import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import type { Scope } from "../../lib/graph/expr";
import type { Vec3 } from "../../lib/graph/plot3d";
import type { GraphSpec, Item } from "../../lib/graph/spec";
import type { GraphHandle } from "./Graph2D";
import { addLights, buildContent, buildFrame, disposeGroup, HOME, SCREEN_3D, type LabelKind } from "./scene3d";

interface Props {
  spec: GraphSpec;
  scope: Scope;
  height: number;
  colorOf: (item: Item) => string;
  handle?: Ref<GraphHandle>;
}

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

const LABEL_CLASS: Record<LabelKind, string> = {
  axis: "graph3d__label graph3d__label--axis",
  tick: "graph3d__label",
  point: "graph3d__label graph3d__label--point",
};

function label(text: string, position: Vec3, kind: LabelKind): CSS2DObject {
  const el = document.createElement("span");
  el.className = LABEL_CLASS[kind];
  el.textContent = text;
  const object = new CSS2DObject(el);
  object.position.set(...position);
  return object;
}

/** Labels are page elements; they leave with their objects. */
const dropLabel = (node: THREE.Object3D) => {
  if (node instanceof CSS2DObject) node.element.remove();
};

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
    addLights(scene);
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
      disposeGroup(content, dropLabel);
      disposeGroup(frame, dropLabel);
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
    disposeGroup(s.frame, dropLabel);
    buildFrame(s.frame, spec, SCREEN_3D, label);
    s.request();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxKey]);

  // What's drawn, rebuilt when the expressions or sliders change.
  useEffect(() => {
    const s = stage.current;
    if (!s) return;
    disposeGroup(s.content, dropLabel);
    s.lineMaterials = buildContent(s.content, spec, scope, colorOf, SCREEN_3D, s.size, label);
    s.request();
  }, [spec, scope, colorOf]);

  if (failed) return <div className="graph3d graph3d--failed" style={{ height }}>3D graphs need WebGL, which isn’t available here.</div>;
  return <div ref={host} className="graph3d" style={{ height }} />;
}
