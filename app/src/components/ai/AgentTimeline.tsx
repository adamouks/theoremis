// An Auto reply as a chain of thought: what the collaborator wrote and, on a rail between, each
// tool it used, in order, then what it changed. The rail follows Vercel AI Elements' Chain of
// Thought (Apache-2.0, see THIRD_PARTY_NOTICES.md).

import { useEffect, useRef, useState } from "react";
import type { AgentRun, AgentStep, Doc } from "../../lib/types";
import { Check, ChevronDown, Retry } from "../Icons";
import { Markdown, type CodeFooter } from "../Markdown";
import { Orb, Shimmer, Sparks, toolActivity, type ClickSparkHandle } from "./effects";

const WORKING: Record<string, string> = {
  read_document: "Reading",
  list_documents: "Looking through the project",
  edit_block: "Rewriting",
  insert_block: "Adding",
  delete_block: "Removing",
  set_status: "Setting a status",
  set_title: "Retitling",
  check_lean: "Checking with Lean",
  check_graph: "Checking a graph",
};

type ToolStep = Extract<AgentStep, { kind: "tool" }>;

type Group = { kind: "text"; text: string; at: number } | { kind: "tools"; steps: { step: ToolStep; at: number }[]; at: number };

/** "8s", "1m 12s". */
function elapsed(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function AgentTimeline({
  run,
  doc,
  model,
  startedAt,
  streaming,
  leanFooter,
  onShowBlock,
  onUndo,
}: {
  run: AgentRun;
  doc: Doc;
  model?: string;
  /** When the reply started, to say how long it worked. */
  startedAt: number;
  streaming: boolean;
  leanFooter?: CodeFooter;
  onShowBlock: (blockId: string) => void;
  onUndo: () => void;
}) {
  // Tool steps in a row share a rail; what the collaborator wrote sits between rails.
  const groups: Group[] = [];
  run.steps.forEach((step, at) => {
    const prev = groups[groups.length - 1];
    if (step.kind === "text") groups.push({ kind: "text", text: step.text, at });
    else if (prev?.kind === "tools") prev.steps.push({ step, at });
    else groups.push({ kind: "tools", steps: [{ step, at }], at });
  });
  const last = run.steps[run.steps.length - 1];
  // Between a tool's result and the model's next words or call.
  const deciding = streaming && last?.kind === "tool" && !last.pending;
  const tools = run.steps.filter((s) => s.kind === "tool").length;
  const changes = run.changes.length;

  return (
    <div className="agent">
      {streaming && !last && (
        <div className="agent-working">
          <Orb activity="thinking" />
          <Shimmer>Working with {model ?? "the model"}…</Shimmer>
        </div>
      )}
      {groups.map((group, g) =>
        group.kind === "text" ? (
          <Markdown key={group.at} text={group.text} variant="ai" codeFooter={leanFooter} />
        ) : (
          <ol key={group.at} className="agent-steps">
            {group.steps.map(({ step, at }) => (
              <StepRow key={`${step.id}:${at}`} step={step} doc={doc} onShowBlock={onShowBlock} />
            ))}
            {deciding && g === groups.length - 1 && (
              <li className="agent-step is-pending is-thinking">
                <div className="agent-step__node">
                  <Orb activity="thinking" />
                </div>
                <div className="agent-step__main">
                  <span className="agent-step__label">
                    <Shimmer>Thinking with {model ?? "the model"}…</Shimmer>
                  </span>
                </div>
              </li>
            )}
          </ol>
        ),
      )}
      {!streaming && (
        <div className="agent-summary">
          <span className="agent-summary__text">
            {run.status === "stopped"
              ? "Stopped. "
              : run.status === "limit"
                ? "Stopped after the most steps one reply may take. "
                : run.status === "failed"
                  ? "Stopped by an error. "
                  : ""}
            {run.undone
              ? `${changes} ${changes === 1 ? "change" : "changes"} undone.`
              : changes
                ? `${changes} ${changes === 1 ? "change" : "changes"} to the document.`
                : "Nothing in the document changed."}
          </span>
          {changes > 0 && !run.undone && (
            <button type="button" className="text-button" onClick={onUndo}>
              <Retry />
              Undo {changes === 1 ? "it" : "all"}
            </button>
          )}
          {run.finishedAt && (
            <span className="agent-summary__meta">
              Worked for {elapsed(run.finishedAt - startedAt)}
              {tools > 0 && ` · ${tools} ${tools === 1 ? "step" : "steps"}`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function StepRow({ step, doc, onShowBlock }: { step: ToolStep; doc: Doc; onShowBlock: (blockId: string) => void }) {
  const [open, setOpen] = useState(false);
  const sparks = useRef<ClickSparkHandle>(null);
  const wasPending = useRef(step.pending);

  // A statement Lean has just verified gets a moment of celebration; one loaded later doesn't.
  useEffect(() => {
    if (wasPending.current && !step.pending && step.verified) sparks.current?.spark();
    wasPending.current = step.pending;
  }, [step.pending, step.verified]);

  const state = step.pending ? "is-pending" : !step.ok ? "is-failed" : step.verified ? "is-verified" : "is-done";
  const shown = !step.pending && !!step.blockId && doc.blocks.some((b) => b.id === step.blockId);
  const detail = !step.pending && step.detail;
  return (
    <li className={`agent-step ${state}`}>
      <div className="agent-step__node">
        <Sparks ref={sparks} className="agent-step__spark" disabled={!step.verified}>
          {step.pending ? (
            <Orb activity={toolActivity(step.name)} />
          ) : (
            <span className="agent-step__mark" aria-hidden="true">
              {step.ok ? <Check /> : "!"}
            </span>
          )}
        </Sparks>
      </div>
      <div className="agent-step__main">
        <div className="agent-step__row">
          <span className="agent-step__label">
            {step.pending ? <Shimmer>{WORKING[step.name] ?? "Working"}…</Shimmer> : <Markdown text={step.label} variant="note" />}
          </span>
          {shown && (
            <button type="button" className="link-button agent-step__show" onClick={() => onShowBlock(step.blockId!)}>
              Show
            </button>
          )}
          {detail && (
            <button type="button" className="agent-step__more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              Details
              <ChevronDown size={9} />
            </button>
          )}
        </div>
        {detail && (
          <div className={`agent-step__detail${open ? " is-open" : ""}`} aria-hidden={!open}>
            <div>
              <pre>{detail}</pre>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}
