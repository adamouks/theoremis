import { useEffect, useState, type FormEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage } from "../lib/api";
import type { Settings, SettingsUpdate } from "../lib/types";
import { Close, OllamaMark, OpenAILogo } from "./Icons";

interface Props {
  settings: Settings;
  onClose: () => void;
  onSaved: (settings: Settings) => void;
}

function keyDescription(settings: Settings): string {
  const { source, hint } = settings.openaiKey;
  if (source === "settings") return `Using the key saved in Theoremis (${hint}).`;
  if (source === "env") return `Using OPENAI_API_KEY from your environment (${hint}).`;
  return "No key yet. It is stored only on this computer and never shown to the interface.";
}

export function SettingsDialog({ settings, onClose, onSaved }: Props) {
  const [displayName, setDisplayName] = useState(settings.displayName);
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState(settings.openaiBaseUrl);
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
    if (apiKey.trim()) update.openaiApiKey = apiKey.trim();
    else if (removeKey) update.openaiApiKey = "";
    if (openaiBaseUrl !== settings.openaiBaseUrl) update.openaiBaseUrl = openaiBaseUrl;
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
              <span className="settings-section__tag">OpenAI API</span>
            </h3>
            <label className="field">
              <span>API key</span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={settings.openaiKey.hint ?? "sk-…"}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setRemoveKey(false);
                }}
              />
              <small>
                {removeKey ? "The saved key will be removed." : keyDescription(settings)}{" "}
                <button type="button" className="link-button" onClick={() => void openUrl("https://platform.openai.com/api-keys")}>
                  Get an API key
                </button>
                {settings.openaiKey.source === "settings" && !removeKey && (
                  <>
                    {" · "}
                    <button type="button" className="link-button" onClick={() => setRemoveKey(true)}>
                      Remove saved key
                    </button>
                  </>
                )}
              </small>
            </label>
            <label className="field">
              <span>API base URL</span>
              <input
                type="url"
                spellCheck={false}
                placeholder={settings.defaultOpenaiBaseUrl}
                value={openaiBaseUrl}
                onChange={(e) => setOpenaiBaseUrl(e.target.value)}
              />
              <small>Leave blank for OpenAI. Any OpenAI-compatible endpoint works here.</small>
            </label>
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
