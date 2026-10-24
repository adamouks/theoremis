// Paragraphs from a PDF page's text runs, with figures placed where they fall, for imports
// made without a model. Assumes one column of text.

import type { Box, FigureRegion, TextItem } from "./figures";

export type LayoutItem = { kind: "text"; text: string } | { kind: "figure"; figure: FigureRegion };

interface Line extends Box {
  text: string;
}

const inside = (t: Box, f: Box) => {
  const cx = (t.x0 + t.x1) / 2;
  const cy = (t.y0 + t.y1) / 2;
  return cx >= f.x0 && cx <= f.x1 && cy >= f.y0 && cy <= f.y1;
};

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Runs on the same baseline become lines; a gap, an indent or a short last line ends a paragraph. */
export function readingOrder(items: TextItem[], figures: FigureRegion[]): LayoutItem[] {
  const runs = items
    .filter((t) => t.text.trim() && !figures.some((f) => inside(t, f)))
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lines: Line[] = [];
  for (const run of runs) {
    const line = lines.find((l) => {
      const overlap = Math.min(l.y1, run.y1) - Math.max(l.y0, run.y0);
      return overlap > 0.5 * Math.min(l.y1 - l.y0, run.y1 - run.y0);
    });
    if (line) {
      const before = run.x0 < line.x0;
      const joiner = Math.max(run.x0 - line.x1, line.x0 - run.x1) > 1.5 ? " " : "";
      line.text = before ? `${run.text}${joiner}${line.text}` : `${line.text}${joiner}${run.text}`;
      line.x0 = Math.min(line.x0, run.x0);
      line.x1 = Math.max(line.x1, run.x1);
      line.y0 = Math.min(line.y0, run.y0);
      line.y1 = Math.max(line.y1, run.y1);
    } else lines.push({ ...run });
  }
  lines.sort((a, b) => a.y0 - b.y0);

  const height = median(lines.map((l) => l.y1 - l.y0)) || 10;
  const left = median(lines.map((l) => l.x0));
  const right = median(lines.map((l) => l.x1));
  const out: LayoutItem[] = [];
  let paragraph: Line[] = [];
  const flush = () => {
    if (!paragraph.length) return;
    const text = paragraph
      .map((l) => l.text.trim())
      .reduce((acc, line) => (acc.endsWith("-") && /^[a-z]/.test(line) ? acc.slice(0, -1) + line : `${acc} ${line}`))
      .replace(/\s+/g, " ")
      .trim();
    if (text) out.push({ kind: "text", text });
    paragraph = [];
  };
  const pending = [...figures].sort((a, b) => a.y0 - b.y0);
  for (const line of lines) {
    while (pending.length && pending[0].y0 < line.y0) {
      flush();
      out.push({ kind: "figure", figure: pending.shift()! });
    }
    const previous = paragraph[paragraph.length - 1];
    if (previous) {
      const gap = line.y0 - previous.y1;
      const indented = line.x0 - left > 8;
      const shortBefore = previous.x1 < right - 0.25 * (right - left);
      if (gap > 0.9 * height || indented || shortBefore) flush();
    }
    paragraph.push(line);
  }
  flush();
  for (const figure of pending) out.push({ kind: "figure", figure });
  return out;
}
