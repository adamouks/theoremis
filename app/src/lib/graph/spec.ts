// A graph block's code: one expression per line, read into what to draw.
//
//   y = a \sin(bx)                 a curve; a and b are sliders below
//   a = 1 [0, 3]                   a slider with its range (and optionally a step)
//   f(x) = x^2 - 2                 a function, usable on other lines and as f'(x)
//   x^2 + y^2 = 4                  an implicit curve
//   y < f(x)                       a shaded region
//   r = 1 + \cos\theta             a polar curve
//   (\cos t, \sin 2t) [0, 2\pi]    a parametric curve and the range of t
//   (1, 2), (3, 4)                 points
//   y = x^2 ; color=#e64980 ; dashed ; label=parabola ; hidden
//   view x=[-5, 5] y=[-3, 3]       the initial window (3D graphs add z=[…])
//   % a note                       a line of its own, or after an expression as in TeX
//
// Three-dimensional graphs (```graph3d) take z = f(x, y), implicit surfaces in x, y and z,
// curves (… t …) and surfaces (… u, v …) given as triples, and points.

import { ExprError, compile, freeVariables, parse, type Compiled, type Functions, type Node } from "./expr";
import { toLatex } from "./latex";

export type Dim = 2 | 3;

export interface ItemStyle {
  color: string | null;
  hidden: boolean;
  dashed: boolean;
  dotted: boolean;
  label: string | null;
  width: number | null;
  opacity: number | null;
}

interface Base {
  /** The line of code, as written. */
  line: number;
  text: string;
  /** The expression typeset, for the list. */
  latex: string;
  style: ItemStyle;
}

export type Range = [Compiled, Compiled];

export type Item = Base &
  (
    | { kind: "slider"; name: string; value: number; min: number; max: number; step: number | null }
    | { kind: "variable"; name: string; fn: Compiled }
    | { kind: "function"; name: string; params: string[] }
    | { kind: "explicit"; axis: "x" | "y"; fn: Compiled }
    | { kind: "implicit"; fn: Compiled }
    | { kind: "region"; test: Compiled; boundaries: { fn: Compiled; strict: boolean }[] }
    | { kind: "polar"; fn: Compiled; range: Range | null }
    | { kind: "parametric"; fns: Compiled[]; range: Range | null }
    | { kind: "points"; points: Compiled[][] }
    | { kind: "surface"; axis: "x" | "y" | "z"; fn: Compiled }
    | { kind: "implicit3"; fn: Compiled }
    | { kind: "surface3"; fns: Compiled[]; u: Range | null; v: Range | null }
    | { kind: "note" }
    | { kind: "error"; message: string; missing: string[] }
  );

export interface View {
  x: [number, number] | null;
  y: [number, number] | null;
  z: [number, number] | null;
  height: number | null;
  grid: boolean;
  axes: boolean;
}

export interface GraphSpec {
  dim: Dim;
  items: Item[];
  view: View;
  /** The line holding the view, if any, so changing the window can rewrite it. */
  viewLine: number | null;
  functions: Functions;
  /** Variables in the order they can be computed. */
  order: string[];
}

const COLORS = ["#ff6b6b", "#4dabf7", "#69db7c", "#b197fc", "#ffa94d", "#f783ac", "#3bc9db", "#ffd43b"];

export function paletteColor(index: number): string {
  return COLORS[index % COLORS.length];
}

const NAMED_COLORS: Record<string, string> = {
  red: "#ff6b6b",
  blue: "#4dabf7",
  green: "#69db7c",
  purple: "#b197fc",
  orange: "#ffa94d",
  pink: "#f783ac",
  cyan: "#3bc9db",
  yellow: "#ffd43b",
  white: "#f1f3f5",
  gray: "#adb5bd",
  grey: "#adb5bd",
  black: "#212529",
};

