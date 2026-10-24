import { createContext, memo, useContext, useState, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { openUrl } from "@tauri-apps/plugin-opener";
import { assetUrl } from "../lib/api";
import { GraphBlock } from "./graph/GraphBlock";
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

/** The document whose media `asset:` links point into. */
export const MediaContext = createContext<string | null>(null);

/** `asset:name.png` is a file kept with the document; everything else is sanitized as usual. */
function urlTransform(url: string): string {
  return /^asset:[\w.-]+$/.test(url) ? url : defaultUrlTransform(url);
}

const captionComponents: Components = {
  p: ({ node: _node, ...props }) => <span {...props} />,
};

/**
 * Markdown turns an image's alt text into plain text, dropping the `$`s around its math. Copy
 * the raw alt into the title, which is kept verbatim, so the caption can be typeset.
 */
function keepCaptions(markdown: string): string {
  return markdown.replace(/!\[((?:[^[\]\n]|\[[^[\]\n]*\])+)\]\((asset:[\w.-]+)\)/g, (_, alt: string, url: string) => {
    return `![${alt}](${url} "${alt.replace(/(["\\])/g, "\\$1")}")`;
  });
}

/** A figure: the image, and its caption (Markdown and math allowed). */
function Figure({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
  const documentId = useContext(MediaContext);
  const [failed, setFailed] = useState(false);
  const name = src?.startsWith("asset:") ? src.slice("asset:".length) : null;
  const resolved = name ? (documentId ? assetUrl(documentId, name) : undefined) : src;
  const caption = (name ? (title ?? alt) : alt)?.trim() ?? "";
  return (
    <span className="figure">
      {resolved && !failed ? (
        <img src={resolved} alt={alt ?? ""} loading="lazy" draggable={false} onError={() => setFailed(true)} />
      ) : (
        <span className="figure__missing">{name ? `Missing image: ${name}` : "Image unavailable"}</span>
      )}
      {caption && (
        <span className="figure__caption">
          <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={captionComponents}>
            {normalizeMath(caption)}
          </ReactMarkdown>
        </span>
      )}
    </span>
  );
}

/**
 * How graph blocks inside this Markdown behave: in a document they can be edited, and edits
 * replace their code in the block's source. Elsewhere (replies, notes) they are read-only.
 */
export const GraphContext = createContext<{ editable: boolean; compact: boolean; onChange?: (before: string, after: string) => void }>({
  editable: false,
  compact: true,
});

function GraphFence({ language, code }: { language: "graph" | "graph3d"; code: string }) {
  const { editable, compact, onChange } = useContext(GraphContext);
  return (
    <GraphBlock
      code={code}
      dim={language === "graph3d" ? 3 : 2}
      editable={editable && !!onChange}
      compact={compact}
      onChange={(next) => onChange?.(code, next)}
    />
  );
}

/** Extra content under a code block, e.g. Lean's verdict on Lean code. */
export type CodeFooter = (language: string | undefined, code: string) => ReactNode;

const CodeFooterContext = createContext<CodeFooter | undefined>(undefined);

function CodeBlock({ children, ...props }: ComponentProps<"pre">) {
  const [copied, setCopied] = useState(false);
  const footer = useContext(CodeFooterContext);
  const child = Array.isArray(children) ? children[0] : children;
  const className =
    child && typeof child === "object" && "props" in child
      ? ((child.props as { className?: string }).className ?? "")
      : "";
  const language = /language-([\w+-]+)/.exec(className)?.[1];
  if (language === "graph" || language === "graph3d") return <GraphFence language={language} code={textOf(children).replace(/\n$/, "")} />;

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
      {footer?.(language, textOf(children).replace(/\n$/, ""))}
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
  img: ({ node: _node, src, alt, title }) => <Figure src={typeof src === "string" ? src : undefined} alt={alt} title={title} />,
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
  codeFooter?: CodeFooter;
}

export const Markdown = memo(function Markdown({ text, variant = "doc", normalized = false, codeFooter }: Props) {
  return (
    <div className={`markdown markdown--${variant}`}>
      <CodeFooterContext.Provider value={codeFooter}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={components}
          urlTransform={urlTransform}
        >
          {keepCaptions(normalized ? text : variant === "doc" ? normalizeMath(text) : unnumberEnvironments(normalizeMath(text)))}
        </ReactMarkdown>
      </CodeFooterContext.Provider>
    </div>
  );
});
