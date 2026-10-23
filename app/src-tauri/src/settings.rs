use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::providers::Provider;

pub const DEFAULT_OLLAMA_URL: &str = "http://127.0.0.1:11434";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelRef {
    pub provider: Provider,
    pub model: String,
}

/// What is persisted to `settings.json`. Empty strings mean "use the default".
///
/// Holds no secrets: the ChatGPT sign-in is kept separately, encrypted.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct StoredSettings {
    pub ollama_base_url: String,
    pub system_prompt: String,
    pub display_name: String,
    pub last_model: Option<ModelRef>,
    /// The first-run introduction has been completed (or skipped).
    pub onboarded: bool,
}

/// The settings as the frontend sees them.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub ollama_base_url: String,
    pub default_ollama_base_url: String,
    pub system_prompt: String,
    pub display_name: String,
    pub last_model: Option<ModelRef>,
    pub onboarded: bool,
}

/// A partial update. `None` leaves a field untouched.
#[derive(Deserialize, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SettingsUpdate {
    pub ollama_base_url: Option<String>,
    pub system_prompt: Option<String>,
    pub display_name: Option<String>,
    pub last_model: Option<ModelRef>,
    pub onboarded: Option<bool>,
}

pub struct SettingsStore {
    path: PathBuf,
    inner: Mutex<StoredSettings>,
}

impl SettingsStore {
    pub fn load(path: PathBuf) -> Self {
        let raw = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
        let stored: StoredSettings = raw
            .as_ref()
            .and_then(|value| serde_json::from_value(value.clone()).ok())
            .unwrap_or_default();
        // Earlier builds kept an OpenAI API key here in plain text. It's no longer used, so
        // don't leave it lying around.
        if raw.is_some_and(|value| value.get("openaiApiKey").is_some()) {
            let _ = serde_json::to_vec_pretty(&stored)
                .map_err(AppError::from)
                .and_then(|bytes| write_private(&path, &bytes));
        }
        Self {
            path,
            inner: Mutex::new(stored),
        }
    }

    pub fn snapshot(&self) -> StoredSettings {
        self.inner.lock().expect("settings lock poisoned").clone()
    }

    pub fn view(&self) -> SettingsView {
        view_of(&self.snapshot(), &EnvVars::from_process())
    }

    pub fn update(&self, update: SettingsUpdate) -> AppResult<SettingsView> {
        // Holding the lock across the write keeps concurrent updates in order on disk, and
        // applying to a copy means a rejected update changes nothing.
        let mut guard = self.inner.lock().expect("settings lock poisoned");
        let mut next = guard.clone();
        apply_update(&mut next, update)?;
        write_private(&self.path, &serde_json::to_vec_pretty(&next)?)?;
        *guard = next;
        Ok(view_of(&guard, &EnvVars::from_process()))
    }

    pub fn ollama_base_url(&self) -> String {
        resolve_ollama_url(&self.snapshot().ollama_base_url, &EnvVars::from_process())
    }
}

/// Environment fallbacks, captured explicitly so resolution is testable.
#[derive(Default)]
struct EnvVars {
    ollama_host: Option<String>,
}

impl EnvVars {
    fn from_process() -> Self {
        Self {
            ollama_host: std::env::var("OLLAMA_HOST")
                .ok()
                .filter(|v| !v.trim().is_empty()),
        }
    }
}

fn apply_update(settings: &mut StoredSettings, update: SettingsUpdate) -> AppResult<()> {
    if let Some(url) = update.ollama_base_url {
        settings.ollama_base_url = validate_url(&url)?;
    }
    if let Some(prompt) = update.system_prompt {
        settings.system_prompt = prompt;
    }
    if let Some(name) = update.display_name {
        settings.display_name = name.trim().to_string();
    }
    if update.last_model.is_some() {
        settings.last_model = update.last_model;
    }
    if let Some(onboarded) = update.onboarded {
        settings.onboarded = onboarded;
    }
    Ok(())
}

/// Accepts an empty string (use the default) or an http(s) URL; strips trailing slashes.
fn validate_url(raw: &str) -> AppResult<String> {
    let url = raw.trim().trim_end_matches('/');
    if url.is_empty() {
        return Ok(String::new());
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(AppError::msg(format!(
            "\"{url}\" is not a valid URL. It should start with http:// or https://"
        )));
    }
    Ok(url.to_string())
}

