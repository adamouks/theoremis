import { memo, useState } from "react";
import { PROVIDER_LABELS, type Message } from "../lib/types";
import { CheckIcon, CopyIcon, RetryIcon } from "./Icons";
import { Markdown } from "./Markdown";

interface Props {
  message: Message;
  streaming: boolean;
  canRetry: boolean;
  onRetry: () => void;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="icon-button icon-button--small"
      title="Copy"
      aria-label="Copy message"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

export const MessageView = memo(function MessageView({ message, streaming, canRetry, onRetry }: Props) {
  if (message.role === "user") {
    return (
      <div className="message message--user">
        <div className="message__bubble">{message.content}</div>
      </div>
    );
  }

  const thinking = streaming && !message.content;
  return (
    <div className="message message--assistant">
      {message.model && (
        <div className="message__meta">
          <span className={`provider-dot provider-dot--${message.model.provider}`} />
          {message.model.model}
          <span className="message__provider">{PROVIDER_LABELS[message.model.provider]}</span>
        </div>
      )}

      {message.reasoning && (
        <details className="reasoning" open={thinking}>
          <summary>{thinking ? "Thinking…" : "Reasoning"}</summary>
          <div className="reasoning__body">{message.reasoning}</div>
        </details>
      )}

      {message.content ? (
        <Markdown text={message.content} />
      ) : (
        thinking &&
        !message.reasoning && (
          <div className="typing" aria-label="Waiting for a reply">
            <span />
            <span />
            <span />
          </div>
        )
      )}

      {message.error && (
        <div className="message__error" role="alert">
          {message.error}
        </div>
      )}

      {!streaming && (
        <div className="message__actions">
          {message.content && <CopyButton text={message.content} />}
          {canRetry && (
            <button
              type="button"
              className="icon-button icon-button--small"
              title="Retry"
              aria-label="Retry"
              onClick={onRetry}
            >
              <RetryIcon />
            </button>
          )}
        </div>
      )}
    </div>
  );
});
