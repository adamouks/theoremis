//! Sign in with ChatGPT: the collaborator runs on the person's own ChatGPT plan.
//!
//! The flow is OpenAI's OAuth for local apps (see [`oauth`]). Credentials never reach the
//! webview: the frontend only sees a [`Session`], and every token stays in this process and in
//! the encrypted [`vault`].

mod api;
pub mod oauth;
pub mod vault;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};
use crate::providers::{ChatMessage, Provider, ProviderStatus, StreamEvent, ToolSpec};
use oauth::{AuthServer, Credentials, SHARING_SCOPE, now_ms};
use vault::Vault;

/// The loopback port tried first for the sign-in redirect.
const REDIRECT_PORT: u16 = 8619;
/// How long a browser sign-in may take before it's abandoned.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Refresh this long before the access token expires.
const REFRESH_MARGIN_MS: i64 = 60_000;

/// What is saved, encrypted, between runs.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
struct Connection {
    /// Issued by ChatGPT when this installation first registered; reused for every sign-in.
    client_id: Option<String>,
    subject: Option<String>,
    name: Option<String>,
    email: Option<String>,
    scopes: Vec<String>,
    credentials: Option<Credentials>,
    /// A refresh whose new ID token hasn't been verified yet. The refresh token it replaced is
    /// already spent, so this is kept until verification succeeds.
    pending: Option<PendingRefresh>,
    expired: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct PendingRefresh {
    credentials: Credentials,
    scopes: Vec<String>,
    id_token: String,
    received_at: i64,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    SignedOut,
    SigningIn,
    Connected,
    /// Was signed in, but the session can no longer be renewed.
    Expired,
}

/// The connection as the frontend sees it. Never contains credentials.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub status: SessionStatus,
    pub name: Option<String>,
    pub email: Option<String>,
    /// Whether the account granted plan usage to Theoremis.
    pub sharing: bool,
    /// Something the person should know, e.g. that a sign-out couldn't be confirmed remotely.
    pub notice: Option<String>,
}

struct State {
    loaded: bool,
    connection: Connection,
}

struct Inner {
    http: reqwest::Client,
    auth: AuthServer,
    api_base: String,
    vault: Vault,
    redirect_port: u16,
    /// Loaded lazily, so the keychain is only consulted once ChatGPT is actually used.
    /// Holding the lock also keeps refreshes one at a time.
    state: tokio::sync::Mutex<State>,
    /// The sign-in in progress, if any, tagged so a finished attempt only clears itself.
    sign_in: Mutex<Option<(u64, CancellationToken)>>,
    attempts: AtomicU64,
}

#[derive(Clone)]
pub struct ChatGpt(Arc<Inner>);

impl ChatGpt {
    pub fn new(vault: Vault) -> AppResult<Self> {
        Ok(Self::with_endpoints(
            http_client()?,
            oauth::ISSUER,
            oauth::RESOURCE,
            vault,
            REDIRECT_PORT,
        ))
    }

    fn with_endpoints(
        http: reqwest::Client,
        issuer: &str,
        api_base: &str,
        vault: Vault,
        redirect_port: u16,
    ) -> Self {
        Self(Arc::new(Inner {
            auth: AuthServer::new(http.clone(), issuer),
            http,
            api_base: api_base.to_string(),
            vault,
            redirect_port,
            state: tokio::sync::Mutex::new(State {
                loaded: false,
                connection: Connection::default(),
            }),
            sign_in: Mutex::new(None),
            attempts: AtomicU64::new(0),
        }))
    }

    /// The connection's state. A saved sign-in that can't be read shows as signed out, with
    /// the reason, so signing in again stays possible.
    pub async fn session(&self) -> Session {
        let signing_in = self
            .0
            .sign_in
            .lock()
            .expect("sign-in lock poisoned")
            .is_some();
        match self.lock().await {
            Ok(state) => session_of(&state.connection, signing_in),
            Err(err) => Session {
                notice: Some(err.to_string()),
                ..session_of(&Connection::default(), signing_in)
            },
        }
    }

