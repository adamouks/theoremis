// The expression language of graph blocks: plain input ("y = a x^2 + sin 2x") and the LaTeX
// models and people write ("y = \frac{1}{2}\sin^2 x"), with Desmos's conventions — implicit
// multiplication, single-letter variables (with subscripts), piecewise braces {x<0: -x, x},
// derivatives f'(x), sums, products and integrals. Compiled to closures: the app's content
// security policy rules out eval.

import { GREEK_NAMES } from "./names";

export class ExprError extends Error {}

export type Node =
  | { type: "num"; value: number }
  | { type: "var"; name: string }
  | { type: "neg"; arg: Node }
  | { type: "fact"; arg: Node }
  | { type: "bin"; op: "+" | "-" | "*" | "/" | "^" | "mod"; left: Node; right: Node }
  | { type: "call"; name: string; args: Node[]; prime: number }
  | { type: "tuple"; items: Node[] }
  | { type: "cmp"; ops: Cmp[]; items: Node[] }
  | { type: "piece"; cases: { cond: Node; value: Node | null }[]; otherwise: Node | null }
  | { type: "agg"; kind: "sum" | "prod"; index: string; from: Node; to: Node; body: Node }
  | { type: "int"; variable: string; from: Node; to: Node; body: Node }
  | { type: "deriv"; variable: string; body: Node };

export type Cmp = "<" | "<=" | ">" | ">=" | "=" | "!=";

// ---------------------------------------------------------------------------
// Tokens

type Token =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: string }
  | { t: "frac" }
  | { t: "sqrt" }
  | { t: "binom" }
  | { t: "sum" }
  | { t: "prod" }
  | { t: "int" }
  | { t: "end" };

const GREEK = [...GREEK_NAMES];

export const BUILTIN_FUNCTIONS = new Set([
  "sin", "cos", "tan", "sec", "csc", "cot", "arcsin", "arccos", "arctan", "asin", "acos", "atan", "arcsec", "arccsc",
  "arccot", "sinh", "cosh", "tanh", "sech", "csch", "coth", "arcsinh", "arccosh", "arctanh", "asinh", "acosh", "atanh",
  "exp", "ln", "log", "lg", "sqrt", "cbrt", "nthroot", "abs", "floor", "ceil", "round", "sign", "sgn", "min", "max", "mod",
  "gcd", "lcm", "nCr", "nPr", "binom", "Gamma", "erf",
]);

const CONSTANTS: Record<string, number> = { pi: Math.PI, tau: 2 * Math.PI, e: Math.E, infty: Infinity };

/** Multi-letter names the tokenizer keeps whole; anything else splits into single letters. */
const NAMES = [...BUILTIN_FUNCTIONS, ...GREEK, "pi", "infty", "mod"].sort((a, b) => b.length - a.length);

const COMMANDS: Record<string, Token | Token[] | null> = {
  frac: { t: "frac" },
  dfrac: { t: "frac" },
  tfrac: { t: "frac" },
  sqrt: { t: "sqrt" },
  binom: { t: "binom" },
  sum: { t: "sum" },
  prod: { t: "prod" },
  int: { t: "int" },
  cdot: { t: "op", v: "*" },
  times: { t: "op", v: "*" },
  ast: { t: "op", v: "*" },
  div: { t: "op", v: "/" },
  le: { t: "op", v: "<=" },
  leq: { t: "op", v: "<=" },
  leqslant: { t: "op", v: "<=" },
  ge: { t: "op", v: ">=" },
  geq: { t: "op", v: ">=" },
  geqslant: { t: "op", v: ">=" },
  lt: { t: "op", v: "<" },
  gt: { t: "op", v: ">" },
  ne: { t: "op", v: "!=" },
  neq: { t: "op", v: "!=" },
  mod: { t: "op", v: "mod" },
  bmod: { t: "op", v: "mod" },
  lfloor: [{ t: "id", v: "floor" }, { t: "op", v: "(" }],
  rfloor: { t: "op", v: ")" },
  lceil: [{ t: "id", v: "ceil" }, { t: "op", v: "(" }],
  rceil: { t: "op", v: ")" },
  lvert: { t: "op", v: "|" },
  rvert: { t: "op", v: "|" },
  vert: { t: "op", v: "|" },
  mid: { t: "op", v: "|" },
  left: null,
  right: null,
  big: null,
  Big: null,
  bigg: null,
  Bigg: null,
  displaystyle: null,
  quad: null,
  qquad: null,
  infty: { t: "num", v: Infinity },
  Gamma: { t: "id", v: "Gamma" },
};

