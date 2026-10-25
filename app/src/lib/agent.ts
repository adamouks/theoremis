// Auto mode: the collaborator acts on the document with tools instead of proposing. This
// module holds the tools (what each is called, what it takes, and what running it does) and
// Undo. Every tool that changes the document is a function from the latest document to the
// next one, so each step is one read-modify-write and can be tested on a plain Doc.

import { errorMessage } from "./api";
import { documentAsText, numberBlocks } from "./doc";
import { parseGraph } from "./graph/spec";
import { leadingLabel, newId } from "./text";
import type { AgentChange, AgentRun, Block, Doc, DocumentSummary, LeanCheck, Status, StoredLeanCheck, ToolCall, ToolSpec } from "./types";

/** Rounds of tool calls in one reply before the collaborator has to stop and report. */
export const MAX_ROUNDS = 24;

/**
 * Statuses the collaborator may give a statement. Adopted and proved are the mathematician's
 * judgments, and verified comes only from Lean accepting a proof (see `check_lean`).
 */
const AGENT_STATUSES = ["open", "tested", "draft"] as const;

/** The note on a statement Lean verified in Auto mode, so it reads differently from a person's check. */
export const AUTO_VERIFIED_NOTE = "checked in Lean (Auto)";

/** A JSON Schema object for a tool's arguments. */
export const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const handle = { type: "string", description: "A block's handle, e.g. B3." };

export const AGENT_TOOLS: ToolSpec[] = [
  {
    name: "read_document",
    description:
      "Read the document as it is now: its title, summary and every block with its handle (B1, B2, …), label, status and Markdown + LaTeX source. Call it after making changes. Pass `document` to read another document in the project instead (read-only).",
    parameters: object({ document: { type: "string", description: "An id from list_documents. Omit for this document." } }),
  },
  {
    name: "list_documents",
    description: "List the other documents in this project, with their ids, titles and how far each has got.",
    parameters: object({}),
  },
  {
    name: "edit_block",
    description:
      "Replace a block's Markdown + LaTeX. Equation numbers are added automatically; don't write \\tag. A block that was proved or verified goes back to draft, since the check no longer applies to new text.",
    parameters: object({ block: handle, text: { type: "string", description: "The block's new text." } }, ["block", "text"]),
  },
  {
    name: "insert_block",
    description:
      "Add a block: a statement, a proof, a remark, a graph (a ```graph or ```graph3d fence) or Lean code (a ```lean fence). One block per paragraph, statement or proof.",
    parameters: object(
      {
        after: { type: "string", description: 'The handle to insert after, or "start" or "end".' },
        text: { type: "string", description: "The block's Markdown + LaTeX." },
        status: { type: "string", enum: [...AGENT_STATUSES], description: "Optional: open for a conjecture, tested for numerical evidence, draft for a proof in progress." },
        note: { type: "string", description: "Optional short qualifier shown under the status, e.g. 'tested to $10^4$'." },
      },
      ["after", "text"],
    ),
  },
  {
    name: "delete_block",
    description: "Remove a block. Only when the request calls for it.",
    parameters: object({ block: handle }, ["block"]),
  },
  {
    name: "set_status",
    description:
      "Set a statement's status: open (stated, not proved), tested (numerical evidence, not a proof) or draft (proof in progress), or none to clear it. Adopted and proved are the mathematician's to give; verified comes only from check_lean.",
    parameters: object(
      { block: handle, status: { type: "string", enum: ["none", ...AGENT_STATUSES] }, note: { type: "string", description: "Optional short qualifier." } },
      ["block", "status"],
    ),
  },
  {
    name: "set_title",
    description: "Change the document's title, its summary paragraph, or both.",
    parameters: object({ title: { type: "string" }, summary: { type: "string" } }),
  },
  {
    name: "check_lean",
    description:
      "Check a complete Lean 4 file against Mathlib on the mathematician's computer and get Lean's verdict and errors. Start with `import Mathlib` and state results as named theorems; `#check` looks up Mathlib names. Files that run programs (#eval, IO, macros, custom syntax) are refused. If Lean accepts every proof, none resting on sorry, and `block` is given, that block is marked verified: give `block` only when the theorem states exactly what the block claims.",
    parameters: object({ code: { type: "string", description: "The whole Lean file." }, block: handle }, ["code"]),
  },
  {
    name: "check_graph",
    description:
      "Check graph code before putting it in the document: returns what each line draws and any errors. The code is what goes inside a ```graph (dim 2) or ```graph3d (dim 3) fence.",
    parameters: object({ code: { type: "string" }, dim: { type: "integer", enum: [2, 3] } }, ["code"]),
  },
];

