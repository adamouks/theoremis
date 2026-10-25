// Pictures of graphs for print and export. A 2D graph is drawn afresh on paper colours from its
// code. A 3D graph is drawn by WebGL in its block, so it is taken from the block on screen.

import { squareWindow } from "../../lib/graph/plot2d";
import { evaluateScope, parseGraph, type Dim } from "../../lib/graph/spec";
import { drawPlane, PAPER } from "./Graph2D";

const cameras = new Map<string, () => string | null>();

const keyOf = (code: string, dim: Dim) => `${dim}:${code}`;

/** Lets a graph on screen be pictured; returns the function that withdraws it. */
export function offerPicture(code: string, dim: Dim, take: () => string | null): () => void {
  const key = keyOf(code, dim);
  cameras.set(key, take);
  return () => {
    if (cameras.get(key) === take) cameras.delete(key);
  };
}

/** A graph as a PNG data URL, `width` CSS pixels wide at twice the resolution, or null. */
export function graphPicture(code: string, dim: Dim, width = 720): string | null {
  if (dim === 3) return cameras.get(keyOf(code, 3))?.() ?? null;
  try {
    const spec = parseGraph(code, 2);
    const sliders = Object.fromEntries(spec.items.flatMap((i) => (i.kind === "slider" ? [[i.name, i.value]] : [])));
    const scope = evaluateScope(spec, sliders);
    const height = spec.view.height ?? 330;
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawPlane(ctx, spec, scope, squareWindow(spec.view.x, spec.view.y, width, height), PAPER);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}
