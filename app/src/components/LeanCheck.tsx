import { useState } from "react";
import { api, errorMessage } from "../lib/api";
import type { LeanMessage, LeanStatus, StoredLeanCheck } from "../lib/types";
import { Check } from "./Icons";

interface Props {
  code: string;
  /** The last check of this exact code, if any. */
  stored?: StoredLeanCheck;
  lean: LeanStatus | null;
  /** The document block this formalizes, when the reply was about one. */
  target?: { label: string; verified: boolean };
  onChecked: (check: StoredLeanCheck) => void;
  onMarkVerified?: () => void;
  onAskToFix?: (request: string) => void;
  onOpenSettings: () => void;
}

const MAX_SHOWN = 6;

function where(m: LeanMessage) {
  return `${m.line}:${m.column + 1}`;
}

/** What to send back to the collaborator so it can repair the formalization. */
function fixRequest(check: StoredLeanCheck): string {
  const problems = check.messages
    .filter((m) => m.severity !== "information")
    .slice(0, 12)
    .map((m) => `${where(m)} ${m.severity}: ${m.text}`)
    .join("\n\n");
  const ask =
    check.outcome === "incomplete"
      ? "Lean accepts the formalization but parts of it are still `sorry`. Fill them in so it compiles without `sorry`, keeping the theorem statement."
      : "Lean rejected the formalization. Fix it so it compiles without `sorry`, keeping the theorem statement.";
  return `${ask} Reply with the complete corrected file.\n\nLean reported:\n\n\`\`\`\n${problems || "(no details)"}\n\`\`\``;
}

/** Checks one Lean code block from a reply against Mathlib, and shows what Lean said. */
export function LeanCheckPanel({ code, stored, lean, target, onChecked, onMarkVerified, onAskToFix, onOpenSettings }: Props) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const result = stored?.code === code ? stored : undefined;

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const check = await api.leanCheck(code);
      onChecked({ ...check, code, checkedAt: Date.now() });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  if (!lean?.ready) {
    return (
      <div className="lean-check">
        <div className="lean-check__bar">
          <span className="lean-check__hint">Set up Lean and Mathlib to check this proof on your computer.</span>
          <button type="button" className="text-button" onClick={onOpenSettings}>
            Set up…
          </button>
        </div>
      </div>
    );
  }

  const problems = result?.messages.filter((m) => m.severity !== "information") ?? [];
  const extra = [...new Set(result?.theorems.flatMap((t) => t.extraAxioms) ?? [])].filter((a) => a !== "sorryAx");

  return (
    <div className={`lean-check${result ? ` lean-check--${result.outcome}` : ""}`}>
      <div className="lean-check__bar">
        {running ? (
          <span className="lean-check__status">
            <span className="spinner" aria-hidden="true" />
            Checking with Lean… loading Mathlib can take a minute.
          </span>
        ) : result ? (
          <span className="lean-check__status">
            {result.outcome === "proved" && <Check size={11} />}
            <strong>
              {result.outcome === "proved"
                ? "Lean accepted the proof"
                : result.outcome === "incomplete"
                  ? "Compiles, but uses sorry"
                  : `Lean found ${problems.filter((m) => m.severity === "error").length || "an"} error${problems.filter((m) => m.severity === "error").length === 1 ? "" : "s"}`}
            </strong>
            <span className="lean-check__meta">{result.seconds.toFixed(1)} s</span>
          </span>
        ) : (
          <span className="lean-check__hint">Not checked yet.</span>
        )}
        <button type="button" className="button button--ghost button--small" onClick={() => void run()} disabled={running}>
          {result ? "Check again" : "Check with Lean"}
        </button>
      </div>

      {error && <p className="lean-check__error">{error}</p>}

      {result?.outcome === "proved" && (
        <div className="lean-check__detail">
          {result.theorems.length > 0 && (
            <p>
              {result.theorems.map((t) => (
                <code key={t.name}>{t.name}</code>
              ))}{" "}
              {result.theorems.length === 1 ? "is" : "are"} proved from Mathlib's standard axioms
              {extra.length > 0 && <>, plus {extra.join(", ")}</>}.
            </p>
          )}
          {target &&
            onMarkVerified &&
            (target.verified ? (
              <p className="lean-check__done">{target.label} is marked verified.</p>
            ) : (
              <button type="button" className="button button--cream button--small" onClick={onMarkVerified}>
                Mark {target.label} as verified
              </button>
            ))}
        </div>
      )}

      {result && result.outcome !== "proved" && (
        <div className="lean-check__detail">
          {problems.length > 0 && (
            <ul className="lean-check__messages">
              {problems.slice(0, MAX_SHOWN).map((m, i) => (
                <li key={i} className={`lean-msg lean-msg--${m.severity}`}>
                  <span className="lean-msg__where">{where(m)}</span>
                  <pre>{m.text}</pre>
                </li>
              ))}
              {problems.length > MAX_SHOWN && <li className="lean-check__more">and {problems.length - MAX_SHOWN} more</li>}
            </ul>
          )}
          {onAskToFix && (
            <button type="button" className="button button--primary button--small" onClick={() => onAskToFix(fixRequest(result))}>
              {result.outcome === "incomplete" ? "Ask to finish the proof" : "Ask to fix"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
