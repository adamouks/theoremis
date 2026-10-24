import { describe, expect, it } from "vitest";
import { AUTO_VERIFIED_NOTE, Handles, describeRun, documentForAgent, runTool, undoRun, type AgentEnv } from "./agent";
import { buildAgentMessages } from "./prompts";
import type { AgentChange, AgentRun, Block, Doc, LeanCheck, Thread } from "./types";

const block = (id: string, source: string, extra: Partial<Block> = {}): Block => ({ id, source, ...extra });

function makeDoc(blocks: Block[]): Doc {
  return {
    id: "d1",
    projectId: "p1",
    title: "Odd sums",
    lede: "Sums of odd numbers.",
    blocks,
    threads: [],
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    status: "open",
    pending: 0,
  };
}

const proved: LeanCheck = { outcome: "proved", messages: [], theorems: [{ name: "odd_sum", extraAxioms: [] }], seconds: 2 };

/** A document held in memory, with Lean answering `check`. */
function harness(doc: Doc, check: LeanCheck | Error = proved) {
  let current = doc;
  const changes: AgentChange[] = [];
  const env: AgentEnv = {
    async transact(fn) {
      const out = fn(current);
      current = out.doc;
      return out.result;
    },
    read: async () => makeDoc([block("x", "Elsewhere.")]),
    documents: [{ id: "d2", projectId: "p1", title: "Other", createdAt: 0, updatedAt: 0, status: null, pending: 0 }],
    lean: async () => {
      if (check instanceof Error) throw check;
      return check;
    },
    origin: { threadId: "t1", messageId: "m1" },
  };
  const handles = new Handles(doc.blocks);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await runTool(env, handles, { id: "c", name, arguments: JSON.stringify(args) });
    changes.push(...result.changes);
    return result;
  };
  return { env, handles, call, changes, doc: () => current };
}

const start = () =>
  makeDoc([
    block("a", "**Theorem 1.** *For every $n\\ge 1$,*\n\n$$\n\\sum_{k=1}^n (2k-1) = n^2.\n$$", { status: "open" }),
    block("b", "*Proof.* By induction.", { status: "proved", note: "checked by hand" }),
    block("s", "A suggestion.", { suggestion: { threadId: "t0", messageId: "m0" } }),
  ]);

