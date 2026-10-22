import { useEffect, useRef } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Conversation, ProviderStatus } from "../lib/types";
import { LogoMark } from "./Icons";
import { MessageView } from "./MessageView";

const SUGGESTIONS = [
  "Prove that there are infinitely many primes.",
  "Explain the Cauchy–Schwarz inequality with an example.",
  "Solve x² − 5x + 6 = 0 and show each step.",
  "What do Gödel's incompleteness theorems actually say?",
];

interface Props {
  conversation: Conversation;
  streaming: boolean;
  providers: ProviderStatus[];
  modelsLoading: boolean;
  hasModel: boolean;
  onSuggestion: (text: string) => void;
  onRetry: () => void;
  onOpenSettings: () => void;
  onRefreshModels: () => void;
}

export function ChatView({
  conversation,
  streaming,
  providers,
  modelsLoading,
  hasModel,
  onSuggestion,
  onRetry,
  onOpenSettings,
  onRefreshModels,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow new tokens only while the reader is already at the bottom.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [conversation]);

  useEffect(() => {
    pinned.current = true;
  }, [conversation.id]);

  const { messages } = conversation;
  const last = messages[messages.length - 1];

  return (
    <div
      className="chat"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {messages.length === 0 ? (
        <EmptyState
          providers={providers}
          modelsLoading={modelsLoading}
          hasModel={hasModel}
          onSuggestion={onSuggestion}
          onOpenSettings={onOpenSettings}
          onRefreshModels={onRefreshModels}
        />
      ) : (
        <div className="chat__messages">
          {messages.map((message) => (
            <MessageView
              key={message.id}
              message={message}
              streaming={streaming && message === last}
              canRetry={!streaming && message === last && message.role === "assistant" && hasModel}
              onRetry={onRetry}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState({
  providers,
  modelsLoading,
  hasModel,
  onSuggestion,
  onOpenSettings,
  onRefreshModels,
}: Omit<Props, "conversation" | "streaming" | "onRetry">) {
  const ollama = providers.find((p) => p.provider === "ollama");
  const openai = providers.find((p) => p.provider === "openai");
  const nothingConnected = !modelsLoading && !hasModel;

  return (
    <div className="empty">
      <LogoMark width={44} height={44} />
      <h1 className="wordmark wordmark--large">Theoremis</h1>
      <p className="empty__lede">Think it through, one step at a time.</p>

      {nothingConnected ? (
        <div className="setup">
          <div className="setup__card">
            <h3>
              <span className="provider-dot provider-dot--ollama" />
              Run models locally
            </h3>
            <p>{ollama?.message ?? "Use Ollama to chat with open models on your own machine."}</p>
            <div className="setup__actions">
              <button
                type="button"
                className="button button--ghost"
                onClick={() => void openUrl("https://ollama.com/download")}
              >
                Get Ollama
              </button>
              <button type="button" className="button button--ghost" onClick={onRefreshModels}>
                Check again
              </button>
            </div>
          </div>
          <div className="setup__card">
            <h3>
              <span className="provider-dot provider-dot--openai" />
              Use ChatGPT models
            </h3>
            <p>{openai?.message ?? "Connect your OpenAI account with an API key."}</p>
            <div className="setup__actions">
              <button type="button" className="button button--primary" onClick={onOpenSettings}>
                Add API key
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="suggestions">
          {SUGGESTIONS.map((text) => (
            <button
              key={text}
              type="button"
              className="suggestion"
              disabled={!hasModel}
              onClick={() => onSuggestion(text)}
            >
              {text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