const UNICODE: Record<string, string> = {
  "−": "-", "–": "-", "×": "*", "·": "*", "⋅": "*", "÷": "/", "≤": "<=", "≥": ">=", "≠": "!=", "π": "\\pi ", "τ": "\\tau ",
  "θ": "\\theta ", "φ": "\\phi ", "α": "\\alpha ", "β": "\\beta ", "γ": "\\gamma ", "δ": "\\delta ", "λ": "\\lambda ",
  "μ": "\\mu ", "σ": "\\sigma ", "ω": "\\omega ", "ε": "\\epsilon ", "ρ": "\\rho ", "ψ": "\\psi ", "χ": "\\chi ", "∞": "\\infty ",
  "√": "\\sqrt ", "∑": "\\sum ", "∏": "\\prod ", "∫": "\\int ", "²": "^2", "³": "^3", "′": "'", "″": "''",
};

export function tokenize(input: string): Token[] {
  const text = input.replace(/[−–×·⋅÷≤≥≠πτθφαβγδλμσωερψχ∞√∑∏∫²³′″]/g, (c) => UNICODE[c] ?? c);
  const tokens: Token[] = [];
  let i = 0;
  const push = (tok: Token | Token[] | null) => {
    if (!tok) return;
    if (Array.isArray(tok)) tokens.push(...tok);
    else tokens.push(tok);
  };
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "\\") {
      const word = /^\\([a-zA-Z]+)/.exec(text.slice(i));
      if (!word) {
        // \, \; \! \: and "\ " are spacing; \{ \} are braces; \| is a norm bar.
        const next = text[i + 1];
        if (next === "{" || next === "}") push({ t: "op", v: next });
        else if (next === "|") push({ t: "op", v: "|" });
        i += 2;
        continue;
      }
      const name = word[1];
      i += word[0].length;
      if (name === "operatorname" || name === "mathrm" || name === "text" || name === "mathit") {
        const close = text.indexOf("}", i);
        const inner = close > i ? text.slice(text.indexOf("{", i) + 1, close).trim() : "";
        i = close > i ? close + 1 : i;
        if (inner) tokens.push(...tokenize(inner).slice(0, -1));
        continue;
      }
      if ((name === "left" || name === "right") && text[i] === ".") {
        // \left. and \right. are invisible delimiters.
        i++;
        continue;
      }
      if (name in COMMANDS) push(COMMANDS[name]);
      else if (name in CONSTANTS || GREEK.includes(name) || BUILTIN_FUNCTIONS.has(name)) push({ t: "id", v: name === "lg" ? "log" : name });
      else throw new ExprError(`Unknown command \\${name}`);
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)/.exec(text.slice(i));
      if (!m) throw new ExprError(`Unexpected "${c}"`);
      push({ t: "num", v: Number.parseFloat(m[1]) });
      i += m[1].length;
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      const run = /^[a-zA-Z]+/.exec(text.slice(i))![0];
      let j = 0;
      while (j < run.length) {
        const rest = run.slice(j);
        const name = NAMES.find((n) => rest.startsWith(n));
        if (name) {
          push(name === "mod" ? { t: "op", v: "mod" } : { t: "id", v: name === "lg" ? "log" : name });
          j += name.length;
        } else {
          push({ t: "id", v: rest[0] });
          j++;
        }
      }
      i += run.length;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "!=" || two === "==") {
      push({ t: "op", v: two === "==" ? "=" : two });
      i += 2;
      continue;
    }
    if ("+-*/^!()[],:|=<>_{}'".includes(c)) {
      push({ t: "op", v: c });
      i++;
      continue;
    }
    throw new ExprError(`Unexpected "${c}"`);
  }
  tokens.push({ t: "end" });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser

