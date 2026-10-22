const CODE_SPANS = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g;

/** Applies `fn` to the parts of `markdown` outside code spans and fences. */
function outsideCode(markdown: string, fn: (text: string) => string): string {
  return markdown
    .split(CODE_SPANS)
    .map((segment, index) => (index % 2 === 1 ? segment : fn(segment)))
    .join("");
}

/**
 * Rewrites the math delimiters models commonly emit into forms remark-math understands:
 * `\[…\]` and a line holding only `$$…$$` become display blocks (remark-math treats a
 * one-line `$$…$$` as inline), and `\(…\)` becomes `$…$`. Code spans and fences are left
 * alone, including a fence that is still open mid-stream.
 */
export function normalizeMath(markdown: string): string {
  return outsideCode(markdown, (segment) =>
    segment
      .replace(/\\\[([\s\S]*?)\\\]/g, (_, body: string) => `\n$$\n${body.trim()}\n$$\n`)
      .replace(/^[ \t]*\$\$([^\n]+?)\$\$[ \t]*$/gm, (_, body: string) => `$$\n${body.trim()}\n$$`)
      .replace(/\\\(([\s\S]*?)\\\)/g, (_, body: string) => `$${body.trim()}$`),
  );
}

/** Stops KaTeX auto-numbering environments, for math shown outside the document. */
export function unnumberEnvironments(markdown: string): string {
  return markdown.replace(/\\(begin|end)\{(align|gather|equation|multline)\}/g, "\\$1{$2*}");
}

const DISPLAY_MATH = /(^|\n)\$\$\n([\s\S]*?)\n\$\$(?=\n|$)/g;
const NUMBERED_ENV = /^\\begin\{(align|gather)\}([\s\S]*)\\end\{\1\}$/;
const NO_NUMBER = /\\(?:notag|nonumber)\b/;
const NO_NUMBER_ALL = /\\(?:notag|nonumber)\b/g;

/**
 * Numbers the display equations in `markdown` from `start`, the way a paper would.
 *
 * A single equation gets `\tag{n}`; each row of an `align` or `gather` gets its own number.
 * Rows or equations marked `\notag`/`\nonumber`, starred environments and equations that
 * already carry a `\tag` are left unnumbered. Returns the rewritten text and the numbers used.
 */
export function numberEquations(markdown: string, start: number): { text: string; numbers: number[] } {
  const numbers: number[] = [];
  let next = start;
  const take = () => {
    numbers.push(next);
    return next++;
  };

  const text = outsideCode(normalizeMath(markdown), (segment) =>
    segment.replace(DISPLAY_MATH, (_, lead: string, raw: string) => {
      const body = raw.trim();
      if (/\\tag\b/.test(body)) return `${lead}$$\n${body}\n$$`;

      const env = NUMBERED_ENV.exec(body);
      if (env && !/\\begin\{/.test(env[2])) {
        const rows = env[2].split(/\\\\/).map((row) => {
          if (!row.trim()) return row;
          if (NO_NUMBER.test(row)) return row.replace(NO_NUMBER_ALL, "");
          return `${row.trimEnd()} \\tag{${take()}}`;
        });
        return `${lead}$$\n\\begin{${env[1]}*}${rows.join("\\\\")}\\end{${env[1]}*}\n$$`;
      }
      if (/\\begin\{(?:align|gather|equation)\*?\}/.test(body)) {
        return `${lead}$$\n${body.replace(/\\begin\{equation\}|\\end\{equation\}/g, "")}\n$$`;
      }
      if (NO_NUMBER.test(body)) return `${lead}$$\n${body.replace(NO_NUMBER_ALL, "")}\n$$`;
      return `${lead}$$\n${body} \\tag{${take()}}\n$$`;
    }),
  );
  return { text, numbers };
}

/** The bold or italic label a block opens with, e.g. "Conjecture 1" or "Proof". */
export function leadingLabel(source: string): string | null {
  const heading = /^\s*#{1,6}\s+(.+)$/m.exec(source);
  if (heading && source.trimStart().startsWith("#")) return heading[1].trim();
  const match = /^\s*(\*\*|\*|_)([^*_\n]{1,48}?)\1/.exec(source);
  return match ? match[2].trim().replace(/[.:]$/, "") : null;
}

/** Formats equation numbers as a range: "(2)" or "(2)–(3)". */
export function equationRange(numbers: number[]): string {
  if (numbers.length === 0) return "";
  const first = numbers[0];
  const last = numbers[numbers.length - 1];
  return first === last ? `(${first})` : `(${first})–(${last})`;
}

/** A short title from the first line of some text. */
export function deriveTitle(text: string, max = 60): string {
  const firstLine =
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const plain = firstLine
    .replace(/[#>*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return "";
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/** "just now", "4 min ago", "3 h ago", "2 days ago", then a date. */
export function timeAgo(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? "yesterday" : `${days} days ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function clockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Up to two initials for an avatar. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  const letters = parts.length === 1 ? [parts[0][0]] : [parts[0][0], parts[parts.length - 1][0]];
  return letters.join("").toUpperCase();
}

export function newId(): string {
  return crypto.randomUUID();
}
