import { describe, expect, it } from "vitest";
import { createDocument } from "./doc";
import { applyPart, documentTail, startPart, statementLabels } from "./importDoc";
import { parseTranscript } from "./transcript";
import type { Doc } from "./types";

const resolve = (s: string) => s.replace("figure:F1", "asset:fig.png");

describe("applyPart", () => {
  it("fills a new document as the reply streams, replacing its own earlier reading", () => {
    let doc = createDocument("p");
    const part = startPart(doc, null, { header: true, pages: true });
    doc = applyPart(doc, part, parseTranscript("@@ title\nOdd sums\n@@ block page=1\nFirst par"), resolve);
    expect(doc.title).toBe("Odd sums");
    expect(doc.blocks.map((b) => b.source)).toEqual(["First par"]);
    doc = applyPart(doc, part, parseTranscript("@@ title\nOdd sums\n@@ block page=1\nFirst paragraph.\n@@ block page=2 status=open\n**Q 1.** ![F](figure:F1)"), resolve);
    expect(doc.blocks.map((b) => b.source)).toEqual(["First paragraph.", "**Q 1.** ![F](asset:fig.png)"]);
    expect(doc.blocks[1]).toMatchObject({ page: 2, status: "open" });
    expect(new Set(doc.blocks.map((b) => b.id)).size).toBe(2);
    // The lede grows as it streams, until the person edits it.
    doc = applyPart(doc, part, parseTranscript("@@ lede\nWe char"), resolve);
    doc = applyPart(doc, part, parseTranscript("@@ lede\nWe characterize run numbers."), resolve);
    expect(doc.lede).toBe("We characterize run numbers.");
    doc = applyPart({ ...doc, lede: "My summary." }, part, parseTranscript("@@ lede\nWe characterize run numbers, again."), resolve);
    expect(doc.lede).toBe("My summary.");
  });

  it("lets the next part continue the last block, and undo that if the reply changes its mind", () => {
    let doc = createDocument("p");
    const first = startPart(doc, null, { header: true, pages: true });
    doc = applyPart(doc, first, parseTranscript("@@ block page=1\nThe run from"), resolve);
    const second = startPart(doc, first, { header: false, pages: true });
    doc = applyPart(doc, second, parseTranscript("@@ block page=2 continues\n$2m+1$ to $2n-1$.\n@@ block page=2\nNext."), resolve);
    expect(doc.blocks.map((b) => b.source)).toEqual(["The run from $2m+1$ to $2n-1$.", "Next."]);
    doc = applyPart(doc, second, parseTranscript("@@ block page=2\nOnly new."), resolve);
    expect(doc.blocks.map((b) => b.source)).toEqual(["The run from", "Only new."]);
  });

  it("adds to the end of an existing document without touching its blocks or title", () => {
    let doc: Doc = { ...createDocument("p"), title: "Mine", blocks: [{ id: "a", source: "My note" }] };
    const part = startPart(doc, null, { header: false, pages: false });
    doc = applyPart(doc, part, parseTranscript("@@ title\nTheirs\n@@ block page=1 continues\nAdded."), resolve);
    expect(doc.title).toBe("Mine");
    expect(doc.blocks.map((b) => b.source)).toEqual(["My note", "Added."]);
    expect(doc.blocks[1].page).toBeUndefined();
  });

  it("summarizes labels and the tail for the next part", () => {
    const doc = { ...createDocument("p"), blocks: [{ id: "a", source: "**Theorem 1.** *x*" }, { id: "b", source: "*Proof.* y" }, { id: "c", source: "**Lemma 2.3.** *z*" }] };
    expect(statementLabels(doc)).toEqual(["Theorem 1", "Lemma 2.3"]);
    expect(documentTail(doc, 10)).toBe("…2.3.** *z*");
    expect(documentTail(doc)).toBe("**Theorem 1.** *x*\n\n*Proof.* y\n\n**Lemma 2.3.** *z*");
  });
});
