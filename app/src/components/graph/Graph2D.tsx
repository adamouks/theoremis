import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { Scope } from "../../lib/graph/expr";
import {
  contour,
  formatTick,
  niceStep,
  regionMask,
  sampleExplicit,
  samplePolar,
  sampleParametric,
  squareWindow,
  type Path,
  type Point,
  type Window2D,
} from "../../lib/graph/plot2d";
import { paletteColor, type GraphSpec, type Item } from "../../lib/graph/spec";

export interface GraphHandle {
  zoom: (factor: number) => void;
  reset: () => void;
  /** Turns the view continuously (3D graphs). */
  rotate?: () => void;
}

interface Props {
  spec: GraphSpec;
  scope: Scope;
  height: number;
  /** Called when the window moves away from (or back to) the code's. */
  onWindowChange?: (window: Window2D, moved: boolean) => void;
  handle?: Ref<GraphHandle>;
}

/** How the plane is coloured: dark in the app, light for print and export. */
export interface PlaneTheme {
  background: string;
  gridMinor: string;
  gridMajor: string;
  axis: string;
  label: string;
  pointLabel: string;
  /** The size of the numbers along the axes, in pixels; labels of points are a pixel larger. */
  font: number;
  /** An item's colour on this background. */
  color: (color: string) => string;
}

const DARK: PlaneTheme = {
  background: "#1a1b21",
  gridMinor: "rgba(255,255,255,0.045)",
  gridMajor: "rgba(255,255,255,0.1)",
  axis: "rgba(236,237,242,0.55)",
  label: "rgba(200,202,212,0.75)",
  pointLabel: "rgba(236,237,242,0.9)",
  font: 11,
  color: (c) => c,
};

/** The palette's colours are light, for the dark plane; on paper each gets a deeper shade. */
const ON_PAPER: Record<string, string> = {
  "#ff6b6b": "#e03131",
  "#4dabf7": "#1971c2",
  "#69db7c": "#2f9e44",
  "#b197fc": "#6741d9",
  "#ffa94d": "#e8590c",
  "#f783ac": "#c2255c",
  "#3bc9db": "#0c8599",
  "#ffd43b": "#e67700",
};

export const PAPER: PlaneTheme = {
  background: "#ffffff",
  gridMinor: "rgba(0,0,0,0.05)",
  gridMajor: "rgba(0,0,0,0.12)",
  axis: "rgba(20,20,28,0.7)",
  label: "rgba(40,40,52,0.85)",
  pointLabel: "rgba(20,20,28,0.95)",
  // On paper the picture is printed at its own size, so the numbers are set a little larger.
  font: 12,
  color: (c) => ON_PAPER[c.toLowerCase()] ?? c,
};

/** What was drawn, kept so the pointer can trace it. */
interface Drawn {
  item: Item;
  color: string;
  paths: Path[];
  points: Point[];
}

export function itemColor(spec: GraphSpec, item: Item): string {
  if (item.style.color) return item.style.color;
  const drawable = spec.items.filter((i) => !["slider", "variable", "function", "note", "error"].includes(i.kind));
  return paletteColor(Math.max(0, drawable.indexOf(item)));
}

function geometry(item: Item, scope: Scope, w: Window2D): { paths: Path[]; points: Point[]; segments?: [Point, Point][] } {
  const range = (r: [(s: Scope) => number, (s: Scope) => number] | null, fallback: [number, number]): [number, number] => {
    if (!r) return fallback;
    const a = r[0](scope);
    const b = r[1](scope);
    return Number.isFinite(a) && Number.isFinite(b) && b > a ? [a, b] : fallback;
  };
  switch (item.kind) {
    case "explicit":
      return { paths: sampleExplicit(item.fn, scope, item.axis, w), points: [] };
    case "polar": {
      const [a, b] = range(item.range, [0, 2 * Math.PI]);
      return { paths: samplePolar(item.fn, scope, a, b, w), points: [] };
    }
    case "parametric": {
      const [a, b] = range(item.range, [0, 2 * Math.PI]);
      return { paths: sampleParametric(item.fns[0], item.fns[1], scope, a, b, w), points: [] };
    }
    case "implicit":
      return { paths: [], points: [], segments: contour(item.fn, scope, w) };
    case "points":
      return {
        paths: [],
        points: item.points.map((p) => {
          try {
            return [p[0](scope), p[1](scope)] as Point;
          } catch {
            return [NaN, NaN] as Point;
          }
        }),
      };
    default:
      return { paths: [], points: [] };
  }
}

