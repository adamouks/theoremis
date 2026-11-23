// What a model is told when it transcribes a paper, notes or a LaTeX source into Theoremis.

import type { ChatMessage } from "./types";

export const TRANSCRIBE_INSTRUCTIONS = String.raw`You transcribe mathematical writing into Theoremis, a workspace where a mathematician studies and checks results statement by statement. The source may be a typeset paper, lecture notes, photos of handwritten work, or a LaTeX file.

Transcribe faithfully and completely: every definition, statement, proof, example, remark and the prose between them, in the source's order, wording and numbering. Do not summarize, skip, merge, explain or correct anything. If something looks wrong, transcribe it as written. Mark words you cannot read as [illegible].

Write Markdown with LaTeX: $…$ inline, and display math on its own lines between $$ lines. Aligned equations go inside $$ as \begin{align}…\end{align}; mark rows that should not be numbered with \notag. Theorem-like statements open with a bold label followed by the statement in italics, e.g. **Theorem 2.1.** *For every …*, and proofs open with *Proof.* Section headings are ## (subsections ###). Lists stay lists. Tables become Markdown tables. Drop running heads, page numbers, line numbers, footers and journal boilerplate. Keep citations as written, e.g. [12]; references at the end become a list.

Answer only in this format. Each section starts with a line beginning with @@:

@@ title
The document's title (first part only).
@@ lede
The abstract, or a one-paragraph summary if there is none (first part only).
@@ block page=<page number>
One block: a heading, a paragraph, a statement, a proof (long proofs split into several blocks at paragraph breaks), a display equation together with the sentence it belongs to, a list, a table or a figure.

Give theorem-like statements a status in their @@ block line:
- status=draft note="proof in source" for a theorem, lemma, proposition or corollary the source proves;
- status=open for a conjecture, a question, or a statement given without proof (note="cited" if it is quoted from another work);
- status=tested note="numerical evidence" for a claim supported only by computation.
Use no other statuses, and none on ordinary paragraphs.

Figures are copied from the source, never redrawn or described in prose. Candidate figures are outlined on the page images with dashed boxes labelled F1, F2, … and listed in the request. To place one, write a block containing only ![<the caption, with math in $…$>](figure:F2). For a picture without a box, or with a wrong box, give its position as fractions of the page's width and height from the top left: ![<caption>](crop:<page>:<left>,<top>,<right>,<bottom>), for example crop:3:0.12,0.40,0.88,0.71. Never use a figure for an equation, a table or text: transcribe those.

If this part begins in the middle of a paragraph or proof that the previous part was transcribing, start with @@ block page=<n> continues and write only the continuation. Write nothing outside the format.`;

export interface Candidate {
  id: string;
  page: number;
  /** Where on the page, in words, e.g. "upper half". */
  where: string;
  caption: string | null;
}

export interface PartRequest {
  name: string;
  part: number;
  parts: number;
  /** "pages 5–8 of 24", "photo 2 of 3", "lines 1–400". */
  span: string;
  /** The end of the transcription so far, to continue from. */
  previous: string;
  /** Statement labels used so far, to keep numbering consistent. */
  labels: string[];
  candidates: Candidate[];
  /** The text layer of each page, or the text of a part of a text file. */
  texts: { label: string; text: string }[];
  images: string[];
  /** What the source is, in words: "a PDF", "photos", "LaTeX source". */
  kind: "pdf" | "images" | "latex" | "markdown" | "text";
}

/** Where a box sits on its page, in words a model can match to the image. */
export function describePosition(top: number, bottom: number, left: number, right: number): string {
  const vertical = (top + bottom) / 2 < 0.34 ? "top" : (top + bottom) / 2 > 0.66 ? "bottom" : "middle";
  const wide = right - left > 0.6;
  const horizontal = wide ? "" : (left + right) / 2 < 0.4 ? " left" : (left + right) / 2 > 0.6 ? " right" : "";
  return `${vertical}${horizontal} of the page (${Math.round(top * 100)}%–${Math.round(bottom * 100)}% down)`;
}

export function buildPartRequest(request: PartRequest): ChatMessage[] {
  const lines: string[] = [];
  const what =
    request.kind === "pdf"
      ? "a PDF"
      : request.kind === "images"
        ? "photos or scans"
        : request.kind === "latex"
          ? "a LaTeX source file"
          : request.kind === "markdown"
            ? "a Markdown file"
            : "a text file";
  lines.push(`Transcribe part ${request.part} of ${request.parts} of "${request.name}" (${what}): ${request.span}.`);
  if (request.part === 1) lines.push("This is the first part: begin with @@ title and @@ lede.");
  else lines.push("Do not repeat the title or the lede.");
  if (request.previous.trim()) {
    lines.push(`The transcription so far ends with:\n"""\n${request.previous.trim()}\n"""`);
  }
  if (request.labels.length) lines.push(`Statement labels used so far: ${request.labels.join(", ")}.`);
  if (request.candidates.length) {
    lines.push(
      "Candidate figures:\n" +
        request.candidates
          .map((c) => `- ${c.id}: page ${c.page}, ${c.where}${c.caption ? `, captioned "${c.caption}"` : ""}`)
          .join("\n"),
    );
  } else if (request.images.length) {
    lines.push("No candidate figures were found; use crop: for any picture you see.");
  }
  if (request.kind === "latex") {
    lines.push(
      "Convert the LaTeX below. Expand simple macros, turn theorem environments into labelled statements with the source's numbering, and keep labels' numbers consistent. Figures whose image files were uploaded are listed as candidates by file name; for others write the caption as *[Figure: …]*.",
    );
  } else if (request.images.length && request.texts.some((t) => t.text.trim())) {
    lines.push(
      "The text layer extracted from the PDF follows each page label. Its spacing and math symbols are often garbled: take the words and numbers from it, and the mathematics from the images.",
    );
  } else if (!request.images.length && request.kind === "pdf") {
    lines.push(
      "Only the PDF's text layer is available (the model can't see images). Math was extracted as plain text and is often garbled: reconstruct the LaTeX with care, and mark anything you can't reconstruct as [unclear]. Place candidate figures where their captions appear.",
    );
  }
  for (const { label, text } of request.texts) {
    if (text.trim()) lines.push(`--- ${label} ---\n${text.trim()}`);
  }
  if (request.images.length) lines.push(`Images, in order: ${request.texts.map((t) => t.label).join(", ")}.`);
  return [
    { role: "system", content: TRANSCRIBE_INSTRUCTIONS },
    { role: "user", content: lines.join("\n\n"), ...(request.images.length ? { images: request.images } : {}) },
  ];
}
