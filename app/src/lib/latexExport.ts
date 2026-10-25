// A document as a LaTeX source a mathematician can keep working on, send to a journal or post
// to arXiv: amsart, compiled by pdfLaTeX. Statements and proofs become amsthm environments that
// keep the names and numbers they have in Theoremis; display equations are numbered by LaTeX in
// the same order Theoremis numbers them; figures and graphs become files beside the source.

import type { Nodes, Parent, PhrasingContent, Root, RootContent, Table } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { STATUS_INFO } from "./doc";
import { normalizeMath } from "./text";
import type { Doc } from "./types";

/** A file the source refers to, under `figures/`, and where its contents come from. */
export interface LatexFigure {
  path: string;
  from: { asset: string } | { graph: string; dim: 2 | 3 };
}

export interface LatexExport {
  tex: string;
  figures: LatexFigure[];
}

export interface LatexOptions {
  author?: string;
  /** The document's own macros, as LaTeX: \newcommand, \DeclareMathOperator… */
  macros?: string;
  /** The BibTeX file to cite from, without its extension, when the document cites anything. */
  bibliography?: string;
  /** Whether a graph could be pictured. One that couldn't is kept as its code. */
  pictured?: (code: string, dim: 2 | 3) => boolean;
  /** When the export was made, for the note at the top. */
  date?: Date;
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

function parse(markdown: string): Root {
  return parser.parse(keepCaptions(normalizeMath(markdown))) as Root;
}

/** An image's alt text loses its `$`s in parsing; keep it whole as the title, which is verbatim. */
function keepCaptions(markdown: string): string {
  return markdown.replace(/!\[((?:[^[\]\n]|\[[^[\]\n]*\])+)\]\((asset:[\w.-]+)\)/g, (_, alt: string, url: string) => `![${alt}](${url} "${alt.replace(/(["\\])/g, "\\$1")}")`);
}

/** Image formats pdfLaTeX includes as they are; others are converted to PNG. */
const INCLUDABLE = /\.(png|jpe?g|pdf)$/i;

interface Context {
  figures: LatexFigure[];
  footnotes: Map<string, RootContent[]>;
  graphs: number;
  pictured: (code: string, dim: 2 | 3) => boolean;
}

export function documentToLatex(doc: Doc, options: LatexOptions = {}): LatexExport {
  const ctx: Context = { figures: [], footnotes: new Map(), graphs: 0, pictured: options.pictured ?? (() => true) };
  const body: string[] = [];
  for (const block of doc.blocks) {
    if (block.suggestion || !block.source.trim()) continue;
    const status = block.status ? `% Theoremis: ${STATUS_INFO[block.status].label.toLowerCase()}${block.note ? ` (${oneLine(block.note)})` : ""}\n` : "";
    body.push(status + convertBlock(block.source, ctx));
  }
  const phrased = phrasingOf(doc.title);
  const title = !doc.title.trim() ? "Untitled" : phrased.length ? inline(phrased, ctx) : escapeText(doc.title.trim());
  const author = options.author?.trim() ? escapeText(options.author.trim()) : "";
  const abstract = doc.lede.trim() ? convertMarkdown(doc.lede, ctx) : "";
  const cites = /\\cite[pt]?\*?(?:\[[^\]]*\])?\{/.test(body.join("\n"));

  const content = [
    abstract && `\\begin{abstract}\n${abstract}\n\\end{abstract}`,
    "\\maketitle",
    ...body,
    cites && options.bibliography ? `\\bibliographystyle{amsplain}\n\\bibliography{${options.bibliography}}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const preamble = [
    `% Exported from Theoremis${options.date ? ` on ${options.date.toISOString().slice(0, 10)}` : ""}. Compile with pdfLaTeX.`,
    "% Statuses from Theoremis are kept as comments; only Lean's checks are machine-verified.",
    "\\documentclass[11pt]{amsart}",
    "\\usepackage[utf8]{inputenc}",
    "\\usepackage[T1]{fontenc}",
    "\\usepackage{lmodern}",
    "\\usepackage{amsmath,amssymb,amsthm,mathtools}",
    ...packages(content + (options.macros ?? "")),
    "\\usepackage[hidelinks]{hyperref}",
    unicodeDeclarations(`${title}\n${author}\n${content}`),
    macroSection(options.macros, content),
    STATEMENTS,
    `\\title{${title}}`,
    author ? `\\author{${author}}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return { tex: `${preamble}\n\n\\begin{document}\n\n${content}\n\n\\end{document}\n`, figures: ctx.figures };
}

/** Statements keep their names and numbers: \begin{statement}{Theorem 2.1}. Italic bodies use the first. */
const STATEMENTS = String.raw`
% Statements keep the names and numbers they have in Theoremis, e.g. \begin{statement}{Theorem 2.1}.
% statement* is for those whose text is upright, like definitions and remarks.
\newcommand{\statementname}{}
\theoremstyle{plain}
\newtheorem*{statementit}{\statementname}
\theoremstyle{definition}
\newtheorem*{statementup}{\statementname}
\newenvironment{statement}[1]{\renewcommand{\statementname}{#1}\begin{statementit}}{\end{statementit}}
\newenvironment{statement*}[1]{\renewcommand{\statementname}{#1}\begin{statementup}}{\end{statementup}}`;

/** Words that open a statement, as in "**Theorem 2.** …". */
const STATEMENT_KINDS = new Set(
  "theorem lemma proposition corollary conjecture claim fact observation hypothesis assumption axiom definition example examples exercise problem question notation convention construction remark remarks note principle property criterion".split(
    " ",
  ),
);

const LABEL = /^\s*\*\*([^*\n]{1,80}?)\*\*\s*/;
const NOTE = /^\(([^()\n]{1,80})\)\.?\s*/;
const PROOF = /^\s*([*_])(Proof\b[^*_\n]{0,80}?)\1\s*/;
const QED = /(?:\s*(?:∎|□|■|\$\\(?:square|blacksquare|Box|qedsymbol)\$|\\qed(?:symbol)?))+\s*$/;

/** One block: a statement, a proof, or ordinary Markdown. */
function convertBlock(source: string, ctx: Context): string {
  const label = LABEL.exec(source);
  if (label) {
    let name = label[1].trim().replace(/[.:]$/, "").trim();
    const kind = name.split(/\s+/)[0].toLowerCase();
    if (kind === "proof") return proofOf(name, source.slice(label[0].length), ctx);
    if (STATEMENT_KINDS.has(kind)) {
      let rest = source.slice(label[0].length);
      const note = NOTE.exec(rest);
      if (note) {
        name = `${name} (${note[1].trim()})`;
        rest = rest.slice(note[0].length);
      }
      const tree = parse(rest);
      collectFootnotes(tree, ctx);
      const italic = italicThroughout(tree.children);
      if (italic) tree.children = unwrapItalic(tree.children);
      const env = italic ? "statement" : "statement*";
      return `\\begin{${env}}{${inline(phrasingOf(name), ctx)}}\n${blocks(tree.children, ctx)}\n\\end{${env}}`;
    }
  }
  const proof = PROOF.exec(source);
  if (proof) return proofOf(proof[2].trim().replace(/[.:]$/, "").trim(), source.slice(proof[0].length), ctx);
  return convertMarkdown(source, ctx);
}

/** A proof: amsthm's, which ends with its own box, so one written at the end is dropped. */
function proofOf(name: string, rest: string, ctx: Context): string {
  const open = name === "Proof" ? "\\begin{proof}" : `\\begin{proof}[${inline(phrasingOf(name), ctx)}]`;
  return `${open}\n${convertMarkdown(rest.replace(QED, ""), ctx)}\n\\end{proof}`;
}

function convertMarkdown(markdown: string, ctx: Context): string {
  const tree = parse(markdown);
  collectFootnotes(tree, ctx);
  return blocks(tree.children, ctx);
}

function collectFootnotes(tree: Root, ctx: Context) {
  for (const node of tree.children) if (node.type === "footnoteDefinition") ctx.footnotes.set(node.identifier, node.children);
}

function phrasingOf(markdown: string): PhrasingContent[] {
  const first = parse(markdown).children[0];
  return first && first.type === "paragraph" ? first.children : [];
}

/** Whether every paragraph is set in italics, as statements usually are: "*For every n…*". */
function italicThroughout(nodes: RootContent[]): boolean {
  let paragraphs = 0;
  const check = (list: Nodes[]): boolean =>
    list.every((node) => {
      if (node.type === "paragraph") {
        paragraphs++;
        const kids = node.children.filter((c) => !(c.type === "text" && !c.value.trim()));
        return kids.length === 1 && kids[0].type === "emphasis";
      }
      if (node.type === "list" || node.type === "listItem") return check((node as Parent).children as Nodes[]);
      return node.type === "math" || node.type === "code";
    });
  return check(nodes) && paragraphs > 0;
}

function unwrapItalic<T extends Nodes>(nodes: T[]): T[] {
  return nodes.map((node) => {
    if (node.type === "paragraph") {
      const kids = node.children.filter((c) => !(c.type === "text" && !c.value.trim()));
      if (kids.length === 1 && kids[0].type === "emphasis") return { ...node, children: kids[0].children } as T;
    }
    if (node.type === "list" || node.type === "listItem") return { ...node, children: unwrapItalic((node as Parent).children as Nodes[]) } as T;
    return node;
  });
}

function blocks(nodes: RootContent[], ctx: Context): string {
  return nodes
    .map((node) => block(node, ctx))
    .filter((text) => text.trim())
    .join("\n\n");
}

const SECTIONS = ["section", "section", "subsection", "subsubsection", "paragraph", "paragraph"];

function block(node: RootContent, ctx: Context): string {
  switch (node.type) {
    case "paragraph": {
      const kids = node.children.filter((c) => !(c.type === "text" && !c.value.trim()));
      if (kids.length === 1 && kids[0].type === "image") return figure(kids[0].url, kids[0].title ?? kids[0].alt ?? "", ctx);
      return inline(node.children, ctx);
    }
    case "heading":
      // Unnumbered, with the heading's own text: Theoremis shows numbers only as written.
      return `\\${SECTIONS[node.depth - 1]}*{${inline(node.children, ctx)}}`;
    case "thematicBreak":
      return "\\begin{center}\\rule{0.4\\linewidth}{0.4pt}\\end{center}";
    case "blockquote":
      return `\\begin{quote}\n${blocks(node.children, ctx)}\n\\end{quote}`;
    case "list": {
      const env = node.ordered ? "enumerate" : "itemize";
      const start = node.ordered && node.start && node.start !== 1 ? `\\setcounter{enumi}{${node.start - 1}}\n` : "";
      const items = node.children.map((item) => {
        const mark = item.checked === true ? "[$\\boxtimes$] " : item.checked === false ? "[$\\square$] " : " ";
        return `\\item${mark}${blocks(item.children, ctx)}`.replace(/\\item (\s)/, "\\item$1");
      });
      return `\\begin{${env}}\n${start}${items.join("\n")}\n\\end{${env}}`;
    }
    case "code":
      return code(node.lang ?? "", node.value, ctx);
    case "math":
      return displayMath(node.value);
    case "table":
      return table(node, ctx);
    case "html":
      return "";
    case "definition":
    case "footnoteDefinition":
      return "";
    default:
      return "";
  }
}

function code(language: string, value: string, ctx: Context): string {
  if (language === "graph" || language === "graph3d") {
    const dim = language === "graph3d" ? 3 : 2;
    if (ctx.pictured(value, dim)) {
      ctx.graphs++;
      const path = `figures/graph-${ctx.graphs}.png`;
      ctx.figures.push({ path, from: { graph: value, dim } });
      return `\\begin{figure}[htbp]\n\\centering\n\\includegraphics[width=0.8\\linewidth]{${path}}\n\\end{figure}`;
    }
    return `% A ${dim}D graph from Theoremis, drawn there from this code:\n${verbatim(value)}`;
  }
  return verbatim(value, language === "lean" || language === "lean4");
}

function verbatim(value: string, small = false): string {
  const text = value.replace(/\\end\{verbatim\}/g, "\\end {verbatim}");
  const env = `\\begin{verbatim}\n${text.replace(/\n$/, "")}\n\\end{verbatim}`;
  return small ? `{\\footnotesize\n${env}\n}` : env;
}

const NUMBERED_ENV = /^\\begin\{(align|gather)\}([\s\S]*)\\end\{\1\}$/;
const NO_NUMBER = /\\(?:notag|nonumber)\b/;
const NO_NUMBER_ALL = /\\(?:notag|nonumber)\b/g;

/**
 * A display equation, numbered exactly when Theoremis numbers it (`numberEquations`), so the
 * numbers the prose refers to stay right: LaTeX's counter then gives the same sequence.
 */
export function displayMath(raw: string): string {
  const body = raw.trim();
  const isEnv = /^\\begin\{/.test(body);
  if (/\\tag\b/.test(body)) return isEnv ? body : equation(body);
  const env = NUMBERED_ENV.exec(body);
  if (env && !/\\begin\{/.test(env[2])) return body;
  if (/\\begin\{(?:align|gather|equation)\*?\}/.test(body)) {
    // Theoremis shows an equation environment without a number, so this does too.
    if (/\\begin\{equation\}/.test(body)) return `\\[\n${body.replace(/\\begin\{equation\}|\\end\{equation\}/g, "").trim()}\n\\]`;
    return body;
  }
  if (NO_NUMBER.test(body)) return `\\[\n${body.replace(NO_NUMBER_ALL, "").trim()}\n\\]`;
  return equation(body);
}

function equation(body: string): string {
  // Lines broken with \\ need an environment that has lines, as KaTeX allows them anywhere.
  const lines = /\\\\/.test(body) && !/\\begin\{/.test(body);
  return lines ? `\\begin{equation}\n\\begin{gathered}\n${body}\n\\end{gathered}\n\\end{equation}` : `\\begin{equation}\n${body}\n\\end{equation}`;
}

function table(node: Table, ctx: Context): string {
  const columns = (node.align ?? []).map((a) => (a === "right" ? "r" : a === "center" ? "c" : "l"));
  const width = Math.max(columns.length, ...node.children.map((row) => row.children.length));
  while (columns.length < width) columns.push("l");
  const rows = node.children.map((row) => `${row.children.map((cell) => inline(cell.children, ctx)).join(" & ")} \\\\`);
  const [head, ...rest] = rows;
  return [`\\begin{center}`, `\\begin{tabular}{${columns.join("")}}`, "\\toprule", head, "\\midrule", ...rest, "\\bottomrule", "\\end{tabular}", "\\end{center}"].join("\n");
}

function figure(url: string, caption: string, ctx: Context): string {
  const name = /^asset:([\w.-]+)$/.exec(url)?.[1];
  if (!name) return url ? `\\url{${escapeUrl(url)}}` : "";
  const path = `figures/${INCLUDABLE.test(name) ? name : name.replace(/\.[^.]+$/, "") + ".png"}`;
  if (!ctx.figures.some((f) => f.path === path)) ctx.figures.push({ path, from: { asset: name } });
  const text = caption.trim() ? `\n\\caption{${inline(phrasingOf(caption), ctx)}}` : "";
  return `\\begin{figure}[htbp]\n\\centering\n\\includegraphics[width=0.8\\linewidth]{${path}}${text}\n\\end{figure}`;
}

/** Adjacent text nodes, merged, so a citation split across them is seen whole. */
function merged(nodes: PhrasingContent[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const node of nodes) {
    const last = out[out.length - 1];
    if (node.type === "text" && last?.type === "text") out[out.length - 1] = { ...last, value: last.value + node.value };
    else out.push(node);
  }
  return out;
}

function inline(nodes: PhrasingContent[], ctx: Context): string {
  return merged(nodes)
    .map((node) => phrase(node, ctx))
    .join("");
}

function phrase(node: PhrasingContent, ctx: Context): string {
  switch (node.type) {
    case "text":
      return textWithCitations(node.value);
    case "emphasis":
      return `\\emph{${inline(node.children, ctx)}}`;
    case "strong":
      return `\\textbf{${inline(node.children, ctx)}}`;
    case "delete":
      return `\\sout{${inline(node.children, ctx)}}`;
    case "inlineCode":
      return `\\texttt{${escapeText(node.value)}}`;
    case "inlineMath":
      return `$${node.value}$`;
    case "break":
      return "\\\\\n";
    case "link": {
      const text = inline(node.children, ctx);
      const plain = node.children.length === 1 && node.children[0].type === "text" && node.children[0].value === node.url;
      return plain ? `\\url{${escapeUrl(node.url)}}` : `\\href{${escapeUrl(node.url)}}{${text}}`;
    }
    case "image": {
      const name = /^asset:([\w.-]+)$/.exec(node.url)?.[1];
      if (!name) return "";
      const path = `figures/${INCLUDABLE.test(name) ? name : name.replace(/\.[^.]+$/, "") + ".png"}`;
      if (!ctx.figures.some((f) => f.path === path)) ctx.figures.push({ path, from: { asset: name } });
      return `\\includegraphics[height=1.2em]{${path}}`;
    }
    case "footnoteReference": {
      const note = ctx.footnotes.get(node.identifier);
      return note ? `\\footnote{${blocks(note, ctx)}}` : "";
    }
    case "linkReference":
    case "imageReference":
      return "children" in node ? inline(node.children, ctx) : "";
    case "html":
      return "";
    default:
      return "";
  }
}

/** Citations written as LaTeX (\cite{key}, \cite[Thm. 2]{key}) pass through; the rest is escaped. */
const CITATION = /\\cite[pt]?\*?(?:\[[^\]\n]*\])?\{[^}\n]+\}/g;

function textWithCitations(value: string): string {
  let out = "";
  let at = 0;
  for (const match of value.matchAll(CITATION)) {
    out += escapeText(value.slice(at, match.index));
    out += match[0];
    at = match.index + match[0].length;
  }
  return out + escapeText(value.slice(at));
}

const SPECIAL: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  "#": "\\#",
  $: "\\$",
  "%": "\\%",
  "&": "\\&",
  _: "\\_",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

export function escapeText(text: string): string {
  return text
    .replace(/[\\{}#$%&_~^]/g, (c) => SPECIAL[c])
    .replace(/“/g, "``")
    .replace(/”/g, "''")
    .replace(/‘/g, "`")
    .replace(/’/g, "'")
    .replace(/—/g, "---")
    .replace(/–/g, "--")
    .replace(/…/g, "\\dots{}")
    .replace(/\u00a0/g, "~");
}

function escapeUrl(url: string): string {
  return url.replace(/([%#\\{}])/g, "\\$1");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Packages the source needs beyond the usual ones, from the commands it uses. */
function packages(text: string): string[] {
  const out: string[] = [];
  if (/\\includegraphics/.test(text)) out.push("\\usepackage{graphicx}");
  if (/\\toprule/.test(text)) out.push("\\usepackage{booktabs}");
  if (/\\sout\{/.test(text)) out.push("\\usepackage[normalem]{ulem}");
  if (/\\bm\{|\\bm\\/.test(text)) out.push("\\usepackage{bm}");
  if (/\\mathscr\{/.test(text)) out.push("\\usepackage{mathrsfs}");
  if (/\\(?:llbracket|rrbracket)\b/.test(text)) out.push("\\usepackage{stmaryrd}");
  if (/\\(?:cancel|bcancel|xcancel|cancelto)\{/.test(text)) out.push("\\usepackage{cancel}");
  if (/\\(?:color|textcolor|colorbox)\{/.test(text)) out.push("\\usepackage{xcolor}");
  return out;
}

/** Macros KaTeX knows but LaTeX doesn't, defined only if the document's own macros don't. */
const KATEX_MACROS: Record<string, string> = {
  R: "\\mathbb{R}",
  N: "\\mathbb{N}",
  Z: "\\mathbb{Z}",
  Q: "\\mathbb{Q}",
  C: "\\mathbb{C}",
  Reals: "\\mathbb{R}",
  reals: "\\mathbb{R}",
  natnums: "\\mathbb{N}",
  Complex: "\\mathbb{C}",
  cnums: "\\mathbb{C}",
  infin: "\\infty",
  isin: "\\in",
  sub: "\\subset",
  sube: "\\subseteq",
  supe: "\\supseteq",
  lang: "\\langle",
  rang: "\\rangle",
  larr: "\\leftarrow",
  rarr: "\\rightarrow",
  Larr: "\\Leftarrow",
  Rarr: "\\Rightarrow",
  harr: "\\leftrightarrow",
  Harr: "\\Leftrightarrow",
  lrarr: "\\leftrightarrow",
  Lrarr: "\\Leftrightarrow",
  plusmn: "\\pm",
  sdot: "\\cdot",
  bull: "\\bullet",
  exist: "\\exists",
};

function macroSection(macros: string | undefined, content: string): string {
  const own = macros?.trim() ?? "";
  const provided = Object.entries(KATEX_MACROS)
    .filter(([name]) => new RegExp(`\\\\${name}(?![A-Za-z])`).test(content))
    .map(([name, body]) => `\\providecommand{\\${name}}{${body}}`);
  if (!own && !provided.length) return "";
  return ["", own && "% The document's macros", own, provided.length ? "% Macros KaTeX provides that LaTeX doesn't" : "", ...provided].filter(Boolean).join("\n");
}

/** Characters pdfLaTeX can't typeset by itself, with what to typeset instead. */
const UNICODE: Record<string, string> = {
  "±": "\\pm", "×": "\\times", "÷": "\\div", "¬": "\\neg", "·": "\\cdot", "°": "^{\\circ}", "µ": "\\mu", "¹": "^{1}", "²": "^{2}", "³": "^{3}",
  α: "\\alpha", β: "\\beta", γ: "\\gamma", δ: "\\delta", ε: "\\varepsilon", ϵ: "\\epsilon", ζ: "\\zeta", η: "\\eta", θ: "\\theta", ϑ: "\\vartheta",
  ι: "\\iota", κ: "\\kappa", λ: "\\lambda", μ: "\\mu", ν: "\\nu", ξ: "\\xi", π: "\\pi", ϖ: "\\varpi", ρ: "\\rho", ϱ: "\\varrho", σ: "\\sigma",
  ς: "\\varsigma", τ: "\\tau", υ: "\\upsilon", φ: "\\varphi", ϕ: "\\phi", χ: "\\chi", ψ: "\\psi", ω: "\\omega",
  Γ: "\\Gamma", Δ: "\\Delta", Θ: "\\Theta", Λ: "\\Lambda", Ξ: "\\Xi", Π: "\\Pi", Σ: "\\Sigma", Υ: "\\Upsilon", Φ: "\\Phi", Ψ: "\\Psi", Ω: "\\Omega",
  ℕ: "\\mathbb{N}", ℤ: "\\mathbb{Z}", ℚ: "\\mathbb{Q}", ℝ: "\\mathbb{R}", ℂ: "\\mathbb{C}", ℙ: "\\mathbb{P}", ℍ: "\\mathbb{H}", "𝔽": "\\mathbb{F}",
  "∑": "\\sum", "∏": "\\prod", "∐": "\\coprod", "∫": "\\int", "∮": "\\oint", "∂": "\\partial", "∇": "\\nabla", "∞": "\\infty", "√": "\\surd",
  "∈": "\\in", "∉": "\\notin", "∋": "\\ni", "⊂": "\\subset", "⊆": "\\subseteq", "⊊": "\\subsetneq", "⊃": "\\supset", "⊇": "\\supseteq",
  "∪": "\\cup", "∩": "\\cap", "⋃": "\\bigcup", "⋂": "\\bigcap", "⊔": "\\sqcup", "⊓": "\\sqcap", "∅": "\\emptyset", "∖": "\\setminus",
  "∀": "\\forall", "∃": "\\exists", "∄": "\\nexists", "∧": "\\wedge", "∨": "\\vee", "⊢": "\\vdash", "⊨": "\\models", "⊤": "\\top", "⊥": "\\bot",
  "→": "\\to", "←": "\\leftarrow", "↔": "\\leftrightarrow", "⇒": "\\Rightarrow", "⇐": "\\Leftarrow", "⇔": "\\Leftrightarrow", "↦": "\\mapsto",
  "⟶": "\\longrightarrow", "⟹": "\\Longrightarrow", "⟷": "\\longleftrightarrow", "↑": "\\uparrow", "↓": "\\downarrow", "↪": "\\hookrightarrow", "↠": "\\twoheadrightarrow",
  "≤": "\\le", "≥": "\\ge", "≠": "\\ne", "≈": "\\approx", "≡": "\\equiv", "≅": "\\cong", "≃": "\\simeq", "∼": "\\sim", "∝": "\\propto",
  "≪": "\\ll", "≫": "\\gg", "≺": "\\prec", "≻": "\\succ", "≼": "\\preceq", "≽": "\\succeq", "∣": "\\mid", "∤": "\\nmid", "∥": "\\parallel",
  "∘": "\\circ", "⊗": "\\otimes", "⊕": "\\oplus", "⊙": "\\odot", "⋅": "\\cdot", "∙": "\\bullet", "•": "\\bullet", "∗": "\\ast", "⋆": "\\star",
  "⟨": "\\langle", "⟩": "\\rangle", "⌊": "\\lfloor", "⌋": "\\rfloor", "⌈": "\\lceil", "⌉": "\\rceil", "‖": "\\|", "⦃": "\\{\\!|", "⦄": "|\\!\\}",
  ℓ: "\\ell", ℵ: "\\aleph", "′": "'", "″": "''", "⋯": "\\cdots", "⋮": "\\vdots", "⋱": "\\ddots", "∎": "\\blacksquare", "□": "\\square", "■": "\\blacksquare",
  "⁰": "^{0}", "⁴": "^{4}", "⁵": "^{5}", "⁶": "^{6}", "⁷": "^{7}", "⁸": "^{8}", "⁹": "^{9}", "⁻": "^{-}", "⁺": "^{+}", "ⁿ": "^{n}", ᶠ: "^{f}",
  "₀": "_{0}", "₁": "_{1}", "₂": "_{2}", "₃": "_{3}", "₄": "_{4}", "₅": "_{5}", "₆": "_{6}", "₇": "_{7}", "₈": "_{8}", "₉": "_{9}",
  "₊": "_{+}", "₋": "_{-}", ᵢ: "_{i}", ⱼ: "_{j}", ₖ: "_{k}", ₙ: "_{n}", ₘ: "_{m}", ₓ: "_{x}",
};

/** Ranges pdfLaTeX with T1 fonts and UTF-8 input already handles: accented Latin letters, punctuation. */
function known(char: string): boolean {
  const code = char.codePointAt(0)!;
  return (code >= 0xa0 && code <= 0x17f && !(char in UNICODE)) || (code >= 0x2010 && code <= 0x2027 && !(char in UNICODE));
}

function unicodeDeclarations(text: string): string {
  const chars = [...new Set([...text].filter((c) => c.codePointAt(0)! > 0x7f && !known(c)))].sort();
  if (!chars.length) return "";
  const lines = chars.map((c) => {
    const hex = c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
    const value = UNICODE[c];
    return value ? `\\DeclareUnicodeCharacter{${hex}}{\\ensuremath{${value}}}` : `\\DeclareUnicodeCharacter{${hex}}{\\textbf{?}} % ${c}: no pdfLaTeX equivalent`;
  });
  return ["", "% Characters pdfLaTeX doesn't know by itself", ...lines].join("\n");
}

/** A file name for the export, from the title: "Odd numbers" → "odd-numbers". */
export function exportName(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\$[^$]*\$/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "untitled";
}
