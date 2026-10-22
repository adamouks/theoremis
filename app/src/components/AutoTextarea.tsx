import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

type Props = TextareaHTMLAttributes<HTMLTextAreaElement> & { maxHeight?: number };

/** A textarea that grows with its content. */
export const AutoTextarea = forwardRef<HTMLTextAreaElement, Props>(function AutoTextarea(
  { maxHeight, value, ...props },
  ref,
) {
  const inner = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => inner.current!);

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    el.style.height = "auto";
    const height = maxHeight ? Math.min(el.scrollHeight, maxHeight) : el.scrollHeight;
    el.style.height = `${height}px`;
  }, [value, maxHeight]);

  return <textarea ref={inner} rows={1} value={value} {...props} />;
});