    /// Runs the browser sign-in. `open` shows the authorization page to the person.
    ///
    /// With `fresh`, the saved registration is set aside so a different account can sign in.
    pub async fn sign_in(
        &self,
        fresh: bool,
        open: impl FnOnce(&str) -> AppResult<()>,
    ) -> AppResult<Session> {
        let cancel = CancellationToken::new();
        let id = self.0.attempts.fetch_add(1, Ordering::Relaxed);
        if let Some((_, previous)) = self
            .0
            .sign_in
            .lock()
            .expect("sign-in lock poisoned")
            .replace((id, cancel.clone()))
        {
            previous.cancel();
        }
        let result = tokio::select! {
            result = self.authorize(fresh, open) => result,
            () = cancel.cancelled() => Err(AppError::msg("Sign-in was cancelled.")),
            () = tokio::time::sleep(SIGN_IN_TIMEOUT) => Err(AppError::msg("Sign-in timed out. Try again.")),
        };
        {
            let mut current = self.0.sign_in.lock().expect("sign-in lock poisoned");
            if current
                .as_ref()
                .is_some_and(|(current_id, _)| *current_id == id)
            {
                *current = None;
            }
        }
        result?;
        Ok(self.session().await)
    }

    pub fn cancel_sign_in(&self) -> bool {
        let token = self.0.sign_in.lock().expect("sign-in lock poisoned").take();
        token.map(|(_, t)| t.cancel()).is_some()
    }

    async fn authorize(
        &self,
        fresh: bool,
        open: impl FnOnce(&str) -> AppResult<()>,
    ) -> AppResult<()> {
        // An unreadable saved sign-in shouldn't block signing in again; it gets replaced.
        let previous = match self.lock().await {
            Ok(state) if !fresh => state.connection.clone(),
            _ => Connection::default(),
        };
        let auth = &self.0.auth;
        let discovery = auth.discovery().await?;
        let loopback = oauth::Loopback::bind(self.0.redirect_port).await?;
        let redirect_uri = loopback.redirect_uri();
        let attempt = oauth::Attempt::new()?;
        let url = auth.authorization_url(
            &discovery,
            &attempt,
            &redirect_uri,
            previous.client_id.as_deref(),
            previous.email.as_deref(),
        )?;
        open(&url)?;
        let callback = loopback
            .wait(&attempt.state, previous.client_id.as_deref())
            .await?;
        drop(loopback);

        // Keep the issued registration before spending the one-time code, so a failed exchange
        // doesn't register Theoremis a second time on the next attempt.
        if previous.client_id.as_deref() != Some(callback.client_id.as_str()) {
            let mut registered = previous.clone();
            registered.client_id = Some(callback.client_id.clone());
            self.replace(registered).await?;
        }
        let tokens = auth
            .exchange_code(
                &callback.client_id,
                &callback.code,
                &attempt.verifier,
                &redirect_uri,
            )
            .await?;
        let id_token = tokens.id_token.ok_or_else(oauth::invalid_identity)?;
        let identity = auth
            .verify_id_token(
                &id_token,
                &callback.client_id,
                Some(&attempt.nonce),
                now_ms(),
            )
            .await?;
        if previous
            .subject
            .as_deref()
            .is_some_and(|subject| subject != identity.subject)
        {
            return Err(AppError::msg(
                "That's a different ChatGPT account from the one Theoremis was connected to. \
                 Choose “Use a different account” to switch.",
            ));
        }
        self.replace(Connection {
            client_id: Some(callback.client_id),
            subject: Some(identity.subject),
            name: identity.name,
            email: identity.email,
            scopes: tokens.scopes,
            credentials: tokens.credentials,
            pending: None,
            expired: false,
        })
        .await
    }

