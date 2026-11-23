import { useState, type DragEvent } from "react";

export type DropTarget = "new" | "append" | "ask" | "insert";

interface Props {
  /** The open document's title, when there is one to add to. */
  documentTitle: string | null;
  /** Whether the collaborator is open to take files with a question. */
  canAsk: boolean;
  /** Whether a paragraph is open for editing, to put images into. */
  canInsert: boolean;
  onDrop: (files: File[], target: DropTarget) => void;
  onCancel: () => void;
}

/**
 * Shown while files are dragged over the window: drop to import as a new document or into
 * this one, to put images into the paragraph being edited, or to ask the collaborator.
 */
export function DropOverlay({ documentTitle, canAsk, canInsert, onDrop, onCancel }: Props) {
  const [over, setOver] = useState<DropTarget | null>(null);

  const zone = (target: DropTarget, title: string, text: string) => (
    <div
      className={`drop-zone${over === target ? " is-over" : ""}`}
      onDragEnter={(e) => {
        e.preventDefault();
        setOver(target);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setOver(target);
      }}
      onDragLeave={() => setOver((o) => (o === target ? null : o))}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        const files = [...e.dataTransfer.files];
        if (files.length) onDrop(files, target);
        else onCancel();
      }}
    >
      <span className="drop-zone__title">{title}</span>
      <span className="drop-zone__text">{text}</span>
    </div>
  );

  return (
    <div
      className="drop-overlay"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onCancel();
      }}
      onDragLeave={(e) => {
        if (!e.relatedTarget) onCancel();
      }}
    >
      <div className="drop-overlay__zones">
        {canInsert && zone("insert", "Put in this paragraph", "Images go where the cursor is, kept with the document")}
        {zone("new", "Import as a new document", "Papers, photos of notes, LaTeX, Markdown, Word, notebooks")}
        {documentTitle !== null &&
          zone("append", `Add to “${documentTitle || "Untitled"}”`, "Transcribed onto the end of this document")}
        {canAsk && zone("ask", "Ask the collaborator", "Attached to your next question, pictures and all")}
      </div>
    </div>
  );
}
