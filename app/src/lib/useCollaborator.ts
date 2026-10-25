import { useCallback, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import { splitProposals } from "./doc";
import { AGENT_TOOLS, Handles, MAX_ROUNDS, undoRun, type AgentEnv } from "./agent";
import { agentLoop, type Mind } from "./agentLoop";
import { CONVENE, LONE_MEMBER, MEMBER_ROUNDS, concurrency, pool, readConvene, type Member } from "./seminar";
import { loadAttachmentImages } from "./attachments";
import { buildAgentMessages, buildConveneMessages, buildMemberMessages, buildMessages, buildSummaryMessages, DEFAULT_REQUESTS, threadImages } from "./prompts";
import { deriveTitle, newId } from "./text";
import type {
  AgentRun,
  Attachment,
  Block,
  ChatMessage,
  Context,
  Doc,
  Mode,
  ModelRef,
  SeminarRun,
  StoredLeanCheck,
  StreamEvent,
  Thread,
  ThreadMessage,
  ToolSpec,
  Work,
} from "./types";
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

/** Whole seconds a model reasoned, at least one, or nothing if it didn't. */
function seconds(ms: number): number | undefined {
  return ms > 0 ? Math.max(1, Math.round(ms / 1000)) : undefined;
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
export function useCollaborator(workspace: WorkspaceApi, systemPrompt: string, canSee: (model: ModelRef) => boolean) {
  const { updateDoc, mutateDocument, transactDocument, currentDocId } = workspace;
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  const busy = useRef(false);
  const sees = useRef(canSee);
  sees.current = canSee;
  const summaries = useRef(workspace.summaries);
  summaries.current = workspace.summaries;
  /** The Auto reply asked to stop; it finishes the tool it is running, then stops. */
  const stopping = useRef<string | null>(null);

  /** Requests in flight for each reply, so Stop reaches every member of a seminar. */
  const inFlight = useRef(new Map<string, Set<string>>());
  const track = useCallback((replyId: string, requestId: string, active: boolean) => {
    const ids = inFlight.current.get(replyId) ?? new Set<string>();
    if (active) ids.add(requestId);
    else ids.delete(requestId);
    if (ids.size) inFlight.current.set(replyId, ids);
    else inFlight.current.delete(replyId);
    if (active) setStreaming((s) => (s && s.messageId === replyId ? { ...s, requestId } : s));
  }, []);

  /** What the tools act through, for a reply working on `doc`. */
  const environment = useCallback(
    (doc: Doc, thread: Thread, replyId: string, seen?: Map<string, string>): AgentEnv => ({
      transact: (fn) => transactDocument(doc.id, fn, "content"),
      read: (id) => transactDocument(id, (d) => ({ doc: d, result: d }), "meta"),
      documents: summaries.current.filter((d) => d.projectId === doc.projectId && d.id !== doc.id),
      lean: (code) => api.leanCheck(code),
      origin: { threadId: thread.id, messageId: replyId },
      ...(seen ? { seen } : {}),
    }),
    [transactDocument],
  );

  /** Auto mode: rounds of reply and tool calls, each tool run on the document as it is then. */
  const runAgent = useCallback(
    async (doc: Doc, thread: Thread, model: ModelRef, effort: string | undefined, replyId: string, images: Map<string, string>) => {
      const handles = new Handles(doc.blocks);
      const history: ChatMessage[] = buildAgentMessages(doc, thread, systemPrompt, handles, images);
      const run: AgentRun = { status: "running", steps: [], changes: [] };
      const leanChecks: StoredLeanCheck[] = [];
      const mind: Mind = { reasoning: "", thought: 0 };
      let frame = 0;
      const content = () =>
        run.steps
          .flatMap((step) => (step.kind === "text" && step.text.trim() ? [step.text.trim()] : []))
          .join("\n\n");
      const publish = (error?: string) => {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        mutateDocument(doc.id, (d) =>
          patchMessage(d, thread.id, replyId, {
            content: content(),
            reasoning: mind.reasoning || undefined,
            thoughtSeconds: seconds(mind.thought),
            agent: { ...run, steps: run.steps.map((step) => ({ ...step })), changes: [...run.changes] },
            ...(leanChecks.length ? { leanChecks: [...leanChecks] } : {}),
            ...(error ? { error } : {}),
          }),
        );
      };
      // Deltas repaint once a frame, and only for the open document; tool steps are written at once.
      const soon = () => {
        if (!frame && currentDocId() === doc.id) frame = requestAnimationFrame(() => publish());
      };

      try {
        const { end } = await agentLoop({
          model,
          effort,
          history,
          tools: AGENT_TOOLS,
          env: environment(doc, thread, replyId),
          handles,
          steps: run.steps,
          record: (changes) => run.changes.push(...changes),
          leanChecks,
          mind,
          maxRounds: MAX_ROUNDS,
          stopped: () => stopping.current === replyId,
          onRequest: (requestId, active) => track(replyId, requestId, active),
          onStream: soon,
          onStep: () => publish(),
        });
        run.status = end;
        run.finishedAt = Date.now();
        publish();
      } catch (err) {
        run.status = "failed";
        run.finishedAt = Date.now();
        publish(errorMessage(err));
      }
    },
    [systemPrompt, mutateDocument, currentDocId, environment, track],
  );

  /**
   * Seminar mode: the chair convenes members with one objective each, they work on the document
   * at the same time, and the chair sums up. Members only overwrite blocks as they last saw them.
   */
  const runSeminar = useCallback(
    async (doc: Doc, thread: Thread, model: ModelRef, effort: string | undefined, replyId: string, images: Map<string, string>) => {
      const handles = new Handles(doc.blocks);
      const seminar: SeminarRun = { status: "convening", members: [], changes: [] };
      const leanChecks: StoredLeanCheck[] = [];
      let summary = "";
      let frame = 0;
      const publish = (error?: string) => {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        mutateDocument(doc.id, (d) =>
          patchMessage(d, thread.id, replyId, {
            content: summary.trim(),
            seminar: {
              ...seminar,
              members: seminar.members.map((m) => ({ ...m, steps: m.steps.map((step) => ({ ...step })) })),
              changes: [...seminar.changes],
            },
            ...(leanChecks.length ? { leanChecks: [...leanChecks] } : {}),
            ...(error ? { error } : {}),
          }),
        );
      };
      const soon = () => {
        if (!frame && currentDocId() === doc.id) frame = requestAnimationFrame(() => publish());
      };
      const stopped = () => stopping.current === replyId;
      const latest = () => transactDocument(doc.id, (d) => ({ doc: d, result: d }), "meta");
      /** One request without tools, streamed into `onText`. */
      const ask = async (messages: ChatMessage[], tools: ToolSpec[], onEvent: (event: StreamEvent) => void) => {
        const requestId = newId();
        track(replyId, requestId, true);
        try {
          return await api.streamChat({ requestId, provider: model.provider, model: model.model, messages, tools, effort, onEvent });
        } finally {
          track(replyId, requestId, false);
        }
      };

      try {
        // The chair decides who works on what.
        let plan: Member[] | null = null;
        const convened = await ask(buildConveneMessages(doc, thread, systemPrompt, handles, images), [CONVENE], (event) => {
          if (event.type === "toolCall" && event.name === CONVENE.name) plan ??= readConvene(event.arguments, handles);
        });
        if (convened.cancelled || stopped()) {
          seminar.status = "stopped";
          seminar.finishedAt = Date.now();
          return publish();
        }
        const members = plan ?? [LONE_MEMBER];
        seminar.members = members.map((m) => ({ id: newId(), role: m.role, objective: m.objective, blocks: m.blocks, status: "waiting", steps: [], changed: 0 }));
        seminar.status = "working";
        publish();

        // The members work at the same time, each on the document as it is when it starts.
        await pool(seminar.members, concurrency(model), async (member) => {
          if (stopped()) {
            member.status = "stopped";
            return publish();
          }
          const brief = members[seminar.members.indexOf(member)];
          member.status = "working";
          member.startedAt = Date.now();
          publish();
          try {
            const now = await latest();
            const seen = new Map(now.blocks.map((b) => [b.id, b.source]));
            const { end, said } = await agentLoop({
              model,
              effort,
              history: buildMemberMessages(now, thread, systemPrompt, handles, images, brief, members),
              tools: AGENT_TOOLS,
              env: environment(doc, thread, replyId, seen),
              handles,
              steps: member.steps,
              // Into the seminar's one list, so Undo takes them back in the order they happened.
              record: (changes) => {
                member.changed += changes.length;
                seminar.changes.push(...changes);
              },
              leanChecks,
              mind: { reasoning: "", thought: 0 },
              maxRounds: MEMBER_ROUNDS,
              stopped,
              onRequest: (requestId, active) => track(replyId, requestId, active),
              onStream: soon,
              onStep: () => publish(),
            });
            member.report = said.trim() || undefined;
            member.status = end === "stopped" ? "stopped" : "done";
          } catch (err) {
            member.status = "failed";
            member.error = errorMessage(err);
          }
          member.finishedAt = Date.now();
          publish();
        });
        if (stopped()) {
          seminar.status = "stopped";
          seminar.finishedAt = Date.now();
          return publish();
        }

        // The chair sums up from the reports and the document as it now is.
        seminar.status = "summing";
        publish();
        const reports = seminar.members.map((m) => ({ role: m.role, objective: m.objective, report: m.report ?? (m.error ? `Failed: ${m.error}` : "") }));
        const summed = await ask(buildSummaryMessages(await latest(), thread, systemPrompt, handles, reports), [], (event) => {
          if (event.type === "delta") {
            summary += event.text;
            soon();
          }
        });
        seminar.status = summed.cancelled ? "stopped" : "done";
        seminar.finishedAt = Date.now();
        publish();
      } catch (err) {
        seminar.status = "failed";
        seminar.finishedAt = Date.now();
        publish(errorMessage(err));
      }
    },
    [systemPrompt, mutateDocument, currentDocId, transactDocument, environment, track],
  );

  const run = useCallback(
    async (doc: Doc, thread: Thread, model: ModelRef, work: Work, effort: string | undefined) => {
      const reply: ThreadMessage = {
        id: newId(),
        role: "assistant",
        content: "",
        mode: thread.messages[thread.messages.length - 1]?.mode ?? "ask",
        model,
        ...(effort ? { effort } : {}),
        ...(work === "auto" ? { agent: { status: "running", steps: [], changes: [] } } : {}),
        ...(work === "seminar" ? { seminar: { status: "convening", members: [], changes: [] } } : {}),
        createdAt: Date.now(),
      };
      const context = [...thread.messages].reverse().find((m) => m.role === "user")?.context;
      const requestId = newId();
      busy.current = true;
      setStreaming({ requestId, docId: doc.id, threadId: thread.id, messageId: reply.id });
      mutateDocument(
        doc.id,
        (d) => patchThread(d, thread.id, (t) => ({ ...t, updatedAt: Date.now(), messages: [...t.messages, reply] })),
        "meta",
      );
      const names = sees.current(model) ? threadImages(thread) : [];
      const images = names.length ? await loadAttachmentImages(doc.id, names) : new Map<string, string>();
      if (work !== "manual") {
        stopping.current = null;
        await (work === "seminar" ? runSeminar : runAgent)(doc, thread, model, effort, reply.id, images);
        busy.current = false;
        setStreaming(null);
        return;
      }
      const messages = buildMessages(doc, thread, systemPrompt, images);

      let content = "";
      let reasoning = "";
      const asked = performance.now();
      let reasoned = 0;
      let frame = 0;
      const flush = () => {
        frame = 0;
        mutateDocument(doc.id, (d) =>
          patchMessage(d, thread.id, reply.id, { content, reasoning: reasoning || undefined, thoughtSeconds: reasoned ? seconds(reasoned - asked) : undefined }),
        );
      };
      let error: string | undefined;
      try {
        await api.streamChat({
          requestId,
          provider: model.provider,
          model: model.model,
          messages,
          effort,
          onEvent: (event) => {
            if (event.type === "delta") content += event.text;
            else if (event.type === "reasoning") {
              reasoning += event.text;
              reasoned = performance.now();
            }
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
          thoughtSeconds: reasoned ? seconds(reasoned - asked) : undefined,
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
    [mutateDocument, currentDocId, systemPrompt, runAgent, runSeminar],
  );

  /** Asks in `mode` about `context`, in the document's active thread (or a new one). */
  const send = useCallback(
    (
      docId: string,
      model: ModelRef,
      mode: Mode,
      text: string,
      context: Context | null,
      newThread = false,
      attachments: Attachment[] = [],
      work: Work = "manual",
      effort?: string,
    ) => {
      if (busy.current) return;
      const content = text.trim() || DEFAULT_REQUESTS[mode];
      if (!content && !context && !attachments.length) return;
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
          ...(attachments.length ? { attachments } : {}),
          createdAt: Date.now(),
        };
        const title =
          base.messages.length > 0
            ? base.title
            : context
              ? `${THREAD_VERBS[mode]} ${context.label}`
              : deriveTitle(content, 48) || (attachments[0] ? `About ${attachments[0].name}` : "New thread");
        const thread: Thread = { ...base, title, updatedAt: Date.now(), messages: [...base.messages, message] };
        out.thread = thread;
        out.doc = {
          ...d,
          activeThreadId: thread.id,
          threads: existing ? d.threads.map((t) => (t.id === thread.id ? thread : t)) : [...d.threads, thread],
        };
        return out.doc;
      }, "meta");
      if (out.doc && out.thread) void run(out.doc, out.thread, model, work, effort);
    },
    [run, updateDoc],
  );

  /** Replaces the last reply in a thread with a fresh one. */
  const retry = useCallback(
    (threadId: string, model: ModelRef, work: Work = "manual", effort?: string) => {
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
      if (out.doc && out.thread) void run(out.doc, out.thread, model, work, effort);
    },
    [run, updateDoc],
  );

  const stop = useCallback(() => {
    if (!streaming) return;
    stopping.current = streaming.messageId;
    void api.cancelChat(streaming.requestId);
    for (const id of inFlight.current.get(streaming.messageId) ?? []) void api.cancelChat(id);
  }, [streaming]);

  /** Takes back every change an Auto or Seminar reply made. */
  const undoAgent = useCallback(
    (threadId: string, messageId: string) =>
      updateDoc((d) => {
        const message = findMessage(d, threadId, messageId);
        const agent = message?.agent;
        if (agent && !agent.undone && agent.status !== "running" && agent.changes.length) {
          return patchMessage(undoRun(d, agent), threadId, messageId, { agent: { ...agent, undone: true } });
        }
        const seminar = message?.seminar;
        const settled = seminar && ["done", "stopped", "failed"].includes(seminar.status);
        if (seminar && settled && !seminar.undone && seminar.changes.length) {
          return patchMessage(undoRun(d, seminar), threadId, messageId, { seminar: { ...seminar, undone: true } });
        }
        return d;
      }),
    [updateDoc],
  );

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

  /** Keeps Lean's verdict with the reply it checked, replacing any earlier check of the same code. */
  const recordLeanCheck = useCallback(
    (threadId: string, messageId: string, check: StoredLeanCheck) =>
      updateDoc((d) => {
        const message = findMessage(d, threadId, messageId);
        if (!message) return d;
        const leanChecks = [...(message.leanChecks ?? []).filter((c) => c.code !== check.code), check];
        return patchMessage(d, threadId, messageId, { leanChecks });
      }, "meta"),
    [updateDoc],
  );

  return {
    streaming,
    send,
    recordLeanCheck,
    retry,
    stop,
    undoAgent,
    acceptRevision,
    rejectRevision,
    undoRevision,
    insertSuggestion,
  };
}

export type CollaboratorApi = ReturnType<typeof useCollaborator>;
