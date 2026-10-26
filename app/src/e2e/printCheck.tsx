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

// ?blocks=N prints only the first N blocks: a shorter document, for checking that one print doesn't
// limit the next.
const full = quarticDocument();
const limit = Number(new URLSearchParams(location.search).get("blocks")) || full.blocks.length;
const doc = { ...full, blocks: full.blocks.slice(0, limit) };
const numbered = numberBlocks(doc.blocks);

(window as unknown as { __printCheck: unknown }).__printCheck = {
  blocks: printedBlocks(numbered).map((n) => n.block.id),
  phrases: QUARTIC_PHRASES,
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
