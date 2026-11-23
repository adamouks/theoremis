// Finding the figures on a PDF page from what its content stream draws: raster images, and
// clusters of vector paths (plots, diagrams, commutative diagrams), with their labels and
// captions. Coordinates are page points with the origin at the top left.

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Mark extends Box {
  kind: "path" | "image";
}

export interface TextItem extends Box {
  text: string;
}

export interface FigureRegion extends Box {
  kind: "raster" | "vector" | "mixed";
  /** The "Figure 3: …" line beside the region, if there is one. */
  caption: string | null;
}

const width = (b: Box) => b.x1 - b.x0;
const height = (b: Box) => b.y1 - b.y0;
const area = (b: Box) => Math.max(0, width(b)) * Math.max(0, height(b));

function intersects(a: Box, b: Box, margin = 0): boolean {
  return a.x0 - margin <= b.x1 && b.x0 - margin <= a.x1 && a.y0 - margin <= b.y1 && b.y0 - margin <= a.y1;
}

function union(a: Box, b: Box): Box {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

function contains(outer: Box, inner: Box, margin = 0): boolean {
  return (
    inner.x0 >= outer.x0 - margin &&
    inner.y0 >= outer.y0 - margin &&
    inner.x1 <= outer.x1 + margin &&
    inner.y1 <= outer.y1 + margin
  );
}

/** Groups boxes that touch (within `margin`), using a grid so large figures stay fast. */
function cluster<T extends Box>(boxes: T[], margin: number): T[][] {
  const parent = boxes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const cell = 32;
  const grid = new Map<string, number[]>();
  boxes.forEach((b, i) => {
    for (let gx = Math.floor((b.x0 - margin) / cell); gx <= Math.floor((b.x1 + margin) / cell); gx++) {
      for (let gy = Math.floor((b.y0 - margin) / cell); gy <= Math.floor((b.y1 + margin) / cell); gy++) {
        const key = `${gx},${gy}`;
        const members = grid.get(key);
        if (members) {
          for (const j of members) {
            if (find(i) !== find(j) && intersects(b, boxes[j], margin)) parent[find(i)] = find(j);
          }
          members.push(i);
        } else grid.set(key, [i]);
      }
    }
  });
  const groups = new Map<number, T[]>();
  boxes.forEach((b, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), b]);
  });
  return [...groups.values()];
}

const bounds = (boxes: Box[]): Box => boxes.reduce(union);

const CAPTION = /^\s*(fig(?:ure|\.)?|table|diagram|plot)\s*[\dIVX]+[.:)]?/i;

/**
 * Text that stands alone, like a diagram's nodes or a plot's tick values: short, with no
 * neighbour on its line. Words of a paragraph always have neighbours.
 */
const words = (t: TextItem) => t.text.trim().split(/\s+/).length;

function isolated(item: TextItem, text: TextItem[]): boolean {
  if (width(item) > 80 || height(item) > 20 || words(item) > 4 || CAPTION.test(item.text)) return false;
  return !text.some((other) => {
    if (other === item) return false;
    const overlap = Math.min(item.y1, other.y1) - Math.max(item.y0, other.y0);
    if (overlap < 0.5 * Math.min(height(item), height(other))) return false;
    const gap = Math.max(other.x0 - item.x1, item.x0 - other.x1);
    return gap < 10;
  });
}

type Member = Box & { kind: "path" | "image" | "text" };

/**
 * The figures on a page of `pageWidth` × `pageHeight` points.
 *
 * Drawn paths, images and stand-alone labels that touch are grouped. A group is a figure if it
 * holds an image or a real drawing: one made only of horizontal rules is an equation's fraction
 * bars or a table's rules, and one full of long text lines is a framed theorem.
 */
