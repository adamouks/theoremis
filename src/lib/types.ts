// Settings, model and storage types mirror the serde types in src-tauri/src. Keep them in sync.

export type Provider = "ollama" | "chatgpt";
export type Role = "system" | "user" | "assistant";

export interface ModelRef {
  provider: Provider;
  model: string;
}

export interface ModelInfo {
  provider: Provider;
  id: string;
  /** A friendlier display name, when the provider has one. */
  name: string | null;
  detail: string | null;
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
}

export interface SettingsUpdate {
  ollamaBaseUrl?: string;
  systemPrompt?: string;
  displayName?: string;
  lastModel?: ModelRef;
}

export interface ChatMessage {
  role: Role;
  content: string;
}

export type StreamEvent = { type: "delta"; text: string } | { type: "reasoning"; text: string };

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
}

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
  model?: ModelRef;
  error?: string;
  /** The block this reply was inserted as, if any. */
  insertedBlockId?: string;
  /** A rewrite of the selected block proposed in this reply, and what became of it. */
  revision?: Revision;
  createdAt: number;
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