function parseStyle(options: string[]): ItemStyle {
  const style: ItemStyle = { color: null, hidden: false, dashed: false, dotted: false, label: null, width: null, opacity: null };
  for (const raw of options) {
    const [key, ...rest] = raw.split("=");
    const value = rest.join("=").trim().replace(/^"(.*)"$/, "$1");
    switch (key.trim().toLowerCase()) {
      case "color":
      case "colour":
        style.color = NAMED_COLORS[value.toLowerCase()] ?? (/^#[0-9a-f]{3,8}$/i.test(value) ? value : null);
        break;
      case "hidden":
        style.hidden = true;
        break;
      case "dashed":
        style.dashed = true;
        break;
      case "dotted":
        style.dotted = true;
        break;
      case "label":
        style.label = value || null;
        break;
      case "width":
        style.width = Number.parseFloat(value) || null;
        break;
      case "opacity":
        style.opacity = Number.isFinite(Number.parseFloat(value)) ? Number.parseFloat(value) : null;
        break;
    }
  }
  return style;
}

/** Splits `expr [range] ; option ; option` into its parts. */
export function splitLine(text: string): { expr: string; range: string[] | null; options: string[]; comment: string } {
  // A % that isn't \% starts a comment, as in TeX.
  const at = text.search(/(?<!\\)%/);
  const comment = at >= 0 ? text.slice(at).trim() : "";
  const code = at >= 0 ? text.slice(0, at) : text;
  // An unescaped ; separates options; \; is LaTeX spacing.
  const [head, ...options] = code.split(/(?<!\\);/).map((s) => s.trim());
  let expr = head ?? "";
  let range: string[] | null = null;
  const tail = /\[([^[\]]+)\]\s*$/.exec(expr);
  // A trailing [a, b] is a range; brackets inside the expression are grouping.
  if (tail && tail.index > 0 && !/[([{,]\s*$/.test(expr.slice(0, tail.index))) {
    const parts = splitTopLevel(tail[1]);
    if (parts.length >= 2 && parts.length <= 4) {
      range = parts;
      expr = expr.slice(0, tail.index).trim();
    }
  }
  return { expr, range, options: options.filter(Boolean), comment };
}

const withComment = (line: string, comment: string) => (comment ? `${line}  ${comment}` : line);

/** Splits at commas outside brackets. */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += c;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

const DEFINITION = /^\s*(\\?[a-zA-Z]+(?:_\{?\w+\}?)?)\s*(?:\\left)?\(\s*((?:\\?[a-zA-Z]+)(?:\s*,\s*\\?[a-zA-Z]+)*)\s*(?:\\right)?\)\s*=/;
const PLOT_VARIABLES: Record<Dim, Set<string>> = {
  2: new Set(["x", "y", "t", "theta", "r"]),
  3: new Set(["x", "y", "z", "t", "u", "v"]),
};

const cleanName = (name: string) => name.replace(/^\\/, "").replace(/_\{(\w+)\}/, "_$1");

function parseView(text: string): View | null {
  const match = /^\s*view\b(.*)$/i.exec(text);
  if (!match) return null;
  const view: View = { x: null, y: null, z: null, height: null, grid: true, axes: true };
  const number = (s: string) => {
    try {
      return compile(parse(s))({});
    } catch {
      return NaN;
    }
  };
  for (const m of match[1].matchAll(/([xyz])\s*=\s*\[([^\]]+)\]/g)) {
    const [a, b] = splitTopLevel(m[2]).map(number);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) view[m[1] as "x" | "y" | "z"] = [a, b];
  }
  const height = /height\s*=\s*(\d+)/.exec(match[1]);
  if (height) view.height = Math.min(900, Math.max(160, Number(height[1])));
  if (/grid\s*=\s*off/.test(match[1])) view.grid = false;
  if (/axes\s*=\s*off/.test(match[1])) view.axes = false;
  return view;
}

/** Writes the view line for a window, keeping the other settings it had. */
export function viewLine(view: View, dim: Dim): string {
  const fmt = (v: number) => String(Number(v.toPrecision(4)));
  const parts = ["view"];
  for (const axis of dim === 3 ? (["x", "y", "z"] as const) : (["x", "y"] as const)) {
    const range = view[axis];
    if (range) parts.push(`${axis}=[${fmt(range[0])}, ${fmt(range[1])}]`);
  }
  if (view.height) parts.push(`height=${view.height}`);
  if (!view.grid) parts.push("grid=off");
  if (!view.axes) parts.push("axes=off");
  return parts.join(" ");
}

export function parseGraph(code: string, dim: Dim): GraphSpec {
  const lines = code.replace(/\r\n?/g, "\n").split("\n");
  const plot = PLOT_VARIABLES[dim];
  const functions: Functions = new Map();
  const names = new Set<string>();
  // First pass: the functions people define, so f(x) elsewhere reads as a call.
  for (const line of lines) {
    const m = DEFINITION.exec(splitLine(line).expr);
    if (m && !plot.has(cleanName(m[1]))) names.add(cleanName(m[1]));
  }

  const items: Item[] = [];
  const variables = new Map<string, { node: Node; fn: Compiled }>();
  let view: View = { x: null, y: null, z: null, height: null, grid: true, axes: true };
  let viewIndex: number | null = null;

  lines.forEach((text, line) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const style = (options: string[]) => parseStyle(options);
    if (/^(%|\/\/|#)/.test(trimmed)) {
      items.push({ kind: "note", line, text, latex: "", style: style([]) });
      return;
    }
    const parsedView = parseView(trimmed);
    if (parsedView) {
      view = parsedView;
      viewIndex = line;
      return;
    }
    const { expr, range, options } = splitLine(trimmed);
    const base = { line, text, style: style(options) };
    try {
      const item = classify(expr, range, base, dim, names, functions, variables);
      items.push(item);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Can't read this";
      items.push({ ...base, kind: "error", latex: "", message, missing: [] });
    }
  });

  // Variables in dependency order; a variable that can't be computed is reported where it's defined.
  const order: string[] = [];
  const visiting = new Set<string>();
  const visit = (name: string): boolean => {
    if (order.includes(name)) return true;
    if (visiting.has(name)) return false;
    visiting.add(name);
    const entry = variables.get(name);
    if (entry) for (const dep of freeVariables(entry.node)) if (variables.has(dep) && !visit(dep)) return false;
    visiting.delete(name);
    order.push(name);
    return true;
  };
  for (const name of variables.keys()) {
    if (!visit(name)) {
      const index = items.findIndex((i) => (i.kind === "variable" || i.kind === "slider") && i.name === name);
      if (index >= 0) items[index] = { ...items[index], kind: "error", message: `${name} depends on itself`, missing: [] } as Item;
    }
  }

  // Anything still undefined: offer to add it as a slider.
  const known = new Set([...plot, ...variables.keys()]);
  return {
    dim,
    view,
    viewLine: viewIndex,
    functions,
    order,
    items: items.map((item) => {
      if (item.kind === "error" || item.kind === "note") return item;
      const missing = [...(usedVariables.get(item) ?? [])].filter((v) => !known.has(v));
      if (!missing.length) return item;
      return { ...item, kind: "error", message: `${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} defined`, missing } as Item;
    }),
  };
}

const usedVariables = new WeakMap<object, Set<string>>();

function compileRange(range: string[] | null, names: Set<string>, functions: Functions): Range | null {
  if (!range) return null;
  const [a, b] = range.map((r) => compile(parse(r, names), functions));
  return [a, b];
}

function classify(
  expr: string,
  range: string[] | null,
  base: { line: number; text: string; style: ItemStyle },
  dim: Dim,
  names: Set<string>,
  functions: Functions,
  variables: Map<string, { node: Node; fn: Compiled }>,
): Item {
  const plot = PLOT_VARIABLES[dim];
  const c = (node: Node) => compile(node, functions);
  const track = (item: Item, ...nodes: Node[]) => {
    const used = new Set<string>();
    for (const n of nodes) for (const v of freeVariables(n)) used.add(v);
    for (const r of range ?? []) for (const v of freeVariables(parse(r, names))) used.add(v);
    usedVariables.set(item, used);
    return item;
  };

  // Several points: (1, 2), (3, 4).
  const pieces = splitTopLevel(expr);
  if (pieces.length > 1 && pieces.every((p) => /^\s*(\\left)?\(/.test(p))) {
    const nodes = pieces.map((p) => parse(p, names));
    if (nodes.every((n) => n.type === "tuple" && n.items.length === dim)) {
      const points = nodes.map((n) => (n as Extract<Node, { type: "tuple" }>).items.map(c));
      return track({ ...base, kind: "points", latex: nodes.map(toLatex).join(", "), points }, ...nodes);
    }
  }

  const node = parse(expr, names);
  const latex = toLatex(node);
  const free = freeVariables(node);

  if (node.type === "cmp" && node.ops.length === 1 && node.ops[0] === "=") {
    const [lhs, rhs] = node.items;
    // f(x, y) = …: a function.
    const def = DEFINITION.exec(expr);
    if (def && lhs.type === "call" && names.has(lhs.name)) {
      const params = def[2].split(",").map((p) => cleanName(p.trim()));
      const entry = { params, body: (() => NaN) as Compiled };
      functions.set(lhs.name, entry);
      entry.body = c(rhs);
      const item: Item = { ...base, kind: "function", latex, name: lhs.name, params };
      const used = new Set([...freeVariables(rhs)].filter((v) => !params.includes(v) && !plot.has(v)));
      usedVariables.set(item, used);
      return item;
    }
    // a = 2: a slider; a = 2b: a variable worked out from others.
    if (lhs.type === "var" && !plot.has(lhs.name)) {
      const constant = rhs.type === "num" || (rhs.type === "neg" && rhs.arg.type === "num");
      const fn = c(rhs);
      variables.set(lhs.name, { node: rhs, fn });
      if (constant) {
        const value = fn({});
        const bounds = range?.map((r) => compile(parse(r, names), functions)({})) ?? [];
        // As in Desmos: −10 to 10, or the next power of ten that holds the value.
        const reach = Math.abs(value) <= 10 ? 10 : Math.pow(10, Math.ceil(Math.log10(Math.abs(value))));
        const min = Number.isFinite(bounds[0]) ? bounds[0] : -reach;
        const max = Number.isFinite(bounds[1]) ? bounds[1] : reach;
        const step = Number.isFinite(bounds[2]) && bounds[2] > 0 ? bounds[2] : null;
        return { ...base, kind: "slider", latex, name: lhs.name, value, min, max, step };
      }
      return track({ ...base, kind: "variable", latex, name: lhs.name, fn }, rhs);
    }
  }

  if (dim === 2) {
    const onlyIn = (allowed: string[]) => [...free].every((v) => allowed.includes(v) || !plot.has(v));
    if (node.type === "tuple") {
      if (node.items.length !== 2) throw new ExprError("A point in the plane has two coordinates");
      if (free.has("t")) return track({ ...base, kind: "parametric", latex, fns: node.items.map(c), range: compileRange(range, names, functions) }, node);
      if ([...free].some((v) => plot.has(v))) throw new ExprError("A point can't depend on x or y");
      return track({ ...base, kind: "points", latex, points: [node.items.map(c)] }, node);
    }
    if (node.type === "cmp") {
      const [lhs, rhs] = node.items;
      if (node.ops.length === 1 && node.ops[0] === "=") {
        const sides = (name: string) => lhs.type === "var" && lhs.name === name;
        const rhsFree = freeVariables(rhs);
        if (sides("y") && !rhsFree.has("y") && !rhsFree.has("theta")) return track({ ...base, kind: "explicit", axis: "y", latex, fn: c(rhs) }, rhs);
        if (sides("x") && !rhsFree.has("x") && !rhsFree.has("theta")) return track({ ...base, kind: "explicit", axis: "x", latex, fn: c(rhs) }, rhs);
        if (sides("r") && [...rhsFree].every((v) => v === "theta" || !plot.has(v))) return track({ ...base, kind: "polar", latex, fn: c(rhs), range: compileRange(range, names, functions) }, rhs);
        if (onlyIn(["x", "y"])) {
          const l = c(lhs);
          const r = c(rhs);
          return track({ ...base, kind: "implicit", latex, fn: (s) => l(s) - r(s) }, node);
        }
        throw new ExprError("Use x and y (or r and θ) to draw an equation");
      }
      if (onlyIn(["x", "y"])) {
        const items = node.items.map(c);
        const boundaries = node.ops.map((op, i) => ({ fn: ((a, b) => (s: Record<string, number>) => a(s) - b(s))(items[i], items[i + 1]), strict: op === "<" || op === ">" || op === "!=" }));
        return track({ ...base, kind: "region", latex, test: c(node), boundaries }, node);
      }
      throw new ExprError("Use x and y to draw an inequality");
    }
    // A bare expression in x is a curve, as in y = x^2.
    if (onlyIn(["x"])) return track({ ...base, kind: "explicit", axis: "y", latex: `y=${latex}`, fn: c(node) }, node);
    throw new ExprError("Write an equation, such as y = …, or a point");
  }

  // Three dimensions.
  const onlyIn = (allowed: string[]) => [...free].every((v) => allowed.includes(v) || !plot.has(v));
  if (node.type === "tuple") {
    if (node.items.length !== 3) throw new ExprError("A point in space has three coordinates");
    if (free.has("u") || free.has("v")) {
      // [u0, u1, v0, v1] gives both ranges; [a, b] gives u's.
      const u = compileRange(range?.slice(0, 2) ?? null, names, functions);
      const v = compileRange(range && range.length === 4 ? range.slice(2) : null, names, functions);
      return track({ ...base, kind: "surface3", latex, fns: node.items.map(c), u, v }, node);
    }
    if (free.has("t")) return track({ ...base, kind: "parametric", latex, fns: node.items.map(c), range: compileRange(range, names, functions) }, node);
    if ([...free].some((v) => plot.has(v))) throw new ExprError("A point can't depend on x, y or z");
    return track({ ...base, kind: "points", latex, points: [node.items.map(c)] }, node);
  }
  if (node.type === "cmp" && node.ops.length === 1 && node.ops[0] === "=") {
    const [lhs, rhs] = node.items;
    const rhsFree = freeVariables(rhs);
    for (const axis of ["z", "y", "x"] as const) {
      if (lhs.type === "var" && lhs.name === axis && !rhsFree.has(axis) && onlyIn(["x", "y", "z"])) {
        return track({ ...base, kind: "surface", axis, latex, fn: c(rhs) }, rhs);
      }
    }
    if (onlyIn(["x", "y", "z"])) {
      const l = c(lhs);
      const r = c(rhs);
      return track({ ...base, kind: "implicit3", latex, fn: (s) => l(s) - r(s) }, node);
    }
  }
  if (node.type !== "cmp" && onlyIn(["x", "y"])) return track({ ...base, kind: "surface", axis: "z", latex: `z=${latex}`, fn: c(node) }, node);
  throw new ExprError("Write z = f(x, y), an equation in x, y and z, or a point (x, y, z)");
}

/** The values of every variable, given the sliders' current positions. */
export function evaluateScope(spec: GraphSpec, sliders: Record<string, number>): Record<string, number> {
  const scope: Record<string, number> = {};
  for (const name of spec.order) {
    const item = spec.items.find((i) => (i.kind === "slider" || i.kind === "variable") && i.name === name);
    if (!item) continue;
    if (item.kind === "slider") scope[name] = sliders[name] ?? item.value;
    else if (item.kind === "variable") {
      try {
        scope[name] = item.fn(scope);
      } catch {
        scope[name] = NaN;
      }
    }
  }
  return scope;
}

/** The code with one line replaced (or removed, for null). */
export function replaceLine(code: string, line: number, text: string | null): string {
  const lines = code.split("\n");
  if (text === null) lines.splice(line, 1);
  else lines[line] = text;
  return lines.join("\n");
}

/** Rewrites a slider's line with a new value, keeping its range and options. */
export function sliderLine(item: Extract<Item, { kind: "slider" }>, value: number): string {
  const { range, options, comment } = splitLine(item.text.trim());
  const fmt = Number(value.toPrecision(6));
  return withComment([`${item.text.trim().split("=")[0].trim()} = ${fmt}${range ? ` [${range.join(", ")}]` : ""}`, ...options].join(" ; "), comment);
}

/** Sets or clears one option of a line (color=…, hidden). */
export function setOption(text: string, key: string, value: string | boolean | null): string {
  const { expr, range, options, comment } = splitLine(text.trim());
  const rest = options.filter((o) => o.split("=")[0].trim().toLowerCase() !== key);
  if (value === true) rest.push(key);
  else if (typeof value === "string") rest.push(`${key}=${value}`);
  return withComment([`${expr}${range ? ` [${range.join(", ")}]` : ""}`, ...rest].join(" ; "), comment);
}
