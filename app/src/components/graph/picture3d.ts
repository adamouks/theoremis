// A 3D graph drawn once for paper: the same scene as on screen (scene3d), on white, from the
// usual angle but framed to fill the picture, with the axes' names and numbers drawn into it.
// Loaded only when a 3D graph is printed or exported, as it brings three.js with it.

import * as THREE from "three";
import type { Scope } from "../../lib/graph/expr";
import type { GraphSpec, Item } from "../../lib/graph/spec";
import { itemColor, PAPER } from "./Graph2D";
import { addLights, buildContent, buildFrame, disposeGroup, HOME, type LabelKind, type Theme3D } from "./scene3d";

const PAPER_3D: Theme3D = {
  edges: 0x4a4d5c,
  edgeOpacity: 0.6,
  gridCenter: 0x9a9daa,
  grid: 0xcfd1d8,
  gridOpacity: 0.9,
  axis: 0x2a2c35,
  line: PAPER.color,
};

const FONTS: Record<LabelKind, string> = {
  axis: "italic 15px 'Literata Variable', 'Literata', Georgia, serif",
  tick: "11.5px 'Geist Variable', 'Geist', system-ui, sans-serif",
  point: "12px 'Geist Variable', 'Geist', system-ui, sans-serif",
};

/** How much of the picture the box and its numbers may fill, from the middle out. */
const FILL = 0.9;

/** Places the camera along the usual direction, as close as lets every point fit the frame. */
function frame(camera: THREE.PerspectiveCamera, points: THREE.Vector3[]) {
  const direction = HOME.clone().normalize();
  let distance = HOME.length();
  for (let i = 0; i < 8; i++) {
    camera.position.copy(direction).multiplyScalar(distance);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    let extent = 0;
    for (const p of points) {
      const v = p.clone().project(camera);
      extent = Math.max(extent, Math.abs(v.x), Math.abs(v.y));
    }
    if (!Number.isFinite(extent) || extent <= 0) break;
    distance *= extent / FILL;
  }
}

/** The picture as a PNG data URL, `width` × `height` CSS pixels at twice the resolution, or null. */
export function picture3d(spec: GraphSpec, scope: Scope, width: number, height: number, scale = 2): string | null {
  const canvas = document.createElement("canvas");
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  } catch {
    return null;
  }
  const scene = new THREE.Scene();
  const box = new THREE.Group();
  const content = new THREE.Group();
  try {
    renderer.setPixelRatio(scale);
    renderer.setSize(width, height, false);
    renderer.setClearColor(0xffffff, 1);
    renderer.localClippingEnabled = true;
    addLights(scene);
    scene.add(box, content);

    const labels: THREE.Object3D[] = [];
    const makeLabel = (text: string, at: [number, number, number], kind: LabelKind) => {
      const mark = new THREE.Object3D();
      mark.position.set(...at);
      mark.userData = { text, kind };
      labels.push(mark);
      return mark;
    };
    const colorOf = (item: Item) => itemColor(spec, item);
    buildFrame(box, spec, PAPER_3D, makeLabel);
    buildContent(content, spec, scope, colorOf, PAPER_3D, { width, height }, makeLabel);
    scene.updateMatrixWorld(true);

    const camera = new THREE.PerspectiveCamera(32, width / height, 0.01, 100);
    camera.up.set(0, 0, 1);
    const corners = [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => new THREE.Vector3(x, y, z))));
    frame(camera, [...corners, ...labels.map((l) => l.getWorldPosition(new THREE.Vector3()))]);
    renderer.render(scene, camera);

    // The labels are text on the page, as on screen, so they're drawn over the scene.
    const out = document.createElement("canvas");
    out.width = width * scale;
    out.height = height * scale;
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(canvas, 0, 0, out.width, out.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const mark of labels) {
      const v = mark.getWorldPosition(new THREE.Vector3()).project(camera);
      if (v.z > 1) continue;
      const kind = mark.userData.kind as LabelKind;
      ctx.font = FONTS[kind];
      ctx.fillStyle = kind === "tick" ? "rgba(40,40,52,0.85)" : "rgba(20,20,28,0.95)";
      ctx.fillText(String(mark.userData.text), ((v.x + 1) / 2) * width, ((1 - v.y) / 2) * height);
    }
    return out.toDataURL("image/png");
  } catch {
    return null;
  } finally {
    disposeGroup(box);
    disposeGroup(content);
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
