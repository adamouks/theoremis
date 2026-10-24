import { describe, expect, it } from "vitest";
import { joinContinuation, parseCrop, parseTranscript, resolveFigures, usedFigureIds } from "./transcript";

const reply = String.raw`@@ title
# On Sums of Odd Integers
@@ lede
We characterize run numbers.
@@ block page=1
## 1 Introduction
@@ block page=1 status=draft note="proof in source"
**Theorem 1.** *For every $n\ge 1$,*

$$
\sum_{k=1}^{n}(2k-1)=n^2
$$
@@ block page=1
*Proof.* By induction on $n$.
@@ block page=2 status=proved
**Lemma 2.** *A claim.*
@@ block page=2 status=open note="cited from [3]"
**Conjecture 3.** *Another.*
@@ block page=2
![Figure 1: Partial sums against $n^2$.](figure:F2)`;

describe("parseTranscript", () => {
  it("reads the title, lede and blocks with their pages and statuses", () => {
    const t = parseTranscript(reply);
    expect(t.title).toBe("On Sums of Odd Integers");
    expect(t.lede).toBe("We characterize run numbers.");
    expect(t.blocks).toHaveLength(6);
    expect(t.blocks[0]).toEqual({ source: "## 1 Introduction", page: 1, continues: false });
    expect(t.blocks[1].status).toBe("draft");
    expect(t.blocks[1].note).toBe("proof in source");
    expect(t.blocks[1].source).toContain("\\sum_{k=1}^{n}(2k-1)=n^2");
    // A transcription never marks a statement as checked.
    expect(t.blocks[3].status).toBe("draft");
    expect(t.blocks[4]).toMatchObject({ status: "open", note: "cited from [3]" });
  });

  it("reads a reply that is still streaming, and one wrapped in a fence", () => {
    const partial = parseTranscript("@@ block page=4\n*Proof.* Suppose $x");
    expect(partial.blocks).toEqual([{ source: "*Proof.* Suppose $x", page: 4, continues: false }]);
    const fenced = parseTranscript("```text\n@@ block page=1 continues\nand so on.\n```");
    expect(fenced.blocks).toEqual([{ source: "and so on.", page: 1, continues: true }]);
  });

  it("keeps text before the first header, and ignores @@ inside a block's lines", () => {
    const t = parseTranscript("Stray preface.\n@@ block\nUses the @@ symbol mid-line.");
    expect(t.blocks.map((b) => b.source)).toEqual(["Stray preface.", "Uses the @@ symbol mid-line."]);
  });
});

describe("joinContinuation", () => {
  it("joins mid-sentence with a space and new material with a paragraph break", () => {
    expect(joinContinuation("the run from", "$2m+1$ to $2n-1$.")).toBe("the run from $2m+1$ to $2n-1$.");
    expect(joinContinuation("This ends.", "A new paragraph.")).toBe("This ends.\n\nA new paragraph.");
    expect(joinContinuation("for all $n$", "and $m$.")).toBe("for all $n$ and $m$.");
    expect(joinContinuation("we get", "$$\nx=1\n$$")).toBe("we get\n\n$$\nx=1\n$$");
  });
});

describe("figures", () => {
  it("resolves figure and crop links to media, and drops the unknown to a caption", () => {
    const source = "![Figure 1: $f$.](figure:F2)\n\n![Photo](crop:3:0.1,0.2,0.9,0.6)\n\n![Lost](figure:F9)";
    const resolved = resolveFigures(source, new Map([["F2", "fig-a.png"]]), new Map([["crop:3:0.1,0.2,0.9,0.6", "fig-b.png"]]));
    expect(resolved).toBe("![Figure 1: $f$.](asset:fig-a.png)\n\n![Photo](asset:fig-b.png)\n\n*[Figure: Lost]*");
    expect([...usedFigureIds([source])]).toEqual(["F2", "F9"]);
    expect(resolveFigures("![The sine on $[0, 2\\pi]$.](figure:plot-1)", new Map([["plot-1", "p.png"]]))).toBe(
      "![The sine on $[0, 2\\pi]$.](asset:p.png)",
    );
  });

  it("reads crop regions as fractions, accepting percentages", () => {
    expect(parseCrop("crop:3:0.12,0.40,0.88,0.71")).toEqual({ page: 3, left: 0.12, top: 0.4, right: 0.88, bottom: 0.71 });
    expect(parseCrop("crop:1:10,20,90,60")).toEqual({ page: 1, left: 0.1, top: 0.2, right: 0.9, bottom: 0.6 });
    expect(parseCrop("crop:1:0.5,0.5,0.5,0.9")).toBeNull();
    expect(parseCrop("crop:x")).toBeNull();
  });
});