/** Short names for blocks ("B3") that stay fixed for a run, so the model needn't copy ids. */
export class Handles {
  private byId = new Map<string, string>();
  private byHandle = new Map<string, string>();
  private next = 1;

  constructor(blocks: Block[] = []) {
    for (const block of blocks) this.of(block.id);
  }

  of(id: string): string {
    let name = this.byId.get(id);
    if (!name) {
      name = `B${this.next++}`;
      this.byId.set(id, name);
      this.byHandle.set(name, id);
    }
    return name;
  }

  id(name: unknown): string | undefined {
    return typeof name === "string" ? this.byHandle.get(name.trim().replace(/^\[|\]$/g, "").toUpperCase()) : undefined;
  }
}

/** The document as the collaborator sees it in Auto mode: each block with its handle and source. */
export function documentForAgent(doc: Doc, handles: Handles): string {
  const lines = [`Title: ${doc.title.trim() || "(untitled)"}`, `Summary: ${doc.lede.trim() || "(none)"}`, ""];
  if (!doc.blocks.length) lines.push("(The document has no blocks yet.)");
  for (const n of numberBlocks(doc.blocks)) {
    const b = n.block;
    const standing = b.suggestion
      ? "a suggestion awaiting the mathematician's decision (leave it alone)"
      : b.status
        ? `status: ${b.status}${b.note ? ` (${b.note})` : ""}`
        : "no status";
    lines.push(`[${handles.of(b.id)}] ${n.label} — ${standing}`, b.source.trim() || "(empty)", "");
  }
  return lines.join("\n").trimEnd();
}

/** What a tool did: what the model is told, what the person sees, and what changed. */
export interface ToolOutcome {
  output: string;
  step: { label: string; detail?: string; ok: boolean; blockId?: string; verified?: boolean };
  changes: AgentChange[];
  leanCheck?: StoredLeanCheck;
}

/** What the tools act through. Everything but `transact` only reads. */
export interface AgentEnv {
  /** Runs `fn` on the latest version of the run's document and keeps the document it returns. */
  transact<T>(fn: (doc: Doc) => { doc: Doc; result: T }): Promise<T>;
  /** Reads another document. */
  read(id: string): Promise<Doc>;
  /** The other documents in the project. */
  documents: DocumentSummary[];
  lean(code: string): Promise<LeanCheck>;
  /** The reply doing the work, recorded on what it writes. */
  origin: { threadId: string; messageId: string };
  /**
   * In Seminar mode, each block's text as this member last saw it. Others change the document
   * at the same time, so an edit to a block that changed since is held back until it reads again.
   */
  seen?: Map<string, string>;
}

const failed = (output: string, label: string, detail?: string): ToolOutcome => ({ output, step: { label, detail, ok: false }, changes: [] });

/** The label a block has in `doc`, e.g. "Theorem 2 · (3)", or its opening words in quotes. */
function labelOf(doc: Doc, id: string): string {
  const numbered = numberBlocks(doc.blocks).find((n) => n.block.id === id);
  if (!numbered) return "a block";
  return leadingLabel(numbered.block.source) || /^Equation /.test(numbered.label) ? numbered.label : `“${numbered.label.replace(/[.:,;]$/, "")}”`;
}

