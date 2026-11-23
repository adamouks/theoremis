// The document as it prints, or saves as a PDF from the print dialog: title, author, summary and
// the blocks with their equation numbers, in black on white, with graphs pictured on paper.
// Rendered into the page but shown only for print (see the print rules in styles.css).
//
// A print job is a snapshot, taken when printing is asked for, and its copy stays in the page
// unchanged until the next one: print dialogs read the page while they are open, some (macOS)
// more than once and late, and the document may change in the meantime. Before the dialog opens,
// the copy is laid out at the paper's width off screen, its graphs are pictured, and its long
// equations and short blocks are fitted to the page (lib/printLayout.ts); then it is ready.

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fitEquations, markKeeps, printGroups } from "../lib/printLayout";
import type { NumberedBlock } from "../lib/doc";
import type { CitedReference } from "../lib/notation";
import type { Doc } from "../lib/types";
import { graphPicture, type GraphPicture } from "./graph/graphPicture";
import { GraphContext, Markdown, MediaContext, type PrintPictures } from "./Markdown";

export interface PrintJob {
  /** Tells one print from the next, so a new one starts afresh. */
  id: number;
  doc: Doc;
  numbered: NumberedBlock[];
  author: string;
  references: CitedReference[];
}

/** The printed copy's content, without the page around it. */
export const PrintArticle = memo(function PrintArticle({ doc, numbered, author, references }: Omit<PrintJob, "id">) {
  return (
    <article className="print-doc">
      <header className="print-doc__head">
        <h1 className="print-doc__title">{doc.title.trim() || "Untitled"}</h1>
        {author.trim() && <p className="print-doc__author">{author}</p>}
        {doc.lede.trim() && (
          <div className="print-doc__abstract">
            <Markdown text={doc.lede} variant="doc" />
          </div>
        )}
      </header>
      {printGroups(numbered).map((group) => {
        const blocks = group.blocks.map((n, i) => (
          <div key={n.block.id} className={`print-doc__block${i < group.blocks.length - 1 ? " print-doc__block--heading" : ""}`} data-block={n.block.id}>
            <Markdown text={n.text} variant="doc" normalized />
          </div>
        ));
        return group.blocks.length > 1 ? (
          <div key={group.key} className="print-doc__group">
            {blocks}
          </div>
        ) : (
          blocks
        );
      })}
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
  );
});

export function PrintDocument({ job, onReady }: { job: PrintJob; onReady: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [pictures, setPictures] = useState<ReadonlyMap<string, GraphPicture | null>>(() => new Map());
  const [asked, setAsked] = useState<ReadonlyMap<string, { code: string; dim: 2 | 3 }>>(() => new Map());
  const [measuring, setMeasuring] = useState(true);
  const drawing = useRef(new Set<string>());

  const print = useMemo<PrintPictures>(
    () => ({
      get: (key) => (pictures.has(key) ? pictures.get(key) : undefined),
      request: (key, code, dim) => setAsked((prev) => (prev.has(key) ? prev : new Map(prev).set(key, { code, dim }))),
    }),
    [pictures],
  );
  const graphs = useMemo(() => ({ editable: false, compact: false, print }), [print]);

  // Graphs ask for their pictures as they render; each is drawn once, after the fonts load.
  useEffect(() => {
    for (const [key, { code, dim }] of asked) {
      if (drawing.current.has(key)) continue;
      drawing.current.add(key);
      void (async () => {
        await document.fonts?.ready;
        const picture = await graphPicture(code, dim);
        setPictures((prev) => new Map(prev).set(key, picture));
      })();
    }
  }, [asked]);

  // Once every graph is pictured and every image decoded, fit the copy to the page. A picture that
  // never comes (it shouldn't) doesn't hold printing up for long.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setWaited(true), 20_000);
    return () => window.clearTimeout(id);
  }, []);
  useEffect(() => {
    const el = root.current;
    const pending = () => !waited && !!el?.querySelector("[data-graph-pending]");
    if (!measuring || !el || pending()) return;
    let live = true;
    void (async () => {
      await document.fonts?.ready;
      await Promise.all([...el.querySelectorAll("img")].map((img) => img.decode().catch(() => {})));
      if (!live || pending()) return;
      fitEquations(el);
      markKeeps(el);
      setMeasuring(false);
    })();
    return () => {
      live = false;
    };
  }, [measuring, pictures, asked, waited]);

  const ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => {
    if (!measuring) ready.current();
  }, [measuring]);

  return createPortal(
    <div ref={root} className={`print-root${measuring ? " is-measuring" : ""}`} aria-hidden="true">
      <MediaContext.Provider value={job.doc.id}>
        <GraphContext.Provider value={graphs}>
          <PrintArticle doc={job.doc} numbered={job.numbered} author={job.author} references={job.references} />
        </GraphContext.Provider>
      </MediaContext.Provider>
    </div>,
    document.body,
  );
}
