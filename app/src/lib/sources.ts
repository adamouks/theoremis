// What can be imported, read into a common shape: pages (PDFs, photos and scans) that a
// model looks at, or text (LaTeX, Markdown, Word, notebooks, code…) that converts directly.

import {
  codeLanguage,
  codeToBlocks,
  latexToBlocks,
  markdownToBlocks,
  notebookToBlocks,
  tableToMarkdown,
  type Converted,
} from "./convert";
import { docxToMarkdown } from "./docx";
import type { FigureRegion } from "./figures";
import type { LayoutItem } from "./layout";
import { imageFileToCanvas, type Canvas } from "./media";
import type { PdfFile } from "./pdf";

export interface SourcePage {
  number: number;
  /** "page 3", "photo 2 (IMG_0042.jpg)". */
  label: string;
  /** The page as an image, and how many pixels a point is (1 for photos). */
  render(): Promise<{ canvas: Canvas; scale: number }>;
  /** The page's text layer; empty for photos and scans. */
  text(): Promise<string>;
  /** Figures found on the page, in points. */
  figures(): Promise<FigureRegion[]>;
  /** Paragraphs and figures in reading order, for imports without a model. */
  layout(): Promise<LayoutItem[]>;
  release(): void;
}

export interface PageBody {
  type: "pages";
  kind: "pdf" | "images";
  pages: number;
  page(number: number): Promise<SourcePage>;
  close(): Promise<void>;
}

export interface TextBody {
  type: "text";
  kind: "latex" | "markdown" | "text";
  text: string;
  /** How the text converts without a model. */
  converted: Converted;
}

export interface ConvertedBody {
  type: "converted";
  converted: Converted;
}

export interface ImportSource {
  /** What the person sees: the file name, or "3 photos". */
  name: string;
  title: string | null;
  /** The files to keep with the document. */
  originals: File[];
  /** Images that came with a text source, by file name without extension (as \includegraphics names them). */
  attachments: Map<string, Blob>;
  body: PageBody | TextBody | ConvertedBody;
}

const IMAGE = /^(png|jpe?g|gif|webp|bmp|avif|svg|heic|heif|tiff?)$/;
const TEXT = /^(txt|text|rst|org|log)$/;

export function extension(name: string): string {
  return /\.([^./]+)$/.exec(name)?.[1].toLowerCase() ?? "";
}

export const stem = (name: string) => name.replace(/\.[^./]+$/, "");

/** File names sort as people number them: IMG_2 before IMG_10. */
const naturally = (a: File, b: File) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

export type FileKind = "pdf" | "image" | "latex" | "markdown" | "text" | "html" | "docx" | "notebook" | "table" | "code" | "unsupported";

export function fileKind(file: File): FileKind {
  const ext = extension(file.name);
  if (ext === "pdf" || file.type === "application/pdf") return "pdf";
  if (IMAGE.test(ext) || file.type.startsWith("image/")) return "image";
  if (ext === "tex" || ext === "ltx" || ext === "latex") return "latex";
  if (ext === "md" || ext === "markdown" || ext === "mdx") return "markdown";
  if (ext === "html" || ext === "htm" || ext === "xhtml") return "html";
  if (ext === "docx") return "docx";
  if (ext === "ipynb") return "notebook";
  if (ext === "csv" || ext === "tsv") return "table";
  if (codeLanguage(ext)) return "code";
  if (TEXT.test(ext) || file.type.startsWith("text/")) return "text";
  return "unsupported";
}

export const ACCEPTED_FILES =
  ".pdf,.png,.jpg,.jpeg,.gif,.webp,.bmp,.avif,.svg,.heic,.heif,.tif,.tiff,.tex,.ltx,.md,.markdown,.txt,.rst,.org,.html,.htm,.docx,.ipynb,.csv,.tsv,.py,.sage,.jl,.m,.r,.lean,.hs,.rs,.c,.h,.cpp,.java,.js,.ts,.json,.wl,.nb,.gp,.mac,.v,.thy,.agda,.sh,.bib,image/*,application/pdf,text/*";

