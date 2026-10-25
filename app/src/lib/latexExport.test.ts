import { describe, expect, it } from "vitest";
import { unzip } from "./docx";
import { displayMath, documentToLatex, escapeText, exportName } from "./latexExport";
import { numberBlocks } from "./doc";
import type { Block, Doc } from "./types";
import { zip } from "./zip";

const block = (id: string, source: string, extra: Partial<Block> = {}): Block => ({ id, source, ...extra });

function makeDoc(blocks: Block[], title = "On Sums of Odd Numbers", lede = "We prove that $1 + 3 + \\dots + (2n-1) = n^2$."): Doc {
  return { id: "d1", projectId: "p1", title, lede, blocks, threads: [], revision: 1, createdAt: 0, updatedAt: 0, status: "open", pending: 0 };
}

const paper = () =>
  makeDoc([
    block("h", "## 1 Introduction"),
    block("t", "**Theorem 1.** *For every $n \\ge 1$,*\n\n$$\n\\sum_{k=1}^n (2k-1) = n^2.\n$$", { status: "verified", note: "checked in Lean" }),
    block("p", "*Proof.* By induction on $n$; see (1). The step is\n$$\n\\begin{align}\nn^2 + 2n + 1 &= (n+1)^2 \\notag \\\\\n&= m.\n\\end{align}\n$$\n∎"),
    block("d", "**Definition 2** (odd). An integer is *odd* if it is $2k+1$ for some $k \\in ℤ$."),
    block("s", "A suggestion.", { suggestion: { threadId: "t", messageId: "m" } }),
    block("g", "```graph\ny = x^2\n```"),
    block("f", "![The sine on $[0, 2\\pi]$.](asset:fig-1.webp)"),
    block("l", "```lean\ntheorem odd_sum (n : ℕ) : ∑ k ∈ Finset.range n, (2 * k + 1) = n ^ 2 := by\n  sorry\n```"),
    block("x", "Costs 5% & more_than #1, as in \\cite[Thm. 2]{tao2006} and \\cite{gauss}. See [the notes](https://example.com/a%20b)."),
  ]);

