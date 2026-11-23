import { useEffect, useMemo, useState, type FormEvent } from "react";
import { errorMessage } from "../lib/api";
import { readImports, type ImportSource } from "../lib/sources";
import { PROVIDER_LABELS, readsImages, type ModelRef, type ProviderStatus } from "../lib/types";
import type { ImportPlan } from "../lib/useImport";
import { Close } from "./Icons";
import { ModelPicker } from "./ModelPicker";

interface Props {
  files: File[];
  /** The open document, which the import can add to instead of starting a new one. */
  openDocument: { id: string; title: string } | null;
  initialTarget: "new" | "append";
  providers: ProviderStatus[];
  modelsLoading: boolean;
  model: ModelRef | null;
  onSelectModel: (model: ModelRef) => void;
  onRefreshModels: () => void;
  onOpenSettings: () => void;
  onClose: () => void;
  onStart: (plans: ImportPlan[]) => void;
}

function describe(source: ImportSource): string {
  const body = source.body;
  if (body.type === "pages") {
    if (body.kind === "pdf") return `PDF · ${body.pages} ${body.pages === 1 ? "page" : "pages"}`;
    return body.pages === 1 ? "Image" : `${body.pages} images, in name order`;
  }
  const figures = source.attachments.size ? ` · ${source.attachments.size} ${source.attachments.size === 1 ? "image" : "images"}` : "";
  if (body.type === "text") return `${body.kind === "latex" ? "LaTeX source" : body.kind === "markdown" ? "Markdown" : "Text"}${figures}`;
  return `${body.converted.blocks.length} ${body.converted.blocks.length === 1 ? "block" : "blocks"}${figures}`;
}

/** Whether a model adds anything: converted formats (Word, notebooks, code) are already structured. */
const canTranscribe = (source: ImportSource) => source.body.type !== "converted";

