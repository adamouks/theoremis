import { describe, expect, it } from "vitest";
import { Handles, runTool, undoRun, type AgentEnv } from "./agent";
import { buildMessages, buildQueryMessages, readQueries } from "./prompts";
import type { AgentChange, Doc, LiteratureSearch, Paper, Thread } from "./types";

const paper = (id: string, extra: Partial<Paper> = {}): Paper => ({
  source: "arXiv",
  id,
  title: "Sums of odd numbers",
  authors: ["Ada Lovelace", "Carl Gauss"],
  year: "2019",
  venue: `arXiv:${id} [math.NT]`,
  summary: "The sum of the first n odd numbers is n^2.",
  url: `https://arxiv.org/abs/${id}`,
  doi: null,
  ...extra,
});

function makeDoc(bibliography?: string): Doc {
  return { id: "d1", projectId: "p1", title: "Odd", lede: "", blocks: [{ id: "a", source: "**Theorem 1.** *$1 + 3 + \\dots = n^2$.*" }], threads: [], revision: 1, createdAt: 0, updatedAt: 0, status: "open", pending: 0, bibliography };
}

function env(doc: Doc, search: LiteratureSearch) {
  let current = doc;
  const looked: string[] = [];
  const e: AgentEnv = {
    async transact(fn) {
      const out = fn(current);
      current = out.doc;
      return out.result;
    },
    read: async () => current,
    documents: [],
    lean: async () => ({ outcome: "proved", messages: [], theorems: [], seconds: 1 }),
    origin: { threadId: "t", messageId: "m" },
    search: async () => search,
    lookup: async (id) => {
      looked.push(id);
      return `@misc{new, author = {Lovelace, Ada}, title = {Sums of Odd Numbers}, year = {2019}, eprint = {${id}}, archivePrefix = {arXiv}}`;
    },
  };
  const handles = new Handles(doc.blocks);
  const changes: AgentChange[] = [];
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await runTool(e, handles, { id: "c", name, arguments: JSON.stringify(args) });
    changes.push(...result.changes);
    return result;
  };
  return { call, changes, looked, doc: () => current };
}

describe("literature tools", () => {
  it("searches and numbers what it finds, saying when a service didn't answer", async () => {
    const t = env(makeDoc(), { papers: [paper("1901.00001"), paper("10.1/x", { source: "Crossref", title: "Figurate numbers", authors: ["A", "B", "C", "D"], summary: null, venue: "J. Num." })], unavailable: ["Crossref"] });
    const found = await t.call("search_literature", { query: "sum of odd numbers squares" });
    expect(found.step.label).toBe("Searched the literature for “sum of odd numbers squares”: 2 papers");
    expect(found.output).toContain("(Crossref didn't answer, so this may be incomplete)");
    expect(found.output).toContain("[1] Ada Lovelace, Carl Gauss, “Sums of odd numbers”, arXiv:1901.00001 [math.NT] (2019). arXiv:1901.00001.");
    expect(found.output).toContain("    The sum of the first n odd numbers is n^2.");
    expect(found.output).toContain("[2] A, B, C et al., “Figurate numbers”, J. Num. (2019). DOI 10.1/x.");
    expect(found.changes).toEqual([]);
    const none = await env(makeDoc(), { papers: [], unavailable: [] }).call("search_literature", { query: "nothing" });
    expect(none.step.label).toBe("Searched the literature for “nothing”: nothing found");
  });

  it("adds a reference once, under a fresh key, and Undo takes it back", async () => {
    const t = env(makeDoc("@book{lovelace2019, author = {Lovelace, Ada}, title = {Notes}, year = 2019}"), { papers: [], unavailable: [] });
    const added = await t.call("add_reference", { id: "arXiv:1901.00001v2" });
    expect(added.output).toContain("Cite it with \\cite{lovelace2019a}.");
    expect(t.doc().bibliography).toContain("@misc{lovelace2019a, author = {Lovelace, Ada}, title = {{Sums of Odd Numbers}}");
    // The same paper again isn't looked up or added twice.
    const again = await t.call("add_reference", { id: "1901.00001" });
    expect(again.output).toBe("Already in the references: cite it with \\cite{lovelace2019a}.");
    expect(t.looked).toEqual(["arXiv:1901.00001v2"]);
    expect(t.changes).toHaveLength(1);
    expect(undoRun(t.doc(), { changes: t.changes }).bibliography).toBe("@book{lovelace2019, author = {Lovelace, Ada}, title = {Notes}, year = 2019}");
    // A document without references gets them, and loses them again on Undo.
    const fresh = env(makeDoc(), { papers: [], unavailable: [] });
    await fresh.call("add_reference", { id: "2301.01234" });
    expect(fresh.doc().bibliography?.startsWith("@misc{lovelace2019,")).toBe(true);
    expect(undoRun(fresh.doc(), { changes: fresh.changes }).bibliography).toBeUndefined();
  });
});

describe("Is it known?", () => {
  const thread: Thread = {
    id: "t",
    title: "t",
    createdAt: 0,
    updatedAt: 0,
    messages: [{ id: "u", role: "user", content: "Is this known?", mode: "literature", context: { label: "Theorem 1", text: "$1 + 3 + \\dots + (2n-1) = n^2$", blockId: "a" }, createdAt: 0 }],
  };

  it("asks for searches from the question and reads them back", () => {
    const [system, user] = buildQueryMessages(makeDoc(), thread);
    expect(system.content).toContain("one or two search queries");
    expect(user.content).toContain("Selection — Theorem 1:\n$1 + 3 + \\dots + (2n-1) = n^2$");
    expect(user.content).not.toContain("[Is it known?]");
    expect(readQueries("1. sum of odd numbers squares\n- “odd integers perfect square”\nok\nthird query ignored")).toEqual(["sum of odd numbers squares", "odd integers perfect square"]);
  });

  it("gives the reply the results, or says the search found nothing or failed", () => {
    const literature = { status: "done" as const, queries: ["odd squares"], papers: [paper("1901.00001")] };
    const turns = buildMessages(makeDoc(), thread, "", new Map(), literature);
    const last = turns[turns.length - 1].content;
    expect(last).toContain("[Is it known?] Find out whether the selected result");
    expect(last).toContain("[Search results from arXiv and Crossref for “odd squares”.]\n[1] Ada Lovelace, Carl Gauss");
    expect(buildMessages(makeDoc(), thread, "", new Map(), { ...literature, papers: [] }).pop()!.content).toContain("[A search of arXiv and Crossref for “odd squares” found nothing.]");
    expect(buildMessages(makeDoc(), thread, "", new Map(), { ...literature, status: "failed", error: "offline" }).pop()!.content).toContain("[The literature search couldn't run: offline.");

    // Later turns know what [1] was.
    const later: Thread = {
      ...thread,
      messages: [...thread.messages, { id: "r", role: "assistant", content: "Yes, see [1].", mode: "literature", literature, createdAt: 0 }, { id: "u2", role: "user", content: "Who wrote [1]?", mode: "ask", createdAt: 0 }],
    };
    const history = buildMessages(makeDoc(), later, "");
    expect(history[2].content).toBe("Yes, see [1].\n\n[The search results you were given: [1] Sums of odd numbers (arXiv:1901.00001).]");
  });
});
