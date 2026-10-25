// Settings, model and storage types mirror the serde types in src-tauri/src. Keep them in sync.

export type Provider = "ollama" | "chatgpt";
export type Role = "system" | "user" | "assistant" | "tool";

export interface ModelRef {
  provider: Provider;
  model: string;
}

/** How hard a model can be asked to think (see `Effort` in providers/mod.rs). */
export interface Effort {
  /** An OpenAI reasoning effort (`none` … `xhigh`), or Ollama's `none` / `think`. */
  id: string;
  /** The provider's own description, when it gives one. */
  description: string | null;
}

export interface ModelInfo {
  provider: Provider;
  id: string;
  /** A friendlier display name, when the provider has one. */
  name: string | null;
  detail: string | null;
  /** Whether the model reads images, when the provider says. */
  vision: boolean | null;
  /** Whether the model can call tools, which Auto mode needs, when the provider says. */
  tools: boolean | null;
  /** The efforts the model takes, least first. Empty when there's no choice to make. */
  efforts: Effort[];
  /** The effort the provider uses when none is asked for. */
  defaultEffort: string | null;
}

export interface ProviderStatus {
  provider: Provider;
  available: boolean;
  models: ModelInfo[];
  message: string | null;
}

export interface Settings {
  ollamaBaseUrl: string;
  defaultOllamaBaseUrl: string;
  systemPrompt: string;
  displayName: string;
  lastModel: ModelRef | null;
  /** The first-run introduction has been completed (or skipped). */
  onboarded: boolean;
  /** The collaborator works on its own (Auto) instead of only proposing (Manual). */
  autoMode: boolean;
  /** With Auto on, it convenes a seminar of members instead of working alone. */
  seminar: boolean;
  /** The effort chosen for each model, keyed by `effortKey`. */
  efforts: Record<string, string>;
}

export interface SettingsUpdate {
  ollamaBaseUrl?: string;
  systemPrompt?: string;
  displayName?: string;
  lastModel?: ModelRef;
  onboarded?: boolean;
  autoMode?: boolean;
  seminar?: boolean;
  efforts?: Record<string, string>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** JSON text, as the model wrote it. */
  arguments: string;
}

/** A tool the model may call, with a JSON Schema for its arguments. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** The tools an assistant turn called. */
  toolCalls?: ToolCall[];
  /** For a tool result: the call it answers, and the tool's name. */
  toolCallId?: string;
  name?: string;
  /** Provider items to send back with an assistant turn unchanged (ChatGPT's encrypted reasoning). */
  opaque?: unknown[];
  /** `data:image/…;base64,…` URLs shown to the model with the text. */
  images?: string[];
}

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: string }
  | { type: "opaque"; item: unknown };

/** Whether a model reads images: ChatGPT models unless they say not, Ollama models that say so. */
export function readsImages(info: ModelInfo | null | undefined): boolean {
  return !!info && (info.provider === "chatgpt" ? info.vision !== false : info.vision === true);
}

/** Whether a model can work in Auto mode: ChatGPT models unless they say not, Ollama models that say so. */
export function callsTools(info: ModelInfo | null | undefined): boolean {
  return !!info && (info.provider === "chatgpt" ? info.tools !== false : info.tools === true);
}

export const PROVIDER_LABELS: Record<Provider, string> = {
  ollama: "Ollama",
  chatgpt: "ChatGPT",
};

/** Where people check how much of their ChatGPT plan they've used. */
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

/** The Sign in with ChatGPT connection. Credentials never reach the interface. */
export interface ChatGptSession {
  status: "signedOut" | "signingIn" | "connected" | "expired";
  name: string | null;
  email: string | null;
  /** Whether the account allowed Theoremis to use its ChatGPT plan. */
  sharing: boolean;
  /** Something to tell the person, e.g. that a sign-out wasn't confirmed by ChatGPT. */
  notice: string | null;
}

