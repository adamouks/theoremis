import { memo, useContext, useEffect, useRef, useState, type ClipboardEvent } from "react";
import { createPortal } from "react-dom";
import { api, assetUrl, errorMessage } from "../lib/api";
import { readAttachment } from "../lib/attachments";
import { effortLabel } from "../lib/effort";
import { MODE_LABELS } from "../lib/prompts";
import { ACCEPTED_FILES } from "../lib/sources";
import { clockTime, initials, timeAgo } from "../lib/text";
import {
  PROVIDER_LABELS,
  type Attachment,
  type Context,
  type Doc,
  type Effort,
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
import { AgentTimeline } from "./ai/AgentTimeline";
import { AutoLabel, ComposerBeam, Orb, Shimmer, Sparks, Spotlight, ThreadEdges, type Activity, type ClickSparkHandle } from "./ai/effects";
import { EffortGauge } from "./ai/EffortGauge";
import { Reasoning } from "./ai/Reasoning";
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

/** Ways to start a thread, after Prompt Kit's prompt suggestions (MIT, see THIRD_PARTY_NOTICES.md). */
const SUGGESTIONS = {
  manual: ["Where is this argument weakest?", "What should I prove next?", "Explain the key idea plainly", "Suggest a cleaner proof"],
  auto: ["Prove the open statements and check them in Lean", "Find the gaps in this proof and fix them", "Formalize the main theorem in Lean", "Graph the functions in this document"],
};

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
  /** Takes back everything an Auto reply changed. */
  onUndoAgent: (threadId: string, messageId: string) => void;
  onSetAutoMode: (auto: boolean) => void;
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
  /** Auto mode is chosen, and whether the chosen model can work in it (call tools). */
  autoMode: boolean;
  canAct: boolean;
  /** How hard the chosen model can think, and the effort chosen for it. */
  efforts: Effort[];
  effort: string | undefined;
  onSetEffort: (effort: string) => void;
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
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /** The reader has scrolled up far enough to want a way back to the latest. */
  const [behind, setBehind] = useState(false);

  const measure = (el: HTMLDivElement) => {
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinned.current = gap < 60;
    setBehind(gap > 160);
  };

  // Follow a streaming reply only while the reader is already at the bottom.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (pinned.current) el.scrollTop = el.scrollHeight;
    measure(el);
  }, [thread]);

  useEffect(() => {
    pinned.current = true;
    setThreadsOpen(false);
  }, [thread?.id, doc.id]);

  const threads = [...doc.threads].sort((a, b) => b.updatedAt - a.updatedAt);
  const last = thread?.messages[thread.messages.length - 1];
  // The header orb: idle until a reply streams, then thinking, or acting while one of its tools runs.
  const steps = streamingMessageId ? thread?.messages.find((m) => m.id === streamingMessageId)?.agent?.steps : undefined;
  const lastStep = steps?.[steps.length - 1];
  const activity: Activity = !streamingMessageId ? "idle" : lastStep?.kind === "tool" && lastStep.pending ? "acting" : "thinking";

  return (
    <aside className="panel">
      <header className="panel-header">
        <div className="panel-title">
          <Orb activity={activity} />
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

      <div className="thread-wrap">
        <div className="thread" ref={scroller} onScroll={(e) => measure(e.currentTarget)}>
          {!thread || thread.messages.length === 0 ? (
            <EmptyThread
              hasModel={props.hasModel}
              providers={props.providers}
              autoMode={props.autoMode && props.canAct}
              onSuggest={(text) => setPrefill({ text, nonce: Date.now() })}
              onOpenSettings={props.onOpenSettings}
              shortcut={shortcut}
            />
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
        <ThreadEdges />
        {behind && (
          <button
            type="button"
            className="jump-latest"
            aria-label="Scroll to the latest"
            title="Scroll to the latest"
            onClick={() => {
              pinned.current = true;
              scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
            }}
          >
            <ChevronDown size={11} />
          </button>
        )}
      </div>

      <Composer
        docId={props.doc.id}
        context={context}
        numbered={props.numbered}
        hasModel={props.hasModel}
        vision={props.vision}
        autoMode={props.autoMode}
        canAct={props.canAct}
        onSetAutoMode={props.onSetAutoMode}
        efforts={props.efforts}
        effort={props.effort}
        onSetEffort={props.onSetEffort}
        dropped={props.dropped}
        prefill={prefill}
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
  autoMode,
  onSuggest,
  onOpenSettings,
  shortcut,
}: {
  hasModel: boolean;
  providers: ProviderStatus[];
  /** Auto mode is on and the model can work in it. */
  autoMode: boolean;
  onSuggest: (text: string) => void;
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
      <Orb size={32} />
      <p>
        {autoMode
          ? "Tell the collaborator what to do. It edits the document, checks proofs in Lean and draws graphs, and you can undo all of it."
          : "Select a step in your proof to ask about it, find gaps, or challenge it."}
      </p>
      <kbd>{shortcut("L")}</kbd>
      {hasModel && (
        <div className="suggestions" aria-label="Suggestions">
          {SUGGESTIONS[autoMode ? "auto" : "manual"].map((text) => (
            <button key={text} type="button" className="suggestion" onClick={() => onSuggest(text)}>
              {text}
            </button>
          ))}
        </div>
      )}
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
  const section = useRef<HTMLElement>(null);
  const sparks = useRef<ClickSparkHandle>(null);
  /** Sparks from the button that took a proposal in. They live on the message, since the card goes at once. */
  const celebrate = (button: HTMLElement) => {
    const box = section.current?.getBoundingClientRect();
    const at = button.getBoundingClientRect();
    if (box) sparks.current?.spark(at.left + at.width / 2 - box.left, at.top + at.height / 2 - box.top);
  };
  const agent = message.agent;
  // Once complete, proposals move out of the prose into their own cards. Auto replies make
  // their changes instead of proposing them.
  const parts = streaming || agent ? null : splitProposals(message.content);
  const liveChanges = !!agent && agent.changes.length > 0 && !agent.undone;
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
    <section ref={section} className={`msg msg--ai${streaming ? " is-streaming" : ""}`}>
      <Sparks ref={sparks} className="msg__sparks" />
      <div className="msg__head">
        <CollaboratorGlyph />
        <span className="msg__author msg__author--ai">Collaborator</span>
        <span className="msg__time">
          {MODE_LABELS[message.mode]}
          {/* An Auto reply's badge leaves no room; its effort is in the run's summary instead. */}
          {message.effort && !agent ? ` · ${effortLabel(message.effort)}` : ""} · {clockTime(message.createdAt)}
        </span>
        {agent && (
          <span className="badge-auto" title="Auto mode: the collaborator worked on the document itself.">
            {streaming ? <AutoLabel /> : "Auto"}
          </span>
        )}
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
        <Reasoning
          text={message.reasoning}
          thinking={streaming && !message.content && !agent?.steps.length}
          seconds={message.thoughtSeconds}
        />
      )}

      {agent ? (
        <AgentTimeline
          run={agent}
          doc={doc}
          model={message.model?.model}
          startedAt={message.createdAt}
          effort={message.effort}
          streaming={streaming}
          leanFooter={streaming ? undefined : leanFooter}
          onShowBlock={actions.onShowBlock}
          onUndo={() => actions.onUndoAgent(thread.id, message.id)}
        />
      ) : message.content ? (
        prose && <Markdown text={prose} variant="ai" codeFooter={streaming ? undefined : leanFooter} />
      ) : (
        streaming &&
        !message.reasoning && (
          <div className="thinking">
            <Orb activity="thinking" />
            <Shimmer>
              {message.mode === "gaps" ? "Reviewing" : "Thinking"} with {message.model?.model ?? "the model"}…
            </Shimmer>
          </div>
        )
      )}

      {message.error && (
        <div className="msg__error" role="alert">
          {message.error}
        </div>
      )}

      {message.revision && !streaming && (
        <RevisionCard message={message} thread={thread} numbered={numbered} pin={pin} actions={actions} onAccepted={celebrate} />
      )}

      {parts?.addition && !message.insertedBlockId && (
        <Spotlight className="addition">
          <div className="revision__head">
            <StatusGlyph suggested size={8} />
            <span className="revision__title">Proposed addition</span>
            <span className="revision__target revision__target--accent">NEW MATERIAL</span>
          </div>
          <div className="addition__body">
            <Markdown text={parts.addition} variant="ai" />
          </div>
          <div className="revision__actions">
            <button
              type="button"
              className="button button--primary button--small"
              onClick={(e) => {
                celebrate(e.currentTarget);
                actions.onInsertSuggestion(thread.id, message.id);
              }}
            >
              Insert as suggestion
            </button>
            <span className="addition__hint">Nothing changes until you accept it in the document.</span>
          </div>
        </Spotlight>
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
          {message.content && !agent && !message.insertedBlockId && !parts?.addition && !message.revision && (
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
          {isLast && canRetry && !liveChanges && (
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
  onAccepted,
}: {
  message: ThreadMessage;
  thread: Thread;
  numbered: NumberedBlock[];
  pin?: Pin;
  actions: CollaboratorActions;
  onAccepted: (button: HTMLElement) => void;
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
    <Spotlight className="revision">
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
          <button
            type="button"
            className="button button--primary button--small"
            onClick={(e) => {
              onAccepted(e.currentTarget);
              actions.onAcceptRevision(thread.id, message.id);
            }}
          >
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
    </Spotlight>
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
  autoMode,
  canAct,
  onSetAutoMode,
  efforts,
  effort,
  onSetEffort,
  dropped,
  prefill,
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
  autoMode: boolean;
  canAct: boolean;
  onSetAutoMode: (auto: boolean) => void;
  efforts: Effort[];
  effort: string | undefined;
  onSetEffort: (effort: string) => void;
  dropped: { files: File[]; nonce: number } | null;
  /** Text to put in the box, e.g. a suggestion picked in an empty thread. */
  prefill: { text: string; nonce: number } | null;
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

  useEffect(() => {
    if (!prefill) return;
    setText(prefill.text);
    input.current?.focus();
  }, [prefill]);

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
      <div className={`composer${focused ? " is-focused" : ""}${autoMode && canAct && streaming ? " is-working" : ""}`}>
        {autoMode && canAct && streaming && <ComposerBeam />}
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
        {autoMode && hasModel && !canAct && (
          <p className="composer__warning">This model can’t use tools, so Auto works like Manual with it. Choose a ChatGPT model, or an Ollama model that supports tools, such as qwen3.</p>
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
          <EffortGauge efforts={efforts} value={effort} onChange={onSetEffort} />
          <div className="mode-switch" role="radiogroup" aria-label="How the collaborator works">
            <button
              type="button"
              role="radio"
              aria-checked={!autoMode}
              className={autoMode ? undefined : "is-on"}
              title="Manual: the collaborator proposes. Nothing changes until you accept it."
              onClick={() => onSetAutoMode(false)}
            >
              Manual
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={autoMode}
              className={autoMode ? "is-on" : undefined}
              title="Auto: the collaborator works on the document itself, editing, checking proofs in Lean and drawing graphs, and you can undo all of it."
              onClick={() => onSetAutoMode(true)}
            >
              {autoMode ? <AutoLabel /> : "Auto"}
            </button>
          </div>
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
                : autoMode && canAct
                  ? "Ask the collaborator to do something: prove, fix, formalize, graph…"
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
