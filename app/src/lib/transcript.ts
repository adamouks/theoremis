// The format models transcribe into, and turning it into document blocks.
//
// A transcript is a run of sections, each opened by a line starting with "@@":
//
//   @@ title
//   On sums of odd integers
//   @@ lede
//   We characterize …
//   @@ block page=2 status=draft note="proof in source"
//   **Theorem 1.** *For every $n\ge 1$, …*
//   @@ block page=3 continues
//   …the rest of a paragraph cut off at the end of the previous part.
//
// Line-based rather than JSON, so LaTeX's backslashes need no escaping and a reply can be
// read while it is still streaming.

import type { Status } from "./types";

export interface TranscribedBlock {
  source: string;
  page?: number;
  status?: Status;
  note?: string;
  /** Continues the last block of the previous part rather than starting a new one. */
  continues: boolean;
}

export interface Transcript {
  title: string | null;
  lede: string | null;
  blocks: TranscribedBlock[];
}

/** Statuses a transcription may give; it never claims a statement was checked. */
const TRANSCRIBED_STATUSES = new Set<Status>(["open", "tested", "draft"]);

const HEADER = /^@@[ \t]*(title|lede|abstract|block)\b(.*)$/i;
const ATTRIBUTE = /([a-z]+)(?:=("(?:[^"\\]|\\.)*"|\S+))?/gi;

function parseAttributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of text.matchAll(ATTRIBUTE)) {
    const value = match[2] ?? "true";
    attrs[match[1].toLowerCase()] = value.startsWith('"') ? value.slice(1, -1).replace(/\\(.)/g, "$1") : value;
  }
  return attrs;
}

function blockFrom(attrs: Record<string, string>, body: string): TranscribedBlock {
  const page = Number.parseInt(attrs.page ?? "", 10);
  const written = attrs.status?.toLowerCase();
  // Anything stronger than "draft" would claim a check that never happened.
  const status: Status | undefined = !written
    ? undefined
    : TRANSCRIBED_STATUSES.has(written as Status)
      ? (written as Status)
      : /conjecture|question|unproved|unknown/.test(written)
        ? "open"
        : "draft";
  const note = attrs.note?.trim();
  return {
    source: body,
    ...(Number.isFinite(page) && page > 0 ? { page } : {}),
    ...(status ? { status } : {}),
    ...(status && note ? { note } : {}),
    continues: "continues" in attrs || "continued" in attrs,
  };
}

/** Removes a fence the whole reply was wrapped in, even one still open mid-stream. */
function unwrap(text: string): string {
  const trimmed = text.replace(/^\s*```[\w-]*[ \t]*\n/, "");
  return trimmed === text ? text : trimmed.replace(/\n```\s*$/, "");
}

/**
 * Reads a transcript. While a reply streams, the last block may be cut off mid-way; it is
 * returned as it stands. Text before the first "@@" line is kept as a block of its own.
 */
export function parseTranscript(reply: string): Transcript {
  const lines = unwrap(reply.replace(/\r\n?/g, "\n")).split("\n");
  const out: Transcript = { title: null, lede: null, blocks: [] };
  let kind: "title" | "lede" | "block" | null = null;
  let attrs: Record<string, string> = {};
  let body: string[] = [];

  const close = () => {
    const text = body.join("\n").trim();
    if (kind === "title") out.title = text.replace(/^#+\s*/, "").replace(/\s+/g, " ") || out.title;
    else if (kind === "lede") out.lede = text || out.lede;
    else if (text) out.blocks.push(blockFrom(kind === "block" ? attrs : {}, text));
    body = [];
  };

  for (const line of lines) {
    const header = HEADER.exec(line.trim());
    if (header && line.trimStart().startsWith("@@")) {
      close();
      const name = header[1].toLowerCase();
      kind = name === "abstract" ? "lede" : (name as "title" | "lede" | "block");
      attrs = parseAttributes(header[2]);
    } else {
      body.push(line);
    }
  }
  close();
  return out;
}

/** How a continuation joins the block it continues: mid-sentence with a space, else a new paragraph. */
export function joinContinuation(previous: string, continuation: string): string {
  const before = previous.trimEnd();
  const after = continuation.trimStart();
  if (!before) return after;
  if (!after) return before;
  const midSentence = !/(?:[.:;!?]|\$\$)$/.test(before) && !/^(#|\$\$|```|[-*+] |\d+\. |\||\*\*|!\[)/.test(after);
  return midSentence ? `${before} ${after}` : `${before}\n\n${after}`;
}

/** A figure a transcript can point at: `figure:F2` names one of these. */
export interface FigureRef {
  id: string;
  /** The media file it was saved as. */
  asset: string;
}

/** A region of a page the model asked to be cropped, as fractions of the page. */
export interface CropRequest {
  page: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** `![alt](figure:F2)` or `![alt](crop:…)`; the alt may hold brackets, as in `$[0, 2\pi]$`. */
const IMAGE_LINK = /!\[((?:[^[\]]|\[[^[\]]*\])*)\]\(\s*(figure:[\w-]+|crop:[^)\s]+)\s*\)/g;

export function parseCrop(target: string): CropRequest | null {
  const match = /^crop:(\d+):([\d.]+),([\d.]+),([\d.]+),([\d.]+)$/.exec(target);
  if (!match) return null;
  const [page, a, b, c, d] = match.slice(1).map(Number);
  const clamp = (v: number) => Math.min(1, Math.max(0, v > 1 && v <= 100 ? v / 100 : v));
  const [left, right] = [clamp(a), clamp(c)].sort((x, y) => x - y);
  const [top, bottom] = [clamp(b), clamp(d)].sort((x, y) => x - y);
  if (right - left < 0.02 || bottom - top < 0.02) return null;
  return { page, left, top, right, bottom };
}

/** The `crop:` regions a block asks for. */
export function cropRequests(source: string): string[] {
  return [...source.matchAll(IMAGE_LINK)].map((m) => m[2]).filter((t) => t.startsWith("crop:"));
}

/**
 * Points a block's figure links at the document's media. Figures that can't be resolved (yet)
 * become an italic caption, so the reader still sees what was there.
 */
export function resolveFigures(
  source: string,
  figures: Map<string, string>,
  crops: Map<string, string> = new Map(),
): string {
  return source.replace(IMAGE_LINK, (_, alt: string, target: string) => {
    const asset = target.startsWith("figure:") ? figures.get(target.slice("figure:".length)) : crops.get(target);
    if (asset) return `![${alt}](asset:${asset})`;
    return alt.trim() ? `*[Figure: ${alt.trim()}]*` : "";
  });
}

/** Which `figure:` ids a transcript used, so unused crops can be dropped. */
export function usedFigureIds(sources: string[]): Set<string> {
  const used = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(IMAGE_LINK)) {
      if (match[2].startsWith("figure:")) used.add(match[2].slice("figure:".length));
    }
  }
  return used;
}
