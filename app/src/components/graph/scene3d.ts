// A 3D graph's scene: the box with its axes, grid and numbers, and what the expressions draw in
// it. Built the same way for the interactive graph (Graph3D) and for its picture on paper
// (picture3d), which differ only in colours and in how labels are shown.

import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import type { Scope } from "../../lib/graph/expr";
import { formatTick, niceStep } from "../../lib/graph/plot2d";
import { curve3, implicitMesh, parametricMesh, surfaceMesh, type Box3, type Mesh, type Vec3 } from "../../lib/graph/plot3d";
import type { GraphSpec, Item } from "../../lib/graph/spec";

/** Where the camera starts, looking at the middle of the box. */
export const HOME = new THREE.Vector3(3.3, -3.9, 2.7);

export interface Theme3D {
  edges: number;
  edgeOpacity: number;
  gridCenter: number;
  grid: number;
  gridOpacity: number;
  axis: number;
  /** An item's colour for curves and points, as on the plane. */
  line: (color: string) => string;
}

export const SCREEN_3D: Theme3D = {
  edges: 0x6b6e80,
  edgeOpacity: 0.45,
  gridCenter: 0x5a5d6e,
  grid: 0x3a3c48,
  gridOpacity: 0.55,
  axis: 0xc8cad4,
  line: (c) => c,
};

/** What a label is: an axis name, a number on an edge, or a point's own label. */
export type LabelKind = "axis" | "tick" | "point";

/** Makes the object that shows a label at a point of the scene. */
export type MakeLabel = (text: string, at: Vec3, kind: LabelKind) => THREE.Object3D;

export function boxOf(spec: GraphSpec): Box3 {
  return { x: spec.view.x ?? [-5, 5], y: spec.view.y ?? [-5, 5], z: spec.view.z ?? [-5, 5] };
}

/** World coordinates to the scene's unit cube. */
export function toScene(box: Box3): (p: Vec3) => Vec3 {
  const c = (r: [number, number]) => (r[0] + r[1]) / 2;
  const h = (r: [number, number]) => (r[1] - r[0]) / 2;
  const [cx, cy, cz, hx, hy, hz] = [c(box.x), c(box.y), c(box.z), h(box.x), h(box.y), h(box.z)];
  const clamp = (v: number) => Math.max(-1e3, Math.min(1e3, v));
  return ([x, y, z]) => [clamp((x - cx) / hx), clamp((y - cy) / hy), clamp((z - cz) / hz)];
}

/** Empties a group, freeing what its children hold; `onRemove` sees each removed node. */
export function disposeGroup(group: THREE.Group, onRemove?: (node: THREE.Object3D) => void) {
  for (const child of [...group.children]) {
    group.remove(child);
    child.traverse((node) => {
      const mesh = node as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
      onRemove?.(node);
    });
  }
}

export function addLights(scene: THREE.Scene) {
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(2, -3, 5);
  const fill = new THREE.DirectionalLight(0xbfc8ff, 0.4);
  fill.position.set(-3, 2, -2);
  scene.add(key, fill);
}

/** The box, axes and grid, with the axes' names and numbers along three edges. */
export function buildFrame(frame: THREE.Group, spec: GraphSpec, theme: Theme3D, makeLabel: MakeLabel) {
  const box = boxOf(spec);
  const map = toScene(box);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)),
    new THREE.LineBasicMaterial({ color: theme.edges, transparent: true, opacity: theme.edgeOpacity }),
  );
  frame.add(edges);
  const origin = map([0, 0, 0]);
  const inside = (v: number) => v >= -1 && v <= 1;
  if (spec.view.grid && inside(origin[2])) {
    const grid = new THREE.GridHelper(2, 10, theme.gridCenter, theme.grid);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = origin[2];
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = theme.gridOpacity;
    frame.add(grid);
  }
  if (spec.view.axes) {
    const axis = (a: Vec3, b: Vec3) =>
      new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]), new THREE.LineBasicMaterial({ color: theme.axis }));
    const [ox, oy, oz] = origin.map((v) => Math.max(-1, Math.min(1, v)));
    frame.add(axis([-1, oy, oz], [1, oy, oz]), axis([ox, -1, oz], [ox, 1, oz]), axis([ox, oy, -1], [ox, oy, 1]));
    frame.add(makeLabel("x", [1.12, oy, oz], "axis"), makeLabel("y", [ox, 1.12, oz], "axis"), makeLabel("z", [ox, oy, 1.12], "axis"));
    // Numbers along three edges of the box that don't share a corner's label.
    const ticks = (range: [number, number], at: (t: number) => Vec3) => {
      const step = niceStep(range[1] - range[0], 4, 1);
      for (let v = Math.ceil(range[0] / step) * step; v <= range[1] + step / 1e6; v += step) {
        const t = (2 * (v - range[0])) / (range[1] - range[0]) - 1;
        if (Math.abs(Math.abs(t) - 1) < 0.08) continue;
        frame.add(makeLabel(formatTick(v, step), at(t), "tick"));
      }
    };
    ticks(box.x, (t) => [t, -1.1, -1]);
    ticks(box.y, (t) => [1.1, t, -1]);
    ticks(box.z, (t) => [-1.08, -1.08, t]);
  }
}

