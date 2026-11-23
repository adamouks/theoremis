import { describe, expect, it } from "vitest";
import { latexToBlocks, markdownToBlocks, notebookToBlocks, tableToMarkdown } from "./convert";

describe("markdownToBlocks", () => {
  it("splits paragraphs, keeps math and code whole, and gives statements statuses", () => {
    const md = [
      "# Odd sums",
      "## Introduction",
      "**Theorem 1.** *For every $n$:*",
      "$$\nx\n\ny\n$$",
      "*Proof.* Induction.",
      "**Conjecture 2.** *Something.*",
      "```python\nprint(1)\n\nprint(2)\n```",
    ].join("\n\n");
    const { title, blocks } = markdownToBlocks(md);
    expect(title).toBe("Odd sums");
    expect(blocks.map((b) => b.source)).toEqual([
      "## Introduction",
      "**Theorem 1.** *For every $n$:*\n\n$$\nx\n\ny\n$$",
      "*Proof.* Induction.",
      "**Conjecture 2.** *Something.*",
      "```python\nprint(1)\n\nprint(2)\n```",
    ]);
    expect(blocks[1]).toMatchObject({ status: "draft", note: "proof in source" });
    expect(blocks[3].status).toBe("open");
  });
});

describe("latexToBlocks", () => {
  const tex = String.raw`\documentclass{amsart}
\newtheorem{theorem}{Theorem}
\newtheorem{lemma}[theorem]{Lemma}
\newtheorem*{remark}{Remark}
\title{Odd \emph{sums}}
\begin{document}
\begin{abstract}We prove things.\end{abstract}
\maketitle
\section{Introduction}\label{sec:intro}
Let $n\ge1$. % a comment
\begin{theorem}\label{thm:main}
For every $n$,
\begin{equation}\label{eq:sum}
\sum_{k=1}^n (2k-1) = n^2.
\end{equation}
\end{theorem}
\begin{proof}
Induction on $n$; see \eqref{eq:sum} and Section~\ref{sec:intro}.
\begin{align}
a &= b \nonumber\\
  &= c \label{eq:c}
\end{align}
\end{proof}
\begin{lemma}[Gauss]\label{lem:g} A \textbf{bold} claim, cf.\ \cite{knuth, hardy}.\end{lemma}
\begin{remark} By Theorem~\ref{thm:main} and Lemma~\ref{lem:g}, (\ref{eq:c}) holds.\end{remark}
\begin{figure}\centering\includegraphics[width=3in]{figs/plot-1.pdf}\caption{The plot of $f$.}\end{figure}
\begin{itemize}\item one \item two\end{itemize}
\end{document}`;

  it("converts structure, numbering and references", () => {
    const { title, lede, blocks } = latexToBlocks(tex);
    expect(title).toBe("Odd *sums*");
    expect(lede).toBe("We prove things.");
    const sources = blocks.map((b) => b.source);
    expect(sources[0]).toBe("## 1 Introduction");
    expect(sources[1]).toBe("Let $n\\ge1$.");
    expect(sources[2]).toBe("**Theorem 1.** *For every $n$,*\n\n$$\n\\sum_{k=1}^n (2k-1) = n^2.\n$$");
    expect(blocks[2]).toMatchObject({ status: "draft", note: "proof in source" });
    // (1) is the theorem's equation; the align's second row is (2), its first is unnumbered.
    expect(sources[3]).toContain("see (1) and Section 1.");
    expect(sources[4]).toContain("a &= b \\nonumber\\\\");
    expect(sources.find((s) => s.startsWith("**Lemma 2.**"))).toBe("**Lemma 2.** (Gauss) *A **bold** claim, cf.\\ [knuth, hardy].*");
    expect(sources.find((s) => s.startsWith("**Remark.**"))).toBe("**Remark.** By Theorem 1 and Lemma 2, (2) holds.");
    expect(sources).toContain("![The plot of $f$.](figure:plot-1)");
    expect(sources).toContain("- one\n- two");
  });
});

describe("other formats", () => {
  it("reads notebooks and tables", () => {
    const nb = JSON.stringify({
      metadata: { language_info: { name: "python" } },
      cells: [
        { cell_type: "markdown", source: ["# Experiments\n", "We test $n<10$."] },
        { cell_type: "code", source: "sum(range(10))" },
      ],
    });
    const { title, blocks } = notebookToBlocks(nb);
    expect(title).toBe("Experiments");
    expect(blocks.map((b) => b.source)).toEqual(["We test $n<10$.", "```python\nsum(range(10))\n```"]);
    expect(tableToMarkdown('n,"sum, odd"\n1,1\n2,4', ",")).toBe("| n | sum, odd |\n| --- | --- |\n| 1 | 1 |\n| 2 | 4 |");
  });
});
