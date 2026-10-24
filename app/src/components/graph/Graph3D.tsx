import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import type { Scope } from "../../lib/graph/expr";
import { formatTick, niceStep } from "../../lib/graph/plot2d";
import { curve3, implicitMesh, parametricMesh, surfaceMesh, type Box3, type Mesh, type Vec3 } from "../../lib/graph/plot3d";
import type { GraphSpec, Item } from "../../lib/graph/spec";
import type { GraphHandle } from "./Graph2D";

interface Props {
  spec: GraphSpec;
  scope: Scope;
  height: number;
  colorOf: (item: Item) => string;
  handle?: Ref<GraphHandle>;
}

const HOME = new THREE.Vector3(3.3, -3.9, 2.7);

interface Stage {
  renderer: THREE.WebGLRenderer;
  labels: CSS2DRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  content: THREE.Group;
  frame: THREE.Group;
  lineMaterials: LineMaterial[];
  request: () => void;
  size: { width: number; height: number };
}

function boxOf(spec: GraphSpec): Box3 {
  return { x: spec.view.x ?? [-5, 5], y: spec.view.y ?? [-5, 5], z: spec.view.z ?? [-5, 5] };
}

/** World coordinates to the scene's unit cube. */
function toScene(box: Box3): (p: Vec3) => Vec3 {
  const c = (r: [number, number]) => (r[0] + r[1]) / 2;
  const h = (r: [number, number]) => (r[1] - r[0]) / 2;
  const [cx, cy, cz, hx, hy, hz] = [c(box.x), c(box.y), c(box.z), h(box.x), h(box.y), h(box.z)];
  const clamp = (v: number) => Math.max(-1e3, Math.min(1e3, v));
  return ([x, y, z]) => [clamp((x - cx) / hx), clamp((y - cy) / hy), clamp((z - cz) / hz)];
}

function disposeGroup(group: THREE.Group) {
  for (const child of [...group.children]) {
    group.remove(child);
    child.traverse((node) => {
      const mesh = node as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
      if (node instanceof CSS2DObject) node.element.remove();
    });
  }
}

function label(text: string, position: Vec3, className = "graph3d__label"): CSS2DObject {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  const object = new CSS2DObject(el);
  object.position.set(...position);
  return object;
}

