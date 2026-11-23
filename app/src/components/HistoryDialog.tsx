// A document's earlier versions: kept every ten minutes or so while it's edited, and before an
// Auto reply or a seminar changes it. Each can be read as it was and brought back; bringing one
// back keeps the document as it is now as another version, so nothing is lost either way.

import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "../lib/api";
import { numberBlocks } from "../lib/doc";
import { timeAgo } from "../lib/text";
import type { Doc, Version } from "../lib/types";
import { Close } from "./Icons";
import { Markdown } from "./Markdown";

function when(at: number): string {
  const date = new Date(at);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `Today, ${time}` : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" })}, ${time}`;
}

export function HistoryDialog({ doc, onRestore, onClose }: { doc: Doc; onRestore: (version: Doc, at: number) => Promise<void>; onClose: () => void }) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<Doc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    api.listVersions(doc.id).then(
      (list) => {
        setVersions(list);
        setSelected(list[0]?.id ?? null);
      },
      (err) => setError(errorMessage(err)),
    );
  }, [doc.id]);

  useEffect(() => {
    if (!selected) return setPreview(null);
    let live = true;
    api.loadVersion(doc.id, selected).then(
      (version) => live && setPreview(version),
      (err) => live && setError(errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [doc.id, selected]);

  const shown = useMemo(() => (preview ? numberBlocks(preview.blocks).filter((n) => !n.block.suggestion && n.text.trim()) : []), [preview]);
  const version = versions?.find((v) => v.id === selected);
  const same = !!preview && preview.title === doc.title && preview.lede === doc.lede && JSON.stringify(preview.blocks) === JSON.stringify(doc.blocks);

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog history-dialog" role="dialog" aria-labelledby="history-title">
        <header className="dialog__head">
          <h2 id="history-title">Version history</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <Close size={12} />
          </button>
        </header>
        <div className="history">
          <ol className="history__list" aria-label="Versions">
            {versions?.length === 0 && <li className="history__empty">No versions yet. One is kept every ten minutes or so while you write, and before the collaborator works on the document.</li>}
            {versions?.map((v) => (
              <li key={v.id}>
                <button type="button" className={`history__item${v.id === selected ? " is-on" : ""}`} onClick={() => setSelected(v.id)}>
                  <span className="history__when">{when(v.at)}</span>
                  {v.label && <span className="history__label">{v.label}</span>}
                  <span className="history__meta">
                    {timeAgo(v.at)} · {v.blocks} {v.blocks === 1 ? "block" : "blocks"} · {v.words.toLocaleString()} {v.words === 1 ? "word" : "words"}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <div className="history__preview">
            {preview ? (
              <article>
                <h3 className="history__title">{preview.title.trim() || "Untitled"}</h3>
                {preview.lede.trim() && (
                  <div className="history__lede">
                    <Markdown text={preview.lede} variant="doc" />
                  </div>
                )}
                {shown.map((n) => (
                  <div key={n.block.id} className="history__block">
                    <Markdown text={n.text} variant="doc" normalized />
                  </div>
                ))}
              </article>
            ) : (
              versions?.length !== 0 && <p className="history__empty">{error ?? "Loading…"}</p>
            )}
          </div>
        </div>
        {error && preview && (
          <p className="dialog__error" role="alert">
            {error}
          </p>
        )}
        <footer className="dialog__foot history__foot">
          <span className="history__note">{same ? "This version is the same as the document now." : "Bringing a version back keeps the document as it is now as a version too. Threads stay as they are."}</span>
          <button type="button" className="text-button" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="button button--cream"
            disabled={!preview || !version || same || restoring}
            onClick={async () => {
              if (!preview || !version) return;
              setRestoring(true);
              try {
                await onRestore(preview, version.at);
              } catch (err) {
                setError(errorMessage(err));
                setRestoring(false);
              }
            }}
          >
            {restoring ? "Restoring…" : "Restore this version"}
          </button>
        </footer>
      </div>
    </div>
  );
}
