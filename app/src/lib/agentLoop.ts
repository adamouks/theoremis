// The loop behind Auto mode, shared by Auto replies and Seminar members: ask the model, run each
// tool it calls on the document as it is then, send the results back, and repeat until it
// answers without calling one.

import { api } from "./api";
import { runTool, type AgentEnv, type Handles } from "./agent";
import { newId } from "./text";
import type { AgentChange, AgentStep, ChatMessage, ModelRef, StoredLeanCheck, ToolCall, ToolSpec } from "./types";

/** What the model thought along the way. */
export interface Mind {
  reasoning: string;
  /** Milliseconds spent reasoning: in each round, from the request to its last reasoning. */
  thought: number;
}

export interface Loop {
  model: ModelRef;
  effort?: string;
  /** The conversation so far. The model's turns and the tools' results are added to it. */
  history: ChatMessage[];
  tools: ToolSpec[];
  env: AgentEnv;
  handles: Handles;
  /** Where its steps go, as they happen. */
  steps: AgentStep[];
  /** Keeps its changes to the document, for Undo. */
  record: (changes: AgentChange[]) => void;
  leanChecks: StoredLeanCheck[];
  mind: Mind;
  maxRounds: number;
  /** Asked to stop: it finishes the tool it is running, then stops. */
  stopped: () => boolean;
  /** Each request as it starts and ends, so Stop can cancel it. */
  onRequest: (requestId: string, active: boolean) => void;
  /** Text or reasoning arrived: repaint soon. */
  onStream: () => void;
  /** A step started or finished: write it now. */
  onStep: () => void;
}

export type LoopEnd = "done" | "stopped" | "limit";

/** Runs the loop. Returns how it ended and what the model said in its last turn. */
export async function agentLoop(o: Loop): Promise<{ end: LoopEnd; said: string }> {
  let said = "";
  for (let round = 0; ; round++) {
    if (o.stopped()) return { end: "stopped", said };
    if (round === o.maxRounds) return { end: "limit", said };
    const requestId = newId();
    said = "";
    const asked = performance.now();
    let reasoned = 0;
    let step: Extract<AgentStep, { kind: "text" }> | null = null;
    const calls: ToolCall[] = [];
    const opaque: unknown[] = [];
    o.onRequest(requestId, true);
    let outcome: { cancelled: boolean };
    try {
      outcome = await api.streamChat({
        requestId,
        provider: o.model.provider,
        model: o.model.model,
        messages: o.history,
        tools: o.tools,
        effort: o.effort,
        onEvent: (event) => {
          if (event.type === "delta") {
            said += event.text;
            if (!step) o.steps.push((step = { kind: "text", text: "" }));
            step.text = said;
            o.onStream();
          } else if (event.type === "reasoning") {
            o.mind.reasoning += event.text;
            reasoned = performance.now();
            o.onStream();
          } else if (event.type === "toolCall") {
            calls.push({ id: event.id, name: event.name, arguments: event.arguments });
          } else {
            opaque.push(event.item);
          }
        },
      });
    } finally {
      o.onRequest(requestId, false);
    }
    if (reasoned) o.mind.thought += reasoned - asked;
    if (outcome.cancelled) return { end: "stopped", said };
    o.history.push({ role: "assistant", content: said, ...(calls.length ? { toolCalls: calls } : {}), ...(opaque.length ? { opaque } : {}) });
    if (!calls.length) return { end: "done", said };
    for (const call of calls) {
      const pending: Extract<AgentStep, { kind: "tool" }> = { kind: "tool", id: call.id, name: call.name, label: "Working…", ok: true, pending: true };
      o.steps.push(pending);
      o.onStep();
      const result = await runTool(o.env, o.handles, call);
      Object.assign(pending, result.step, { pending: false });
      if (result.changes.length) o.record(result.changes);
      if (result.leanCheck) {
        const check = result.leanCheck;
        o.leanChecks.splice(0, o.leanChecks.length, ...o.leanChecks.filter((c) => c.code !== check.code), check);
      }
      o.history.push({ role: "tool", toolCallId: call.id, name: call.name, content: result.output });
      o.onStep();
    }
  }
}
