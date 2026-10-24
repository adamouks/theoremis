// Turning expressions into geometry for a window of the plane: adaptive sampling for curves,
// marching squares for implicit curves, and masks for inequalities. World coordinates in,
// world coordinates out; drawing is the canvas's business.

import type { Compiled, Scope } from "./expr";

export interface Window2D {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Size in CSS pixels. */
  width: number;
  height: number;
}

export type Point = [number, number];
export type Path = Point[];

const safe = (fn: Compiled, scope: Scope) => {
  try {
    const v = fn(scope);
    return typeof v === "number" ? v : NaN;
  } catch {
    return NaN;
  }
};

/**
 * y = f(x) (or x = f(y)) across the window: about two samples a pixel, refined where the curve
 * bends faster than that, and broken at gaps and asymptotes.
 */
export function sampleExplicit(fn: Compiled, scope: Scope, axis: "x" | "y", w: Window2D): Path[] {
  const [lo, hi, span, pixels] = axis === "y" ? [w.x0, w.x1, w.y1 - w.y0, w.width] : [w.y0, w.y1, w.x1 - w.x0, w.height];
  const vlo = axis === "y" ? w.y0 : w.x0;
  const vhi = axis === "y" ? w.y1 : w.x1;
  const unit = span / (axis === "y" ? w.height : w.width);
  const input = axis === "y" ? "x" : "y";
  const s: Scope = Object.create(scope);
  const f = (v: number) => {
    s[input] = v;
    return safe(fn, s);
  };
  const point = (a: number, b: number): Point => (axis === "y" ? [a, b] : [b, a]);
  const n = Math.max(64, Math.round(pixels * 2));
  const step = (hi - lo) / n;
  const paths: Path[] = [];
  let path: Path = [];
  const flush = () => {
    if (path.length > 1) paths.push(path);
    else if (path.length === 1) paths.push(path); // An isolated defined point, e.g. a removable gap's neighbour.
    path = [];
  };
  // Where a value sits relative to the window: below, inside or above.
  const side = (v: number) => (v < vlo ? -1 : v > vhi ? 1 : 0);
  /**
   * Adds the points between a and b until neighbours are within a pixel or two. Returns false
   * if a jump survives every halving: a discontinuity or an asymptote, where the path breaks.
   */
  const refine = (a: number, fa: number, b: number, fb: number, depth: number): boolean => {
    if (Math.abs(fb - fa) / unit <= 1.5) return true;
    // Both ends off the same edge of the window: nothing visible to refine.
    if (side(fa) !== 0 && side(fa) === side(fb)) return true;
    if (depth >= 14) return false;
    const m = (a + b) / 2;
    const fm = f(m);
    if (!Number.isFinite(fm)) return false;
    if (!refine(a, fa, m, fm, depth + 1)) return false;
    path.push(point(m, fm));
    return refine(m, fm, b, fb, depth + 1);
  };

  let prev = lo;
  let fprev = f(lo);
  if (Number.isFinite(fprev)) path.push(point(prev, fprev));
  for (let i = 1; i <= n; i++) {
    const v = lo + i * step;
    const fv = f(v);
    if (!Number.isFinite(fv)) {
      flush();
    } else if (!Number.isFinite(fprev)) {
      path.push(point(v, fv));
    } else if (!refine(prev, fprev, v, fv, 0)) {
      flush();
      path.push(point(v, fv));
    } else {
      path.push(point(v, fv));
    }
    prev = v;
    fprev = fv;
  }
  flush();
  return paths.filter((p) => p.length > 0);
}

