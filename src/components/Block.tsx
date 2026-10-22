import { memo, useState, type KeyboardEvent, type MouseEvent } from "react";
import { STATUS_INFO, type NumberedBlock } from "../lib/doc";
import type { Status } from "../lib/types";
import { AutoTextarea } from "./AutoTextarea";
import { StatusGlyph } from "./Icons";
import { Markdown } from "./Markdown";
import { StatusMenu } from "./StatusMenu";

export interface Pin {
  n: number;
  kind: "finding" | "suggestion";
}

export interface MarginNote {
  title: string;
  detail: string;
  tone: "finding" | "thread";
  onClick: () => void;
}

interface Props {
  numbered: NumberedBlock;
  texMode: boolean;
  editing: boolean;
  selected: boolean;
  pin?: Pin;
  margin?: MarginNote;
  shortcut: (keys: string) => string;
  onStartEdit: (id: string) => void;
  onChange: (id: string, source: string) => void;
  onStopEdit: () => void;
  onAddAfter: (id: string) => void;
  onRemoveEmpty: (id: string) => void;
  onSetStatus: (id: string, status: Status | undefined, note: string | undefined) => void;
  onDelete: (id: string) => void;
  onAsk: (id: string) => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
}

const PLACEHOLDER = "Write in Markdown with LaTeX, e.g. **Theorem 1.** *For every $n\\ge 1$, …*";

export const BlockView = memo(function BlockView({
  numbered,
  texMode,
  editing,
  selected,
  pin,
  margin,
  shortcut,
  onStartEdit,
  onChange,
  onStopEdit,
  onAddAfter,
  onRemoveEmpty,
  onSetStatus,
  onDelete,
  onAsk,
  onAccept,
  onReject,
}: Props) {
  const { block } = numbered;
  const [menuOpen, setMenuOpen] = useState(false);
  const suggested = !!block.suggestion;
  const showSource = texMode || editing;

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onAddAfter(block.id);
    } else if (e.key === "Backspace" && block.source === "") {
      e.preventDefault();
      onRemoveEmpty(block.id);
    }
  };

  const onRenderedClick = (e: MouseEvent) => {
    // A drag-selection is for asking about the text, not for editing it.
    if (!window.getSelection()?.isCollapsed) return;
    if ((e.target as HTMLElement).closest("a, button")) return;
    onStartEdit(block.id);
  };

  const classes = [
    "block",
    suggested && "block--suggested",
    selected && "block--selected",
    showSource && "block--source",
    !block.source.trim() && "block--empty",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} data-block-id={block.id}>
      <div className="block__gutter">
        {suggested ? (
          <div className="gutter-status gutter-status--suggested" title="Suggested by the collaborator. Not checked by you or by Lean.">
            <span className="gutter-status__label">
              <StatusGlyph suggested size={7} />
              SUGGESTED
            </span>
            <span className="gutter-status__note">not verified</span>
          </div>
        ) : (
          <button
            type="button"
            className={`gutter-status${block.status ? "" : " gutter-status--unset"}`}
            title={block.status ? STATUS_INFO[block.status].meaning : "Set a status"}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {block.status ? (
              <>
                <span className="gutter-status__label">
                  <StatusGlyph status={block.status} size={7} />
                  {STATUS_INFO[block.status].label}
                </span>
                {block.note && (
                  <span className="gutter-status__note">
                    <Markdown text={block.note} variant="note" />
                  </span>
                )}
              </>
            ) : (
              <span className="gutter-status__label">
                <StatusGlyph size={7} />
                STATUS
              </span>
            )}
          </button>
        )}
        {menuOpen && (
          <StatusMenu
            status={block.status}
            note={block.note}
            shortcut={shortcut}
            onChange={(status, note) => onSetStatus(block.id, status, note)}
            onAsk={() => onAsk(block.id)}
            onDelete={() => onDelete(block.id)}
            onClose={() => setMenuOpen(false)}
          />
        )}
      </div>

      <div className="block__body">
        {selected && <SelectionCorners />}
        {pin && (
          <span className={`pin pin--${pin.kind}`} title={pin.kind === "finding" ? "Proposed revision" : "Suggestion"}>
            {pin.n}
          </span>
        )}
        {showSource ? (
          <AutoTextarea
            className="block__source"
            value={block.source}
            autoFocus={editing}
            spellCheck={false}
            placeholder={PLACEHOLDER}
            onChange={(e) => onChange(block.id, e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => editing && onStopEdit()}
          />
        ) : (
          <div className="block__rendered" onClick={onRenderedClick}>
            {block.source.trim() ? (
              <Markdown text={numbered.text} normalized={!suggested} variant={suggested ? "ai" : "doc"} />
            ) : (
              <p className="block__placeholder">Empty paragraph — click to write</p>
            )}
          </div>
        )}
        {suggested && (
          <div className="suggestion-bar">
            <span className="suggestion-bar__source">
              <StatusGlyph suggested size={7} />
              From the collaborator · not verified
            </span>
            <span className="suggestion-bar__actions">
              <button type="button" className="text-button" onClick={() => onReject(block.id)}>
                Reject
              </button>
              <button type="button" className="text-button" onClick={() => onStartEdit(block.id)}>
                Edit
              </button>
              <button type="button" className="button button--primary button--small" onClick={() => onAccept(block.id)}>
                Accept
                <kbd>{shortcut("↵")}</kbd>
              </button>
            </span>
          </div>
        )}
      </div>

      <div className="block__margin">
        {margin && (
          <button type="button" className={`margin-note margin-note--${margin.tone}`} onClick={margin.onClick}>
            <span className="margin-note__title">{margin.title}</span>
            <span className="margin-note__detail">{margin.detail}</span>
          </button>
        )}
      </div>
    </div>
  );
});

/** The bracket corners the design draws around the passage under discussion. */
export function SelectionCorners() {
  return (
    <>
      <span className="corner corner--tl" />
      <span className="corner corner--tr" />
      <span className="corner corner--bl" />
      <span className="corner corner--br" />
    </>
  );
}
