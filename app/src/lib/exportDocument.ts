// Exporting a document: its LaTeX source (lib/latexExport.ts), with its figures, graphs and
// references as files beside it in a ZIP when it has any, saved where the person chooses.

import { graphPicture } from "../components/graph/graphPicture";
import { api, assetUrl } from "./api";
import { documentToLatex, exportName } from "./latexExport";
import { macroSource, readMacros } from "./macros";
import type { Doc } from "./types";
import { zip } from "./zip";

const GRAPH_FENCE = /```(graph3d|graph)[ \t]*\n([\s\S]*?)\n```/g;

/** Exports `doc` as LaTeX. Resolves to where it was saved, or null if the person cancelled. */
export async function exportLatex(doc: Doc, author: string): Promise<string | null> {
  // Graphs are pictured first, so a graph that can't be is kept as its code instead.
  const pictures = new Map<string, string>();
  for (const block of doc.blocks) {
    if (block.suggestion) continue;
    for (const [, language, code] of block.source.matchAll(GRAPH_FENCE)) {
      const dim = language === "graph3d" ? 3 : 2;
      const picture = graphPicture(code, dim);
      if (picture) pictures.set(`${dim}:${code}`, picture);
    }
  }
  const bibliography = doc.bibliography?.trim() ?? "";
  const { tex, figures } = documentToLatex(doc, {
    author,
    macros: macroSource(readMacros(doc.macros)),
    bibliography: bibliography ? "references" : undefined,
    pictured: (code, dim) => pictures.has(`${dim}:${code}`),
    date: new Date(),
  });
  const base = exportName(doc.title);
  const source = new TextEncoder().encode(tex);
  // The references go beside the source only when it cites them.
  const cites = bibliography && tex.includes("\\bibliography{references}");
  if (!figures.length && !cites) return api.saveFile(`${base}.tex`, "LaTeX source", source);

  const files: { name: string; data: Uint8Array }[] = [{ name: `${base}.tex`, data: source }];
  if (cites) files.push({ name: "references.bib", data: new TextEncoder().encode(`${bibliography}\n`) });
  for (const figure of figures) {
    const data =
      "graph" in figure.from
        ? dataUrlBytes(pictures.get(`${figure.from.dim}:${figure.from.graph}`)!)
        : await assetForLatex(doc.id, figure.from.asset, figure.path);
    if (data) files.push({ name: figure.path, data });
  }
  return api.saveFile(`${base}.zip`, "ZIP archive", await zip(files));
}

function dataUrlBytes(url: string): Uint8Array {
  const binary = atob(url.slice(url.indexOf(",") + 1));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** A figure's file, converted to PNG when pdfLaTeX can't include its format. */
async function assetForLatex(documentId: string, name: string, path: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(assetUrl(documentId, name));
    if (!response.ok) return null;
    const blob = await response.blob();
    if (path.endsWith(name)) return new Uint8Array(await blob.arrayBuffer());
    // An <img> decodes every format the webview shows, SVG included.
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.src = url;
    await image.decode().finally(() => URL.revokeObjectURL(url));
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || 1200;
    canvas.height = image.naturalHeight || 800;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return dataUrlBytes(canvas.toDataURL("image/png"));
  } catch {
    return null;
  }
}
