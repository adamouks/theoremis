import { describe, expect, it } from "vitest";
import { Handles, runTool, undoRun, type AgentEnv } from "./agent";
import { buildAgentMessages, buildMemberMessages, buildSummaryMessages } from "./prompts";
import { MAX_MEMBERS, describeSeminar, pool, readConvene, type Member } from "./seminar";
import type { AgentChange, Block, Doc, SeminarRun, Thread } from "./types";

const block = (id: string, source: string, extra: Partial<Block> = {}): Block => ({ id, source, ...extra });

function makeDoc(blocks: Block[]): Doc {
  return { id: "d1", projectId: "p1", title: "Odd sums", lede: "", blocks, threads: [], revision: 1, createdAt: 0, updatedAt: 0, status: "open", pending: 0 };
}

const start = () =>
  makeDoc([
    block("a", "**Theorem 1.** *For every $n\\ge 1$,* $\\sum_{k=1}^n (2k-1) = n^2$.", { status: "open" }),
    block("b", "*Proof.* By induction."),
  ]);

/** One document in memory, worked on by several members at once, each with its own view. */
function seminar(doc: Doc) {
  let current = doc;
  const changes: AgentChange[] = [];
  const handles = new Handles(doc.blocks);
  const member = () => {
    const env: AgentEnv = {
      async transact(fn) {
        const out = fn(current);
        current = out.doc;
        return out.result;
      },
      read: async () => current,
      documents: [],
      lean: async () => ({ outcome: "proved", messages: [], theorems: [], seconds: 1 }),
      origin: { threadId: "t1", messageId: "m1" },
      seen: new Map(current.blocks.map((b) => [b.id, b.source])),
    };
    return async (name: string, args: Record<string, unknown>) => {
      const result = await runTool(env, handles, { id: "c", name, arguments: JSON.stringify(args) });
      changes.push(...result.changes);
      return result;
    };
  };
  return { member, changes, doc: () => current };
}

describe("Seminar mode: convening", () => {
  const handles = new Handles(start().blocks);

  it("reads the members the chair convened", () => {
    const members = readConvene(
      JSON.stringify({
        members: [
          { role: "Prover", objective: "I'll write the induction in full.", blocks: ["B2", "B9"] },
          { role: " Skeptic ", objective: "I'll  test small n\nfor a gap.", blocks: ["B1", "B1"] },
          { role: "Prover", objective: "I'll try a bijective proof instead." },
        ],
      }),
      handles,
    );
    expect(members).toEqual([
      { role: "Prover", objective: "I'll write the induction in full.", blocks: ["b"] },
      { role: "Skeptic", objective: "I'll test small n for a gap.", blocks: ["a"] },
      { role: "Prover 2", objective: "I'll try a bijective proof instead.", blocks: [] },
    ]);
  });

  it("keeps at most four members, each with a role and an objective, and clips long ones", () => {
    const listed = [
      { role: "", objective: "Nobody." },
      { role: "Editor" },
      ...Array.from({ length: 6 }, (_, i) => ({ role: `Member ${i}`, objective: "x".repeat(400) })),
    ];
    const members = readConvene(JSON.stringify({ members: listed }), handles)!;
    expect(members.length).toBeLessThanOrEqual(MAX_MEMBERS);
    expect(members.map((m) => m.role)).toEqual(["Member 0", "Member 1"]);
    expect(members[0].objective).toHaveLength(320);
  });

  it("finds nobody in a call it can't read", () => {
    expect(readConvene("not json", handles)).toBeNull();
    expect(readConvene("{}", handles)).toBeNull();
    expect(readConvene(JSON.stringify({ members: [] }), handles)).toBeNull();
    expect(readConvene(JSON.stringify({ members: "Prover" }), handles)).toBeNull();
  });
});