// ---------------------------------------------------------------------------
// Workspace

/**
 * How established a statement is, weakest first. `adopted` marks text accepted from a
 * collaborator suggestion that hasn't been checked independently.
 */
export type Status = "open" | "tested" | "draft" | "adopted" | "proved" | "verified";

export interface Block {
  id: string;
  /** Markdown with LaTeX math. */
  source: string;
  status?: Status;
  /** A short qualifier shown under the status, e.g. "tested to $10^4$". */
  note?: string;
  /** Set while the block is a collaborator suggestion awaiting a decision. */
  suggestion?: { threadId: string; messageId: string };
  /** The page of the imported original this block was transcribed from. */
  page?: number;
  /** Written or changed by the collaborator in Auto mode, until the person edits it. */
  byAgent?: { threadId: string; messageId: string };
}

/** How the collaborator works: proposes (Manual), acts (Auto), or convenes a seminar that acts. */
export type Work = "manual" | "auto" | "seminar";

export type Mode = "ask" | "explore" | "gaps" | "challenge" | "formalize";

export interface Context {
  /** What was selected, e.g. "Proof · (2)–(3)". */
  label: string;
  /** The LaTeX/Markdown source the collaborator receives. */
  text: string;
  blockId?: string;
}

export interface ThreadMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  mode: Mode;
  context?: Context;
  reasoning?: string;
  /** How long the model reasoned before answering, in whole seconds. */
  thoughtSeconds?: number;
  model?: ModelRef;
  /** The effort the reply was asked for. */
  effort?: string;
  error?: string;
  /** The block this reply was inserted as, if any. */
  insertedBlockId?: string;
  /** A rewrite of the selected block proposed in this reply, and what became of it. */
  revision?: Revision;
  /** Lean's verdicts on the reply's Lean code, one per code block checked. */
  leanChecks?: StoredLeanCheck[];
  /** Files sent with a question. */
  attachments?: Attachment[];
  /** What the collaborator did on its own, for a reply in Auto mode. */
  agent?: AgentRun;
  /** Who the seminar convened and what each did, for a reply in Seminar mode. */
  seminar?: SeminarRun;
  createdAt: number;
}

/** A reply in Auto mode: what the collaborator said and did, and how to take it back. */
export interface AgentRun {
  status: "running" | "done" | "stopped" | "failed" | "limit";
  /** What it wrote and the tools it used, in order. */
  steps: AgentStep[];
  /** Every change to the document, oldest first, for Undo. */
  changes: AgentChange[];
  undone?: boolean;
  /** When the run ended, to say how long it worked. */
  finishedAt?: number;
}

export type AgentStep =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      /** What it did, for people: "Rewrote Theorem 2", "Lean accepted the proof". */
      label: string;
      /** More to read on request, e.g. Lean's errors. */
      detail?: string;
      ok: boolean;
      pending?: boolean;
      /** The block it concerned, to show in the document. */
      blockId?: string;
      /** Lean accepted a proof of the block and it was marked verified. */
      verified?: boolean;
    };

/**
 * A reply in Seminar mode: the chair convenes a few members, each with one objective, who work
 * on the document at the same time; the chair then sums up (the reply's `content`).
 */
export interface SeminarRun {
  status: "convening" | "working" | "summing" | "done" | "stopped" | "failed";
  members: SeminarMember[];
  /** Every member's changes to the document, in the order they happened, for Undo. */
  changes: AgentChange[];
  undone?: boolean;
  finishedAt?: number;
}

export interface SeminarMember {
  id: string;
  /** "Prover", "Skeptic", "Formalizer"… */
  role: string;
  /** What it set out to do, in its own words. */
  objective: string;
  /** The blocks the chair gave it. */
  blocks: string[];
  status: "waiting" | "working" | "done" | "stopped" | "failed";
  steps: AgentStep[];
  /** What it told the chair when it finished. */
  report?: string;
  error?: string;
  /** How many of the seminar's changes are its. */
  changed: number;
  startedAt?: number;
  finishedAt?: number;
}