const isAgentStatus = (value: unknown): value is (typeof AGENT_STATUSES)[number] =>
  typeof value === "string" && (AGENT_STATUSES as readonly string[]).includes(value);

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Runs one tool call. Never throws: problems are reported to the model so it can carry on. */
export async function runTool(env: AgentEnv, handles: Handles, call: ToolCall): Promise<ToolOutcome> {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = call.arguments.trim() ? JSON.parse(call.arguments) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    args = parsed as Record<string, unknown>;
  } catch {
    return failed(`The arguments for ${call.name} weren't a JSON object. Call it again with valid arguments.`, `Couldn't read a ${call.name} call`);
  }
  try {
    switch (call.name) {
      case "read_document":
        return await readDocument(env, handles, text(args.document));
      case "list_documents":
        return listDocuments(env);
      case "edit_block":
        return await env.transact((doc) => guarded(doc, env, handles, args.block, () => editBlock(doc, handles, env.origin, args)));
      case "insert_block":
        return await env.transact((doc) => guarded(doc, env, handles, undefined, () => insertBlock(doc, handles, env.origin, args)));
      case "delete_block":
        return await env.transact((doc) => guarded(doc, env, handles, args.block, () => deleteBlock(doc, handles, args)));
      case "set_status":
        return await env.transact((doc) => setStatus(doc, handles, args));
      case "set_title":
        return await env.transact((doc) => setTitle(doc, args));
      case "check_lean":
        return await checkLean(env, handles, args);
      case "check_graph":
        return checkGraph(args);
      default:
        return failed(`There is no tool called ${call.name}.`, `Tried a tool that doesn't exist (${call.name})`);
    }
  } catch (err) {
    return failed(`${call.name} failed: ${errorMessage(err)}`, `${call.name} failed`, errorMessage(err));
  }
}

async function readDocument(env: AgentEnv, handles: Handles, other: string): Promise<ToolOutcome> {
  if (other) {
    const summary = env.documents.find((d) => d.id === other);
    if (!summary) return failed(`No document in this project has the id ${other}. list_documents shows them.`, "Looked for a document that isn't there");
    const doc = await env.read(other);
    return { output: documentAsText(doc), step: { label: `Read “${doc.title || "Untitled"}”`, ok: true }, changes: [] };
  }
  const output = await env.transact((doc) => {
    remember(env, doc);
    return { doc, result: documentForAgent(doc, handles) };
  });
  return { output, step: { label: "Read the document", ok: true }, changes: [] };
}

/** Notes the text of `doc`'s blocks as this member has now seen them (Seminar mode). */
export function remember(env: AgentEnv, doc: Doc, only?: string) {
  if (!env.seen) return;
  for (const b of doc.blocks) if (!only || b.id === only) env.seen.set(b.id, b.source);
}

/**
 * Runs a change unless `target` changed since this member last saw it (Seminar mode), and
 * notes what it then saw. All in one read-modify-write, so nobody can slip in between.
 */
function guarded(doc: Doc, env: AgentEnv, handles: Handles, target: unknown, change: () => Step): Step {
  const id = target === undefined ? undefined : handles.id(target);
  const now = id ? doc.blocks.find((b) => b.id === id) : undefined;
  const known = id ? env.seen?.get(id) : undefined;
  if (now && known !== undefined && known !== now.source) {
    return unchanged(
      doc,
      failed(
        `${handles.of(now.id)} changed since you last read it: another member is working on it. Call read_document, then decide whether your change still applies.`,
        `Held back from overwriting ${labelOf(doc, now.id)}, which another member had just changed`,
      ),
    );
  }
  const step = change();
  const touched = step.result.step.blockId ?? id;
  if (touched) {
    if (step.doc.blocks.some((b) => b.id === touched)) remember(env, step.doc, touched);
    else env.seen?.delete(touched);
  }
  return step;
}

function listDocuments(env: AgentEnv): ToolOutcome {
  const output = env.documents.length
    ? env.documents.map((d) => `${d.id} — ${d.title || "Untitled"}${d.status ? ` (${d.status})` : ""}`).join("\n")
    : "This is the only document in the project.";
  return { output, step: { label: "Looked through the project", ok: true }, changes: [] };
}

type Step = { doc: Doc; result: ToolOutcome };
const unchanged = (doc: Doc, outcome: ToolOutcome): Step => ({ doc, result: outcome });

