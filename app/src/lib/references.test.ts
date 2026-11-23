import katex from "katex";
import { describe, expect, it } from "vitest";
import { citationNumbers, formatEntry, parseBibtex, plainText, protectTitle, sentenceCase, suggestKey } from "./bibtex";
import { citationLinkKeys, citedKeys, linkCitations } from "./citations";
import { macroSource, readMacros } from "./macros";

const render = (tex: string, macros: object) => katex.renderToString(tex, { macros: { ...macros }, throwOnError: true });

describe("macros", () => {
  it("reads the definitions out of a pasted preamble and gives them to KaTeX", () => {
    const m = readMacros(String.raw`\documentclass{amsart}
\usepackage{amsmath}
\newcommand{\R}{\mathbb{R}}   % KaTeX has \R already; this redefines it
\newcommand\norm[1]{\lVert #1 \rVert}
\DeclareMathOperator{\Hom}{Hom}
\DeclareMathOperator*{\argmax}{arg\,max}
\def\eps{\varepsilon}
\providecommand{\N}{\mathbf{N}}
% \newcommand{\gone}{x}
\newcommand{\ip}[2][x]{\langle #1, #2 \rangle}`);
    expect(m.definitions.map((d) => d.name)).toEqual(["\\R", "\\norm", "\\Hom", "\\argmax", "\\eps", "\\N", "\\ip"]);
    expect(m.ignored).toEqual(["\\documentclass{amsart}", "\\usepackage{amsmath}"]);
    expect(m.problems).toEqual(["\\ip: an optional argument with a default isn't supported here, so it renders only in the LaTeX export."]);
    // KaTeX renders with them, and a \providecommand of something it knows keeps its own.
    expect(() => render("\\norm{x} \\in \\R, \\Hom(A, B), \\argmax_x f, \\eps, \\N", m.katex)).not.toThrow();
    expect(render("\\Hom", m.katex)).toContain("Hom");
    expect(render("\\N", m.katex)).toContain('mathvariant="double-struck"');
    // The export gets the definitions as written, one to a line.
    expect(macroSource(m).split("\n")[1]).toBe("\\newcommand\\norm[1]{\\lVert #1 \\rVert}");
  });

  it("says which definitions KaTeX can't take, and keeps the rest", () => {
    const m = readMacros("\\newcommand{\\bad}{\\frac{1}\n\\newcommand{\\good}{x}\n\\newcommand{\\worse}{\\undefinedthing}");
    expect(m.definitions.map((d) => d.name)).toEqual(["\\good", "\\worse"]);
    expect(() => render("\\good", m.katex)).not.toThrow();
    // An undefined command in a body is only found when it's used.
    expect(readMacros("").definitions).toEqual([]);
  });
});

const BIB = String.raw`
@string{ann = "Annals of Mathematics"}
@comment{Exported from somewhere}
@article{wiles1995,
  author = {Wiles, Andrew},
  title = {Modular elliptic curves and {F}ermat's {L}ast {T}heorem},
  journal = ann,
  volume = 141,
  number = {3},
  year = {1995},
  pages = {443--551},
}
@book{gauss1801, author = "Carl Friedrich Gauss", title = {Disquisitiones Arithmeticae}, publisher = {Fleischer}, address = {Leipzig}, year = 1801}
@misc{tao2023,
  author = {Tao, Terence and Green, Ben and Erd{\H o}s, P{\'a}l},
  title = {Sums of $k$-th powers},
  howpublished = {arXiv:2301.01234 [math.NT]},
  eprint = {2301.01234},
  archivePrefix = {arXiv},
  primaryClass = {math.NT},
  year = {2023}
}
@inproceedings{poussin, author = {de la Vall{\'e}e Poussin, Charles}, title = {Recherches analytiques}, booktitle = {Annales}, year = {1896}, pages = {183--256}}
@article{broken
`;

