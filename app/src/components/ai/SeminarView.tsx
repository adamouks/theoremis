// A Seminar reply: who the chair convened, each member's objective in its own words, what it is
// doing now and what it reported, then the chair's summary. Each member has its own orb, tinted,
// which moves as the collaborator's does: idle, thinking, or acting while one of its tools runs.

import { useState } from "react";
import { effortLabel } from "../../lib/effort";
import type { AgentStep, Doc, SeminarMember, SeminarRun } from "../../lib/types";
import { ChevronDown, Retry } from "../Icons";
import { Markdown, type CodeFooter } from "../Markdown";
import { elapsed, StepRow, WORKING } from "./AgentTimeline";
import { MEMBER_TINTS, Orb, Shimmer, type Activity } from "./effects";

/** A member's orb: idle unless it is working, and acting while one of its tools runs. */
export function memberActivity(member: SeminarMember): Activity {
  if (member.status !== "working") return "idle";
  return pendingTool(member.steps) ? "acting" : "thinking";
}

/** The tool a run is waiting on, if any. */
export function pendingTool(steps: AgentStep[] | undefined) {
  const last = steps?.[steps.length - 1];
  return last?.kind === "tool" && last.pending ? last : undefined;
}

/** `#rrggbb` at `a` opacity, for the card's wash and line in the member's tint. */
function alpha(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const STATUS: Record<SeminarMember["status"], string> = {
  waiting: "Waiting its turn",
  working: "Working",
  done: "Done",
  stopped: "Stopped",
  failed: "Failed",
};

export function SeminarView({
  run,
  summary,
  doc,
  model,
  startedAt,
  effort,
  streaming,
  leanFooter,
  onShowBlock,
  onUndo,
}: {
  run: SeminarRun;
  /** The chair's summary: the reply's content. */
  summary: string;
  doc: Doc;
  model?: string;
  startedAt: number;
  effort?: string;
  streaming: boolean;
  leanFooter?: CodeFooter;
  onShowBlock: (blockId: string) => void;
  onUndo: () => void;
}) {
  const changes = run.changes.length;
  const steps = run.members.reduce((n, m) => n + m.steps.filter((s) => s.kind === "tool").length, 0);
  const members = run.members.length;

  return (
    <div className="agent seminar">
      {run.status === "convening" && streaming && (
        <div className="agent-working">
          <Orb activity="thinking" />
          <Shimmer>Convening a seminar with {model ?? "the model"}…</Shimmer>
        </div>
      )}
      {members > 0 && (
        <ol className="seminar-members" aria-label="The seminar">
          {run.members.map((member, i) => (
            <MemberCard key={member.id} member={member} tint={MEMBER_TINTS[i % MEMBER_TINTS.length]} doc={doc} onShowBlock={onShowBlock} />
          ))}
        </ol>
      )}
      {run.status === "summing" && streaming && !summary && (
        <div className="agent-working">
          <Orb activity="thinking" />
          <Shimmer>Summing up the seminar…</Shimmer>
        </div>
      )}
      {summary && (
        <div className="seminar-summary">
          <Markdown text={summary} variant="ai" codeFooter={leanFooter} />
        </div>
      )}
      {!streaming && (
        <div className="agent-summary">
          <span className="agent-summary__text">
            {run.status === "stopped" ? "Stopped. " : run.status === "failed" ? "Stopped by an error. " : ""}
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
              {members > 0 && ` · ${members} ${members === 1 ? "member" : "members"}`}
              {steps > 0 && ` · ${steps} ${steps === 1 ? "step" : "steps"}`}
              {effort && ` · ${effortLabel(effort)}`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function MemberCard({ member, tint, doc, onShowBlock }: { member: SeminarMember; tint: string; doc: Doc; onShowBlock: (blockId: string) => void }) {
  const [open, setOpen] = useState(false);
  const working = member.status === "working";
  const tools = member.steps.filter((s): s is Extract<AgentStep, { kind: "tool" }> => s.kind === "tool");
  const pending = pendingTool(member.steps);
  const last = member.steps[member.steps.length - 1];
  const done = !!member.finishedAt;
  const ran = member.startedAt && member.finishedAt ? elapsed(member.finishedAt - member.startedAt) : undefined;

  return (
    <li className={`seminar-member is-${member.status}`} style={{ ["--tint" as string]: tint, ["--tint-wash" as string]: alpha(tint, 0.045), ["--tint-line" as string]: alpha(tint, 0.16), ["--tint-glow" as string]: alpha(tint, 0.34) }}>
      <div className="seminar-member__orb">
        <Orb size={32} tint={tint} activity={memberActivity(member)} />
      </div>
      <div className="seminar-member__main">
        <div className="seminar-member__head">
          <span className="seminar-member__role">{member.role}</span>
          <span className="seminar-member__status">
            {STATUS[member.status]}
            {member.changed > 0 && ` · ${member.changed} ${member.changed === 1 ? "change" : "changes"}`}
            {ran && ` · ${ran}`}
          </span>
        </div>
        <p className="seminar-member__objective">{member.objective}</p>
        {working && (
          <div className="seminar-member__now" aria-live="polite">
            <Shimmer>{pending ? `${WORKING[pending.name] ?? "Working"}…` : last?.kind === "text" ? "Writing to the chair…" : "Thinking…"}</Shimmer>
          </div>
        )}
        {member.report && done && (
          <div className="seminar-member__report">
            <Markdown text={member.report} variant="note" />
          </div>
        )}
        {member.error && <p className="seminar-member__error">{member.error}</p>}
        {tools.length > 0 && (
          <>
            <button type="button" className="agent-step__more seminar-member__more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {open ? "Hide work" : "Show work"} · {tools.length} {tools.length === 1 ? "step" : "steps"}
              <ChevronDown size={9} />
            </button>
            <div className={`agent-step__detail${open ? " is-open" : ""}`} aria-hidden={!open}>
              <div>
                {/* Only while open, so a hidden rail's orbs don't keep drawing. */}
                {open && (
                  <ol className="agent-steps seminar-member__steps">
                    {tools.map((step, at) => (
                      <StepRow key={`${step.id}:${at}`} step={step} doc={doc} onShowBlock={onShowBlock} />
                    ))}
                  </ol>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </li>
  );
}
