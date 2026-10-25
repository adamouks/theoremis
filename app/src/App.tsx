import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type MarginNote, type Pin } from "./components/Block";
import { Collaborator, CollaboratorRail } from "./components/Collaborator";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { DocumentView } from "./components/DocumentView";
import { DropOverlay } from "./components/DropOverlay";
import { ImportBanner } from "./components/ImportBanner";
import { ImportDialog } from "./components/ImportDialog";
import { Close } from "./components/Icons";
import { MediaContext, NotationContext, type Notation } from "./components/Markdown";
import { NotationDialog } from "./components/NotationDialog";
import { PrintDocument } from "./components/PrintDocument";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { SourceViewer } from "./components/SourceViewer";
import { Welcome, type WelcomeChoice } from "./components/Welcome";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, errorMessage } from "./lib/api";
import { formatEntry } from "./lib/bibtex";
import { exportLatex } from "./lib/exportDocument";
import { citationSignature, citedReferences, readNotation } from "./lib/notation";
import { blockContext, numberBlocks } from "./lib/doc";
import { effortKey, resolveEffort } from "./lib/effort";
import { MODE_LABELS } from "./lib/prompts";
import { ACCEPTED_FILES } from "./lib/sources";
import { timeAgo } from "./lib/text";
import { callsTools, readsImages, type ChatGptSession, type Context, type Doc, type Mode, type ModelRef, type ProviderStatus, type Settings, type Work } from "./lib/types";
import { useCollaborator } from "./lib/useCollaborator";
import { useImport } from "./lib/useImport";
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

  const infoOf = useCallback(
    (model: ModelRef | null) => providers.flatMap((p) => p.models).find((m) => model && m.provider === model.provider && m.id === model.model),
    [providers],
  );
  const collab = useCollaborator(workspace, settings?.systemPrompt ?? "", (model) => readsImages(infoOf(model)));
  const importer = useImport(workspace);
  const [importing, setImporting] = useState<{ files: File[]; target: "new" | "append" } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [composerDrop, setComposerDrop] = useState<{ files: File[]; nonce: number } | null>(null);
  // The paragraph open for editing when a drag began, which can take dropped images.
  const dropEditor = useRef<HTMLTextAreaElement | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pickTarget = useRef<"new" | "append">("new");

  const pickFiles = useCallback((target: "new" | "append") => {
    pickTarget.current = target;
    fileInput.current?.click();
  }, []);
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
  const selectedVision = readsImages(infoOf(selected));
  // Auto mode needs a model that calls tools; with any other, the collaborator works as in Manual.
  // How the collaborator works: as chosen, except that a model that can't call tools works as in Manual.
  const chosen: Work = !settings?.autoMode ? "manual" : settings.seminar ? "seminar" : "auto";
  const canAct = callsTools(infoOf(selected));
  const work: Work = canAct ? chosen : "manual";
  // How hard the model thinks: chosen per model, and remembered.
  const efforts = infoOf(selected)?.efforts ?? [];
  const effort = selected ? resolveEffort(infoOf(selected), settings?.efforts?.[effortKey(selected)]) : undefined;
  const setEffort = useCallback(
    (id: string) => {
      if (!selected || !settings) return;
      const next = { ...settings.efforts, [effortKey(selected)]: id };
      setSettings((s) => (s ? { ...s, efforts: next } : s));
      api.updateSettings({ efforts: next }).then(setSettings, (err) => console.error(err));
    },
    [selected, settings],
  );
  const setWork = useCallback((next: Work) => {
    const update = { autoMode: next !== "manual", seminar: next === "seminar" };
    setSettings((s) => (s ? { ...s, ...update } : s));
    api.updateSettings(update).then(setSettings, (err) => console.error(err));
  }, []);

  const changeChatgpt = useCallback(
    (session: ChatGptSession) => {
      setChatgpt(session);
      if (session.status !== "signingIn") void refreshModels();
    },
    [refreshModels],
  );

  // The introduction runs until it's finished once, and the workspace waits behind it.
  const onboarding = !!settings && !settings.onboarded;

  const finishWelcome = async (choice: WelcomeChoice, displayName: string) => {
    if (choice === "example") await workspace.addExample();
    else if (choice === "blank") await workspace.createDocument();
    setSettings(await api.updateSettings({ onboarded: true, displayName }));
  };

  const selectModel = (model: ModelRef) => {
    setSelected(model);
    api.updateSettings({ lastModel: model }).then(setSettings, console.error);
  };

  // A selection belongs to the document it came from, and so does a view of its original.
  useEffect(() => {
    setContext(null);
    setViewer(null);
  }, [doc?.id]);

  // Files dragged over the window can be dropped to import them.
  useEffect(() => {
    if (onboarding) return;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    const onEnter = (e: DragEvent) => {
      if (hasFiles(e)) {
        e.preventDefault();
        const active = document.activeElement;
        dropEditor.current = active instanceof HTMLTextAreaElement && active.matches(".block__source") ? active : null;
        setDragging(true);
      }
    };
    const onOver = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const onDrop = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
      setDragging(false);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [onboarding]);

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
      else collab.send(doc.id, selected, mode, "", ctx, false, [], work, effort);
    },
    [doc, numbered, selected, hasModel, collab, work, effort],
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

  // The document's macros and references, for its math, its citations and its references list.
  const [notationOpen, setNotationOpen] = useState<"macros" | "references" | null>(null);
  const read = useMemo(() => readNotation({ macros: doc?.macros, bibliography: doc?.bibliography }), [doc?.macros, doc?.bibliography]);
  const blocks = doc?.blocks;
  const signature = useMemo(() => (blocks ? citationSignature({ blocks }) : ""), [blocks]);
  const references = useMemo(() => citedReferences(read.bibliography, signature), [read, signature]);
  const notation = useMemo<Notation>(() => {
    const numbers = new Map(references.map((r) => [r.key, r.number]));
    const entries = new Map(read.bibliography.entries.map((e) => [e.key, e]));
    return {
      macros: read.macros.katex,
      number: (key) => numbers.get(key),
      describe: (key) => {
        const entry = entries.get(key);
        return entry && formatEntry(entry).replace(/\*+/g, "");
      },
    };
  }, [read, references]);

  // Export and print. Where an export went is said for a few seconds, with a way to it.
  const [notice, setNotice] = useState<{ text: string; path?: string; error?: boolean } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), notice.error ? 9000 : 6000);
    return () => window.clearTimeout(id);
  }, [notice]);
  const exportDoc = useCallback(async () => {
    if (!doc) return;
    try {
      const path = await exportLatex(doc, settings?.displayName ?? "");
      if (path) setNotice({ text: `Exported ${path.split(/[\\/]/).pop()}`, path });
    } catch (err) {
      setNotice({ text: `Couldn’t export: ${errorMessage(err)}`, error: true });
    }
  }, [doc, settings?.displayName]);
  /** The document being printed. It stays in the page until printing ends, as the dialog reads it late. */
  const [printing, setPrinting] = useState<string | null>(null);
  useEffect(() => {
    if (!printing) return;
    const done = () => setPrinting(null);
    window.addEventListener("afterprint", done);
    const id = window.setTimeout(done, 10 * 60_000);
    return () => {
      window.removeEventListener("afterprint", done);
      window.clearTimeout(id);
    };
  }, [printing]);
  const printDoc = useCallback(async () => {
    if (!doc) return;
    setPrinting(doc.id);
    // Let the print layout render, and its figures load, before the dialog reads the page.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await Promise.all([...document.querySelectorAll<HTMLImageElement>(".print-root img")].map((img) => img.decode().catch(() => {})));
    try {
      await api.printPage();
    } catch (err) {
      setNotice({ text: `Couldn’t print: ${errorMessage(err)}`, error: true });
    }
  }, [doc]);

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (onboarding) return;
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
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        pickFiles("new");
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "p" && doc) {
        e.preventDefault();
        void printDoc();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "e" && doc) {
        e.preventDefault();
        void exportDoc();
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
  }, [onboarding, newDocument, pickFiles, ask, acceptSuggestion, doc, focus, settingsOpen, paletteOpen, printDoc, exportDoc]);

  const commands: Command[] = [
    { id: "new-doc", label: "New document", hint: shortcut("N"), run: () => newDocument() },
    {
      id: "new-project",
      label: "New project",
      run: () => void workspace.createProject("Untitled project"),
    },
    { id: "import", label: "Import a paper, notes or file…", hint: shortcut("O"), run: () => pickFiles("new") },
    ...(doc
      ? [
          { id: "import-here", label: "Add a file to this document…", run: () => pickFiles("append") },
          { id: "notation", label: "Macros and references…", run: () => setNotationOpen("macros") },
          { id: "export-latex", label: "Export as LaTeX…", hint: shortcut("⇧E"), run: () => void exportDoc() },
          { id: "print", label: "Print or save as PDF…", hint: shortcut("P"), run: () => void printDoc() },
        ]
      : []),
    { id: "example", label: "Add the example project", run: () => void workspace.addExample() },
    { id: "tex", label: texMode ? "Show rendered document" : "Show TeX source", run: () => setTexMode((t) => !t) },
    { id: "focus", label: focus ? "Exit focus mode" : "Focus mode", hint: shortcut("."), run: () => setFocus((f) => !f) },
    {
      id: "auto",
      label: chosen !== "manual" ? "Collaborator: switch to Manual (propose only)" : "Collaborator: switch to Auto (work on the document)",
      run: () => setWork(chosen !== "manual" ? "manual" : "auto"),
    },
    {
      id: "seminar",
      label: chosen === "seminar" ? "Collaborator: work alone again (Auto)" : "Collaborator: switch to Seminar (several members at once)",
      run: () => setWork(chosen === "seminar" ? "auto" : "seminar"),
    },
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

  // Settings say whether to show the introduction; until they and the workspace are read, show nothing.
  if (!settings || !workspace.loaded) return <div className="app" data-tauri-drag-region />;

  if (onboarding) {
    return (
      <Welcome
        displayName={settings.displayName}
        hasDocuments={workspace.summaries.length > 0}
        providers={providers}
        modelsLoading={modelsLoading}
        chatgpt={chatgpt}
        lean={lean}
        onChatgptChange={changeChatgpt}
        onRefreshModels={() => void refreshModels()}
        onFinish={finishWelcome}
      />
    );
  }

  const project = doc ? workspace.projects.find((p) => p.id === doc.projectId) : undefined;
  const streaming = collab.streaming;
  const streamingHere = streaming && doc && streaming.docId === doc.id ? streaming.messageId : null;
  const pendingPins = [...new Map([...blockPins.values()].map((p) => [`${p.kind}${p.n}`, p])).values()];

  const continueImport = () => {
    if (!doc || !selected) return;
    setImportError(null);
    importer.resume(doc, selected, selectedVision).catch((err) => setImportError(errorMessage(err)));
  };

  return (
    <NotationContext.Provider value={notation}>
    <MediaContext.Provider value={doc?.id ?? null}>
    <div className={`app${focus ? " app--focus" : ""}`}>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        accept={ACCEPTED_FILES}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) setImporting({ files, target: pickTarget.current });
        }}
      />
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
          onImport={() => pickFiles("new")}
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
          onExport={() => void exportDoc()}
          onEditNotation={() => setNotationOpen("macros")}
          references={references}
          onPrint={() => void printDoc()}
          onAsk={ask}
          onAcceptSuggestion={acceptSuggestion}
          onRejectSuggestion={rejectSuggestion}
          onShowPage={doc.origin && doc.origin.kind !== "text" && doc.origin.files.length ? setViewer : undefined}
          banner={
            <>
              <ImportBanner
                doc={doc}
                job={importer.job}
                canContinue={hasModel && !importer.busy}
                model={selected}
                onStop={importer.stop}
                onDismiss={importer.dismiss}
                onContinue={continueImport}
                onShowOriginal={setViewer}
              />
              {importError && (
                <div className="import-banner import-banner--error" role="alert">
                  <div className="import-banner__text">
                    <span className="import-banner__title">{importError}</span>
                  </div>
                  <div className="import-banner__actions">
                    <button type="button" className="text-button" onClick={() => setImportError(null)}>
                      Dismiss
                    </button>
                  </div>
                </div>
              )}
            </>
          }
        />
      ) : (
        <EmptyMain
          loaded={workspace.loaded}
          shortcut={shortcut}
          onNew={() => newDocument()}
          onImport={() => pickFiles("new")}
          onSearch={() => setPaletteOpen(true)}
        />
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
            vision={selectedVision}
            dropped={composerDrop}
            work={chosen}
            canAct={canAct}
            efforts={efforts}
            effort={effort}
            onSetEffort={setEffort}
            onSetWork={setWork}
            onUndoAgent={collab.undoAgent}
            onSend={(mode, text, attachments) => selected && collab.send(doc.id, selected, mode, text, context, false, attachments, work, effort)}
            onStop={collab.stop}
            onRetry={(threadId) => selected && collab.retry(threadId, selected, work, effort)}
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
            onFollowUp={(mode, text) => selected && collab.send(doc.id, selected, mode, text, null, false, [], work, effort)}
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

      {importing && (
        <ImportDialog
          files={importing.files}
          openDocument={doc ? { id: doc.id, title: doc.title } : null}
          initialTarget={importing.target}
          providers={providers}
          modelsLoading={modelsLoading}
          model={selected}
          onSelectModel={selectModel}
          onRefreshModels={() => void refreshModels()}
          onOpenSettings={() => setSettingsOpen(true)}
          onClose={() => setImporting(null)}
          onStart={(plans) => {
            setImporting(null);
            setFocus(false);
            void importer.start(plans);
          }}
        />
      )}

      {dragging && !importing && (
        <DropOverlay
          documentTitle={doc ? doc.title : null}
          canAsk={!!doc && !panelCollapsed && !focus}
          canInsert={!!dropEditor.current?.isConnected}
          onCancel={() => setDragging(false)}
          onDrop={(files, target) => {
            setDragging(false);
            if (target === "ask") setComposerDrop({ files, nonce: Date.now() });
            else if (target === "insert") {
              dropEditor.current?.focus();
              dropEditor.current?.dispatchEvent(new CustomEvent("theoremis:insert-files", { detail: files }));
            } else setImporting({ files, target });
          }}
        />
      )}

      {viewer !== null && doc?.origin && <SourceViewer doc={doc} page={viewer} onClose={() => setViewer(null)} />}

      {settingsOpen && settings && (
        <SettingsDialog
          settings={settings}
          chatgpt={chatgpt}
          updates={updates}
          lean={lean}
          onChatgptChange={changeChatgpt}
          onClose={() => setSettingsOpen(false)}
          onSaved={(next) => {
            setSettings(next);
            setSettingsOpen(false);
            void refreshModels();
          }}
        />
      )}
      {doc && printing === doc.id && <PrintDocument doc={doc} numbered={numbered} author={settings?.displayName ?? ""} references={references} />}
      {doc && notationOpen && (
        <NotationDialog
          macros={doc.macros ?? ""}
          bibliography={doc.bibliography ?? ""}
          cited={new Set(signature ? signature.split(",") : [])}
          initialTab={notationOpen}
          onSave={(macros, bibliography) => {
            updateDoc((d) => ({ ...d, macros: macros.trim() ? macros : undefined, bibliography: bibliography.trim() ? bibliography : undefined }));
            setNotationOpen(null);
          }}
          onClose={() => setNotationOpen(null)}
        />
      )}
      {notice && (
        <div className={`toast${notice.error ? " toast--error" : ""}`} role={notice.error ? "alert" : "status"}>
          <span className="toast__text">{notice.text}</span>
          {notice.path && (
            <button type="button" className="text-button" onClick={() => void revealItemInDir(notice.path!).catch(() => {})}>
              {isMac ? "Show in Finder" : "Show in folder"}
            </button>
          )}
          <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setNotice(null)}>
            <Close size={9} />
          </button>
        </div>
      )}
    </div>
    </MediaContext.Provider>
    </NotationContext.Provider>
  );
}

function EmptyMain({
  loaded,
  shortcut,
  onNew,
  onImport,
  onSearch,
}: {
  loaded: boolean;
  shortcut: (keys: string) => string;
  onNew: () => void;
  onImport: () => void;
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
          <p>Open a document from the sidebar, start a new one, or import a paper or your notes.</p>
          <div className="empty-main__actions">
            <button type="button" className="button button--cream" onClick={onNew}>
              New document <kbd>{shortcut("N")}</kbd>
            </button>
            <button type="button" className="button button--ghost" onClick={onImport}>
              Import <kbd>{shortcut("O")}</kbd>
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
