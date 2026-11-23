// Turning text formats into Theoremis blocks without a model: Markdown, LaTeX, notebooks,
// tables and code. Used when importing such files directly, and as the fallback when no
// collaborator is available.

import { normalizeMath } from "./text";
import type { Status } from "./types";

export interface ConvertedBlock {
  source: string;
  status?: Status;
  note?: string;
}

export interface Converted {
  title: string | null;
  lede: string | null;
  blocks: ConvertedBlock[];
}

const PROVED_KINDS = /^(?:\*\*|\*|_)?(theorem|lemma|proposition|corollary|claim|fact)\b/i;
const OPEN_KINDS = /^(?:\*\*|\*|_)?(conjecture|question|problem|open problem|hypothesis)\b/i;
const PROOF = /^(?:\*|_|\*\*)?proof\b/i;

/** Statuses for statements, as a transcription would give them: proved in the source or not. */
export function assignStatuses(blocks: ConvertedBlock[]): ConvertedBlock[] {
  return blocks.map((block, i) => {
    if (block.status) return block;
    const text = block.source.trimStart();
    if (OPEN_KINDS.test(text)) return { ...block, status: "open" as const };
    if (PROVED_KINDS.test(text)) {
      const proved = PROOF.test(blocks[i + 1]?.source.trimStart() ?? "") || /\n\s*(\*|_)?proof\b/i.test(text);
      return proved ? { ...block, status: "draft" as const, note: "proof in source" } : { ...block, status: "open" as const };
    }
    return block;
  });
}

/**
 * Splits Markdown into blocks at blank lines, keeping display math, code fences, lists and
 * tables whole, and a statement together with the display equations that finish it.
 */
