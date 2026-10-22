import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import { createDocument, withSummary } from "./doc";
import { exampleWorkspace } from "./seed";
import { newId } from "./text";
import type { Doc, DocumentSummary, Project, Workspace } from "./types";

const SEEDED_KEY = "theoremis.seeded";
const LAST_DOC_KEY = "theoremis.lastDocument";
const SAVE_DELAY = 600;

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // These are conveniences; nothing breaks without them.
  }
}

let initialLoad: Promise<Workspace> | null = null;

/**
 * Loads the workspace, creating the example project on the very first launch. Shared, so
 * React's double-mounting in development can't seed twice.
 */
function loadInitialWorkspace(): Promise<Workspace> {
  initialLoad ??= (async () => {
    const ws = await api.loadWorkspace();
    if (ws.projects.length > 0 || ws.documents.length > 0 || storageGet(SEEDED_KEY)) return ws;
    const example = exampleWorkspace();
    await api.saveProjects([example.project]);
    for (const d of example.documents) await api.saveDocument(d);
    storageSet(SEEDED_KEY, "1");
    return api.loadWorkspace();
  })();
  return initialLoad;
}

/** "content" edits bump the revision; "meta" ones (threads, folding) don't. */
export type ChangeKind = "content" | "meta";
export type SaveState = "saved" | "saving" | "error";

/**
 * Projects, the document list and the open document, kept in sync with disk.
 * Edits to the open document are saved automatically after a short pause.
 */
