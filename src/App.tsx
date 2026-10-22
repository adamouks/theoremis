import { useCallback, useEffect, useMemo, useState } from "react";
import { ChatView } from "./components/ChatView";
import { Composer } from "./components/Composer";
import { SidebarIcon } from "./components/Icons";
import { ModelPicker } from "./components/ModelPicker";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { api, errorMessage } from "./lib/api";
import { useChat } from "./lib/useChat";
import type { ConversationSummary, ModelRef, ProviderStatus, Settings } from "./lib/types";

const sameModel = (a: ModelRef | null, b: ModelRef | null) =>
  !!a && !!b && a.provider === b.provider && a.model === b.model;

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [selected, setSelected] = useState<ModelRef | null>(null);
  const [summaries, setSummaries] = useState<ConversationSummary[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [startupError, setStartupError] = useState<string | null>(null);

  const refreshSummaries = useCallback(() => {
    api.listConversations().then(setSummaries, (err) => console.error(err));
  }, []);

  const refreshModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      setProviders(await api.listModels());
    } catch (err) {
      console.error(err);
    } finally {
      setModelsLoading(false);
    }
  }, []);

  const chat = useChat({ systemPrompt: settings?.systemPrompt ?? "", onSaved: refreshSummaries });

  useEffect(() => {
    api.getSettings().then(
      (loaded) => {
        setSettings(loaded);
        setSelected(loaded.lastModel);
      },
      (err) => setStartupError(errorMessage(err)),
    );
    void refreshModels();
    refreshSummaries();
  }, [refreshModels, refreshSummaries]);

  const available = useMemo(
    () => providers.flatMap((p) => p.models).map((m) => ({ provider: m.provider, model: m.id })),
    [providers],
  );

  // Fall back to the first available model when the remembered one is gone.
  useEffect(() => {
    if (!settings || modelsLoading || available.length === 0) return;
    if (!available.some((m) => sameModel(m, selected))) setSelected(available[0]);
  }, [settings, modelsLoading, available, selected]);

  // Opening a conversation switches to the model it was using, if it's still around.
  const conversationModel = chat.conversation.model;
  useEffect(() => {
    const match = available.find((m) => sameModel(m, conversationModel));
    if (match) setSelected(match);
    // Only when a different conversation is opened, not on every model-list refresh.
  }, [chat.conversation.id]);

  const selectModel = (model: ModelRef) => {
    setSelected(model);
    api.updateSettings({ lastModel: model }).then(setSettings, console.error);
  };

  const deleteConversation = async (id: string) => {
    try {
      await api.deleteConversation(id);
      if (id === chat.conversation.id) chat.startNew();
      refreshSummaries();
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "n") {
        e.preventDefault();
        chat.startNew();
      } else if (e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chat.startNew]);

  const hasModel = selected !== null && available.some((m) => sameModel(m, selected));
  const blockedReason = !hasModel
    ? modelsLoading
      ? "Loading models…"
      : "Connect Ollama or ChatGPT to start"
    : chat.isBusy && !chat.isStreaming
      ? "Waiting for another reply to finish…"
      : null;

  if (startupError) {
    return (
      <div className="fatal">
        <h1>Theoremis couldn't start</h1>
        <p>{startupError}</p>
      </div>
    );
  }

  return (
    <div className={`app${sidebarOpen ? "" : " app--sidebar-hidden"}`}>
      {sidebarOpen && (
        <Sidebar
          conversations={summaries}
          activeId={chat.conversation.id}
          streamingId={chat.streamingId}
          onSelect={(id) => void chat.open(id)}
          onNew={chat.startNew}
          onDelete={(id) => void deleteConversation(id)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}

      <main className="main">
        <header className="topbar" data-tauri-drag-region>
          <button
            type="button"
            className="icon-button"
            onClick={() => setSidebarOpen((o) => !o)}
            aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          >
            <SidebarIcon />
          </button>
          <ModelPicker
            providers={providers}
            loading={modelsLoading}
            selected={selected}
            onSelect={selectModel}
            onRefresh={() => void refreshModels()}
            onOpenSettings={() => setSettingsOpen(true)}
          />
          <span className="topbar__title" data-tauri-drag-region>
            {chat.conversation.messages.length > 0 ? chat.conversation.title : ""}
          </span>
        </header>

        <ChatView
          conversation={chat.conversation}
          streaming={chat.isStreaming}
          providers={providers}
          modelsLoading={modelsLoading}
          hasModel={hasModel}
          onSuggestion={(text) => selected && void chat.send(text, selected)}
          onRetry={() => selected && void chat.retry(selected)}
          onOpenSettings={() => setSettingsOpen(true)}
          onRefreshModels={() => void refreshModels()}
        />

        <Composer
          blockedReason={blockedReason}
          streaming={chat.isStreaming}
          focusKey={chat.conversation.id}
          onSend={(text) => selected && void chat.send(text, selected)}
          onStop={chat.stop}
        />
      </main>

      {settingsOpen && settings && (
        <SettingsDialog
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={(next) => {
            setSettings(next);
            setSettingsOpen(false);
            void refreshModels();
          }}
        />
      )}
    </div>
  );
}
