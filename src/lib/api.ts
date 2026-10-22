import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  ChatGptSession,
  ChatMessage,
  LeanCheck,
  LeanSetupEvent,
  LeanStatus,
  Doc,
  DocumentSummary,
  Project,
  Provider,
  ProviderStatus,
  Settings,
  SettingsUpdate,
  StreamEvent,
  Workspace,
} from "./types";

export interface StreamRequest {
  requestId: string;
  provider: Provider;
  model: string;
  messages: ChatMessage[];
  onEvent: (event: StreamEvent) => void;
}

/** Typed wrappers around the Rust commands in src-tauri/src/lib.rs. */
export const api = {
  getSettings: () => invoke<Settings>("get_settings"),
  updateSettings: (update: SettingsUpdate) => invoke<Settings>("update_settings", { update }),
  listModels: () => invoke<ProviderStatus[]>("list_models"),

  chatgptSession: () => invoke<ChatGptSession>("chatgpt_session"),
  /**
   * Opens ChatGPT's sign-in page in the browser and resolves once the person finishes there.
   * `fresh` sets the saved account aside so a different one can sign in.
   */
  chatgptSignIn: (fresh = false) => invoke<ChatGptSession>("chatgpt_sign_in", { fresh }),
  chatgptCancelSignIn: () => invoke<boolean>("chatgpt_cancel_sign_in"),
  chatgptSignOut: () => invoke<ChatGptSession>("chatgpt_sign_out"),

  /**
   * Resolves once the reply is complete or cancelled and every streamed event has been
   * delivered; rejects with a readable message on failure.
   */
  async streamChat({ requestId, provider, model, messages, onEvent }: StreamRequest) {
    let markDone = () => {};
    const done = new Promise<void>((resolve) => (markDone = resolve));
    const channel = new Channel<StreamEvent | { type: "done" }>();
    channel.onmessage = (event) => (event.type === "done" ? markDone() : onEvent(event));

    const outcome = await invoke<{ cancelled: boolean }>("chat_stream", {
      requestId,
      provider,
      model,
      messages,
      onEvent: channel,
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    // Channel messages travel separately from the command result; wait for the
    // backend's final marker so trailing deltas aren't lost.
    await Promise.race([done, new Promise((resolve) => window.setTimeout(resolve, 1500))]);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  },
  cancelChat: (requestId: string) => invoke<boolean>("chat_cancel", { requestId }),

  leanStatus: () => invoke<LeanStatus>("lean_status"),
  /** Installs Lean and downloads Mathlib; resolves with the new status when done. */
  leanSetup: (onEvent: (event: LeanSetupEvent) => void) => {
    const channel = new Channel<LeanSetupEvent>();
    channel.onmessage = onEvent;
    return invoke<LeanStatus>("lean_setup", { onEvent: channel });
  },
  leanCancelSetup: () => invoke<boolean>("lean_cancel_setup"),
  leanCheck: (code: string) => invoke<LeanCheck>("lean_check", { code }),

  loadWorkspace: () => invoke<Workspace>("load_workspace"),
  saveProjects: (projects: Project[]) => invoke<void>("save_projects", { projects }),
  loadDocument: (id: string) => invoke<Doc>("load_document", { id }),
  saveDocument: (document: Doc) => invoke<DocumentSummary>("save_document", { document }),
  deleteDocument: (id: string) => invoke<void>("delete_document", { id }),
};

/** Tauri rejects with the serialized `AppError` string; anything else is unexpected. */
export function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
