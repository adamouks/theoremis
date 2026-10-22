import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUpIcon, StopIcon } from "./Icons";

interface Props {
  /** Why sending is unavailable, if it is. */
  blockedReason: string | null;
  streaming: boolean;
  focusKey: string;
  onSend: (text: string) => void;
  onStop: () => void;
}

export function Composer({ blockedReason, streaming, focusKey, onSend, onStop }: Props) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  useEffect(() => ref.current?.focus(), [focusKey]);

  const canSend = !blockedReason && !streaming && text.trim().length > 0;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    onSend(text.trim());
    setText("");
  };

  return (
    <form className="composer" onSubmit={submit}>
      <div className="composer__box">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={blockedReason ?? "Ask anything — LaTeX welcome"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {streaming ? (
          <button
            type="button"
            className="composer__button composer__button--stop"
            onClick={onStop}
            title="Stop"
            aria-label="Stop generating"
          >
            <StopIcon />
          </button>
        ) : (
          <button
            type="submit"
            className="composer__button"
            disabled={!canSend}
            title="Send"
            aria-label="Send"
          >
            <ArrowUpIcon />
          </button>
        )}
      </div>
      <p className="composer__hint">Enter to send · Shift + Enter for a new line</p>
    </form>
  );
}
