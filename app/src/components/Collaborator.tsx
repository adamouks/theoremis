import { memo, useContext, useEffect, useRef, useState, type ClipboardEvent } from "react";
import { createPortal } from "react-dom";
import { api, assetUrl, errorMessage } from "../lib/api";
import { readAttachment } from "../lib/attachments";
import { MODE_LABELS } from "../lib/prompts";
import { ACCEPTED_FILES } from "../lib/sources";
import { clockTime, initials, timeAgo } from "../lib/text";
import {
  PROVIDER_LABELS,
  type Attachment,
  type Context,
  type Doc,
  type Mode,
  type ModelRef,
  type LeanStatus,
  type ProviderStatus,
  type StoredLeanCheck,
  type Thread,
  type ThreadMessage,
} from "../lib/types";
import { splitProposals, type NumberedBlock } from "../lib/doc";
import { numberEquations } from "../lib/text";
import { AutoTextarea } from "./AutoTextarea";
import { SelectionCorners, type Pin } from "./Block";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Close,
  CollaboratorGlyph,
  Compare,
  Copy,
  ImportFile,
  PanelRight,
  PlusLarge,
  Retry,
  StatusGlyph,
  StopSquare,
} from "./Icons";
import { LeanCheckPanel } from "./LeanCheck";
import { Markdown, MediaContext, type CodeFooter } from "./Markdown";
import { ModelPicker } from "./ModelPicker";

const COMPOSER_MODES: Mode[] = ["explore", "gaps", "challenge", "formalize"];