export function markdownToBlocks(markdown: string): Converted {
  const lines = normalizeMath(markdown.replace(/\r\n?/g, "\n")).split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  let math = false;
  const flush = () => {
    const text = current.join("\n").trim();
    if (text) chunks.push(text);
    current = [];
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (fence) {
      current.push(line);
      if (trimmed.startsWith(fence)) fence = null;
      continue;
    }
    if (math) {
      current.push(line);
      if (trimmed === "$$") math = false;
      continue;
    }
    if (/^(```|~~~)/.test(trimmed)) {
      fence = trimmed.slice(0, 3);
      current.push(line);
      continue;
    }
    if (trimmed === "$$") {
      math = true;
      current.push(line);
      continue;
    }
    if (/^#{1,6}\s/.test(trimmed)) {
      flush();
      chunks.push(trimmed);
      continue;
    }
    if (!trimmed) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();

  // A paragraph ending in ":" or a display equation, followed by a display equation, is one block.
  const merged: string[] = [];
  for (const chunk of chunks) {
    const previous = merged[merged.length - 1];
    // A display equation usually finishes the sentence before it, unless that sentence ended,
    // and a paragraph that starts in lower case carries on the sentence of the equation above.
    const continuesEquation = previous?.endsWith("$$") && /^[a-z]/.test(chunk);
    const finishesSentence = chunk.startsWith("$$") && !/[.?!]\**$/.test(previous ?? ".");
    if (previous !== undefined && !previous.startsWith("#") && (continuesEquation || finishesSentence)) {
      merged[merged.length - 1] = `${previous}\n\n${chunk}`;
    } else merged.push(chunk);
  }

  let title: string | null = null;
  if (merged[0]?.startsWith("# ")) title = merged.shift()!.slice(2).trim();
  return { title, lede: null, blocks: assignStatuses(merged.map((source) => ({ source }))) };
}

// ---------------------------------------------------------------------------
// LaTeX

/** The argument of `\command{…}` starting at `open` (the brace), and where it ends. */
function braced(text: string, open: number): { body: string; end: number } | null {
  if (text[open] !== "{") return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return { body: text.slice(open + 1, i), end: i + 1 };
  }
  return null;
}

/** Replaces every `\name{arg}` (with an optional `[…]` first) by `fn(arg)`. */
function replaceCommand(text: string, name: string, fn: (arg: string, optional: string | null) => string): string {
  const pattern = new RegExp(`\\\\${name}\\*?\\s*(?:\\[([^\\]]*)\\])?\\s*(?=\\{)`, "g");
  let out = "";
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const arg = braced(text, match.index + match[0].length);
    if (!arg) continue;
    out += text.slice(last, match.index) + fn(arg.body, match[1] ?? null);
    last = arg.end;
    pattern.lastIndex = arg.end;
  }
  return out + text.slice(last);
}

const THEOREM_NAMES: Record<string, string> = {
  theorem: "Theorem",
  thm: "Theorem",
  lemma: "Lemma",
  lem: "Lemma",
  proposition: "Proposition",
  prop: "Proposition",
  corollary: "Corollary",
  cor: "Corollary",
  conjecture: "Conjecture",
  conj: "Conjecture",
  definition: "Definition",
  defn: "Definition",
  def: "Definition",
  example: "Example",
  ex: "Example",
  remark: "Remark",
  rem: "Remark",
  question: "Question",
  problem: "Problem",
  claim: "Claim",
  exercise: "Exercise",
  notation: "Notation",
  observation: "Observation",
  fact: "Fact",
};

/** Replaces `\name{a}{b}` by `fn(a, b)`. */
function replaceCommand2(text: string, name: string, fn: (a: string, b: string) => string): string {
  const pattern = new RegExp(`\\\\${name}\\s*(?=\\{)`, "g");
  let out = "";
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const a = braced(text, match.index + match[0].length);
    const gap = a ? text.slice(a.end).match(/^\s*/)![0].length : 0;
    const b = a ? braced(text, a.end + gap) : null;
    if (!a || !b) continue;
    out += text.slice(last, match.index) + fn(a.body, b.body);
    last = b.end;
    pattern.lastIndex = b.end;
  }
  return out + text.slice(last);
}

const DISPLAY = /\n\$\$\n([\s\S]*?)\n\$\$\n/g;
const ROWS_ENV = /^\\begin\{(align|gather)(\*?)\}([\s\S]*)\\end\{\1\2\}$/;
const NO_NUMBER = /\\(?:notag|nonumber)\b/;

/**
 * Numbers display equations the way Theoremis does (each row of an align or gather, skipping
 * \notag and starred environments), recording which number each \label received.
 */
function numberLabels(markdown: string, labels: Map<string, string>): string {
  let next = 1;
  return markdown.replace(DISPLAY, (_, raw: string) => {
    const body = raw.trim();
    const take = (part: string) => {
      const label = /\\label\{([^}]+)\}/.exec(part)?.[1];
      if (label) labels.set(label, String(next));
      next++;
    };
    const rows = ROWS_ENV.exec(body);
    if (rows) {
      if (!rows[2]) for (const row of rows[3].split(/\\\\/)) if (row.trim() && !NO_NUMBER.test(row)) take(row);
    } else if (!NO_NUMBER.test(body) && !/\\tag\b/.test(body) && !/\\begin\{\w+\*\}/.test(body)) take(body);
    return `\n$$\n${body.replace(/\\label\{[^}]*\}/g, "").trim()}\n$$\n`;
  });
}

/**
 * Converts a LaTeX document to Theoremis Markdown: sections, theorem environments (numbered
 * as the source's `\newtheorem`s share counters), proofs, display math, lists, emphasis,
 * citations and cross-references. Figures become `figure:<file>` links to uploaded images.
 */
export function latexToMarkdown(source: string): { title: string | null; lede: string | null; markdown: string } {
  // Comments, but not escaped percent signs.
  let tex = source.replace(/\r\n?/g, "\n").replace(/(^|[^\\])%.*$/gm, "$1");

  const names: Record<string, string> = { ...THEOREM_NAMES };
  const counterOf: Record<string, string> = {};
  const unnumbered = new Set<string>();
  // \newtheorem{env}[shared]{Name}, \newtheorem{env}{Name}[section], \newtheorem*{env}{Name}
  for (const m of tex.matchAll(/\\newtheorem(\*?)\s*\{(\w+)\}\s*(?:\[(\w+)\])?\s*\{([^}]*)\}/g)) {
    names[m[2]] = m[4].trim();
    if (m[1]) unnumbered.add(m[2]);
    else counterOf[m[2]] = m[3] ?? m[2];
  }
  const counterFor = (env: string) => counterOf[env] ?? (THEOREM_NAMES[env] ? "theorem" : env);

  const titleMatch = /\\title\s*(?:\[[^\]]*\])?\s*(?=\{)/.exec(tex);
  const titleText = titleMatch ? (braced(tex, titleMatch.index + titleMatch[0].length)?.body ?? null) : null;
  const abstract = /\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/.exec(tex)?.[1] ?? null;

  const begin = tex.indexOf("\\begin{document}");
  if (begin >= 0) tex = tex.slice(begin + "\\begin{document}".length);
  tex = tex.replace(/\\end\{document\}[\s\S]*$/, "");
  tex = tex.replace(/\\begin\{abstract\}[\s\S]*?\\end\{abstract\}/, "");
  tex = tex.replace(/\\(maketitle|tableofcontents|newpage|clearpage|noindent|medskip|bigskip|smallskip|centering|qedhere|appendix)\b/g, "");
  tex = replaceCommand(tex, "(?:title|author|date|thanks|address|email|keywords|subjclass|dedicatory|bibliographystyle|bibliography)", () => "");

  const labels = new Map<string, string>();
  let sections = 0;
  let subsections = 0;
  const takeLabel = (body: string, number: string) => {
    const label = /^\s*\\label\{([^}]+)\}/.exec(body)?.[1];
    if (label) labels.set(label, number);
    return body.replace(/^\s*\\label\{[^}]+\}/, "");
  };

  // Sections, numbered for \ref.
  tex = tex.replace(/\\(section|subsection|subsubsection|paragraph)(\*?)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}(\s*\\label\{([^}]+)\})?/g, (_, kind: string, star: string, heading: string, _l: string, label?: string) => {
    if (kind === "section") {
      if (!star) sections++;
      subsections = 0;
      if (label) labels.set(label, String(sections));
      return `\n\n## ${star ? "" : `${sections} `}${heading.trim()}\n\n`;
    }
    if (kind === "subsection") {
      if (!star) subsections++;
      if (label) labels.set(label, `${sections}.${subsections}`);
      return `\n\n### ${star ? "" : `${sections}.${subsections} `}${heading.trim()}\n\n`;
    }
    return `\n\n**${heading.trim()}.** `;
  });

  // Figures: \includegraphics{file} with its \caption.
  const figureLink = (file: string, caption: string) => {
    const name = file.split("/").pop()!.replace(/\.[^.]+$/, "").replace(/[^\w-]/g, "_");
    return `\n\n![${caption}](figure:${name})\n\n`;
  };
  tex = tex.replace(/\\begin\{figure\*?\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{figure\*?\}/g, (_, body: string) => {
    const file = /\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/.exec(body)?.[1];
    const captionStart = /\\caption\s*(?:\[[^\]]*\])?\s*(?=\{)/.exec(body);
    const caption = captionStart ? (braced(body, captionStart.index + captionStart[0].length)?.body.trim() ?? "") : "";
    if (!file) return caption ? `\n\n*[Figure: ${caption}]*\n\n` : "";
    return figureLink(file, caption.replace(/\\label\{[^}]*\}/g, "").trim());
  });
  tex = tex.replace(/\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g, (_, file: string) => figureLink(file, ""));

  // Display math, keeping \label until the equations are numbered.
  tex = tex.replace(/\\begin\{(equation|align|gather|multline|eqnarray)(\*?)\}([\s\S]*?)\\end\{\1\2\}/g, (_, env: string, star: string, body: string) => {
    const inner = body.trim();
    if (env === "equation") return `\n$$\n${inner}${star ? " \\notag" : ""}\n$$\n`;
    if (env === "multline") return `\n$$\n${inner.replace(/\\\\/g, "")}${star ? " \\notag" : ""}\n$$\n`;
    const name = env === "eqnarray" ? "align" : env;
    return `\n$$\n\\begin{${name}${star}}\n${inner}\n\\end{${name}${star}}\n$$\n`;
  });
  tex = tex.replace(/\\\[([\s\S]*?)\\\]/g, (_, body: string) => `\n$$\n${body.trim()} \\notag\n$$\n`);
  tex = tex.replace(/\$\$([\s\S]*?)\$\$/g, (whole, body: string) => (body.startsWith("\n") ? whole : `\n$$\n${body.trim()}\n$$\n`));
  tex = numberLabels(tex, labels);

  // Statements and proofs, numbered by their shared counters.
  const counters: Record<string, number> = {};
  tex = tex.replace(/\\begin\{(\w+)(\*?)\}(?:\s*\[([^\]]*)\])?([\s\S]*?)\\end\{\1\2\}/g, (whole, env: string, star: string, note: string | undefined, body: string) => {
    if (env === "proof") return `\n\n*Proof${note ? ` (${note})` : ""}.* ${body.trim()}\n\n`;
    const name = names[env];
    if (!name) return whole;
    let label = name;
    let text = body;
    if (!star && !unnumbered.has(env)) {
      const counter = counterFor(env);
      counters[counter] = (counters[counter] ?? 0) + 1;
      label += ` ${counters[counter]}`;
      text = takeLabel(body, String(counters[counter]));
    }
    text = text.replace(/^\s*\\label\{[^}]+\}/, "").trim();
    const italic = /^(Theorem|Lemma|Proposition|Corollary|Conjecture|Claim|Fact|Hypothesis)$/.test(name);
    return `\n\n**${label}.**${note ? ` (${note})` : ""} ${italic ? italicize(text) : text}\n\n`;
  });

  tex = replaceCommand(tex, "eqref", (label) => `(${labels.get(label) ?? "?"})`);
  tex = replaceCommand(tex, "(?:ref|cref|Cref|autoref)", (label) => labels.get(label) ?? "?");
  tex = replaceCommand(tex, "label", () => "");
  tex = replaceCommand(tex, "(?:cite|citep|citet)", (keys, note) => `[${keys.split(",").map((k) => k.trim()).join(", ")}${note ? `, ${note}` : ""}]`);
  tex = replaceCommand(tex, "footnote", (text) => ` (${text.trim()})`);
  tex = replaceCommand(tex, "(?:emph|textit|textsl)", (text) => `*${text}*`);
  tex = replaceCommand(tex, "textbf", (text) => `**${text}**`);
  tex = replaceCommand(tex, "texttt", (text) => `\`${text}\``);
  tex = replaceCommand(tex, "url", (text) => `<${text}>`);
  tex = replaceCommand2(tex, "href", (url, text) => `[${text}](${url})`);

  // Lists and references.
  tex = tex.replace(/\\begin\{(itemize|enumerate|description)\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{\1\}/g, (_, kind: string, body: string) => {
    const items = body.split(/\\item\b/).slice(1);
    const line = (item: string, i: number) => {
      const named = /^\s*\[([^\]]*)\]\s*/.exec(item);
      const text = item.slice(named ? named[0].length : 0).trim().replace(/\n\s*/g, " ");
      if (kind === "enumerate") return `${i + 1}. ${text}`;
      return `- ${named ? `**${named[1]}** ` : ""}${text}`;
    };
    return `\n\n${items.map(line).join("\n")}\n\n`;
  });
  tex = tex.replace(/\\begin\{thebibliography\}\{[^}]*\}([\s\S]*?)\\end\{thebibliography\}/, (_, body: string) => {
    const items = body
      .split(/\\bibitem\b/)
      .slice(1)
      .map((item) => item.replace(/^\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/, "[$1] ").trim().replace(/\s+/g, " "));
    return `\n\n## References\n\n${items.map((i) => `- ${i}`).join("\n")}\n\n`;
  });
  tex = tex.replace(/\\(?:begin|end)\{(?:center|flushleft|flushright|quote|quotation)\}/g, "");

  // Typography outside math.
  tex = tex
    .replace(/(^|[^\\])~/g, "$1 ")
    .replace(/``|''/g, '"')
    .replace(/\\&/g, "&")
    .replace(/\\%/g, "%")
    .replace(/\\#/g, "#")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");

  const clean = (text: string | null) =>
    text
      ? replaceCommand(text.replace(/\\\\/g, " "), "(?:emph|textit)", (t) => `*${t}*`)
          .replace(/\s+/g, " ")
          .trim()
      : null;
  return { title: clean(titleText), lede: clean(abstract), markdown: tex.trim() };
}

