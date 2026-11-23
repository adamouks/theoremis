import { useCallback, useRef, useState } from "react";
import { api, assetUrl, errorMessage } from "./api";
import { applyPart, documentTail, startPart, statementLabels, type PartState } from "./importDoc";
import { modelImage, releaseCanvas, saveCrop, saveMedia, type Canvas, type Rect } from "./media";
import { readImports, splitText, stem, type ImportSource, type SourcePage } from "./sources";
import { buildPartRequest, describePosition, type Candidate } from "./transcribePrompt";
import { cropRequests, parseCrop, parseTranscript, resolveFigures, usedFigureIds, type Transcript } from "./transcript";
import { newId } from "./text";
import type { Doc, DocOrigin, ModelRef } from "./types";
import type { WorkspaceApi } from "./useWorkspace";

export interface ImportPlan {
  source: ImportSource;
  target: { kind: "new"; projectId?: string } | { kind: "append"; docId: string };
  /** Who transcribes; null converts without the collaborator. */
  model: ModelRef | null;
  /** Whether the model reads images. Without, a PDF is transcribed from its text layer. */
  vision: boolean;
  /** Pages to transcribe, for PDFs and photos. */
  from: number;
  to: number;
  /** Continues an unfinished import of the target document. */
  resume?: boolean;
}

export type ImportStage = "preparing" | "reading" | "transcribing" | "done" | "stopped" | "failed";

export interface ImportJob {
  id: string;
  docId: string;
  name: string;
  stage: ImportStage;
  /** What's happening, e.g. "Transcribing pages 4–6 of 12". */
  detail: string;
  /** 0 to 1. */
  progress: number;
  model: ModelRef | null;
  error?: string;
  /** Figures copied into the document so far. */
  figures: number;
  /** More imports waiting behind this one. */
  queued: number;
}

/** Pages a model reads per request: enough context to keep a proof together, few enough to stay accurate. */
const PAGES_WITH_IMAGES = 3;
const PAGES_TEXT_ONLY = 6;

class Stopped extends Error {}

