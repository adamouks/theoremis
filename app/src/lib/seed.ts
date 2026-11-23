import { withSummary } from "./doc";
import { newId } from "./text";
import type { Block, Doc, Project } from "./types";

function block(source: string, status?: Block["status"], note?: string): Block {
  return { id: newId(), source, ...(status ? { status } : {}), ...(note ? { note } : {}) };
}

let order = 0;

function doc(projectId: string, title: string, lede: string, blocks: Block[], ageMinutes: number): Doc {
  const time = Date.now() - ageMinutes * 60_000;
  // Creation times only order the list; the edit times make the example feel lived in.
  order += 1;
  return withSummary({
    id: newId(),
    projectId,
    title,
    lede,
    blocks,
    threads: [],
    revision: 1,
    createdAt: Date.now() - 7 * 24 * 3_600_000 + order,
    updatedAt: time,
    status: "open",
    pending: 0,
  });
}

/** The example project a new workspace starts with, so there is something to try the tools on. */
export function exampleWorkspace(): { project: Project; documents: Doc[] } {
  const project: Project = { id: newId(), name: "Figurate numbers", createdAt: Date.now(), collapsed: false };
  const p = project.id;
  const documents = [
    doc(
      p,
      "Sums of odd integers",
      "We prove $1+3+\\cdots+(2n-1)=n^2$ and look for an argument that extends to runs of odd integers that do not start at 1.",
      [
        block(
          "**Conjecture 1.** *For every integer $n\\ge 1$, the sum of the first $n$ odd positive integers is $n^2$:*\n\n$$\n\\sum_{k=1}^{n}(2k-1)=n^2\n$$",
          "open",
          "tested to $10^4$",
        ),
        block(
          "*Proof.* By induction on $n$. The case $n=1$ reads $1=1^2$. Suppose (1) holds for some $n\\ge 1$. Adding the next odd number, $2n+1$, to both sides gives",
          "draft",
          "not formalized",
        ),
        block("$$\n\\begin{align}\n\\sum_{k=1}^{n+1}(2k-1) &= n^2+2n+1 \\\\\n&= (n+1)^2.\n\\end{align}\n$$"),
        block("Hence (1) holds for $n+1$, and therefore for every $n\\ge 1$."),
        block("## Runs that do not start at 1"),
        block(
          "**Question 3.** *Which positive integers are sums of two or more consecutive odd integers?*",
          "open",
        ),
        block(
          "A run from $2m+1$ to $2n-1$ has $n-m$ terms, and subtracting two instances of (1) gives\n\n$$\n\\sum_{k=m+1}^{n}(2k-1)=n^2-m^2=(n-m)(n+m)\n$$",
        ),
        block("So the question asks which integers factor as $(n-m)(n+m)$ with $n-m\\ge 2$."),
      ],
      2,
    ),
    doc(
      p,
      "Nicomachus’s theorem",
      "The sum of the first $n$ cubes is the square of the $n$-th triangular number.",
      [
        block(
          "**Theorem 1.** *For every $n\\ge 1$,*\n\n$$\n\\sum_{k=1}^{n}k^3=\\Bigl(\\sum_{k=1}^{n}k\\Bigr)^2=\\frac{n^2(n+1)^2}{4}.\n$$",
          "proved",
          "checked by hand",
        ),
        block(
          "*Proof.* Induction on $n$. Both sides equal 1 when $n=1$, and adding $(n+1)^3$ to $\\tfrac{n^2(n+1)^2}{4}$ gives $\\tfrac{(n+1)^2(n^2+4n+4)}{4}=\\tfrac{(n+1)^2(n+2)^2}{4}$.",
          "proved",
          "checked by hand",
        ),
      ],
      60 * 26,
    ),
    doc(
      p,
      "Faulhaber’s formula",
      "Closed forms for $\\sum_{k=1}^{n}k^p$ as polynomials in $n$ of degree $p+1$.",
      [
        block(
          "**Theorem 1.** *For every $p\\ge 0$,*\n\n$$\n\\sum_{k=1}^{n}k^p=\\frac{1}{p+1}\\sum_{j=0}^{p}\\binom{p+1}{j}B_j\\,n^{p+1-j},\n$$\n\n*with Bernoulli numbers $B_j$ ($B_1=+\\tfrac12$).*",
          "draft",
          "not formalized",
        ),
      ],
      60 * 24 * 3,
    ),
    doc(
      p,
      "Centered square numbers",
      "Numbers of the form $n^2+(n-1)^2$: $1, 5, 13, 25, 41, \\dots$",
      [
        block(
          "**Question 1.** *Which centered square numbers are perfect squares?*",
          "open",
        ),
      ],
      60 * 24 * 6,
    ),
  ];
  return { project, documents };
}
