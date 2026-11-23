import { describe, expect, it } from "vitest";
import { sharedCopy } from "./share";
import type { Doc } from "./types";

describe("sharing a document", () => {
  it("leaves out what's the sender's own: threads, pending suggestions and Auto marks", () => {
    const doc: Doc = {
      id: "d1",
      projectId: "p1",
      title: "Odd numbers",
      lede: "Sums.",
      blocks: [
        { id: "a", source: "**Theorem 1.** …", status: "verified", note: "checked in Lean" },
        { id: "b", source: "A suggestion.", suggestion: { threadId: "t", messageId: "m" } },
        { id: "c", source: "*Proof.* …", byAgent: { threadId: "t", messageId: "m2" } },
      ],
      threads: [{ id: "t", title: "Private", createdAt: 0, updatedAt: 0, messages: [] }],
      activeThreadId: "t",
      revision: 7,
      createdAt: 0,
      updatedAt: 0,
      status: "verified",
      pending: 1,
      macros: "\\newcommand{\\R}{\\mathbb{R}}",
      bibliography: "@book{a, title = {T}}",
    };
    const shared = sharedCopy(doc);
    expect(shared.threads).toEqual([]);
    expect("activeThreadId" in shared).toBe(false);
    expect(shared.blocks.map((b) => b.id)).toEqual(["a", "c"]);
    expect(shared.blocks[0]).toEqual({ id: "a", source: "**Theorem 1.** …", status: "verified", note: "checked in Lean" });
    expect("byAgent" in shared.blocks[1]).toBe(false);
    expect(shared.macros).toBe(doc.macros);
    expect(shared.bibliography).toBe(doc.bibliography);
  });
});
