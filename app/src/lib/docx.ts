// Word documents: paragraphs, headings, lists, tables, images, and equations (Office Math,
// converted to LaTeX).

/** The files in a ZIP archive, inflated with the browser's own decompressor. */
export async function unzip(bytes: Uint8Array, wanted: (name: string) => boolean): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("This file isn't a readable Word document.");
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const files = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (!wanted(name)) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + compressed);
    if (method === 0) files.set(name, data.slice());
    else if (method === 8) {
      const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      files.set(name, new Uint8Array(await new Response(stream).arrayBuffer()));
    }
  }
  return files;
}

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const M = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";

const local = (el: Element) => el.localName;
const kids = (el: Element, ns: string, name: string) => [...el.children].filter((c) => c.namespaceURI === ns && local(c) === name);
const kid = (el: Element | undefined, ns: string, name: string) => (el ? kids(el, ns, name)[0] : undefined);
const attr = (el: Element | undefined, ns: string, name: string) => el?.getAttributeNS(ns, name) ?? el?.getAttribute(`${ns === W ? "w" : "m"}:${name}`) ?? null;

const SYMBOLS: Record<string, string> = {
  "∑": "\\sum",
  "∏": "\\prod",
  "∐": "\\coprod",
  "∫": "\\int",
  "∬": "\\iint",
  "∭": "\\iiint",
  "∮": "\\oint",
  "⋃": "\\bigcup",
  "⋂": "\\bigcap",
  "⋁": "\\bigvee",
  "⋀": "\\bigwedge",
};
const ACCENTS: Record<string, string> = { "̂": "\\hat", "̄": "\\bar", "̃": "\\tilde", "̇": "\\dot", "̈": "\\ddot", "⃗": "\\vec", "́": "\\acute" };
const FUNCTIONS = new Set(["sin", "cos", "tan", "cot", "sec", "csc", "log", "ln", "exp", "lim", "max", "min", "sup", "inf", "det", "gcd", "deg", "dim", "ker", "arg", "sinh", "cosh", "tanh", "arcsin", "arccos", "arctan", "Pr"]);

