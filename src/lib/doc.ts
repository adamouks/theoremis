import { deriveTitle, equationRange, leadingLabel, newId, numberEquations } from "./text";
import type { Block, Context, Doc, Status } from "./types";

export const STATUSES: Status[] = ["open", "tested", "draft", "adopted", "proved", "verified"];

export const STATUS_INFO: Record<Status, { label: string; meaning: string; note: string }> = {
  open: { label: "OPEN", meaning: "Stated, not yet proved", note: "" },
  tested: { label: "TESTED", meaning: "Numerical evidence, not a proof", note: "evidence, not proof" },
  draft: { label: "DRAFT", meaning: "Proof in progress", note: "not formalized" },
  adopted: { label: "ADOPTED", meaning: "Accepted from the collaborator", note: "not formalized" },
  proved: { label: "PROVED", meaning: "Checked by hand", note: "checked by hand" },
  verified: { label: "VERIFIED", meaning: "Checked in Lean", note: "checked in Lean" },
};

const RANK: Record<Status, number> = { open: 0, tested: 1, draft: 2, adopted: 2, proved: 3, verified: 4 };

export function createDocument(projectId: string, title = ""): Doc {
  const now = Date.now();
  return {
    id: newId(),
    projectId,
    title,
    lede: "",
    blocks: [{ id: newId(), source: "" }],
    threads: [],
    revision: 0,
    createdAt: now,
    updatedAt: now,
    status: "open",
    pending: 0,
  };
}

/** The furthest any statement in the document has got, shown next to it in the sidebar. */
export function docStatus(doc: Pick<Doc, "blocks">): Status {
  let best: Status = "open";
  for (const block of doc.blocks) {
    if (block.status && !block.suggestion && RANK[block.status] > RANK[best]) best = block.status;
  }
  return best;
}

export function withSummary(doc: Doc): Doc {
  return {
    ...doc,
    status: docStatus(doc),
    pending: doc.blocks.filter((b) => b.suggestion).length,
  };
}

export interface NumberedBlock {
  block: Block;
  /** The source with equation numbers applied. */
  text: string;
  numbers: number[];
  /** How to refer to the block, e.g. "Proof · (2)–(3)". */
  label: string;
  /** 1-based position among pending suggestions, for the numbered pins. */
  suggestionIndex?: number;
}

/**
 * Numbers equations across the document and works out a label for every block.
 * Suggestions are numbered separately and don't consume equation numbers.
 */
export function numberBlocks(blocks: Block[]): NumberedBlock[] {
  let next = 1;
  let lastLabel: string | null = null;
  let suggestions = 0;
  return blocks.map((block) => {
    if (block.suggestion) {
      suggestions += 1;
      return {
        block,
        text: block.source,
        numbers: [],
        label: leadingLabel(block.source) ?? `Suggestion ${suggestions}`,
        suggestionIndex: suggestions,
      };
    }
    const { text, numbers } = numberEquations(block.source, next);
    next += numbers.length;
    const own = leadingLabel(block.source);
    const range = equationRange(numbers);
    let label: string;
    if (own) label = range ? `${own} · ${range}` : own;
    else if (range) label = lastLabel ? `${lastLabel} · ${range}` : `Equation ${range}`;
    else label = deriveTitle(block.source, 32) || "Empty paragraph";
    if (own) lastLabel = own;
    return { block, text, numbers, label };
  });
}

export function blockContext(numbered: NumberedBlock): Context {
  return { label: numbered.label, text: numbered.text, blockId: numbered.block.id };
}

/** The document as plain Markdown + LaTeX, with equation numbers and statuses. */
export function documentAsText(doc: Doc, { statuses = true } = {}): string {
  const parts = [`# ${doc.title || "Untitled"}`];
  if (doc.lede.trim()) parts.push(doc.lede.trim());
  for (const { block, text } of numberBlocks(doc.blocks)) {
    if (!text.trim()) continue;
    if (block.suggestion) continue;
    const status =
      statuses && block.status
        ? `[${STATUS_INFO[block.status].label}${block.note ? ` — ${block.note}` : ""}]\n`
        : "";
    parts.push(status + text.trim());
  }
  return parts.join("\n\n");
}

export interface Proposals {
  /** The reply without its proposal sections. */
  body: string;
  /** Replacement text for the passage the question was about. */
  revision: string | null;
  /** New material to add to the document, such as a remark or an alternative proof. */
  addition: string | null;
}

const PROPOSAL_HEADING =
  /^[ \t]*(?:#{1,6}[ \t]*|\*\*)?Proposed (revision|addition)[ \t]*:?(?:\*\*)?[ \t]*:?[ \t]*$/gim;
// A section ends at the next Markdown heading or proposal heading, not at bold text,
// which proposals themselves often start with ("**Lemma 3.**").
const SECTION_END =
  /^[ \t]*(?:#{1,6}[ \t]+\S|(?:\*\*)?Proposed (?:revision|addition)[ \t]*:?(?:\*\*)?[ \t]*:?[ \t]*$)/im;

function unfence(text: string): string {
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(text.trim());
  return (fenced ? fenced[1] : text).trim();
}

/**
 * Pulls the "Proposed revision" and "Proposed addition" sections out of a collaborator reply.
 * A section runs from its heading to the next heading or the end of the reply.
 */
export function splitProposals(reply: string): Proposals {
  const found: { kind: "revision" | "addition"; start: number; end: number; text: string }[] = [];
  for (const match of reply.matchAll(PROPOSAL_HEADING)) {
    const kind = match[1].toLowerCase() as "revision" | "addition";
    const start = match.index ?? 0;
    const contentStart = start + match[0].length;
    const rest = reply.slice(contentStart);
    const next = SECTION_END.exec(rest);
    const end = next ? contentStart + next.index : reply.length;
    found.push({ kind, start, end, text: unfence(reply.slice(contentStart, end)) });
  }
  let body = reply;
  for (const section of [...found].reverse()) body = body.slice(0, section.start) + body.slice(section.end);
  const pick = (kind: "revision" | "addition") => found.find((f) => f.kind === kind && f.text)?.text ?? null;
  return { body: body.trim(), revision: pick("revision"), addition: pick("addition") };
}

/** The replacement text a reply proposes for the selected passage, if any. */
export function extractRevision(reply: string): string | null {
  return splitProposals(reply).revision;
}