/** A curve (x(t), y(t)) over a range of t, refined where consecutive samples are far apart. */
export function sampleCurve(at: (t: number) => Point, from: number, to: number, w: Window2D, samples = 1200): Path[] {
  const scaleX = w.width / (w.x1 - w.x0);
  const scaleY = w.height / (w.y1 - w.y0);
  const dist = (p: Point, q: Point) => Math.hypot((p[0] - q[0]) * scaleX, (p[1] - q[1]) * scaleY);
  const finite = (p: Point) => Number.isFinite(p[0]) && Number.isFinite(p[1]);
  const diagonal = Math.hypot(w.width, w.height);
  const paths: Path[] = [];
  let path: Path = [];
  const flush = () => {
    if (path.length) paths.push(path);
    path = [];
  };
  const refine = (a: number, pa: Point, b: number, pb: Point, depth: number) => {
    if (depth > 8 || dist(pa, pb) < 3) return true;
    const m = (a + b) / 2;
    const pm = at(m);
    if (!finite(pm)) return false;
    // A gap that doesn't shrink as it's halved is a jump, not a fast stretch of curve.
    if (depth > 5 && dist(pa, pm) > 0.8 * dist(pa, pb) && dist(pa, pb) > diagonal / 4) return false;
    if (!refine(a, pa, m, pm, depth + 1)) return false;
    path.push(pm);
    return refine(m, pm, b, pb, depth + 1);
  };
  const step = (to - from) / samples;
  let prev = from;
  let pprev = at(from);
  if (finite(pprev)) path.push(pprev);
  for (let i = 1; i <= samples; i++) {
    const t = from + i * step;
    const p = at(t);
    if (!finite(p)) flush();
    else if (!finite(pprev)) path.push(p);
    else if (!refine(prev, pprev, t, p, 0)) {
      flush();
      path.push(p);
    } else path.push(p);
    prev = t;
    pprev = p;
  }
  flush();
  return paths;
}

export function samplePolar(fn: Compiled, scope: Scope, from: number, to: number, w: Window2D): Path[] {
  const s: Scope = Object.create(scope);
  return sampleCurve(
    (theta) => {
      s.theta = theta;
      const r = safe(fn, s);
      return [r * Math.cos(theta), r * Math.sin(theta)];
    },
    from,
    to,
    w,
    Math.max(720, Math.round(((to - from) / (2 * Math.PI)) * 720)),
  );
}

export function sampleParametric(fx: Compiled, fy: Compiled, scope: Scope, from: number, to: number, w: Window2D): Path[] {
  const s: Scope = Object.create(scope);
  return sampleCurve(
    (t) => {
      s.t = t;
      return [safe(fx, s), safe(fy, s)];
    },
    from,
    to,
    w,
  );
}

/**
 * The zero set of F(x, y) as line segments: marching squares on a coarse grid, with cells
 * that change sign subdivided. Sign changes across poles, where |F| is large at the crossing,
 * are dropped.
 */
export function contour(fn: Compiled, scope: Scope, w: Window2D, cell = 8, refine = 4): [Point, Point][] {
  const s: Scope = Object.create(scope);
  const F = (x: number, y: number) => {
    s.x = x;
    s.y = y;
    return safe(fn, s);
  };
  const nx = Math.max(8, Math.ceil(w.width / cell));
  const ny = Math.max(8, Math.ceil(w.height / cell));
  const dx = (w.x1 - w.x0) / nx;
  const dy = (w.y1 - w.y0) / ny;
  const grid = new Float64Array((nx + 1) * (ny + 1));
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) grid[j * (nx + 1) + i] = F(w.x0 + i * dx, w.y0 + j * dy);
  const segments: [Point, Point][] = [];
  const at = (i: number, j: number) => grid[j * (nx + 1) + i];

  const crossing = (ax: number, ay: number, fa: number, bx: number, by: number, fb: number): Point | null => {
    if (!(fa * fb < 0) && !(fa === 0 && fb !== 0)) return null;
    const t = fa / (fa - fb);
    const px = ax + (bx - ax) * t;
    const py = ay + (by - ay) * t;
    const fp = F(px, py);
    if (!Number.isFinite(fp) || Math.abs(fp) > 0.2 * (Math.abs(fa) + Math.abs(fb))) return null;
    // A corner next to a pole is huge; the crossing it suggests lands on the other, ordinary
    // corner's value instead of near zero.
    const small = Math.min(Math.abs(fa), Math.abs(fb));
    const large = Math.max(Math.abs(fa), Math.abs(fb));
    if (large > 1e3 * small && Math.abs(fp) > 0.5 * small) return null;
    return [px, py];
  };

  const march = (x: number, y: number, sx: number, sy: number, f00: number, f10: number, f01: number, f11: number) => {
    // Corners counter-clockwise from the bottom left; edges between them.
    const e0 = crossing(x, y, f00, x + sx, y, f10);
    const e1 = crossing(x + sx, y, f10, x + sx, y + sy, f11);
    const e2 = crossing(x, y + sy, f01, x + sx, y + sy, f11);
    const e3 = crossing(x, y, f00, x, y + sy, f01);
    const points = [e0, e1, e2, e3].filter((p): p is Point => !!p);
    if (points.length === 2) segments.push([points[0], points[1]]);
    else if (points.length === 4) {
      // A saddle: the centre decides which corners connect.
      const centre = F(x + sx / 2, y + sy / 2);
      if ((centre > 0) === (f00 > 0)) {
        segments.push([e0!, e1!], [e2!, e3!]);
      } else {
        segments.push([e0!, e3!], [e1!, e2!]);
      }
    }
  };

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = [at(i, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1)];
      const finite = c.filter(Number.isFinite);
      const positive = finite.filter((v) => v > 0).length;
      const mixed = finite.length >= 2 && positive > 0 && positive < finite.length;
      const near = finite.some((v) => v === 0);
      if (!mixed && !near && finite.length === 4) {
        // Small loops can hide inside a cell whose corners agree; check its centre too.
        const centre = F(w.x0 + (i + 0.5) * dx, w.y0 + (j + 0.5) * dy);
        if (!Number.isFinite(centre) || Math.sign(centre) === Math.sign(c[0])) continue;
      } else if (finite.length < 2) continue;
      const x = w.x0 + i * dx;
      const y = w.y0 + j * dy;
      const sx = dx / refine;
      const sy = dy / refine;
      const sub = new Float64Array((refine + 1) * (refine + 1));
      for (let b = 0; b <= refine; b++) for (let a = 0; a <= refine; a++) sub[b * (refine + 1) + a] = F(x + a * sx, y + b * sy);
      for (let b = 0; b < refine; b++) {
        for (let a = 0; a < refine; a++) {
          const k = b * (refine + 1) + a;
          march(x + a * sx, y + b * sy, sx, sy, sub[k], sub[k + 1], sub[k + refine + 1], sub[k + refine + 2]);
        }
      }
    }
  }
  return segments;
}