    /// Forgets the tokens and revokes them with ChatGPT. The registration and account name
    /// are kept so signing back in is one click.
    pub async fn sign_out(&self) -> AppResult<Session> {
        let (client_id, refresh_token) = {
            let mut state = self.lock().await?;
            let connection = &mut state.connection;
            let refresh_token = connection
                .pending
                .take()
                .and_then(|p| p.credentials.refresh_token)
                .or_else(|| connection.credentials.take().and_then(|c| c.refresh_token));
            connection.credentials = None;
            connection.expired = false;
            let saved = connection.clone();
            self.persist(saved).await?;
            (connection.client_id.clone(), refresh_token)
        };
        let mut session = self.session().await;
        if let (Some(client_id), Some(token)) = (client_id, refresh_token)
            && self.0.auth.revoke(&client_id, &token).await.is_err()
        {
            session.notice = Some(
                "Signed out here, but ChatGPT didn't confirm it. You can also remove Theoremis \
                 from the connected apps in your ChatGPT settings."
                    .into(),
            );
        }
        Ok(session)
    }

    /// The models this account can use, or why there are none.
    pub async fn provider_status(&self) -> ProviderStatus {
        let unavailable = |message: String| ProviderStatus {
            provider: Provider::Chatgpt,
            available: false,
            models: Vec::new(),
            message: Some(message),
        };
        let token = match self.access_token().await {
            Ok(token) => token,
            Err(err) => return unavailable(err.to_string()),
        };
        match api::list_models(&self.0.http, &self.0.api_base, &token).await {
            Ok(models) => ProviderStatus {
                provider: Provider::Chatgpt,
                available: true,
                message: models
                    .is_empty()
                    .then(|| "Your ChatGPT plan has no models available to apps.".into()),
                models,
            },
            Err(err) => unavailable(err.to_string()),
        }
    }

    pub async fn stream_chat(
        &self,
        model: &str,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
        emit: impl FnMut(StreamEvent),
    ) -> AppResult<()> {
        let token = self.access_token().await?;
        api::stream_chat(
            &self.0.http,
            &self.0.api_base,
            &token,
            model,
            messages,
            tools,
            emit,
        )
        .await
    }

    /// A valid access token, refreshed first if it's about to expire.
    async fn access_token(&self) -> AppResult<String> {
        // Refreshing spends the old refresh token, so the refresh runs in its own task: a reply
        // that is cancelled meanwhile can't abandon it before the new tokens are saved.
        let this = self.clone();
        tokio::spawn(async move { this.fresh_token().await })
            .await
            .map_err(|_| AppError::msg("Renewing the ChatGPT sign-in failed unexpectedly."))?
    }

    async fn fresh_token(&self) -> AppResult<String> {
        let mut state = self.lock().await?;
        let connection = &mut state.connection;
        if connection.expired {
            return Err(AppError::msg(
                "Your ChatGPT session has expired. Sign in again in Settings.",
            ));
        }
        let Some(credentials) = connection.credentials.clone() else {
            return Err(AppError::msg(
                "Sign in with ChatGPT in Settings to use your plan.",
            ));
        };
        if !connection.scopes.iter().any(|s| s == SHARING_SCOPE) {
            return Err(AppError::msg(
                "You're signed in, but plan usage wasn't granted to Theoremis. Sign out and sign in again to allow it.",
            ));
        }
        let now = now_ms();
        if connection.pending.is_some() || credentials.expires_at <= now + REFRESH_MARGIN_MS {
            let may_refresh = credentials.earliest_refresh_at.is_none_or(|at| at <= now);
            if connection.pending.is_some() || may_refresh {
                if let Err(err) = self.refresh(connection).await {
                    if needs_new_sign_in(&err) {
                        connection.credentials = None;
                        connection.pending = None;
                        connection.expired = true;
                        let saved = connection.clone();
                        self.persist(saved).await?;
                    }
                    return Err(err);
                }
            } else if credentials.expires_at <= now {
                return Err(AppError::msg(
                    "Your ChatGPT sign-in can't be renewed just yet. Try again in a moment.",
                ));
            }
        }
        connection
            .credentials
            .as_ref()
            .map(|c| c.access_token.clone())
            .ok_or_else(|| AppError::msg("Sign in with ChatGPT in Settings to use your plan."))
    }

