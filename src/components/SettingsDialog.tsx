import { useEffect, useState, type FormEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage } from "../lib/api";
import type { ChatGptSession, Settings, SettingsUpdate } from "../lib/types";
import type { Updates, UpdateStatus } from "../lib/useUpdates";
import { ChatGptAccount } from "./ChatGptAccount";
import { Close, OllamaMark, OpenAILogo } from "./Icons";

interface Props {
  settings: Settings;
  chatgpt: ChatGptSession | null;
  updates: Updates;
  onChatgptChange: (session: ChatGptSession) => void;
  onClose: () => void;
  onSaved: (settings: Settings) => void;
}

function updateLine(status: UpdateStatus): string {
  switch (status.kind) {
    case "checking":
      return "Checking for updates…";
    case "upToDate":
      return "You have the latest version.";
    case "downloading":
      return `Downloading ${status.version}${status.percent === null ? "…" : ` · ${status.percent}%`}`;
    case "ready":
      return `Version ${status.version} is ready. Restart to finish updating.`;
    case "installing":
      return `Installing ${status.version}…`;
    case "error":
      return status.message;
    default:
      return "Updates download automatically from GitHub releases.";
  }
}

export function SettingsDialog({ settings, chatgpt, updates, onChatgptChange, onClose, onSaved }: Props) {
  const [displayName, setDisplayName] = useState(settings.displayName);
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState(settings.ollamaBaseUrl);
  const [systemPrompt, setSystemPrompt] = useState(settings.systemPrompt);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const update: SettingsUpdate = {};
    if (displayName !== settings.displayName) update.displayName = displayName;
    if (ollamaBaseUrl !== settings.ollamaBaseUrl) update.ollamaBaseUrl = ollamaBaseUrl;
    if (systemPrompt !== settings.systemPrompt) update.systemPrompt = systemPrompt;

    setSaving(true);
    setError(null);
    try {
      onSaved(await api.updateSettings(update));
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  };

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" onSubmit={submit} aria-labelledby="settings-title">
        <header className="dialog__head">
          <h2 id="settings-title">Settings</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close settings">
            <Close size={12} />
          </button>
        </header>

        <div className="dialog__body">
          <section className="settings-section">
            <h3>You</h3>
            <label className="field">
              <span>Name</span>
              <input
                value={displayName}
                placeholder="e.g. Élise Moreau"
                onChange={(e) => setDisplayName(e.target.value)}
              />
              <small>Shown on your documents and on what you ask the collaborator.</small>
            </label>
          </section>

          <section className="settings-section">
            <h3>
              <OpenAILogo size={14} />
              ChatGPT
              <span className="settings-section__tag">Your plan</span>
            </h3>
            <ChatGptAccount session={chatgpt} onChange={onChatgptChange} />
          </section>

          <section className="settings-section">
            <h3>
              <OllamaMark size={14} />
              Ollama
              <span className="settings-section__tag">Local models</span>
            </h3>
            <label className="field">
              <span>Server URL</span>
              <input
                type="url"
                spellCheck={false}
                placeholder={settings.defaultOllamaBaseUrl}
                value={ollamaBaseUrl}
                onChange={(e) => setOllamaBaseUrl(e.target.value)}
              />
              <small>
                Runs models on your machine.{" "}
                <button type="button" className="link-button" onClick={() => void openUrl("https://ollama.com/download")}>
                  Download Ollama
                </button>
                , then pull a model with <code>ollama pull qwen3:8b</code>.
              </small>
            </label>
          </section>

          <section className="settings-section">
            <h3>Collaborator</h3>
            <label className="field">
              <span>Standing instructions</span>
              <textarea
                rows={4}
                placeholder="e.g. Prefer elementary arguments. I work in analytic number theory."
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
              />
              <small>Added to every request, for every model.</small>
            </label>
          </section>

          <section className="settings-section">
            <h3>
              Updates
              {updates.version && <span className="settings-section__tag">Version {updates.version}</span>}
            </h3>
            <div className="update-panel">
              <p className={`update-panel__line${updates.status.kind === "error" ? " is-error" : ""}`}>
                {updateLine(updates.status)}
              </p>
              {updates.status.kind === "ready" || updates.status.kind === "installing" ? (
                <button
                  type="button"
                  className="button button--cream button--small"
                  onClick={() => void updates.restart()}
                  disabled={updates.status.kind === "installing"}
                >
                  Restart to update
                </button>
              ) : (
                <button
                  type="button"
                  className="button button--ghost button--small"
                  onClick={() => void updates.checkNow()}
                  disabled={updates.status.kind === "checking" || updates.status.kind === "downloading"}
                >
                  Check for updates
                </button>
              )}
            </div>
          </section>

          {error && (
            <p className="dialog__error" role="alert">
              {error}
            </p>
          )}
        </div>

        <footer className="dialog__foot">
          <button type="button" className="text-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button--cream" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </form>
    </div>
  );
}
