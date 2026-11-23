// What an "Is it known?" reply searched for and found, numbered as the reply cites them, each
// with a way to open it and to add it to the document's references.

import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { errorMessage } from "../../lib/api";
import { findReference } from "../../lib/bibtex";
import type { Literature, Paper } from "../../lib/types";
import { Check, ChevronDown } from "../Icons";
import { Orb, Shimmer } from "./effects";

export function Sources({
  literature,
  bibliography,
  onAdd,
}: {
  literature: Literature;
  /** The document's references, to show which papers are in them already. */
  bibliography: string | undefined;
  /** Adds a paper to the references; resolves to its key. */
  onAdd: (paper: Paper) => Promise<string>;
}) {
  const [open, setOpen] = useState(true);
  const queries = literature.queries.map((q) => `“${q}”`).join(", ");

  if (literature.status === "searching") {
    return (
      <div className="agent-working">
        <Orb activity="acting" />
        <Shimmer>{literature.queries.length ? `Searching arXiv and Crossref for ${queries}…` : "Choosing what to search for…"}</Shimmer>
      </div>
    );
  }
  if (literature.status === "failed") {
    return <p className="sources__note">The search couldn’t run{literature.error ? `: ${literature.error}` : ""}.</p>;
  }
  const count = literature.papers.length;
  return (
    <div className="sources">
      <button type="button" className="sources__head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>
          Searched arXiv and Crossref for {queries} · {count ? `${count} ${count === 1 ? "paper" : "papers"}` : "nothing found"}
        </span>
        {count > 0 && <ChevronDown size={9} />}
      </button>
      {literature.unavailable && literature.unavailable.length > 0 && (
        <p className="sources__note">{literature.unavailable.join(" and ")} didn’t answer, so this may be incomplete.</p>
      )}
      {open && count > 0 && (
        <ol className="sources__list">
          {literature.papers.map((paper, i) => (
            <Source key={paper.id} n={i + 1} paper={paper} present={findReference(bibliography, paper.id) ?? (paper.doi ? findReference(bibliography, paper.doi) : undefined)} onAdd={onAdd} />
          ))}
        </ol>
      )}
    </div>
  );
}

function Source({ n, paper, present, onAdd }: { n: number; paper: Paper; present?: string; onAdd: (paper: Paper) => Promise<string> }) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const who = paper.authors.length > 3 ? `${paper.authors.slice(0, 3).join(", ")} et al.` : paper.authors.join(", ");
  return (
    <li className="source">
      <span className="source__n">[{n}]</span>
      <div className="source__main">
        <button type="button" className="source__title" title={paper.url} onClick={() => void openUrl(paper.url)}>
          {paper.title}
        </button>
        <span className="source__meta">{[who, paper.year, paper.venue].filter(Boolean).join(" · ")}</span>
        {error && <span className="source__error">{error}</span>}
      </div>
      {present ? (
        <span className="source__added" title={`Cite it with \\cite{${present}}`}>
          <Check />
          {present}
        </span>
      ) : (
        <button
          type="button"
          className="text-button source__add"
          disabled={adding}
          onClick={async () => {
            setAdding(true);
            setError(null);
            try {
              await onAdd(paper);
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setAdding(false);
            }
          }}
        >
          {adding ? "Adding…" : "Add to references"}
        </button>
      )}
    </li>
  );
}