/** Italicizes the prose of a statement, leaving its display equations and lists upright. */
function italicize(text: string): string {
  return text
    .split(/(\n?\$\$\n[\s\S]*?\n\$\$\n?)/)
    .flatMap((part) => (part.includes("$$\n") ? [part.trim()] : part.split(/\n\s*\n/)))
    .map((para) => {
      const trimmed = para.trim();
      if (!trimmed || trimmed.startsWith("$$") || /^([-*+] |\d+\. )/.test(trimmed)) return trimmed;
      return `*${trimmed.replace(/\s*\n\s*/g, " ")}*`;
    })
    .filter(Boolean)
    .join("\n\n");
}

export function latexToBlocks(source: string): Converted {
  const { title, lede, markdown } = latexToMarkdown(source);
  const converted = markdownToBlocks(markdown);
  return { title: title ?? converted.title, lede, blocks: converted.blocks };
}

// ---------------------------------------------------------------------------
// Notebooks, tables and code

interface NotebookCell {
  cell_type: string;
  source: string | string[];
}

/** A Jupyter notebook: Markdown cells as they are, code cells as fenced code. */
export function notebookToBlocks(json: string): Converted {
  const notebook = JSON.parse(json) as { cells?: NotebookCell[]; metadata?: { language_info?: { name?: string } } };
  const language = notebook.metadata?.language_info?.name ?? "python";
  const parts = (notebook.cells ?? []).map((cell) => {
    const text = Array.isArray(cell.source) ? cell.source.join("") : cell.source;
    if (cell.cell_type === "code") return text.trim() ? `\`\`\`${language}\n${text.trim()}\n\`\`\`` : "";
    return text;
  });
  return markdownToBlocks(parts.filter(Boolean).join("\n\n"));
}