export type AgentChange =
  /** `before` is null for an insertion and `after` for a deletion; `index` is where the block was. */
  | { kind: "block"; blockId: string; before: Block | null; after: Block | null; index: number }
  | { kind: "header"; before: { title: string; lede: string }; after: { title: string; lede: string } };

export interface Attachment {
  /** The file's name as attached. */
  name: string;
  kind: "image" | "pdf" | "text";
  /** Media of the document shown to the model: the image, or a PDF's first pages. */
  images: string[];
  /** What the model reads: a PDF's text layer, or the file as text. */
  text?: string;
  /** A PDF's page count. */
  pages?: number;
}

export interface Revision {
  blockId: string;
  text: string;
  state: "pending" | "accepted" | "rejected";
  /** The block's source before the revision was accepted, for Undo. */
  previous?: string;
}

export interface Thread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ThreadMessage[];
}

/** What a document was transcribed from: a paper, photos of notes, a LaTeX source. */
export interface DocOrigin {
  kind: "pdf" | "images" | "text";
  /** The original file names, as uploaded. */
  names: string[];
  /** The originals, kept with the document's media; for `images`, one file per page. */
  files: string[];
  /** Pages (or, for text, parts) in the original. */
  pages: number;
  /** The first and last page chosen for transcription. */
  from: number;
  to: number;
  /** Pages transcribed so far; less than `to` while an import is unfinished. */
  done: number;
  /** Who transcribed it; none when imported without the collaborator. */
  model?: ModelRef;
  importedAt: number;
}

export interface Doc {
  id: string;
  projectId: string;
  title: string;
  /** The summary paragraph under the title. */
  lede: string;
  blocks: Block[];
  threads: Thread[];
  activeThreadId?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  /** Derived on save so the sidebar can show it without loading every document. */
  status: Status;
  pending: number;
  /** Set when the document was imported from a file. */
  origin?: DocOrigin;
  /** The document's LaTeX macros: \newcommand, \DeclareMathOperator… (lib/macros.ts). */
  macros?: string;
  /** Its references, as BibTeX, cited with \cite{key} (lib/bibtex.ts). */
  bibliography?: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  collapsed: boolean;
}

export interface DocumentSummary {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: Status | null;
  pending: number;
}

export interface Workspace {
  projects: Project[];
  documents: DocumentSummary[];
}

// ---------------------------------------------------------------------------
// Lean 4 and Mathlib

export interface LeanStatus {
  /** Lean's toolchain manager (elan) is installed. */
  installed: boolean;
  /** Mathlib is downloaded and formalizations can be checked. */
  ready: boolean;
  leanVersion: string | null;
  /** The Mathlib commit, abbreviated. */
  mathlibVersion: string | null;
  settingUp: boolean;
  projectPath: string;
}

export type LeanSetupEvent = { type: "step"; text: string } | { type: "line"; text: string };

/** proved: every proof accepted, none resting on `sorry`. incomplete: compiles with `sorry`. */
export type LeanOutcome = "proved" | "incomplete" | "failed";

export interface LeanMessage {
  severity: "error" | "warning" | "information";
  line: number;
  column: number;
  endLine: number | null;
  endColumn: number | null;
  text: string;
}

export interface LeanTheorem {
  name: string;
  /** Axioms beyond propext, choice and quotient soundness, e.g. `Lean.ofReduceBool`. */
  extraAxioms: string[];
}

export interface LeanCheck {
  outcome: LeanOutcome;
  messages: LeanMessage[];
  theorems: LeanTheorem[];
  seconds: number;
}

export interface StoredLeanCheck extends LeanCheck {
  /** The code that was checked, so an edited reply isn't mistaken for a checked one. */
  code: string;
  checkedAt: number;
}