describe("Seminar mode: working at once", () => {
  it("runs every member, no more than the limit at a time, in order of starting", async () => {
    let running = 0;
    let most = 0;
    const started: number[] = [];
    await pool([0, 1, 2, 3, 4], 3, async (n) => {
      started.push(n);
      most = Math.max(most, ++running);
      await new Promise((r) => setTimeout(r, 5 + (n % 2) * 10));
      running--;
    });
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(most).toBe(3);
    // One at a time, as on Ollama.
    const order: string[] = [];
    await pool(["a", "b"], 1, async (x) => {
      order.push(`${x}+`);
      await new Promise((r) => setTimeout(r, 1));
      order.push(`${x}-`);
    });
    expect(order).toEqual(["a+", "a-", "b+", "b-"]);
    await pool([], 3, async () => {
      throw new Error("never");
    });
  });

  it("holds back a change to a block another member changed since this one read it", async () => {
    const s = seminar(start());
    const prover = s.member();
    const skeptic = s.member();
    expect((await prover("edit_block", { block: "B2", text: "*Proof.* For $n = 1$, … ; then add $2n+1$." })).step.ok).toBe(true);

    const held = await skeptic("edit_block", { block: "B2", text: "*Proof.* Starting from $1 = 1^2$." });
    expect(held.step.ok).toBe(false);
    expect(held.output).toContain("B2 changed since you last read it");
    expect(held.changes).toEqual([]);
    expect(s.doc().blocks[1].source).toContain("add $2n+1$");
    expect((await skeptic("delete_block", { block: "B2" })).step.ok).toBe(false);

    // Having read it again, the change is the skeptic's to make.
    await skeptic("read_document", {});
    expect((await skeptic("edit_block", { block: "B2", text: "*Proof.* Starting from $1 = 1^2$." })).step.ok).toBe(true);
    // And the prover's own edit is now the stale one.
    expect((await prover("edit_block", { block: "B2", text: "*Proof.* Again." })).step.ok).toBe(false);
  });

  it("lets members add blocks and edit their own new ones, and undoes everything in order", async () => {
    const before = start();
    const s = seminar(before);
    const formalizer = s.member();
    const editor = s.member();
    const added = await formalizer("insert_block", { after: "end", text: "```lean\ntheorem odd_sum : True := trivial\n```" });
    expect(added.step.ok).toBe(true);
    const handle = /B\d+/.exec(added.output)?.[0];
    expect(handle).toBeDefined();
    expect((await formalizer("edit_block", { block: handle, text: "```lean\ntheorem odd_sum' : True := trivial\n```" })).step.ok).toBe(true);
    // A block added after the editor started isn't one it has seen differently.
    expect((await editor("edit_block", { block: handle, text: "**Formalization.**" })).step.ok).toBe(true);
    expect((await editor("set_status", { block: "B1", status: "tested" })).step.ok).toBe(true);
    expect(s.doc().blocks).toHaveLength(3);
    const undone = undoRun(s.doc(), { changes: s.changes });
    expect(undone.blocks).toEqual(before.blocks);
  });
});

describe("Seminar mode: requests", () => {
  const doc = start();
  const handles = new Handles(doc.blocks);
  const thread: Thread = {
    id: "t1",
    title: "t",
    createdAt: 0,
    updatedAt: 0,
    messages: [{ id: "u1", role: "user", content: "Prove it and check it in Lean.", mode: "ask", createdAt: 0 }],
  };
  const members: Member[] = [
    { role: "Prover", objective: "I'll write the induction.", blocks: ["b"] },
    { role: "Formalizer", objective: "I'll check it in Lean.", blocks: ["a"] },
  ];

  it("gives each member its objective, its blocks and the others'", () => {
    const [system] = buildMemberMessages(doc, thread, "", handles, new Map(), members[0], members);
    expect(system.content).toContain("You are in Auto mode");
    expect(system.content).toContain("You are the Prover in a seminar of 2");
    expect(system.content).toContain("Your objective: I'll write the induction.");
    expect(system.content).toContain("- Formalizer: I'll check it in Lean.");
    expect(system.content).toContain("Your blocks: B2.");
    expect(system.content).toContain("[B1] Theorem 1");
  });

  it("sums up from the reports, and tells later turns who did what", () => {
    const messages = buildSummaryMessages(doc, thread, "", handles, [
      { role: "Prover", objective: "I'll write the induction.", report: "Rewrote the proof." },
      { role: "Formalizer", objective: "I'll check it in Lean.", report: "" },
    ]);
    expect(messages[0].content).toContain("You chaired a seminar");
    expect(messages[messages.length - 1].content).toBe(
      "[The members' reports]\n\nProver (I'll write the induction.):\nRewrote the proof.\n\nFormalizer (I'll check it in Lean.):\n(no report)",
    );

    const run: SeminarRun = {
      status: "done",
      changes: [],
      members: [
        { id: "1", role: "Prover", objective: "I'll write the induction.", blocks: [], status: "done", changed: 1, steps: [{ kind: "tool", id: "c", name: "edit_block", label: "Rewrote Proof", ok: true }] },
        { id: "2", role: "Skeptic", objective: "I'll test small n.", blocks: [], status: "done", changed: 0, steps: [{ kind: "text", text: "Fine." }] },
      ],
    };
    expect(describeSeminar(run)).toBe("[In Seminar mode you convened Prover (I'll write the induction.): Rewrote Proof · Skeptic (I'll test small n.).]");
    expect(describeSeminar({ ...run, undone: true })).toContain("The mathematician then undid all of it");
    expect(describeSeminar({ status: "stopped", changes: [], members: [] })).toBe("");

    const later: Thread = {
      ...thread,
      messages: [
        ...thread.messages,
        { id: "a1", role: "assistant", content: "Done.", mode: "ask", seminar: run, createdAt: 0 },
        { id: "u2", role: "user", content: "Thanks.", mode: "ask", createdAt: 0 },
      ],
    };
    expect(buildAgentMessages(doc, later, "", handles)[2].content).toBe(`Done.\n\n${describeSeminar(run)}`);
  });
});
