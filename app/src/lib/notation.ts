// A document's notation: its macros and its references, read once and shared by rendering,
// the references list, the collaborator's prompts and the export.

import { citationNumbers, formatEntry, parseBibtex, type Bibliography } from "./bibtex";
import { citedKeys } from "./citations";
import { macroSource, readMacros, type Macros } from "./macros";
import type { Doc } from "./types";

/** A cited reference as the references list shows it. */
export interface CitedReference {
  number: number;
  key: string;
  /** amsplain's setting of it, in Markdown. */
  text: string;
}

export function readNotation(doc: Pick<Doc, "macros" | "bibliography">): { macros: Macros; bibliography: Bibliography } {
  return { macros: readMacros(doc.macros), bibliography: parseBibtex(doc.bibliography ?? "") };
}

/** The keys a document cites, as one string, so it only changes when the citations do. */
export function citationSignature(doc: Pick<Doc, "blocks">): string {
  return [...citedKeys(doc.blocks.filter((b) => !b.suggestion).map((b) => b.source))].sort().join(",");
}

/** The references the document cites, numbered as the exported paper will number them. */
export function citedReferences(bibliography: Bibliography, signature: string): CitedReference[] {
  const numbers = citationNumbers(bibliography.entries, new Set(signature ? signature.split(",") : []));
  return bibliography.entries
    .filter((e) => numbers.has(e.key))
    .map((e) => ({ number: numbers.get(e.key)!, key: e.key, text: formatEntry(e) }))
    .sort((a, b) => a.number - b.number);
}

/** What the collaborator is told about the notation, after the document. */
export function notationForPrompt(doc: Pick<Doc, "macros" | "bibliography">): string {
  const { macros, bibliography } = readNotation(doc);
  const parts: string[] = [];
  const source = macroSource(macros);
  if (source) parts.push(`The document's macros, which Theoremis renders; use them in math:\n${source}`);
  if (bibliography.entries.length) {
    const list = bibliography.entries.map((e) => `- ${e.key}: ${formatEntry(e).replace(/\*+/g, "")}`).join("\n");
    parts.push(`The document's references, cited with \\cite{key} or \\cite[Theorem 2]{key}; cite only these:\n${list}`);
  }
  return parts.length ? `\n\n${parts.join("\n\n")}` : "";
}