    async fn refresh(&self, connection: &mut Connection) -> AppResult<()> {
        let client_id = connection
            .client_id
            .clone()
            .ok_or_else(|| AppError::msg("Sign in with ChatGPT in Settings to use your plan."))?;
        let pending = match connection.pending.clone() {
            // A refresh already went through; only its identity check is left.
            Some(pending) => pending,
            None => {
                let refresh_token = connection
                    .credentials
                    .as_ref()
                    .and_then(|c| c.refresh_token.clone())
                    .ok_or_else(|| expired("invalid_grant"))?;
                let tokens = self
                    .0
                    .auth
                    .refresh(&client_id, &refresh_token, &connection.scopes.join(" "))
                    .await?;
                let credentials = tokens
                    .credentials
                    .ok_or_else(|| expired("invalid_token_response"))?;
                let Some(id_token) = tokens.id_token else {
                    connection.credentials = Some(credentials);
                    connection.scopes = tokens.scopes;
                    return self.persist(connection.clone()).await;
                };
                let pending = PendingRefresh {
                    credentials,
                    scopes: tokens.scopes,
                    id_token,
                    received_at: now_ms(),
                };
                // Save before verifying: if the keys can't be fetched now, this is all we have.
                connection.pending = Some(pending.clone());
                self.persist(connection.clone()).await?;
                pending
            }
        };
        let identity = self
            .0
            .auth
            .verify_id_token(&pending.id_token, &client_id, None, pending.received_at)
            .await?;
        if connection.subject.as_deref() != Some(identity.subject.as_str()) {
            return Err(AppError::Auth {
                code: "account_mismatch".into(),
                message: "ChatGPT renewed the sign-in for a different account. Sign in again."
                    .into(),
            });
        }
        connection.credentials = Some(pending.credentials);
        connection.scopes = pending.scopes;
        connection.pending = None;
        connection.name = identity.name.or(connection.name.take());
        connection.email = identity.email.or(connection.email.take());
        self.persist(connection.clone()).await
    }

    async fn lock(&self) -> AppResult<tokio::sync::MutexGuard<'_, State>> {
        let mut state = self.0.state.lock().await;
        if !state.loaded {
            let inner = self.0.clone();
            let stored = tokio::task::spawn_blocking(move || inner.vault.read::<Connection>())
                .await
                .map_err(|_| AppError::msg("Reading the ChatGPT sign-in failed unexpectedly."))??;
            state.connection = stored.unwrap_or_default();
            state.loaded = true;
        }
        Ok(state)
    }

    /// Saves and adopts a whole new connection.
    async fn replace(&self, connection: Connection) -> AppResult<()> {
        self.persist(connection.clone()).await?;
        let mut state = self.0.state.lock().await;
        state.connection = connection;
        state.loaded = true;
        Ok(())
    }

    async fn persist(&self, connection: Connection) -> AppResult<()> {
        let inner = self.0.clone();
        tokio::task::spawn_blocking(move || inner.vault.write(&connection))
            .await
            .map_err(|_| AppError::msg("Saving the ChatGPT sign-in failed unexpectedly."))?
    }
}

fn session_of(connection: &Connection, signing_in: bool) -> Session {
    let connected = connection.credentials.is_some();
    let status = if signing_in {
        SessionStatus::SigningIn
    } else if connected {
        SessionStatus::Connected
    } else if connection.expired {
        SessionStatus::Expired
    } else {
        SessionStatus::SignedOut
    };
    Session {
        status,
        name: connection.name.clone(),
        email: connection.email.clone(),
        sharing: connected && connection.scopes.iter().any(|s| s == SHARING_SCOPE),
        notice: None,
    }
}

fn http_client() -> AppResult<reqwest::Client> {
    // Never follow redirects: one could carry a token or a document to another origin.
    Ok(reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("Theoremis/", env!("CARGO_PKG_VERSION")))
        .build()?)
}

fn expired(code: &str) -> AppError {
    AppError::Auth {
        code: code.into(),
        message: "Your ChatGPT session has expired. Sign in again in Settings.".into(),
    }
}

