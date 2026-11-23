import { PROVIDER_LABELS, type Doc, type ModelRef } from "../lib/types";
import type { ImportJob } from "../lib/useImport";

interface Props {
  doc: Doc;
  job: ImportJob | null;
  /** A model is selected and available, so an unfinished import can continue. */
  canContinue: boolean;
  model: ModelRef | null;
  onStop: () => void;
  onDismiss: () => void;
  onContinue: () => void;
  onShowOriginal: (page: number) => void;
}

/** The import's progress over the document it is filling, and what to do when it stops. */
export function ImportBanner({ doc, job, canContinue, model, onStop, onDismiss, onContinue, onShowOriginal }: Props) {
  const origin = doc.origin;
  const mine = job && job.docId === doc.id ? job : null;
  const unfinished = origin && origin.done < origin.to;
  if (!mine && !unfinished) return null;

  const active = mine && (mine.stage === "preparing" || mine.stage === "reading" || mine.stage === "transcribing");
  const who = mine?.model ?? origin?.model ?? null;
  const by = who ? ` with ${who.provider === "chatgpt" ? PROVIDER_LABELS.chatgpt : who.model}` : "";
  const next = origin ? origin.done + 1 : 1;

  let title: string;
  let detail: string;
  if (active) {
    title = mine.detail;
    detail = `${mine.name}${by}${mine.queued ? ` · ${mine.queued} more waiting` : ""}`;
  } else if (mine?.stage === "done") {
    title = origin?.model || mine.model ? "Transcribed. Check it against the original." : "Imported.";
    detail = `${mine.name}${by}${mine.figures ? ` · ${mine.figures} ${mine.figures === 1 ? "figure" : "figures"} copied` : ""}`;
  } else if (mine?.stage === "failed") {
    title = mine.error ?? "The import stopped.";
    detail = origin && unfinished ? `Transcribed up to page ${origin.done} of ${origin.to}.` : mine.name;
  } else {
    title = origin && unfinished ? `Transcription stopped after ${origin.kind === "pdf" ? "page" : "part"} ${origin.done} of ${origin.to}.` : "Stopped.";
    detail = origin?.names.join(", ") ?? mine?.name ?? "";
  }

  return (
    <div className={`import-banner${mine?.stage === "failed" ? " import-banner--error" : ""}`} role="status">
      <div className="import-banner__text">
        <span className="import-banner__title">{title}</span>
        <span className="import-banner__detail">{detail}</span>
      </div>
      {active && (
        <div className="import-banner__bar" aria-hidden="true">
          <span style={{ width: `${Math.round(Math.max(0.04, mine.progress) * 100)}%` }} />
        </div>
      )}
      <div className="import-banner__actions">
        {active && (
          <button type="button" className="text-button" onClick={onStop}>
            Stop
          </button>
        )}
        {!active && origin && origin.files.length > 0 && origin.kind !== "text" && (
          <button type="button" className="text-button" onClick={() => onShowOriginal(origin.from)}>
            View original
          </button>
        )}
        {!active && unfinished && (
          <button
            type="button"
            className="button button--small button--primary"
            onClick={onContinue}
            disabled={!canContinue}
            title={canContinue ? `Continue with ${model?.model ?? "the selected model"}` : "Choose a model in the collaborator panel to continue"}
          >
            Continue from {origin.kind === "pdf" ? "page" : "part"} {next}
          </button>
        )}
        {!active && mine && (
          <button type="button" className="text-button" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
