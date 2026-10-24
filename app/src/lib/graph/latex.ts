// Printing expressions as LaTeX, so a graph's expression list is typeset however it was typed.

import { GREEK_NAMES } from "./names";
import type { Node } from "./expr";

const FUNCTION_COMMANDS = new Set([
  "sin", "cos", "tan", "sec", "csc", "cot", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "coth", "exp", "ln",
  "log", "max", "min", "gcd", "deg", "det", "lim", "sup", "inf",
]);

const ALIASES: Record<string, string> = { asin: "arcsin", acos: "arccos", atan: "arctan", sgn: "sign" };

export function nameLatex(name: string): string {
  const [base, sub] = name.split("_");
  const head = GREEK_NAMES.has(base) ? `\\${base}` : base.length > 1 ? `\\operatorname{${base}}` : base;
  return sub ? `${head}_{${sub}}` : head;
}

function number(value: number): string {
  if (value === Math.PI) return "\\pi";
  if (value === Math.E) return "e";
  if (value === Infinity) return "\\infty";
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(10)));
}

const PRECEDENCE: Record<string, number> = { cmp: 0, "+": 1, "-": 1, "*": 2, "/": 2, mod: 2, neg: 3, "^": 4 };

function precedence(node: Node): number {
  if (node.type === "bin") return PRECEDENCE[node.op];
  if (node.type === "neg") return PRECEDENCE.neg;
  if (node.type === "cmp") return 0;
  return 5;
}

const paren = (text: string) => `\\left(${text}\\right)`;

export function toLatex(node: Node): string {
  const wrap = (child: Node, min: number) => (precedence(child) < min ? paren(toLatex(child)) : toLatex(child));
  switch (node.type) {
    case "num":
      return number(node.value);
    case "var":
      return nameLatex(node.name);
    case "neg":
      return `-${wrap(node.arg, 3)}`;
    case "fact":
      return `${wrap(node.arg, 5)}!`;
    case "bin": {
      switch (node.op) {
        case "+":
          return `${wrap(node.left, 1)}+${wrap(node.right, 1)}`;
        case "-":
          return `${wrap(node.left, 1)}-${wrap(node.right, 2)}`;
        case "*": {
          const left = wrap(node.left, 2);
          const right = wrap(node.right, 3);
          // Two numbers side by side would read as one; keep a dot between them.
          const dot = /\d$/.test(left) && /^[\d.]/.test(right);
          return `${left}${dot ? "\\cdot " : node.right.type === "var" || node.right.type === "call" ? " " : ""}${right}`;
        }
        case "/":
          return `\\frac{${toLatex(node.left)}}{${toLatex(node.right)}}`;
        case "mod":
          return `${wrap(node.left, 2)}\\bmod ${wrap(node.right, 3)}`;
        case "^": {
          const base = node.left.type === "call" && FUNCTION_COMMANDS.has(ALIASES[node.left.name] ?? node.left.name) ? paren(toLatex(node.left)) : wrap(node.left, 5);
          return `${base}^{${toLatex(node.right)}}`;
        }
      }
      break;
    }
    case "call": {
      const name = ALIASES[node.name] ?? node.name;
      const args = node.args.map(toLatex).join(", ");
      if (name === "sqrt") return `\\sqrt{${args}}`;
      if (name === "nthroot") return `\\sqrt[${toLatex(node.args[1])}]{${toLatex(node.args[0])}}`;
      if (name === "abs") return `\\left|${args}\\right|`;
      if (name === "floor") return `\\left\\lfloor ${args}\\right\\rfloor`;
      if (name === "ceil") return `\\left\\lceil ${args}\\right\\rceil`;
      if (name === "nCr" || name === "binom") return `\\binom{${toLatex(node.args[0])}}{${toLatex(node.args[1])}}`;
      if (name === "log" && node.args.length === 2) return `\\log_{${toLatex(node.args[1])}}${paren(toLatex(node.args[0]))}`;
      const head = FUNCTION_COMMANDS.has(name) ? `\\${name}` : name === "Gamma" ? "\\Gamma" : nameLatex(name);
      return `${head}${"'".repeat(node.prime)}${paren(args)}`;
    }
    case "tuple":
      return paren(node.items.map(toLatex).join(", "));
    case "cmp": {
      const ops: Record<string, string> = { "<": "<", "<=": "\\le", ">": ">", ">=": "\\ge", "=": "=", "!=": "\\ne" };
      return node.items.map((item, i) => (i ? `${ops[node.ops[i - 1]]}${toLatex(item)}` : toLatex(item))).join("");
    }
    case "piece": {
      const cases = node.cases.map((c) => (c.value ? `${toLatex(c.cond)}:${toLatex(c.value)}` : toLatex(c.cond)));
      if (node.otherwise) cases.push(toLatex(node.otherwise));
      return `\\left\\{${cases.join(", ")}\\right\\}`;
    }
    case "agg":
      return `\\${node.kind}_{${nameLatex(node.index)}=${toLatex(node.from)}}^{${toLatex(node.to)}}${wrap(node.body, 2)}`;
    case "int":
      return `\\int_{${toLatex(node.from)}}^{${toLatex(node.to)}}${toLatex(node.body)}\\,d${nameLatex(node.variable)}`;
    case "deriv":
      return `\\frac{d}{d${nameLatex(node.variable)}}${wrap(node.body, 3)}`;
  }
  return "";
}
