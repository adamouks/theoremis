mod chatgpt;
mod error;
mod lean;
mod providers;
mod references;
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
use lean::check::CheckResult;
use lean::{Lean, LeanStatus, SetupEvent};
use providers::{ChatMessage, Provider, ProviderStatus, StreamEvent, ToolSpec, ollama};
use settings::{SettingsStore, SettingsUpdate, SettingsView};
use storage::{DocumentSummary, Project, Workspace, WorkspaceStore};

struct AppState {
    settings: SettingsStore,
    workspace: WorkspaceStore,
    chatgpt: ChatGpt,
    lean: Lean,
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

// A Tauri command takes each argument by name from the frontend's payload.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn chat_stream(
    state: tauri::State<'_, AppState>,
    request_id: String,
    provider: Provider,
    model: String,
    messages: Vec<ChatMessage>,
    tools: Option<Vec<ToolSpec>>,
    effort: Option<String>,
    on_event: Channel<StreamEvent>,
) -> AppResult<ChatOutcome> {
    let tools = tools.unwrap_or_default();
    let target = Target {
        provider,
        model,
        effort,
    };
    let result = run_chat(&state, request_id, target, messages, &tools, &on_event).await;
    let _ = on_event.send(StreamEvent::Done);
    result
}

/// The model a reply comes from, and how hard it is asked to think.
struct Target {
    provider: Provider,
    model: String,
    effort: Option<String>,
}

async fn run_chat(
    state: &AppState,
    request_id: String,
    target: Target,
    messages: Vec<ChatMessage>,
    tools: &[ToolSpec],
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
    let Target {
        provider,
        model,
        effort,
    } = target;
    let effort = effort.as_deref();
    let run = async {
        match provider {
            Provider::Ollama => {
                let url = state.settings.ollama_base_url();
                ollama::stream_chat(&state.http, &url, &model, effort, &messages, tools, emit).await
            }
            Provider::Chatgpt => {
                state
                    .chatgpt
                    .stream_chat(&model, effort, &messages, tools, emit)
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
fn lean_status(state: tauri::State<'_, AppState>) -> LeanStatus {
    state.lean.status()
}

/// Installs Lean and downloads Mathlib, reporting progress as it goes.
#[tauri::command]
async fn lean_setup(
    state: tauri::State<'_, AppState>,
    on_event: Channel<SetupEvent>,
) -> AppResult<LeanStatus> {
    state
        .lean
        .set_up(|event| {
            let _ = on_event.send(event);
        })
        .await
}

#[tauri::command]
fn lean_cancel_setup(state: tauri::State<'_, AppState>) -> bool {
    state.lean.cancel_setup()
}

#[tauri::command]
async fn lean_check(state: tauri::State<'_, AppState>, code: String) -> AppResult<CheckResult> {
    state.lean.check(&code).await
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

/// Saves a file of a document's media. The bytes travel as the raw request body, with the
/// document id and file name in the `x-document` and `x-name` headers.
#[tauri::command]
async fn save_asset(
    state: tauri::State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> AppResult<String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::msg("Expected the file's bytes."));
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .ok_or_else(|| AppError::msg(format!("Missing {name}")))
    };
    let (document, name) = (header("x-document")?, header("x-name")?);
    let bytes = bytes.clone();
    state.workspace.save_asset(&document, &name, &bytes).await?;
    Ok(name)
}

#[tauri::command]
async fn delete_asset(
    state: tauri::State<'_, AppState>,
    document: String,
    name: String,
) -> AppResult<()> {
    state.workspace.delete_asset(&document, &name).await
}

/// Asks where to save a file Theoremis made, such as an export, suggesting its name, and writes it
/// there. The bytes travel as the raw body, the suggested name and the kind of file (for the
/// dialog's filter) in the `x-name` and `x-kind` headers. Returns where it went, or nothing if
/// the person cancelled. Only the person picks the path, so the interface can't write elsewhere.
#[tauri::command]
async fn save_file(
    app: tauri::AppHandle,
    window: tauri::Window,
    request: tauri::ipc::Request<'_>,
) -> AppResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::msg("Expected the file's bytes."));
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .ok_or_else(|| AppError::msg(format!("Missing {name}")))
    };
    let (name, kind) = (header("x-name")?, header("x-kind")?);
    let extension = name.rsplit_once('.').map(|(_, e)| e.to_string());
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_parent(&window).set_file_name(&name);
    if let Some(extension) = &extension {
        dialog = dialog.add_filter(&kind, &[extension.as_str()]);
    }
    dialog.save_file(move |path| {
        let _ = tx.send(path);
    });
    let Some(path) = rx.await.ok().flatten() else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .map_err(|_| AppError::msg("Theoremis can't save to that location."))?;
    tokio::fs::write(&path, bytes).await?;
    Ok(Some(path.display().to_string()))
}

/// BibTeX for an arXiv id or a DOI, looked up on arXiv or doi.org.
#[tauri::command]
async fn lookup_reference(state: tauri::State<'_, AppState>, text: String) -> AppResult<String> {
    references::lookup(&state.http, &text).await
}

/// Opens the system's print dialog for the page, which can also save it as a PDF.
#[tauri::command]
fn print_page(webview: tauri::Webview) -> AppResult<()> {
    Ok(webview.print()?)
}

/// Serves `theoremis://localhost/<document id>/<file>` (on Windows,
/// `http://theoremis.localhost/…`) from the document's media, so figures load like any image.
async fn serve_asset(app: tauri::AppHandle, path: String) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{Response, StatusCode, header};
    let respond = |status: StatusCode, mime: &str, body: Vec<u8>| {
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::CACHE_CONTROL, "no-cache")
            // SVGs are shown as images here, never as documents that run scripts.
            .header(
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
            )
            .body(body)
            .expect("a valid response")
    };
    let decoded = percent_decode(path.trim_start_matches('/'));
    let Some((document, name)) = decoded.split_once('/') else {
        return respond(StatusCode::NOT_FOUND, "text/plain", Vec::new());
    };
    let state = app.state::<AppState>();
    match state.workspace.read_asset(document, name).await {
        Ok((bytes, mime)) => respond(StatusCode::OK, mime, bytes),
        Err(_) => respond(StatusCode::NOT_FOUND, "text/plain", Vec::new()),
    }
}

/// Decodes `%XX` escapes: the frontend encodes the whole path as one URL component.
fn percent_decode(text: &str) -> String {
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2]))
        {
            out.push(hi << 4 | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .register_asynchronous_uri_scheme_protocol("theoremis", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_string();
            tauri::async_runtime::spawn(async move {
                responder.respond(serve_asset(app, path).await);
            });
        })
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
                lean: Lean::new(data_dir.join("lean"), app.path().home_dir()?, http.clone()),
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
            lean_status,
            lean_setup,
            lean_cancel_setup,
            lean_check,
            chat_stream,
            chat_cancel,
            load_workspace,
            save_projects,
            load_document,
            save_document,
            delete_document,
            save_asset,
            delete_asset,
            save_file,
            print_page,
            lookup_reference,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Theoremis");
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    #[test]
    fn decodes_asset_paths() {
        assert_eq!(percent_decode("d1%2Ffig-1.png"), "d1/fig-1.png");
        assert_eq!(percent_decode("d1/fig.png"), "d1/fig.png");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz%2f"), "%zz/");
    }
}
