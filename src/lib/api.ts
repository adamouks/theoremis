import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  ChatMessage,
  Conversation,
  ConversationSummary,
  Provider,
  ProviderStatus,
  Settings,
  SettingsUpdate,
  StreamEvent,
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

  listConversations: () => invoke<ConversationSummary[]>("list_conversations"),
  loadConversation: (id: string) => invoke<Conversation>("load_conversation", { id }),
  saveConversation: (conversation: Conversation) =>
    invoke<void>("save_conversation", { conversation }),
  deleteConversation: (id: string) => invoke<void>("delete_conversation", { id }),
};

/** Tauri rejects with the serialized `AppError` string; anything else is unexpected. */
export function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
