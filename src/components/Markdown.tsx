import { memo, useState, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { openUrl } from "@tauri-apps/plugin-opener";
import { normalizeMath } from "../lib/text";
import { CheckIcon, CopyIcon } from "./Icons";

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins: ComponentProps<typeof ReactMarkdown>["rehypePlugins"] = [
  [rehypeKatex, { throwOnError: false, strict: "ignore" }],
  rehypeHighlight,
];

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

  const copy = async () => {
    await navigator.clipboard.writeText(textOf(children).replace(/\n$/, ""));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="code-block">
      <div className="code-block__bar">
        <span>{language ?? "text"}</span>
        <button type="button" className="code-block__copy" onClick={copy}>
          {copied ? <CheckIcon /> : <CopyIcon />}
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
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {normalizeMath(text)}
      </ReactMarkdown>
    </div>
  );
});