function findBlock(doc: Doc, handles: Handles, name: unknown): { index: number; block: Block } | string {
  const id = handles.id(name);
  const index = id ? doc.blocks.findIndex((b) => b.id === id) : -1;
  if (index < 0) return `There is no block ${String(name)}. read_document shows the current handles.`;
  const block = doc.blocks[index];
  if (block.suggestion) return `${String(name)} is a suggestion awaiting the mathematician's decision; leave it to them.`;
  return { index, block };
}

export function editBlock(doc: Doc, handles: Handles, origin: AgentEnv["origin"], args: Record<string, unknown>): Step {
  const found = findBlock(doc, handles, args.block);
  if (typeof found === "string") return unchanged(doc, failed(found, "Couldn't find a block to edit"));
  const source = text(args.text).trim();
  if (!source) return unchanged(doc, failed("The new text is empty. Use delete_block to remove a block.", "Tried to empty a block"));
  const { index, block: before } = found;
  if (source === before.source.trim()) return unchanged(doc, { output: "That is already the block's text; nothing changed.", step: { label: `Left ${labelOf(doc, before.id)} as it was`, ok: true, blockId: before.id }, changes: [] });
  const wasChecked = before.status === "verified" || before.status === "proved";
  const after: Block = {
    ...before,
    source,
    byAgent: origin,
    ...(wasChecked ? { status: "draft" as Status, note: "changed after it was checked" } : {}),
  };
  const next = { ...doc, blocks: doc.blocks.map((b, i) => (i === index ? after : b)) };
  const name = handles.of(after.id);
  return {
    doc: next,
    result: {
      output: wasChecked ? `Rewrote ${name}. It was ${before.status}; it is now draft, since that check was of the old text.` : `Rewrote ${name}.`,
      step: { label: `Rewrote ${labelOf(next, after.id)}`, ok: true, blockId: after.id },
      changes: [{ kind: "block", blockId: after.id, before, after, index }],
    },
  };
}

export function insertBlock(doc: Doc, handles: Handles, origin: AgentEnv["origin"], args: Record<string, unknown>): Step {
  const source = text(args.text).trim();
  if (!source) return unchanged(doc, failed("The block's text is empty.", "Tried to add an empty block"));
  if (args.status !== undefined && !isAgentStatus(args.status)) {
    return unchanged(doc, failed(`A new block's status can be ${AGENT_STATUSES.join(", ")}, or left out.`, "Tried to give a status it can't"));
  }
  const where = text(args.after).trim().toLowerCase();
  let index: number;
  if (where === "start") index = 0;
  else if (where === "end" || !where) index = doc.blocks.length;
  else {
    const id = handles.id(args.after);
    const at = id ? doc.blocks.findIndex((b) => b.id === id) : -1;
    if (at < 0) return unchanged(doc, failed(`There is no block ${String(args.after)} to insert after. read_document shows the current handles.`, "Couldn't find where to add a block"));
    index = at + 1;
  }
  const note = text(args.note).trim();
  const block: Block = {
    id: newId(),
    source,
    ...(isAgentStatus(args.status) ? { status: args.status } : {}),
    ...(note && isAgentStatus(args.status) ? { note } : {}),
    byAgent: origin,
  };
  const blocks = [...doc.blocks];
  blocks.splice(index, 0, block);
  const next = { ...doc, blocks };
  return {
    doc: next,
    result: {
      output: `Added ${handles.of(block.id)}.`,
      step: { label: `Added ${labelOf(next, block.id)}`, ok: true, blockId: block.id },
      changes: [{ kind: "block", blockId: block.id, before: null, after: block, index }],
    },
  };
}

export function deleteBlock(doc: Doc, handles: Handles, args: Record<string, unknown>): Step {
  const found = findBlock(doc, handles, args.block);
  if (typeof found === "string") return unchanged(doc, failed(found, "Couldn't find a block to remove"));
  const { index, block } = found;
  return {
    doc: { ...doc, blocks: doc.blocks.filter((b) => b.id !== block.id) },
    result: {
      output: `Removed ${handles.of(block.id)}.`,
      step: { label: `Removed ${labelOf(doc, block.id)}`, ok: true },
      changes: [{ kind: "block", blockId: block.id, before: block, after: null, index }],
    },
  };
}

