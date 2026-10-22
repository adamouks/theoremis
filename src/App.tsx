import { useCallback, useEffect, useMemo, useState } from "react";
import { type MarginNote, type Pin } from "./components/Block";
import { Collaborator, CollaboratorRail } from "./components/Collaborator";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { DocumentView } from "./components/DocumentView";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { api, errorMessage } from "./lib/api";
import { blockContext, numberBlocks } from "./lib/doc";
import { MODE_LABELS } from "./lib/prompts";
import { timeAgo } from "./lib/text";
import type { ChatGptSession, Context, Doc, Mode, ModelRef, ProviderStatus, Settings } from "./lib/types";
import { useCollaborator } from "./lib/useCollaborator";
import { useLean } from "./lib/useLean";
import { useUpdates } from "./lib/useUpdates";
import { useWorkspace } from "./lib/useWorkspace";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
const shortcut = (keys: string) => (isMac ? `⌘${keys}` : `Ctrl ${keys}`);

const sameModel = (a: ModelRef | null, b: ModelRef | null) =>
  !!a && !!b && a.provider === b.provider && a.model === b.model;

function inTextField(target: EventTarget | null) {
  return target instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable);
}

/** The block under the user's text selection or cursor, if any. */
function blockAtSelection(): string | null {
  const fromNode = (node: Node | null) =>
    (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-block-id]")?.dataset.blockId ?? null;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
    const id = fromNode(selection.getRangeAt(0).startContainer);
    if (id) return id;
  }
  return fromNode(document.activeElement);
}

