import { documentAsText } from "./doc";
import type { ChatMessage, Doc, Mode, Thread, ThreadMessage } from "./types";

export const MODE_LABELS: Record<Mode, string> = {
  ask: "Ask",
  explore: "Explore",
  gaps: "Find gaps",
  challenge: "Challenge",
  formalize: "Formalize",
};

/** What each action asks for when the composer is empty. */
export const DEFAULT_REQUESTS: Record<Mode, string> = {
  ask: "",
  explore: "Explore this.",
  gaps: "Is this fully justified as written?",
  challenge: "Challenge this.",
  formalize: "Formalize this in Lean 4.",
};

const MODE_INSTRUCTIONS: Record<Mode, string> = {
  ask: "",
  explore:
    "Explore the selected statement: test small cases, look for patterns, related known results and generalizations. Label numerical checks as evidence, not proof.",
  gaps:
    "Check the selected argument step by step. For each gap or error, give a short title, a severity in bold (**CRITICAL**, **MAJOR** or **MINOR**) and an explanation. If the argument is sound, say so and point out any step left implicit. If a step should be rewritten, end with a \"Proposed revision\" section.",
  challenge:
    "Challenge the selected claim or step. Look for counterexamples, hidden assumptions and edge cases, and argue the other side as strongly as you honestly can.",
  formalize:
    "Formalize the selected statement in Lean 4 with Mathlib. Give the theorem statement and a proof or proof sketch in a ```lean code block, and say what you could not formalize. Remember the code has not been checked by Lean.",
};

const COLLABORATOR = `You are the Collaborator in Theoremis, a workspace where a mathematician develops proofs. You assist; the mathematician decides what enters the document.

- Be rigorous and concise. Write math in LaTeX: $…$ inline, $$…$$ on their own lines for display.
- Refer to the document's equations by their numbers, e.g. (2).
- Nothing you say is checked. Never call something verified or proved unless you give the argument, and say what you did not check.
- To rewrite the selected passage, end with a section headed "### Proposed revision" containing exactly its replacement, in the document's Markdown + LaTeX.
- To suggest new material instead (a remark, a lemma, an alternative proof), end with a section headed "### Proposed addition" containing exactly the text to add.
- Put nothing after those sections, and include at most one of each.`;

const MAX_DOCUMENT_CHARS = 12000;

function describeTurn(message: ThreadMessage): string {
  const parts: string[] = [];
  const instruction = MODE_INSTRUCTIONS[message.mode];
  if (instruction) parts.push(`[${MODE_LABELS[message.mode]}] ${instruction}`);
  if (message.context) parts.push(`Selection — ${message.context.label}:\n${message.context.text.trim()}`);
  if (message.content.trim()) parts.push(message.content.trim());
  return parts.join("\n\n");
}

/** The full request for the next reply in `thread`: instructions, the document, then the thread. */
export function buildMessages(doc: Doc, thread: Thread, userPrompt: string): ChatMessage[] {
  let document = documentAsText(doc);
  if (document.length > MAX_DOCUMENT_CHARS) {
    document = `${document.slice(0, MAX_DOCUMENT_CHARS)}\n\n[… the rest of the document is omitted]`;
  }
  const system = [COLLABORATOR, userPrompt.trim(), `The document, with its current statuses:\n\n${document}`]
    .filter(Boolean)
    .join("\n\n");

  const history: ChatMessage[] = thread.messages
    .filter((m) => !m.error && (m.role === "user" || m.content.trim()))
    .map((m) => ({
      role: m.role,
      content: m.role === "user" ? describeTurn(m) : m.content,
    }));
  return [{ role: "system", content: system }, ...history];
}