export function setStatus(doc: Doc, handles: Handles, args: Record<string, unknown>): Step {
  const found = findBlock(doc, handles, args.block);
  if (typeof found === "string") return unchanged(doc, failed(found, "Couldn't find a block to set a status on"));
  const wanted = args.status;
  if (wanted !== "none" && !isAgentStatus(wanted)) {
    const why =
      wanted === "verified"
        ? "Only Lean can verify a statement: call check_lean with `block`."
        : wanted === "proved" || wanted === "adopted"
          ? `${String(wanted)} is the mathematician's judgment to make, not yours.`
          : `The status can be ${AGENT_STATUSES.join(", ")} or none.`;
    return unchanged(doc, failed(why, `Tried to mark a statement ${String(wanted)}`));
  }
  const { index, block: before } = found;
  const note = text(args.note).trim();
  const after: Block = { ...before };
  delete after.status;
  delete after.note;
  if (wanted !== "none") {
    after.status = wanted;
    if (note) after.note = note;
  }
  const next = { ...doc, blocks: doc.blocks.map((b, i) => (i === index ? after : b)) };
  const label = labelOf(next, after.id);
  return {
    doc: next,
    result: {
      output: wanted === "none" ? `Cleared ${handles.of(after.id)}'s status.` : `${handles.of(after.id)} is now ${wanted}.`,
      step: { label: wanted === "none" ? `Cleared the status of ${label}` : `Marked ${label} ${wanted}`, ok: true, blockId: after.id },
      changes: [{ kind: "block", blockId: after.id, before, after, index }],
    },
  };
}

export function setTitle(doc: Doc, args: Record<string, unknown>): Step {
  const title = typeof args.title === "string" ? args.title.trim() : doc.title;
  const lede = typeof args.summary === "string" ? args.summary.trim() : doc.lede;
  if (title === doc.title && lede === doc.lede) return unchanged(doc, { output: "Nothing changed.", step: { label: "Left the title as it was", ok: true }, changes: [] });
  return {
    doc: { ...doc, title, lede },
    result: {
      output: "Updated.",
      step: { label: title !== doc.title ? `Retitled the document “${title}”` : "Rewrote the summary", ok: true },
      changes: [{ kind: "header", before: { title: doc.title, lede: doc.lede }, after: { title, lede } }],
    },
  };
}

/** Lean's verdict, for the model. */
export function describeCheck(check: LeanCheck): string {
  const verdict =
    check.outcome === "proved"
      ? "Lean accepted the file: every proof checks and none rests on sorry."
      : check.outcome === "incomplete"
        ? "The file compiles, but something rests on sorry, so it proves nothing yet."
        : "Lean reported errors.";
  const lines = [verdict];
  const errors = check.messages.filter((m) => m.severity !== "information");
  if (errors.length) {
    lines.push("", "Messages:");
    for (const m of errors.slice(0, 12)) lines.push(`line ${m.line}:${m.column} ${m.severity}: ${m.text.trim()}`);
    if (errors.length > 12) lines.push(`… and ${errors.length - 12} more.`);
  }
  if (check.theorems.length) {
    lines.push("", "Theorems:");
    for (const t of check.theorems) lines.push(`${t.name}: ${t.extraAxioms.length ? `also rests on ${t.extraAxioms.join(", ")}` : "standard axioms only"}`);
  }
  return lines.join("\n");
}

