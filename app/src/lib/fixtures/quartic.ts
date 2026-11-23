// A long research document of the kind Auto mode writes, for testing print and export: an
// abstract, long theorems and proofs, piecewise and wide numbered equations, a 2D and a 3D graph,
// and a Lean formalization of well over a page near the end with more prose after it.

import type { Block, Doc } from "../types";

export const QUARTIC_LEAN = String.raw`import Mathlib

/-!
# A sharp nonnegativity criterion for a parameterized quartic

We study \`P a x = x ^ 4 - 2 * a * x ^ 2 + 1\` and prove that \`P a\` is nonnegative on all of \`ℝ\`
exactly when \`a ≤ 1\`, together with its global minimum and the points where it is attained.
-/

open Real

namespace Quartic

/-- The quartic \`P_a(x) = x⁴ - 2ax² + 1\`. -/
noncomputable def P (a x : ℝ) : ℝ := x ^ 4 - 2 * a * x ^ 2 + 1

/-- Completing the square in \`x²\`. -/
theorem P_eq (a x : ℝ) : P a x = (x ^ 2 - a) ^ 2 + (1 - a ^ 2) := by
  unfold P
  ring

/-- \`P a\` is even. -/
theorem P_neg (a x : ℝ) : P a (-x) = P a x := by
  unfold P
  ring

/-- \`P a 0 = 1\` for every \`a\`. -/
@[simp] theorem P_zero (a : ℝ) : P a 0 = 1 := by
  unfold P
  ring

/-- The lower bound \`1 - a²\`, valid for every \`a\` and \`x\`. -/
theorem P_ge_one_sub_sq (a x : ℝ) : 1 - a ^ 2 ≤ P a x := by
  rw [P_eq]
  nlinarith [sq_nonneg (x ^ 2 - a)]

/-- For \`a ≤ 0\` the quartic is at least \`1\`. -/
theorem P_ge_one_of_nonpos {a : ℝ} (ha : a ≤ 0) (x : ℝ) : 1 ≤ P a x := by
  unfold P
  have hx : 0 ≤ x ^ 2 := sq_nonneg x
  have h4 : 0 ≤ x ^ 4 := by positivity
  nlinarith [mul_nonneg (neg_nonneg.mpr ha) hx]

/-- For \`a > 0\` the bound \`1 - a²\` is attained at \`x = √a\`. -/
theorem P_sqrt {a : ℝ} (ha : 0 < a) : P a (Real.sqrt a) = 1 - a ^ 2 := by
  rw [P_eq]
  have h : Real.sqrt a ^ 2 = a := Real.sq_sqrt ha.le
  rw [h]
  ring

/-- ... and at \`x = -√a\`. -/
theorem P_neg_sqrt {a : ℝ} (ha : 0 < a) : P a (-Real.sqrt a) = 1 - a ^ 2 := by
  rw [P_neg, P_sqrt ha]

/-- The global minimum of \`P a\`, as a piecewise function of \`a\`. -/
noncomputable def m (a : ℝ) : ℝ := if a ≤ 0 then 1 else 1 - a ^ 2

theorem m_le (a x : ℝ) : m a ≤ P a x := by
  unfold m
  split_ifs with ha
  · exact P_ge_one_of_nonpos ha x
  · exact P_ge_one_sub_sq a x

theorem m_attained (a : ℝ) : ∃ x, P a x = m a := by
  unfold m
  split_ifs with ha
  · exact ⟨0, P_zero a⟩
  · exact ⟨Real.sqrt a, P_sqrt (lt_of_not_le ha)⟩

/-- The minimum is \`IsLeast\` of the range. -/
theorem isLeast_range (a : ℝ) : IsLeast (Set.range (P a)) (m a) := by
  refine ⟨?_, ?_⟩
  · obtain ⟨x, hx⟩ := m_attained a
    exact ⟨x, hx⟩
  · rintro y ⟨x, rfl⟩
    exact m_le a x

/-- The sharp criterion: \`P a ≥ 0\` everywhere if and only if \`a ≤ 1\`. -/
theorem nonneg_iff (a : ℝ) : (∀ x, 0 ≤ P a x) ↔ a ≤ 1 := by
  constructor
  · intro h
    by_contra ha
    push_neg at ha
    have hpos : 0 < a := lt_trans one_pos ha
    have h1 := h (Real.sqrt a)
    rw [P_sqrt hpos] at h1
    nlinarith
  · intro ha x
    rcases le_or_lt a 0 with h0 | h0
    · linarith [P_ge_one_of_nonpos h0 x]
    · have := P_ge_one_sub_sq a x
      nlinarith

/-- Strict positivity holds exactly for \`a < 1\`. -/
theorem pos_iff (a : ℝ) : (∀ x, 0 < P a x) ↔ a < 1 := by
  constructor
  · intro h
    by_contra ha
    push_neg at ha
    have hpos : 0 < a := lt_of_lt_of_le one_pos ha
    have h1 := h (Real.sqrt a)
    rw [P_sqrt hpos] at h1
    nlinarith
  · intro ha x
    rcases le_or_lt a 0 with h0 | h0
    · linarith [P_ge_one_of_nonpos h0 x]
    · have := P_ge_one_sub_sq a x
      nlinarith

/-- At the threshold \`a = 1\` the quartic is a perfect square. -/
theorem P_one (x : ℝ) : P 1 x = (x ^ 2 - 1) ^ 2 := by
  unfold P
  ring

/-- ... whose real zeros are exactly \`±1\`. -/
theorem P_one_eq_zero_iff (x : ℝ) : P 1 x = 0 ↔ x = 1 ∨ x = -1 := by
  rw [P_one, sq_eq_zero_iff, sub_eq_zero, sq_eq_one_iff_of_ne_zero] <;> sorry

/-- Values at small integers, checked by evaluation. -/
example : P 0 1 = 2 := by unfold P; norm_num
example : P 0 2 = 17 := by unfold P; norm_num
example : P 1 1 = 0 := by unfold P; norm_num
example : P 1 2 = 9 := by unfold P; norm_num
example : P 2 1 = -2 := by unfold P; norm_num
example : P 2 2 = 1 := by unfold P; norm_num
example : P (-1) 1 = 4 := by unfold P; norm_num
example : P (-1) 2 = 25 := by unfold P; norm_num
example : P (1 / 2) 1 = 1 := by unfold P; norm_num
example : P (1 / 2) 2 = 13 := by unfold P; norm_num
example : P 3 1 = -4 := by unfold P; norm_num
example : P 3 2 = -7 := by unfold P; norm_num

/-- The set of parameters for which \`P a\` is nonnegative is the ray \`(-∞, 1]\`. -/
theorem nonneg_set : {a : ℝ | ∀ x, 0 ≤ P a x} = Set.Iic 1 := by
  ext a
  simp only [Set.mem_setOf_eq, Set.mem_Iic]
  exact nonneg_iff a

/-- The minimum value is continuous in the parameter: on each piece it is a polynomial, and at
the junction \`a = 0\` both pieces take the value \`1\`, so no jump can occur there either. -/
theorem m_continuous : Continuous m := by
  unfold m
  refine Continuous.if_le continuous_const (by continuity) continuous_id continuous_const ?_
  intro a ha
  rw [ha]
  ring

/-- \`m\` is nonincreasing. -/
theorem m_antitone : Antitone m := by
  intro a b hab
  unfold m
  split_ifs with h1 h2 h2
  · exact le_rfl
  · nlinarith
  · exact absurd (le_trans hab h2) h1
  · nlinarith

/-- The minimum is negative exactly when \`a > 1\`. -/
theorem m_neg_iff (a : ℝ) : m a < 0 ↔ 1 < a := by
  unfold m
  split_ifs with h
  · constructor
    · intro h'
      linarith
    · intro h'
      linarith
  · constructor
    · intro h'
      nlinarith
    · intro h'
      nlinarith

end Quartic`.replace(/\\`/g, "`");

let n = 0;
const block = (source: string, extra: Partial<Block> = {}): Block => ({ id: `q${++n}`, source, ...extra });

/** "A sharp nonnegativity criterion for a parameterized quartic", as Auto mode might write it. */
export function quarticDocument(): Doc {
  n = 0;
  const blocks: Block[] = [
    block("## 1 Introduction"),
    block(
      "Throughout, $a$ is a real parameter and $P_a(x) = x^4 - 2ax^2 + 1$. The family interpolates between the strictly positive quartic $x^4 + 1$ at $a = 0$ and quartics with two double wells for large $a$. We determine, for every $a$, the global minimum of $P_a$ on $\\mathbb{R}$, the points where it is attained, and the exact range of $a$ for which $P_a$ is nonnegative. The answer is sharp: nonnegativity holds precisely for $a \\le 1$, and at the threshold $a = 1$ the quartic degenerates into a perfect square with double roots at $\\pm 1$.",
    ),
    block(
      "Completing the square in $x^2$ gives the identity on which everything rests,\n\n$$\nP_a(x) = (x^2 - a)^2 + 1 - a^2,\n$$\n\nso the behaviour of $P_a$ is governed by whether the inner square $x^2 - a$ can vanish, which happens exactly when $a \\ge 0$.",
    ),
    block(
      "**Theorem 1** (global minimum). *For every $a \\in \\mathbb{R}$ the quartic $P_a$ attains its minimum on $\\mathbb{R}$, and*\n\n$$\n\\min_{x \\in \\mathbb{R}} P_a(x) = m(a) := \\begin{cases} 1, & a \\le 0, \\\\ 1 - a^2, & a > 0, \\end{cases} \\qquad \\operatorname*{arg\\,min}_{x \\in \\mathbb{R}} P_a(x) = \\begin{cases} \\{0\\}, & a \\le 0, \\\\ \\{-\\sqrt{a},\\ \\sqrt{a}\\}, & a > 0. \\end{cases}\n$$\n\n*In particular $m$ is continuous, nonincreasing, equal to $1$ on $(-\\infty, 0]$, and strictly decreasing on $[0, \\infty)$ with $m(a) \\to -\\infty$ as $a \\to \\infty$.*",
      { status: "verified", note: "checked in Lean" },
    ),
    block(
      "*Proof.* By the identity above, $P_a(x) \\ge 1 - a^2$ for all $x$, with equality if and only if $x^2 = a$. If $a > 0$ this equation has the two solutions $x = \\pm\\sqrt{a}$, so the bound $1 - a^2$ is attained and is the minimum. If $a \\le 0$, then $-2ax^2 \\ge 0$ and $x^4 \\ge 0$, so\n\n$$\n\\begin{aligned} P_a(x) &= x^4 - 2ax^2 + 1 \\\\ &\\ge 0 + 0 + 1 = 1, \\end{aligned}\n$$\n\nwith equality exactly when $x = 0$ (if $a < 0$ both terms must vanish; if $a = 0$ we need $x^4 = 0$). Hence the minimum is $1 = P_a(0)$, attained only at $0$. Continuity of $m$ at $a = 0$ follows since both pieces equal $1$ there, and monotonicity is immediate from the formula: $1 - a^2$ is strictly decreasing on $[0, \\infty)$. $\\square$",
      { status: "proved", note: "checked by hand" },
    ),
    block(
      "**Theorem 2** (sharp criterion). *The quartic $P_a$ is nonnegative on $\\mathbb{R}$ if and only if $a \\le 1$, and strictly positive on $\\mathbb{R}$ if and only if $a < 1$. More precisely, the sign of $P_a$ is classified by*\n\n$$\n\\operatorname{sign}\\Bigl(\\min_{x\\in\\mathbb{R}} P_a(x)\\Bigr) = \\operatorname{sign}\\bigl(m(a)\\bigr) = \\begin{cases} +1 & \\text{if } a < 1 \\ (\\text{so } P_a(x) > 0 \\text{ for every } x \\in \\mathbb{R}), \\\\ 0 & \\text{if } a = 1 \\ (\\text{so } P_1(x) = (x^2-1)^2 \\text{ vanishes exactly at } x = \\pm 1), \\\\ -1 & \\text{if } a > 1 \\ (\\text{so } P_a < 0 \\text{ on } \\sqrt{a - \\sqrt{a^2-1}} < |x| < \\sqrt{a + \\sqrt{a^2-1}}). \\end{cases}\n$$",
      { status: "verified", note: "checked in Lean" },
    ),
    block(
      "*Proof.* By Theorem 1, $\\min P_a = m(a)$. For $a \\le 0$ we have $m(a) = 1 > 0$. For $a > 0$ we have $m(a) = 1 - a^2$, which is positive for $0 < a < 1$, zero for $a = 1$ and negative for $a > 1$. At $a = 1$,\n\n$$\nP_1(x) = x^4 - 2x^2 + 1 = (x^2 - 1)^2 = (x - 1)^2 (x + 1)^2 \\ge 0,\n$$\n\nwith equality exactly at $x = \\pm 1$. For $a > 1$ the roots of $P_a$ in $x^2$ are $x^2 = a \\pm \\sqrt{a^2 - 1}$, both positive since $a > \\sqrt{a^2 - 1}$, and $P_a$ is negative strictly between them. Writing out the factorization explicitly,\n\n$$\nP_a(x) = \\Bigl(x^2 - a - \\sqrt{a^2-1}\\Bigr)\\Bigl(x^2 - a + \\sqrt{a^2-1}\\Bigr) = \\Bigl(x - \\sqrt{a + \\sqrt{a^2-1}}\\Bigr)\\Bigl(x + \\sqrt{a + \\sqrt{a^2-1}}\\Bigr)\\Bigl(x - \\sqrt{a - \\sqrt{a^2-1}}\\Bigr)\\Bigl(x + \\sqrt{a - \\sqrt{a^2-1}}\\Bigr)\n$$\n\nshows the four simple real roots and the sign pattern $+,-,+,-,+$ on the five intervals they cut out. $\\square$",
    ),
    block(
      "**Corollary 3.** *For every $a \\le 1$ and every $x \\in \\mathbb{R}$,*\n\n$$\n\\begin{align} x^4 + 1 &\\ge 2ax^2, \\\\ x^4 - 2x^2 + 1 &\\ge (1 - a) \\cdot 2x^2 \\ge 0, \\\\ \\frac{x^4 + 1}{2x^2} &\\ge a \\quad (x \\neq 0), \\end{align}\n$$\n\n*and the constant $1$ in the first inequality cannot be replaced by any $c < 1$: for $a = 1$ the inequality $x^4 + c \\ge 2x^2$ fails at $x = 1$ whenever $c < 1$.*",
    ),
    block("## 2 Graphical investigation"),
    block(
      "The two pictures below show the family. In the plane, the curves $y = P_a(x)$ for a few values of $a$ around the threshold: the curve for $a = 1$ touches the axis at $\\pm 1$, the curve for $a = 1.4$ dips below it, and the curve for $a = -0.5$ stays above $1$.",
    ),
    block(
      "```graph\ny = x^4 - 2 a x^2 + 1 ; label=P_a\ny = x^4 - 2 x^2 + 1 ; dashed ; label=a = 1\ny = x^4 - 2.8 x^2 + 1 ; label=a = 1.4\ny = x^4 + x^2 + 1 ; label=a = -0.5\na = 0.6 [-1, 2]\nview x=[-2, 2] y=[-1.5, 4] height=320\n```",
    ),
    block(
      "In space, the surface $z = P_y(x)$ over the $(x, y)$-plane with $y$ playing the role of the parameter: the valley floor follows the curve $z = 1 - y^2$ for $y > 0$ and crosses $z = 0$ exactly above the line $y = 1$.",
    ),
    block("```graph3d\nz = x^4 - 2 y x^2 + 1\nview x=[-1.6, 1.6] y=[-1, 2] z=[-2, 4]\n```"),
    block(
      "Both pictures agree with Theorem 2: the minimum over $x$ is positive for $a < 1$, zero at $a = 1$, and negative beyond.",
    ),
    block("## 3 Lean 4 formalization"),
    block(
      "The statements of Theorems 1 and 2 have been formalized in Lean 4 with Mathlib. The file below defines $P_a$ and the piecewise minimum $m$, proves the lower bound, the attainment of the minimum, the sharp criterion and its strict version, and checks a table of values by evaluation.",
    ),
    block(`\`\`\`lean\n${QUARTIC_LEAN}\n\`\`\``, { status: "verified", note: "checked in Lean" }),
    block(
      "**Verification status.** Lean accepts every theorem above except `P_one_eq_zero_iff`, whose last step is left as `sorry`; it is not used elsewhere. The main results `nonneg_iff`, `pos_iff`, `isLeast_range` and `m_continuous` depend only on the standard axioms.",
    ),
    block("## 4 Discussion"),
    block(
      "The criterion $a \\le 1$ is the quartic case of a general principle: an even polynomial in $x$ that is a quadratic in $x^2$ is nonnegative on $\\mathbb{R}$ exactly when that quadratic is nonnegative on $[0, \\infty)$. It would be interesting to extend the formalization to the two-parameter family $x^4 - 2ax^2 + b$.",
    ),
    block("This is the last paragraph of the document, after the Lean formalization. If it is missing from a printed copy, the print is incomplete."),
  ];
  return {
    id: "quartic",
    projectId: "research",
    title: "A sharp nonnegativity criterion for a parameterized quartic",
    lede: "We study the one-parameter family of even quartics $P_a(x) = x^4 - 2ax^2 + 1$. We determine the global minimum of $P_a$ and where it is attained as piecewise functions of $a$, prove that $P_a \\ge 0$ on $\\mathbb{R}$ if and only if $a \\le 1$, illustrate the transition with plane and space graphs, and formalize the main results in Lean 4.",
    blocks,
    threads: [],
    revision: 7,
    createdAt: 0,
    updatedAt: 0,
    status: "verified",
    pending: 0,
  };
}

/**
 * Phrases a complete printed copy shows once each, in this order: every section, the long
 * statements and proofs, both graphs' captions, the Lean file's first and last lines, and the
 * prose after it.
 */
export const QUARTIC_PHRASES = [
  "parameterized quartic ÉLISE MOREAU",
  "We study the one-parameter family",
  "1 Introduction",
  "is a real parameter and",
  "gives the identity on which everything rests",
  "Theorem 1 (global minimum)",
  "is continuous, nonincreasing, equal to",
  "By the identity above",
  "Theorem 2 (sharp criterion)",
  "By Theorem 1,",
  "shows the four simple real roots",
  "Corollary 3.",
  "cannot be replaced by any",
  "2 Graphical investigation",
  "The two pictures below show the family",
  "In space, the surface",
  "Both pictures agree with Theorem 2",
  "3 Lean 4 formalization",
  "The statements of Theorems 1 and 2 have been formalized",
  "import Mathlib",
  "theorem nonneg_iff",
  "end Quartic",
  "Verification status.",
  "4 Discussion",
  "is the quartic case of a general principle",
  "This is the last paragraph of the document",
];
