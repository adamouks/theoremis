import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { errorMessage } from "../lib/api";
import type { ChatGptSession, ProviderStatus } from "../lib/types";
import type { LeanApi } from "../lib/useLean";
import { ChatGptAccount } from "./ChatGptAccount";
import { ArrowUpRight, OllamaMark, OpenAILogo } from "./Icons";
import { LeanSetup } from "./LeanSetup";

export type WelcomeChoice = "example" | "blank" | "workspace";

interface Props {
  displayName: string;
  /** Documents from an earlier version, so there's nothing to create. */
  hasDocuments: boolean;
  providers: ProviderStatus[];
  modelsLoading: boolean;
  chatgpt: ChatGptSession | null;
  lean: LeanApi;
  onChatgptChange: (session: ChatGptSession) => void;
  onRefreshModels: () => void;
  onFinish: (choice: WelcomeChoice, displayName: string) => Promise<void>;
}

const STEPS = ["Welcome", "Model", "Lean 4", "Start"] as const;

function BetaTag() {
  return <span className="beta-tag">Beta</span>;
}

/** The first-run introduction: what Theoremis is, what beta means, and getting set up. */
export function Welcome(props: Props) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState(props.displayName);
  const [finishing, setFinishing] = useState<WelcomeChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Fixed when the introduction opens, so the example being added doesn't change the last step under it.
  const [hasDocuments] = useState(props.hasDocuments);

  const finish = async (choice: WelcomeChoice) => {
    setFinishing(choice);
    setError(null);
    try {
      await props.onFinish(choice, name.trim());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setFinishing(null);
    }
  };

  const ollama = props.providers.find((p) => p.provider === "ollama");
  const chatgptReady = props.chatgpt?.status === "connected" && props.chatgpt.sharing;
  const ollamaReady = !!ollama?.available && ollama.models.length > 0;

  return (
    <div className="welcome">
      <div className="welcome__chrome" data-tauri-drag-region />
      <div className="welcome__inner">
        <header className="welcome__head">
          <span className="welcome__brand">
            <span className="wordmark">Theoremis</span>
            <span className="tombstone" />
            <BetaTag />
          </span>
          <ol className="welcome__steps" aria-label="Introduction steps">
            {STEPS.map((label, i) => (
              <li key={label} className={i === step ? "is-current" : i < step ? "is-done" : ""}>
                <span>{i + 1}</span>
                {label}
              </li>
            ))}
          </ol>
        </header>

        {step === 0 && (
          <section className="welcome__body">
            <h1>A workspace for mathematics, with a collaborator in the margins.</h1>
            <p className="welcome__lead">
              Write proofs in a typeset document. Ask a model to explore a conjecture, find gaps or challenge a step, and
              check formalizations in Lean 4. Nothing enters your document unless you accept it.
            </p>
            <div className="welcome__notice">
              <strong>Theoremis is in beta.</strong> It works, but it is early: things will change between versions and
              some will break. Your documents are plain files on this computer, so keep copies of anything important. What
              the collaborator says is model reasoning, never a checked proof.
            </div>
            <label className="field welcome__field">
              <span>Your name</span>
              <input value={name} placeholder="Optional" onChange={(e) => setName(e.target.value)} autoFocus />
              <small>Shown on your documents and on what you ask the collaborator.</small>
            </label>
          </section>
        )}

        {step === 1 && (
          <section className="welcome__body">
            <h1>Choose what the collaborator runs on.</h1>
            <p className="welcome__lead">
              Theoremis is made for ChatGPT and Ollama. Use either, or both, and change your mind any time in Settings.
            </p>
            <div className="welcome__cards">
              <div className="welcome-card">
                <div className="welcome-card__head">
                  <OpenAILogo size={16} />
                  <strong>ChatGPT</strong>
                  <span className="welcome-card__tag">Your plan</span>
                  <BetaTag />
                </div>
                <ChatGptAccount session={props.chatgpt} onChange={props.onChatgptChange} />
              </div>
              <div className="welcome-card">
                <div className="welcome-card__head">
                  <OllamaMark size={16} />
                  <strong>Ollama</strong>
                  <span className="welcome-card__tag">On this computer</span>
                  <BetaTag />
                </div>
                <div className="account">
                  {ollamaReady ? (
                    <div className="account__row">
                      <span className="dot dot--on" />
                      <span className="account__who">
                        <strong>Ollama is running</strong>
                        <small>
                          {ollama.models
                            .slice(0, 3)
                            .map((m) => m.id)
                            .join(", ")}
                          {ollama.models.length > 3 ? ` and ${ollama.models.length - 3} more` : ""}
                        </small>
                      </span>
                    </div>
                  ) : (
                    <p className="account__note">
                      Run open models privately on your computer.{" "}
                      {ollama?.available ? (
                        <>
                          Ollama is running but has no models yet. Pull one with <code>ollama pull qwen3:8b</code>, then
                          check again.
                        </>
                      ) : (
                        <>
                          Install Ollama, pull a model with <code>ollama pull qwen3:8b</code>, then check again.
                        </>
                      )}
                    </p>
                  )}
                  <div className="account__actions">
                    {!ollama?.available && (
                      <button type="button" className="button button--ghost button--small" onClick={() => void openUrl("https://ollama.com/download")}>
                        Download Ollama
                        <ArrowUpRight size={10} />
                      </button>
                    )}
                    <button type="button" className="text-button" onClick={props.onRefreshModels} disabled={props.modelsLoading}>
                      {props.modelsLoading ? "Checking…" : "Check again"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
            {!chatgptReady && !ollamaReady && (
              <p className="welcome__hint">You can continue without a model and connect one later; the collaborator waits until you do.</p>
            )}
          </section>
        )}

        {step === 2 && (
          <section className="welcome__body">
            <h1>
              Check proofs in Lean 4. <BetaTag />
            </h1>
            <p className="welcome__lead">
              When the collaborator formalizes a step, Theoremis can check it with Lean against Mathlib, on your computer.
              A proof Lean accepts can mark the step verified. This is the newest part of Theoremis and entirely optional.
            </p>
            <div className="welcome-card">
              <LeanSetup lean={props.lean} />
            </div>
            <p className="welcome__hint">Setup keeps running in the background, so you can carry on. You'll also find it in Settings.</p>
          </section>
        )}

        {step === 3 && (
          <section className="welcome__body">
            <h1>{hasDocuments ? "Your documents are where you left them." : "Where would you like to start?"}</h1>
            <p className="welcome__lead">
              {hasDocuments
                ? "Pick up your work, or add the example project to try the tools on."
                : "Try the tools on a short worked example, or begin with an empty page."}
            </p>
            <div className="welcome__choices">
              {hasDocuments && (
                <button type="button" className="welcome-choice" onClick={() => void finish("workspace")} disabled={!!finishing}>
                  <strong>Open my documents</strong>
                  <span>Continue where you left off.</span>
                </button>
              )}
              <button type="button" className="welcome-choice" onClick={() => void finish("example")} disabled={!!finishing}>
                <strong>Explore an example</strong>
                <span>
                  <em>Figurate numbers</em>: a proof to review, statuses to read, and a step to send to the collaborator.
                </span>
              </button>
              {!hasDocuments && (
                <button type="button" className="welcome-choice" onClick={() => void finish("blank")} disabled={!!finishing}>
                  <strong>Start from a blank page</strong>
                  <span>An empty document in a new project.</span>
                </button>
              )}
            </div>
            {error && <p className="welcome__error">{error}</p>}
          </section>
        )}

        <footer className="welcome__foot">
          {step > 0 ? (
            <button type="button" className="text-button" onClick={() => setStep((s) => s - 1)}>
              Back
            </button>
          ) : (
            <button type="button" className="text-button" onClick={() => setStep(STEPS.length - 1)}>
              Skip introduction
            </button>
          )}
          {step < STEPS.length - 1 && (
            <button type="button" className="button button--cream" onClick={() => setStep((s) => s + 1)}>
              {step === 2 ? (props.lean.status?.ready || props.lean.progress ? "Continue" : "Maybe later") : "Continue"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