export function findFigures(marks: Mark[], text: TextItem[], pageWidth: number, pageHeight: number): FigureRegion[] {
  const pageArea = pageWidth * pageHeight;
  const page: Box = { x0: 0, y0: 0, x1: pageWidth, y1: pageHeight };
  const onPage = marks
    .map((m) => ({ ...m, x0: Math.max(0, m.x0), y0: Math.max(0, m.y0), x1: Math.min(pageWidth, m.x1), y1: Math.min(pageHeight, m.y1) }))
    .filter((m) => width(m) >= 0 && height(m) >= 0 && intersects(m, page));

  const images = onPage.filter((m) => m.kind === "image" && width(m) >= 18 && height(m) >= 18 && area(m) < 0.85 * pageArea);
  const paths = onPage.filter(
    (m) => m.kind === "path" && !(width(m) > 0.9 * pageWidth && height(m) > 0.9 * pageHeight),
  );
  const isRule = (m: Box) => Math.min(width(m), height(m)) < 1.5;
  const isHorizontalRule = (m: Box) => isRule(m) && width(m) >= height(m);
  const labels = text.filter((t) => isolated(t, text));

  const members: Member[] = [...images, ...paths, ...labels.map((t) => ({ ...t, kind: "text" as const }))];
  let regions: (Box & { kind: FigureRegion["kind"] })[] = [];
  for (const group of cluster(members, 8)) {
    const drawn = group.filter((m) => m.kind !== "text");
    if (drawn.length === 0) continue;
    const box = bounds(group);
    const hasImage = drawn.some((m) => m.kind === "image");
    const drawing = drawn.filter((m) => m.kind === "path" && !isHorizontalRule(m));
    // A lone rectangle is a frame or a background, so a drawing needs a few real shapes.
    if (!hasImage && (width(box) < 36 || height(box) < 24 || drawing.length < 3)) continue;
    // Long lines of text inside mean a framed theorem or a shaded box, not a picture.
    const longLines = text.filter((t) => contains(box, t, 2) && width(t) > 0.55 * width(box)).length;
    if (longLines >= 3 && !hasImage) continue;
    const pathCount = drawn.length - drawn.filter((m) => m.kind === "image").length;
    regions.push({ ...box, kind: hasImage ? (pathCount > 2 ? "mixed" : "raster") : "vector" });
  }

  // Axes and tick marks are rules; let them extend the figure they run alongside.
  const rules = paths.filter(isRule);
  regions = regions.map((r) => {
    let box: Box = r;
    for (let pass = 0; pass < 3; pass++) {
      const before = area(box);
      for (const rule of rules) if (belongsTo(rule, box)) box = union(box, rule);
      if (area(box) === before) break;
    }
    return { ...r, ...box };
  });

  // Labels and tick values sit just around and inside the drawing.
  regions = regions.map((r) => {
    let box: Box = r;
    for (const t of text) {
      const short = width(t) <= Math.max(0.6 * width(r), 60) && height(t) <= 16 && words(t) <= 5;
      if (short && intersects(r, t, 10) && !CAPTION.test(t.text)) box = union(box, t);
    }
    return { ...r, ...box };
  });

  // Regions that now overlap are one figure.
  const merged = cluster(regions, 2).map((group) => ({
    ...bounds(group),
    kind: group.every((r) => r.kind === group[0].kind) ? group[0].kind : ("mixed" as const),
  }));

  return merged
    .map((r) => {
      const padded = {
        x0: Math.max(0, r.x0 - 4),
        y0: Math.max(0, r.y0 - 4),
        x1: Math.min(pageWidth, r.x1 + 4),
        y1: Math.min(pageHeight, r.y1 + 4),
      };
      return { ...padded, kind: r.kind, caption: captionFor(padded, text) };
    })
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

/** A rule near a figure that spans much of it, as axes do, rather than a stray line of text. */
function belongsTo(rule: Box, box: Box): boolean {
  if (!intersects(rule, box, 24)) return false;
  const horizontal = width(rule) >= height(rule);
  const [ruleFrom, ruleTo, boxFrom, boxTo] = horizontal
    ? [rule.x0, rule.x1, box.x0, box.x1]
    : [rule.y0, rule.y1, box.y0, box.y1];
  const length = ruleTo - ruleFrom;
  const extent = boxTo - boxFrom;
  const overlap = Math.min(ruleTo, boxTo) - Math.max(ruleFrom, boxFrom);
  // Short rules (ticks) only need to touch; long ones must lie along the figure, not past it.
  if (length < 12) return intersects(rule, box, 6);
  return overlap >= 0.5 * Math.min(length, extent) && length <= 1.4 * extent + 40;
}

/** The closest "Figure n…" line within a few lines below the region, or else above it. */
function captionFor(region: Box, text: TextItem[]): string | null {
  const horizontal = (t: TextItem) => t.x1 > region.x0 - 20 && t.x0 < region.x1 + 20;
  const candidates = text.filter((t) => CAPTION.test(t.text) && horizontal(t));
  const below = candidates
    .filter((t) => t.y0 >= region.y1 - 4 && t.y0 - region.y1 < 48)
    .sort((a, b) => a.y0 - b.y0)[0];
  const above = candidates
    .filter((t) => t.y1 <= region.y0 + 4 && region.y0 - t.y1 < 36)
    .sort((a, b) => b.y1 - a.y1)[0];
  const line = below ?? above;
  return line ? line.text.trim() : null;
}