/** Office Math (OMML) to LaTeX, for the constructions equations commonly use. */
export function ommlToLatex(el: Element): string {
  const all = (parent: Element | undefined) => (parent ? [...parent.children].map(ommlToLatex).join("") : "");
  const arg = (name: string) => all(kid(el, M, name));
  const group = (text: string) => (text.length === 1 ? text : `{${text}}`);
  switch (local(el)) {
    case "oMath":
    case "oMathPara":
    case "e":
    case "num":
    case "den":
    case "sub":
    case "sup":
    case "deg":
    case "fName":
    case "lim":
    case "box":
    case "borderBox":
      return all(el);
    case "r": {
      const text = kids(el, M, "t").map((t) => t.textContent ?? "").join("");
      if (FUNCTIONS.has(text.trim())) return `\\${text.trim()} `;
      return text.replace(/[{}]/g, "\\$&");
    }
    case "f": {
      const type = attr(kid(kid(el, M, "fPr"), M, "type"), M, "val");
      if (type === "lin") return `${group(arg("num"))}/${group(arg("den"))}`;
      if (type === "noBar") return `\\genfrac{}{}{0pt}{}{${arg("num")}}{${arg("den")}}`;
      return `\\frac{${arg("num")}}{${arg("den")}}`;
    }
    case "sSup":
      return `${group(arg("e"))}^{${arg("sup")}}`;
    case "sSub":
      return `${group(arg("e"))}_{${arg("sub")}}`;
    case "sSubSup":
      return `${group(arg("e"))}_{${arg("sub")}}^{${arg("sup")}}`;
    case "sPre":
      return `{}_{${arg("sub")}}^{${arg("sup")}}${group(arg("e"))}`;
    case "rad": {
      const degree = arg("deg");
      return degree ? `\\sqrt[${degree}]{${arg("e")}}` : `\\sqrt{${arg("e")}}`;
    }
    case "nary": {
      const pr = kid(el, M, "naryPr");
      const chr = attr(kid(pr, M, "chr"), M, "val") ?? "∫";
      const op = SYMBOLS[chr] ?? chr;
      const sub = arg("sub");
      const sup = arg("sup");
      return `${op}${sub ? `_{${sub}}` : ""}${sup ? `^{${sup}}` : ""} ${arg("e")}`;
    }
    case "d": {
      const pr = kid(el, M, "dPr");
      const open = attr(kid(pr, M, "begChr"), M, "val") ?? "(";
      const close = attr(kid(pr, M, "endChr"), M, "val") ?? ")";
      const sep = attr(kid(pr, M, "sepChr"), M, "val") ?? ",";
      const delim = (c: string) => (c === "" ? "." : c === "{" ? "\\{" : c === "}" ? "\\}" : c === "‖" ? "\\|" : c === "⟨" ? "\\langle" : c === "⟩" ? "\\rangle" : c === "⌊" ? "\\lfloor" : c === "⌋" ? "\\rfloor" : c === "⌈" ? "\\lceil" : c === "⌉" ? "\\rceil" : c);
      return `\\left${delim(open)} ${kids(el, M, "e").map(ommlToLatex).join(sep)} \\right${delim(close)}`;
    }
    case "func":
      return `${arg("fName")}${group(arg("e"))}`;
    case "acc": {
      const chr = attr(kid(kid(el, M, "accPr"), M, "chr"), M, "val") ?? "̂";
      return `${ACCENTS[chr] ?? "\\hat"}{${arg("e")}}`;
    }
    case "bar": {
      const pos = attr(kid(kid(el, M, "barPr"), M, "pos"), M, "val");
      return pos === "bot" ? `\\underline{${arg("e")}}` : `\\overline{${arg("e")}}`;
    }
    case "limLow":
      return `${group(arg("e"))}_{${arg("lim")}}`;
    case "limUpp":
      return `${group(arg("e"))}^{${arg("lim")}}`;
    case "groupChr":
      return `\\underbrace{${arg("e")}}`;
    case "m":
      return `\\begin{matrix} ${kids(el, M, "mr")
        .map((row) => kids(row, M, "e").map(ommlToLatex).join(" & "))
        .join(" \\\\ ")} \\end{matrix}`;
    case "eqArr":
      return `\\begin{aligned} ${kids(el, M, "e").map(ommlToLatex).join(" \\\\ ")} \\end{aligned}`;
    default:
      return local(el).endsWith("Pr") || local(el) === "ctrlPr" ? "" : all(el);
  }
}

export interface DocxContent {
  title: string | null;
  markdown: string;
  /** Embedded images, by the `figure:` id the Markdown uses for them. */
  images: Map<string, Blob>;
}

const MEDIA_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp", svg: "image/svg+xml" };

