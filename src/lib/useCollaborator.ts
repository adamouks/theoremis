import { useCallback, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import { splitProposals } from "./doc";
import { buildMessages, DEFAULT_REQUESTS } from "./prompts";
import { deriveTitle, newId } from "./text";
import type { Block, Context, Doc, Mode, ModelRef, Thread, ThreadMessage } from "./types";
import type { WorkspaceApi } from "./useWorkspace";

function patchThread(doc: Doc, threadId: string, fn: (thread: Thread) => Thread): Doc {
  return { ...doc, threads: doc.threads.map((t) => (t.id === threadId ? fn(t) : t)) };
}

function patchMessage(doc: Doc, threadId: string, messageId: string, patch: Partial<ThreadMessage>): Doc {
  return patchThread(doc, threadId, (t) => ({
    ...t,
    updatedAt: Date.now(),
    messages: t.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m)),
  }));
}

function findMessage(doc: Doc, threadId: string, messageId: string) {
  return doc.threads.find((t) => t.id === threadId)?.messages.find((m) => m.id === messageId);
}

const THREAD_VERBS: Record<Mode, string> = {
  ask: "About",
  explore: "Exploring",
  gaps: "Review of",
  challenge: "Challenging",
  formalize: "Formalizing",
};

export function createThread(): Thread {
  const now = Date.now();
  return { id: newId(), title: "New thread", createdAt: now, updatedAt: now, messages: [] };
}

interface Streaming {
  requestId: string;
  docId: string;
  threadId: string;
  messageId: string;
}

/**
 * The collaborator side of a document: asking in a mode, streaming replies into the
 * document's threads, and turning replies into revisions or suggestions.
 */
