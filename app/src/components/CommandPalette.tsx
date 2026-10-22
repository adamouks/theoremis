import { useEffect, useMemo, useRef, useState } from "react";
import type { DocumentSummary, Project } from "../lib/types";
import { Search, StatusGlyph } from "./Icons";

export interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface Props {
  documents: DocumentSummary[];
  projects: Project[];
  commands: Command[];
  onOpen: (id: string) => void;
  onClose: () => void;
}

type Item = { kind: "doc"; doc: DocumentSummary; project?: string } | { kind: "command"; command: Command };

function matches(text: string, query: string) {
  const haystack = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/** ⌘K: jump to a document or run a command. */
export function CommandPalette({ documents, projects, commands, onOpen, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const items = useMemo<Item[]>(() => {
    const names = new Map(projects.map((p) => [p.id, p.name]));
    const docs: Item[] = [...documents]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((doc) => ({ kind: "doc" as const, doc, project: names.get(doc.projectId) }))
      .filter((item) => matches(`${item.doc.title || "Untitled"} ${item.project ?? ""}`, query));
    const cmds: Item[] = commands
      .filter((c) => matches(c.label, query))
      .map((command) => ({ kind: "command" as const, command }));
    return [...docs, ...cmds];
  }, [documents, projects, commands, query]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    if (item.kind === "doc") onOpen(item.doc.id);
    else item.command.run();
  };

  return (
    <div className="dialog-backdrop dialog-backdrop--top" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Search or jump to">
        <div className="palette__input">
          <Search />
          <input
            autoFocus
            value={query}
            placeholder="Search documents and commands…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, items.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(items[active]);
              }
            }}
          />
        </div>
        <div className="palette__list" ref={list}>
          {items.length === 0 && <p className="palette__empty">Nothing matches “{query}”.</p>}
          {items.map((item, index) => (
            <button
              key={item.kind === "doc" ? item.doc.id : item.command.id}
              type="button"
              data-index={index}
              className={`palette__item${index === active ? " is-active" : ""}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(item)}
            >
              {item.kind === "doc" ? (
                <>
                  <StatusGlyph status={item.doc.status ?? "open"} size={8} />
                  <span className="palette__label">{item.doc.title || "Untitled"}</span>
                  <span className="palette__hint">{item.project}</span>
                </>
              ) : (
                <>
                  <span className="palette__command">›</span>
                  <span className="palette__label">{item.command.label}</span>
                  {item.command.hint && <kbd>{item.command.hint}</kbd>}
                </>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
