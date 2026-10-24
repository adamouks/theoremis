// Reading PDFs with pdf.js: pages as images, their text layer, and where figures are drawn.

import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { findFigures, type FigureRegion, type Mark, type TextItem } from "./figures";
import { readingOrder, type LayoutItem } from "./layout";
import { createCanvas, type Canvas } from "./media";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** pdf.js's fonts, character maps and decoders, copied into the app by vite.config.ts. */
const resource = (dir: string) => new URL(`/pdfjs/${dir}/`, window.location.href).href;

export interface PdfPage {
  number: number;
  /** Size in points. */
  width: number;
  height: number;
  /** Renders the page at `scale` pixels per point, on white. */
  render(scale: number): Promise<Canvas>;
  /** The page's text layer: plain text, and each run with its box in points. */
  text(): Promise<{ plain: string; items: TextItem[] }>;
  /** The figures drawn on the page, in points. */
  figures(): Promise<FigureRegion[]>;
  /** Paragraphs and figures in reading order, for imports without a model. */
  layout(): Promise<LayoutItem[]>;
  release(): void;
}

export interface PdfFile {
  pages: number;
  title: string | null;
  page(number: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}

export async function openPdf(bytes: Uint8Array): Promise<PdfFile> {
  const task = pdfjs.getDocument({
    // pdf.js transfers the buffer to its worker; keep the caller's copy intact.
    data: bytes.slice(),
    cMapUrl: resource("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: resource("standard_fonts"),
    wasmUrl: resource("wasm"),
    iccUrl: resource("iccs"),
    enableXfa: false,
  });
  let doc: pdfjs.PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "PasswordException") throw new Error("This PDF is password-protected. Remove the password and try again.");
    if (name === "InvalidPDFException") throw new Error("This file isn't a readable PDF.");
    throw err;
  }
  let title: string | null = null;
  try {
    const meta = await doc.getMetadata();
    const raw = (meta.info as { Title?: unknown } | undefined)?.Title;
    if (typeof raw === "string" && raw.trim() && !/^untitled|\.(tex|dvi|pdf)$|^microsoft word/i.test(raw.trim())) title = raw.trim();
  } catch {
    // A title is a nicety.
  }
  return {
    pages: doc.numPages,
    title,
    page: async (number) => wrapPage(await doc.getPage(number)),
    destroy: () => task.destroy(),
  };
}

type Matrix = [number, number, number, number, number, number];

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

function transformBox(m: Matrix, x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ]) {
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const PAINT_PATH = new Set([
  pdfjs.OPS.stroke,
  pdfjs.OPS.closeStroke,
  pdfjs.OPS.fill,
  pdfjs.OPS.eoFill,
  pdfjs.OPS.fillStroke,
  pdfjs.OPS.eoFillStroke,
  pdfjs.OPS.closeFillStroke,
  pdfjs.OPS.closeEOFillStroke,
]);

const PAINT_IMAGE = new Set([
  pdfjs.OPS.paintImageXObject,
  pdfjs.OPS.paintInlineImageXObject,
  pdfjs.OPS.paintImageMaskXObject,
  pdfjs.OPS.paintImageXObjectRepeat,
  pdfjs.OPS.paintSolidColorImageMask,
]);

function wrapPage(page: pdfjs.PDFPageProxy): PdfPage {
  const viewport = page.getViewport({ scale: 1 });
  // From PDF user space (origin bottom left) to the page in points (origin top left).
  const toPage = (x0: number, y0: number, x1: number, y1: number) => {
    const [a, b] = viewport.convertToViewportPoint(x0, y0) as number[];
    const [c, d] = viewport.convertToViewportPoint(x1, y1) as number[];
    return { x0: Math.min(a, c), y0: Math.min(b, d), x1: Math.max(a, c), y1: Math.max(b, d) };
  };

  let textCache: Promise<{ plain: string; items: TextItem[] }> | null = null;
  const text = () =>
    (textCache ??= page.getTextContent().then((content) => {
      let plain = "";
      const items: TextItem[] = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        plain += item.str + (item.hasEOL ? "\n" : "");
        if (!item.str.trim()) continue;
        const [, , , , e, f] = item.transform as number[];
        const size = Math.hypot(item.transform[2], item.transform[3]) || item.height;
        items.push({ ...toPage(e, f - size * 0.2, e + item.width, f + size * 0.8), text: item.str });
      }
      return { plain: plain.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), items };
    }));

  const marks = async (): Promise<Mark[]> => {
    const list = await page.getOperatorList();
    const out: Mark[] = [];
    let ctm: Matrix = [1, 0, 0, 1, 0, 0];
    const stack: Matrix[] = [];
    for (let i = 0; i < list.fnArray.length; i++) {
      const fn = list.fnArray[i];
      const args = list.argsArray[i] as unknown[];
      if (fn === pdfjs.OPS.save || fn === pdfjs.OPS.beginGroup) stack.push(ctm);
      else if (fn === pdfjs.OPS.restore || fn === pdfjs.OPS.endGroup) ctm = stack.pop() ?? ctm;
      else if (fn === pdfjs.OPS.transform) ctm = multiply(ctm, args as Matrix);
      else if (fn === pdfjs.OPS.paintFormXObjectBegin) {
        stack.push(ctm);
        const matrix = args[0] as Matrix | null;
        if (matrix) ctm = multiply(ctm, matrix);
      } else if (fn === pdfjs.OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
      else if (fn === pdfjs.OPS.constructPath) {
        const [paint, , minMax] = args as [number, unknown, ArrayLike<number> | null];
        if (!minMax || !PAINT_PATH.has(paint) || !Number.isFinite(minMax[0])) continue;
        const [x0, y0, x1, y1] = transformBox(ctm, minMax[0], minMax[1], minMax[2], minMax[3]);
        out.push({ ...toPage(x0, y0, x1, y1), kind: "path" });
      } else if (PAINT_IMAGE.has(fn)) {
        const [x0, y0, x1, y1] = transformBox(ctm, 0, 0, 1, 1);
        out.push({ ...toPage(x0, y0, x1, y1), kind: "image" });
      }
    }
    return out;
  };

  let figureCache: Promise<FigureRegion[]> | null = null;
  const figures = () =>
    (figureCache ??= Promise.all([marks(), text()]).then(([found, { items }]) =>
      findFigures(found, items, viewport.width, viewport.height),
    ));

  return {
    number: page.pageNumber,
    width: viewport.width,
    height: viewport.height,
    async render(scale) {
      const scaled = page.getViewport({ scale });
      const canvas = createCanvas(scaled.width, scaled.height);
      await page.render({ canvas, viewport: scaled, background: "#ffffff" }).promise;
      return canvas;
    },
    text,
    figures,
    async layout() {
      const [found, { items }] = await Promise.all([figures(), text()]);
      return readingOrder(items, found);
    },
    release: () => void page.cleanup(),
  };
}