export async function docxToMarkdown(bytes: Uint8Array): Promise<DocxContent> {
  const files = await unzip(bytes, (name) => name === "word/document.xml" || name === "word/_rels/document.xml.rels" || name.startsWith("word/media/"));
  const xml = files.get("word/document.xml");
  if (!xml) throw new Error("This file isn't a readable Word document.");
  const decode = (b: Uint8Array) => new TextDecoder().decode(b);
  const doc = new DOMParser().parseFromString(decode(xml), "application/xml");
  const rels = new Map<string, string>();
  const relsXml = files.get("word/_rels/document.xml.rels");
  if (relsXml) {
    const relDoc = new DOMParser().parseFromString(decode(relsXml), "application/xml");
    for (const rel of relDoc.getElementsByTagName("Relationship")) rels.set(rel.getAttribute("Id") ?? "", rel.getAttribute("Target") ?? "");
  }

  const images = new Map<string, Blob>();
  const image = (rid: string): string | null => {
    const target = rels.get(rid);
    if (!target) return null;
    const path = target.startsWith("/") ? target.slice(1) : `word/${target}`;
    const data = files.get(path);
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    if (!data || !MEDIA_TYPES[ext]) return null;
    const id = `docx-image${images.size + 1}`;
    images.set(id, new Blob([data.slice()], { type: MEDIA_TYPES[ext] }));
    return id;
  };

  let title: string | null = null;
  const blocks: string[] = [];
  const runText = (run: Element): string => {
    let text = "";
    for (const c of run.children) {
      if (c.namespaceURI === W && local(c) === "t") text += c.textContent ?? "";
      else if (c.namespaceURI === W && local(c) === "tab") text += " ";
      else if (c.namespaceURI === W && (local(c) === "br" || local(c) === "cr")) text += "\n";
    }
    const pr = kid(run, W, "rPr");
    const on = (name: string) => {
      const el = kid(pr, W, name);
      return !!el && attr(el, W, "val") !== "0" && attr(el, W, "val") !== "false";
    };
    if (!text.trim()) return text;
    if (on("b") && on("i")) return `***${text.trim()}*** `;
    if (on("b")) return `**${text.trim()}** `;
    if (on("i")) return `*${text.trim()}* `;
    return text;
  };

  const paragraph = (p: Element): { text: string; display: string[] } => {
    let text = "";
    const display: string[] = [];
    const visit = (el: Element) => {
      for (const c of el.children) {
        if (c.namespaceURI === M && local(c) === "oMathPara") display.push(ommlToLatex(c).trim());
        else if (c.namespaceURI === M && local(c) === "oMath") text += `$${ommlToLatex(c).trim()}$`;
        else if (c.namespaceURI === W && local(c) === "r") {
          for (const blip of c.getElementsByTagNameNS(A, "blip")) {
            const id = image(blip.getAttributeNS(R, "embed") ?? "");
            if (id) display.push(`![](figure:${id})`);
          }
          text += runText(c);
        } else if (c.namespaceURI === W && (local(c) === "hyperlink" || local(c) === "smartTag" || local(c) === "ins" || local(c) === "sdt" || local(c) === "sdtContent")) visit(c);
      }
    };
    visit(p);
    return { text: text.replace(/\*\* \*\*/g, " ").replace(/[ \t]+/g, " ").trim(), display };
  };

  const body = doc.getElementsByTagNameNS(W, "body")[0];
  if (!body) throw new Error("This file isn't a readable Word document.");
  for (const el of body.children) {
    if (el.namespaceURI === W && local(el) === "p") {
      const style = attr(kid(kid(el, W, "pPr"), W, "pStyle"), W, "val") ?? "";
      const list = !!kid(kid(el, W, "pPr"), W, "numPr");
      const { text, display } = paragraph(el);
      if (/^title$/i.test(style) && text) {
        title ??= text.replace(/\*/g, "");
        continue;
      }
      const heading = /^heading\s*([1-6])$/i.exec(style.replace(/(\D)(\d)$/, "$1 $2"));
      if (heading && text) blocks.push(`${"#".repeat(Math.min(3, Number(heading[1]) + 1))} ${text.replace(/\*/g, "")}`);
      else if (text) blocks.push(list ? `- ${text}` : text);
      for (const math of display) blocks.push(math.startsWith("![") ? math : `$$\n${math}\n$$`);
    } else if (el.namespaceURI === W && local(el) === "tbl") {
      const rows = kids(el, W, "tr").map((tr) => kids(tr, W, "tc").map((tc) => kids(tc, W, "p").map((p) => paragraph(p).text).join(" ").replace(/\|/g, "\\|")));
      if (rows.length) {
        const width = Math.max(...rows.map((r) => r.length));
        const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
        const [head, ...rest] = rows.map(pad);
        blocks.push([`| ${head.join(" | ")} |`, `|${" --- |".repeat(width)}`, ...rest.map((r) => `| ${r.join(" | ")} |`)].join("\n"));
      }
    }
  }
  // Consecutive list items stay one block.
  const markdown = blocks.join("\n\n").replace(/^(- .*)\n\n(?=- )/gm, "$1\n");
  return { title, markdown, images };
}
