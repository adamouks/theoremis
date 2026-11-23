import katex from "katex";
import { memo, useEffect, useRef, useState } from "react";
import type { GraphSpec, Item } from "../../lib/graph/spec";
import { paletteColor } from "../../lib/graph/spec";

interface Props {
  spec: GraphSpec;
  editable: boolean;
  values: Record<string, number>;
  colorOf: (item: Item) => string;
  onSlide: (name: string, value: number) => void;
  onCommitSlider: (item: Extract<Item, { kind: "slider" }>, value: number) => void;
  onReplaceLine: (line: number, text: string | null) => void;
  onSetOption: (line: number, key: string, value: string | boolean | null) => void;
  onAppend: (text: string) => void;
}

const Tex = memo(function Tex({ latex }: { latex: string }) {
  const html = katex.renderToString(latex, { throwOnError: false, strict: "ignore", output: "html" });
  return <span className="graph-row__tex" dangerouslySetInnerHTML={{ __html: html }} />;
});

const SWATCHES = [0, 1, 2, 3, 4, 5, 6, 7].map(paletteColor);

function formatValue(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return String(Number(v.toPrecision(4)));
}

/** A graph's expressions, typeset as in Desmos, with sliders for its variables. */
export function ExpressionList({ spec, editable, values, colorOf, onSlide, onCommitSlider, onReplaceLine, onSetOption, onAppend }: Props) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState("");
  const [palette, setPalette] = useState<number | null>(null);

  const startEdit = (item: Item) => {
    if (!editable) return;
    setEditing(item.line);
    setDraft(item.text.trim());
  };

  const commit = () => {
    if (editing === null) return;
    const text = draft.trim();
    onReplaceLine(editing, text || null);
    setEditing(null);
  };

  return (
    <div className="graph-list">
      {spec.items.map((item) => (
        <div key={`${item.line}:${item.text}`} className={`graph-row graph-row--${item.kind}${item.style.hidden ? " is-hidden" : ""}`}>
          {item.kind === "note" ? (
            <span className="graph-row__note">{item.text.trim().replace(/^(%|\/\/|#)\s*/, "")}</span>
          ) : editing === item.line ? (
            <input
              className="graph-row__input"
              autoFocus
              spellCheck={false}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditing(null);
                }
              }}
            />
          ) : (
            <>
              {item.kind === "slider" || item.kind === "variable" || item.kind === "function" || item.kind === "error" ? (
                <span className="graph-row__marker" aria-hidden="true" />
              ) : (
                <span className="graph-row__swatch-anchor">
                  <button
                    type="button"
                    className="graph-row__swatch"
                    style={{ background: item.style.hidden ? "transparent" : colorOf(item), borderColor: colorOf(item) }}
                    title={item.style.hidden ? "Show" : editable ? "Hide, or choose a color" : "Hide"}
                    onClick={() => (editable ? setPalette((p) => (p === item.line ? null : item.line)) : onSetOption(item.line, "hidden", !item.style.hidden || null))}
                  />
                  {palette === item.line && (
                    <span className="graph-palette" onMouseLeave={() => setPalette(null)}>
                      {SWATCHES.map((c) => (
                        <button
                          key={c}
                          type="button"
                          className="graph-palette__color"
                          style={{ background: c }}
                          aria-label={`Color ${c}`}
                          onClick={() => {
                            onSetOption(item.line, "color", c);
                            setPalette(null);
                          }}
                        />
                      ))}
                      <button
                        type="button"
                        className="graph-palette__action"
                        onClick={() => {
                          onSetOption(item.line, "hidden", item.style.hidden ? null : true);
                          setPalette(null);
                        }}
                      >
                        {item.style.hidden ? "Show" : "Hide"}
                      </button>
                      <button
                        type="button"
                        className="graph-palette__action"
                        onClick={() => {
                          onSetOption(item.line, "dashed", item.style.dashed ? null : true);
                          setPalette(null);
                        }}
                      >
                        {item.style.dashed ? "Solid" : "Dashed"}
                      </button>
                    </span>
                  )}
                </span>
              )}
              <div className="graph-row__main" onClick={() => startEdit(item)} title={editable ? "Click to edit" : undefined}>
                {item.kind === "error" ? (
                  <>
                    <code className="graph-row__raw">{item.text.trim()}</code>
                    <span className="graph-row__error">
                      {item.message}
                      {editable &&
                        item.missing.map((name) => (
                          <button
                            key={name}
                            type="button"
                            className="graph-row__fix"
                            onClick={(e) => {
                              e.stopPropagation();
                              onAppend(`${name} = 1`);
                            }}
                          >
                            Add a slider for {name}
                          </button>
                        ))}
                    </span>
                  </>
                ) : (
                  <Tex latex={item.kind === "slider" ? `${item.latex.split("=")[0]}=${formatValue(values[item.name] ?? item.value)}` : item.latex} />
                )}
                {item.kind === "variable" && <span className="graph-row__value">= {formatValue(values[item.name])}</span>}
              </div>
              {item.kind === "slider" && <Slider item={item} value={values[item.name] ?? item.value} editable={editable} onSlide={onSlide} onCommit={onCommitSlider} />}
              {editable && (
                <button type="button" className="graph-row__delete" aria-label="Remove" title="Remove" onClick={() => onReplaceLine(item.line, null)}>
                  ×
                </button>
              )}
            </>
          )}
        </div>
      ))}
      {editable && (
        <div className="graph-row graph-row--add">
          <span className="graph-row__marker" aria-hidden="true" />
          <input
            className="graph-row__input"
            placeholder="Add an expression: y = x^2, a = 1, (1, 2), x^2 + y^2 = 4…"
            spellCheck={false}
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && adding.trim()) {
                e.preventDefault();
                onAppend(adding.trim());
                setAdding("");
              }
            }}
          />
        </div>
      )}
    </div>
  );
}

function Slider({
  item,
  value,
  editable,
  onSlide,
  onCommit,
}: {
  item: Extract<Item, { kind: "slider" }>;
  value: number;
  editable: boolean;
  onSlide: (name: string, value: number) => void;
  onCommit: (item: Extract<Item, { kind: "slider" }>, value: number) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const latest = useRef(value);
  latest.current = value;

  // Playing sweeps the slider from its minimum to its maximum every four seconds, then loops.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const span = item.max - item.min;
      let next = latest.current + (span * (now - last)) / 4000;
      last = now;
      if (next > item.max) next = item.min;
      onSlide(item.name, item.step ? Math.round((next - item.min) / item.step) * item.step + item.min : next);
      latest.current = next;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, item, onSlide]);

  const step = item.step ?? (item.max - item.min) / 1000;
  return (
    <div className="graph-slider" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`graph-slider__play${playing ? " is-playing" : ""}`}
        aria-label={playing ? "Pause" : "Play"}
        onClick={() => {
          if (playing && editable) onCommit(item, latest.current);
          setPlaying((p) => !p);
        }}
      >
        {playing ? "❚❚" : "▶"}
      </button>
      <span className="graph-slider__bound">{formatValue(item.min)}</span>
      <input
        type="range"
        min={item.min}
        max={item.max}
        step={step}
        value={value}
        onChange={(e) => onSlide(item.name, Number(e.target.value))}
        onPointerUp={(e) => editable && onCommit(item, Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => editable && onCommit(item, Number((e.target as HTMLInputElement).value))}
      />
      <span className="graph-slider__bound">{formatValue(item.max)}</span>
    </div>
  );
}
