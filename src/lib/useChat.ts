import { useCallback, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import { deriveTitle, newId } from "./text";
import type { ChatMessage, Conversation, Message, ModelRef } from "./types";

export function createConversation(): Conversation {
  const now = Date.now();
  return { id: newId(), title: "New chat", createdAt: now, updatedAt: now, model: null, messages: [] };
}

/** The history sent to the model: completed turns only, with the system prompt first. */
export function toChatMessages(messages: Message[], systemPrompt: string): ChatMessage[] {
  const history: ChatMessage[] = messages
    .filter((m) => !m.error && m.content.trim().length > 0)
    .map(({ role, content }) => ({ role, content }));
  const prompt = systemPrompt.trim();
  return prompt ? [{ role: "system", content: prompt }, ...history] : history;
}

function patchMessage(conversation: Conversation, id: string, patch: Partial<Message>): Conversation {
  return {
    ...conversation,
    messages: conversation.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
  };
}

interface Options {
  systemPrompt: string;
  /** Called after a conversation is written to disk, e.g. to refresh the sidebar. */
  onSaved: () => void;
}

/**
 * Owns the conversation on screen and the (at most one) reply streaming in.
 *
 * A reply keeps streaming into its own conversation even if the user switches away;
 * switching back shows the live copy rather than the stale one on disk.
 */
export function useChat({ systemPrompt, onSaved }: Options) {
  const [conversation, setConversation] = useState<Conversation>(createConversation);
  const [streaming, setStreaming] = useState<{ requestId: string; conversationId: string } | null>(
    null,
  );
  const shownId = useRef(conversation.id);
  const live = useRef<Conversation | null>(null);

  const show = useCallback((next: Conversation) => {
    shownId.current = next.id;
    setConversation(next);
  }, []);

  const commitLive = useCallback((next: Conversation) => {
    live.current = next;
    if (shownId.current === next.id) setConversation(next);
  }, []);

  const persist = useCallback(
    async (next: Conversation) => {
      try {
        await api.saveConversation(next);
        onSaved();
      } catch (err) {
        console.error("Failed to save conversation", err);
      }
    },
    [onSaved],
  );

  const run = useCallback(
    async (base: Conversation, model: ModelRef) => {
      const history = toChatMessages(base.messages, systemPrompt);
      const reply: Message = {
        id: newId(),
        role: "assistant",
        content: "",
        model,
        createdAt: Date.now(),
      };
      let current: Conversation = {
        ...base,
        model,
        updatedAt: Date.now(),
        messages: [...base.messages, reply],
      };
      commitLive(current);
      const requestId = newId();
      setStreaming({ requestId, conversationId: current.id });

      let content = "";
      let reasoning = "";
      let frame = 0;
      // Batch token updates to one render per animation frame.
      const flush = () => {
        frame = 0;
        current = patchMessage(current, reply.id, { content, reasoning: reasoning || undefined });
        commitLive(current);
      };

      let error: string | undefined;
      try {
        await api.streamChat({
          requestId,
          provider: model.provider,
          model: model.model,
          messages: history,
          onEvent: (event) => {
            if (event.type === "delta") content += event.text;
            else reasoning += event.text;
            if (!frame) frame = requestAnimationFrame(flush);
          },
        });
      } catch (err) {
        error = errorMessage(err);
      }
      if (frame) cancelAnimationFrame(frame);

      current = {
        ...patchMessage(current, reply.id, { content, reasoning: reasoning || undefined, error }),
        updatedAt: Date.now(),
      };
      commitLive(current);
      live.current = null;
      setStreaming(null);
      await persist(current);
    },
    [commitLive, persist, systemPrompt],
  );

  const send = useCallback(
    async (text: string, model: ModelRef) => {
      if (live.current) return;
      const message: Message = { id: newId(), role: "user", content: text, createdAt: Date.now() };
      const next: Conversation = {
        ...conversation,
        title: conversation.messages.length === 0 ? deriveTitle(text) : conversation.title,
        messages: [...conversation.messages, message],
      };
      await run(next, model);
    },
    [conversation, run],
  );

  /** Re-asks for the last reply, optionally with a different model. */
  const retry = useCallback(
    async (model: ModelRef) => {
      if (live.current) return;
      const messages = [...conversation.messages];
      while (messages.length && messages[messages.length - 1].role === "assistant") messages.pop();
      if (!messages.length) return;
      await run({ ...conversation, messages }, model);
    },
    [conversation, run],
  );

  const stop = useCallback(() => {
    if (streaming) void api.cancelChat(streaming.requestId);
  }, [streaming]);

  const open = useCallback(
    async (id: string) => {
      if (live.current?.id === id) return show(live.current);
      try {
        show(await api.loadConversation(id));
      } catch (err) {
        console.error("Failed to open conversation", err);
      }
    },
    [show],
  );

  const startNew = useCallback(() => show(createConversation()), [show]);

  return {
    conversation,
    isStreaming: streaming !== null && streaming.conversationId === conversation.id,
    isBusy: streaming !== null,
    streamingId: streaming?.conversationId ?? null,
    send,
    retry,
    stop,
    open,
    startNew,
  };
}