/// Errors after which the saved session can't be used again.
fn needs_new_sign_in(err: &AppError) -> bool {
    matches!(err, AppError::Auth { code, .. } if matches!(code.as_str(),
        "invalid_grant" | "invalid_refresh_token" | "token_expired" | "refresh_token_expired"
        | "refresh_token_invalidated" | "refresh_token_reused" | "invalid_id_token"
        | "invalid_token_response" | "account_mismatch"))
}

/// Turns an error from ChatGPT's auth server or API into a readable message.
///
/// Server messages can echo submitted text, so only the machine-readable code is used.
pub(crate) fn service_error(body: &Value, status: Option<u16>) -> AppError {
    let mut detail = body;
    for _ in 0..4 {
        match (detail.get("error"), detail.get("detail")) {
            (Some(inner @ Value::Object(_)), _) | (_, Some(inner @ Value::Object(_))) => {
                detail = inner;
            }
            _ => break,
        }
    }
    let code = detail
        .get("error")
        .and_then(Value::as_str)
        .or_else(|| detail.get("code").and_then(Value::as_str))
        .filter(|c| {
            c.len() <= 100
                && c.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
        })
        // Older deployments version the sharing codes; they mean the same thing.
        .map(|c| c.replace("subscription_sharing_v2_", "subscription_sharing_"));
    let message = match code.as_deref() {
        Some("subscription_sharing_user_not_eligible") => {
            "This ChatGPT account or workspace can't share its plan with apps."
        }
        Some("subscription_sharing_usage_limit_exceeded") => {
            "You've reached a ChatGPT usage limit. Check your usage in ChatGPT's settings."
        }
        Some("subscription_sharing_usage_unavailable") => {
            "ChatGPT couldn't check your usage right now. Try again shortly."
        }
        Some(
            "subscription_sharing_unsupported_capability"
            | "subscription_sharing_route_not_supported",
        ) => "ChatGPT plan usage doesn't support this kind of request.",
        Some(
            "subscription_sharing_invalid_user"
            | "chatpass_v2_scope_not_authorized"
            | "chatpass_v2_invalid_authorization_context",
        ) => "ChatGPT couldn't confirm your plan for this connection. Sign out and sign in again.",
        Some("subscription_sharing_user_unavailable") => {
            "Your ChatGPT account is temporarily unavailable. Try again shortly."
        }
        Some("subscription_sharing_client_not_enabled") => {
            "ChatGPT hasn't enabled plan usage for Theoremis yet."
        }
        Some("invalid_client") => {
            "ChatGPT rejected Theoremis's registration. Choose “Use a different account” to register again."
        }
        Some(
            "invalid_grant"
            | "invalid_refresh_token"
            | "token_expired"
            | "refresh_token_expired"
            | "refresh_token_invalidated"
            | "refresh_token_reused",
        ) => "Your ChatGPT session has expired. Sign in again in Settings.",
        Some("invalid_token" | "invalid_api_key") => {
            "ChatGPT didn't accept this sign-in. Sign out and sign in again."
        }
        Some("access_denied") => "Sign-in wasn't completed.",
        Some("model_not_found") => {
            "This model isn't available with your ChatGPT plan. Choose another one."
        }
        _ => match status {
            Some(401) => "ChatGPT didn't accept this sign-in. Sign out and sign in again.",
            Some(403) => {
                "ChatGPT refused this request because of a policy or regional restriction."
            }
            Some(429) => "Too many requests. Wait a moment and try again.",
            Some(400 | 422) => "ChatGPT rejected this request.",
            Some(500..) => "ChatGPT is temporarily unavailable. Try again shortly.",
            _ => "ChatGPT couldn't complete this request.",
        },
    };
    let known = !message.starts_with("ChatGPT couldn't complete")
        && !message.starts_with("ChatGPT rejected this");
    let message = match (&code, known) {
        (Some(code), false) => format!("{} ({code})", message.trim_end_matches('.')),
        _ => message.to_string(),
    };
    match code {
        Some(code) => AppError::Auth { code, message },
        None => AppError::Message(message),
    }
}

#[cfg(test)]
mod tests;
