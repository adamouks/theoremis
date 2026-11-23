// Putting a transcription into a document as it streams in: each part's blocks replace the
// previous reading of that part, so a reply can be re-read on every delta.

import { leadingLabel, newId } from "./text";
import { joinContinuation, type Transcript } from "./transcript";
import type { Block, Doc } from "./types";

export interface PartState {
  /** Ids of the blocks this part has written, in order. */
  ids: string[];
  /** The block before this part and its text before the part touched it, in case the part continues it. */
  carry: { id: string; base: string } | null;
  /** Where the part's blocks go: after this block, or at the end of the document. */
  afterId: string | null;
  /** An empty block the import may replace (a new document's first paragraph). */
  placeholderId: string | null;
  /** Whether to fill in the title and lede, and to record source pages on blocks. */
  header: boolean;
  pages: boolean;
  /** The title and lede this part last wrote, so a longer reading can replace them but the person's edits stay. */
  wrote: { title: string | null; lede: string | null };
}

/**
 * The state for the next part. A part may continue the block before it when it follows an
 * earlier part, or resumes an unfinished import; new material added to a document starts fresh.
 */
export function startPart(
  doc: Doc,
  previous: PartState | null,
  { header, pages, resuming = false }: { header: boolean; pages: boolean; resuming?: boolean },
): PartState {
  const lastId = previous?.ids[previous.ids.length - 1] ?? previous?.carry?.id ?? doc.blocks[doc.blocks.length - 1]?.id ?? null;
  const last = doc.blocks.find((b) => b.id === lastId);
  const placeholder = !previous && doc.blocks.length === 1 && !doc.blocks[0].source.trim() ? doc.blocks[0].id : null;
  const canContinue = !!previous || resuming;
  return {
    ids: [],
    carry: last && !placeholder && canContinue ? { id: last.id, base: last.source } : null,
    afterId: placeholder ? null : (last?.id ?? null),
    placeholderId: placeholder,
    header,
    pages,
    wrote: { title: null, lede: null },
  };
}

/**
 * The document with `transcript` as this part's blocks. `resolve` turns the transcript's
 * figure links into the document's media.
 */
export function applyPart(doc: Doc, part: PartState, transcript: Transcript, resolve: (source: string) => string): Doc {
  let blocks = doc.blocks.filter((b) => !part.ids.includes(b.id) && b.id !== part.placeholderId);
  let items = transcript.blocks;
  if (part.carry) {
    const { id, base } = part.carry;
    const continued = items[0]?.continues ? joinContinuation(base, resolve(items[0].source)) : base;
    if (items[0]?.continues) items = items.slice(1);
    blocks = blocks.map((b) => (b.id === id ? { ...b, source: continued } : b));
  }
  while (part.ids.length < items.length) part.ids.push(newId());
  const fresh: Block[] = items.map((item, i) => ({
    id: part.ids[i],
    source: resolve(item.source),
    ...(item.status ? { status: item.status } : {}),
    ...(item.status && item.note ? { note: item.note } : {}),
    ...(part.pages && item.page ? { page: item.page } : {}),
  }));
  const anchor = part.afterId ? blocks.findIndex((b) => b.id === part.afterId) : -1;
  const at = anchor >= 0 ? anchor + 1 : blocks.length;
  blocks = [...blocks.slice(0, at), ...fresh, ...blocks.slice(at)];
  if (!blocks.length) blocks = [{ id: part.placeholderId ?? newId(), source: "" }];

  let next: Doc = { ...doc, blocks };
  if (part.header) {
    const ours = (current: string, wrote: string | null) => !current.trim() || current === wrote;
    if (transcript.title && ours(doc.title, part.wrote.title)) {
      next = { ...next, title: transcript.title };
      part.wrote.title = transcript.title;
    }
    if (transcript.lede && ours(doc.lede, part.wrote.lede)) {
      next = { ...next, lede: transcript.lede };
      part.wrote.lede = transcript.lede;
    }
  }
  return next;
}

/** The labels of statements so far ("Theorem 1", "Lemma 2.3"), so later parts keep numbering. */
export function statementLabels(doc: Doc, limit = 40): string[] {
  const labels: string[] = [];
  for (const block of doc.blocks) {
    const label = leadingLabel(block.source);
    if (label && /\d/.test(label) && !labels.includes(label)) labels.push(label);
  }
  return labels.slice(-limit);
}

/** The end of the document's text, for the next part to continue from. */
export function documentTail(doc: Doc, chars = 1500): string {
  const text = doc.blocks.map((b) => b.source.trim()).filter(Boolean).join("\n\n");
  return text.length > chars ? `…${text.slice(-chars)}` : text;
}
