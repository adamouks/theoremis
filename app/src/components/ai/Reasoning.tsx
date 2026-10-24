// What a model thought before answering, for models that expose it. The behaviour follows Vercel
// AI Elements' Reasoning (Apache-2.0, see THIRD_PARTY_NOTICES.md): it opens while the model
// reasons, closes itself a moment after the answer starts, and then says how long it thought.

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "../Icons";
import { Orb, Shimmer } from "./effects";

/** How long the reasoning stays open once the answer has started. */
const CLOSE_AFTER = 1000;

export function Reasoning({
  text,
  thinking,
  seconds,
}: {
  text: string;
  /** The model is reasoning now: streaming, with no answer yet. */
  thinking: boolean;
  /** How long it reasoned, once known. */
  seconds?: number;
}) {
  const [open, setOpen] = useState(thinking);
  const touched = useRef(false);
  const wasThinking = useRef(thinking);
  const body = useRef<HTMLDivElement>(null);
  /** The start has scrolled out of view, so the top edge fades. */
  const [clipped, setClipped] = useState(false);

  // Keep the newest thought in view while it streams.
  useEffect(() => {
    const el = body.current;
    if (!thinking || !el) return;
    el.scrollTop = el.scrollHeight;
    setClipped(el.scrollTop > 0);
  }, [text, thinking]);

  useEffect(() => {
    if (thinking) {
      wasThinking.current = true;
      if (!touched.current) setOpen(true);
      return;
    }
    // Close once, after it has streamed, unless the person opened or closed it themselves.
    if (!wasThinking.current || touched.current) return;
    const timer = window.setTimeout(() => setOpen(false), CLOSE_AFTER);
    return () => window.clearTimeout(timer);
  }, [thinking]);

  const label = thinking ? null : seconds ? `Thought for ${seconds} ${seconds === 1 ? "second" : "seconds"}` : "Reasoning";
  return (
    <div className={`reasoning${open ? " is-open" : ""}${thinking && clipped ? " is-clipped" : ""}`}>
      <button
        type="button"
        className="reasoning__toggle"
        aria-expanded={open}
        onClick={() => {
          touched.current = true;
          setOpen((o) => !o);
        }}
      >
        {thinking ? <Orb activity="thinking" /> : <span className="reasoning__mark" aria-hidden="true" />}
        <span className="reasoning__label">{thinking ? <Shimmer>Thinking…</Shimmer> : label}</span>
        <ChevronDown size={10} />
      </button>
      <div className="reasoning__panel" aria-hidden={!open}>
        <div className="reasoning__clip">
          <div className="reasoning__body" ref={body} onScroll={(e) => setClipped(e.currentTarget.scrollTop > 0)}>
            {text}
          </div>
        </div>
      </div>
    </div>
  );
}
