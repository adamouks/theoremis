use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::providers::Provider;

pub const DEFAULT_OLLAMA_URL: &str = "http://127.0.0.1:11434";
pub const DEFAULT_OPENAI_URL: &str = "https://api.openai.com/v1";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelRef {
    pub provider: Provider,
    pub model: String,
}

/// What is persisted to `settings.json`. Empty strings mean "use the default".
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct StoredSettings {
    pub ollama_base_url: String,
    pub openai_base_url: String,
    pub openai_api_key: Option<String>,
    pub system_prompt: String,
    pub last_model: Option<ModelRef>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum KeySource {
    Settings,
    Env,
    None,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub source: KeySource,
    /// A masked form of the key, e.g. `sk-…a1b2`. Never the full key.
    pub hint: Option<String>,
}

/// The settings as the frontend sees them. The API key itself never leaves the backend.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub ollama_base_url: String,
    pub openai_base_url: String,
    pub default_ollama_base_url: String,
    pub default_openai_base_url: String,
    pub openai_key: KeyStatus,
    pub system_prompt: String,
    pub last_model: Option<ModelRef>,
}

/// A partial update. `None` leaves a field untouched; for the API key, `Some("")` clears it.
#[derive(Deserialize, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SettingsUpdate {
    pub ollama_base_url: Option<String>,
    pub openai_base_url: Option<String>,
    pub openai_api_key: Option<String>,
    pub system_prompt: Option<String>,
    pub last_model: Option<ModelRef>,
}

pub struct SettingsStore {
    path: PathBuf,
    inner: Mutex<StoredSettings>,
}

impl SettingsStore {
    pub fn load(path: PathBuf) -> Self {
        let stored = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
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

    pub fn openai_base_url(&self) -> String {
        resolve_openai_url(&self.snapshot().openai_base_url, &EnvVars::from_process())
    }

    pub fn openai_api_key(&self) -> Option<String> {
        resolve_openai_key(&self.snapshot(), &EnvVars::from_process()).map(|(key, _)| key)
    }
}

/// Environment fallbacks, captured explicitly so resolution is testable.
#[derive(Default)]
struct EnvVars {
    ollama_host: Option<String>,
    openai_base_url: Option<String>,
    openai_api_key: Option<String>,
}

impl EnvVars {
    fn from_process() -> Self {
        let get = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        Self {
            ollama_host: get("OLLAMA_HOST"),
            openai_base_url: get("OPENAI_BASE_URL"),
            openai_api_key: get("OPENAI_API_KEY"),
        }
    }
}

fn apply_update(settings: &mut StoredSettings, update: SettingsUpdate) -> AppResult<()> {
    if let Some(url) = update.ollama_base_url {
        settings.ollama_base_url = validate_url(&url)?;
    }
    if let Some(url) = update.openai_base_url {
        settings.openai_base_url = validate_url(&url)?;
    }
    if let Some(key) = update.openai_api_key {
        let key = key.trim();
        settings.openai_api_key = (!key.is_empty()).then(|| key.to_string());
    }
    if let Some(prompt) = update.system_prompt {
        settings.system_prompt = prompt;
    }
    if update.last_model.is_some() {
        settings.last_model = update.last_model;
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
    let key = resolve_openai_key(settings, env);
    SettingsView {
        ollama_base_url: settings.ollama_base_url.clone(),
        openai_base_url: settings.openai_base_url.clone(),
        default_ollama_base_url: resolve_ollama_url("", env),
        default_openai_base_url: resolve_openai_url("", env),
        openai_key: KeyStatus {
            source: key.as_ref().map_or(KeySource::None, |(_, source)| *source),
            hint: key.map(|(key, _)| mask_key(&key)),
        },
        system_prompt: settings.system_prompt.clone(),
        last_model: settings.last_model.clone(),
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

fn resolve_openai_url(configured: &str, env: &EnvVars) -> String {
    if !configured.is_empty() {
        return configured.to_string();
    }
    env.openai_base_url
        .as_deref()
        .map(|url| url.trim().trim_end_matches('/').to_string())
        .unwrap_or_else(|| DEFAULT_OPENAI_URL.to_string())
}

fn resolve_openai_key(settings: &StoredSettings, env: &EnvVars) -> Option<(String, KeySource)> {
    if let Some(key) = settings.openai_api_key.as_ref().filter(|k| !k.is_empty()) {
        return Some((key.clone(), KeySource::Settings));
    }
    env.openai_api_key
        .as_ref()
        .map(|key| (key.trim().to_string(), KeySource::Env))
}

fn mask_key(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() <= 8 {
        return "••••".to_string();
    }
    let prefix: String = if key.starts_with("sk-") {
        "sk-".to_string()
    } else {
        String::new()
    };
    let suffix: String = chars[chars.len() - 4..].iter().collect();
    format!("{prefix}…{suffix}")
}

/// Writes a file readable only by the current user (on Unix), via a temp file + rename.
fn write_private(path: &Path, bytes: &[u8]) -> AppResult<()> {
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
            ..Default::default()
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
    fn key_resolution_and_masking() {
        let env = EnvVars {
            openai_api_key: Some("sk-envkey-123456789".into()),
            ..Default::default()
        };
        let mut settings = StoredSettings::default();
        let view = view_of(&settings, &env);
        assert_eq!(view.openai_key.source, KeySource::Env);
        assert_eq!(view.openai_key.hint.as_deref(), Some("sk-…6789"));

        settings.openai_api_key = Some("sk-proj-abcdefghijkl".into());
        let view = view_of(&settings, &env);
        assert_eq!(view.openai_key.source, KeySource::Settings);
        assert_eq!(view.openai_key.hint.as_deref(), Some("sk-…ijkl"));

        let view = view_of(&StoredSettings::default(), &EnvVars::default());
        assert_eq!(view.openai_key.source, KeySource::None);
        assert!(view.openai_key.hint.is_none());
    }

    #[test]
    fn view_never_contains_full_key() {
        let settings = StoredSettings {
            openai_api_key: Some("sk-secret-value-do-not-leak".into()),
            ..Default::default()
        };
        let json = serde_json::to_string(&view_of(&settings, &EnvVars::default())).unwrap();
        assert!(!json.contains("secret-value"));
    }

    #[test]
    fn update_clears_key_and_validates_urls() {
        let mut settings = StoredSettings {
            openai_api_key: Some("sk-old".into()),
            ..Default::default()
        };
        apply_update(
            &mut settings,
            SettingsUpdate {
                openai_api_key: Some("   ".into()),
                ollama_base_url: Some("http://localhost:11434/".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(settings.openai_api_key.is_none());
        assert_eq!(settings.ollama_base_url, "http://localhost:11434");

        let err = apply_update(
            &mut settings,
            SettingsUpdate {
                openai_base_url: Some("api.openai.com".into()),
                ..Default::default()
            },
        );
        assert!(err.is_err());
    }

    #[test]
    fn store_round_trips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("settings.json");
        let store = SettingsStore::load(path.clone());
        store
            .update(SettingsUpdate {
                system_prompt: Some("Be rigorous.".into()),
                openai_api_key: Some("sk-test-1234567890".into()),
                ..Default::default()
            })
            .unwrap();

        let reloaded = SettingsStore::load(path.clone());
        assert_eq!(reloaded.snapshot().system_prompt, "Be rigorous.");
        assert_eq!(
            reloaded.snapshot().openai_api_key.as_deref(),
            Some("sk-test-1234567890")
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}
