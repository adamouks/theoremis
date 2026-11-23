// Pictures of graphs for print and export. Each is drawn afresh from the graph's code, on paper
// colours and at the size it will have on the page, never taken from the graph on screen: that
// one may not be drawn at all (a 3D graph loads its renderer only when it's shown), may be turned
// or zoomed, and is sized for the window rather than the page.

import type { Scope } from "../../lib/graph/expr";
import { squareWindow } from "../../lib/graph/plot2d";
import { evaluateScope, parseGraph, type Dim, type GraphSpec, type Item } from "../../lib/graph/spec";
import { drawPlane, itemColor, PAPER } from "./Graph2D";

/** The width pictures are drawn at, in CSS pixels: the printed column, 170 mm. */
export const PAPER_WIDTH = 640;

/** A drawn item, for the key under a picture: its colour and its label, or its expression. */
export interface LegendEntry {
  color: string;
  label: string | null;
  latex: string;
  dashed: boolean;
}

export interface GraphPicture {
  /** A PNG data URL. */
  src: string;
  /** Its size on the page, in CSS pixels; the image itself has twice the resolution. */
  width: number;
  height: number;
  legend: LegendEntry[];
  /** The sliders' values the picture was drawn with, typeset, e.g. "a = 0.6". */
  values: string[];
}

/** Identifies a graph by its code, the same however the code reaches the printer. */
export const graphKey = (dim: Dim, code: string) => `${dim}:${code.trim()}`;

const DRAWN = new Set(["explicit", "implicit", "region", "polar", "parametric", "points", "surface", "implicit3", "surface3"]);

function sliderValues(spec: GraphSpec): Record<string, number> {
  return Object.fromEntries(spec.items.flatMap((i) => (i.kind === "slider" ? [[i.name, i.value]] : [])));
}

function legendOf(spec: GraphSpec, dim: Dim): LegendEntry[] {
  return spec.items
    .filter((item) => DRAWN.has(item.kind) && !item.style.hidden)
    .map((item: Item) => {
      // Surfaces keep their own colour under the light; curves and points take the paper shade.
      const own = itemColor(spec, item);
      const color = dim === 3 && item.kind !== "parametric" && item.kind !== "points" ? own : PAPER.color(own);
      return { color, label: item.style.label, latex: item.latex, dashed: item.style.dashed };
    });
}

function picture2d(spec: GraphSpec, scope: Scope, width: number, height: number): string | null {
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawPlane(ctx, spec, scope, squareWindow(spec.view.x, spec.view.y, width, height), PAPER);
  return canvas.toDataURL("image/png");
}

/**
 * A graph's picture for the page, or null when it can't be drawn (its code doesn't parse, or a
 * 3D graph finds no WebGL). Fonts should be loaded first, as the numbers are drawn into it.
 */
export async function graphPicture(code: string, dim: Dim, width = PAPER_WIDTH): Promise<GraphPicture | null> {
  try {
    const spec = parseGraph(code, dim);
    const sliders = sliderValues(spec);
    const scope = evaluateScope(spec, sliders);
    // Heights are written for the document's column on screen, about 560 pixels wide.
    const height = Math.min(560, Math.round(((spec.view.height ?? (dim === 3 ? 380 : 330)) * width) / 560));
    const src = dim === 2 ? picture2d(spec, scope, width, height) : (await import("./picture3d")).picture3d(spec, scope, width, height);
    if (!src) return null;
    return {
      src,
      width,
      height,
      legend: legendOf(spec, dim),
      values: Object.entries(sliders).map(([name, value]) => `${name} = ${Number(value.toPrecision(4))}`),
    };
  } catch {
    return null;
  }
}