async function decodeText(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function pdfBody(pdf: PdfFile): PageBody {
  return {
    type: "pages",
    kind: "pdf",
    pages: pdf.pages,
    async page(number) {
      const page = await pdf.page(number);
      // 2.5 pixels per point (180 dpi): sharp figure crops, and pages a model can read.
      const scale = 2.5;
      return {
        number,
        label: `page ${number}`,
        render: async () => ({ canvas: await page.render(scale), scale }),
        text: async () => (await page.text()).plain,
        figures: () => page.figures(),
        layout: () => page.layout(),
        release: () => page.release(),
      };
    },
    close: () => pdf.destroy(),
  };
}

function imagesBody(files: File[]): PageBody {
  return {
    type: "pages",
    kind: "images",
    pages: files.length,
    async page(number) {
      const file = files[number - 1];
      return {
        number,
        label: files.length > 1 ? `photo ${number} (${file.name})` : "the image",
        render: async () => ({ canvas: await imageFileToCanvas(file, 3200), scale: 1 }),
        text: async () => "",
        figures: async () => [],
        layout: async () => [],
        release: () => {},
      };
    },
    close: async () => {},
  };
}

/** HTML (saved web pages, ar5iv papers) to Markdown, keeping LaTeX from MathML annotations. */
export function htmlToMarkdown(html: string): { title: string | null; markdown: string } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, noscript, nav, header > nav, footer").forEach((n) => n.remove());
  const title = doc.querySelector("h1")?.textContent?.trim() || doc.title.trim() || null;

  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\s+/g, " ");
    if (!(node instanceof Element)) return "";
    const tag = node.tagName.toLowerCase();
    if (tag === "math") {
      const tex = node.getAttribute("alttext") ?? node.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? node.textContent ?? "";
      return node.getAttribute("display") === "block" ? `\n\n$$\n${tex.trim()}\n$$\n\n` : `$${tex.trim()}$`;
    }
    if (node.classList.contains("katex-display")) return `\n\n$$\n${node.querySelector("annotation")?.textContent?.trim() ?? ""}\n$$\n\n`;
    if (node.classList.contains("katex")) return `$${node.querySelector("annotation")?.textContent?.trim() ?? ""}$`;
    const children = [...node.childNodes].map(inline).join("");
    if (tag === "strong" || tag === "b") return children.trim() ? `**${children.trim()}**` : "";
    if (tag === "em" || tag === "i") return children.trim() ? `*${children.trim()}*` : "";
    if (tag === "code") return `\`${children}\``;
    if (tag === "br") return "\n";
    if (tag === "a") {
      const href = node.getAttribute("href");
      return href && /^https?:/.test(href) ? `[${children.trim()}](${href})` : children;
    }
    return children;
  };

  const blocks: string[] = [];
  const walk = (node: Element) => {
    for (const child of node.children) {
      const tag = child.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        const level = Math.min(3, Math.max(2, Number(tag[1])));
        if (tag === "h1" && child.textContent?.trim() === title) continue;
        blocks.push(`${"#".repeat(level)} ${inline(child).trim()}`);
      } else if (tag === "p" || tag === "blockquote" || tag === "figcaption" || tag === "dt" || tag === "dd") {
        const text = inline(child).trim();
        if (text) blocks.push(text);
      } else if (tag === "ul" || tag === "ol") {
        const items = [...child.children].filter((c) => c.tagName.toLowerCase() === "li");
        blocks.push(items.map((li, i) => `${tag === "ol" ? `${i + 1}.` : "-"} ${inline(li).trim()}`).join("\n"));
      } else if (tag === "pre") {
        blocks.push(`\`\`\`\n${child.textContent?.trimEnd() ?? ""}\n\`\`\``);
      } else if (tag === "table") {
        const rows = [...child.querySelectorAll("tr")].map((tr) => [...tr.children].map((td) => inline(td).trim().replace(/\|/g, "\\|")));
        if (rows.length) {
          const width = Math.max(...rows.map((r) => r.length));
          const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
          const [head, ...rest] = rows.map(pad);
          blocks.push([`| ${head.join(" | ")} |`, `|${" --- |".repeat(width)}`, ...rest.map((r) => `| ${r.join(" | ")} |`)].join("\n"));
        }
      } else if (tag === "math" || child.classList.contains("katex-display")) {
        blocks.push(inline(child).trim());
      } else {
        walk(child);
      }
    }
  };
  walk(doc.body);
  return { title, markdown: blocks.join("\n\n") };
}

