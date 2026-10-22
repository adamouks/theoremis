mod error;
mod providers;
mod settings;
mod storage;

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::Manager;
use tauri::ipc::Channel;
use tokio_util::sync::CancellationToken;

use error::{AppError, AppResult};
use providers::{ChatMessage, Provider, ProviderStatus, StreamEvent, ollama, openai};
use settings::{SettingsStore, SettingsUpdate, SettingsView};
use storage::{Conversation, ConversationStore, ConversationSummary};

struct AppState {
    settings: SettingsStore,
    conversations: ConversationStore,
    http: reqwest::Client,
    /// Cancellation handles for replies that are still streaming, keyed by request id.
    streams: Mutex<HashMap<String, CancellationToken>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatOutcome {
    cancelled: bool,
}

#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> SettingsView {
    state.settings.view()
}

#[tauri::command]
fn update_settings(
    state: tauri::State<'_, AppState>,
    update: SettingsUpdate,
) -> AppResult<SettingsView> {
    state.settings.update(update)
}

#[tauri::command]
async fn list_models(state: tauri::State<'_, AppState>) -> AppResult<Vec<ProviderStatus>> {
    let ollama_url = state.settings.ollama_base_url();
    let openai_url = state.settings.openai_base_url();
    let openai_key = state.settings.openai_api_key();
    let (ollama, openai) = tokio::join!(
        ollama::list_models(&state.http, &ollama_url),
        openai::list_models(&state.http, &openai_url, openai_key.as_deref()),
    );
    Ok(vec![ollama, openai])
}

#[tauri::command]
async fn chat_stream(
    state: tauri::State<'_, AppState>,
    request_id: String,
    provider: Provider,
    model: String,
    messages: Vec<ChatMessage>,
    on_event: Channel<StreamEvent>,
) -> AppResult<ChatOutcome> {
    let result = run_chat(&state, request_id, provider, model, messages, &on_event).await;
    let _ = on_event.send(StreamEvent::Done);
    result
}

async fn run_chat(
    state: &AppState,
    request_id: String,
    provider: Provider,
    model: String,
    messages: Vec<ChatMessage>,
    on_event: &Channel<StreamEvent>,
) -> AppResult<ChatOutcome> {
    if messages.is_empty() {
        return Err(AppError::msg("Nothing to send."));
    }
    let token = CancellationToken::new();
    state
        .streams
        .lock()
        .expect("streams lock poisoned")
        .insert(request_id.clone(), token.clone());

    let emit = |event: StreamEvent| {
        // The window may have gone away mid-stream; there's no one left to tell.
        let _ = on_event.send(event);
    };
    let run = async {
        match provider {
            Provider::Ollama => {
                let url = state.settings.ollama_base_url();
                ollama::stream_chat(&state.http, &url, &model, &messages, emit).await
            }
            Provider::Openai => {
                let url = state.settings.openai_base_url();
                let key = state.settings.openai_api_key();
                openai::stream_chat(&state.http, &url, key.as_deref(), &model, &messages, emit)
                    .await
            }
        }
    };
    // Dropping the request future closes the connection, which also stops generation server-side.
    let result = tokio::select! {
        result = run => result.map(|()| ChatOutcome { cancelled: false }),
        () = token.cancelled() => Ok(ChatOutcome { cancelled: true }),
    };

    state
        .streams
        .lock()
        .expect("streams lock poisoned")
        .remove(&request_id);
    result
}

#[tauri::command]
fn chat_cancel(state: tauri::State<'_, AppState>, request_id: String) -> bool {
    let token = state
        .streams
        .lock()
        .expect("streams lock poisoned")
        .remove(&request_id);
    token.map(|t| t.cancel()).is_some()
}

#[tauri::command]
async fn list_conversations(
    state: tauri::State<'_, AppState>,
) -> AppResult<Vec<ConversationSummary>> {
    state.conversations.list().await
}

#[tauri::command]
async fn load_conversation(
    state: tauri::State<'_, AppState>,
    id: String,
) -> AppResult<Conversation> {
    state.conversations.load(&id).await
}

#[tauri::command]
async fn save_conversation(
    state: tauri::State<'_, AppState>,
    conversation: Conversation,
) -> AppResult<()> {
    state.conversations.save(&conversation).await
}

#[tauri::command]
async fn delete_conversation(state: tauri::State<'_, AppState>, id: String) -> AppResult<()> {
    state.conversations.delete(&id).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_data_dir()?;
            let http = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .user_agent(concat!("Theoremis/", env!("CARGO_PKG_VERSION")))
                .build()?;
            app.manage(AppState {
                settings: SettingsStore::load(config_dir.join("settings.json")),
                conversations: ConversationStore::new(data_dir.join("conversations")),
                http,
                streams: Mutex::new(HashMap::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            list_models,
            chat_stream,
            chat_cancel,
            list_conversations,
            load_conversation,
            save_conversation,
            delete_conversation,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Theoremis");
}
