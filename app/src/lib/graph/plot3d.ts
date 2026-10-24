// Geometry for 3D graphs, in world coordinates: surfaces sampled on grids, implicit surfaces by
// marching tetrahedra, curves and points. Triangles with an undefined corner are left out, so
// gaps and domain edges stay open.

import type { Compiled, Scope } from "./expr";

export type Vec3 = [number, number, number];

export interface Box3 {
  x: [number, number];
  y: [number, number];
  z: [number, number];
}

export interface Mesh {
  /** Triangle corners, three numbers per corner, three corners per triangle. */
  positions: Float32Array;
}

const safe = (fn: Compiled, scope: Scope) => {
  try {
    return fn(scope);
  } catch {
    return NaN;
  }
};

const finite = (p: Vec3) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]);

/** A grid of points over (a, b) as triangles, skipping any cell with an undefined corner. */
function gridMesh(at: (a: number, b: number) => Vec3, a: [number, number], b: [number, number], n: number, m = n): Mesh {
  const points: Vec3[] = [];
  for (let j = 0; j <= m; j++) {
    for (let i = 0; i <= n; i++) points.push(at(a[0] + ((a[1] - a[0]) * i) / n, b[0] + ((b[1] - b[0]) * j) / m));
  }
  const out: number[] = [];
  const index = (i: number, j: number) => j * (n + 1) + i;
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < n; i++) {
      const p00 = points[index(i, j)];
      const p10 = points[index(i + 1, j)];
      const p01 = points[index(i, j + 1)];
      const p11 = points[index(i + 1, j + 1)];
      if (finite(p00) && finite(p10) && finite(p11)) out.push(...p00, ...p10, ...p11);
      if (finite(p00) && finite(p11) && finite(p01)) out.push(...p00, ...p11, ...p01);
    }
  }
  return { positions: new Float32Array(out) };
}

/** z = f(x, y) (or x = f(y, z), y = f(x, z)) over the box. */
export function surfaceMesh(fn: Compiled, scope: Scope, axis: "x" | "y" | "z", box: Box3, n = 96): Mesh {
  const s: Scope = Object.create(scope);
  const [p, q] = axis === "z" ? (["x", "y"] as const) : axis === "y" ? (["x", "z"] as const) : (["y", "z"] as const);
  return gridMesh(
    (a, b) => {
      s[p] = a;
      s[q] = b;
      const v = safe(fn, s);
      if (axis === "z") return [a, b, v];
      if (axis === "y") return [a, v, b];
      return [v, a, b];
    },
    box[p],
    box[q],
    n,
  );
}

/** (x(u, v), y(u, v), z(u, v)) over ranges of u and v. */
export function parametricMesh(fns: Compiled[], scope: Scope, u: [number, number], v: [number, number], n = 96): Mesh {
  const s: Scope = Object.create(scope);
  return gridMesh(
    (a, b) => {
      s.u = a;
      s.v = b;
      return [safe(fns[0], s), safe(fns[1], s), safe(fns[2], s)];
    },
    u,
    v,
    n,
  );
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const centroid = (corners: [Vec3, number][]): Vec3 => {
  const c: Vec3 = [0, 0, 0];
  for (const [p] of corners) for (let i = 0; i < 3; i++) c[i] += p[i] / corners.length;
  return c;
};

// Each cube splits into six tetrahedra sharing its main diagonal, corner 0 to corner 6.
const CUBE: Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];
const TETRAHEDRA = [
  [0, 5, 1, 6],
  [0, 1, 2, 6],
  [0, 2, 3, 6],
  [0, 3, 7, 6],
  [0, 7, 4, 6],
  [0, 4, 5, 6],
];

/** The surface F(x, y, z) = 0 inside the box, by marching tetrahedra on an n³ grid. */
export function implicitMesh(fn: Compiled, scope: Scope, box: Box3, n = 44): Mesh {
  const s: Scope = Object.create(scope);
  const dx = (box.x[1] - box.x[0]) / n;
  const dy = (box.y[1] - box.y[0]) / n;
  const dz = (box.z[1] - box.z[0]) / n;
  const stride = n + 1;
  const values = new Float64Array(stride * stride * stride);
  for (let k = 0; k <= n; k++) {
    s.z = box.z[0] + k * dz;
    for (let j = 0; j <= n; j++) {
      s.y = box.y[0] + j * dy;
      for (let i = 0; i <= n; i++) {
        s.x = box.x[0] + i * dx;
        values[(k * stride + j) * stride + i] = safe(fn, s);
      }
    }
  }
  const out: number[] = [];
  const corner = (i: number, j: number, k: number, c: number): [Vec3, number] => {
    const [a, b, d] = CUBE[c];
    const p: Vec3 = [box.x[0] + (i + a) * dx, box.y[0] + (j + b) * dy, box.z[0] + (k + d) * dz];
    return [p, values[((k + d) * stride + (j + b)) * stride + (i + a)]];
  };
  const lerp = (p: Vec3, fp: number, q: Vec3, fq: number): Vec3 => {
    const t = fp / (fp - fq);
    return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
  };
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const corners = CUBE.map((_, c) => corner(i, j, k, c));
        if (corners.some(([, v]) => !Number.isFinite(v))) continue;
        const positive = corners.filter(([, v]) => v > 0).length;
        if (positive === 0 || positive === 8) continue;
        for (const tet of TETRAHEDRA) {
          const t = tet.map((c) => corners[c]);
          const inside = t.filter(([, v]) => v > 0);
          const outside = t.filter(([, v]) => v <= 0);
          if (inside.length === 0 || inside.length === 4) continue;
          // Every triangle faces the side where F is positive, so normals agree across cells.
          const toward = sub(centroid(inside), centroid(outside));
          const emit = (a: Vec3, b: Vec3, c: Vec3) => {
            if (dot(cross(sub(b, a), sub(c, a)), toward) < 0) out.push(...a, ...c, ...b);
            else out.push(...a, ...b, ...c);
          };
          if (inside.length === 1 || inside.length === 3) {
            const [lone, others] = inside.length === 1 ? [inside[0], outside] : [outside[0], inside];
            const tri = others.map(([p, v]) => lerp(lone[0], lone[1], p, v));
            emit(tri[0], tri[1], tri[2]);
          } else {
            const [a, b] = inside;
            const [c, d] = outside;
            const ac = lerp(a[0], a[1], c[0], c[1]);
            const ad = lerp(a[0], a[1], d[0], d[1]);
            const bc = lerp(b[0], b[1], c[0], c[1]);
            const bd = lerp(b[0], b[1], d[0], d[1]);
            emit(ac, ad, bd);
            emit(ac, bd, bc);
          }
        }
      }
    }
  }
  return { positions: new Float32Array(out) };
}

/** A curve in space, broken where it's undefined. */
export function curve3(fns: Compiled[], scope: Scope, from: number, to: number, samples = 1200): Vec3[][] {
  const s: Scope = Object.create(scope);
  const paths: Vec3[][] = [];
  let path: Vec3[] = [];
  for (let k = 0; k <= samples; k++) {
    s.t = from + ((to - from) * k) / samples;
    const p: Vec3 = [safe(fns[0], s), safe(fns[1], s), safe(fns[2], s)];
    if (finite(p)) path.push(p);
    else if (path.length) {
      paths.push(path);
      path = [];
    }
  }
  if (path.length) paths.push(path);
  return paths;
}
