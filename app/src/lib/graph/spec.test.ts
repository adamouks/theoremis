import { describe, expect, it } from "vitest";
import { evaluateScope, parseGraph, setOption, sliderLine, splitLine, viewLine, type Item } from "./spec";

describe("parseGraph", () => {
  const code = String.raw`y = a \sin(bx)
a = 2 [0, 5]
b = 1
c = 2a
f(x) = x^2 - c
y < f(x) ; color=#3bc9db ; opacity=0.2
x^2 + y^2 = 4 ; dashed
r = 1 + \cos\theta
(\cos t, \sin 2t) [0, \pi]
(1, 2), (3, f(1))
x = 1
x^3
% a note
view x=[-5, 5] y=[-3, 3] height=300
y = k x`;

  it("reads every kind of line", () => {
    const spec = parseGraph(code, 2);
    const kinds = spec.items.map((i) => i.kind);
    expect(kinds).toEqual(["explicit", "slider", "slider", "variable", "function", "region", "implicit", "polar", "parametric", "points", "explicit", "explicit", "note", "error"]);
    const slider = spec.items[1];
    expect(slider).toMatchObject({ kind: "slider", name: "a", value: 2, min: 0, max: 5 });
    expect(spec.items[5].style).toMatchObject({ color: "#3bc9db", opacity: 0.2 });
    expect(spec.items[6].style.dashed).toBe(true);
    expect(spec.items[10]).toMatchObject({ kind: "explicit", axis: "x" });
    expect(spec.items[13]).toMatchObject({ kind: "error", missing: ["k"] });
    expect(spec.view).toMatchObject({ x: [-5, 5], y: [-3, 3], height: 300 });
    expect(spec.viewLine).toBe(13);
  });

  it("computes variables in order and evaluates items against them", () => {
    const spec = parseGraph(code, 2);
    const scope = evaluateScope(spec, { a: 3 });
    expect(scope).toMatchObject({ a: 3, b: 1, c: 6 });
    const curve = spec.items[0];
    if (curve.kind !== "explicit") throw new Error("expected a curve");
    expect(curve.fn({ ...scope, x: Math.PI / 2 })).toBeCloseTo(3);
    const points = spec.items[9];
    if (points.kind !== "points") throw new Error("expected points");
    expect(points.points[1][1]({ ...scope })).toBe(1 - 6);
    expect(spec.items[4].latex).toBe("f\\left(x\\right)=x^{2}-c");
  });

  it("reads 3D graphs", () => {
    const spec = parseGraph(String.raw`z = x^2 - y^2
x^2 + y^2 + z^2 = 4
(\cos t, \sin t, t/4) [0, 4\pi]
(\cos u \sin v, \sin u \sin v, \cos v) [0, 2\pi, 0, \pi]
(1, 1, 1)`, 3);
    expect(spec.items.map((i) => i.kind)).toEqual(["surface", "implicit3", "parametric", "surface3", "points"]);
    const surface = spec.items[3];
    if (surface.kind !== "surface3") throw new Error("expected a surface");
    expect(surface.v![1]({})).toBeCloseTo(Math.PI);
  });

  it("reports cycles and bad lines without failing the rest", () => {
    const spec = parseGraph("a = b + 1\nb = a\ny = 2 +\ny = x", 2);
    expect(spec.items.map((i) => i.kind)).toEqual(["error", "error", "error", "explicit"]);
  });
});

describe("editing lines", () => {
  it("splits ranges and options, and rewrites sliders and options", () => {
    expect(splitLine("a = 1 [0, 3] ; color=red ; hidden")).toEqual({ expr: "a = 1", range: ["0", "3"], options: ["color=red", "hidden"], comment: "" });
    expect(splitLine("y = x\\;+1")).toEqual({ expr: "y = x\\;+1", range: null, options: [], comment: "" });
    expect(splitLine("y = 50\\% x ; dashed   % half")).toEqual({ expr: "y = 50\\% x", range: null, options: ["dashed"], comment: "% half" });
    const spec = parseGraph("a = 1 [0, 3] ; color=red", 2);
    const slider = spec.items[0];
    if (slider.kind !== "slider") throw new Error("expected a slider");
    expect(sliderLine(slider, 2.5)).toBe("a = 2.5 [0, 3] ; color=red");
    expect(setOption("y = x ; color=red", "hidden", true)).toBe("y = x ; color=red ; hidden");
    expect(setOption("y = x ; color=red ; hidden", "hidden", null)).toBe("y = x ; color=red");
    expect(setOption("y = x ; color=red", "color", "#fff")).toBe("y = x ; color=#fff");
    expect(setOption("y = x   % the diagonal", "dashed", true)).toBe("y = x ; dashed  % the diagonal");
    const commented = parseGraph("a = 1 [0, 3]  % slope\ny = a x  % a line", 2);
    expect(commented.items.map((i) => i.kind)).toEqual(["slider", "explicit"]);
    expect(sliderLine(commented.items[0] as Extract<Item, { kind: "slider" }>, 2)).toBe("a = 2 [0, 3]  % slope");
    expect(viewLine({ x: [-2, 2], y: [-1.23456, 1], z: null, height: null, grid: true, axes: true }, 2)).toBe("view x=[-2, 2] y=[-1.235, 1]");
  });
});
