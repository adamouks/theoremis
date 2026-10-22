// Mirrors the serde types in src-tauri/src. Keep the two in sync.

export type Provider = "ollama" | "openai";
export type Role = "system" | "user" | "assistant";

export interface ModelRef {
  provider: Provider;
  model: string;
}

export interface ModelInfo {
  provider: Provider;
  id: string;
  detail: string | null;
}

export interface ProviderStatus {
  provider: Provider;
  available: boolean;
  models: ModelInfo[];
  message: string | null;
}

export interface KeyStatus {
  source: "settings" | "env" | "none";
  hint: string | null;
}

export interface Settings {
  ollamaBaseUrl: string;
  openaiBaseUrl: string;
  defaultOllamaBaseUrl: string;
  defaultOpenaiBaseUrl: string;
  openaiKey: KeyStatus;
  systemPrompt: string;
  lastModel: ModelRef | null;
}

export interface SettingsUpdate {
  ollamaBaseUrl?: string;
  openaiBaseUrl?: string;
  /** An empty string removes the stored key. */
  openaiApiKey?: string;
  systemPrompt?: string;
  lastModel?: ModelRef;
}

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface Message extends ChatMessage {
  id: string;
  reasoning?: string;
  model?: ModelRef;
  error?: string;
  createdAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: ModelRef | null;
  messages: Message[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  model: ModelRef | null;
}

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string };

export const PROVIDER_LABELS: Record<Provider, string> = {
  ollama: "Ollama",
  openai: "ChatGPT",
};
