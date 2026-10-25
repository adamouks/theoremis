// The document as it prints, or saves as a PDF from the print dialog: title, author, summary and
// the blocks with their equation numbers, in black on white, with graphs pictured on paper.
// Rendered into the page but shown only for print (see the print rules in styles.css).

import { createPortal } from "react-dom";
import type { NumberedBlock } from "../lib/doc";
import type { CitedReference } from "../lib/notation";
import type { Doc } from "../lib/types";
import { GraphContext, Markdown, MediaContext } from "./Markdown";

const PRINT_GRAPHS = { editable: false, compact: false, print: true };

export function PrintDocument({ doc, numbered, author, references }: { doc: Doc; numbered: NumberedBlock[]; author: string; references: CitedReference[] }) {
  return createPortal(
    <div className="print-root" aria-hidden="true">
      <MediaContext.Provider value={doc.id}>
        <GraphContext.Provider value={PRINT_GRAPHS}>
          <article className="print-doc">
            <h1 className="print-doc__title">{doc.title.trim() || "Untitled"}</h1>
            {author.trim() && <p className="print-doc__author">{author}</p>}
            {doc.lede.trim() && (
              <div className="print-doc__abstract">
                <Markdown text={doc.lede} variant="doc" />
              </div>
            )}
            {numbered
              .filter((n) => !n.block.suggestion && n.text.trim())
              .map((n) => (
                <div key={n.block.id} className="print-doc__block">
                  <Markdown text={n.text} variant="doc" normalized />
                </div>
              ))}
            {references.length > 0 && (
              <section className="print-doc__references">
                <h2>References</h2>
                <ol>
                  {references.map((r) => (
                    <li key={r.key}>
                      <span className="doc-references__number">[{r.number}]</span>
                      <Markdown text={r.text} variant="doc" />
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </article>
        </GraphContext.Provider>
      </MediaContext.Provider>
    </div>,
    document.body,
  );
}
