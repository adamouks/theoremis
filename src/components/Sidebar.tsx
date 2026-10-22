import { useMemo, useState } from "react";
import { dateGroup, type DateGroup } from "../lib/text";
import type { ConversationSummary } from "../lib/types";
import { LogoMark, PlusIcon, SettingsIcon, TrashIcon } from "./Icons";

interface Props {
  conversations: ConversationSummary[];
  activeId: string;
  streamingId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
}

export function Sidebar({
  conversations,
  activeId,
  streamingId,
  onSelect,
  onNew,
  onDelete,
  onOpenSettings,
}: Props) {
  const [confirming, setConfirming] = useState<string | null>(null);

  const groups = useMemo(() => {
    const now = Date.now();
    const map = new Map<DateGroup, ConversationSummary[]>();
    for (const c of conversations) {
      const group = dateGroup(c.updatedAt, now);
      map.set(group, [...(map.get(group) ?? []), c]);
    }
    return [...map.entries()];
  }, [conversations]);

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <LogoMark />
        <span className="wordmark">Theoremis</span>
      </div>

      <button type="button" className="sidebar__new" onClick={onNew}>
        <PlusIcon />
        New chat
        <kbd>{navigator.platform.startsWith("Mac") ? "⌘N" : "Ctrl N"}</kbd>
      </button>

      <nav className="sidebar__list" aria-label="Conversations">
        {conversations.length === 0 && <p className="sidebar__empty">Your conversations will appear here.</p>}
        {groups.map(([label, items]) => (
          <section key={label}>
            <h2>{label}</h2>
            {items.map((c) => (
              <div
                key={c.id}
                className={`sidebar__item${c.id === activeId ? " is-active" : ""}`}
                onMouseLeave={() => confirming === c.id && setConfirming(null)}
              >
                <button type="button" className="sidebar__title" onClick={() => onSelect(c.id)} title={c.title}>
                  {c.id === streamingId && <span className="pulse" aria-label="Replying" />}
                  <span>{c.title}</span>
                </button>
                {confirming === c.id ? (
                  <button
                    type="button"
                    className="sidebar__confirm"
                    onClick={() => {
                      setConfirming(null);
                      onDelete(c.id);
                    }}
                  >
                    Delete
                  </button>
                ) : (
                  c.id !== streamingId && (
                    <button
                      type="button"
                      className="icon-button icon-button--small sidebar__delete"
                      title="Delete conversation"
                      aria-label={`Delete ${c.title}`}
                      onClick={() => setConfirming(c.id)}
                    >
                      <TrashIcon />
                    </button>
                  )
                )}
              </div>
            ))}
          </section>
        ))}
      </nav>

      <button type="button" className="sidebar__settings" onClick={onOpenSettings}>
        <SettingsIcon />
        Settings
      </button>
    </aside>
  );
}
