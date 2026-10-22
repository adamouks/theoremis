import { memo, useState, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { openUrl } from "@tauri-apps/plugin-opener";
import { normalizeMath, unnumberEnvironments } from "../lib/text";
import { Check, Copy } from "./Icons";

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins: ComponentProps<typeof ReactMarkdown>["rehypePlugins"] = [
  [rehypeKatex, { throwOnError: false, strict: "ignore" }],
  rehypeHighlight,
];

const SEVERITIES = new Set(["CRITICAL", "MAJOR", "MINOR"]);

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node.props as { children?: ReactNode }).children);
  }
  return "";
}

function CodeBlock({ children, ...props }: ComponentProps<"pre">) {
  const [copied, setCopied] = useState(false);
  const child = Array.isArray(children) ? children[0] : children;
  const className =
    child && typeof child === "object" && "props" in child
      ? ((child.props as { className?: string }).className ?? "")
      : "";
  const language = /language-([\w+-]+)/.exec(className)?.[1];

  return (
    <div className="code-block">
      <div className="code-block__bar">
        <span>{language ?? "text"}</span>
        <button
          type="button"
          className="code-block__copy"
          onClick={async () => {
            await navigator.clipboard.writeText(textOf(children).replace(/\n$/, ""));
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre {...props}>{children}</pre>
    </div>
  );
}

const components: Components = {
  pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
  // Links would otherwise navigate the app's own webview.
  a: ({ node: _node, href, children, ...props }) => (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (href && /^(https?|mailto):/i.test(href)) void openUrl(href);
      }}
    >
      {children}
    </a>
  ),
  table: ({ node: _node, ...props }) => (
    <div className="table-scroll">
      <table {...props} />
    </div>
  ),
  // The collaborator marks findings **MINOR** etc.; show those as the design's severity tags.
  strong: ({ node: _node, children, ...props }) => {
    const text = textOf(children).trim();
    if (SEVERITIES.has(text)) return <span className={`severity severity--${text.toLowerCase()}`}>{text}</span>;
    return <strong {...props}>{children}</strong>;
  },
};

interface Props {
  text: string;
  /** Which typographic setting to use: the document's serif, a collaborator reply, and so on. */
  variant?: "doc" | "ai" | "note" | "context" | "question" | "diff";
  /** Skip delimiter normalization when the caller already did it (e.g. numbered blocks). */
  normalized?: boolean;
}

export const Markdown = memo(function Markdown({ text, variant = "doc", normalized = false }: Props) {
  return (
    <div className={`markdown markdown--${variant}`}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {normalized ? text : variant === "doc" ? normalizeMath(text) : unnumberEnvironments(normalizeMath(text))}
      </ReactMarkdown>
    </div>
  );
});
