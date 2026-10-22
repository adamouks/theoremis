import { describe, expect, it } from "vitest";
import { dateGroup, deriveTitle, normalizeMath } from "./text";

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

  it("leaves code untouched", () => {
    const source = "Use `\\(x\\)` inline.\n```tex\n\\[ y \\]\n```\nThen \\(z\\).";
    expect(normalizeMath(source)).toBe("Use `\\(x\\)` inline.\n```tex\n\\[ y \\]\n```\nThen $z$.");
  });

  it("leaves an unterminated fence alone while streaming", () => {
    const source = "Here:\n```latex\n\\[ a \\]";
    expect(normalizeMath(source)).toBe(source);
  });
});

describe("deriveTitle", () => {
  it("uses the first non-empty line without markdown", () => {
    expect(deriveTitle("\n\n## Prove that **√2** is irrational\nmore")).toBe(
      "Prove that √2 is irrational",
    );
  });

  it("truncates long titles", () => {
    const title = deriveTitle("a".repeat(100), 20);
    expect(title).toHaveLength(20);
    expect(title.endsWith("…")).toBe(true);
  });

  it("falls back for empty input", () => {
    expect(deriveTitle("   ")).toBe("New chat");
  });
});

describe("dateGroup", () => {
  const now = new Date(2026, 9, 22, 15, 0).getTime();
  it("buckets by calendar day", () => {
    expect(dateGroup(new Date(2026, 9, 22, 0, 1).getTime(), now)).toBe("Today");
    expect(dateGroup(new Date(2026, 9, 21, 23, 59).getTime(), now)).toBe("Yesterday");
    expect(dateGroup(new Date(2026, 9, 17).getTime(), now)).toBe("Previous 7 days");
    expect(dateGroup(new Date(2026, 9, 1).getTime(), now)).toBe("Previous 30 days");
    expect(dateGroup(new Date(2025, 0, 1).getTime(), now)).toBe("Older");
  });
});
