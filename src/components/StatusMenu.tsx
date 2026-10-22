import { useEffect, useRef, useState } from "react";
import { STATUSES, STATUS_INFO } from "../lib/doc";
import type { Status } from "../lib/types";
import { StatusGlyph } from "./Icons";

interface Props {
  status?: Status;
  note?: string;
  onChange: (status: Status | undefined, note: string | undefined) => void;
  onAsk: () => void;
  onDelete: () => void;
  onClose: () => void;
  shortcut: (keys: string) => string;
}

/** Sets a block's standing and its short note, from the gutter. */
export function StatusMenu({ status, note, onChange, onAsk, onDelete, onClose, shortcut }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const [draftNote, setDraftNote] = useState(note ?? "");

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const choose = (next: Status | undefined) => {
    // Swap in the new status's default note unless the author wrote their own.
    const isDefault = !note || STATUSES.some((s) => STATUS_INFO[s].note === note);
    const nextNote = next ? (isDefault ? STATUS_INFO[next].note : note) : undefined;
    onChange(next, nextNote || undefined);
    onClose();
  };

  return (
    <div className="menu status-menu" ref={root} role="menu" onClick={(e) => e.stopPropagation()}>
      <div className="menu__label">Standing</div>
      {STATUSES.map((s) => (
        <button
          key={s}
          type="button"
          role="menuitemradio"
          aria-checked={s === status}
          className={`menu__item${s === status ? " is-active" : ""}`}
          onClick={() => choose(s)}
        >
          <StatusGlyph status={s} size={8} />
          <span className="menu__mono">{STATUS_INFO[s].label}</span>
          <span className="menu__hint">{STATUS_INFO[s].meaning}</span>
        </button>
      ))}
      <button
        type="button"
        role="menuitemradio"
        aria-checked={!status}
        className={`menu__item${!status ? " is-active" : ""}`}
        onClick={() => choose(undefined)}
      >
        <span className="status-glyph status-glyph--none" />
        <span className="menu__mono">NONE</span>
        <span className="menu__hint">Plain text</span>
      </button>
      {status && (
        <label className="menu__field">
          <span>Note</span>
          <input
            value={draftNote}
            placeholder="e.g. tested to $10^4$"
            onChange={(e) => setDraftNote(e.target.value)}
            onBlur={() => onChange(status, draftNote.trim() || undefined)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onChange(status, draftNote.trim() || undefined);
                onClose();
              }
            }}
          />
        </label>
      )}
      <div className="menu__divider" />
      <button
        type="button"
        className="menu__item"
        onClick={() => {
          onAsk();
          onClose();
        }}
      >
        <span className="collab-glyph" />
        <span>Ask about this</span>
        <kbd>{shortcut("L")}</kbd>
      </button>
      <button
        type="button"
        className="menu__item menu__item--danger"
        onClick={() => {
          onDelete();
          onClose();
        }}
      >
        <span className="menu__spacer" />
        <span>Delete block</span>
      </button>
    </div>
  );
}
