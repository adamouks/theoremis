// A document's macros and references: paste a paper's preamble or a .bib file, or add a
// reference by its arXiv id or DOI. Both are the document's own and travel with it.

import { useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../lib/api";
import { formatEntry, parseBibtex, protectTitle, suggestKey } from "../lib/bibtex";
import { readMacros } from "../lib/macros";
import { Check, Close, Copy } from "./Icons";
import { Markdown } from "./Markdown";

type Tab = "macros" | "references";

export function NotationDialog({
  macros: initialMacros,
  bibliography: initialBibliography,
  cited,
  initialTab = "macros",
  onSave,
  onClose,
}: {
  macros: string;
  bibliography: string;
  /** The keys the document cites. */
  cited: Set<string>;
  initialTab?: Tab;
  onSave: (macros: string, bibliography: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [macros, setMacros] = useState(initialMacros);
  const [bibliography, setBibliography] = useState(initialBibliography);
  const [lookup, setLookup] = useState("");
  const [looking, setLooking] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const bibFile = useRef<HTMLInputElement>(null);

  const read = useMemo(() => readMacros(macros), [macros]);
  const bib = useMemo(() => parseBibtex(bibliography), [bibliography]);
  const changed = macros !== initialMacros || bibliography !== initialBibliography;

  const append = (entry: string) => setBibliography((b) => (b.trim() ? `${b.trimEnd()}\n\n${entry.trim()}\n` : `${entry.trim()}\n`));

  const add = async () => {
    const text = lookup.trim();
    if (!text || looking) return;
    setLooking(true);
    setLookupError(null);
    try {
      const found = await api.lookupReference(text);
      const entry = parseBibtex(found).entries[0];
      if (!entry) throw new Error("The reference that came back couldn’t be read.");
      const key = suggestKey(entry, new Set(bib.entries.map((e) => e.key)));
      append(protectTitle(found.replace(/^(\s*@\s*\w+\s*\{)\s*[^,]*,/, `$1${key},`)));
      setLookup("");
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : errorMessage(err));
    } finally {
      setLooking(false);
    }
  };

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="dialog notation-dialog"
        aria-labelledby="notation-title"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(macros, bibliography);
        }}
      >
        <header className="dialog__head">
          <h2 id="notation-title">Macros and references</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <Close size={12} />
          </button>
        </header>
        <div className="notation-tabs" role="tablist">
          {(["macros", "references"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "is-on" : undefined} onClick={() => setTab(t)}>
              {t === "macros" ? "Macros" : "References"}
              <span className="notation-tabs__count">{t === "macros" ? read.definitions.length : bib.entries.length}</span>
            </button>
          ))}
        </div>

        <div className="dialog__body">
          {tab === "macros" ? (
            <section className="settings-section">
              <label className="field">
                <span>Definitions</span>
                <textarea
                  className="notation-source"
                  rows={10}
                  spellCheck={false}
                  placeholder={"\\newcommand{\\R}{\\mathbb{R}}\n\\newcommand{\\norm}[1]{\\lVert #1 \\rVert}\n\\DeclareMathOperator{\\Hom}{Hom}"}
                  value={macros}
                  onChange={(e) => setMacros(e.target.value)}
                />
                <small>
                  Paste your paper’s preamble: \newcommand, \renewcommand, \DeclareMathOperator and \def are read, the rest is left out. The document’s math uses them, the
                  collaborator is told about them, and the LaTeX export puts them in its preamble.
                </small>
              </label>
              {read.definitions.length > 0 && (
                <div className="notation-chips" aria-label="Defined">
                  {read.definitions.map((d) => (
                    <code key={d.name + d.source}>{d.name}</code>
                  ))}
                </div>
              )}
              {read.problems.map((p) => (
                <p key={p} className="notation-problem">
                  {p}
                </p>
              ))}
              {read.ignored.length > 0 && (
                <p className="notation-note">
                  Left out, as they aren’t macro definitions: <code>{read.ignored.slice(0, 4).join("  ")}</code>
                  {read.ignored.length > 4 ? ` and ${read.ignored.length - 4} more` : ""}.
                </p>
              )}
            </section>
          ) : (
            <section className="settings-section">
              <div className="field">
                <span>Add a reference</span>
                <div className="notation-lookup">
                  <input
                    value={lookup}
                    spellCheck={false}
                    placeholder="An arXiv id or a DOI, e.g. 2301.01234 or 10.4007/annals.2005.162.1"
                    onChange={(e) => setLookup(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void add();
                      }
                    }}
                  />
                  <button type="button" className="button button--ghost button--small" disabled={!lookup.trim() || looking} onClick={() => void add()}>
                    {looking ? "Looking up…" : "Add"}
                  </button>
                  <button type="button" className="text-button" onClick={() => bibFile.current?.click()}>
                    Import .bib…
                  </button>
                  <input
                    ref={bibFile}
                    type="file"
                    accept=".bib,text/x-bibtex,text/plain"
                    hidden
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (file) append(await file.text());
                    }}
                  />
                </div>
                {lookupError && <small className="notation-problem">{lookupError}</small>}
                <small>Looked up on arXiv or doi.org. Cite one in the document with \cite{"{key}"} or \cite[Theorem 2]{"{key}"}.</small>
              </div>

              {bib.entries.length > 0 && (
                <ul className="notation-entries">
                  {bib.entries.map((entry) => (
                    <li key={entry.key}>
                      <div className="notation-entries__head">
                        <code>{entry.key}</code>
                        <span className={`notation-entries__state${cited.has(entry.key) ? " is-cited" : ""}`}>{cited.has(entry.key) ? "Cited" : "Not cited yet"}</span>
                        <button
                          type="button"
                          className="text-button"
                          onClick={async () => {
                            await navigator.clipboard.writeText(`\\cite{${entry.key}}`);
                            setCopied(entry.key);
                            window.setTimeout(() => setCopied(null), 1400);
                          }}
                        >
                          {copied === entry.key ? <Check /> : <Copy />}
                          {copied === entry.key ? "Copied" : `Copy \\cite`}
                        </button>
                      </div>
                      <Markdown text={formatEntry(entry)} variant="note" />
                    </li>
                  ))}
                </ul>
              )}
              {bib.problems.map((p) => (
                <p key={p} className="notation-problem">
                  {p}
                </p>
              ))}

              <label className="field">
                <span>BibTeX</span>
                <textarea
                  className="notation-source"
                  rows={8}
                  spellCheck={false}
                  placeholder={"@article{wiles1995,\n  author = {Wiles, Andrew},\n  title = {Modular elliptic curves and Fermat's Last Theorem},\n  journal = {Ann. of Math.},\n  year = {1995},\n}"}
                  value={bibliography}
                  onChange={(e) => setBibliography(e.target.value)}
                />
                <small>The export writes this as references.bib, numbered with amsplain as here.</small>
              </label>
            </section>
          )}
        </div>

        <footer className="dialog__foot">
          <button type="button" className="text-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button--cream" disabled={!changed}>
            Save
          </button>
        </footer>
      </form>
    </div>
  );
}
