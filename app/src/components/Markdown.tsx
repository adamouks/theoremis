import { createContext, memo, useContext, useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import katex, { type KatexOptions } from "katex";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { openUrl } from "@tauri-apps/plugin-opener";
import { assetUrl } from "../lib/api";
import { GraphBlock } from "./graph/GraphBlock";
import { graphKey, type GraphPicture } from "./graph/graphPicture";
import { citationLinkKeys, linkCitations } from "../lib/citations";
import { normalizeMath, unnumberEnvironments } from "../lib/text";
import { Check, Copy } from "./Icons";

const remarkPlugins = [remarkGfm, remarkMath];
type RehypePlugins = ComponentProps<typeof ReactMarkdown>["rehypePlugins"];

/** The open document's macros and references, for its math and its citations. */
export interface Notation {
  macros: NonNullable<KatexOptions["macros"]>;
  /** A cited reference's number, in the order the exported paper will number them. */
  number: (key: string) => number | undefined;
  /** A cited reference written out, for its tooltip; undefined for an unknown key. */
  describe: (key: string) => string | undefined;
}

export const NotationContext = createContext<Notation | null>(null);

/** KaTeX with the document's macros. Each render gets its own copy, as KaTeX writes into it. */
function useRehypePlugins(): RehypePlugins {
  const notation = useContext(NotationContext);
  return useMemo(
    () => [[rehypeKatex, { throwOnError: false, strict: "ignore", ...(notation ? { macros: { ...notation.macros } } : {}) }], rehypeHighlight],
    [notation],
  );
}

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

/** `asset:name.png` is a file kept with the document, `cite:key` a citation; everything else is sanitized as usual. */
function urlTransform(url: string): string {
  return /^(?:asset:[\w.-]+|cite:[^\s]+)$/.test(url) ? url : defaultUrlTransform(url);
}

/** A citation, "[3, Thm. 2]", with the references it cites in its tooltip. */
function Citation({ keys, children }: { keys: string[]; children: ReactNode }) {
  const notation = useContext(NotationContext);
  const described = keys.map((key) => notation?.describe(key) ?? `No reference has the key “${key}”.`);
  const missing = keys.some((key) => !notation?.describe(key));
  return (
    <span className={`citation${missing ? " citation--missing" : ""}`} title={described.join("\n\n")}>
      {children}
    </span>
  );
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
  const rehypePlugins = useRehypePlugins();
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
 * The pictures of graphs a printed document shows. A graph that has none yet asks for one, and
 * shows nothing until it's drawn; `null` means it couldn't be drawn.
 */
export interface PrintPictures {
  get: (key: string) => GraphPicture | null | undefined;
  request: (key: string, code: string, dim: 2 | 3) => void;
}

/**
 * How graph blocks inside this Markdown behave: in a document they can be edited, and edits
 * replace their code in the block's source. Elsewhere (replies, notes) they are read-only. In
 * print they are pictures on paper.
 */
export const GraphContext = createContext<{
  editable: boolean;
  compact: boolean;
  onChange?: (before: string, after: string) => void;
  print?: PrintPictures;
}>({
  editable: false,
  compact: true,
});

const legendMath = (latex: string) => katex.renderToString(latex, { throwOnError: false, strict: "ignore", output: "html" });

/** A graph as it prints: its picture, with a key to what's drawn and the sliders' values. */
function PrintedGraph({ code, dim, pictures }: { code: string; dim: 2 | 3; pictures: PrintPictures }) {
  const key = graphKey(dim, code);
  const picture = pictures.get(key);
  useEffect(() => {
    if (picture === undefined) pictures.request(key, code, dim);
  }, [picture, pictures, key, code, dim]);
  if (picture === undefined) return <span className="figure figure--graph" data-graph-pending="" />;
  if (!picture)
    return (
      <span className="figure figure--graph">
        <pre className="print-code">{code}</pre>
        <span className="figure__caption">{dim === 3 ? "This 3D graph couldn’t be drawn here, as it needs WebGL; its code is shown instead." : "This graph couldn’t be drawn; its code is shown instead."}</span>
      </span>
    );
  return (
    <span className="figure figure--graph">
      <img src={picture.src} width={picture.width} height={picture.height} alt="" />
      {(picture.legend.length > 0 || picture.values.length > 0) && (
        <span className="graph-legend">
          {picture.legend.map((entry, i) => (
            <span key={i} className="graph-legend__item">
              <span className={`graph-legend__swatch${entry.dashed ? " is-dashed" : ""}`} style={{ color: entry.color }} />
              {entry.label ? <span>{entry.label}</span> : <span dangerouslySetInnerHTML={{ __html: legendMath(entry.latex) }} />}
            </span>
          ))}
          {picture.values.map((value) => (
            <span key={value} className="graph-legend__value" dangerouslySetInnerHTML={{ __html: legendMath(value) }} />
          ))}
        </span>
      )}
    </span>
  );
}

function GraphFence({ language, code }: { language: "graph" | "graph3d"; code: string }) {
  const { editable, compact, onChange, print } = useContext(GraphContext);
  if (print) return <PrintedGraph code={code} dim={language === "graph3d" ? 3 : 2} pictures={print} />;
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
  a: ({ node: _node, href, children, ...props }) => {
    const cited = href ? citationLinkKeys(href) : null;
    if (cited) return <Citation keys={cited}>{children}</Citation>;
    return (
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
    );
  },
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
  const rehypePlugins = useRehypePlugins();
  const notation = useContext(NotationContext);
  const cited = notation ? linkCitations(text, notation.number) : text;
  return (
    <div className={`markdown markdown--${variant}`}>
      <CodeFooterContext.Provider value={codeFooter}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={components}
          urlTransform={urlTransform}
        >
          {keepCaptions(normalized ? cited : variant === "doc" ? normalizeMath(cited) : unnumberEnvironments(normalizeMath(cited)))}
        </ReactMarkdown>
      </CodeFooterContext.Provider>
    </div>
  );
});