/** Splits the dropped or chosen files into imports: one per document they become. */
export async function readImports(files: File[]): Promise<{ sources: ImportSource[]; skipped: string[] }> {
  const byKind = new Map<FileKind, File[]>();
  for (const file of files) {
    const kind = fileKind(file);
    byKind.set(kind, [...(byKind.get(kind) ?? []), file]);
  }
  const images = [...(byKind.get("image") ?? [])].sort(naturally);
  const skipped = (byKind.get("unsupported") ?? []).map((f) => f.name);
  const sources: ImportSource[] = [];
  const texts = [...(byKind.get("latex") ?? []), ...(byKind.get("markdown") ?? [])];
  // Images that come with a LaTeX or Markdown file are its figures, not pages of their own.
  const attachments = new Map<string, Blob>();
  if (texts.length) for (const image of images) attachments.set(stem(image.name).replace(/[^\w-]/g, "_"), image);

  for (const file of byKind.get("pdf") ?? []) {
    // pdf.js is large; load it with the first PDF.
    const { openPdf } = await import("./pdf");
    const pdf = await openPdf(new Uint8Array(await file.arrayBuffer()));
    sources.push({ name: file.name, title: pdf.title, originals: [file], attachments: new Map(), body: pdfBody(pdf) });
  }
  if (images.length && !texts.length) {
    sources.push({
      name: images.length === 1 ? images[0].name : `${images.length} images`,
      title: null,
      originals: images,
      attachments: new Map(),
      body: imagesBody(images),
    });
  }
  for (const file of texts) {
    const text = await decodeText(file);
    const latex = fileKind(file) === "latex";
    const converted = latex ? latexToBlocks(text) : markdownToBlocks(text);
    sources.push({
      name: file.name,
      title: converted.title,
      originals: [file],
      attachments,
      body: { type: "text", kind: latex ? "latex" : "markdown", text, converted },
    });
  }
  for (const file of byKind.get("text") ?? []) {
    const text = await decodeText(file);
    sources.push({ name: file.name, title: null, originals: [file], attachments: new Map(), body: { type: "text", kind: "text", text, converted: markdownToBlocks(text) } });
  }
  for (const file of byKind.get("html") ?? []) {
    const { title, markdown } = htmlToMarkdown(await decodeText(file));
    const converted = markdownToBlocks(markdown);
    sources.push({ name: file.name, title, originals: [], attachments: new Map(), body: { type: "text", kind: "markdown", text: markdown, converted } });
  }
  for (const file of byKind.get("docx") ?? []) {
    const { title, markdown, images: media } = await docxToMarkdown(new Uint8Array(await file.arrayBuffer()));
    const converted = markdownToBlocks(markdown);
    sources.push({ name: file.name, title: title ?? converted.title, originals: [file], attachments: media, body: { type: "converted", converted } });
  }
  for (const file of byKind.get("notebook") ?? []) {
    let converted: Converted;
    try {
      converted = notebookToBlocks(await decodeText(file));
    } catch {
      skipped.push(file.name);
      continue;
    }
    sources.push({ name: file.name, title: converted.title, originals: [], attachments: new Map(), body: { type: "converted", converted } });
  }
  for (const file of byKind.get("table") ?? []) {
    const table = tableToMarkdown(await decodeText(file), extension(file.name) === "tsv" ? "\t" : ",");
    sources.push({ name: file.name, title: stem(file.name), originals: [], attachments: new Map(), body: { type: "converted", converted: { title: stem(file.name), lede: null, blocks: [{ source: table }] } } });
  }
  for (const file of byKind.get("code") ?? []) {
    const language = codeLanguage(extension(file.name)) ?? "text";
    sources.push({ name: file.name, title: file.name, originals: [], attachments: new Map(), body: { type: "converted", converted: codeToBlocks(await decodeText(file), language, file.name) } });
  }
  return { sources, skipped };
}

/** Splits long text at paragraph breaks into parts a model can take one at a time. */
export function splitText(text: string, size = 14000): string[] {
  const parts: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n\s*\n/)) {
    if (current && current.length + paragraph.length > size) {
      parts.push(current);
      current = "";
    }
    current += (current ? "\n\n" : "") + paragraph;
    while (current.length > size * 1.5) {
      parts.push(current.slice(0, size));
      current = current.slice(size);
    }
  }
  if (current.trim()) parts.push(current);
  return parts.length ? parts : [""];
}
