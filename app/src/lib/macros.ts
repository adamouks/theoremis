// A document's macros: the \newcommand, \DeclareMathOperator and \def lines of a paper's
// preamble. Theoremis reads the definitions out of whatever is pasted (a whole preamble is fine)
// and gives them to KaTeX, so the document renders as the paper would; the LaTeX export writes
// the same definitions into its preamble.

import katex, { type KatexOptions } from "katex";

type KatexMacros = NonNullable<KatexOptions["macros"]>;

export interface MacroDefinition {
  /** "\R", "\norm". */
  name: string;
  /** The definition as LaTeX, for the export. */
  source: string;
}

export interface Macros {
  definitions: MacroDefinition[];
  /** For KaTeX's `macros` option. Copy it before use: KaTeX writes global definitions into it. */
  katex: KatexMacros;
  /** Definitions KaTeX couldn't take, and why. */
  problems: string[];
  /** Other preamble lines, which only the LaTeX export would have used. */
  ignored: string[];
}

const EMPTY: Macros = { definitions: [], katex: {}, problems: [], ignored: [] };

/** Reads at `at` a group in braces, returning its inside and where it ends. */
function group(text: string, at: number): { inside: string; end: number } | null {
  if (text[at] !== "{") return null;
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return { inside: text.slice(at + 1, i), end: i + 1 };
  }
  return null;
}

function skipSpace(text: string, at: number): number {
  while (at < text.length && /\s/.test(text[at])) at++;
  return at;
}

/** A command's name, written `{\name}` or `\name`. */
function nameAt(text: string, at: number): { name: string; end: number } | null {
  at = skipSpace(text, at);
  const braced = group(text, at);
  if (braced) {
    const name = braced.inside.trim();
    return /^\\(?:[A-Za-z@]+|.)$/.test(name) ? { name, end: braced.end } : null;
  }
  const bare = /^\\(?:[A-Za-z@]+|.)/.exec(text.slice(at));
  return bare ? { name: bare[0], end: at + bare[0].length } : null;
}

/** `[2]` or `[x]` at `at`, after spaces. */
function optional(text: string, at: number): { inside: string; end: number } | null {
  at = skipSpace(text, at);
  if (text[at] !== "[") return null;
  const close = text.indexOf("]", at);
  return close < 0 ? null : { inside: text.slice(at + 1, close), end: close + 1 };
}

const DEFINERS = /\\(newcommand|renewcommand|providecommand|DeclareMathOperator|def|gdef)(\*?)/g;

interface Parsed {
  kind: string;
  star: boolean;
  name: string;
  args: number;
  /** An optional first argument's default, which KaTeX doesn't support. */
  fallback?: string;
  params?: string;
  body: string;
  source: string;
}

function parseDefinitions(text: string): { parsed: Parsed[]; spans: [number, number][] } {
  const parsed: Parsed[] = [];
  const spans: [number, number][] = [];
  for (const match of text.matchAll(DEFINERS)) {
    const start = match.index;
    if (spans.some(([a, b]) => start >= a && start < b)) continue;
    const [, kind, star] = match;
    const named = nameAt(text, start + match[0].length);
    if (!named) continue;
    let at = named.end;
    let args = 0;
    let fallback: string | undefined;
    let params: string | undefined;
    if (kind === "def" || kind === "gdef") {
      const brace = text.indexOf("{", at);
      if (brace < 0) continue;
      params = text.slice(at, brace).trim();
      if (!/^(#\d)*$/.test(params.replace(/\s/g, ""))) continue;
      args = (params.match(/#\d/g) ?? []).length;
      at = brace;
    } else if (kind !== "DeclareMathOperator") {
      const count = optional(text, at);
      if (count && /^\s*\d\s*$/.test(count.inside)) {
        args = Number(count.inside);
        at = count.end;
        const first = optional(text, at);
        if (first) {
          fallback = first.inside;
          at = first.end;
        }
      }
    }
    const body = group(text, skipSpace(text, at));
    if (!body) continue;
    const source = text.slice(start, body.end);
    parsed.push({ kind, star: star === "*", name: named.name, args, fallback, params, body: body.inside, source });
    spans.push([start, body.end]);
  }
  return { parsed, spans };
}

/** Reads the macro definitions in `text`. */
export function readMacros(text: string | undefined): Macros {
  if (!text?.trim()) return EMPTY;
  // Comments go first, so a commented-out definition stays out.
  const clean = text.replace(/(^|[^\\])%.*$/gm, "$1");
  const { parsed, spans } = parseDefinitions(clean);
  const macros: KatexMacros = {};
  const definitions: MacroDefinition[] = [];
  const problems: string[] = [];

  for (const d of parsed) {
    definitions.push({ name: d.name, source: d.source });
    if (d.fallback !== undefined) {
      problems.push(`${d.name}: an optional argument with a default isn't supported here, so it renders only in the LaTeX export.`);
      continue;
    }
    const attempts =
      d.kind === "DeclareMathOperator"
        ? [`\\newcommand{${d.name}}{\\operatorname${d.star ? "*" : ""}{${d.body}}}`, `\\renewcommand{${d.name}}{\\operatorname${d.star ? "*" : ""}{${d.body}}}`]
        : d.kind === "def" || d.kind === "gdef"
          ? [`\\gdef${d.name}${d.params ?? ""}{${d.body}}`]
          : [
              `\\newcommand{${d.name}}${d.args ? `[${d.args}]` : ""}{${d.body}}`,
              // LaTeX lacks commands KaTeX has (\R, \N…), so defining one there is fine: here it's a redefinition.
              ...(d.kind === "providecommand" ? [] : [`\\renewcommand{${d.name}}${d.args ? `[${d.args}]` : ""}{${d.body}}`]),
            ];
    let error = "";
    for (const attempt of attempts) {
      const trial = { ...macros };
      try {
        katex.renderToString(attempt, { macros: trial, globalGroup: true, throwOnError: true });
        Object.assign(macros, trial);
        error = "";
        break;
      } catch (err) {
        error = err instanceof Error ? err.message.replace(/^KaTeX parse error: /, "") : String(err);
        // \providecommand of something KaTeX knows keeps KaTeX's, as LaTeX would keep its own.
        if (d.kind === "providecommand" && /redefine/.test(error)) {
          error = "";
          break;
        }
      }
    }
    if (error) problems.push(`${d.name}: ${error}`);
  }

  // Whatever else was pasted: \usepackage, \newtheorem…
  let rest = clean;
  for (const [a, b] of [...spans].reverse()) rest = rest.slice(0, a) + rest.slice(b);
  const ignored = rest
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^\\(?:makeatletter|makeatother)$/.test(line));

  return { definitions, katex: macros, problems, ignored };
}

/** The definitions as LaTeX, one to a line, for a preamble or a prompt. */
export function macroSource(macros: Macros): string {
  return macros.definitions.map((d) => d.source.replace(/\s*\n\s*/g, " ")).join("\n");
}
