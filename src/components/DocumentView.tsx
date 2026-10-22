import { useCallback, useEffect, useRef, useState } from "react";
import { documentAsText, type NumberedBlock } from "../lib/doc";
import { MODE_LABELS } from "../lib/prompts";
import { newId, timeAgo } from "../lib/text";
import type { Block, Doc, Mode, Status } from "../lib/types";
import type { ChangeKind, SaveState } from "../lib/useWorkspace";
import { AutoTextarea } from "./AutoTextarea";
import { BlockView, type MarginNote, type Pin } from "./Block";
import { ExitFocus, Focus, More } from "./Icons";
import { Markdown } from "./Markdown";

interface Props {
  doc: Doc;
  numbered: NumberedBlock[];
  projectName: string;
  displayName: string;
  saveState: SaveState;
  texMode: boolean;
  focus: boolean;
  /** Leave room for macOS window controls when the sidebar is hidden. */
  insetForWindowControls: boolean;
  selectedBlockId: string | null;
  /** Scroll to a block (and optionally start editing it); a new nonce repeats the request. */
  reveal: { blockId: string; edit: boolean; nonce: number } | null;
  pins: Map<string, Pin>;
  margins: Map<string, MarginNote>;
  shortcut: (keys: string) => string;
  updateDoc: (fn: (doc: Doc) => Doc, kind?: ChangeKind) => void;
  onTexMode: (tex: boolean) => void;
  onToggleFocus: () => void;
  onDelete: () => void;
  onAsk: (blockId: string, mode: Mode) => void;
  onAcceptSuggestion: (blockId: string) => void;
  onRejectSuggestion: (blockId: string) => void;
}

const TOOLBAR_MODES: Mode[] = ["explore", "gaps", "challenge", "formalize"];

