import type { LeanApi } from "../lib/useLean";

/** Lean 4 and Mathlib on this computer: what's installed, and setting it up. */
export function LeanSetup({ lean }: { lean: LeanApi }) {
  const { status, progress, error } = lean;
  const ready = !!status?.ready;
  return (
    <div className="account">
      <p className="account__note">
        {ready
          ? `Formalizations are checked against Mathlib on this computer${status?.leanVersion ? `, with Lean ${status.leanVersion}` : ""}${status?.mathlibVersion ? ` and Mathlib ${status.mathlibVersion}` : ""}. Use Check with Lean under any Lean code from the collaborator.`
          : "Check the collaborator's Lean code against Mathlib, on your computer. Setup installs Lean with elan and downloads Mathlib's prebuilt library, about 5 GB."}
      </p>
      {progress ? (
        <div className="lean-setup">
          <div className="account__actions">
            <span className="account__waiting">
              <span className="spinner" aria-hidden="true" />
              {progress.step}
            </span>
            <button type="button" className="text-button" onClick={lean.cancel}>
              Cancel
            </button>
          </div>
          {progress.line && <code className="lean-setup__line">{progress.line}</code>}
        </div>
      ) : (
        <div className="account__actions">
          <button type="button" className={`button button--small ${ready ? "button--ghost" : "button--cream"}`} onClick={() => void lean.setUp()}>
            {ready ? "Run setup again" : status?.installed ? "Download Mathlib" : "Set up Lean & Mathlib"}
          </button>
          {ready && status && <span className="account__hint">{status.projectPath}</span>}
        </div>
      )}
      {error && (
        <p className="account__notice" role="status">
          {error}
        </p>
      )}
    </div>
  );
}
