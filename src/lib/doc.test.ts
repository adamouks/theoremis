import { describe, expect, it } from "vitest";
import { docStatus, documentAsText, extractRevision, numberBlocks, splitProposals, withSummary } from "./doc";
import { buildMessages } from "./prompts";
import { exampleWorkspace } from "./seed";
import type { Block, Doc, Thread } from "./types";

const block = (source: string, extra: Partial<Block> = {}): Block => ({ id: source.slice(0, 12), source, ...extra });

describe("numberBlocks", () => {
  it("numbers equations across blocks and labels each block", () => {
    const blocks = [
      block("**Conjecture 1.** *Claim:*\n\n$$\nx=y\n$$", { status: "open" }),
      block("*Proof.* By induction."),
      block("$$\n\\begin{align}\na&=b\\\\\n&=c\n\\end{align}\n$$"),
      block("Hence done."),
    ];
    const numbered = numberBlocks(blocks);
    expect(numbered.map((n) => n.numbers)).toEqual([[1], [], [2, 3], []]);
    expect(numbered.map((n) => n.label)).toEqual(["Conjecture 1 · (1)", "Proof", "Proof · (2)–(3)", "Hence done."]);
  });

  it("keeps suggestions out of the equation numbering", () => {
    const numbered = numberBlocks([
      block("$$\na\n$$"),
      block("**Remark 2.** $$\nb\n$$", { suggestion: { threadId: "t", messageId: "m" } }),
      block("$$\nc\n$$"),
    ]);
    expect(numbered.map((n) => n.numbers)).toEqual([[1], [], [2]]);
    expect(numbered[1].suggestionIndex).toBe(1);
    expect(numbered[1].label).toBe("Remark 2");
  });
});

describe("status and summary", () => {
  it("reports the furthest status, ignoring suggestions", () => {
    expect(docStatus({ blocks: [] })).toBe("open");
    expect(
      docStatus({
        blocks: [
          block("a", { status: "open" }),
          block("b", { status: "draft" }),
          block("c", { status: "verified", suggestion: { threadId: "t", messageId: "m" } }),
        ],
      }),
    ).toBe("draft");
  });

  it("counts pending suggestions", () => {
    const { documents } = exampleWorkspace();
    const doc: Doc = {
      ...documents[0],
      blocks: [...documents[0].blocks, block("x", { suggestion: { threadId: "t", messageId: "m" } })],
    };
    expect(withSummary(doc).pending).toBe(1);
    expect(withSummary(doc).status).toBe("draft");
  });
});

describe("the example workspace", () => {
  it("numbers the design's equations (1)–(4)", () => {
    const { documents } = exampleWorkspace();
    const numbered = numberBlocks(documents[0].blocks);
    expect(numbered.flatMap((n) => n.numbers)).toEqual([1, 2, 3, 4]);
    expect(numbered[2].label).toBe("Proof · (2)–(3)");
  });

  it("exports as Markdown with statuses", () => {
    const text = documentAsText(exampleWorkspace().documents[0]);
    expect(text.startsWith("# Sums of odd integers")).toBe(true);
    expect(text).toContain("[OPEN — tested to $10^4$]");
    expect(text).toContain("\\tag{1}");
  });
});

describe("extractRevision", () => {
  it("takes the text under a Proposed revision heading", () => {
    const reply = "The step is implicit.\n\n### Proposed revision\n\n$$\na = b\n$$\n\nby (1).\n\n### Why\n\nBecause.";
    expect(extractRevision(reply)).toBe("$$\na = b\n$$\n\nby (1).");
  });

  it("accepts bold headings and fenced blocks", () => {
    expect(extractRevision("**Proposed revision:**\n```latex\nx = y\n```")).toBe("x = y");
  });

  it("returns null when nothing is proposed", () => {
    expect(extractRevision("Looks fine to me.")).toBeNull();
  });
});

describe("splitProposals", () => {
  it("separates revisions and additions from the prose", () => {
    const reply = [
      "Sound overall.",
      "",
      "### Proposed revision",
      "",
      "$$\nx = y\n$$",
      "",
      "### Proposed addition",
      "",
      "**Lemma 3.**",
      "*For all n.*",
    ].join("\n");
    const parts = splitProposals(reply);
    expect(parts.body).toBe("Sound overall.");
    expect(parts.revision).toBe("$$\nx = y\n$$");
    // Bold lines inside a proposal don't end it.
    expect(parts.addition).toBe("**Lemma 3.**\n*For all n.*");
  });

  it("stops a proposal at the next heading", () => {
    const parts = splitProposals("### Proposed addition\nA remark.\n\n## Notes\nUnchecked.");
    expect(parts.addition).toBe("A remark.");
    expect(parts.body).toBe("## Notes\nUnchecked.");
  });
});

describe("buildMessages", () => {
  it("puts the document in the system prompt and the selection in the turn", () => {
    const doc = exampleWorkspace().documents[0];
    const thread: Thread = {
      id: "t",
      title: "Find gaps",
      createdAt: 0,
      updatedAt: 0,
      messages: [
        {
          id: "u1",
          role: "user",
          content: "Is (2) justified?",
          mode: "gaps",
          context: { label: "Proof · (2)–(3)", text: "$$x$$", blockId: doc.blocks[2].id },
          createdAt: 0,
        },
        { id: "a1", role: "assistant", content: "", mode: "gaps", createdAt: 0 },
      ],
    };
    const messages = buildMessages(doc, thread, "Prefer elementary arguments.");
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("Prefer elementary arguments.");
    expect(messages[0].content).toContain("# Sums of odd integers");
    expect(messages[1].content).toContain("[Find gaps]");
    expect(messages[1].content).toContain("Selection — Proof · (2)–(3):\n$$x$$");
    expect(messages[1].content).toContain("Is (2) justified?");
  });
});
