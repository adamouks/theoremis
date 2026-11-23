import { describe, expect, it } from "vitest";
import { findFigures, type Mark, type TextItem } from "./figures";

const W = 612;
const H = 792;
const path = (x0: number, y0: number, x1: number, y1: number): Mark => ({ x0, y0, x1, y1, kind: "path" });
const image = (x0: number, y0: number, x1: number, y1: number): Mark => ({ x0, y0, x1, y1, kind: "image" });
const text = (x0: number, y0: number, x1: number, y1: number, value: string): TextItem => ({ x0, y0, x1, y1, text: value });

/** Lines of body text down the page, as a paper has around its figures. */
function body(from: number, to: number): TextItem[] {
  const lines: TextItem[] = [];
  for (let y = from; y < to; y += 14) lines.push(text(72, y, 540, y + 10, "Lorem ipsum dolor sit amet, consectetur adipiscing elit."));
  return lines;
}

describe("findFigures", () => {
  it("finds a plot: curves, axes, ticks and labels, with its caption", () => {
    const curve = Array.from({ length: 12 }, (_, i) => path(150 + i * 20, 300 - i * 8, 172 + i * 20, 310 - i * 8));
    const axes = [path(140, 330, 400, 330.8), path(140, 200, 140.8, 330)];
    const ticks = Array.from({ length: 5 }, (_, i) => path(160 + i * 50, 330, 160.6 + i * 50, 334));
    const labels = [text(150, 336, 162, 344, "0"), text(390, 336, 400, 344, "5"), text(120, 200, 136, 208, "y")];
    const caption = text(72, 356, 400, 366, "Figure 2: The function f on [0, 5].");
    const figures = findFigures([...curve, ...axes, ...ticks], [...body(72, 180), ...labels, caption, ...body(380, 700)], W, H);
    expect(figures).toHaveLength(1);
    const [f] = figures;
    expect(f.kind).toBe("vector");
    expect(f.caption).toBe("Figure 2: The function f on [0, 5].");
    // The box takes in the axes, the tick labels and the axis label, but not the caption.
    expect(f.x0).toBeLessThanOrEqual(120);
    expect(f.y0).toBeLessThanOrEqual(200);
    expect(f.y1).toBeGreaterThanOrEqual(344);
    expect(f.y1).toBeLessThan(356);
  });

  it("finds embedded images but not a scanned page or tiny glyph masks", () => {
    const photo = image(100, 400, 500, 650);
    const scan = image(0, 0, W, H);
    const glyphs = [image(80, 100, 86, 108), image(90, 100, 96, 108)];
    const figures = findFigures([scan, photo, ...glyphs], body(72, 380), W, H);
    expect(figures).toHaveLength(1);
    expect(figures[0].kind).toBe("raster");
    expect(figures[0].y0).toBeCloseTo(396);
  });

  it("ignores fraction bars, rules and framed theorems", () => {
    const rules = [path(200, 120, 260, 120.5), path(72, 60, 540, 60.6), path(300, 240, 340, 240.4)];
    // A framed theorem: a box around several full-width lines of text.
    const frame = [path(70, 400, 542, 402), path(70, 480, 542, 482), path(70, 400, 72, 482), path(540, 400, 542, 482)];
    const theorem = [text(80, 410, 530, 420, "Theorem 3. Every bounded monotone sequence of real numbers"), text(80, 424, 530, 434, "converges, and its limit is the supremum of its terms."), text(80, 438, 530, 448, "Moreover the convergence is monotone.")];
    expect(findFigures([...rules, ...frame], [...body(72, 380), ...theorem], W, H)).toEqual([]);
  });

  it("merges a diagram's pieces and labels into one figure", () => {
    // A commutative square: four arrows and four node labels.
    const arrows = [path(120, 120, 220, 126), path(120, 200, 220, 206), path(110, 130, 116, 196), path(226, 130, 232, 196)];
    const nodes = [text(100, 116, 112, 128, "A"), text(228, 116, 240, 128, "B"), text(100, 198, 112, 210, "C"), text(228, 198, 240, 210, "D")];
    const figures = findFigures(arrows, nodes, W, H);
    expect(figures).toHaveLength(1);
    expect(figures[0].x0).toBeLessThanOrEqual(100);
    expect(figures[0].x1).toBeGreaterThanOrEqual(240);
  });

  it("keeps separate figures apart, top to bottom", () => {
    const top = Array.from({ length: 6 }, (_, i) => path(100 + i * 30, 100, 125 + i * 30, 160));
    const bottom = [image(100, 500, 400, 650)];
    const figures = findFigures([...bottom, ...top], body(200, 480), W, H);
    expect(figures.map((f) => f.kind)).toEqual(["vector", "raster"]);
  });

  it("finds a diagram drawn with plain lines, held together by its node labels", () => {
    const cx = 230;
    const cy = 300;
    const arrows = [
      path(cx + 16, cy, cx + 142, cy + 0.5),
      path(cx + 16, cy + 70, cx + 142, cy + 70.5),
      path(cx + 5, cy + 10, cx + 5.5, cy + 58),
      path(cx + 175, cy + 10, cx + 175.5, cy + 58),
      path(cx + 137, cy - 3, cx + 142, cy + 3),
      path(cx + 137, cy + 67, cx + 142, cy + 73),
    ];
    const nodes = [
      text(cx, cy - 8, cx + 10, cy + 4, "N"),
      text(cx + 150, cy - 8, cx + 210, cy + 4, "(n-m)(n+m)"),
      text(cx, cy + 62, cx + 14, cy + 74, "d e"),
      text(cx + 150, cy + 62, cx + 180, cy + 74, "Z x Z"),
    ];
    const figures = findFigures(arrows, [...body(200, 280), ...nodes, ...body(400, 500)], W, H);
    expect(figures).toHaveLength(1);
    expect(figures[0].x0).toBeLessThanOrEqual(cx);
    expect(figures[0].x1).toBeGreaterThanOrEqual(cx + 210);
    expect(figures[0].y1).toBeLessThan(400);
  });

  it("leaves display equations alone: fraction bars with numerators and denominators", () => {
    const bars = [path(250, 300, 290, 300.5), path(310, 300, 350, 300.5)];
    const pieces = [
      text(255, 288, 285, 298, "n(n+1)"),
      text(266, 302, 274, 312, "2"),
      text(315, 288, 345, 298, "n(n-1)"),
      text(326, 302, 334, 312, "2"),
      text(520, 296, 536, 306, "(1)"),
    ];
    expect(findFigures(bars, [...body(200, 280), ...pieces, ...body(330, 400)], W, H)).toEqual([]);
  });
});