/** Comma- or tab-separated values as a Markdown table (the first 200 rows). */
export function tableToMarkdown(text: string, separator: "," | "\t"): string {
  const rows: string[][] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') {
          cell += '"';
          i++;
        } else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === separator) {
        cells.push(cell);
        cell = "";
      } else cell += c;
    }
    cells.push(cell);
    rows.push(cells.map((c) => c.trim().replace(/\|/g, "\\|")));
    if (rows.length > 200) break;
  }
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
  const [head, ...body] = rows.map(pad);
  return [`| ${head.join(" | ")} |`, `|${" --- |".repeat(width)}`, ...body.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

const LANGUAGES: Record<string, string> = {
  py: "python",
  sage: "python",
  jl: "julia",
  m: "matlab",
  r: "r",
  lean: "lean",
  hs: "haskell",
  rs: "rust",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  java: "java",
  js: "javascript",
  ts: "typescript",
  json: "json",
  mpl: "maple",
  mw: "maple",
  nb: "mathematica",
  wl: "mathematica",
  gp: "gp",
  mac: "maxima",
  v: "coq",
  thy: "isabelle",
  agda: "agda",
  sh: "bash",
  bib: "bibtex",
};

export function codeLanguage(extension: string): string | null {
  return LANGUAGES[extension.toLowerCase()] ?? null;
}

export function codeToBlocks(code: string, language: string, name: string): Converted {
  return { title: name, lede: null, blocks: [{ source: `\`\`\`${language}\n${code.trimEnd()}\n\`\`\`` }] };
}