export function DocumentView({
  doc,
  numbered,
  projectName,
  displayName,
  saveState,
  texMode,
  focus,
  insetForWindowControls,
  selectedBlockId,
  reveal,
  pins,
  margins,
  shortcut,
  updateDoc,
  onTexMode,
  onToggleFocus,
  onDelete,
  onAsk,
  onAcceptSuggestion,
  onRejectSuggestion,
}: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [editingLede, setEditingLede] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [toolbar, setToolbar] = useState<{ x: number; y: number; blockId: string } | null>(null);
  const [, setTick] = useState(0);
  const page = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // Keep "Edited 2 min ago" honest.
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    setEditing(null);
    setEditingLede(false);
    setToolbar(null);
    scroller.current?.scrollTo({ top: 0 });
  }, [doc.id]);

  useEffect(() => {
    if (!reveal) return;
    const el = page.current?.querySelector<HTMLElement>(`[data-block-id="${reveal.blockId}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (reveal.edit) setEditing(reveal.blockId);
    el?.classList.add("block--flash");
    const id = window.setTimeout(() => el?.classList.remove("block--flash"), 1200);
    return () => window.clearTimeout(id);
  }, [reveal]);

  // A brand-new document starts with the cursor in its title.
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!doc.title && doc.revision === 0) titleRef.current?.focus();
  }, [doc.id, doc.title, doc.revision]);

  const setBlocks = useCallback(
    (fn: (blocks: Block[]) => Block[]) => updateDoc((d) => ({ ...d, blocks: fn(d.blocks) })),
    [updateDoc],
  );

  const onChange = useCallback(
    (id: string, source: string) => setBlocks((blocks) => blocks.map((b) => (b.id === id ? { ...b, source } : b))),
    [setBlocks],
  );

  const onAddAfter = useCallback(
    (id: string | null) => {
      const block: Block = { id: newId(), source: "" };
      setBlocks((blocks) => {
        const at = id ? blocks.findIndex((b) => b.id === id) : -1;
        const next = [...blocks];
        next.splice(at >= 0 ? at + 1 : next.length, 0, block);
        return next;
      });
      setEditing(block.id);
    },
    [setBlocks],
  );

  const onRemoveEmpty = useCallback(
    (id: string) => {
      const index = doc.blocks.findIndex((b) => b.id === id);
      if (doc.blocks.length <= 1) return;
      setBlocks((blocks) => blocks.filter((b) => b.id !== id));
      setEditing(index > 0 ? doc.blocks[index - 1].id : null);
    },
    [doc.blocks, setBlocks],
  );

  const onSetStatus = useCallback(
    (id: string, status: Status | undefined, note: string | undefined) =>
      setBlocks((blocks) =>
        blocks.map((b) => {
          if (b.id !== id) return b;
          const { status: _s, note: _n, ...rest } = b;
          return { ...rest, ...(status ? { status } : {}), ...(status && note ? { note } : {}) };
        }),
      ),
    [setBlocks],
  );

  const onDeleteBlock = useCallback(
    (id: string) =>
      setBlocks((blocks) => {
        const next = blocks.filter((b) => b.id !== id);
        return next.length ? next : [{ id: newId(), source: "" }];
      }),
    [setBlocks],
  );

  const onStopEdit = useCallback(() => setEditing(null), []);

  // Show the Ask toolbar over a text selection inside the document.
  const updateToolbar = useCallback(() => {
    const selection = window.getSelection();
    const host = page.current;
    if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !host) {
      setToolbar(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const start = range.startContainer;
    const element = (start instanceof Element ? start : start.parentElement)?.closest<HTMLElement>("[data-block-id]");
    if (!element || !host.contains(element) || element.querySelector("textarea")) {
      setToolbar(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    const origin = host.getBoundingClientRect();
    setToolbar({
      x: Math.min(Math.max(rect.left + rect.width / 2 - origin.left, 150), origin.width - 150),
      y: rect.top - origin.top,
      blockId: element.dataset.blockId!,
    });
  }, []);

  useEffect(() => {
    const onSelectionChange = () => {
      if (window.getSelection()?.isCollapsed) setToolbar(null);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  const ask = (mode: Mode) => {
    if (!toolbar) return;
    onAsk(toolbar.blockId, mode);
    window.getSelection()?.removeAllRanges();
    setToolbar(null);
  };

  const meta = [displayName, doc.revision > 0 ? `Revision ${doc.revision}` : "New", `Edited ${timeAgo(doc.updatedAt)}`]
    .filter(Boolean)
    .join(" · ");

  return (
    <main className={`document${focus ? " document--focus" : ""}`}>
      <header
        className={`doc-header${insetForWindowControls ? " doc-header--inset" : ""}`}
        data-tauri-drag-region
      >
        <div className="crumbs" data-tauri-drag-region>
          <span className="crumbs__project">{projectName}</span>
          <span className="crumbs__sep">/</span>
          <span className="crumbs__current">{doc.title || "Untitled"}</span>
        </div>
        <div className="doc-header__actions">
          <span className={`save-state save-state--${saveState}`}>
            {saveState === "saving" ? "Saving…" : saveState === "error" ? "Not saved" : "Saved"}
          </span>
          <div className="segmented" role="tablist" aria-label="View">
            <button type="button" role="tab" aria-selected={!texMode} className={texMode ? "" : "is-active"} onClick={() => onTexMode(false)}>
              Rendered
            </button>
            <button type="button" role="tab" aria-selected={texMode} className={texMode ? "is-active" : ""} onClick={() => onTexMode(true)}>
              TeX
            </button>
          </div>
          {focus ? (
            <button type="button" className="header-button header-button--active" onClick={onToggleFocus}>
              <ExitFocus />
              <span>Exit focus</span>
              <kbd>esc</kbd>
            </button>
          ) : (
            <button type="button" className="header-button" onClick={onToggleFocus} title="Distraction-free writing">
              <Focus />
              <span>Focus</span>
              <kbd>{shortcut(".")}</kbd>
            </button>
          )}
          <div className="menu-anchor">
            <button
              type="button"
              className="icon-button"
              aria-label="More"
              onClick={() => {
                setMenuOpen((o) => !o);
                setConfirmDelete(false);
              }}
            >
              <More />
            </button>
            {menuOpen && (
              <div className="menu menu--right" onMouseLeave={() => setMenuOpen(false)}>
                <button
                  type="button"
                  className="menu__item"
                  onClick={() => {
                    void navigator.clipboard.writeText(documentAsText(doc, { statuses: false }));
                    setMenuOpen(false);
                  }}
                >
                  <span className="menu__spacer" />
                  Copy as Markdown + LaTeX
                </button>
                <div className="menu__divider" />
                <button
                  type="button"
                  className="menu__item menu__item--danger"
                  onClick={() => {
                    if (!confirmDelete) return setConfirmDelete(true);
                    setMenuOpen(false);
                    onDelete();
                  }}
                >
                  <span className="menu__spacer" />
                  {confirmDelete ? "Click again to delete" : "Delete document"}
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="doc-scroll" ref={scroller} onMouseUp={() => requestAnimationFrame(updateToolbar)}>
        <div className="doc-page" ref={page}>
          <div className="doc-row">
            <div />
            <div className="doc-head">
              <div className="doc-meta">{meta}</div>
              <input
                ref={titleRef}
                className="doc-title"
                value={doc.title}
                placeholder="Untitled"
                spellCheck={false}
                onChange={(e) => updateDoc((d) => ({ ...d, title: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    setEditingLede(true);
                  }
                }}
              />
              {texMode || editingLede ? (
                <AutoTextarea
                  className="doc-lede doc-lede--source"
                  value={doc.lede}
                  autoFocus={editingLede}
                  placeholder="Add a summary of what this document sets out to do…"
                  onChange={(e) => updateDoc((d) => ({ ...d, lede: e.target.value }))}
                  onBlur={() => setEditingLede(false)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) {
                      e.preventDefault();
                      e.currentTarget.blur();
                    }
                  }}
                />
              ) : (
                <div
                  className={`doc-lede${doc.lede.trim() ? "" : " doc-lede--empty"}`}
                  onClick={() => window.getSelection()?.isCollapsed && setEditingLede(true)}
                >
                  {doc.lede.trim() ? <Markdown text={doc.lede} variant="doc" /> : "Add a summary…"}
                </div>
              )}
            </div>
            <div />
          </div>

          <div className="doc-blocks">
            {numbered.map((nb) => (
              <BlockView
                key={nb.block.id}
                numbered={nb}
                texMode={texMode}
                editing={editing === nb.block.id}
                selected={selectedBlockId === nb.block.id}
                pin={pins.get(nb.block.id)}
                margin={margins.get(nb.block.id)}
                shortcut={shortcut}
                onStartEdit={setEditing}
                onChange={onChange}
                onStopEdit={onStopEdit}
                onAddAfter={onAddAfter}
                onRemoveEmpty={onRemoveEmpty}
                onSetStatus={onSetStatus}
                onDelete={onDeleteBlock}
                onAsk={(id) => onAsk(id, "ask")}
                onAccept={onAcceptSuggestion}
                onReject={onRejectSuggestion}
              />
            ))}
          </div>

          <div className="doc-row">
            <div />
            <button type="button" className="add-block" onClick={() => onAddAfter(null)}>
              + Add a paragraph
              <span>
                or press <kbd>{shortcut("↵")}</kbd> while writing
              </span>
            </button>
            <div />
          </div>

          {toolbar && (
            <div className="selection-toolbar" style={{ left: toolbar.x, top: toolbar.y }} onMouseDown={(e) => e.preventDefault()}>
              <button type="button" className="selection-toolbar__ask" onClick={() => ask("ask")}>
                <span className="collab-glyph collab-glyph--small" />
                Ask
                <kbd>{shortcut("L")}</kbd>
              </button>
              <span className="selection-toolbar__sep" />
              {TOOLBAR_MODES.map((mode) => (
                <button key={mode} type="button" onClick={() => ask(mode)}>
                  {MODE_LABELS[mode]}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {focus && (
        <div className="focus-pill">
          Focus mode<span className="focus-pill__sep">·</span>
          <span>Collaborator and navigation hidden</span>
          <kbd>esc</kbd>
        </div>
      )}
    </main>
  );
}