export function useCollaborator(workspace: WorkspaceApi, systemPrompt: string) {
  const { updateDoc, mutateDocument, currentDocId } = workspace;
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  const busy = useRef(false);

  const run = useCallback(
    async (doc: Doc, thread: Thread, model: ModelRef) => {
      const reply: ThreadMessage = {
        id: newId(),
        role: "assistant",
        content: "",
        mode: thread.messages[thread.messages.length - 1]?.mode ?? "ask",
        model,
        createdAt: Date.now(),
      };
      const messages = buildMessages(doc, thread, systemPrompt);
      const context = [...thread.messages].reverse().find((m) => m.role === "user")?.context;
      const requestId = newId();
      busy.current = true;
      setStreaming({ requestId, docId: doc.id, threadId: thread.id, messageId: reply.id });
      mutateDocument(
        doc.id,
        (d) => patchThread(d, thread.id, (t) => ({ ...t, updatedAt: Date.now(), messages: [...t.messages, reply] })),
        "meta",
      );

      let content = "";
      let reasoning = "";
      let frame = 0;
      const flush = () => {
        frame = 0;
        mutateDocument(doc.id, (d) => patchMessage(d, thread.id, reply.id, { content, reasoning: reasoning || undefined }));
      };
      let error: string | undefined;
      try {
        await api.streamChat({
          requestId,
          provider: model.provider,
          model: model.model,
          messages,
          onEvent: (event) => {
            if (event.type === "delta") content += event.text;
            else reasoning += event.text;
            // Only the open document re-renders while streaming; others are written at the end.
            if (!frame && currentDocId() === doc.id) frame = requestAnimationFrame(flush);
          },
        });
      } catch (err) {
        error = errorMessage(err);
      }
      if (frame) cancelAnimationFrame(frame);

      const proposed = content && context?.blockId ? splitProposals(content).revision : null;
      mutateDocument(doc.id, (d) =>
        patchMessage(d, thread.id, reply.id, {
          content,
          reasoning: reasoning || undefined,
          error,
          revision:
            proposed && context?.blockId && d.blocks.some((b) => b.id === context.blockId)
              ? { blockId: context.blockId, text: proposed, state: "pending" }
              : undefined,
        }),
      );
      busy.current = false;
      setStreaming(null);
    },
    [mutateDocument, currentDocId, systemPrompt],
  );

  /** Asks in `mode` about `context`, in the document's active thread (or a new one). */
  const send = useCallback(
    (docId: string, model: ModelRef, mode: Mode, text: string, context: Context | null, newThread = false) => {
      if (busy.current) return;
      const content = text.trim() || DEFAULT_REQUESTS[mode];
      if (!content && !context) return;
      const out: { doc?: Doc; thread?: Thread } = {};
      updateDoc((d) => {
        if (d.id !== docId) return d;
        const existing = newThread ? undefined : d.threads.find((t) => t.id === d.activeThreadId);
        const base = existing ?? createThread();
        const message: ThreadMessage = {
          id: newId(),
          role: "user",
          content,
          mode,
          ...(context ? { context } : {}),
          createdAt: Date.now(),
        };
        const title =
          base.messages.length > 0
            ? base.title
            : context
              ? `${THREAD_VERBS[mode]} ${context.label}`
              : deriveTitle(content, 48) || "New thread";
        const thread: Thread = { ...base, title, updatedAt: Date.now(), messages: [...base.messages, message] };
        out.thread = thread;
        out.doc = {
          ...d,
          activeThreadId: thread.id,
          threads: existing ? d.threads.map((t) => (t.id === thread.id ? thread : t)) : [...d.threads, thread],
        };
        return out.doc;
      }, "meta");
      if (out.doc && out.thread) void run(out.doc, out.thread, model);
    },
    [run, updateDoc],
  );

  /** Replaces the last reply in a thread with a fresh one. */
  const retry = useCallback(
    (threadId: string, model: ModelRef) => {
      if (busy.current) return;
      const out: { doc?: Doc; thread?: Thread } = {};
      updateDoc((d) => {
        const thread = d.threads.find((t) => t.id === threadId);
        if (!thread) return d;
        const messages = [...thread.messages];
        while (messages.length && messages[messages.length - 1].role === "assistant") messages.pop();
        if (!messages.length) return d;
        out.thread = { ...thread, messages };
        out.doc = patchThread(d, threadId, () => out.thread!);
        return out.doc;
      }, "meta");
      if (out.doc && out.thread) void run(out.doc, out.thread, model);
    },
    [run, updateDoc],
  );

  const stop = useCallback(() => {
    if (streaming) void api.cancelChat(streaming.requestId);
  }, [streaming]);

  const acceptRevision = useCallback(
    (threadId: string, messageId: string) =>
      updateDoc((d) => {
        const revision = findMessage(d, threadId, messageId)?.revision;
        const target = revision && d.blocks.find((b) => b.id === revision.blockId);
        if (!revision || !target) return d;
        const withBlock = { ...d, blocks: d.blocks.map((b) => (b.id === target.id ? { ...b, source: revision.text } : b)) };
        return patchMessage(withBlock, threadId, messageId, {
          revision: { ...revision, state: "accepted", previous: target.source },
        });
      }),
    [updateDoc],
  );

  const rejectRevision = useCallback(
    (threadId: string, messageId: string) =>
      updateDoc((d) => {
        const revision = findMessage(d, threadId, messageId)?.revision;
        return revision ? patchMessage(d, threadId, messageId, { revision: { ...revision, state: "rejected" } }) : d;
      }, "meta"),
    [updateDoc],
  );

  const undoRevision = useCallback(
    (threadId: string, messageId: string) =>
      updateDoc((d) => {
        const revision = findMessage(d, threadId, messageId)?.revision;
        if (!revision) return d;
        const restored =
          revision.state === "accepted" && revision.previous !== undefined
            ? {
                ...d,
                blocks: d.blocks.map((b) => (b.id === revision.blockId ? { ...b, source: revision.previous! } : b)),
              }
            : d;
        return patchMessage(restored, threadId, messageId, {
          revision: { blockId: revision.blockId, text: revision.text, state: "pending" },
        });
      }),
    [updateDoc],
  );

  /** Puts a reply into the document as a suggestion block, right after what it was about. */
  const insertSuggestion = useCallback(
    (threadId: string, messageId: string) =>
      updateDoc((d) => {
        const message = findMessage(d, threadId, messageId);
        if (!message?.content.trim()) return d;
        const thread = d.threads.find((t) => t.id === threadId);
        const question = [...(thread?.messages ?? [])]
          .slice(0, thread?.messages.findIndex((m) => m.id === messageId))
          .reverse()
          .find((m) => m.role === "user");
        const block: Block = {
          id: newId(),
          source: (() => {
            const parts = splitProposals(message.content);
            return parts.addition ?? parts.revision ?? message.content.trim();
          })(),
          suggestion: { threadId, messageId },
        };
        const anchor = question?.context?.blockId ? d.blocks.findIndex((b) => b.id === question.context!.blockId) : -1;
        const blocks = [...d.blocks];
        blocks.splice(anchor >= 0 ? anchor + 1 : blocks.length, 0, block);
        return patchMessage({ ...d, blocks }, threadId, messageId, { insertedBlockId: block.id });
      }),
    [updateDoc],
  );

  return {
    streaming,
    send,
    retry,
    stop,
    acceptRevision,
    rejectRevision,
    undoRevision,
    insertSuggestion,
  };
}

export type CollaboratorApi = ReturnType<typeof useCollaborator>;