export function useWorkspace() {
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [summaries, setSummaries] = useState<DocumentSummary[]>([]);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");

  const current = useRef<Doc | null>(null);
  const dirty = useRef(false);
  const contentChanged = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const projectsRef = useRef<Project[]>([]);
  // Every write goes through one chain, so saves land on disk in the order they were made.
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = chain.current.then(task, task);
    chain.current = run.catch(() => undefined);
    return run;
  }, []);

  const recordSummary = useCallback((summary: DocumentSummary) => {
    setSummaries((list) =>
      [...list.filter((s) => s.id !== summary.id), summary].sort((a, b) => a.createdAt - b.createdAt),
    );
  }, []);

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const pending = current.current;
    if (!pending || !dirty.current) return chain.current;
    const bump = contentChanged.current;
    dirty.current = false;
    contentChanged.current = false;
    const next = withSummary({
      ...pending,
      revision: pending.revision + (bump ? 1 : 0),
      updatedAt: bump ? Date.now() : pending.updatedAt,
    });
    return enqueue(async () => {
      try {
        const summary = await api.saveDocument(next);
        // Fold the saved metadata back in without clobbering edits made meanwhile.
        const merge = (d: Doc | null) =>
          d && d.id === next.id
            ? { ...d, revision: next.revision, updatedAt: next.updatedAt, status: next.status, pending: next.pending }
            : d;
        current.current = merge(current.current);
        setDoc(merge);
        recordSummary(summary);
        if (!dirty.current) setSaveState("saved");
      } catch (err) {
        console.error("Failed to save document", err);
        if (current.current?.id === next.id) {
          dirty.current = true;
          contentChanged.current ||= bump;
        }
        setSaveState("error");
      }
    });
  }, [enqueue, recordSummary]);

  const updateDoc = useCallback(
    (fn: (doc: Doc) => Doc, kind: ChangeKind = "content") => {
      const prev = current.current;
      if (!prev) return;
      const next = fn(prev);
      if (next === prev) return;
      current.current = next;
      dirty.current = true;
      if (kind === "content") contentChanged.current = true;
      setDoc(next);
      setSaveState("saving");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), SAVE_DELAY);
    },
    [flush],
  );

  /** Changes any document: the open one in place, others on disk. */
  const mutateDocument = useCallback(
    (id: string, fn: (doc: Doc) => Doc, kind: ChangeKind = "meta") => {
      if (current.current?.id === id) {
        updateDoc(fn, kind);
        return;
      }
      void enqueue(async () => {
        try {
          const changed = fn(await api.loadDocument(id));
          const next = withSummary(
            kind === "content" ? { ...changed, revision: changed.revision + 1, updatedAt: Date.now() } : changed,
          );
          recordSummary(await api.saveDocument(next));
        } catch (err) {
          console.error("Failed to update document", err);
        }
      });
    },
    [updateDoc, enqueue, recordSummary],
  );

  const openDocument = useCallback(
    async (id: string | null) => {
      if (current.current?.id === id) return;
      await flush();
      if (!id) {
        current.current = null;
        setDoc(null);
        return;
      }
      try {
        const next = await enqueue(() => api.loadDocument(id));
        current.current = next;
        dirty.current = false;
        contentChanged.current = false;
        setDoc(next);
        setSaveState("saved");
        storageSet(LAST_DOC_KEY, id);
      } catch (err) {
        console.error("Failed to open document", err);
      }
    },
    [flush, enqueue],
  );

  const writeProjects = useCallback(
    async (next: Project[]) => {
      projectsRef.current = next;
      setProjects(next);
      try {
        await enqueue(() => api.saveProjects(next));
      } catch (err) {
        console.error("Failed to save projects", err);
      }
    },
    [enqueue],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ws = await loadInitialWorkspace();
        if (cancelled) return;
        projectsRef.current = ws.projects;
        setProjects(ws.projects);
        setSummaries(ws.documents);
        const last = storageGet(LAST_DOC_KEY);
        const first = ws.documents.find((d) => d.id === last) ?? ws.documents[0];
        if (first) await openDocument(first.id);
        setLoaded(true);
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openDocument]);

  // Don't lose the last keystrokes when the window closes.
  useEffect(() => {
    const onHide = () => void flush();
    window.addEventListener("beforeunload", onHide);
    return () => window.removeEventListener("beforeunload", onHide);
  }, [flush]);

  const createProject = useCallback(
    async (name: string) => {
      const project: Project = {
        id: newId(),
        name: name.trim() || "Untitled project",
        createdAt: Date.now(),
        collapsed: false,
      };
      await writeProjects([...projectsRef.current, project]);
      return project;
    },
    [writeProjects],
  );

  const updateProject = useCallback(
    (id: string, patch: Partial<Project>) =>
      writeProjects(projectsRef.current.map((p) => (p.id === id ? { ...p, ...patch } : p))),
    [writeProjects],
  );

  const deleteProject = useCallback(
    async (id: string) => {
      if (current.current?.projectId === id) await openDocument(null);
      const doomed = summaries.filter((s) => s.projectId === id);
      await enqueue(async () => {
        for (const d of doomed) await api.deleteDocument(d.id);
      });
      setSummaries((list) => list.filter((s) => s.projectId !== id));
      await writeProjects(projectsRef.current.filter((p) => p.id !== id));
    },
    [summaries, openDocument, enqueue, writeProjects],
  );

  const createDocumentIn = useCallback(
    async (projectId?: string) => {
      let target = projectId ?? current.current?.projectId ?? projectsRef.current[0]?.id;
      if (!target) target = (await createProject("Untitled project")).id;
      if (projectsRef.current.find((p) => p.id === target)?.collapsed) {
        await updateProject(target, { collapsed: false });
      }
      const fresh = createDocument(target);
      recordSummary(await enqueue(() => api.saveDocument(fresh)));
      await openDocument(fresh.id);
      return fresh;
    },
    [createProject, updateProject, recordSummary, enqueue, openDocument],
  );

  const deleteDocument = useCallback(
    async (id: string) => {
      if (current.current?.id === id) {
        window.clearTimeout(timer.current);
        dirty.current = false;
        current.current = null;
        setDoc(null);
      }
      await enqueue(() => api.deleteDocument(id));
      setSummaries((list) => list.filter((s) => s.id !== id));
    },
    [enqueue],
  );

  const currentDocId = useCallback(() => current.current?.id ?? null, []);

  return {
    loaded,
    loadError,
    currentDocId,
    projects,
    summaries,
    doc,
    saveState,
    /** Saves pending edits now; resolves once they're on disk. */
    flush,
    openDocument,
    updateDoc,
    mutateDocument,
    createProject,
    updateProject,
    deleteProject,
    createDocument: createDocumentIn,
    deleteDocument,
  };
}

export type WorkspaceApi = ReturnType<typeof useWorkspace>;