export function ImportDialog({
  files,
  openDocument,
  initialTarget,
  providers,
  modelsLoading,
  model,
  onSelectModel,
  onRefreshModels,
  onOpenSettings,
  onClose,
  onStart,
}: Props) {
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<"new" | "append">(openDocument ? initialTarget : "new");
  const [useModel, setUseModel] = useState(true);
  const [range, setRange] = useState<{ from: string; to: string }>({ from: "1", to: "" });

  useEffect(() => {
    let cancelled = false;
    readImports(files).then(
      (result) => {
        if (cancelled) return;
        setSources(result.sources);
        setSkipped(result.skipped);
        const pages = result.sources.find((s) => s.body.type === "pages");
        if (pages?.body.type === "pages") setRange({ from: "1", to: String(pages.body.pages) });
        // Markdown is already in the document's format; papers and photos need reading.
        setUseModel(result.sources.some((s) => s.body.type === "pages" || (s.body.type === "text" && s.body.kind === "latex")));
      },
      (err) => !cancelled && setError(errorMessage(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [files]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const info = useMemo(
    () => providers.flatMap((p) => p.models).find((m) => model && m.provider === model.provider && m.id === model.model) ?? null,
    [providers, model],
  );
  const hasModel = !!info;
  const vision = readsImages(info);
  const transcribable = sources?.some(canTranscribe) ?? false;
  const transcribe = useModel && hasModel && transcribable;
  const pageSource = sources?.find((s) => s.body.type === "pages");
  const totalPages = pageSource?.body.type === "pages" ? pageSource.body.pages : 0;
  const pdf = pageSource?.body.type === "pages" && pageSource.body.kind === "pdf";
  const images = pageSource?.body.type === "pages" && pageSource.body.kind === "images";
  const from = Math.max(1, Math.min(totalPages || 1, Number.parseInt(range.from, 10) || 1));
  const to = Math.max(from, Math.min(totalPages || 1, Number.parseInt(range.to, 10) || totalPages || 1));
  const count = to - from + 1;
  const appendTitle = openDocument?.title.trim() || "Untitled";
  // Several files can't all be added to one document as different sources; each gets its own.
  const multiple = (sources?.length ?? 0) > 1;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!sources?.length) return;
    const plans: ImportPlan[] = sources.map((source) => ({
      source,
      target: target === "append" && openDocument && !multiple ? { kind: "append", docId: openDocument.id } : { kind: "new" },
      model: transcribe && canTranscribe(source) ? model : null,
      vision,
      from: source.body.type === "pages" ? from : 1,
      to: source.body.type === "pages" ? to : 1,
    }));
    onStart(plans);
  };

  const action = !sources
    ? "Import"
    : transcribe
      ? pageSource
        ? `Transcribe ${count} ${pdf ? (count === 1 ? "page" : "pages") : count === 1 ? "image" : "images"}`
        : "Transcribe"
      : "Import";

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog import-dialog" onSubmit={submit} aria-labelledby="import-title">
        <header className="dialog__head">
          <h2 id="import-title">Import</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <Close size={12} />
          </button>
        </header>

        <div className="dialog__body">
          <section className="settings-section">
            <ul className="import-files">
              {!sources && !error && <li className="import-files__item is-loading">Reading {files.length === 1 ? files[0].name : `${files.length} files`}…</li>}
              {sources?.map((source) => (
                <li key={source.name} className="import-files__item">
                  <span className="import-files__name">{source.name}</span>
                  <span className="import-files__kind">{describe(source)}</span>
                </li>
              ))}
              {skipped.map((name) => (
                <li key={name} className="import-files__item is-skipped">
                  <span className="import-files__name">{name}</span>
                  <span className="import-files__kind">Can’t be read</span>
                </li>
              ))}
            </ul>
            {sources?.length === 0 && !error && (
              <p className="import-note">
                None of these files can be imported. Theoremis reads PDFs, images, LaTeX, Markdown, Word documents, notebooks, tables and code.
              </p>
            )}
          </section>

          {openDocument && !multiple && (
            <section className="settings-section">
              <h3>Into</h3>
              <div className="segmented import-segmented" role="radiogroup" aria-label="Destination">
                <button type="button" role="radio" aria-checked={target === "new"} className={target === "new" ? "is-active" : ""} onClick={() => setTarget("new")}>
                  A new document
                </button>
                <button type="button" role="radio" aria-checked={target === "append"} className={target === "append" ? "is-active" : ""} onClick={() => setTarget("append")}>
                  The end of “{appendTitle.length > 28 ? `${appendTitle.slice(0, 27)}…` : appendTitle}”
                </button>
              </div>
            </section>
          )}

          {transcribable && (
            <section className="settings-section">
              <h3>How</h3>
              <label className={`import-choice${useModel ? " is-active" : ""}`}>
                <input type="radio" name="how" checked={useModel} onChange={() => setUseModel(true)} />
                <span className="import-choice__body">
                  <span className="import-choice__title">Transcribe with the collaborator</span>
                  <span className="import-choice__text">
                    The model reads {pdf ? "each page" : images ? "the images" : "the source"} and writes it out as a Theoremis document:
                    statements with statuses, LaTeX, and {pdf ? "figures copied from the PDF" : "pictures cropped from the original"}.
                    Check it against the original afterwards.
                  </span>
                  {useModel && (
                    <span className="import-choice__model">
                      <ModelPicker
                        providers={providers}
                        loading={modelsLoading}
                        selected={model}
                        onSelect={onSelectModel}
                        onRefresh={onRefreshModels}
                        onOpenSettings={onOpenSettings}
                      />
                      {hasModel && info?.provider === "chatgpt" && (
                        <span className="import-choice__hint">
                          Uses your {PROVIDER_LABELS.chatgpt} plan
                          {pageSource ? `: about ${Math.ceil(count / (vision ? 3 : 6))} ${Math.ceil(count / (vision ? 3 : 6)) === 1 ? "request" : "requests"}` : ""}.
                        </span>
                      )}
                    </span>
                  )}
                  {useModel && !hasModel && (
                    <span className="import-warning">Connect ChatGPT or Ollama to transcribe, or import without the collaborator.</span>
                  )}
                  {useModel && hasModel && !vision && pageSource && (
                    <span className="import-warning">
                      {info?.name ?? info?.id} can’t read images.{" "}
                      {pdf
                        ? "It will work from the PDF’s text layer, so formulas may come out wrong."
                        : "Images can only be inserted as pictures."}{" "}
                      For best results choose a vision model: any ChatGPT model, or one like qwen2.5vl or gemma3 in Ollama.
                    </span>
                  )}
                </span>
              </label>
              <label className={`import-choice${!useModel ? " is-active" : ""}`}>
                <input type="radio" name="how" checked={!useModel} onChange={() => setUseModel(false)} />
                <span className="import-choice__body">
                  <span className="import-choice__title">Import without the collaborator</span>
                  <span className="import-choice__text">
                    {pdf
                      ? "Keeps the PDF’s paragraphs and copies its figures. Formulas come out as the PDF’s plain text."
                      : images
                        ? "Inserts the images as pictures, one per page."
                        : "Converts the file directly: sections, statements, equations and lists."}
                  </span>
                </span>
              </label>
            </section>
          )}

          {pageSource && totalPages > 1 && (
            <section className="settings-section">
              <h3>{pdf ? "Pages" : "Images"}</h3>
              <div className="import-range">
                <label>
                  From
                  <input type="number" min={1} max={totalPages} value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
                </label>
                <label>
                  to
                  <input type="number" min={1} max={totalPages} value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
                </label>
                <span className="import-range__total">of {totalPages}</span>
              </div>
            </section>
          )}

          {error && (
            <p className="dialog__error" role="alert">
              {error}
            </p>
          )}
        </div>

        <footer className="dialog__foot">
          <button type="button" className="text-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button--cream" disabled={!sources?.length || (useModel && transcribable && !hasModel)}>
            {action}
          </button>
        </footer>
      </form>
    </div>
  );
}