fn view_of(settings: &StoredSettings, env: &EnvVars) -> SettingsView {
    SettingsView {
        ollama_base_url: settings.ollama_base_url.clone(),
        default_ollama_base_url: resolve_ollama_url("", env),
        system_prompt: settings.system_prompt.clone(),
        display_name: settings.display_name.clone(),
        last_model: settings.last_model.clone(),
        onboarded: settings.onboarded,
    }
}

fn resolve_ollama_url(configured: &str, env: &EnvVars) -> String {
    if !configured.is_empty() {
        return configured.to_string();
    }
    match &env.ollama_host {
        Some(host) => normalize_ollama_host(host),
        None => DEFAULT_OLLAMA_URL.to_string(),
    }
}

/// `OLLAMA_HOST` is often a bare `host:port` or a bind address like `0.0.0.0`.
fn normalize_ollama_host(host: &str) -> String {
    let host = host.trim().trim_end_matches('/');
    let (scheme, rest) = match host.split_once("://") {
        Some((scheme, rest)) => (scheme, rest),
        None => ("http", host),
    };
    let (name, port) = match rest.rsplit_once(':') {
        Some((name, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
            (name, port)
        }
        _ => (rest, "11434"),
    };
    let name = match name {
        "" | "0.0.0.0" => "127.0.0.1",
        "[::]" => "[::1]",
        other => other,
    };
    format!("{scheme}://{name}:{port}")
}

/// Writes a file readable only by the current user (on Unix), via a temp file + rename.
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ollama_host_normalization() {
        assert_eq!(normalize_ollama_host("0.0.0.0"), "http://127.0.0.1:11434");
        assert_eq!(
            normalize_ollama_host("0.0.0.0:8080"),
            "http://127.0.0.1:8080"
        );
        assert_eq!(normalize_ollama_host("myhost:11434"), "http://myhost:11434");
        assert_eq!(
            normalize_ollama_host("https://ollama.example.com:443/"),
            "https://ollama.example.com:443"
        );
        assert_eq!(normalize_ollama_host("box"), "http://box:11434");
    }

    #[test]
    fn configured_url_wins_over_env() {
        let env = EnvVars {
            ollama_host: Some("remote:1234".into()),
        };
        assert_eq!(resolve_ollama_url("", &env), "http://remote:1234");
        assert_eq!(
            resolve_ollama_url("http://localhost:9999", &env),
            "http://localhost:9999"
        );
        assert_eq!(
            resolve_ollama_url("", &EnvVars::default()),
            DEFAULT_OLLAMA_URL
        );
    }

    #[test]
    fn update_validates_urls() {
        let mut settings = StoredSettings::default();
        apply_update(
            &mut settings,
            SettingsUpdate {
                ollama_base_url: Some("http://localhost:11434/".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(settings.ollama_base_url, "http://localhost:11434");

        let err = apply_update(
            &mut settings,
            SettingsUpdate {
                ollama_base_url: Some("localhost:11434".into()),
                ..Default::default()
            },
        );
        assert!(err.is_err());
    }

    #[test]
    fn older_settings_files_still_load() {
        // Earlier builds stored an API key and called ChatGPT models `openai`.
        let stored: StoredSettings = serde_json::from_str(
            r#"{"ollamaBaseUrl":"","openaiApiKey":"sk-old","openaiBaseUrl":"","systemPrompt":"Be rigorous.","lastModel":{"provider":"openai","model":"gpt-5"}}"#,
        )
        .unwrap();
        assert_eq!(stored.system_prompt, "Be rigorous.");
        assert_eq!(stored.last_model.unwrap().provider, Provider::Chatgpt);
        // People upgrading from a build without the introduction see it once.
        assert!(!stored.onboarded);
        let saved = serde_json::to_string(&StoredSettings::default()).unwrap();
        assert!(!saved.contains("openaiApiKey"));
    }

    #[test]
    fn store_round_trips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("settings.json");
        let store = SettingsStore::load(path.clone());
        store
            .update(SettingsUpdate {
                system_prompt: Some("Be rigorous.".into()),
                onboarded: Some(true),
                ..Default::default()
            })
            .unwrap();

        let reloaded = SettingsStore::load(path.clone());
        assert_eq!(reloaded.snapshot().system_prompt, "Be rigorous.");
        assert!(reloaded.view().onboarded);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}
