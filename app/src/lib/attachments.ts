// Files attached to a question for the collaborator: images and PDF pages are kept with the
// document and shown to the model; text, LaTeX, Word and the like go in as text.

import { assetUrl } from "./api";
import { blobToDataUrl, modelImageBlob, releaseCanvas, saveMedia } from "./media";
import { readImports } from "./sources";
import type { Attachment } from "./types";

/** Pages of a PDF shown to the model as images; the rest go in as text only. */
const MAX_PAGES = 6;
/** Pages whose text is read, and how much of it goes in. */
const MAX_TEXT_PAGES = 60;
const MAX_TEXT = 40000;

function capText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_TEXT ? `${trimmed.slice(0, MAX_TEXT)}\n\n[… the rest of the file is omitted]` : trimmed;
}

/** Reads `file` into an attachment of `documentId`, saving the images it shows the model. */
export async function readAttachment(documentId: string, file: File): Promise<Attachment> {
  const { sources, skipped } = await readImports([file]);
  const source = sources[0];
  if (!source || skipped.length) throw new Error(`Theoremis can't read ${file.name}.`);
  const body = source.body;
  if (body.type === "pages") {
    const images: string[] = [];
    const texts: string[] = [];
    try {
      for (let n = 1; n <= Math.min(body.pages, MAX_TEXT_PAGES); n++) {
        const page = await body.page(n);
        try {
          if (n <= MAX_PAGES) {
            const { canvas } = await page.render();
            try {
              images.push(await saveMedia(documentId, await modelImageBlob(canvas), "attach"));
            } finally {
              releaseCanvas(canvas);
            }
          }
          const text = (await page.text()).trim();
          if (text) texts.push(body.pages > 1 ? `[Page ${n}]\n${text}` : text);
        } finally {
          page.release();
        }
      }
    } finally {
      await body.close();
    }
    return {
      name: file.name,
      kind: body.kind === "pdf" ? "pdf" : "image",
      images,
      ...(texts.length ? { text: capText(texts.join("\n\n")) } : {}),
      ...(body.kind === "pdf" ? { pages: body.pages } : {}),
    };
  }
  const text = body.type === "text" ? body.text : body.converted.blocks.map((b) => b.source).join("\n\n");
  return { name: file.name, kind: "text", images: [], text: capText(text) };
}

/** Loads the images attached in a thread as data URLs, by file name. */
export async function loadAttachmentImages(documentId: string, names: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    names.map(async (name) => {
      try {
        const response = await fetch(assetUrl(documentId, name));
        if (response.ok) out.set(name, await blobToDataUrl(await response.blob()));
      } catch {
        // A missing image is left out; the text still says it was attached.
      }
    }),
  );
  return out;
}