/** Where a condition holds, on a grid of `cell`-pixel squares (row 0 at the top). */
export function regionMask(test: Compiled, scope: Scope, w: Window2D, cell = 3): { mask: Uint8Array; columns: number; rows: number } {
  const s: Scope = Object.create(scope);
  const columns = Math.ceil(w.width / cell);
  const rows = Math.ceil(w.height / cell);
  const mask = new Uint8Array(columns * rows);
  const dx = (w.x1 - w.x0) / columns;
  const dy = (w.y1 - w.y0) / rows;
  for (let j = 0; j < rows; j++) {
    s.y = w.y1 - (j + 0.5) * dy;
    for (let i = 0; i < columns; i++) {
      s.x = w.x0 + (i + 0.5) * dx;
      const v = safe(test, s);
      mask[j * columns + i] = v !== 0 && !Number.isNaN(v) ? 1 : 0;
    }
  }
  return { mask, columns, rows };
}

/** A tick spacing of 1, 2 or 5 times a power of ten, about `target` pixels apart. */
export function niceStep(span: number, pixels: number, target = 90): number {
  const raw = (span / pixels) * target;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const fraction = raw / power;
  const nice = fraction < 1.5 ? 1 : fraction < 3.5 ? 2 : fraction < 7.5 ? 5 : 10;
  return nice * power;
}

/** A tick label without floating-point noise: 0.30000000000000004 shows as 0.3. */
export function formatTick(value: number, step: number): string {
  if (Math.abs(value) < step / 1e6) return "0";
  const digits = Math.max(0, -Math.floor(Math.log10(step)) + (step / Math.pow(10, Math.floor(Math.log10(step))) === 2.5 ? 1 : 0));
  const abs = Math.abs(value);
  if (abs >= 1e6 || abs < 1e-4) return value.toExponential(1).replace("e+", "e");
  return value.toFixed(Math.min(digits, 10));
}

/** A window with the plane's units square, centred on the given ranges. */
export function squareWindow(x: [number, number] | null, y: [number, number] | null, width: number, height: number): Window2D {
  if (x && y) return { x0: x[0], x1: x[1], y0: y[0], y1: y[1], width, height };
  const aspect = height / width;
  if (y && !x) {
    const span = (y[1] - y[0]) / aspect;
    return { x0: -span / 2, x1: span / 2, y0: y[0], y1: y[1], width, height };
  }
  const [x0, x1] = x ?? [-10, 10];
  const span = (x1 - x0) * aspect;
  return { x0, x1, y0: -span / 2, y1: span / 2, width, height };
}
