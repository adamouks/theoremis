import { describe, expect, it } from "vitest";
import { compile, freeVariables, parse, type Functions } from "./expr";

const value = (src: string, scope: Record<string, number> = {}, functions: Functions = new Map(), names: string[] = []) =>
  compile(parse(src, new Set(names)), functions)(scope);

describe("parse and evaluate", () => {
  it("reads plain arithmetic with precedence and implicit multiplication", () => {
    expect(value("1 + 2 * 3")).toBe(7);
    expect(value("2^3^2")).toBe(512);
    expect(value("-x^2", { x: 3 })).toBe(-9);
    expect(value("2x + 3y", { x: 1, y: 2 })).toBe(8);
    expect(value("xy", { x: 2, y: 5 })).toBe(10);
    expect(value("2(x+1)(x-1)", { x: 3 })).toBe(16);
    expect(value("5!")).toBe(120);
    expect(value("|x - 5|", { x: 2 })).toBe(3);
    expect(value("|x||y|", { x: -2, y: 3 })).toBe(6);
    expect(value("7 mod 3")).toBe(1);
  });

  it("reads functions with and without parentheses", () => {
    expect(value("sin x", { x: Math.PI / 2 })).toBeCloseTo(1);
    expect(value("sinx", { x: Math.PI / 2 })).toBeCloseTo(1);
    expect(value("\\sin 2x", { x: Math.PI / 4 })).toBeCloseTo(1);
    expect(value("\\sin x \\cos x", { x: Math.PI / 4 })).toBeCloseTo(0.5);
    expect(value("\\sin^2 x + \\cos^2 x", { x: 0.7 })).toBeCloseTo(1);
    expect(value("\\sin^{-1}(1)")).toBeCloseTo(Math.PI / 2);
    expect(value("\\log_2 8")).toBeCloseTo(3);
    expect(value("\\ln e")).toBeCloseTo(1);
    expect(value("max(1, 5, 3)")).toBe(5);
    expect(value("\\operatorname{arctan}(1, 1)")).toBeCloseTo(Math.PI / 4);
  });

  it("reads LaTeX: fractions, roots, Greek letters, subscripts and delimiters", () => {
    expect(value("\\frac{1}{2} + \\frac{x}{4}", { x: 2 })).toBe(1);
    expect(value("\\sqrt{16} + \\sqrt[3]{-8}")).toBeCloseTo(2);
    expect(value("\\left(x+1\\right)^{2}", { x: 2 })).toBe(9);
    expect(value("2\\pi r", { r: 1 })).toBeCloseTo(2 * Math.PI);
    expect(value("a_1 + a_{12}", { a_1: 1, a_12: 2 })).toBe(3);
    expect(value("\\theta^2", { theta: 3 })).toBe(9);
    expect(value("θ + π", { theta: 1 })).toBeCloseTo(1 + Math.PI);
    expect(value("x \\cdot y \\div 2", { x: 3, y: 4 })).toBe(6);
    expect(value("\\lfloor 2.7 \\rfloor + \\lceil 2.1 \\rceil")).toBe(5);
    expect(value("\\binom{5}{2}")).toBe(10);
    expect(value("x^{1/3}", { x: -8 })).toBeCloseTo(-2);
  });

  it("evaluates piecewise expressions and restrictions", () => {
    expect(value("{x < 0: -x, x}", { x: -3 })).toBe(3);
    expect(value("{x < 0: -x, x}", { x: 4 })).toBe(4);
    expect(value("\\left\\{x<0:-x,x\\right\\}", { x: -2 })).toBe(2);
    expect(value("x^2 {x > 0}", { x: 2 })).toBe(4);
    expect(value("x^2 {x > 0}", { x: -2 })).toBeNaN();
    expect(value("{0 < x < 1: 1, 0}", { x: 0.5 })).toBe(1);
  });

  it("evaluates sums, products, integrals and derivatives", () => {
    expect(value("\\sum_{n=1}^{10} n")).toBe(55);
    expect(value("\\sum_{k=1}^{n} (2k-1)", { n: 7 })).toBe(49);
    expect(value("\\prod_{k=1}^{5} k")).toBe(120);
    expect(value("\\int_0^1 t^2 dt")).toBeCloseTo(1 / 3, 6);
    expect(value("\\int_{0}^{x} \\cos(t)\\,dt", { x: Math.PI / 2 })).toBeCloseTo(1, 6);
    expect(value("\\frac{d}{dx} x^3", { x: 2 })).toBeCloseTo(12, 4);
    const f: Functions = new Map([["f", { params: ["x"], body: compile(parse("x^3")) }]]);
    expect(value("f(2)", {}, f, ["f"])).toBe(8);
    expect(value("f'(2)", {}, f, ["f"])).toBeCloseTo(12, 4);
    expect(value("f''(2)", {}, f, ["f"])).toBeCloseTo(12, 2);
  });

  it("finds free variables and parses equations, points and errors", () => {
    expect([...freeVariables(parse("y = a x^2 + \\sum_{n=1}^{3} n x"))].sort()).toEqual(["a", "x", "y"]);
    expect(parse("x^2 + y^2 = 1").type).toBe("cmp");
    expect(parse("(\\cos t, \\sin t)").type).toBe("tuple");
    expect(() => parse("2 +")).toThrow();
    expect(() => parse("\\foo x")).toThrow(/Unknown command/);
    expect(() => compile(parse("g(2)", new Set(["g"])))({})).toThrow(/isn't defined/);
  });
});