export default function App() {
  const workspace = useWorkspace();
  const { doc, updateDoc } = workspace;

  const [settings, setSettings] = useState<Settings | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [selected, setSelected] = useState<ModelRef | null>(null);
  const [chatgpt, setChatgpt] = useState<ChatGptSession | null>(null);

  const [texMode, setTexMode] = useState(false);
  const [focus, setFocus] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [context, setContext] = useState<Context | null>(null);
  const [composerFocus, setComposerFocus] = useState(0);
  const [reveal, setReveal] = useState<{ blockId: string; edit: boolean; nonce: number } | null>(null);

  const collab = useCollaborator(workspace, settings?.systemPrompt ?? "");
  const updates = useUpdates(workspace.flush);
  const lean = useLean();

  const refreshModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      setProviders(await api.listModels());
      // Listing ChatGPT models can renew or end the session, so re-read it alongside.
      setChatgpt(await api.chatgptSession());
    } catch (err) {
      console.error(err);
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    api.getSettings().then(
      (loaded) => {
        setSettings(loaded);
        setSelected(loaded.lastModel);
      },
      (err) => setStartupError(errorMessage(err)),
    );
    void refreshModels();
  }, [refreshModels]);

  const available = useMemo(
    () => providers.flatMap((p) => p.models).map((m) => ({ provider: m.provider, model: m.id })),
    [providers],
  );

  // Fall back to the first available model when the remembered one is gone.
  useEffect(() => {
    if (!settings || modelsLoading || available.length === 0) return;
    if (!available.some((m) => sameModel(m, selected))) setSelected(available[0]);
  }, [settings, modelsLoading, available, selected]);

  const hasModel = selected !== null && available.some((m) => sameModel(m, selected));

  const selectModel = (model: ModelRef) => {
    setSelected(model);
    api.updateSettings({ lastModel: model }).then(setSettings, console.error);
  };

  // A selection belongs to the document it came from.
  useEffect(() => setContext(null), [doc?.id]);

  const numbered = useMemo(() => (doc ? numberBlocks(doc.blocks) : []), [doc]);
  const thread = doc?.threads.find((t) => t.id === doc.activeThreadId) ?? null;

  const openThread = useCallback(
    (threadId: string) => {
      updateDoc((d) => ({ ...d, activeThreadId: threadId }), "meta");
      setPanelCollapsed(false);
      setFocus(false);
    },
    [updateDoc],
  );

  // Numbered pins tie each pending revision or suggestion in the document to its reply.
  const { blockPins, messagePins, margins } = useMemo(() => {
    const blockPins = new Map<string, Pin>();
    const messagePins = new Map<string, Pin>();
    const margins = new Map<string, MarginNote>();
    if (!doc) return { blockPins, messagePins, margins };
    let n = 0;
    for (const { block } of numbered) {
      for (const t of doc.threads) {
        for (const m of t.messages) {
          if (m.revision?.state === "pending" && m.revision.blockId === block.id) {
            const pin: Pin = { n: ++n, kind: "finding" };
            if (!blockPins.has(block.id)) blockPins.set(block.id, pin);
            messagePins.set(m.id, pin);
            if (!margins.has(block.id)) {
              margins.set(block.id, {
                title: "Proposed revision",
                detail: `${MODE_LABELS[m.mode]} · open in review`,
                tone: "finding",
                onClick: () => openThread(t.id),
              });
            }
          }
        }
      }
      if (block.suggestion) {
        const pin: Pin = { n: ++n, kind: "suggestion" };
        blockPins.set(block.id, pin);
        messagePins.set(block.suggestion.messageId, pin);
      }
      if (!margins.has(block.id)) {
        const about = [...doc.threads]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((t) => ({ t, m: [...t.messages].reverse().find((m) => m.role === "user" && m.context?.blockId === block.id) }))
          .find((x) => x.m);
        if (about?.m) {
          margins.set(block.id, {
            title: MODE_LABELS[about.m.mode] === "Ask" ? "Discussed" : MODE_LABELS[about.m.mode],
            detail: `Collaborator · ${timeAgo(about.t.updatedAt)}`,
            tone: "thread",
            onClick: () => openThread(about.t.id),
          });
        }
      }
    }
    return { blockPins, messagePins, margins };
  }, [doc, numbered, openThread]);

  const ask = useCallback(
    (blockId: string, mode: Mode) => {
      if (!doc) return;
      const nb = numbered.find((n) => n.block.id === blockId);
      if (!nb || !nb.block.source.trim()) return;
      const ctx = blockContext(nb);
      setContext(ctx);
      setPanelCollapsed(false);
      setFocus(false);
      if (mode === "ask" || !selected || !hasModel) setComposerFocus((k) => k + 1);
      else collab.send(doc.id, selected, mode, "", ctx);
    },
    [doc, numbered, selected, hasModel, collab],
  );

  const acceptSuggestion = useCallback(
    (blockId: string) =>
      updateDoc((d) => ({
        ...d,
        blocks: d.blocks.map((b) => {
          if (b.id !== blockId) return b;
          const { suggestion: _s, ...rest } = b;
          return { ...rest, status: "adopted", note: "not formalized" };
        }),
      })),
    [updateDoc],
  );

  const rejectSuggestion = useCallback(
    (blockId: string) => updateDoc((d) => ({ ...d, blocks: d.blocks.filter((b) => b.id !== blockId) })),
    [updateDoc],
  );

  const newDocument = useCallback(
    (projectId?: string) => {
      setFocus(false);
      void workspace.createDocument(projectId);
    },
    [workspace],
  );

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const field = inTextField(e.target);
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newDocument();
      } else if (mod && e.key === ".") {
        e.preventDefault();
        setFocus((f) => !f);
      } else if (mod && e.key === "\\") {
        e.preventDefault();
        setPanelCollapsed((c) => !c);
        setFocus(false);
      } else if (mod && e.key.toLowerCase() === "l") {
        const blockId = blockAtSelection();
        if (blockId) {
          e.preventDefault();
          ask(blockId, "ask");
        }
      } else if (mod && e.key === "Enter" && !field && doc) {
        const first = doc.blocks.find((b) => b.suggestion);
        if (first) {
          e.preventDefault();
          acceptSuggestion(first.id);
        }
      } else if (e.key === "Escape" && focus && !field && !settingsOpen && !paletteOpen) {
        setFocus(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newDocument, ask, acceptSuggestion, doc, focus, settingsOpen, paletteOpen]);

  const commands: Command[] = [
    { id: "new-doc", label: "New document", hint: shortcut("N"), run: () => newDocument() },
    {
      id: "new-project",
      label: "New project",
      run: () => void workspace.createProject("Untitled project"),
    },
    { id: "tex", label: texMode ? "Show rendered document" : "Show TeX source", run: () => setTexMode((t) => !t) },
    { id: "focus", label: focus ? "Exit focus mode" : "Focus mode", hint: shortcut("."), run: () => setFocus((f) => !f) },
    {
      id: "panel",
      label: panelCollapsed ? "Show collaborator" : "Hide collaborator",
      hint: shortcut("\\"),
      run: () => setPanelCollapsed((c) => !c),
    },
    { id: "settings", label: "Settings", hint: shortcut(","), run: () => setSettingsOpen(true) },
  ];

  if (startupError || workspace.loadError) {
    return (
      <div className="fatal">
        <h1>Theoremis couldn’t start</h1>
        <p>{startupError ?? workspace.loadError}</p>
      </div>
    );
  }

  const project = doc ? workspace.projects.find((p) => p.id === doc.projectId) : undefined;
  const streaming = collab.streaming;
  const streamingHere = streaming && doc && streaming.docId === doc.id ? streaming.messageId : null;
  const pendingPins = [...new Map([...blockPins.values()].map((p) => [`${p.kind}${p.n}`, p])).values()];

  return (
    <div className={`app${focus ? " app--focus" : ""}`}>
      {!focus && (
        <Sidebar
          projects={workspace.projects}
          documents={workspace.summaries}
          activeId={doc?.id ?? null}
          displayName={settings?.displayName ?? ""}
          showWindowControlsSpace={isMac}
          shortcut={shortcut}
          onOpen={(id) => void workspace.openDocument(id)}
          onNewDocument={newDocument}
          onNewProject={() => workspace.createProject("Untitled project")}
          onToggleProject={(p) => void workspace.updateProject(p.id, { collapsed: !p.collapsed })}
          onRenameProject={(p, name) => name.trim() && void workspace.updateProject(p.id, { name: name.trim() })}
          onDeleteProject={(p) => void workspace.deleteProject(p.id)}
          onSearch={() => setPaletteOpen(true)}
          onSettings={() => setSettingsOpen(true)}
          update={updates.status}
          onRestartToUpdate={() => void updates.restart()}
        />
      )}

      {doc ? (
        <DocumentView
          doc={doc}
          numbered={numbered}
          projectName={project?.name ?? ""}
          displayName={settings?.displayName ?? ""}
          saveState={workspace.saveState}
          texMode={texMode}
          focus={focus}
          insetForWindowControls={isMac && focus}
          selectedBlockId={context?.blockId ?? null}
          reveal={reveal}
          pins={blockPins}
          margins={margins}
          shortcut={shortcut}
          updateDoc={updateDoc}
          onTexMode={setTexMode}
          onToggleFocus={() => setFocus((f) => !f)}
          onDelete={() => void workspace.deleteDocument(doc.id)}
          onAsk={ask}
          onAcceptSuggestion={acceptSuggestion}
          onRejectSuggestion={rejectSuggestion}
        />
      ) : (
        <EmptyMain loaded={workspace.loaded} shortcut={shortcut} onNew={() => newDocument()} onSearch={() => setPaletteOpen(true)} />
      )}

      {!focus &&
        doc &&
        (panelCollapsed ? (
          <CollaboratorRail pins={pendingPins} onExpand={() => setPanelCollapsed(false)} shortcut={shortcut} />
        ) : (
          <Collaborator
            doc={doc}
            numbered={numbered}
            thread={thread}
            context={context}
            providers={providers}
            lean={lean.status}
            modelsLoading={modelsLoading}
            model={selected}
            hasModel={hasModel}
            streamingMessageId={streamingHere}
            busyElsewhere={!!streaming && !streamingHere}
            displayName={settings?.displayName ?? ""}
            pins={messagePins}
            focusKey={composerFocus}
            shortcut={shortcut}
            onSend={(mode, text) => selected && collab.send(doc.id, selected, mode, text, context)}
            onStop={collab.stop}
            onRetry={(threadId) => selected && collab.retry(threadId, selected)}
            onNewThread={() => {
              updateDoc((d: Doc) => ({ ...d, activeThreadId: undefined }), "meta");
              setComposerFocus((k) => k + 1);
            }}
            onSelectThread={openThread}
            onCollapse={() => setPanelCollapsed(true)}
            onSetContext={setContext}
            onShowBlock={(blockId) => setReveal({ blockId, edit: false, nonce: Date.now() })}
            onAcceptRevision={collab.acceptRevision}
            onEditRevision={(threadId, messageId) => {
              const blockId = doc.threads.find((t) => t.id === threadId)?.messages.find((m) => m.id === messageId)?.revision?.blockId;
              collab.acceptRevision(threadId, messageId);
              if (blockId) setReveal({ blockId, edit: true, nonce: Date.now() });
            }}
            onRejectRevision={collab.rejectRevision}
            onUndoRevision={collab.undoRevision}
            onInsertSuggestion={collab.insertSuggestion}
            onSelectModel={selectModel}
            onRefreshModels={() => void refreshModels()}
            onOpenSettings={() => setSettingsOpen(true)}
            onLeanChecked={collab.recordLeanCheck}
            onMarkVerified={(blockId) =>
              updateDoc((d) => ({
                ...d,
                blocks: d.blocks.map((b) => (b.id === blockId ? { ...b, status: "verified", note: "checked in Lean" } : b)),
              }))
            }
            onFollowUp={(mode, text) => selected && collab.send(doc.id, selected, mode, text, null)}
          />
        ))}

      {paletteOpen && (
        <CommandPalette
          documents={workspace.summaries}
          projects={workspace.projects}
          commands={commands}
          onOpen={(id) => void workspace.openDocument(id)}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {settingsOpen && settings && (
        <SettingsDialog
          settings={settings}
          chatgpt={chatgpt}
          updates={updates}
          lean={lean}
          onChatgptChange={(session) => {
            setChatgpt(session);
            if (session.status !== "signingIn") void refreshModels();
          }}
          onClose={() => setSettingsOpen(false)}
          onSaved={(next) => {
            setSettings(next);
            setSettingsOpen(false);
            void refreshModels();
          }}
        />
      )}
    </div>
  );
}

function EmptyMain({
  loaded,
  shortcut,
  onNew,
  onSearch,
}: {
  loaded: boolean;
  shortcut: (keys: string) => string;
  onNew: () => void;
  onSearch: () => void;
}) {
  return (
    <main className="document document--empty" data-tauri-drag-region>
      {loaded && (
        <div className="empty-main">
          <div className="empty-main__mark">
            <span className="wordmark wordmark--large">Theoremis</span>
            <span className="tombstone tombstone--large" />
          </div>
          <p>Open a document from the sidebar, or start a new one.</p>
          <div className="empty-main__actions">
            <button type="button" className="button button--cream" onClick={onNew}>
              New document <kbd>{shortcut("N")}</kbd>
            </button>
            <button type="button" className="button button--ghost" onClick={onSearch}>
              Search <kbd>{shortcut("K")}</kbd>
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
