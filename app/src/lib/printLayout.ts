// How a document is laid out on paper (components/PrintDocument.tsx): which blocks print, in
// what groups, and how long equations and short blocks are fitted to the page once the printed
// copy has been laid out at the paper's width.
//
// Blocks flow across pages like paragraphs of a paper, so nothing taller than a page has to be
// kept in one piece: a long proof or a Lean file simply continues on the next page. Only short
// things are kept together (a short block, a heading with a short block after it, a figure, an
// equation), so moving them to the next page never leaves much of a page empty.

import type { NumberedBlock } from "./doc";

/**
 * The height a page leaves for the document, in CSS pixels: US Letter less the margins
 * (styles.css sets 22 mm at the top and bottom), the shorter of Letter and A4.
 */
export const PAGE_HEIGHT = Math.floor(((279.4 - 44) / 25.4) * 96);

/** A block this short is kept on one page; moving it leaves at most this much of a page empty. */
export const KEEP_BLOCK = Math.round(PAGE_HEIGHT * 0.24);

/** A heading and the block after it are kept together when both fit in this much. */
export const KEEP_GROUP = Math.round(PAGE_HEIGHT * 0.36);

/** The blocks that print: everything written, in order, except pending suggestions. */
export function printedBlocks(numbered: NumberedBlock[]): NumberedBlock[] {
  return numbered.filter((n) => !n.block.suggestion && n.text.trim());
}

/** A block that is only a heading, like "## 3 Lean 4 formalization". */
export function isHeading(source: string): boolean {
  const lines = source.split("\n").filter((line) => line.trim());
  return lines.length > 0 && lines.every((line) => /^\s{0,3}#{1,6}\s+\S/.test(line));
}

export interface PrintGroup {
  key: string;
  blocks: NumberedBlock[];
}

/** The printed blocks, with each heading grouped with the block that follows it. */
export function printGroups(numbered: NumberedBlock[]): PrintGroup[] {
  const blocks = printedBlocks(numbered);
  const groups: PrintGroup[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const group = [blocks[i]];
    while (isHeading(group[group.length - 1].block.source) && i + 1 < blocks.length) group.push(blocks[++i]);
    groups.push({ key: group[0].block.id, blocks: group });
  }
  return groups;
}

export interface EquationPlan {
  /** What to scale the equation's type by, at most 1. */
  scale: number;
  /** Set the equation number on its own line, under the equation. */
  tagBelow: boolean;
  /** Let the equation break across lines at its relations and operators. */
  wrap: boolean;
}

/** Below this, shrinking an equation to fit makes it hard to read, so it is broken instead. */
export const READABLE_SCALE = 0.8;

/**
 * How to fit a displayed equation into `available` pixels: `width` is the equation's own width,
 * `tag` its number's (0 if none), `gap` the space wanted between them, and `widestPiece` the
 * widest part that can't be broken (KaTeX breaks only between top-level relations and operators).
 * The equation stays centred, so a number needs room on both sides.
 */
export function planEquation({ available, width, tag, gap, widestPiece }: { available: number; width: number; tag: number; gap: number; widestPiece: number }): EquationPlan {
  const fits = (w: number) => w <= available + 0.5;
  const whole = tag ? width + 2 * (tag + gap) : width;
  if (available <= 0 || width <= 0 || fits(whole)) return { scale: 1, tagBelow: false, wrap: false };
  const shrink = available / whole;
  if (shrink >= READABLE_SCALE) return { scale: shrink, tagBelow: false, wrap: false };
  const alone = Math.min(1, available / width);
  if (tag && alone >= READABLE_SCALE) return { scale: alone, tagBelow: true, wrap: false };
  if (widestPiece > 0 && widestPiece < width - 1) {
    // Broken into lines, each line is at most as wide as its widest piece.
    return { scale: Math.min(1, available / widestPiece), tagBelow: tag > 0, wrap: true };
  }
  // Nothing to break at: shrink it until it fits, whatever it takes, rather than cut it off.
  return { scale: alone, tagBelow: tag > 0, wrap: false };
}

/** Fits every displayed equation in `root` to its column (see planEquation). */
export function fitEquations(root: HTMLElement) {
  for (const display of root.querySelectorAll<HTMLElement>(".katex-display")) {
    display.style.removeProperty("--fit");
    display.classList.remove("is-tag-below", "is-wrapped");
    const html = display.querySelector<HTMLElement>(":scope > .katex > .katex-html");
    if (!html) continue;
    // KaTeX 0.19 names its parts katex-base and katex-tag; earlier versions, base and tag.
    const bases = [...html.children].filter((c) => c.classList.contains("katex-base") || c.classList.contains("base")).map((c) => c.getBoundingClientRect());
    if (!bases.length) continue;
    const width = Math.max(...bases.map((r) => r.right)) - Math.min(...bases.map((r) => r.left));
    const tag = html.querySelector<HTMLElement>(":scope > .katex-tag, :scope > .tag")?.getBoundingClientRect().width ?? 0;
    const em = Number.parseFloat(getComputedStyle(html).fontSize) || 16;
    const plan = planEquation({ available: display.clientWidth, width, tag, gap: em * 0.8, widestPiece: Math.max(...bases.map((r) => r.width)) });
    if (plan.scale < 1) display.style.setProperty("--fit", plan.scale.toFixed(4));
    display.classList.toggle("is-tag-below", plan.tagBelow);
    display.classList.toggle("is-wrapped", plan.wrap);
  }
}

/** Marks the short blocks and groups to keep on one page (see KEEP_BLOCK and KEEP_GROUP). */
export function markKeeps(root: HTMLElement) {
  for (const el of root.querySelectorAll<HTMLElement>(".print-doc__group, .print-doc__block")) {
    const limit = el.classList.contains("print-doc__group") ? KEEP_GROUP : KEEP_BLOCK;
    el.classList.toggle("print-doc__keep", el.getBoundingClientRect().height <= limit);
  }
}