describe("Auto mode tools", () => {
  it("names blocks by stable handles and shows the document with them", () => {
    const handles = new Handles(start().blocks);
    expect(handles.of("a")).toBe("B1");
    expect(handles.id("b2")).toBe("b");
    expect(handles.id("[B1]")).toBe("a");
    expect(handles.of("new")).toBe("B4");
    const text = documentForAgent(start(), handles);
    expect(text).toContain("Title: Odd sums");
    expect(text).toContain("[B1] Theorem 1 · (1) — status: open");
    expect(text).toContain("[B2] Proof — status: proved (checked by hand)");
    expect(text).toContain("[B3]");
    expect(text).toContain("suggestion awaiting the mathematician's decision");
  });

  it("edits, inserts and removes blocks, marking what it wrote", async () => {
    const h = harness(start());
    const edited = await h.call("edit_block", { block: "B2", text: "*Proof.* Induct on $n$: the step adds $2n+1$." });
    expect(edited.step.ok).toBe(true);
    // A proof checked by hand isn't checked any more once its text changes.
    expect(h.doc().blocks[1]).toMatchObject({ status: "draft", byAgent: { threadId: "t1", messageId: "m1" } });
    expect(edited.output).toContain("now draft");

    const added = await h.call("insert_block", { after: "B1", text: "**Remark.** Compare squares.", status: "tested", note: "to $10^4$" });
    expect(added.output).toBe("Added B4.");
    expect(h.doc().blocks.map((b) => b.id)[1]).toBe(h.handles.id("B4"));
    expect(h.doc().blocks[1]).toMatchObject({ status: "tested", note: "to $10^4$" });
    await h.call("insert_block", { after: "start", text: "Introduction." });
    expect(h.doc().blocks[0].source).toBe("Introduction.");

    await h.call("delete_block", { block: "B4" });
    expect(h.doc().blocks.some((b) => b.source.startsWith("**Remark.**"))).toBe(false);
    expect(h.changes).toHaveLength(4);
  });

  it("refuses what isn't its to do", async () => {
    const h = harness(start());
    expect((await h.call("edit_block", { block: "B3", text: "Mine now." })).step.ok).toBe(false);
    expect((await h.call("edit_block", { block: "B9", text: "x" })).output).toContain("no block B9");
    expect((await h.call("set_status", { block: "B1", status: "verified" })).output).toContain("Only Lean");
    expect((await h.call("set_status", { block: "B1", status: "proved" })).output).toContain("mathematician's judgment");
    expect((await h.call("insert_block", { after: "end", text: "x", status: "verified" })).step.ok).toBe(false);
    const bad = await runTool(h.env, h.handles, { id: "c", name: "edit_block", arguments: "{not json" });
    expect(bad.output).toContain("weren't a JSON object");
    expect((await h.call("format_disk", {})).output).toContain("no tool called");
    expect(h.doc()).toEqual(start());
  });

  it("sets statuses and the title", async () => {
    const h = harness(start());
    await h.call("set_status", { block: "B1", status: "tested", note: "to $10^6$" });
    expect(h.doc().blocks[0]).toMatchObject({ status: "tested", note: "to $10^6$" });
    await h.call("set_status", { block: "B1", status: "none" });
    expect(h.doc().blocks[0].status).toBeUndefined();
    await h.call("set_title", { title: "Sums of odd numbers" });
    expect(h.doc()).toMatchObject({ title: "Sums of odd numbers", lede: "Sums of odd numbers." });
  });

  it("marks a statement verified only when Lean accepts a named theorem on standard axioms", async () => {
    const code = "import Mathlib\ntheorem odd_sum (n : ℕ) : True := trivial";
    const h = harness(start());
    const result = await h.call("check_lean", { code, block: "B1" });
    expect(h.doc().blocks[0]).toMatchObject({ status: "verified", note: AUTO_VERIFIED_NOTE });
    expect(result.step.label).toContain("is verified");
    expect(result.leanCheck?.code).toBe(code);

    const axioms = harness(start(), { ...proved, theorems: [{ name: "odd_sum", extraAxioms: ["Lean.ofReduceBool"] }] });
    expect((await axioms.call("check_lean", { code, block: "B1" })).output).toContain("wasn't marked verified");
    expect(axioms.doc().blocks[0].status).toBe("open");

    const example = harness(start(), { ...proved, theorems: [] });
    expect((await example.call("check_lean", { code, block: "B1" })).output).toContain("declares no theorem");

    const failing = harness(start(), {
      outcome: "failed",
      messages: [{ severity: "error", line: 2, column: 4, endLine: null, endColumn: null, text: "unknown identifier 'foo'" }],
      theorems: [],
      seconds: 1,
    });
    const errors = await failing.call("check_lean", { code, block: "B1" });
    expect(errors.step).toMatchObject({ ok: false, label: "Lean found 1 error" });
    expect(errors.output).toContain("line 2:4 error: unknown identifier 'foo'");
    expect(failing.doc().blocks[0].status).toBe("open");

    const missing = harness(start(), new Error("Set up Lean and Mathlib in Settings to check formalizations."));
    expect((await missing.call("check_lean", { code })).output).toContain("Set up Lean");
  });

  it("checks graphs and reads the project", async () => {
    const h = harness(start());
    expect((await h.call("check_graph", { code: "y = x^2\nx^2 + y^2 = 4" })).output).toContain("Every line parses.");
    const broken = await h.call("check_graph", { code: "y = b x" });
    expect(broken.step.ok).toBe(false);
    expect(broken.output).toContain("define b");
    expect((await h.call("list_documents", {})).output).toContain("d2 — Other");
    expect((await h.call("read_document", { document: "d2" })).output).toContain("Elsewhere.");
    expect((await h.call("read_document", {})).output).toContain("[B1]");
  });

  it("undoes a run in reverse, even after the person moved things", async () => {
    const h = harness(start());
    await h.call("edit_block", { block: "B1", text: "**Theorem 1.** Changed." });
    await h.call("insert_block", { after: "B1", text: "New." });
    await h.call("delete_block", { block: "B2" });
    await h.call("set_title", { title: "Renamed", summary: "New summary." });
    const run: AgentRun = { status: "done", steps: [], changes: h.changes };
    // The person adds a block of their own meanwhile; Undo leaves it.
    const touched = { ...h.doc(), blocks: [block("p", "Mine."), ...h.doc().blocks] };
    const undone = undoRun(touched, run);
    expect(undone.title).toBe("Odd sums");
    expect(undone.lede).toBe("Sums of odd numbers.");
    expect(undone.blocks.map((b) => b.id)).toEqual(["p", "a", "b", "s"]);
    expect(undone.blocks[1]).toEqual(start().blocks[0]);
  });
});

describe("Auto mode requests", () => {
  it("shows the document with handles and tells later turns what was done", () => {
    const doc = start();
    const thread: Thread = {
      id: "t1",
      title: "t",
      createdAt: 0,
      updatedAt: 0,
      messages: [
        { id: "u1", role: "user", content: "Tidy the proof.", mode: "ask", createdAt: 0 },
        {
          id: "a1",
          role: "assistant",
          content: "Done.",
          mode: "ask",
          agent: { status: "done", steps: [{ kind: "tool", id: "c", name: "edit_block", label: "Rewrote Proof", ok: true }], changes: [] },
          createdAt: 0,
        },
        { id: "u2", role: "user", content: "Now formalize it.", mode: "formalize", createdAt: 0 },
      ],
    };
    const messages = buildAgentMessages(doc, thread, "", new Handles(doc.blocks));
    expect(messages[0].content).toContain("You are in Auto mode");
    expect(messages[0].content).toContain("[B1] Theorem 1");
    expect(messages[2].content).toBe("Done.\n\n[In Auto mode you did the following: Rewrote Proof.]");
    expect(describeRun({ status: "done", steps: [], changes: [] })).toBe("");
  });
});