const CMP_OPS = new Set(["<", "<=", ">", ">=", "=", "!="]);

class Parser {
  private i = 0;
  private abs = 0;

  constructor(
    private tokens: Token[],
    private functions: Set<string>,
  ) {}

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.i + offset, this.tokens.length - 1)];
  }

  private next(): Token {
    return this.tokens[this.i++] ?? { t: "end" };
  }

  private isOp(v: string, tok = this.peek()) {
    return tok.t === "op" && tok.v === v;
  }

  private expect(v: string) {
    if (!this.isOp(v)) throw new ExprError(`Expected "${v}"`);
    this.next();
  }

  parse(): Node {
    const node = this.comparison();
    if (this.peek().t !== "end") throw new ExprError(`Unexpected "${describe(this.peek())}"`);
    return node;
  }

  comparison(): Node {
    const first = this.additive();
    const items = [first];
    const ops: Cmp[] = [];
    while (this.peek().t === "op" && CMP_OPS.has((this.peek() as { v: string }).v)) {
      ops.push((this.next() as { v: string }).v as Cmp);
      items.push(this.additive());
    }
    return ops.length ? { type: "cmp", ops, items } : first;
  }

  additive(): Node {
    let left = this.multiplicative();
    while (this.isOp("+") || this.isOp("-")) {
      const op = (this.next() as { v: "+" | "-" }).v;
      left = { type: "bin", op, left, right: this.multiplicative() };
    }
    return left;
  }

  /** Whether the next token can start a factor, for implicit multiplication. */
  private startsFactor(): boolean {
    const tok = this.peek();
    if (tok.t === "num" || tok.t === "id" || tok.t === "frac" || tok.t === "sqrt" || tok.t === "binom") return true;
    if (tok.t === "sum" || tok.t === "prod" || tok.t === "int") return true;
    if (tok.t !== "op") return false;
    if (tok.v === "(" || tok.v === "{") return true;
    // A bar opens an absolute value only when none is open to be closed.
    return tok.v === "|" && this.abs === 0;
  }

  multiplicative(): Node {
    let left = this.unary();
    for (;;) {
      if (this.isOp("*") || this.isOp("/") || this.isOp("mod")) {
        const op = (this.next() as { v: "*" | "/" | "mod" }).v;
        left = { type: "bin", op, left, right: this.unary() };
      } else if (this.startsFactor() && !this.atDifferential()) {
        left = { type: "bin", op: "*", left, right: this.power() };
      } else return left;
    }
  }

  unary(): Node {
    if (this.isOp("-")) {
      this.next();
      return { type: "neg", arg: this.unary() };
    }
    if (this.isOp("+")) {
      this.next();
      return this.unary();
    }
    return this.power();
  }

  power(): Node {
    const base = this.postfix(this.primary());
    if (this.isOp("^")) {
      this.next();
      const exponent = this.isOp("{") ? this.group() : this.isOp("-") ? (this.next(), { type: "neg" as const, arg: this.powerOperand() }) : this.powerOperand();
      return { type: "bin", op: "^", left: base, right: exponent };
    }
    return base;
  }

  /** The exponent in x^2, x^-1, 2^x^2 (right associative). */
  private powerOperand(): Node {
    const base = this.postfix(this.primary());
    if (this.isOp("^")) {
      this.next();
      return { type: "bin", op: "^", left: base, right: this.isOp("{") ? this.group() : this.powerOperand() };
    }
    return base;
  }

  private postfix(node: Node): Node {
    let out = node;
    while (this.isOp("!")) {
      this.next();
      out = { type: "fact", arg: out };
    }
    return out;
  }

  /** `{…}` as LaTeX grouping, or a single factor (x^2, \frac12 aside). */
  group(): Node {
    if (this.isOp("{")) {
      this.next();
      const inner = this.comparison();
      this.expect("}");
      return inner;
    }
    return this.postfix(this.primary());
  }

  /** In an integral, `dx` (or \,dx) ends the integrand. */
  private differential: string | null = null;

  private atDifferential(): boolean {
    if (!this.differential) return false;
    const a = this.peek();
    const b = this.peek(1);
    return a.t === "id" && a.v === "d" && b.t === "id" && b.v === this.differential;
  }

  private subscriptName(base: string): string {
    if (!this.isOp("_")) return base;
    this.next();
    if (this.isOp("{")) {
      this.next();
      let name = "";
      while (!this.isOp("}") && this.peek().t !== "end") {
        const tok = this.next();
        name += tok.t === "num" ? String(tok.v) : tok.t === "id" ? tok.v : "";
      }
      this.expect("}");
      return `${base}_${name}`;
    }
    const tok = this.next();
    return `${base}_${tok.t === "num" ? tok.v : tok.t === "id" ? tok.v : ""}`;
  }

  primary(): Node {
    const tok = this.next();
    switch (tok.t) {
      case "num":
        return { type: "num", value: tok.v };
      case "frac": {
        const num = this.group();
        const den = this.group();
        // \frac{d}{dx} f is a derivative.
        if (num.type === "var" && num.name === "d" && den.type === "bin" && den.op === "*" && den.left.type === "var" && den.left.name === "d" && den.right.type === "var") {
          return { type: "deriv", variable: den.right.name, body: this.power() };
        }
        return { type: "bin", op: "/", left: num, right: den };
      }
      case "sqrt": {
        if (this.isOp("[")) {
          this.next();
          const index = this.additive();
          this.expect("]");
          return { type: "call", name: "nthroot", args: [this.group(), index], prime: 0 };
        }
        return { type: "call", name: "sqrt", args: [this.group()], prime: 0 };
      }
      case "binom":
        return { type: "call", name: "nCr", args: [this.group(), this.group()], prime: 0 };
      case "sum":
      case "prod":
        return this.aggregate(tok.t);
      case "int":
        return this.integral();
      case "id":
        return this.identifier(tok.v);
      case "op":
        if (tok.v === "(") {
          const first = this.comparison();
          if (this.isOp(",")) {
            const items = [first];
            while (this.isOp(",")) {
              this.next();
              items.push(this.comparison());
            }
            this.expect(")");
            return { type: "tuple", items };
          }
          this.expect(")");
          return first;
        }
        if (tok.v === "[") {
          const inner = this.comparison();
          this.expect("]");
          return inner;
        }
        if (tok.v === "|") {
          this.abs++;
          const inner = this.additive();
          this.abs--;
          this.expect("|");
          return { type: "call", name: "abs", args: [inner], prime: 0 };
        }
        if (tok.v === "{") return this.piecewise();
        throw new ExprError(`Unexpected "${tok.v}"`);
      default:
        throw new ExprError(tok.t === "end" ? "The expression ends too soon" : `Unexpected "${describe(tok)}"`);
    }
  }

  private identifier(raw: string): Node {
    if (raw in CONSTANTS && !this.isOp("_")) return { type: "num", value: CONSTANTS[raw] };
    // A built-in function takes no subscript (log's is its base).
    if (BUILTIN_FUNCTIONS.has(raw) && !(raw === "gamma" && !this.isOp("("))) return this.application(raw, this.primes());
    const name = this.subscriptName(raw);
    const prime = this.primes();
    if (this.functions.has(name)) return this.application(name, prime);
    if (prime) throw new ExprError(`${name}' needs ${name} to be a function`);
    return { type: "var", name };
  }

  private primes(): number {
    let prime = 0;
    while (this.isOp("'")) {
      this.next();
      prime++;
    }
    return prime;
  }

  /** f(x, y), \sin x, \sin^2 x, \sin^{-1} x, \log_2 x. */
  private application(name: string, prime: number): Node {
    let exponent: Node | null = null;
    let base: Node | null = null;
    if (name === "log" && this.isOp("_")) {
      this.next();
      base = this.group();
    }
    if (this.isOp("^")) {
      this.next();
      exponent = this.isOp("{") ? this.group() : this.isOp("-") ? (this.next(), { type: "neg" as const, arg: this.postfix(this.primary()) }) : this.postfix(this.primary());
    }
    let args: Node[];
    if (this.isOp("(")) {
      this.next();
      args = [this.comparison()];
      while (this.isOp(",")) {
        this.next();
        args.push(this.comparison());
      }
      this.expect(")");
    } else {
      // Without parentheses the argument runs over the factors that follow: \sin 2x = sin(2x).
      if (!this.startsFactor()) throw new ExprError(`${name} needs an argument`);
      let arg = this.power();
      while (this.startsFactor() && !this.startsFunction() && !this.atDifferential()) arg = { type: "bin", op: "*", left: arg, right: this.power() };
      args = [arg];
    }
    if (base) args.push(base);
    const inverse = exponent?.type === "neg" && exponent.arg.type === "num" && exponent.arg.value === 1;
    if (inverse && TRIG_INVERSE[name]) return { type: "call", name: TRIG_INVERSE[name], args, prime };
    const call: Node = { type: "call", name, args, prime };
    return exponent ? { type: "bin", op: "^", left: call, right: exponent } : call;
  }

  private startsFunction(): boolean {
    const tok = this.peek();
    return tok.t === "id" && (BUILTIN_FUNCTIONS.has(tok.v) || this.functions.has(tok.v));
  }

  /** \sum_{n=1}^{N} body, where the body is the term that follows. */
  private aggregate(kind: "sum" | "prod"): Node {
    this.expect("_");
    const braced = this.isOp("{");
    if (braced) this.next();
    const index = this.next();
    if (index.t !== "id") throw new ExprError(`\\${kind} needs an index, as in _{n=1}`);
    this.expect("=");
    const from = this.additive();
    if (braced) this.expect("}");
    this.expect("^");
    const to = this.group();
    const body = this.multiplicative();
    return { type: "agg", kind, index: index.v, from, to, body };
  }

  /** \int_a^b f(t)\,dt. */
  private integral(): Node {
    this.expect("_");
    const from = this.group();
    this.expect("^");
    const to = this.group();
    // Find the differential ahead so the integrand stops there.
    let variable: string | null = null;
    for (let k = this.i; k < this.tokens.length - 1; k++) {
      const a = this.tokens[k];
      const b = this.tokens[k + 1];
      if (a.t === "id" && a.v === "d" && b.t === "id") {
        variable = b.v;
        break;
      }
    }
    if (!variable) throw new ExprError("An integral needs its variable, as in dt");
    const outer = this.differential;
    this.differential = variable;
    const body = this.additive();
    this.differential = outer;
    this.next();
    this.next();
    return { type: "int", variable, from, to, body };
  }

  /** {cond: value, cond: value, otherwise} or a bare condition {x > 0}. */
  private piecewise(): Node {
    const cases: { cond: Node; value: Node | null }[] = [];
    let otherwise: Node | null = null;
    for (;;) {
      const part = this.comparison();
      if (this.isOp(":")) {
        this.next();
        cases.push({ cond: part, value: this.comparison() });
      } else if (part.type === "cmp") cases.push({ cond: part, value: null });
      else if (!cases.length && this.isOp("}")) {
        // Plain LaTeX grouping, e.g. a stray {2x}.
        this.next();
        return part;
      } else otherwise = part;
      if (this.isOp(",")) {
        this.next();
        continue;
      }
      this.expect("}");
      return { type: "piece", cases, otherwise };
    }
  }
}

