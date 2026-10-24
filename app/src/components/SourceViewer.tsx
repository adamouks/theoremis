import { useEffect, useRef, useState } from "react";
import { assetUrl, errorMessage } from "../lib/api";
import { releaseCanvas } from "../lib/media";
import type { PdfFile } from "../lib/pdf";
import type { Doc } from "../lib/types";
import { ChevronDown, Close } from "./Icons";

interface Props {
  doc: Doc;
  page: number;
  onClose: () => void;
}

/** The original of an imported document, a page at a time, to check a transcription against. */
export function SourceViewer({ doc, page: initial, onClose }: Props) {
  const origin = doc.origin!;
  const [page, setPage] = useState(initial);
  const [pdf, setPdf] = useState<PdfFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const pages = origin.kind === "images" ? origin.files.length : origin.pages;

  useEffect(() => {
    if (origin.kind !== "pdf") return;
    let cancelled = false;
    let opened: PdfFile | null = null;
    (async () => {
      try {
        const response = await fetch(assetUrl(doc.id, origin.files[0]));
        if (!response.ok) throw new Error("The original isn’t kept with this document any more.");
        const { openPdf } = await import("../lib/pdf");
        opened = await openPdf(new Uint8Array(await response.arrayBuffer()));
        if (cancelled) void opened.destroy();
        else setPdf(opened);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
      void opened?.destroy();
    };
  }, [doc.id, origin.kind, origin.files]);

  useEffect(() => {
    if (!pdf || !host.current) return;
    let cancelled = false;
    setRendering(true);
    (async () => {
      const p = await pdf.page(page);
      const width = Math.min(host.current!.clientWidth, 1100);
      const canvas = await p.render((width / p.width) * Math.min(2, window.devicePixelRatio || 1));
      p.release();
      if (cancelled) return releaseCanvas(canvas);
      canvas.style.width = `${width}px`;
      canvas.className = "source-viewer__page";
      const old = host.current!.querySelector("canvas");
      host.current!.replaceChildren(canvas);
      if (old) releaseCanvas(old);
      setRendering(false);
    })().catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [pdf, page]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" || e.key === "PageDown") setPage((p) => Math.min(pages, p + 1));
      else if (e.key === "ArrowLeft" || e.key === "PageUp") setPage((p) => Math.max(1, p - 1));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, pages]);

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="source-viewer" role="dialog" aria-label="Original">
        <header className="dialog__head">
          <h2>{origin.names[origin.kind === "images" ? page - 1 : 0] ?? "Original"}</h2>
          <div className="source-viewer__nav">
            <button type="button" className="icon-button source-viewer__prev" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronDown size={10} />
            </button>
            <span>
              {origin.kind === "pdf" ? "Page" : "Image"} {page} of {pages}
            </span>
            <button type="button" className="icon-button source-viewer__next" aria-label="Next page" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
              <ChevronDown size={10} />
            </button>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <Close size={12} />
          </button>
        </header>
        <div className={`source-viewer__body${rendering ? " is-rendering" : ""}`}>
          {error ? (
            <p className="dialog__error">{error}</p>
          ) : origin.kind === "images" ? (
            <img className="source-viewer__page" src={assetUrl(doc.id, origin.files[page - 1])} alt={origin.names[page - 1] ?? ""} />
          ) : (
            <div ref={host} className="source-viewer__host" />
          )}
        </div>
      </div>
    </div>
  );
}