/** Space: surfaces, curves and points in a box, turned by dragging, zoomed by scrolling. */
export default function Graph3D({ spec, scope, height, colorOf, handle }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<Stage | null>(null);
  const [failed, setFailed] = useState(false);
  const [rotating, setRotating] = useState(false);

  // The renderer, camera and controls, made once.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setClearColor(0x1a1b21);
    renderer.localClippingEnabled = true;
    el.appendChild(renderer.domElement);
    const labels = new CSS2DRenderer();
    labels.domElement.className = "graph3d__labels";
    el.appendChild(labels.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100);
    camera.up.set(0, 0, 1);
    camera.position.copy(HOME);
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(2, -3, 5);
    const fill = new THREE.DirectionalLight(0xbfc8ff, 0.4);
    fill.position.set(-3, 2, -2);
    scene.add(key, fill);
    const content = new THREE.Group();
    const frame = new THREE.Group();
    scene.add(content, frame);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.minDistance = 1.2;
    controls.maxDistance = 20;
    controls.autoRotateSpeed = 1.4;

    let frameId = 0;
    const draw = () => {
      frameId = 0;
      const moving = controls.update();
      renderer.render(scene, camera);
      labels.render(scene, camera);
      if (moving || controls.autoRotate) frameId = requestAnimationFrame(draw);
    };
    const request = () => {
      if (!frameId) frameId = requestAnimationFrame(draw);
    };
    controls.addEventListener("change", request);

    const s: Stage = { renderer, labels, scene, camera, controls, content, frame, lineMaterials: [], request, size: { width: 1, height: 1 } };
    stage.current = s;
    const resize = () => {
      const width = Math.max(1, el.clientWidth);
      const h = Math.max(1, el.clientHeight);
      s.size = { width, height: h };
      renderer.setSize(width, h, false);
      renderer.domElement.style.width = `${width}px`;
      renderer.domElement.style.height = `${h}px`;
      labels.setSize(width, h);
      camera.aspect = width / h;
      camera.updateProjectionMatrix();
      for (const m of s.lineMaterials) m.resolution.set(width, h);
      request();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frameId);
      controls.dispose();
      disposeGroup(content);
      disposeGroup(frame);
      renderer.dispose();
      renderer.domElement.remove();
      labels.domElement.remove();
      stage.current = null;
    };
  }, []);

  useImperativeHandle(
    handle,
    () => ({
      zoom: (factor) => {
        const s = stage.current;
        if (!s) return;
        s.camera.position.sub(s.controls.target).multiplyScalar(factor).add(s.controls.target);
        s.controls.update();
        s.request();
      },
      reset: () => {
        const s = stage.current;
        if (!s) return;
        s.controls.target.set(0, 0, 0);
        s.camera.position.copy(HOME);
        s.controls.update();
        s.request();
      },
      rotate: () => setRotating((r) => !r),
    }),
    [],
  );

  useEffect(() => {
    const s = stage.current;
    if (!s) return;
    s.controls.autoRotate = rotating;
    s.request();
  }, [rotating]);

  // The box, axes and grid, rebuilt when the window changes.
  const boxKey = JSON.stringify([spec.view.x, spec.view.y, spec.view.z, spec.view.grid, spec.view.axes]);
  useEffect(() => {
    const s = stage.current;
    if (!s) return;
    disposeGroup(s.frame);
    const box = boxOf(spec);
    const map = toScene(box);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)),
      new THREE.LineBasicMaterial({ color: 0x6b6e80, transparent: true, opacity: 0.45 }),
    );
    s.frame.add(edges);
    const origin = map([0, 0, 0]);
    const inside = (v: number) => v >= -1 && v <= 1;
    if (spec.view.grid && inside(origin[2])) {
      const grid = new THREE.GridHelper(2, 10, 0x5a5d6e, 0x3a3c48);
      grid.rotation.x = Math.PI / 2;
      grid.position.z = origin[2];
      (grid.material as THREE.Material).transparent = true;
      (grid.material as THREE.Material).opacity = 0.55;
      s.frame.add(grid);
    }
    if (spec.view.axes) {
      const axis = (a: Vec3, b: Vec3) =>
        new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]), new THREE.LineBasicMaterial({ color: 0xc8cad4 }));
      const [ox, oy, oz] = origin.map((v) => Math.max(-1, Math.min(1, v)));
      s.frame.add(axis([-1, oy, oz], [1, oy, oz]), axis([ox, -1, oz], [ox, 1, oz]), axis([ox, oy, -1], [ox, oy, 1]));
      s.frame.add(
        label("x", [1.12, oy, oz], "graph3d__label graph3d__label--axis"),
        label("y", [ox, 1.12, oz], "graph3d__label graph3d__label--axis"),
        label("z", [ox, oy, 1.12], "graph3d__label graph3d__label--axis"),
      );
      // Numbers along three edges of the box that don't share a corner's label.
      const ticks = (range: [number, number], at: (t: number) => Vec3) => {
        const step = niceStep(range[1] - range[0], 4, 1);
        for (let v = Math.ceil(range[0] / step) * step; v <= range[1] + step / 1e6; v += step) {
          const t = (2 * (v - range[0])) / (range[1] - range[0]) - 1;
          if (Math.abs(Math.abs(t) - 1) < 0.08) continue;
          s.frame.add(label(formatTick(v, step), at(t)));
        }
      };
      ticks(box.x, (t) => [t, -1.1, -1]);
      ticks(box.y, (t) => [1.1, t, -1]);
      ticks(box.z, (t) => [-1.08, -1.08, t]);
    }
    s.request();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxKey]);

  // What's drawn, rebuilt when the expressions or sliders change.
  useEffect(() => {
    const s = stage.current;
    if (!s) return;
    disposeGroup(s.content);
    s.lineMaterials = [];
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
      s.content.add(new THREE.Mesh(geometry, material));
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
              const material = new LineMaterial({ color: new THREE.Color(colorOf(item)).getHex(), linewidth: item.style.width ?? 3, dashed: item.style.dashed });
              material.clippingPlanes = planes;
              material.resolution.set(s.size.width, s.size.height);
              s.lineMaterials.push(material);
              const line = new Line2(geometry, material);
              line.computeLineDistances();
              s.content.add(line);
            }
            break;
          }
          case "points": {
            const material = new THREE.MeshPhongMaterial({ color: colorOf(item), shininess: 60 });
            for (const p of item.points) {
              const world = p.map((f) => f(scope)) as Vec3;
              if (!world.every(Number.isFinite)) continue;
              const ball = new THREE.Mesh(new THREE.SphereGeometry(0.035, 20, 14), material);
              ball.position.set(...map(world));
              s.content.add(ball);
              if (item.style.label) s.content.add(label(item.style.label, [ball.position.x, ball.position.y, ball.position.z + 0.08], "graph3d__label graph3d__label--point"));
            }
            break;
          }
        }
      } catch {
        // Lines that fail to evaluate are flagged in the list.
      }
    }
    s.request();
  }, [spec, scope, colorOf]);

  if (failed) return <div className="graph3d graph3d--failed" style={{ height }}>3D graphs need WebGL, which isn’t available here.</div>;
  return <div ref={host} className="graph3d" style={{ height }} />;
}
