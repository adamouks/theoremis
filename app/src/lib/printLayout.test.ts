import { describe, expect, it } from "vitest";
import { numberBlocks } from "./doc";
import { QUARTIC_LEAN, quarticDocument } from "./fixtures/quartic";
import { isHeading, KEEP_BLOCK, KEEP_GROUP, PAGE_HEIGHT, planEquation, printedBlocks, printGroups, READABLE_SCALE } from "./printLayout";
import type { Block } from "./types";

describe("what prints", () => {
  const doc = quarticDocument();
  const numbered = numberBlocks(doc.blocks);

  it("prints every block of a long document once, in order, through the prose after the Lean file", () => {
    const printed = printedBlocks(numbered).map((n) => n.block.id);
    expect(printed).toEqual(doc.blocks.map((b) => b.id));
    expect(new Set(printed).size).toBe(printed.length);
    const lean = doc.blocks.findIndex((b) => b.source.startsWith("```lean"));
    expect(lean).toBeGreaterThan(0);
    expect(QUARTIC_LEAN.split("\n").length).toBeGreaterThanOrEqual(150);
    expect(doc.blocks.slice(lean + 1).map((b) => b.source)).toContain("## 4 Discussion");
    expect(printed[printed.length - 1]).toBe(doc.blocks[doc.blocks.length - 1].id);
  });

  it("leaves out only pending suggestions and empty blocks", () => {
    const blocks: Block[] = [
      { id: "a", source: "**Theorem 1.** Statement." },
      { id: "b", source: "  \n" },
      { id: "c", source: "A suggested remark.", suggestion: { threadId: "t", messageId: "m" } },
      { id: "d", source: "*Proof.* Done." },
    ];
    expect(printedBlocks(numberBlocks(blocks)).map((n) => n.block.id)).toEqual(["a", "d"]);
  });

  it("groups each heading with the block after it, and loses nothing in the grouping", () => {
    const groups = printGroups(numbered);
    expect(groups.flatMap((g) => g.blocks.map((n) => n.block.id))).toEqual(printedBlocks(numbered).map((n) => n.block.id));
    for (const group of groups) {
      const sources = group.blocks.map((n) => n.block.source);
      expect(sources.slice(0, -1).every(isHeading)).toBe(true);
      if (group.blocks.length === 1) expect(isHeading(sources[0]) && group !== groups[groups.length - 1]).toBe(false);
    }
    const lean = groups.find((g) => g.blocks.some((n) => n.block.source.startsWith("```lean")))!;
    // The Lean file is a block of its own, never held to a heading: it may run over pages.
    expect(lean.blocks).toHaveLength(1);
  });

  it("knows a heading block", () => {
    expect(isHeading("## 3 Lean 4 formalization")).toBe(true);
    expect(isHeading("# Part I\n\n## Chapter 1")).toBe(true);
    expect(isHeading("## Heading\n\nA paragraph.")).toBe(false);
    expect(isHeading("**Theorem 1.** Statement.")).toBe(false);
    expect(isHeading("#hashtag")).toBe(false);
    expect(isHeading("")).toBe(false);
  });

  it("keeps together only what is short next to a page", () => {
    expect(PAGE_HEIGHT).toBeGreaterThan(800);
    expect(KEEP_BLOCK).toBeLessThan(PAGE_HEIGHT / 3);
    expect(KEEP_GROUP).toBeLessThan(PAGE_HEIGHT / 2);
  });
});

describe("fitting a displayed equation to the column", () => {
  const plan = (available: number, width: number, tag = 0, widestPiece = width) => planEquation({ available, width, tag, gap: 12, widestPiece });

  it("leaves an equation that fits alone", () => {
    expect(plan(600, 400)).toEqual({ scale: 1, tagBelow: false, wrap: false });
    expect(plan(600, 500, 30)).toEqual({ scale: 1, tagBelow: false, wrap: false });
  });

  it("shrinks a slightly wide one, keeping its number clear of it on the same line", () => {
    const p = plan(600, 560, 30);
    expect(p.wrap).toBe(false);
    expect(p.tagBelow).toBe(false);
    expect(p.scale).toBeGreaterThanOrEqual(READABLE_SCALE);
    expect(p.scale * (560 + 2 * (30 + 12))).toBeLessThanOrEqual(600 + 1e-9);
  });

  it("moves the number under an equation that only fits without it", () => {
    expect(plan(600, 590, 80)).toEqual({ scale: 1, tagBelow: true, wrap: false });
    const p = plan(600, 640, 80);
    expect(p).toMatchObject({ tagBelow: true, wrap: false });
    expect(p.scale * 640).toBeLessThanOrEqual(600 + 1e-9);
  });

  it("breaks a long equation at its operators rather than shrink it unreadably", () => {
    const p = plan(600, 1000, 30, 260);
    expect(p).toEqual({ scale: 1, tagBelow: true, wrap: true });
    expect(plan(600, 1400, 0, 700)).toMatchObject({ wrap: true, scale: 600 / 700 });
  });

  it("shrinks one with nothing to break at until it fits, never cutting it off", () => {
    const p = plan(600, 1500, 30, 1500);
    expect(p.wrap).toBe(false);
    expect(p.scale * 1500).toBeLessThanOrEqual(600 + 1e-9);
  });

  it("never enlarges, and always fits what it decides", () => {
    for (let i = 0; i < 500; i++) {
      const available = 200 + ((i * 37) % 600);
      const width = 50 + ((i * 101) % 1800);
      const tag = i % 3 ? 0 : 20 + (i % 40);
      const widestPiece = Math.max(10, width / (1 + (i % 5)));
      const p = plan(available, width, tag, widestPiece);
      expect(p.scale).toBeGreaterThan(0);
      expect(p.scale).toBeLessThanOrEqual(1);
      const line = p.wrap ? widestPiece : width + (tag && !p.tagBelow ? 2 * (tag + 12) : 0);
      expect(p.scale * line).toBeLessThanOrEqual(available + 0.5 + 1e-9);
    }
  });
});
