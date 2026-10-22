mod chatgpt;
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

use chatgpt::{ChatGpt, Session};
use error::{AppError, AppResult};
use providers::{ChatMessage, Provider, ProviderStatus, StreamEvent, ollama};
use settings::{SettingsStore, SettingsUpdate, SettingsView};
use storage::{DocumentSummary, Project, Workspace, WorkspaceStore};

struct AppState {
    settings: SettingsStore,
    workspace: WorkspaceStore,
    chatgpt: ChatGpt,
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
    let (ollama, chatgpt) = tokio::join!(
        ollama::list_models(&state.http, &ollama_url),
        state.chatgpt.provider_status(),
    );
    Ok(vec![ollama, chatgpt])
}

#[tauri::command]
async fn chatgpt_session(state: tauri::State<'_, AppState>) -> Result<Session, ()> {
    Ok(state.chatgpt.session().await)
}

/// Opens ChatGPT's sign-in page in the browser and waits for the person to finish there.
#[tauri::command]
async fn chatgpt_sign_in(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    fresh: bool,
) -> AppResult<Session> {
    use tauri_plugin_opener::OpenerExt;
    state
        .chatgpt
        .sign_in(fresh, |url| {
            app.opener().open_url(url, None::<&str>).map_err(|err| {
                AppError::msg(format!("Couldn't open your browser to sign in: {err}"))
            })
        })
        .await
}

#[tauri::command]
fn chatgpt_cancel_sign_in(state: tauri::State<'_, AppState>) -> bool {
    state.chatgpt.cancel_sign_in()
}

#[tauri::command]
async fn chatgpt_sign_out(state: tauri::State<'_, AppState>) -> AppResult<Session> {
    state.chatgpt.sign_out().await
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
            Provider::Chatgpt => state.chatgpt.stream_chat(&model, &messages, emit).await,
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
async fn load_workspace(state: tauri::State<'_, AppState>) -> AppResult<Workspace> {
    state.workspace.load().await
}

#[tauri::command]
async fn save_projects(state: tauri::State<'_, AppState>, projects: Vec<Project>) -> AppResult<()> {
    state.workspace.save_projects(&projects).await
}

#[tauri::command]
async fn load_document(
    state: tauri::State<'_, AppState>,
    id: String,
) -> AppResult<serde_json::Value> {
    state.workspace.load_document(&id).await
}

#[tauri::command]
async fn save_document(
    state: tauri::State<'_, AppState>,
    document: serde_json::Value,
) -> AppResult<DocumentSummary> {
    state.workspace.save_document(&document).await
}

#[tauri::command]
async fn delete_document(state: tauri::State<'_, AppState>, id: String) -> AppResult<()> {
    state.workspace.delete_document(&id).await
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
            let vault = chatgpt::vault::Vault::new(
                config_dir.join("chatgpt.json"),
                Box::new(chatgpt::vault::OsKeyStore),
            );
            app.manage(AppState {
                settings: SettingsStore::load(config_dir.join("settings.json")),
                workspace: WorkspaceStore::new(data_dir.join("workspace")),
                chatgpt: ChatGpt::new(vault)?,
                http,
                streams: Mutex::new(HashMap::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            list_models,
            chatgpt_session,
            chatgpt_sign_in,
            chatgpt_cancel_sign_in,
            chatgpt_sign_out,
            chat_stream,
            chat_cancel,
            load_workspace,
            save_projects,
            load_document,
            save_document,
            delete_document,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Theoremis");
}
