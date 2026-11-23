import { describe, expect, it } from "vitest";
import { compile, parse } from "./expr";
import { contour, formatTick, niceStep, regionMask, sampleExplicit, samplePolar, squareWindow } from "./plot2d";

const w = squareWindow([-5, 5], null, 500, 300);
const fn = (src: string) => compile(parse(src));

describe("sampling", () => {
  it("draws a smooth curve as one path", () => {
    const paths = sampleExplicit(fn("x^2"), {}, "y", w);
    expect(paths).toHaveLength(1);
    expect(paths[0].length).toBeGreaterThan(900);
    for (const [x, y] of paths[0]) expect(y).toBeCloseTo(x * x, 6);
  });

  it("breaks at asymptotes and gaps", () => {
    // tan has asymptotes at ±π/2 and ±3π/2 inside [-5, 5].
    expect(sampleExplicit(fn("\\tan x"), {}, "y", w).length).toBe(5);
    expect(sampleExplicit(fn("1/x"), {}, "y", w).length).toBe(2);
    expect(sampleExplicit(fn("\\sqrt{x}"), {}, "y", w).length).toBe(1);
    expect(sampleExplicit(fn("\\{x>0: 1, -1\\}"), {}, "y", w).length).toBe(2);
  });

  it("closes a polar circle", () => {
    const [path] = samplePolar(fn("2"), {}, 0, 2 * Math.PI, w);
    expect(Math.hypot(...path[0])).toBeCloseTo(2);
    expect(path[path.length - 1][0]).toBeCloseTo(2);
  });

  it("finds an implicit circle and nothing at a pole", () => {
    const circle = contour(fn("x^2 + y^2 - 4"), {}, w);
    expect(circle.length).toBeGreaterThan(60);
    for (const seg of circle) for (const [x, y] of seg) expect(Math.hypot(x, y)).toBeCloseTo(2, 1);
    // 1/x - y changes sign across x = 0 without a zero there.
    const hyperbola = contour(fn("1/x - y"), {}, w);
    for (const seg of hyperbola) for (const [x, y] of seg) expect(Math.abs(1 / x - y)).toBeLessThan(0.3);
  });

  it("masks a region", () => {
    const { mask, columns, rows } = regionMask(fn("y < 0"), {}, w);
    expect(mask[0]).toBe(0);
    expect(mask[(rows - 1) * columns]).toBe(1);
  });

  it("picks tick spacings and labels", () => {
    expect(niceStep(10, 500)).toBe(2);
    expect(niceStep(0.01, 500)).toBe(0.002);
    expect(formatTick(0.30000000000000004, 0.1)).toBe("0.3");
    expect(formatTick(-2, 1)).toBe("-2");
    expect(formatTick(1e-12, 0.5)).toBe("0");
  });
});
