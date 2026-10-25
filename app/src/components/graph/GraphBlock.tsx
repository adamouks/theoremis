import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { evaluateScope, parseGraph, replaceLine, setOption, sliderLine, viewLine, type Dim, type Item } from "../../lib/graph/spec";
import type { Window2D } from "../../lib/graph/plot2d";
import { Close } from "../Icons";
import { ExpressionList } from "./ExpressionList";
import { Graph2D, itemColor, type GraphHandle } from "./Graph2D";
import { offerPicture } from "./graphPicture";

// three.js is large; load it with the first 3D graph.
const Graph3D = lazy(() => import("./Graph3D"));

interface Props {
  code: string;
  dim: Dim;
  /** Whether the person can change the graph; changes are written back to the code. */
  editable: boolean;
  /** Smaller, for the collaborator's narrow column. */
  compact: boolean;
  onChange?: (code: string) => void;
}

/** A graph block: the plane (or space), the expressions that draw it, and their sliders. */
export function GraphBlock({ code, dim, editable, compact, onChange }: Props) {
  const spec = useMemo(() => parseGraph(code, dim), [code, dim]);
  const [values, setValues] = useState<Record<string, number>>({});
  const [moved, setMoved] = useState<Window2D | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [listOpen, setListOpen] = useState(true);
  const graph = useRef<GraphHandle>(null);

  // A slider moved by hand stays where it is until the code says otherwise.
  const codeValues = useMemo(
    () => Object.fromEntries(spec.items.flatMap((i) => (i.kind === "slider" ? [[i.name, i.value]] : []))),
    [spec],
  );
  useEffect(() => setValues({}), [codeValues]);
  const sliders = useMemo(() => ({ ...codeValues, ...values }), [codeValues, values]);
  const scope = useMemo(() => evaluateScope(spec, sliders), [spec, sliders]);
  const shownValues = useMemo(() => ({ ...scope }), [scope]);

  const write = useCallback((next: string) => editable && onChange?.(next), [editable, onChange]);
  const onSlide = useCallback((name: string, value: number) => setValues((v) => ({ ...v, [name]: value })), []);
  const onCommitSlider = useCallback(
    (item: Extract<Item, { kind: "slider" }>, value: number) => write(replaceLine(code, item.line, sliderLine(item, value))),
    [code, write],
  );
  const onReplaceLine = useCallback((line: number, text: string | null) => write(replaceLine(code, line, text)), [code, write]);
  const onSetOption = useCallback(
    (line: number, key: string, value: string | boolean | null) => {
      const lines = code.split("\n");
      if (editable) write(replaceLine(code, line, setOption(lines[line], key, value)));
    },
    [code, editable, write],
  );
  const onAppend = useCallback((text: string) => write(code.trim() ? `${code.replace(/\n+$/, "")}\n${text}` : text), [code, write]);

  const keepView = () => {
    if (!moved) return;
    const line = viewLine({ ...spec.view, x: [moved.x0, moved.x1], y: [moved.y0, moved.y1] }, 2);
    write(spec.viewLine === null ? `${code.replace(/\n+$/, "")}\n${line}` : replaceLine(code, spec.viewLine, line));
    setMoved(null);
  };

  // A 3D graph can only be pictured from the screen, for print and export.
  useEffect(() => (dim === 3 ? offerPicture(code, 3, () => graph.current?.capture?.() ?? null) : undefined), [code, dim]);

  const height = spec.view.height ?? (compact ? 230 : 330);
  const colorOf = useCallback((item: Item) => itemColor(spec, item), [spec]);
  const drawable = spec.items.filter((i) => i.kind !== "note").length;

  const body = (wide: boolean) => (
    <div className={`graph${wide ? " graph--wide" : ""}${compact && !wide ? " graph--compact" : ""}`} data-graph>
      <div className="graph__stage">
        {dim === 2 ? (
          <Graph2D
            spec={spec}
            scope={scope}
            height={wide ? Math.round(window.innerHeight * 0.78) : height}
            handle={graph}
            onWindowChange={(w, didMove) => setMoved(didMove ? w : null)}
          />
        ) : (
          <Suspense fallback={<div className="graph3d graph3d--loading" style={{ height }} />}>
            <Graph3D spec={spec} scope={scope} height={wide ? Math.round(window.innerHeight * 0.78) : height} colorOf={colorOf} handle={graph} />
          </Suspense>
        )}
        <div className="graph__tools">
          {dim === 3 && (
            <button type="button" className="graph__tool" title="Turn the view" onClick={() => graph.current?.rotate?.()}>
              ⟳
            </button>
          )}
          <button type="button" className="graph__tool" title="Zoom in" onClick={() => graph.current?.zoom(dim === 2 ? 0.6 : 0.8)}>
            +
          </button>
          <button type="button" className="graph__tool" title="Zoom out" onClick={() => graph.current?.zoom(dim === 2 ? 1 / 0.6 : 1.25)}>
            −
          </button>
          <button type="button" className="graph__tool" title={dim === 2 ? "Back to the original window" : "Back to the original view"} onClick={() => graph.current?.reset()}>
            ⌂
          </button>
          {editable && moved && dim === 2 && (
            <button type="button" className="graph__tool graph__tool--text" title="Save this window in the graph" onClick={keepView}>
              Keep view
            </button>
          )}
          <button type="button" className="graph__tool" title={wide ? "Close" : "Open large"} onClick={() => setExpanded((e) => !e)}>
            {wide ? <Close size={10} /> : "⤢"}
          </button>
        </div>
      </div>
      {(listOpen || wide) && (drawable > 0 || editable) && (
        <ExpressionList
          spec={spec}
          editable={editable}
          values={shownValues}
          colorOf={colorOf}
          onSlide={onSlide}
          onCommitSlider={onCommitSlider}
          onReplaceLine={onReplaceLine}
          onSetOption={onSetOption}
          onAppend={onAppend}
        />
      )}
      {!wide && drawable > 0 && (
        <button type="button" className="graph__fold" onClick={() => setListOpen((o) => !o)}>
          {listOpen ? "Hide expressions" : `Show ${drawable} ${drawable === 1 ? "expression" : "expressions"}`}
        </button>
      )}
    </div>
  );

  return (
    <>
      {body(false)}
      {expanded &&
        createPortal(
          <div className="dialog-backdrop graph-modal" onPointerDown={(e) => e.target === e.currentTarget && setExpanded(false)}>
            <div className="graph-modal__panel" onKeyDown={(e) => e.key === "Escape" && setExpanded(false)}>
              {body(true)}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