/** The plane: grid, axes, and every visible item of the spec. Drag to pan, scroll or pinch to zoom. */
export function Graph2D({ spec, scope, height, onWindowChange, handle }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [win, setWin] = useState<Window2D | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; px: number; py: number; color: string } | null>(null);
  const drawn = useRef<Drawn[]>([]);
  const home = useRef<Window2D | null>(null);
  const drag = useRef<{ x: number; y: number; win: Window2D } | null>(null);

  // The code's window, fitted to the canvas.
  const viewKey = JSON.stringify([spec.view.x, spec.view.y]);
  useEffect(() => {
    if (!width) return;
    const fresh = squareWindow(spec.view.x, spec.view.y, width, height);
    home.current = fresh;
    setWin(fresh);
    // Only when the code's window changes, not on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, width > 0, height]);

  // Keep the scale when the block's width changes.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      setWidth((old) => {
        if (old && next !== old) {
          setWin((w) => {
            if (!w) return w;
            const ppu = w.width / (w.x1 - w.x0);
            const cx = (w.x0 + w.x1) / 2;
            return { ...w, x0: cx - next / ppu / 2, x1: cx + next / ppu / 2, width: next };
          });
        }
        return next;
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const current = useRef<Window2D | null>(null);
  current.current = win;

  const setWindow = useCallback(
    (next: Window2D) => {
      current.current = next;
      setWin(next);
      const h = home.current;
      const moved = !h || Math.abs(next.x0 - h.x0) + Math.abs(next.x1 - h.x1) + Math.abs(next.y0 - h.y0) + Math.abs(next.y1 - h.y1) > 1e-9;
      onWindowChange?.(next, moved);
    },
    [onWindowChange],
  );

  const zoomAt = useCallback(
    (factor: number, px?: number, py?: number) => {
      const w = current.current;
      if (!w) return;
      const fx = px === undefined ? 0.5 : px / w.width;
      const fy = py === undefined ? 0.5 : py / w.height;
      const cx = w.x0 + fx * (w.x1 - w.x0);
      const cy = w.y1 - fy * (w.y1 - w.y0);
      setWindow({
        ...w,
        x0: cx - (cx - w.x0) * factor,
        x1: cx + (w.x1 - cx) * factor,
        y0: cy - (cy - w.y0) * factor,
        y1: cy + (w.y1 - cy) * factor,
      });
    },
    [setWindow],
  );

  useImperativeHandle(
    handle,
    () => ({
      zoom: (factor) => zoomAt(factor),
      reset: () => home.current && setWindow(home.current),
    }),
    [zoomAt, setWindow],
  );

  // Draw.
  useEffect(() => {
    const el = canvas.current;
    if (!el || !win || !width) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(width * dpr);
    el.height = Math.round(height * dpr);
    const ctx = el.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawn.current = drawPlane(ctx, spec, scope, { ...win, width, height }, DARK);
  }, [spec, scope, win, width, height]);

  // Wheel zoom needs a non-passive listener to stop the page scrolling.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(Math.exp(delta * (e.ctrlKey ? 0.01 : 0.0018)), e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const trace = (px: number, py: number) => {
    if (!win) return null;
    const x = win.x0 + (px / width) * (win.x1 - win.x0);
    const toPx = (p: Point) => [((p[0] - win.x0) / (win.x1 - win.x0)) * width, ((win.y1 - p[1]) / (win.y1 - win.y0)) * height];
    let best: { d: number; p: Point; color: string } | null = null;
    for (const d of drawn.current) {
      if (d.item.kind === "explicit" && d.item.axis === "y") {
        try {
          const y = d.item.fn({ ...scope, x });
          if (Number.isFinite(y)) {
            const [, qy] = toPx([x, y]);
            const dist = Math.abs(qy - py);
            if (!best || dist < best.d) best = { d: dist, p: [x, y], color: d.color };
          }
        } catch {
          // Not traceable here.
        }
        continue;
      }
      for (const p of [...d.points, ...d.paths.flat()]) {
        const [qx, qy] = toPx(p);
        const dist = Math.hypot(qx - px, qy - py);
        if (!best || dist < best.d) best = { d: dist, p, color: d.color };
      }
    }
    if (!best || best.d > 14) return null;
    const [qx, qy] = toPx(best.p);
    return { x: best.p[0], y: best.p[1], px: qx, py: qy, color: best.color };
  };

  // Coordinates to about a hundredth of a pixel's worth, without trailing zeros.
  const coordinate = (v: number) => {
    const step = niceStep(win ? win.x1 - win.x0 : 1, width || 1, 1);
    const digits = Math.max(0, Math.min(8, -Math.floor(Math.log10(step / 10))));
    const text = String(Number(v.toFixed(digits)));
    return text === "-0" ? "0" : text;
  };

  return (
    <div ref={host} className="graph2d" style={{ height }}>
      <canvas
        ref={canvas}
        style={{ width: "100%", height }}
        onPointerDown={(e) => {
          if (!win || e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, win };
          setHover(null);
        }}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const d = drag.current;
          if (d) {
            const dx = ((e.clientX - d.x) / width) * (d.win.x1 - d.win.x0);
            const dy = ((e.clientY - d.y) / height) * (d.win.y1 - d.win.y0);
            setWindow({ ...d.win, x0: d.win.x0 - dx, x1: d.win.x1 - dx, y0: d.win.y0 + dy, y1: d.win.y1 + dy });
            return;
          }
          setHover(trace(e.clientX - rect.left, e.clientY - rect.top));
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          zoomAt(e.altKey ? 2 : 0.5, e.clientX - rect.left, e.clientY - rect.top);
        }}
      />
      {hover && (
        <>
          <span className="graph2d__dot" style={{ left: hover.px, top: hover.py, background: hover.color }} />
          <span className="graph2d__coords" style={{ left: Math.min(hover.px + 10, width - 120), top: Math.max(hover.py - 30, 4) }}>
            ({coordinate(hover.x)}, {coordinate(hover.y)})
          </span>
        </>
      )}
    </div>
  );
}

