// How hard the model thinks, as a gauge in the composer: the needle sits at the chosen effort
// among those the model offers, and the menu lists them with what each costs.

import { useEffect, useRef, useState } from "react";
import { effortLabel, effortNote } from "../../lib/effort";
import type { Effort } from "../../lib/types";
import { Check } from "../Icons";

/** A half-dial with a tick per effort and the needle at `level` of `levels`. */
export function Gauge({ level, levels }: { level: number; levels: number }) {
  const at = levels > 1 ? level / (levels - 1) : 1;
  // The arc runs from 180° (least) to 0° (most) around (10, 10), radius 7.5.
  const point = (t: number, r: number) => {
    const a = Math.PI * (1 - t);
    return [10 + r * Math.cos(a), 10 - r * Math.sin(a)];
  };
  const ticks = Array.from({ length: levels }, (_, i) => (levels > 1 ? i / (levels - 1) : 1));
  return (
    <svg className="gauge" width="20" height="12" viewBox="0 0 20 12" aria-hidden="true">
      <path className="gauge__track" d="M2.5 10 A7.5 7.5 0 0 1 17.5 10" pathLength={100} />
      <path className="gauge__fill" d="M2.5 10 A7.5 7.5 0 0 1 17.5 10" pathLength={100} style={{ strokeDashoffset: 100 - at * 100 }} />
      {ticks.map((t, i) => {
        const [x, y] = point(t, 9.2);
        return <circle key={i} className={`gauge__tick${i <= level ? " is-on" : ""}`} cx={x} cy={y} r={0.7} />;
      })}
      <g className="gauge__needle" style={{ transform: `rotate(${at * 180}deg)` }}>
        <line x1="10" y1="10" x2="4.2" y2="10" />
      </g>
      <circle className="gauge__hub" cx="10" cy="10" r="1.4" />
    </svg>
  );
}

export function EffortGauge({ efforts, value, onChange }: { efforts: Effort[]; value: string | undefined; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (efforts.length < 2 || !value) return null;
  const level = Math.max(0, efforts.findIndex((e) => e.id === value));
  const current = efforts[level];
  return (
    <div className="menu-anchor effort" ref={root}>
      <button
        type="button"
        className={`effort__button${open ? " is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Effort: ${effortLabel(current.id)}`}
        title={`Effort: ${effortLabel(current.id)}. ${effortNote(current)}`}
        onClick={() => setOpen((o) => !o)}
      >
        <Gauge level={level} levels={efforts.length} />
        <span className="effort__label">{effortLabel(current.id)}</span>
      </button>
      {open && (
        <div className="menu menu--up menu--right effort-menu" role="menu">
          <div className="menu__label">How hard it thinks</div>
          {efforts.map((effort, i) => (
            <button
              key={effort.id}
              type="button"
              role="menuitemradio"
              aria-checked={i === level}
              className={`menu__item effort-menu__item${i === level ? " is-active" : ""}`}
              onClick={() => {
                onChange(effort.id);
                setOpen(false);
              }}
            >
              <Gauge level={i} levels={efforts.length} />
              <span className="effort-menu__text">
                <span className="effort-menu__name">{effortLabel(effort.id)}</span>
                <span className="effort-menu__note">{effortNote(effort)}</span>
              </span>
              <span className="menu__check">{i === level && <Check />}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