const TRIG_INVERSE: Record<string, string> = { sin: "asin", cos: "acos", tan: "atan", sinh: "asinh", cosh: "acosh", tanh: "atanh" };

function describe(tok: Token): string {
  if (tok.t === "num") return String(tok.v);
  if (tok.t === "id" || tok.t === "op") return tok.v;
  return tok.t === "end" ? "end" : `\\${tok.t}`;
}

/** Parses one expression or equation. `functions` names the user's own functions, f(x) = …. */
export function parse(input: string, functions: Set<string> = new Set()): Node {
  if (!input.trim()) throw new ExprError("Empty expression");
  return new Parser(tokenize(input), functions).parse();
}

// ---------------------------------------------------------------------------
// Analysis

/** The variables an expression depends on, excluding those bound by sums and integrals. */
export function freeVariables(node: Node, bound: Set<string> = new Set(), out: Set<string> = new Set()): Set<string> {
  switch (node.type) {
    case "num":
      break;
    case "var":
      if (!bound.has(node.name)) out.add(node.name);
      break;
    case "neg":
    case "fact":
      freeVariables(node.arg, bound, out);
      break;
    case "bin":
      freeVariables(node.left, bound, out);
      freeVariables(node.right, bound, out);
      break;
    case "call":
    case "tuple":
      for (const a of node.type === "call" ? node.args : node.items) freeVariables(a, bound, out);
      break;
    case "cmp":
      for (const a of node.items) freeVariables(a, bound, out);
      break;
    case "piece":
      for (const c of node.cases) {
        freeVariables(c.cond, bound, out);
        if (c.value) freeVariables(c.value, bound, out);
      }
      if (node.otherwise) freeVariables(node.otherwise, bound, out);
      break;
    case "agg":
    case "int": {
      const name = node.type === "agg" ? node.index : node.variable;
      freeVariables(node.from, bound, out);
      freeVariables(node.to, bound, out);
      freeVariables(node.body, new Set([...bound, name]), out);
      break;
    }
    case "deriv":
      freeVariables(node.body, bound, out);
      out.add(node.variable);
      break;
  }
  return out;
}