/** Draws the plane into `ctx`: grid, axes, and every visible item, in the window `w`. */
export function drawPlane(ctx: CanvasRenderingContext2D, spec: GraphSpec, scope: Scope, w: Window2D, theme: PlaneTheme): Drawn[] {
  const { width, height } = w;
  const sx = (x: number) => ((x - w.x0) / (w.x1 - w.x0)) * width;
  const sy = (y: number) => ((w.y1 - y) / (w.y1 - w.y0)) * height;

  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);

  // Grid and axes.
  const stepX = niceStep(w.x1 - w.x0, width);
  const stepY = niceStep(w.y1 - w.y0, height);
  if (spec.view.grid) {
    ctx.lineWidth = 1;
    for (const [step, color] of [
      [stepX / 5, theme.gridMinor],
      [stepX, theme.gridMajor],
    ] as const) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let x = Math.ceil(w.x0 / step) * step; x <= w.x1; x += step) {
        const px = Math.round(sx(x)) + 0.5;
        ctx.moveTo(px, 0);
        ctx.lineTo(px, height);
      }
      const sY = step === stepX ? stepY : stepY / 5;
      for (let y = Math.ceil(w.y0 / sY) * sY; y <= w.y1; y += sY) {
        const py = Math.round(sy(y)) + 0.5;
        ctx.moveTo(0, py);
        ctx.lineTo(width, py);
      }
      ctx.stroke();
    }
  }
  if (spec.view.axes) {
    ctx.strokeStyle = theme.axis;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    const ax = Math.round(sx(0)) + 0.5;
    const ay = Math.round(sy(0)) + 0.5;
    if (ax >= 0 && ax <= width) {
      ctx.moveTo(ax, 0);
      ctx.lineTo(ax, height);
    }
    if (ay >= 0 && ay <= height) {
      ctx.moveTo(0, ay);
      ctx.lineTo(width, ay);
    }
    ctx.stroke();
    // Tick labels along the axes, or along the edge when an axis is off screen.
    ctx.fillStyle = theme.label;
    ctx.font = `${theme.font}px 'Geist Variable', 'Geist', system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const labelY = Math.min(height - 14, Math.max(3, ay + 4));
    for (let x = Math.ceil(w.x0 / stepX) * stepX; x <= w.x1; x += stepX) {
      // Skip zero (marked once, at the origin) and labels the edges would cut off.
      if (Math.abs(x) < stepX / 1e6 || sx(x) < 14 || sx(x) > width - 14) continue;
      ctx.fillText(formatTick(x, stepX), sx(x), labelY);
    }
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const labelX = Math.min(width - 4, Math.max(28, ax - 5));
    for (let y = Math.ceil(w.y0 / stepY) * stepY; y <= w.y1; y += stepY) {
      if (Math.abs(y) < stepY / 1e6 || sy(y) < 8 || sy(y) > height - 8) continue;
      ctx.fillText(formatTick(y, stepY), labelX, sy(y));
    }
    if (ax >= 0 && ax <= width && ay >= 0 && ay <= height) {
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.fillText("0", ax - 5, ay + 4);
    }
  }

  // Items, in the order they're written.
  const record: Drawn[] = [];
  for (const item of spec.items) {
    if (item.style.hidden) continue;
    const color = theme.color(itemColor(spec, item));
    const lineWidth = item.style.width ?? 2.5;
    const dash = item.style.dashed ? [7, 5] : item.style.dotted ? [1.5, 4.5] : [];
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    try {
      if (item.kind === "region") {
        const cell = 3;
        const { mask, columns, rows } = regionMask(item.test, scope, w, cell);
        const image = new ImageData(columns, rows);
        const [r, g, b] = hexToRgb(color);
        const alpha = Math.round(255 * (item.style.opacity ?? 0.22));
        for (let k = 0; k < mask.length; k++) {
          if (!mask[k]) continue;
          image.data[k * 4] = r;
          image.data[k * 4 + 1] = g;
          image.data[k * 4 + 2] = b;
          image.data[k * 4 + 3] = alpha;
        }
        const off = document.createElement("canvas");
        off.width = columns;
        off.height = rows;
        off.getContext("2d")!.putImageData(image, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(off, 0, 0, columns * cell, rows * cell);
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        for (const boundary of item.boundaries) {
          ctx.setLineDash(boundary.strict ? [7, 5] : dash);
          strokeSegments(ctx, contour(boundary.fn, scope, w), sx, sy);
        }
        ctx.setLineDash([]);
        record.push({ item, color, paths: [], points: [] });
        continue;
      }
      const g = geometry(item, scope, w);
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.setLineDash(dash);
      for (const path of g.paths) {
        if (path.length === 1) {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(sx(path[0][0]), sy(path[0][1]), lineWidth, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        ctx.beginPath();
        path.forEach(([x, y], k) => (k ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
        ctx.stroke();
      }
      if (g.segments) strokeSegments(ctx, g.segments, sx, sy);
      ctx.setLineDash([]);
      for (const [x, y] of g.points) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(sx(x), sy(y), 4.5, 0, Math.PI * 2);
        ctx.fill();
        if (item.style.label) {
          ctx.fillStyle = theme.pointLabel;
          ctx.font = `${theme.font + 1}px 'Geist Variable', system-ui, sans-serif`;
          ctx.textAlign = "left";
          ctx.textBaseline = "bottom";
          ctx.fillText(item.style.label, sx(x) + 7, sy(y) - 4);
        }
      }
      const paths = g.segments ? g.segments.map((s) => [s[0], s[1]]) : g.paths;
      record.push({ item, color, paths, points: g.points });
    } catch {
      // A line that fails to evaluate is shown as an error in the list; skip drawing it.
    }
  }
  return record;
}

function strokeSegments(ctx: CanvasRenderingContext2D, segments: [Point, Point][], sx: (x: number) => number, sy: (y: number) => number) {
  ctx.beginPath();
  for (const [a, b] of segments) {
    ctx.moveTo(sx(a[0]), sy(a[1]));
    ctx.lineTo(sx(b[0]), sy(b[1]));
  }
  ctx.stroke();
}

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = Number.parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