/** Imports files into documents: transcribing with the collaborator, or converting directly. */
export function useImport(workspace: WorkspaceApi) {
  const [job, setJob] = useState<ImportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const control = useRef<{ stopped: boolean; requestId: string | null } | null>(null);
  const running = useRef(false);

  const update = useCallback((patch: Partial<ImportJob>) => setJob((j) => (j ? { ...j, ...patch } : j)), []);

  /** The document as it stands, whether open or on disk. */
  const snapshot = useCallback(
    async (docId: string): Promise<Doc> => {
      let found: Doc | null = null;
      if (workspace.currentDocId() === docId) {
        workspace.updateDoc((d) => {
          found = d;
          return d;
        }, "meta");
      }
      if (found) return found;
      await workspace.flush();
      return api.loadDocument(docId);
    },
    [workspace],
  );

  const write = useCallback(
    (docId: string, fn: (doc: Doc) => Doc) => workspace.mutateDocument(docId, fn, "content"),
    [workspace],
  );

  const runOne = useCallback(
    async (plan: ImportPlan, queued: number) => {
      const { source } = plan;
      const ctl = { stopped: false, requestId: null as string | null };
      control.current = ctl;
      const check = () => {
        if (ctl.stopped) throw new Stopped();
      };

      // The document: a new one, or the one being added to.
      let docId: string;
      if (plan.target.kind === "new") {
        const created = await workspace.createDocument(plan.target.projectId);
        docId = created.id;
      } else docId = plan.target.docId;
      const jobId = newId();
      setJob({ id: jobId, docId, name: source.name, stage: "preparing", detail: "Preparing…", progress: 0, model: plan.model, figures: 0, queued });

      try {
        const pageBody = source.body.type === "pages" ? source.body : null;
        const textParts = source.body.type === "text" && plan.model ? splitText(source.body.text) : null;
        const isNew = plan.target.kind === "new";
        const from = pageBody ? Math.max(1, plan.from) : 1;
        const to = pageBody ? Math.min(pageBody.pages, plan.to) : (textParts?.length ?? 1);

        // Keep the originals with the document, and name it after them.
        let files: string[] = [];
        if (!plan.resume && source.originals.length) {
          update({ detail: "Keeping a copy of the original…" });
          files = [];
          for (const file of source.originals) files.push(await saveMedia(docId, file, "original"));
        }
        if (isNew && !plan.resume) {
          const origin: DocOrigin = {
            kind: pageBody ? pageBody.kind : "text",
            names: source.originals.length ? source.originals.map((f) => f.name) : [source.name],
            files,
            pages: pageBody ? pageBody.pages : to,
            from,
            to,
            done: from - 1,
            ...(plan.model ? { model: plan.model } : {}),
            importedAt: Date.now(),
          };
          // A transcription brings its own title; until then, and without one, use the file's.
          const title = plan.model ? "" : (source.title ?? stem(source.name));
          write(docId, (d) => ({ ...d, title: d.title.trim() ? d.title : title, origin }));
        }
        const recordPages = isNew || !!plan.resume;
        let figureCount = 0;
        let placed = 0;

        // Images uploaded with a text source, kept as media when a block uses them.
        const attachmentAssets = new Map<string, string>();
        const attachment = async (id: string) => {
          if (attachmentAssets.has(id)) return attachmentAssets.get(id)!;
          const blob = source.attachments.get(id);
          if (!blob) return null;
          const name = await saveMedia(docId, blob, "fig");
          attachmentAssets.set(id, name);
          return name;
        };

        // ---- Without a model: convert directly.
        if (!plan.model || (pageBody?.kind === "images" && !plan.vision)) {
          const blocks: Transcript["blocks"] = [];
          let title: string | null = null;
          let lede: string | null = null;
          if (source.body.type !== "pages") {
            const converted = source.body.converted;
            title = converted.title;
            lede = converted.lede;
            for (const block of converted.blocks) {
              let text = block.source;
              for (const id of usedFigureIds([text])) {
                const asset = await attachment(id);
                if (asset) text = resolveFigures(text, new Map([[id, asset]]));
              }
              blocks.push({ ...block, source: resolveFigures(text, new Map()), continues: false });
            }
          } else {
            for (let n = from; n <= to; n++) {
              check();
              update({ stage: "reading", detail: `Reading ${pageBody!.kind === "pdf" ? "page" : "image"} ${n} of ${to}…`, progress: (n - from) / (to - from + 1) });
              const page = await pageBody!.page(n);
              try {
                if (pageBody!.kind === "images") {
                  const original = files[n - 1] ?? (await saveMedia(docId, source.originals[n - 1], "original"));
                  blocks.push({ source: `![](asset:${original})`, page: n, continues: false });
                  continue;
                }
                const items = await page.layout();
                const captions = new Set(items.flatMap((i) => (i.kind === "figure" && i.figure.caption ? [i.figure.caption.trim()] : [])));
                const needsRender = captions.size > 0 || items.some((i) => i.kind === "figure");
                const rendered = needsRender ? await page.render() : null;
                for (const item of items) {
                  // A figure carries its caption, so its line of text isn't repeated.
                  if (item.kind === "text" && captions.has(item.text.trim())) continue;
                  if (item.kind === "text") blocks.push({ source: item.text, page: n, continues: false });
                  else if (rendered) {
                    const f = item.figure;
                    const s = rendered.scale;
                    const asset = await saveCrop(docId, rendered.canvas, { x: f.x0 * s, y: f.y0 * s, width: (f.x1 - f.x0) * s, height: (f.y1 - f.y0) * s });
                    figureCount++;
                    blocks.push({ source: `![${f.caption ?? ""}](asset:${asset})`, page: n, continues: false });
                  }
                }
                if (rendered) releaseCanvas(rendered.canvas);
              } finally {
                page.release();
              }
            }
          }
          const doc = await snapshot(docId);
          const part = startPart(doc, null, { header: isNew, pages: recordPages && !!pageBody });
          write(docId, (d) => applyPart(d, part, { title, lede, blocks }, (s) => s));
          if (isNew) write(docId, (d) => (d.origin ? { ...d, origin: { ...d.origin, done: to } } : d));
          update({ stage: "done", detail: "Imported", progress: 1, figures: figureCount });
          return false;
        }

        // ---- With a model: part by part.
        const model = plan.model;
        const perPart = plan.vision ? PAGES_WITH_IMAGES : PAGES_TEXT_ONLY;
        const spans: [number, number][] = [];
        if (pageBody) for (let a = from; a <= to; a += perPart) spans.push([a, Math.min(to, a + perPart - 1)]);
        else textParts!.forEach((_, i) => spans.push([i + 1, i + 1]));
        let previous: PartState | null = null;
        const total = spans.length;

        for (const [index, [a, b]] of spans.entries()) {
          check();
          const spanText = pageBody
            ? a === b
              ? `${pageBody.kind === "pdf" ? "page" : "image"} ${a} of ${pageBody.pages}`
              : `${pageBody.kind === "pdf" ? "pages" : "images"} ${a}–${b} of ${pageBody.pages}`
            : `part ${a} of ${total}`;
          update({ stage: "reading", detail: `Reading ${spanText}…`, progress: index / total });

          // Read the pages: images for the model, their text layer, and figure candidates.
          const pages: { page: SourcePage; canvas: Canvas | null; scale: number }[] = [];
          const candidates: Candidate[] = [];
          const candidateAssets = new Map<string, string>();
          const images: string[] = [];
          const texts: { label: string; text: string }[] = [];
          try {
            if (pageBody) {
              for (let n = a; n <= b; n++) {
                check();
                const page = await pageBody.page(n);
                const figures = await page.figures();
                const needsRender = plan.vision || figures.length > 0;
                const rendered = needsRender ? await page.render() : null;
                pages.push({ page, canvas: rendered?.canvas ?? null, scale: rendered?.scale ?? 1 });
                const boxes: { rect: Rect; label: string }[] = [];
                if (rendered) {
                  const { canvas, scale } = rendered;
                  for (const f of figures) {
                    const id = `F${++figureCount}`;
                    const rect = { x: f.x0 * scale, y: f.y0 * scale, width: (f.x1 - f.x0) * scale, height: (f.y1 - f.y0) * scale };
                    candidateAssets.set(id, await saveCrop(docId, canvas, rect));
                    boxes.push({ rect, label: id });
                    candidates.push({
                      id,
                      page: n,
                      where: describePosition(rect.y / canvas.height, (rect.y + rect.height) / canvas.height, rect.x / canvas.width, (rect.x + rect.width) / canvas.width),
                      caption: f.caption,
                    });
                  }
                  if (plan.vision) images.push(await modelImage(canvas, boxes));
                }
                texts.push({ label: page.label, text: await page.text() });
              }
            } else {
              const body = source.body as Extract<ImportSource["body"], { type: "text" }>;
              const text = textParts![a - 1];
              texts.push({ label: spanText, text });
              for (const id of usedFigureIds([body.kind === "latex" ? body.converted.blocks.map((x) => x.source).join("\n") : text])) {
                if (!source.attachments.has(id)) continue;
                const asset = await attachment(id);
                if (asset) {
                  candidateAssets.set(id, asset);
                  candidates.push({ id, page: a, where: "an uploaded image file", caption: `${id} (uploaded)` });
                }
              }
            }

            // Transcribe, showing blocks as they arrive.
            check();
            const doc = await snapshot(docId);
            const part = startPart(doc, previous, { header: isNew && index === 0 && !plan.resume, pages: recordPages && !!pageBody, resuming: !!plan.resume && index === 0 });
            const messages = buildPartRequest({
              name: source.name,
              part: index + 1 + (plan.resume ? 1 : 0),
              parts: total + (plan.resume ? 1 : 0),
              span: spanText,
              previous: index > 0 || plan.resume ? documentTail(doc) : "",
              labels: statementLabels(doc),
              candidates,
              texts,
              images,
              kind: pageBody ? pageBody.kind : (source.body as { kind: "latex" | "markdown" | "text" }).kind,
            });
            const crops = new Map<string, string>();
            const resolve = (text: string) => resolveFigures(text, candidateAssets, crops);
            update({ stage: "transcribing", detail: `Transcribing ${spanText}…` });

            let reply = "";
            let frame = 0;
            // A transcribed page runs to about 3,000 characters; progress within a part is a guess from that.
            const expected = (pageBody ? b - a + 1 : 1) * (pageBody ? 3000 : (textParts![a - 1]?.length ?? 6000) * 1.1);
            const show = () => {
              frame = 0;
              update({ progress: (index + Math.min(0.92, reply.length / expected)) / total });
              if (workspace.currentDocId() === docId) write(docId, (d) => applyPart(d, part, parseTranscript(reply), resolve));
            };
            const requestId = newId();
            ctl.requestId = requestId;
            const outcome = await api.streamChat({
              requestId,
              provider: model.provider,
              model: model.model,
              messages,
              onEvent: (event) => {
                if (event.type !== "delta") return;
                reply += event.text;
                if (!frame) frame = requestAnimationFrame(show);
              },
            });
            if (frame) cancelAnimationFrame(frame);
            ctl.requestId = null;
            check();
            if (outcome.cancelled) throw new Stopped();

            // Crop the pictures the model placed by position, then settle the part.
            const transcript = parseTranscript(reply);
            for (const target of new Set(transcript.blocks.flatMap((x) => cropRequests(x.source)))) {
              const crop = parseCrop(target);
              const entry = crop && pages.find((p) => p.page.number === crop.page);
              if (!crop || !entry?.canvas) continue;
              const { canvas } = entry;
              crops.set(
                target,
                await saveCrop(docId, canvas, {
                  x: crop.left * canvas.width,
                  y: crop.top * canvas.height,
                  width: (crop.right - crop.left) * canvas.width,
                  height: (crop.bottom - crop.top) * canvas.height,
                }),
              );
            }
            write(docId, (d) => applyPart(d, part, transcript, resolve));
            const used = usedFigureIds(transcript.blocks.map((x) => x.source));
            for (const [id, asset] of candidateAssets) {
              if (!used.has(id) && !attachmentAssets.has(id)) void api.deleteAsset(docId, asset).catch(() => undefined);
            }
            if (pageBody || isNew) write(docId, (d) => (d.origin ? { ...d, origin: { ...d.origin, done: b, model } } : d));
            previous = part;
            placed += [...used].filter((id) => candidateAssets.has(id)).length + crops.size;
            update({ figures: placed, progress: (index + 1) / total });
          } finally {
            for (const p of pages) {
              if (p.canvas) releaseCanvas(p.canvas);
              p.page.release();
            }
          }
        }
        if (isNew) write(docId, (d) => (d.title.trim() ? d : { ...d, title: source.title ?? stem(source.name) }));
        update({ stage: "done", detail: "Transcribed", progress: 1 });
      } catch (err) {
        if (err instanceof Stopped || ctl.stopped) update({ stage: "stopped", detail: "Stopped" });
        else update({ stage: "failed", detail: "Stopped by an error", error: errorMessage(err) });
      } finally {
        if (source.body.type === "pages") await source.body.close().catch(() => undefined);
        control.current = null;
      }
      return ctl.stopped;
    },
    [workspace, update, snapshot, write],
  );

  /** Imports each source in turn, each into its own document unless one is being added to. */
  const start = useCallback(
    async (plans: ImportPlan[]) => {
      if (running.current || plans.length === 0) return;
      running.current = true;
      setBusy(true);
      try {
        for (const [i, plan] of plans.entries()) {
          const stopped = await runOne(plan, plans.length - i - 1);
          if (stopped) break;
        }
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [runOne],
  );

  /** Picks up an import that stopped part-way, from the original kept with the document. */
  const resume = useCallback(
    async (doc: Doc, model: ModelRef, vision: boolean) => {
      const origin = doc.origin;
      if (!origin || origin.done >= origin.to || running.current) return;
      const files: File[] = [];
      for (const [i, name] of origin.files.entries()) {
        const response = await fetch(assetUrl(doc.id, name));
        if (!response.ok) throw new Error("The original file is no longer kept with this document.");
        files.push(new File([await response.blob()], origin.names[i] ?? name));
      }
      const { sources } = await readImports(files);
      if (!sources[0]) throw new Error("Theoremis couldn't read the original file.");
      await start([{ source: sources[0], target: { kind: "append", docId: doc.id }, model, vision, from: origin.done + 1, to: origin.to, resume: true }]);
    },
    [start],
  );

  const stop = useCallback(() => {
    const ctl = control.current;
    if (!ctl) return;
    ctl.stopped = true;
    if (ctl.requestId) void api.cancelChat(ctl.requestId);
  }, []);

  const dismiss = useCallback(() => setJob((j) => (j && (j.stage === "done" || j.stage === "stopped" || j.stage === "failed") ? null : j)), []);

  return { job, busy, start, resume, stop, dismiss };
}

export type ImportApi = ReturnType<typeof useImport>;