/** The user functions an expression calls. */
export function calledFunctions(node: Node, out: Set<string> = new Set()): Set<string> {
  const visit = (n: Node) => {
    if (n.type === "call") {
      if (!BUILTIN_FUNCTIONS.has(n.name)) out.add(n.name);
      n.args.forEach(visit);
    } else if (n.type === "neg" || n.type === "fact") visit(n.arg);
    else if (n.type === "bin") {
      visit(n.left);
      visit(n.right);
    } else if (n.type === "tuple" || n.type === "cmp") n.items.forEach(visit);
    else if (n.type === "piece") {
      n.cases.forEach((c) => {
        visit(c.cond);
        if (c.value) visit(c.value);
      });
      if (n.otherwise) visit(n.otherwise);
    } else if (n.type === "agg" || n.type === "int") {
      visit(n.from);
      visit(n.to);
      visit(n.body);
    } else if (n.type === "deriv") visit(n.body);
  };
  visit(node);
  return out;
}

// ---------------------------------------------------------------------------
// Evaluation

export type Scope = Record<string, number>;
export type Compiled = (scope: Scope) => number;

export interface UserFunction {
  params: string[];
  body: Compiled;
}

export type Functions = Map<string, UserFunction>;

function gamma(z: number): number {
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61503916999185, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  const x = z - 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return Math.sqrt(2 * Math.PI) * Math.pow(t, x + 0.5) * Math.exp(-t) * a;
}