export interface CollaboratorActions {
  onSend: (mode: Mode, text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  onRetry: (threadId: string) => void;
  onNewThread: () => void;
  onSelectThread: (threadId: string) => void;
  onCollapse: () => void;
  onSetContext: (context: Context | null) => void;
  onShowBlock: (blockId: string) => void;
  onAcceptRevision: (threadId: string, messageId: string) => void;
  onEditRevision: (threadId: string, messageId: string) => void;
  onRejectRevision: (threadId: string, messageId: string) => void;
  onUndoRevision: (threadId: string, messageId: string) => void;
  onInsertSuggestion: (threadId: string, messageId: string) => void;
  onSelectModel: (model: ModelRef) => void;
  onRefreshModels: () => void;
  onOpenSettings: () => void;
  onLeanChecked: (threadId: string, messageId: string, check: StoredLeanCheck) => void;
  onMarkVerified: (blockId: string) => void;
  /** Sends a follow-up in the current thread, e.g. Lean's errors with a request to fix them. */
  onFollowUp: (mode: Mode, text: string) => void;
}

interface Props extends CollaboratorActions {
  doc: Doc;
  numbered: NumberedBlock[];
  thread: Thread | null;
  context: Context | null;
  providers: ProviderStatus[];
  lean: LeanStatus | null;
  modelsLoading: boolean;
  model: ModelRef | null;
  hasModel: boolean;
  /** Whether the chosen model sees images. */
  vision: boolean;
  /** Files dropped on the window to attach to the next question. */
  dropped: { files: File[]; nonce: number } | null;
  streamingMessageId: string | null;
  busyElsewhere: boolean;
  displayName: string;
  pins: Map<string, Pin>;
  focusKey: number;
  shortcut: (keys: string) => string;
}

export function Collaborator(props: Props) {
  const { doc, thread, context, streamingMessageId, onCollapse, shortcut } = props;
  const [threadsOpen, setThreadsOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow a streaming reply only while the reader is already at the bottom.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [thread]);

  useEffect(() => {
    pinned.current = true;
    setThreadsOpen(false);
  }, [thread?.id, doc.id]);

  const threads = [...doc.threads].sort((a, b) => b.updatedAt - a.updatedAt);
  const last = thread?.messages[thread.messages.length - 1];

  return (
    <aside className="panel">
      <header className="panel-header">
        <div className="panel-title">
          <CollaboratorGlyph />
          <span className="panel-title__name">Collaborator</span>
          {(thread || threads.length > 0) && <span className="panel-title__sep">/</span>}
          <div className="menu-anchor panel-title__thread">
            {(thread || threads.length > 0) && (
              <button type="button" className="thread-switch" onClick={() => setThreadsOpen((o) => !o)} title="Threads on this document">
                <span>{thread?.title ?? "New thread"}</span>
                {threads.length > 0 && <ChevronDown size={10} />}
              </button>
            )}
            {threadsOpen && (
              <div className="menu thread-menu" onMouseLeave={() => setThreadsOpen(false)}>
                <div className="menu__label">Threads on this document</div>
                {threads.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`menu__item${t.id === thread?.id ? " is-active" : ""}`}
                    onClick={() => {
                      props.onSelectThread(t.id);
                      setThreadsOpen(false);
                    }}
                  >
                    <span className="thread-menu__title">{t.title}</span>
                    <span className="menu__hint">{timeAgo(t.updatedAt)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="panel-actions">
          <ModelPicker
            providers={props.providers}
            loading={props.modelsLoading}
            selected={props.model}
            onSelect={props.onSelectModel}
            onRefresh={props.onRefreshModels}
            onOpenSettings={props.onOpenSettings}
          />
          <button type="button" className="icon-button" title="New thread" aria-label="New thread" onClick={props.onNewThread}>
            <PlusLarge />
          </button>
          <button
            type="button"
            className="icon-button"
            title={`Hide collaborator  ${shortcut("\\")}`}
            aria-label="Hide collaborator"
            onClick={onCollapse}
          >
            <PanelRight />
          </button>
        </div>
      </header>

      <div
        className="thread"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {!thread || thread.messages.length === 0 ? (
          <EmptyThread hasModel={props.hasModel} providers={props.providers} onOpenSettings={props.onOpenSettings} shortcut={shortcut} />
        ) : (
          thread.messages.map((message) =>
            message.role === "user" ? (
              <UserMessage key={message.id} message={message} displayName={props.displayName} onShowBlock={props.onShowBlock} />
            ) : (
              <AssistantMessage
                key={message.id}
                message={message}
                thread={thread}
                doc={doc}
                numbered={props.numbered}
                streaming={message.id === streamingMessageId}
                isLast={message === last}
                canRetry={props.hasModel && !streamingMessageId && !props.busyElsewhere}
                pin={props.pins.get(message.id)}
                lean={props.lean}
                actions={props}
              />
            ),
          )
        )}
      </div>

      <Composer
        docId={props.doc.id}
        context={context}
        numbered={props.numbered}
        hasModel={props.hasModel}
        vision={props.vision}
        dropped={props.dropped}
        streaming={!!streamingMessageId}
        busyElsewhere={props.busyElsewhere}
        focusKey={props.focusKey}
        onSend={props.onSend}
        onStop={props.onStop}
        onSetContext={props.onSetContext}
        shortcut={shortcut}
      />
    </aside>
  );
}

function EmptyThread({
  hasModel,
  providers,
  onOpenSettings,
  shortcut,
}: {
  hasModel: boolean;
  providers: ProviderStatus[];
  onOpenSettings: () => void;
  shortcut: (keys: string) => string;
}) {
  if (!hasModel && providers.length > 0) {
    return (
      <div className="thread-empty">
        <CollaboratorGlyph size={12} />
        <p>Connect a model to start. Sign in with ChatGPT to use your plan, or run one locally with Ollama.</p>
        <ul className="thread-empty__providers">
          {providers.map((p) => (
            <li key={p.provider}>
              <span className={`dot${p.available ? " dot--on" : ""}`} />
              <span>{PROVIDER_LABELS[p.provider]}</span>
              <span className="thread-empty__state">{p.message ?? (p.available ? "Connected" : "Not connected")}</span>
            </li>
          ))}
        </ul>
        <button type="button" className="button button--primary button--small" onClick={onOpenSettings}>
          Open settings
        </button>
      </div>
    );
  }
  return (
    <div className="thread-empty">
      <CollaboratorGlyph size={12} />
      <p>Select a step in your proof to ask about it, find gaps, or challenge it.</p>
      <kbd>{shortcut("L")}</kbd>
    </div>
  );
}

const UserMessage = memo(function UserMessage({
  message,
  displayName,
  onShowBlock,
}: {
  message: ThreadMessage;
  displayName: string;
  onShowBlock: (blockId: string) => void;
}) {
  const name = displayName.split(/\s+/)[0] || "You";
  return (
    <section className="msg msg--user">
      <div className="msg__head">
        <span className="avatar avatar--small">{initials(displayName) || "Y"}</span>
        <span className="msg__author">{name}</span>
        <span className="msg__time">{clockTime(message.createdAt)}</span>
      </div>
      {message.context && (
        <button
          type="button"
          className="context-card"
          title="Show in document"
          onClick={() => message.context?.blockId && onShowBlock(message.context.blockId)}
        >
          <SelectionCorners />
          <span className="context-card__head">
            <span>Selection · {message.context.label}</span>
            <span className="context-card__mode">{MODE_LABELS[message.mode]}</span>
          </span>
          <span className="context-card__body">
            <Markdown text={message.context.text} variant="context" />
          </span>
        </button>
      )}
      {message.attachments && message.attachments.length > 0 && <AttachmentList attachments={message.attachments} />}
      {message.content.trim() && (
        <div className="msg__question">
          <Markdown text={message.content} variant="question" />
        </div>
      )}
    </section>
  );
});

/** What a question was sent with: pictures as thumbnails, other files by name. */
function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  const docId = useContext(MediaContext);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!docId) return null;
  return (
    <div className="attachments">
      {attachments.map((a, i) =>
        a.kind === "image" && a.images[0] ? (
          <button key={i} type="button" className="attachment attachment--image" title={a.name} onClick={() => setOpen(a.images[0])}>
            <img src={assetUrl(docId, a.images[0])} alt={a.name} />
          </button>
        ) : (
          <button
            key={i}
            type="button"
            className="attachment attachment--file"
            title={a.name}
            disabled={!a.images[0]}
            onClick={() => a.images[0] && setOpen(a.images[0])}
          >
            {a.images[0] ? <img src={assetUrl(docId, a.images[0])} alt="" /> : <ImportFile size={13} />}
            <span className="attachment__name">{a.name}</span>
            <span className="attachment__meta">{a.kind === "pdf" ? `${a.pages} ${a.pages === 1 ? "page" : "pages"}` : "text"}</span>
          </button>
        ),
      )}
      {open &&
        createPortal(
          <div className="dialog-backdrop lightbox" onClick={() => setOpen(null)}>
            <img src={assetUrl(docId, open)} alt="" />
          </div>,
          document.body,
        )}
    </div>
  );
}

function AssistantMessage({
  message,
  thread,
  doc,
  numbered,
  streaming,
  isLast,
  canRetry,
  pin,
  lean,
  actions,
}: {
  message: ThreadMessage;
  thread: Thread;
  doc: Doc;
  numbered: NumberedBlock[];
  streaming: boolean;
  isLast: boolean;
  canRetry: boolean;
  pin?: Pin;
  lean: LeanStatus | null;
  actions: CollaboratorActions;
}) {
  const [copied, setCopied] = useState(false);
  // Once complete, proposals move out of the prose into their own cards.
  const parts = streaming ? null : splitProposals(message.content);
  const prose = parts && (parts.revision || parts.addition) ? parts.body : message.content;
  const inserted = message.insertedBlockId ? doc.blocks.find((b) => b.id === message.insertedBlockId) : undefined;
  const insertedPin = message.insertedBlockId ? numbered.find((n) => n.block.id === message.insertedBlockId)?.suggestionIndex : undefined;
  const leanProved = !!message.leanChecks?.some((c) => c.outcome === "proved" && message.content.includes(c.code));

  // The block the question was about, so a proof Lean accepts can mark it verified.
  const index = thread.messages.findIndex((m) => m.id === message.id);
  const asked = thread.messages
    .slice(0, index)
    .reverse()
    .find((m) => m.role === "user" && m.context?.blockId);
  const targetBlock = asked?.context?.blockId ? numbered.find((n) => n.block.id === asked.context?.blockId) : undefined;

  const leanFooter: CodeFooter = (language, code) =>
    language === "lean" || language === "lean4" ? (
      <LeanCheckPanel
        code={code}
        stored={message.leanChecks?.find((c) => c.code === code)}
        lean={lean}
        target={targetBlock && { label: targetBlock.label, verified: targetBlock.block.status === "verified" }}
        onChecked={(check) => actions.onLeanChecked(thread.id, message.id, check)}
        onMarkVerified={targetBlock && (() => actions.onMarkVerified(targetBlock.block.id))}
        onAskToFix={canRetry ? (text) => actions.onFollowUp("formalize", text) : undefined}
        onOpenSettings={actions.onOpenSettings}
      />
    ) : null;

  return (
    <section className="msg msg--ai">
      <div className="msg__head">
        <CollaboratorGlyph />
        <span className="msg__author msg__author--ai">Collaborator</span>
        <span className="msg__time">
          {MODE_LABELS[message.mode]} · {clockTime(message.createdAt)}
        </span>
        <span className="msg__spacer" />
        {leanProved ? (
          <span className="badge-lean" title="Lean accepted the formal proof in this reply. The prose around it is still model reasoning.">
            LEAN CHECKED
          </span>
        ) : (
          <span className="badge-unverified" title="Model reasoning. Nothing in this response has been checked by Lean or by you.">
            NOT VERIFIED
          </span>
        )}
      </div>

      {message.reasoning && (
        <details className="reasoning" open={streaming && !message.content}>
          <summary>{streaming && !message.content ? "Thinking…" : "Reasoning"}</summary>
          <div className="reasoning__body">{message.reasoning}</div>
        </details>
      )}

      {message.content ? (
        prose && <Markdown text={prose} variant="ai" codeFooter={streaming ? undefined : leanFooter} />
      ) : (
        streaming &&
        !message.reasoning && (
          <div className="thinking">
            <CollaboratorGlyph />
            {message.mode === "gaps" ? "Reviewing" : "Thinking"} with {message.model?.model ?? "the model"}
            <span className="thinking__dots">
              <span />
              <span />
              <span />
            </span>
          </div>
        )
      )}

      {message.error && (
        <div className="msg__error" role="alert">
          {message.error}
        </div>
      )}

      {message.revision && !streaming && (
        <RevisionCard message={message} thread={thread} numbered={numbered} pin={pin} actions={actions} />
      )}

      {parts?.addition && !message.insertedBlockId && (
        <div className="addition">
          <div className="revision__head">
            <StatusGlyph suggested size={8} />
            <span className="revision__title">Proposed addition</span>
            <span className="revision__target revision__target--accent">NEW MATERIAL</span>
          </div>
          <div className="addition__body">
            <Markdown text={parts.addition} variant="ai" />
          </div>
          <div className="revision__actions">
            <button type="button" className="button button--primary button--small" onClick={() => actions.onInsertSuggestion(thread.id, message.id)}>
              Insert as suggestion
            </button>
            <span className="addition__hint">Nothing changes until you accept it in the document.</span>
          </div>
        </div>
      )}

      {message.insertedBlockId && (
        <div className="status-row">
          {inserted ? (
            <>
              {insertedPin && inserted.suggestion ? <span className="pin pin--suggestion pin--inline">{insertedPin}</span> : <StatusGlyph status="adopted" size={8} />}
              <span className="status-row__text">
                {inserted.suggestion ? "Inserted as a suggestion · awaiting your review" : "Adopted into the document"}
              </span>
              <button type="button" className="link-button" onClick={() => actions.onShowBlock(inserted.id)}>
                Show
              </button>
            </>
          ) : (
            <>
              <span className="status-row__text">Rejected · nothing was added to the document</span>
              <button type="button" className="link-button" onClick={() => actions.onInsertSuggestion(thread.id, message.id)}>
                Insert again
              </button>
            </>
          )}
        </div>
      )}

      {!streaming && (message.content || message.error) && (
        <div className="msg__actions">
          {message.content && !message.insertedBlockId && !parts?.addition && !message.revision && (
            <button type="button" className="text-button" onClick={() => actions.onInsertSuggestion(thread.id, message.id)}>
              Insert as suggestion
            </button>
          )}
          {message.content && (
            <button
              type="button"
              className="text-button"
              onClick={async () => {
                await navigator.clipboard.writeText(message.content);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : "Copy"}
            </button>
          )}
          {isLast && canRetry && (
            <button type="button" className="text-button" onClick={() => actions.onRetry(thread.id)}>
              <Retry />
              Retry
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function RevisionCard({
  message,
  thread,
  numbered,
  pin,
  actions,
}: {
  message: ThreadMessage;
  thread: Thread;
  numbered: NumberedBlock[];
  pin?: Pin;
  actions: CollaboratorActions;
}) {
  const [compare, setCompare] = useState(true);
  const revision = message.revision!;
  const target = numbered.find((n) => n.block.id === revision.blockId);
  const label = target?.label ?? "the selection";
  // Preview the numbers the rewrite will carry once it is in the document.
  const proposed = numberEquations(revision.text, target?.numbers[0] ?? 1).text;

  if (revision.state !== "pending") {
    return (
      <div className="status-row">
        <span className={`dot${revision.state === "accepted" ? " dot--on" : ""}`} />
        <span className="status-row__text">
          {revision.state === "accepted" ? `Accepted · ${label} now reads as proposed` : `Rejected · ${label} left as written`}
        </span>
        <button type="button" className="link-button" onClick={() => actions.onUndoRevision(thread.id, message.id)}>
          Undo
        </button>
      </div>
    );
  }

  return (
    <div className="revision">
      <div className="revision__head">
        {pin ? <span className="pin pin--finding pin--inline">{pin.n}</span> : null}
        <span className="revision__title">Proposed revision</span>
        <span className="revision__target">{label}</span>
      </div>
      {target ? (
        <div className="diff">
          {compare && (
            <div className="diff__row diff__row--original">
              <span className="diff__label">ORIGINAL</span>
              <div className="diff__body">
                <Markdown text={target.text} variant="diff" normalized />
              </div>
            </div>
          )}
          <div className="diff__row diff__row--proposed">
            <span className="diff__label">PROPOSED</span>
            <div className="diff__body">
              <Markdown text={proposed} variant="diff" normalized />
            </div>
          </div>
        </div>
      ) : (
        <p className="status-row__text">The passage this revises is no longer in the document.</p>
      )}
      {target && (
        <div className="revision__actions">
          <button type="button" className="button button--primary button--small" onClick={() => actions.onAcceptRevision(thread.id, message.id)}>
            Accept
          </button>
          <button type="button" className="text-button" onClick={() => actions.onEditRevision(thread.id, message.id)}>
            Edit
          </button>
          <button type="button" className="text-button" onClick={() => actions.onRejectRevision(thread.id, message.id)}>
            Reject
          </button>
          <span className="msg__spacer" />
          <button
            type="button"
            className={`toggle-button${compare ? " is-on" : ""}`}
            title={compare ? "Hide original" : "Show original"}
            onClick={() => setCompare((c) => !c)}
          >
            <Compare />
            Compare
          </button>
        </div>
      )}
    </div>
  );
}

interface PendingFile {
  id: number;
  name: string;
  attachment?: Attachment;
  error?: string;
}

function Composer({
  docId,
  context,
  numbered,
  hasModel,
  vision,
  dropped,
  streaming,
  busyElsewhere,
  focusKey,
  onSend,
  onStop,
  onSetContext,
  shortcut,
}: {
  docId: string;
  context: Context | null;
  numbered: NumberedBlock[];
  hasModel: boolean;
  vision: boolean;
  dropped: { files: File[]; nonce: number } | null;
  streaming: boolean;
  busyElsewhere: boolean;
  focusKey: number;
  onSend: (mode: Mode, text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  onSetContext: (context: Context | null) => void;
  shortcut: (keys: string) => string;
}) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [picking, setPicking] = useState(false);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const nextId = useRef(0);

  useEffect(() => {
    if (focusKey > 0) input.current?.focus();
  }, [focusKey]);

  // Attachments belong to the document they were read into.
  useEffect(() => setFiles([]), [docId]);

  const attach = (list: File[]) => {
    for (const file of list) {
      const id = nextId.current++;
      setFiles((f) => [...f, { id, name: file.name || "Pasted image" }]);
      readAttachment(docId, file).then(
        (attachment) => setFiles((f) => f.map((p) => (p.id === id ? { ...p, attachment } : p))),
        (err) => setFiles((f) => f.map((p) => (p.id === id ? { ...p, error: errorMessage(err) } : p))),
      );
    }
    input.current?.focus();
  };

  const lastDrop = useRef(0);
  useEffect(() => {
    if (dropped && dropped.nonce !== lastDrop.current) {
      lastDrop.current = dropped.nonce;
      attach(dropped.files);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropped]);

  const remove = (file: PendingFile) => {
    setFiles((f) => f.filter((p) => p.id !== file.id));
    for (const name of file.attachment?.images ?? []) void api.deleteAsset(docId, name).catch(() => {});
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...e.clipboardData.files];
    if (!pasted.length) return;
    e.preventDefault();
    attach(pasted);
  };

  const reading = files.some((f) => !f.attachment && !f.error);
  const ready = files.flatMap((f) => (f.attachment ? [f.attachment] : []));
  const blocked = !hasModel || streaming || busyElsewhere || reading;
  const send = (mode: Mode) => {
    if (blocked) return;
    if (mode === "ask" && !text.trim() && !ready.length) return;
    if (mode !== "ask" && !text.trim() && !context && !ready.length) return;
    onSend(mode, text, ready);
    setText("");
    setFiles([]);
  };
  const unseen = !vision && ready.some((a) => a.images.length > 0);

  const choices = numbered.filter((n) => !n.block.suggestion && n.block.source.trim());

  return (
    <div className="composer-wrap">
      <div className={`composer${focused ? " is-focused" : ""}`}>
        {files.length > 0 && (
          <div className="composer__files">
            {files.map((f) => (
              <span key={f.id} className={`file-chip${f.error ? " is-failed" : ""}${!f.attachment && !f.error ? " is-reading" : ""}`} title={f.error ?? f.name}>
                {f.attachment?.images[0] ? <img src={assetUrl(docId, f.attachment.images[0])} alt="" /> : <ImportFile size={12} />}
                <span className="file-chip__name">{f.name}</span>
                <span className="file-chip__meta">
                  {f.error ? "Couldn’t read" : !f.attachment ? "Reading…" : f.attachment.kind === "pdf" ? `${f.attachment.pages} pp.` : f.attachment.kind === "image" ? "Image" : "Text"}
                </span>
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => remove(f)}>
                  <Close size={9} />
                </button>
              </span>
            ))}
          </div>
        )}
        {unseen && <p className="composer__warning">This model can’t see images, so only the text Theoremis reads from these files is sent. Choose a vision model to show it the pictures.</p>}
        <div className="composer__chips">
          {context && (
            <span className="chip chip--context">
              Selection · {context.label}
              <button type="button" aria-label="Remove selection" onClick={() => onSetContext(null)}>
                <Close size={9} />
              </button>
            </span>
          )}
          <div className="menu-anchor">
            <button type="button" className="chip chip--add" onClick={() => setPicking((p) => !p)}>
              + Context
            </button>
            {picking && (
              <div className="menu menu--up context-menu" onMouseLeave={() => setPicking(false)}>
                <div className="menu__label">Ask about</div>
                {choices.length === 0 && <p className="model-menu__note">Write something in the document first.</p>}
                {choices.map((n) => (
                  <button
                    key={n.block.id}
                    type="button"
                    className="menu__item"
                    onClick={() => {
                      onSetContext({ label: n.label, text: n.text, blockId: n.block.id });
                      setPicking(false);
                      input.current?.focus();
                    }}
                  >
                    <StatusGlyph status={n.block.status} size={7} />
                    <span className="context-menu__label">{n.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button type="button" className="chip chip--add" title="Attach images, PDFs or files" onClick={() => fileInput.current?.click()}>
            + File
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            accept={ACCEPTED_FILES}
            onChange={(e) => {
              attach([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
        </div>
        <AutoTextarea
          ref={input}
          className="composer__input"
          value={text}
          maxHeight={180}
          placeholder={
            !hasModel
              ? "Connect a model in Settings to ask…"
              : busyElsewhere
                ? "Waiting for another reply to finish…"
                : "Ask a follow-up, or challenge a step…"
          }
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send("ask");
            }
          }}
        />
        <div className="composer__bar">
          <div className="composer__modes">
            {COMPOSER_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                className="chip-button"
                disabled={blocked || (!text.trim() && !context && !ready.length)}
                title={context || text.trim() ? undefined : "Select a step or type a question first"}
                onClick={() => send(mode)}
              >
                {MODE_LABELS[mode]}
              </button>
            ))}
          </div>
          {streaming ? (
            <button type="button" className="send send--stop" title="Stop" aria-label="Stop" onClick={onStop}>
              <StopSquare />
            </button>
          ) : (
            <button
              type="button"
              className="send"
              title={`Send  ${shortcut("↵")}`}
              aria-label="Send"
              disabled={blocked || (!text.trim() && !ready.length)}
              onClick={() => send("ask")}
            >
              <ArrowUp />
            </button>
          )}
        </div>
      </div>
      <p className="composer__note">Collaborator output is model reasoning, not a checked proof.</p>
    </div>
  );
}

/** The 48px rail shown when the collaborator is collapsed. */
export function CollaboratorRail({
  pins,
  onExpand,
  shortcut,
}: {
  pins: Pin[];
  onExpand: () => void;
  shortcut: (keys: string) => string;
}) {
  return (
    <aside className="panel-rail">
      <div className="panel-rail__top">
        <button type="button" className="icon-button" title={`Show collaborator  ${shortcut("\\")}`} aria-label="Show collaborator" onClick={onExpand}>
          <PanelRight />
        </button>
      </div>
      <div className="panel-rail__pins">
        <CollaboratorGlyph />
        {pins.map((pin) => (
          <button key={`${pin.kind}-${pin.n}`} type="button" className={`pin pin--${pin.kind} pin--inline`} onClick={onExpand}>
            {pin.n}
          </button>
        ))}
      </div>
    </aside>
  );
}