/**
 * What the expressions draw: surfaces, curves and points, clipped to the box. Returns the
 * curves' materials, which need the drawing size to give lines their width.
 */
export function buildContent(
  content: THREE.Group,
  spec: GraphSpec,
  scope: Scope,
  colorOf: (item: Item) => string,
  theme: Theme3D,
  size: { width: number; height: number },
  makeLabel: MakeLabel,
): LineMaterial[] {
  const lineMaterials: LineMaterial[] = [];
  const box = boxOf(spec);
  const map = toScene(box);
  const planes = [
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), 1.0001),
    new THREE.Plane(new THREE.Vector3(1, 0, 0), 1.0001),
    new THREE.Plane(new THREE.Vector3(0, -1, 0), 1.0001),
    new THREE.Plane(new THREE.Vector3(0, 1, 0), 1.0001),
    new THREE.Plane(new THREE.Vector3(0, 0, -1), 1.0001),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), 1.0001),
  ];

  const addMesh = (mesh: Mesh, item: Item) => {
    if (!mesh.positions.length) return;
    const positions = new Float32Array(mesh.positions.length);
    const colors = new Float32Array(mesh.positions.length);
    const base = new THREE.Color(colorOf(item));
    const tint = new THREE.Color();
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const [x, y, z] = map([mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]);
      positions[i] = x;
      positions[i + 1] = y;
      positions[i + 2] = z;
      // Lighter higher up, so height reads even where the light is flat.
      const t = Math.max(0, Math.min(1, (z + 1) / 2));
      tint.copy(base).multiplyScalar(0.55 + 0.55 * t);
      colors[i] = tint.r;
      colors[i + 1] = tint.g;
      colors[i + 2] = tint.b;
    }
    let geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry = mergeVertices(geometry, 1e-5);
    geometry.computeVertexNormals();
    const opacity = item.style.opacity ?? 1;
    const material = new THREE.MeshPhongMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      shininess: 40,
      specular: 0x222222,
      transparent: opacity < 1,
      opacity,
      clippingPlanes: planes,
      depthWrite: opacity >= 1,
    });
    content.add(new THREE.Mesh(geometry, material));
  };

  for (const item of spec.items) {
    if (item.style.hidden) continue;
    try {
      switch (item.kind) {
        case "surface":
          addMesh(surfaceMesh(item.fn, scope, item.axis, box), item);
          break;
        case "implicit3":
          addMesh(implicitMesh(item.fn, scope, box), item);
          break;
        case "surface3": {
          const range = (r: typeof item.u): [number, number] => {
            if (!r) return [0, 2 * Math.PI];
            const a = r[0](scope);
            const b = r[1](scope);
            return Number.isFinite(a) && Number.isFinite(b) && b > a ? [a, b] : [0, 2 * Math.PI];
          };
          addMesh(parametricMesh(item.fns, scope, range(item.u), range(item.v)), item);
          break;
        }
        case "parametric": {
          if (item.fns.length !== 3) break;
          const a = item.range?.[0](scope) ?? 0;
          const b = item.range?.[1](scope) ?? 2 * Math.PI;
          for (const path of curve3(item.fns, scope, a, b)) {
            if (path.length < 2) continue;
            const geometry = new LineGeometry();
            geometry.setPositions(path.flatMap((p) => map(p)));
            const material = new LineMaterial({ color: new THREE.Color(theme.line(colorOf(item))).getHex(), linewidth: item.style.width ?? 3, dashed: item.style.dashed });
            material.clippingPlanes = planes;
            material.resolution.set(size.width, size.height);
            lineMaterials.push(material);
            const line = new Line2(geometry, material);
            line.computeLineDistances();
            content.add(line);
          }
          break;
        }
        case "points": {
          const material = new THREE.MeshPhongMaterial({ color: theme.line(colorOf(item)), shininess: 60 });
          for (const p of item.points) {
            const world = p.map((f) => f(scope)) as Vec3;
            if (!world.every(Number.isFinite)) continue;
            const ball = new THREE.Mesh(new THREE.SphereGeometry(0.035, 20, 14), material);
            ball.position.set(...map(world));
            content.add(ball);
            if (item.style.label) content.add(makeLabel(item.style.label, [ball.position.x, ball.position.y, ball.position.z + 0.08], "point"));
          }
          break;
        }
      }
    } catch {
      // Lines that fail to evaluate are flagged in the list.
    }
  }
  return lineMaterials;
}