describe("LaTeX export", () => {
  it("writes an amsart source with the title, abstract and author", () => {
    const { tex } = documentToLatex(paper(), { author: "Élise Moreau", date: new Date("2026-10-25T12:00:00Z") });
    expect(tex).toMatch(/^% Exported from Theoremis on 2026-10-25\./);
    expect(tex).toContain("\\documentclass[11pt]{amsart}");
    expect(tex).toContain("\\title{On Sums of Odd Numbers}");
    expect(tex).toContain("\\author{Élise Moreau}");
    expect(tex).toContain("\\begin{abstract}\nWe prove that $1 + 3 + \\dots + (2n-1) = n^2$.\n\\end{abstract}\n\n\\maketitle");
    expect(tex.trimEnd().endsWith("\\end{document}")).toBe(true);
    // Packages for what it uses, and hyperref last.
    expect(tex).toContain("\\usepackage{graphicx}");
    expect(tex.indexOf("\\usepackage[hidelinks]{hyperref}")).toBeGreaterThan(tex.indexOf("\\usepackage{graphicx}"));
    expect(tex).not.toContain("booktabs");
  });

  it("keeps statements' names and numbers, and their style", () => {
    const { tex } = documentToLatex(paper());
    expect(tex).toContain("\\section*{1 Introduction}");
    expect(tex).toContain("% Theoremis: verified (checked in Lean)\n\\begin{statement}{Theorem 1}\nFor every $n \\ge 1$,\n\n\\begin{equation}\n\\sum_{k=1}^n (2k-1) = n^2.\n\\end{equation}\n\\end{statement}");
    // Upright text is a definition-style statement, with its note in the name.
    expect(tex).toContain("\\begin{statement*}{Definition 2 (odd)}\nAn integer is \\emph{odd} if it is $2k+1$ for some $k \\in ℤ$.\n\\end{statement*}");
    expect(tex).toContain("\\newtheorem*{statementit}{\\statementname}");
    // A suggestion awaiting a decision isn't part of the document yet.
    expect(tex).not.toContain("A suggestion.");
  });

  it("writes proofs in amsthm's environment, without a second box", () => {
    const { tex } = documentToLatex(paper());
    expect(tex).toContain("\\begin{proof}\nBy induction on $n$; see (1). The step is\n\n\\begin{align}\nn^2 + 2n + 1 &= (n+1)^2 \\notag \\\\\n&= m.\n\\end{align}\n\\end{proof}");
    expect(tex).not.toContain("∎");
    const named = documentToLatex(makeDoc([block("p", "**Proof of Theorem 1.** Clear. $\\square$")])).tex;
    expect(named).toContain("\\begin{proof}[Proof of Theorem 1]\nClear.\n\\end{proof}");
  });

  it("numbers display equations exactly where Theoremis does", () => {
    const sources = [
      "$$\nx = 1\n$$",
      "$$\ny = 2 \\notag\n$$",
      "$$\n\\begin{align}\na &= b \\\\\nc &= d \\nonumber \\\\\ne &= f\n\\end{align}\n$$",
      "$$\nz = 3 \\tag{$*$}\n$$",
      "$$\n\\begin{align*}\np &= q\n\\end{align*}\n$$",
      "$$\nw = 4\n$$",
    ];
    // Theoremis's own numbers: 1, then 2 and 3 for the align's numbered rows, then 4.
    expect(numberBlocks(sources.map((s, i) => block(String(i), s))).flatMap((n) => n.numbers)).toEqual([1, 2, 3, 4]);
    const tex = sources.map((s) => displayMath(/\$\$\n([\s\S]*)\n\$\$/.exec(s)![1])).join("\n");
    // LaTeX numbers each equation without a \tag, and each align row not marked \notag/\nonumber.
    const equations = [...tex.matchAll(/\\begin\{equation\}([\s\S]*?)\\end\{equation\}/g)].filter((m) => !m[1].includes("\\tag"));
    expect(equations.length + 2).toBe(4);
    expect(tex).toContain("\\[\ny = 2\n\\]");
    expect(tex).toContain("\\begin{equation}\nz = 3 \\tag{$*$}\n\\end{equation}");
    expect(tex).toContain("\\begin{align*}");
    expect(displayMath("a \\\\ b")).toBe("\\begin{equation}\n\\begin{gathered}\na \\\\ b\n\\end{gathered}\n\\end{equation}");
  });

  it("puts figures and graphs in files beside the source", () => {
    const { tex, figures } = documentToLatex(paper());
    expect(figures).toEqual([
      { path: "figures/graph-1.png", from: { graph: "y = x^2", dim: 2 } },
      { path: "figures/fig-1.png", from: { asset: "fig-1.webp" } },
    ]);
    expect(tex).toContain("\\includegraphics[width=0.8\\linewidth]{figures/graph-1.png}");
    // The caption keeps its math.
    expect(tex).toContain("\\caption{The sine on $[0, 2\\pi]$.}");
    // A graph that couldn't be pictured is kept as its code.
    const kept = documentToLatex(makeDoc([block("g", "```graph3d\nz = x y\n```")]), { pictured: () => false });
    expect(kept.figures).toEqual([]);
    expect(kept.tex).toContain("% A 3D graph from Theoremis, drawn there from this code:\n\\begin{verbatim}\nz = x y\n\\end{verbatim}");
  });

  it("escapes text, passes citations through and declares characters pdfLaTeX lacks", () => {
    const { tex } = documentToLatex(paper(), { bibliography: "references" });
    expect(tex).toContain("Costs 5\\% \\& more\\_than \\#1, as in \\cite[Thm. 2]{tao2006} and \\cite{gauss}.");
    expect(tex).toContain("\\href{https://example.com/a\\%20b}{the notes}");
    expect(tex).toContain("\\bibliographystyle{amsplain}\n\\bibliography{references}");
    expect(tex).toContain("{\\footnotesize\n\\begin{verbatim}\ntheorem odd_sum (n : ℕ)");
    expect(tex).toContain("\\DeclareUnicodeCharacter{2115}{\\ensuremath{\\mathbb{N}}}");
    expect(tex).toContain("\\DeclareUnicodeCharacter{2124}{\\ensuremath{\\mathbb{Z}}}");
    expect(tex).toContain("\\DeclareUnicodeCharacter{2211}{\\ensuremath{\\sum}}");
    // Accented letters are left to T1 fonts.
    expect(tex).not.toContain("\\DeclareUnicodeCharacter{00C9}");
    expect(escapeText("a\\b {c} ~ ^ “q” — x… y")).toBe("a\\textbackslash{}b \\{c\\} \\textasciitilde{} \\textasciicircum{} ``q'' --- x\\dots{} y");
    // Without a bibliography there's nothing to cite from.
    expect(documentToLatex(paper()).tex).not.toContain("\\bibliography");
  });

  it("defines KaTeX's own macros, after the document's", () => {
    const doc = makeDoc([block("a", "Let $x \\in \\R$ and $f \\colon \\N \\to \\R$.")]);
    const { tex } = documentToLatex(doc, { macros: "\\newcommand{\\N}{\\mathbf{N}}" });
    expect(tex).toContain("% The document's macros\n\\newcommand{\\N}{\\mathbf{N}}");
    expect(tex).toContain("\\providecommand{\\R}{\\mathbb{R}}");
    expect(tex).toContain("\\providecommand{\\N}{\\mathbb{N}}");
    expect(tex.indexOf("\\providecommand{\\N}")).toBeGreaterThan(tex.indexOf("\\newcommand{\\N}"));
    expect(tex).not.toContain("\\providecommand{\\Z}");
  });

  it("converts lists and tables", () => {
    const doc = makeDoc([block("a", "1. first\n2. second with $x$\n\n| a | b |\n|:-|-:|\n| 1 | 2 |"), block("b", "- [x] done\n- [ ] not yet")]);
    const { tex } = documentToLatex(doc);
    expect(tex).toContain("\\begin{enumerate}\n\\item first\n\\item second with $x$\n\\end{enumerate}");
    expect(tex).toContain("\\begin{tabular}{lr}\n\\toprule\na & b \\\\\n\\midrule\n1 & 2 \\\\\n\\bottomrule\n\\end{tabular}");
    expect(tex).toContain("\\usepackage{booktabs}");
    expect(tex).toContain("\\item[$\\boxtimes$] done");
    expect(tex).toContain("\\item[$\\square$] not yet");
  });

  it("names the file after the title", () => {
    expect(exportName("On Sums of Odd Numbers")).toBe("on-sums-of-odd-numbers");
    expect(exportName("Théorème $\\pi$ & co.")).toBe("theoreme-co");
    expect(exportName("")).toBe("untitled");
  });
});

describe("ZIP archives", () => {
  it("writes archives that read back, stored and compressed", async () => {
    const text = new TextEncoder().encode("\\documentclass{amsart}\n".repeat(40));
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...Array.from({ length: 100 }, (_, i) => i)]);
    const archive = await zip([
      { name: "paper/paper.tex", data: text },
      { name: "paper/figures/graph-1.png", data: png },
    ]);
    expect(archive.length).toBeLessThan(text.length + png.length);
    const files = await unzip(archive, () => true);
    expect([...files.keys()]).toEqual(["paper/paper.tex", "paper/figures/graph-1.png"]);
    expect(files.get("paper/paper.tex")).toEqual(text);
    expect(files.get("paper/figures/graph-1.png")).toEqual(png);
  });
});
