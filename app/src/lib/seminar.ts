// Seminar mode: the collaborator chairs a small seminar on the request. It convenes up to four
// members, each with one objective of its own, who work on the document at the same time with
// the Auto tools; then it sums up what they did. This module holds the chair's tool, the
// reading of its plan, and the pieces the run is built from (see `useCollaborator`).

import { object, type Handles } from "./agent";
import type { ModelRef, SeminarRun, ToolSpec } from "./types";

export const MAX_MEMBERS = 4;
/** Rounds of tool calls each member may take; less than an Auto reply, since there are several. */
export const MEMBER_ROUNDS = 12;

export const CONVENE: ToolSpec = {
  name: "convene",
  description:
    "Convene the seminar: who works on this request, at the same time, each with one objective the others don't share. Call it once.",
  parameters: object(
    {
      members: {
        type: "array",
        minItems: 1,
        maxItems: MAX_MEMBERS,
        items: object(
          {
            role: { type: "string", description: "One or two words, e.g. Prover, Skeptic, Formalizer, Illustrator, Editor." },
            objective: {
              type: "string",
              description: "In the member's own voice, one or two sentences: what it will do and why. E.g. “I'll test the induction step on small n and look for a gap.”",
            },
            blocks: { type: "array", items: { type: "string" }, description: "Handles of the blocks it works on, e.g. B2. Empty for new material." },
          },
          ["role", "objective"],
        ),
      },
    },
    ["members"],
  ),
};

/** A member as the chair described it. */
export interface Member {
  role: string;
  objective: string;
  /** Block ids. */
  blocks: string[];
}

const clip = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** The members in a `convene` call, or null when it names none that can work. */
export function readConvene(argumentsJson: string, handles: Handles): Member[] | null {
  let args: unknown;
  try {
    args = JSON.parse(argumentsJson || "{}");
  } catch {
    return null;
  }
  const listed = (args as { members?: unknown })?.members;
  if (!Array.isArray(listed)) return null;
  const taken = new Map<string, number>();
  const members: Member[] = [];
  for (const raw of listed.slice(0, MAX_MEMBERS)) {
    const role = clip((raw as { role?: unknown })?.role, 32);
    const objective = clip((raw as { objective?: unknown })?.objective, 320);
    if (!role || !objective) continue;
    // Two members with one role are told apart: Prover, Prover 2.
    const n = (taken.get(role.toLowerCase()) ?? 0) + 1;
    taken.set(role.toLowerCase(), n);
    const blocks = Array.isArray((raw as { blocks?: unknown }).blocks) ? ((raw as { blocks: unknown[] }).blocks.map((b) => handles.id(b)).filter(Boolean) as string[]) : [];
    members.push({ role: n > 1 ? `${role} ${n}` : role, objective, blocks: [...new Set(blocks)] });
  }
  return members.length ? members : null;
}

/** When the chair names nobody, one member takes the whole request. */
export const LONE_MEMBER: Member = { role: "Collaborator", objective: "I'll take the request as a whole.", blocks: [] };

/** How many members work at once: ChatGPT serves them together; a local Ollama model takes them in turn. */
export function concurrency(model: ModelRef): number {
  return model.provider === "ollama" ? 1 : 3;
}

/** Runs `work` on every item, at most `limit` at a time, in order of starting. */
export async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, lane));
}

/** What a seminar did, in a line, for the conversation history of later turns. */
export function describeSeminar(run: SeminarRun): string {
  const lines = run.members.map((m) => {
    const did = m.steps.flatMap((s) => (s.kind === "tool" && !s.pending ? [s.label] : []));
    return `${m.role} (${m.objective})${did.length ? `: ${did.join("; ")}` : ""}`;
  });
  if (!lines.length) return "";
  return `[In Seminar mode you convened ${lines.join(" · ")}${run.undone ? ". The mathematician then undid all of it" : ""}.]`;
}