describe("references", () => {
  const { entries, problems } = parseBibtex(BIB);

  it("reads BibTeX entries, strings and comments", () => {
    expect(entries.map((e) => e.key)).toEqual(["wiles1995", "gauss1801", "tao2023", "poussin"]);
    expect(entries[0].fields.journal).toBe("Annals of Mathematics");
    expect(entries[0].fields.volume).toBe("141");
    expect(entries[0].fields.title).toBe("Modular elliptic curves and {F}ermat's {L}ast {T}heorem");
    expect(problems).toHaveLength(1);
  });

  it("formats them as amsplain does", () => {
    expect(formatEntry(entries[0])).toBe("Andrew Wiles, *Modular elliptic curves and Fermat's Last Theorem*, Annals of Mathematics **141** (1995), no. 3, 443–551.");
    expect(formatEntry(entries[1])).toBe("Carl Friedrich Gauss, *Disquisitiones arithmeticae*, Fleischer, Leipzig, 1801.");
    expect(formatEntry(entries[2])).toBe("Terence Tao, Ben Green, and Pál Erdős, *Sums of $k$-th powers*, arXiv:2301.01234 [math.NT], 2023.");
    expect(formatEntry(entries[3])).toBe("Charles de la Vallée Poussin, *Recherches analytiques*, Annales, 1896, pp. 183–256.");
    expect(sentenceCase("The {Riemann} Hypothesis: A Survey of $L$-Functions and \\emph{Zeta}")).toBe("The {Riemann} hypothesis: A survey of $L$-functions and \\emph{Zeta}");
    expect(plainText("Erd{\\H o}s and G{\\\"o}del, {\\ss}, \\o, $\\{x\\}$")).toBe("Erdős and Gödel, ß, ø, $\\{x\\}$");
  });

  it("numbers only what's cited, by author, as the exported paper will", () => {
    const numbers = citationNumbers(entries, new Set(["wiles1995", "gauss1801", "tao2023"]));
    expect([...numbers]).toEqual([
      ["gauss1801", 1],
      ["tao2023", 2],
      ["wiles1995", 3],
    ]);
  });

  it("keeps a looked-up title's capitals", () => {
    const crossref = "@article{Wiles_1995, title={Modular Elliptic Curves and Fermat's Last Theorem}, year={1995}}";
    const kept = protectTitle(crossref);
    expect(kept).toBe("@article{Wiles_1995, title={{Modular Elliptic Curves and Fermat's Last Theorem}}, year={1995}}");
    expect(formatEntry(parseBibtex(kept).entries[0])).toContain("*Modular Elliptic Curves and Fermat's Last Theorem*");
    expect(protectTitle(kept)).toBe(kept);
    expect(protectTitle('@misc{a, title = "Quoted", year = 1}')).toBe('@misc{a, title = {{Quoted}}, year = 1}');
  });

  it("suggests keys that aren't taken", () => {
    expect(suggestKey(entries[3], new Set())).toBe("delavalleepoussin1896");
    expect(suggestKey(entries[0], new Set(["wiles1995"]))).toBe("wiles1995a");
  });
});

describe("citations", () => {
  it("finds cited keys outside code", () => {
    const keys = citedKeys(["As in \\cite{a, b} and \\cite[Thm. 2]{c}.", "`\\cite{code}`\n\n```\n\\cite{fence}\n```"]);
    expect([...keys]).toEqual(["a", "b", "c"]);
  });

  it("links citations with their numbers", () => {
    const numbers = new Map([
      ["a", 1],
      ["c", 3],
    ]);
    const text = linkCitations("See \\cite{a,b} and \\cite[Thm. 2]{c}.", (k) => numbers.get(k));
    expect(text).toBe("See [\\[1, ?\\]](cite:a,b) and [\\[3, Thm. 2\\]](cite:c).");
    expect(citationLinkKeys("cite:a,b")).toEqual(["a", "b"]);
    expect(citationLinkKeys("https://x")).toBeNull();
    expect(linkCitations("no citations", () => 1)).toBe("no citations");
  });
});

describe("the collaborator and the notation", () => {
  it("is told the document's macros and the references it may cite", async () => {
    const { buildMessages } = await import("./prompts");
    const doc = {
      id: "d1",
      projectId: "p1",
      title: "T",
      lede: "",
      blocks: [{ id: "b", source: "Let $x \\in \\R$." }],
      threads: [],
      revision: 1,
      createdAt: 0,
      updatedAt: 0,
      status: "open" as const,
      pending: 0,
      macros: "\\usepackage{x}\n\\newcommand{\\R}{\\mathbb{R}}",
      bibliography: BIB,
    };
    const [system] = buildMessages(doc, { id: "t", title: "t", createdAt: 0, updatedAt: 0, messages: [] }, "");
    expect(system.content).toContain("The document's macros, which Theoremis renders; use them in math:\n\\newcommand{\\R}{\\mathbb{R}}");
    expect(system.content).not.toContain("\\usepackage");
    expect(system.content).toContain("- wiles1995: Andrew Wiles, Modular elliptic curves and Fermat's Last Theorem, Annals of Mathematics 141 (1995), no. 3, 443–551.");
  });
});