async function checkLean(env: AgentEnv, handles: Handles, args: Record<string, unknown>): Promise<ToolOutcome> {
  const code = text(args.code).trim();
  if (!code) return failed("The Lean file is empty.", "Tried to check an empty Lean file");
  let check: LeanCheck;
  try {
    check = await env.lean(code);
  } catch (err) {
    const why = errorMessage(err);
    return failed(`Lean didn't check this file: ${why}`, "Lean didn't run", why);
  }
  const stored: StoredLeanCheck = { ...check, code, checkedAt: Date.now() };
  const report = describeCheck(check);
  const errors = check.messages.filter((m) => m.severity === "error").length;
  const label =
    check.outcome === "proved" ? "Lean accepted the proof" : check.outcome === "incomplete" ? "Lean: it compiles, with sorry" : `Lean found ${errors || "some"} ${errors === 1 ? "error" : "errors"}`;
  const outcome: ToolOutcome = { output: report, step: { label, detail: report, ok: check.outcome === "proved" }, changes: [], leanCheck: stored };
  if (check.outcome !== "proved" || args.block === undefined) return outcome;

  // A verified status is the one thing in Auto mode the model can't simply assert.
  const extra = check.theorems.flatMap((t) => t.extraAxioms);
  if (!check.theorems.length) return { ...outcome, output: `${report}\n\nIt declares no theorem, so ${String(args.block)} wasn't marked verified. State the result as a named theorem.` };
  if (extra.length) return { ...outcome, output: `${report}\n\nIt rests on axioms beyond Mathlib's standard ones (${extra.join(", ")}), so ${String(args.block)} wasn't marked verified.` };
  return env.transact((doc) => {
    const found = findBlock(doc, handles, args.block);
    if (typeof found === "string") return unchanged(doc, { ...outcome, output: `${report}\n\n${found}` });
    const { index, block: before } = found;
    const after: Block = { ...before, status: "verified", note: AUTO_VERIFIED_NOTE };
    const next = { ...doc, blocks: doc.blocks.map((b, i) => (i === index ? after : b)) };
    return {
      doc: next,
      result: {
        ...outcome,
        output: `${report}\n\n${handles.of(after.id)} is now verified.`,
        step: { ...outcome.step, label: `Lean accepted the proof · ${labelOf(next, after.id)} is verified`, blockId: after.id, verified: true },
        changes: [{ kind: "block", blockId: after.id, before, after, index }],
      },
    };
  });
}

export function checkGraph(args: Record<string, unknown>): ToolOutcome {
  const code = text(args.code);
  const dim = args.dim === 3 ? 3 : 2;
  const spec = parseGraph(code, dim);
  const errors = spec.items.filter((i) => i.kind === "error");
  const drawn = spec.items.filter((i) => i.kind !== "error" && i.kind !== "note");
  const lines = drawn.map((i) => `line ${i.line + 1}: ${i.kind}`);
  for (const e of errors) if (e.kind === "error") lines.push(`line ${e.line + 1}: error: ${e.message}${e.missing.length ? ` (define ${e.missing.join(", ")}, e.g. as a slider)` : ""}`);
  const output = `${errors.length ? `${errors.length} ${errors.length === 1 ? "line has" : "lines have"} errors.` : "Every line parses."}\n${lines.join("\n")}`.trim();
  return { output, step: { label: errors.length ? "Checked a graph · it has errors" : "Checked a graph", ok: !errors.length }, changes: [] };
}

/** Takes back everything a run changed, newest first. Blocks edited since keep their place. */
export function undoRun(doc: Doc, run: Pick<AgentRun, "changes">): Doc {
  let next = doc;
  for (const change of [...run.changes].reverse()) {
    if (change.kind === "header") {
      next = { ...next, title: change.before.title, lede: change.before.lede };
      continue;
    }
    const at = next.blocks.findIndex((b) => b.id === change.blockId);
    if (!change.before) {
      if (at >= 0) next = { ...next, blocks: next.blocks.filter((b) => b.id !== change.blockId) };
    } else if (at >= 0) {
      const before = change.before;
      next = { ...next, blocks: next.blocks.map((b) => (b.id === change.blockId ? before : b)) };
    } else {
      const blocks = [...next.blocks];
      blocks.splice(Math.min(change.index, blocks.length), 0, change.before);
      next = { ...next, blocks };
    }
  }
  return next;
}

/** What a run did, in a line, for the conversation history of later turns. */
export function describeRun(run: AgentRun): string {
  const done = run.steps.flatMap((s) => (s.kind === "tool" && !s.pending ? [s.label] : []));
  if (!done.length) return "";
  return `[In Auto mode you ${run.undone ? "did the following, which the mathematician then undid" : "did the following"}: ${done.join("; ")}.]`;
}
