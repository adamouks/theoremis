// The page e2e/print-check.mjs prints: the long test document (lib/fixtures/quartic.ts) laid out
// for print exactly as the app lays out a document before opening the print dialog, without the
// app around it. When the copy is ready it says so on <html>, with what a complete print holds.

import ReactDOM from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/literata/opsz.css";
import "@fontsource-variable/literata/opsz-italic.css";
import "katex/dist/katex.min.css";
import "../styles.css";
import { PrintDocument } from "../components/PrintDocument";
import { numberBlocks } from "../lib/doc";
import { QUARTIC_LEAN, QUARTIC_PHRASES, quarticDocument } from "../lib/fixtures/quartic";
import { printedBlocks } from "../lib/printLayout";

// ?pad=N adds N remarks before the Lean section, so the same document is longer and its page
// breaks fall elsewhere: where the pages break decides whether a print that counts its pages wrong
// loses any. ?blocks=N prints only the first N blocks.
const params = new URLSearchParams(location.search);
const pad = Number(params.get("pad")) || 0;
const remarks = Array.from({ length: pad }, (_, i) => `Remark ${i + 1} (length ${pad})`);
const full = quarticDocument();
const lean = full.blocks.findIndex((b) => b.source.startsWith("## 3 Lean"));
const padded = [
  ...full.blocks.slice(0, lean),
  ...remarks.map((name, i) => ({
    id: `pad${i + 1}`,
    source: `**${name}.** Completing the square once more, $P_a(x) - m(a)$ is a sum of squares in $x$ for every fixed $a$: it is $(x^2 - a)^2$ when $a > 0$ and $x^4 - 2ax^2$ when $a \\le 0$. So every bound in Theorem 1 comes with a certificate that can be checked line by line, by hand or by a computer, and the same holds for the strict version of the criterion in Theorem 2.`,
  })),
  ...full.blocks.slice(lean),
];
const limit = Number(params.get("blocks")) || padded.length;
const doc = { ...full, blocks: padded.slice(0, limit) };
const numbered = numberBlocks(doc.blocks);
const before = QUARTIC_PHRASES.indexOf("3 Lean 4 formalization");

(window as unknown as { __printCheck: unknown }).__printCheck = {
  blocks: printedBlocks(numbered).map((n) => n.block.id),
  phrases: [...QUARTIC_PHRASES.slice(0, before), ...remarks, ...QUARTIC_PHRASES.slice(before)],
  lean: QUARTIC_LEAN.split("\n").filter((line) => line.trim()),
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <PrintDocument
    job={{ id: 1, doc, numbered, author: "Élise Moreau", references: [] }}
    onReady={() => {
      document.documentElement.dataset.printReady = "true";
    }}
  />,
);