function factorial(n: number): number {
  if (Number.isInteger(n) && n >= 0 && n <= 170) {
    let out = 1;
    for (let k = 2; k <= n; k++) out *= k;
    return out;
  }
  return gamma(n + 1);
}

function gcd(a: number, b: number): number {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) [a, b] = [b, a % b];
  return a;
}

function erf(x: number): number {
  // Abramowitz and Stegun 7.1.26.
  const s = Math.sign(x);
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

const BUILTINS: Record<string, (...args: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  sec: (x) => 1 / Math.cos(x),
  csc: (x) => 1 / Math.sin(x),
  cot: (x) => 1 / Math.tan(x),
  asin: Math.asin,
  arcsin: Math.asin,
  acos: Math.acos,
  arccos: Math.acos,
  atan: (y, x) => (x === undefined ? Math.atan(y) : Math.atan2(y, x)),
  arctan: (y, x) => (x === undefined ? Math.atan(y) : Math.atan2(y, x)),
  arcsec: (x) => Math.acos(1 / x),
  arccsc: (x) => Math.asin(1 / x),
  arccot: (x) => Math.atan(1 / x),
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  sech: (x) => 1 / Math.cosh(x),
  csch: (x) => 1 / Math.sinh(x),
  coth: (x) => 1 / Math.tanh(x),
  asinh: Math.asinh,
  arcsinh: Math.asinh,
  acosh: Math.acosh,
  arccosh: Math.acosh,
  atanh: Math.atanh,
  arctanh: Math.atanh,
  exp: Math.exp,
  ln: Math.log,
  log: (x, base) => (base === undefined ? Math.log10(x) : Math.log(x) / Math.log(base)),
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  nthroot: (x, n) => (x < 0 && Math.round(n) % 2 === 1 ? -Math.pow(-x, 1 / n) : Math.pow(x, 1 / n)),
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
  sgn: Math.sign,
  min: (...xs) => Math.min(...xs),
  max: (...xs) => Math.max(...xs),
  mod: (a, b) => ((a % b) + b) % b,
  gcd: (...xs) => xs.reduce(gcd),
  lcm: (...xs) => xs.reduce((a, b) => Math.abs(Math.round(a) * Math.round(b)) / gcd(a, b)),
  nCr: (n, k) => (k < 0 || k > n ? 0 : factorial(n) / (factorial(k) * factorial(n - k))),
  binom: (n, k) => (k < 0 || k > n ? 0 : factorial(n) / (factorial(k) * factorial(n - k))),
  nPr: (n, k) => (k < 0 || k > n ? 0 : factorial(n) / factorial(n - k)),
  Gamma: gamma,
  gamma,
  erf,
};

const truthy = (v: number) => v !== 0 && !Number.isNaN(v);

function compare(op: Cmp, a: number, b: number): boolean {
  switch (op) {
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    case "=":
      return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    case "!=":
      return a !== b;
  }
}

const MAX_DEPTH = 64;
let depth = 0;

/**
 * Compiles an expression to a function of its variables. Equations and inequalities evaluate
 * to 1 or 0; a condition that fails, and a piecewise with no matching case, give NaN.
 */
export function compile(node: Node, functions: Functions = new Map()): Compiled {
  const c = (n: Node) => compile(n, functions);
  switch (node.type) {
    case "num": {
      const v = node.value;
      return () => v;
    }
    case "var": {
      const name = node.name;
      return (s) => {
        const v = s[name];
        return v === undefined ? NaN : v;
      };
    }
    case "neg": {
      const a = c(node.arg);
      return (s) => -a(s);
    }
    case "fact": {
      const a = c(node.arg);
      return (s) => factorial(a(s));
    }
    case "bin": {
      const a = c(node.left);
      const b = c(node.right);
      switch (node.op) {
        case "+":
          return (s) => a(s) + b(s);
        case "-":
          return (s) => a(s) - b(s);
        case "*":
          return (s) => a(s) * b(s);
        case "/":
          return (s) => a(s) / b(s);
        case "mod":
          return (s) => {
            const m = b(s);
            return ((a(s) % m) + m) % m;
          };
        case "^":
          return (s) => {
            const base = a(s);
            const exp = b(s);
            // Odd roots of negatives, as in x^{1/3}, are real.
            if (base < 0 && !Number.isInteger(exp)) {
              const inv = 1 / exp;
              if (Number.isInteger(Math.round(inv * 1e9) / 1e9) && Math.round(inv) % 2 !== 0) return -Math.pow(-base, exp);
            }
            return Math.pow(base, exp);
          };
      }
      break;
    }
    case "call": {
      const args = node.args.map(c);
      const builtin = BUILTINS[node.name];
      const user = functions.get(node.name);
      const call = (s: Scope, values: number[]) => {
        if (builtin) return builtin(...values);
        const fn = functions.get(node.name);
        if (!fn) return NaN;
        if (++depth > MAX_DEPTH) {
          depth--;
          return NaN;
        }
        // The function's parameters shadow the caller's variables without copying them.
        const inner: Scope = Object.create(s);
        fn.params.forEach((p, k) => (inner[p] = values[k]));
        const out = fn.body(inner);
        depth--;
        return out;
      };
      if (!builtin && !user) {
        const name = node.name;
        return () => {
          throw new ExprError(`${name} isn't defined`);
        };
      }
      if (node.prime === 0) {
        if (args.length === 1) {
          const [a] = args;
          if (builtin) return (s) => builtin(a(s));
          return (s) => call(s, [a(s)]);
        }
        return (s) => call(s, args.map((a) => a(s)));
      }
      // Derivatives by central differences in the first argument.
      const order = node.prime;
      return (s) => {
        const values = args.map((a) => a(s));
        const x = values[0];
        const h = (order === 1 ? 1e-5 : 1e-3) * Math.max(1, Math.abs(x));
        const at = (dx: number) => call(s, [x + dx, ...values.slice(1)]);
        if (order === 1) return (at(h) - at(-h)) / (2 * h);
        if (order === 2) return (at(h) - 2 * at(0) + at(-h)) / (h * h);
        return (at(2 * h) - 2 * at(h) + 2 * at(-h) - at(-2 * h)) / (2 * h * h * h);
      };
    }
    case "tuple":
      throw new ExprError("A point isn't a number");
    case "cmp": {
      const items = node.items.map(c);
      const ops = node.ops;
      return (s) => {
        let prev = items[0](s);
        for (let k = 0; k < ops.length; k++) {
          const next = items[k + 1](s);
          if (!compare(ops[k], prev, next)) return 0;
          prev = next;
        }
        return 1;
      };
    }
    case "piece": {
      const cases = node.cases.map((k) => ({ cond: c(k.cond), value: k.value ? c(k.value) : null }));
      const otherwise = node.otherwise ? c(node.otherwise) : null;
      return (s) => {
        for (const k of cases) if (truthy(k.cond(s))) return k.value ? k.value(s) : 1;
        return otherwise ? otherwise(s) : NaN;
      };
    }
    case "agg": {
      const from = c(node.from);
      const to = c(node.to);
      const body = c(node.body);
      const { index, kind } = node;
      return (s) => {
        const a = Math.ceil(from(s) - 1e-9);
        const b = Math.floor(to(s) + 1e-9);
        if (!Number.isFinite(a) || !Number.isFinite(b) || b - a > 100000) return NaN;
        const inner: Scope = Object.create(s);
        let acc = kind === "sum" ? 0 : 1;
        for (let k = a; k <= b; k++) {
          inner[index] = k;
          acc = kind === "sum" ? acc + body(inner) : acc * body(inner);
        }
        return acc;
      };
    }
    case "int": {
      const from = c(node.from);
      const to = c(node.to);
      const body = c(node.body);
      const v = node.variable;
      return (s) => {
        const a = from(s);
        const b = to(s);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
        // Composite Simpson's rule.
        const n = 128;
        const h = (b - a) / n;
        const inner: Scope = Object.create(s);
        let acc = 0;
        for (let k = 0; k <= n; k++) {
          inner[v] = a + k * h;
          const w = k === 0 || k === n ? 1 : k % 2 ? 4 : 2;
          acc += w * body(inner);
        }
        return (acc * h) / 3;
      };
    }
    case "deriv": {
      const body = c(node.body);
      const v = node.variable;
      return (s) => {
        const x = s[v] ?? 0;
        const h = 1e-5 * Math.max(1, Math.abs(x));
        const inner: Scope = Object.create(s);
        inner[v] = x + h;
        const up = body(inner);
        inner[v] = x - h;
        return (up - body(inner)) / (2 * h);
      };
    }
  }
  throw new ExprError("Can't evaluate this");
}
