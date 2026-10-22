import { describe, expect, it } from "vitest";
import { deriveTitle, equationRange, initials, leadingLabel, normalizeMath, numberEquations, timeAgo } from "./text";

describe("normalizeMath", () => {
  it("rewrites display and inline LaTeX delimiters", () => {
    expect(normalizeMath("Since \\(a^2 + b^2 = c^2\\), we get \\[ c = \\sqrt{a^2+b^2} \\]")).toBe(
      "Since $a^2 + b^2 = c^2$, we get \n$$\nc = \\sqrt{a^2+b^2}\n$$\n",
    );
  });

  it("turns a line holding only $$…$$ into a display block", () => {
    expect(normalizeMath("so\n\n$$|\\langle u, v\\rangle| \\le 1.$$\n\nthen $$x$$ inline")).toBe(
      "so\n\n$$\n|\\langle u, v\\rangle| \\le 1.\n$$\n\nthen $$x$$ inline",
    );
  });

  it("keeps dollar signs in the replacement literal", () => {
    expect(normalizeMath("\\(x\\)")).toBe("$x$");
  });

  it("leaves code untouched, including an unterminated fence", () => {
    const source = "Use `\\(x\\)` inline.\n```tex\n\\[ y \\]\n```\nThen \\(z\\).";
    expect(normalizeMath(source)).toBe("Use `\\(x\\)` inline.\n```tex\n\\[ y \\]\n```\nThen $z$.");
    const streaming = "Here:\n```latex\n\\[ a \\]";
    expect(normalizeMath(streaming)).toBe(streaming);
  });
});

describe("numberEquations", () => {
  it("numbers single display equations from the starting number", () => {
    const { text, numbers } = numberEquations("A\n\n$$\nx=1\n$$\n\nB\n\n$$\ny=2\n$$", 4);
    expect(numbers).toEqual([4, 5]);
    expect(text).toContain("x=1 \\tag{4}");
    expect(text).toContain("y=2 \\tag{5}");
  });

  it("numbers each row of align and gather, skipping \\notag rows", () => {
    const { text, numbers } = numberEquations(
      "$$\n\\begin{align}\na &= b \\\\\n&= c \\notag \\\\\n&= d\n\\end{align}\n$$",
      2,
    );
    expect(numbers).toEqual([2, 3]);
    expect(text).toContain("\\begin{align*}");
    expect(text).toContain("a &= b \\tag{2}");
    expect(text).not.toContain("\\notag");
    expect(text).toContain("&= d \\tag{3}");
  });

  it("leaves tagged, starred and \\nonumber equations unnumbered", () => {
    const tagged = numberEquations("$$\nx \\tag{A}\n$$", 1);
    expect(tagged.numbers).toEqual([]);
    expect(tagged.text).toContain("\\tag{A}");
    expect(numberEquations("$$\n\\begin{align*} a&=b \\end{align*}\n$$", 1).numbers).toEqual([]);
    const unnumbered = numberEquations("$$\nx=1 \\nonumber\n$$", 1);
    expect(unnumbered.numbers).toEqual([]);
    expect(unnumbered.text).not.toContain("nonumber");
  });

  it("handles \\[ \\] delimiters and ignores math in code", () => {
    expect(numberEquations("so \\[ x \\]", 1).numbers).toEqual([1]);
    expect(numberEquations("```\n$$\nx\n$$\n```", 1).numbers).toEqual([]);
  });

  it("numbers consistently across repeated calls", () => {
    const source = "$$\nx \\nonumber\n$$\n\n$$\ny\n$$\n\n$$\nz\n$$";
    expect(numberEquations(source, 1).numbers).toEqual([1, 2]);
    expect(numberEquations(source, 1).numbers).toEqual([1, 2]);
  });
});

describe("labels", () => {
  it("reads the leading bold or italic label", () => {
    expect(leadingLabel("**Conjecture 1.** *For every n*")).toBe("Conjecture 1");
    expect(leadingLabel("*Proof.* By induction")).toBe("Proof");
    expect(leadingLabel("## Runs that do not start at 1")).toBe("Runs that do not start at 1");
    expect(leadingLabel("Hence (1) holds")).toBeNull();
  });

  it("formats equation ranges", () => {
    expect(equationRange([])).toBe("");
    expect(equationRange([2])).toBe("(2)");
    expect(equationRange([2, 3])).toBe("(2)–(3)");
  });
});

describe("small text helpers", () => {
  it("derives titles", () => {
    expect(deriveTitle("\n\n## Prove that **√2** is irrational\nmore")).toBe("Prove that √2 is irrational");
    const long = deriveTitle("a".repeat(100), 20);
    expect(long).toHaveLength(20);
    expect(long.endsWith("…")).toBe(true);
    expect(deriveTitle("   ")).toBe("");
  });

  it("describes elapsed time", () => {
    const now = new Date(2026, 9, 22, 15, 0).getTime();
    expect(timeAgo(now - 10_000, now)).toBe("just now");
    expect(timeAgo(now - 2 * 60_000, now)).toBe("2 min ago");
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(timeAgo(now - 30 * 3_600_000, now)).toBe("yesterday");
  });

  it("builds initials", () => {
    expect(initials("Élise Moreau")).toBe("ÉM");
    expect(initials("ada")).toBe("A");
    expect(initials("  ")).toBe("");
  });
});
