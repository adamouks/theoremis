import { describeRun, documentForAgent, type Handles } from "./agent";
import { describeSeminar, type Member } from "./seminar";
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

/** The conversation so far, as the model sees it. */
function history(thread: Thread, images: Map<string, string>): ChatMessage[] {
  return thread.messages
    .filter((m) => (m.role === "user" ? !m.error : m.content.trim() || (m.agent && describeRun(m.agent)) || (m.seminar && describeSeminar(m.seminar))))
    .map((m) => {
      if (m.role !== "user") {
        const actions = m.agent ? describeRun(m.agent) : m.seminar ? describeSeminar(m.seminar) : "";
        return { role: m.role, content: [m.content.trim(), actions].filter(Boolean).join("\n\n") };
      }
      const sent = (m.attachments ?? []).flatMap((a) => a.images).filter((name) => images.has(name));
      const shown = (a: Attachment) => {
        let n = 0;
        while (n < a.images.length && images.has(a.images[n])) n++;
        return n;
      };
      return { role: m.role, content: describeTurn(m, shown), ...(sent.length ? { images: sent.map((name) => images.get(name)!) } : {}) };
    });
}

const capped = (document: string) =>
  document.length > MAX_DOCUMENT_CHARS ? `${document.slice(0, MAX_DOCUMENT_CHARS)}\n\n[… the rest of the document is omitted]` : document;

/**
 * The full request for the next reply in `thread`: instructions, the document, then the thread.
 * `images` holds the attached images as data URLs, by file name; leave it empty for models
 * that can't see.
 */
export function buildMessages(doc: Doc, thread: Thread, userPrompt: string, images: Map<string, string> = new Map()): ChatMessage[] {
  const system = [COLLABORATOR, userPrompt.trim(), `The document, with its current statuses:\n\n${capped(documentAsText(doc))}`]
    .filter(Boolean)
    .join("\n\n");
  return [{ role: "system", content: system }, ...history(thread, images)];
}

const AUTO = `You are in Auto mode. Instead of proposing changes, you make them yourself with your tools, and every change is recorded so the mathematician can undo it.
- The document below is as it was when you began; blocks are named by handle, e.g. B3. Call read_document to see it after your changes.
- Do what was asked in as many steps as it takes, then stop and reply with a short summary: what you changed (by label), what Lean checked, and what is still unverified or uncertain.
- Statuses: you may set open, tested (numerical evidence only) or draft. Adopted and proved are the mathematician's judgments. A statement becomes verified only when check_lean accepts a proof with \`block\` given, and only if the theorem states exactly what the block claims: never weaken a statement to get it accepted.
- To formalize, write a complete file, check it, read Lean's errors, fix them and check again, until Lean accepts it or you are stuck. Put the final file in your reply in a \`\`\`lean block, and say what you couldn't formalize.
- Keep the mathematician's notation and voice. Don't delete or rewrite material you weren't asked to touch. One block per paragraph, statement or proof.
- Check graph code with check_graph before putting it in the document.
- Don't write "Proposed revision" or "Proposed addition" sections in Auto mode: make the change instead.`;

/** The request for a reply in Auto mode: the same conversation, the document with block handles, and the tools' rules. */
export function buildAgentMessages(doc: Doc, thread: Thread, userPrompt: string, handles: Handles, images: Map<string, string> = new Map()): ChatMessage[] {
  const system = [COLLABORATOR, AUTO, userPrompt.trim(), `The document:\n\n${capped(documentForAgent(doc, handles))}`]
    .filter(Boolean)
    .join("\n\n");
  return [{ role: "system", content: system }, ...history(thread, images)];
}

const CHAIR = `You are in Seminar mode, chairing a small seminar on the mathematician's request. Decide who should work on it, all at the same time: one to four members, each with a single objective that the others don't share. Choose roles that fit the request, for instance:
- Prover: writes or repairs a proof.
- Skeptic: looks for gaps, counterexamples and unstated assumptions, and tests claims numerically.
- Formalizer: states results in Lean and checks them.
- Illustrator: draws graphs that make a statement visible.
- Editor: makes the exposition clear without changing the mathematics.
A small request needs one or two members; don't convene more than the work needs. Write each objective in the member's own voice, and give each the blocks it concerns. Call convene once and don't do the work yourself.`;

/** The chair's request: decide who works on what. */
export function buildConveneMessages(doc: Doc, thread: Thread, userPrompt: string, handles: Handles, images: Map<string, string> = new Map()): ChatMessage[] {
  const system = [COLLABORATOR, CHAIR, userPrompt.trim(), `The document:\n\n${capped(documentForAgent(doc, handles))}`].filter(Boolean).join("\n\n");
  return [{ role: "system", content: system }, ...history(thread, images)];
}

function membership(member: Member, all: Member[], handles: Handles): string {
  const others = all.filter((m) => m !== member);
  const mine = member.blocks.map((id) => handles.of(id));
  return [
    `You are the ${member.role} in a seminar of ${all.length} working on the mathematician's request at the same time. Your objective: ${member.objective}`,
    others.length ? `The others:\n${others.map((m) => `- ${m.role}: ${m.objective}`).join("\n")}` : "",
    `- Work only toward your objective, and don't redo another member's work.${mine.length ? ` Your blocks: ${mine.join(", ")}. Change others only if your objective needs it.` : ""}
- The others change the document while you work. If a tool says a block changed since you read it, call read_document before deciding what to do.
- When you're done, reply without calling a tool: a short report to the chair of what you did, what you found and what is still open, in at most five sentences.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** A member's request: the Auto rules, its objective, and who else is working. */
export function buildMemberMessages(
  doc: Doc,
  thread: Thread,
  userPrompt: string,
  handles: Handles,
  images: Map<string, string>,
  member: Member,
  all: Member[],
): ChatMessage[] {
  const system = [COLLABORATOR, AUTO, membership(member, all, handles), userPrompt.trim(), `The document, as you begin:\n\n${capped(documentForAgent(doc, handles))}`]
    .filter(Boolean)
    .join("\n\n");
  return [{ role: "system", content: system }, ...history(thread, images)];
}

const SUMMARY = `You chaired a seminar on the mathematician's request. The members worked on the document at the same time, and their reports follow. Write the reply to the mathematician: what changed (by label), what Lean verified, where members found problems or disagreed, and what is still open. Be brief, and don't repeat the reports word for word.`;

/** The chair's last request: sum up from the members' reports and the document as it now is. */
export function buildSummaryMessages(
  doc: Doc,
  thread: Thread,
  userPrompt: string,
  handles: Handles,
  reports: { role: string; objective: string; report: string }[],
): ChatMessage[] {
  const system = [COLLABORATOR, SUMMARY, userPrompt.trim(), `The document now:\n\n${capped(documentForAgent(doc, handles))}`].filter(Boolean).join("\n\n");
  const told = reports.map((r) => `${r.role} (${r.objective}):\n${r.report || "(no report)"}`).join("\n\n");
  return [{ role: "system", content: system }, ...history(thread, new Map()), { role: "user", content: `[The members' reports]\n\n${told}` }];
}
