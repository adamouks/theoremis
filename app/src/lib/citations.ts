// Citations in a document: \cite{key}, \cite{a,b} and \cite[Thm. 2]{key}, written as in LaTeX.
// For showing, each becomes a link Theoremis draws as "[3, Thm. 2]", numbered from the
// document's references (lib/bibtex.ts); the LaTeX export passes them through unchanged.

import { outsideCode } from "./text";

const CITE = /\\cite[pt]?\*?(?:\[([^\]\n]*)\])?\{([^}\n]+)\}/g;

const keysOf = (list: string) =>
  list
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

/** The keys cited anywhere in `texts`, outside code. */
export function citedKeys(texts: string[]): Set<string> {
  const keys = new Set<string>();
  for (const text of texts) outsideCode(text, (segment) => {
    for (const match of segment.matchAll(CITE)) for (const key of keysOf(match[2])) keys.add(key);
    return segment;
  });
  return keys;
}

/** Rewrites each citation as a `cite:` link labelled with its numbers, "?" for an unknown key. */
export function linkCitations(markdown: string, number: (key: string) => number | undefined): string {
  if (!markdown.includes("\\cite")) return markdown;
  return outsideCode(markdown, (segment) =>
    segment.replace(CITE, (_, note: string | undefined, list: string) => {
      const keys = keysOf(list);
      const label = `${keys.map((k) => number(k) ?? "?").join(", ")}${note?.trim() ? `, ${note.trim()}` : ""}`;
      return `[\\[${label.replace(/([[\]])/g, "\\$1")}\\]](cite:${keys.map(encodeURIComponent).join(",")})`;
    }),
  );
}

/** The keys a `cite:` link stands for. */
export function citationLinkKeys(href: string): string[] | null {
  return href.startsWith("cite:") ? href.slice(5).split(",").map(decodeURIComponent) : null;
}
