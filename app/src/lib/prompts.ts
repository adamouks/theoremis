import { documentAsText } from "./doc";
import type { Attachment, ChatMessage, Doc, Mode, Thread, ThreadMessage } from "./types";

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
    "Formalize the selected statement in Lean 4 with Mathlib. Write one complete file in a single ```lean code block: start with `import Mathlib`, state it as a named `theorem`, and prove it, using `sorry` only for steps you cannot prove and saying which. Use current Mathlib names. Don't use #eval, macros, new syntax or IO; Theoremis refuses to run files that do. The person can check the file with Lean and Mathlib from the reply, and may send back Lean's errors for you to fix; until then it is unchecked. After the code, say briefly what you could not formalize.",
};

const COLLABORATOR = `You are the Collaborator in Theoremis, a workspace where a mathematician develops proofs. You assist; the mathematician decides what enters the document.

- Be rigorous and concise. Write math in LaTeX: $…$ inline, $$…$$ on their own lines for display.
- Refer to the document's equations by their numbers, e.g. (2).
- Nothing you say is checked. Never call something verified or proved unless you give the argument, and say what you did not check.
- To rewrite the selected passage, end with a section headed "### Proposed revision" containing exactly its replacement, in the document's Markdown + LaTeX.
- To suggest new material instead (a remark, a lemma, an alternative proof), end with a section headed "### Proposed addition" containing exactly the text to add.
- Put nothing after those sections, and include at most one of each.
- To show a graph, write a \`\`\`graph block (or \`\`\`graph3d for space); Theoremis draws it, with sliders, in the reply and in the document. One expression per line, in LaTeX or plain notation:
  - \`y = a\\sin(bx)\` a curve, with sliders for a and b; \`a = 1 [0, 3]\` a slider with its range; \`f(x) = x^2 - 2\` a function usable on other lines.
  - \`x^2 + y^2 = 4\` implicit; \`y < f(x)\` a region; \`r = 1 + \\cos\\theta\` polar; \`(\\cos t, \\sin 2t) [0, 2\\pi]\` parametric; \`(1, 2), (3, 4) ; label=P\` points.
  - Options after semicolons: \`; color=#e64980 ; dashed ; label=name\`. \`view x=[-5, 5] y=[-3, 3]\` sets the window.
  - In graph3d: \`z = \\sin x \\cos y\`, \`x^2 + y^2 + z^2 = 4\`, curves \`(\\cos t, \\sin t, t/4) [0, 4\\pi]\`, surfaces \`((2+\\cos v)\\cos u, (2+\\cos v)\\sin u, \\sin v) [0, 2\\pi, 0, 2\\pi]\`, points \`(1, 1, 1)\`, \`; opacity=0.5\`, \`view x=[…] y=[…] z=[…]\`.
- Files the mathematician attaches come with their text, and images of pages or photos when the model can see them. Read figures and handwriting carefully, and say where they are unclear.`;

const MAX_DOCUMENT_CHARS = 12000;

function describeAttachment(a: Attachment, shown: number): string {
  const what = a.kind === "pdf" ? `PDF, ${a.pages} ${a.pages === 1 ? "page" : "pages"}` : a.kind === "image" ? "image" : "file";
  let seen = "";
  if (shown && a.kind === "image") seen = ", shown below";
  else if (shown === 1) seen = ", page 1 shown as an image";
  else if (shown > 1) seen = `, pages 1–${shown} shown as images`;
  const blind = a.kind === "image" && !shown ? "\n\n[The image wasn't sent: this model can't see images.]" : "";
  return `Attached: ${a.name} (${what}${seen})${a.text ? `\n\n${a.text}` : blind}`;
}

function describeTurn(message: ThreadMessage, shown: (a: Attachment) => number): string {
  const parts: string[] = [];
  const instruction = MODE_INSTRUCTIONS[message.mode];
  if (instruction) parts.push(`[${MODE_LABELS[message.mode]}] ${instruction}`);
  if (message.context) parts.push(`Selection — ${message.context.label}:\n${message.context.text.trim()}`);
  for (const a of message.attachments ?? []) parts.push(describeAttachment(a, shown(a)));
  if (message.content.trim()) parts.push(message.content.trim());
  return parts.join("\n\n");
}

/** Images shown to the model across a thread; older ones are left out first. */
const MAX_IMAGES = 12;

/** The attached images a thread would send, newest last, as file names. */
export function threadImages(thread: Thread): string[] {
  const names = thread.messages.filter((m) => m.role === "user" && !m.error).flatMap((m) => (m.attachments ?? []).flatMap((a) => a.images));
  return names.slice(-MAX_IMAGES);
}

/**
 * The full request for the next reply in `thread`: instructions, the document, then the thread.
 * `images` holds the attached images as data URLs, by file name; leave it empty for models
 * that can't see.
 */
export function buildMessages(doc: Doc, thread: Thread, userPrompt: string, images: Map<string, string> = new Map()): ChatMessage[] {
  let document = documentAsText(doc);
  if (document.length > MAX_DOCUMENT_CHARS) {
    document = `${document.slice(0, MAX_DOCUMENT_CHARS)}\n\n[… the rest of the document is omitted]`;
  }
  const system = [COLLABORATOR, userPrompt.trim(), `The document, with its current statuses:\n\n${document}`]
    .filter(Boolean)
    .join("\n\n");

  const history: ChatMessage[] = thread.messages
    .filter((m) => !m.error && (m.role === "user" || m.content.trim()))
    .map((m) => {
      if (m.role !== "user") return { role: m.role, content: m.content };
      const sent = (m.attachments ?? []).flatMap((a) => a.images).filter((name) => images.has(name));
      const shown = (a: Attachment) => {
        let n = 0;
        while (n < a.images.length && images.has(a.images[n])) n++;
        return n;
      };
      return { role: m.role, content: describeTurn(m, shown), ...(sent.length ? { images: sent.map((name) => images.get(name)!) } : {}) };
    });
  return [{ role: "system", content: system }, ...history];
}
