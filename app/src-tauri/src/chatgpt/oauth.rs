//! OAuth 2.0 and OpenID Connect against ChatGPT's authorization server.
//!
//! Sign-in is an authorization-code flow with PKCE, a nonce and a loopback redirect to
//! `127.0.0.1`. The first sign-in registers this installation dynamically: the request carries
//! the placeholder client id and an app name, and the callback returns the client id that
//! ChatGPT issued, which is reused from then on.

use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::service_error;
use super::vault::fill_random;
use crate::error::{AppError, AppResult};

pub const ISSUER: &str = "https://auth.openai.com";
/// The API the tokens are issued for.
pub const RESOURCE: &str = "https://api.openai.com/v1";
/// The scope that lets requests draw on the account's ChatGPT plan.
pub const SHARING_SCOPE: &str = "chatgpt.tokens.use.direct";
const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const APP_NAME: &str = "Theoremis";
/// Sent as the client id until ChatGPT registers this installation and issues a real one.
const DYNAMIC_CLIENT: &str = "dynamic_agent_client";
const CALLBACK_PATH: &str = "/auth/callback";
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
/// Allowance for clock differences when checking token lifetimes.
const SKEW_MS: i64 = 5_000;

#[derive(Deserialize, Clone, Debug)]
pub struct Discovery {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    #[serde(default)]
    pub revocation_endpoint: Option<String>,
    pub jwks_uri: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Milliseconds since the Unix epoch.
    pub expires_at: i64,
    /// The server may ask clients not to refresh before this time (milliseconds since the epoch).
    #[serde(default)]
    pub earliest_refresh_at: Option<i64>,
}

#[derive(Debug)]
pub struct Tokens {
    pub scopes: Vec<String>,
    pub credentials: Option<Credentials>,
    pub id_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub subject: String,
    pub name: Option<String>,
    pub email: Option<String>,
}

/// One authorization attempt's secrets.
pub struct Attempt {
    pub state: String,
    pub nonce: String,
    pub verifier: String,
}

impl Attempt {
    pub fn new() -> AppResult<Self> {
        Ok(Self {
            state: random_value()?,
            nonce: random_value()?,
            verifier: random_value()?,
        })
    }

    fn challenge(&self) -> String {
        URL_SAFE_NO_PAD.encode(Sha256::digest(self.verifier.as_bytes()))
    }
}

fn random_value() -> AppResult<String> {
    let mut bytes = [0u8; 32];
    fill_random(&mut bytes)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub struct AuthServer {
    http: reqwest::Client,
    issuer: String,
    discovery: tokio::sync::Mutex<Option<Discovery>>,
    keys: tokio::sync::Mutex<Option<JwkSet>>,
}

impl AuthServer {
    pub fn new(http: reqwest::Client, issuer: impl Into<String>) -> Self {
        Self {
            http,
            issuer: issuer.into(),
            discovery: tokio::sync::Mutex::new(None),
            keys: tokio::sync::Mutex::new(None),
        }
    }

    /// The server's OpenID configuration, fetched once and checked to stay on the issuer's origin.
    pub async fn discovery(&self) -> AppResult<Discovery> {
        let mut cached = self.discovery.lock().await;
        if let Some(discovery) = cached.as_ref() {
            return Ok(discovery.clone());
        }
        let unverified =
            || AppError::msg("ChatGPT's sign-in configuration couldn't be verified. Try again.");
        let response = self
            .http
            .get(format!("{}/.well-known/openid-configuration", self.issuer))
            .timeout(HTTP_TIMEOUT)
            .send()
            .await
            .map_err(network_error)?;
        if !response.status().is_success() {
            return Err(unverified());
        }
        let discovery: Discovery = response.json().await.map_err(|_| unverified())?;
        let origin = Url::parse(&self.issuer).map_err(|_| unverified())?.origin();
        let same_origin = |url: &str| Url::parse(url).is_ok_and(|url| url.origin() == origin);
        if discovery.issuer != self.issuer
            || !same_origin(&discovery.authorization_endpoint)
            || !same_origin(&discovery.token_endpoint)
            || !same_origin(&discovery.jwks_uri)
            || discovery
                .revocation_endpoint
                .as_deref()
                .is_some_and(|url| !same_origin(url))
        {
            return Err(unverified());
        }
        *cached = Some(discovery.clone());
        Ok(discovery)
    }

    pub fn authorization_url(
        &self,
        discovery: &Discovery,
        attempt: &Attempt,
        redirect_uri: &str,
        client_id: Option<&str>,
        login_hint: Option<&str>,
    ) -> AppResult<String> {
        let mut url = Url::parse(&discovery.authorization_endpoint)
            .map_err(|_| AppError::msg("ChatGPT's sign-in address is invalid."))?;
        {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("client_id", client_id.unwrap_or(DYNAMIC_CLIENT))
                .append_pair("response_type", "code")
                .append_pair("redirect_uri", redirect_uri)
                .append_pair("scope", SCOPES)
                .append_pair("resource", RESOURCE)
                .append_pair("state", &attempt.state)
                .append_pair("nonce", &attempt.nonce)
                .append_pair("code_challenge_method", "S256")
                .append_pair("code_challenge", &attempt.challenge());
            if client_id.is_none() {
                query.append_pair("agent_name_hint", APP_NAME);
            }
            if let Some(email) = login_hint {
                query.append_pair("login_hint", email);
            }
        }
        Ok(url.into())
    }

    pub async fn exchange_code(
        &self,
        client_id: &str,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> AppResult<Tokens> {
        let data = self
            .token_request(&[
                ("grant_type", "authorization_code"),
                ("client_id", client_id),
                ("code", code),
                ("code_verifier", verifier),
                ("redirect_uri", redirect_uri),
                ("resource", RESOURCE),
            ])
            .await?;
        parse_tokens(&data, false, None, now_ms())
    }

    /// Trades a refresh token for new credentials. The old refresh token is spent once this
    /// succeeds, so callers must keep what comes back.
    pub async fn refresh(
        &self,
        client_id: &str,
        refresh_token: &str,
        previous_scopes: &str,
    ) -> AppResult<Tokens> {
        let data = self
            .token_request(&[
                ("grant_type", "refresh_token"),
                ("client_id", client_id),
                ("refresh_token", refresh_token),
                ("resource", RESOURCE),
            ])
            .await?;
        parse_tokens(&data, true, Some(previous_scopes), now_ms())
    }

    async fn token_request(&self, form: &[(&str, &str)]) -> AppResult<Value> {
        let discovery = self.discovery().await?;
        let response = self
            .http
            .post(&discovery.token_endpoint)
            .header("accept", "application/json")
            .form(form)
            .timeout(HTTP_TIMEOUT)
            .send()
            .await
            .map_err(network_error)?;
        let status = response.status();
        let body = response.text().await.map_err(network_error)?;
        let data = serde_json::from_str::<Value>(&body).unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(service_error(&data, Some(status.as_u16())));
        }
        if !data.is_object() {
            return Err(invalid_tokens());
        }
        Ok(data)
    }

    /// Revokes the refresh token, which ends the renewable session on ChatGPT's side.
    pub async fn revoke(&self, client_id: &str, refresh_token: &str) -> AppResult<()> {
        let failed = || AppError::msg("ChatGPT couldn't confirm the sign-out.");
        let discovery = self.discovery().await.map_err(|_| failed())?;
        let endpoint = discovery.revocation_endpoint.ok_or_else(failed)?;
        for attempt in 0..2 {
            let result = self
                .http
                .post(&endpoint)
                .form(&[
                    ("token", refresh_token),
                    ("token_type_hint", "refresh_token"),
                    ("client_id", client_id),
                ])
                .timeout(Duration::from_secs(10))
                .send()
                .await;
            let retry = match result {
                Ok(response) if response.status().is_success() => return Ok(()),
                Ok(response) => response.status().is_server_error(),
                Err(_) => true,
            };
            if !retry || attempt == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        Err(failed())
    }

    /// Verifies an ID token's signature and claims, and returns who it identifies.
    ///
    /// `now_ms` is when the token was received; a refresh that is resumed after an outage is
    /// judged by when it arrived, not by when the signing keys became reachable again.
    pub async fn verify_id_token(
        &self,
        token: &str,
        client_id: &str,
        nonce: Option<&str>,
        now_ms: i64,
    ) -> AppResult<Identity> {
        let discovery = self
            .discovery()
            .await
            .map_err(|_| verification_unavailable())?;
        let header = jsonwebtoken::decode_header(token).map_err(|_| invalid_identity())?;
        if header.alg != Algorithm::RS256 {
            return Err(invalid_identity());
        }
        let kid = header.kid.ok_or_else(invalid_identity)?;
        let key = self.signing_key(&discovery.jwks_uri, &kid).await?;

        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[&discovery.issuer]);
        validation.set_audience(&[client_id]);
        validation.set_required_spec_claims(&["iss", "aud", "exp", "sub"]);
        // Expiry is checked below against `now_ms`, not the wall clock.
        validation.validate_exp = false;
        let claims = jsonwebtoken::decode::<IdClaims>(token, &key, &validation)
            .map_err(|_| invalid_identity())?
            .claims;

        let audiences = match &claims.aud {
            Value::Array(items) => items.len(),
            _ => 1,
        };
        let valid = claims.exp.saturating_mul(1000) + SKEW_MS > now_ms
            && claims.iat.saturating_mul(1000) - SKEW_MS <= now_ms
            && !claims.sub.is_empty()
            && nonce.is_none_or(|nonce| claims.nonce.as_deref() == Some(nonce))
            && claims.azp.as_deref().is_none_or(|azp| azp == client_id)
            && (audiences <= 1 || claims.azp.as_deref() == Some(client_id));
        if !valid {
            return Err(invalid_identity());
        }
        Ok(Identity {
            subject: claims.sub,
            name: claims.name.filter(|n| !n.is_empty()),
            email: claims.email.filter(|e| !e.is_empty()),
        })
    }

    async fn signing_key(&self, jwks_uri: &str, kid: &str) -> AppResult<DecodingKey> {
        let mut keys = self.keys.lock().await;
        // Fetch again when the key id is unknown: the server may have rotated its keys.
        if keys.as_ref().and_then(|set| set.find(kid)).is_none() {
            *keys = Some(self.fetch_keys(jwks_uri).await?);
        }
        let jwk = keys
            .as_ref()
            .and_then(|set| set.find(kid))
            .ok_or_else(invalid_identity)?;
        DecodingKey::from_jwk(jwk).map_err(|_| invalid_identity())
    }

    async fn fetch_keys(&self, jwks_uri: &str) -> AppResult<JwkSet> {
        let response = self
            .http
            .get(jwks_uri)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|_| verification_unavailable())?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(verification_unavailable());
        }
        response
            .json::<JwkSet>()
            .await
            .map_err(|_| verification_unavailable())
    }
}

#[derive(Deserialize)]
struct IdClaims {
    sub: String,
    aud: Value,
    exp: i64,
    iat: i64,
    #[serde(default)]
    nonce: Option<String>,
    #[serde(default)]
    azp: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    email: Option<String>,
}

pub fn invalid_identity() -> AppError {
    AppError::Auth {
        code: "invalid_id_token".into(),
        message: "ChatGPT's answer about who you are couldn't be verified. Sign in again.".into(),
    }
}

fn verification_unavailable() -> AppError {
    AppError::msg(
        "ChatGPT's identity check is temporarily unavailable. Your sign-in is kept; try again shortly.",
    )
}

fn invalid_tokens() -> AppError {
    AppError::Auth {
        code: "invalid_token_response".into(),
        message: "ChatGPT returned incomplete credentials. Sign in again.".into(),
    }
}

fn network_error(_: reqwest::Error) -> AppError {
    AppError::msg("Couldn't reach ChatGPT. Check your internet connection and try again.")
}

/// Validates a token endpoint response.
///
/// On refresh the server may leave out `scope` when nothing changed, so the previous grant
/// stands in for it.
pub fn parse_tokens(
    data: &Value,
    require_refresh: bool,
    previous_scopes: Option<&str>,
    now_ms: i64,
) -> AppResult<Tokens> {
    let scope = data
        .get("scope")
        .and_then(Value::as_str)
        .or(previous_scopes)
        .ok_or_else(invalid_tokens)?;
    let scopes: Vec<String> = scope.split_whitespace().map(str::to_string).collect();
    let wants_refresh = require_refresh || scopes.iter().any(|s| s == "offline_access");
    let text = |name: &str| {
        data.get(name)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };

    let credentials = match text("access_token") {
        Some(access_token) => {
            let bearer = text("token_type").is_some_and(|t| t.eq_ignore_ascii_case("bearer"));
            let expires_in = data
                .get("expires_in")
                .and_then(Value::as_f64)
                .filter(|s| s.is_finite() && *s > 0.0);
            let refresh_token = text("refresh_token");
            let (true, Some(expires_in)) = (bearer, expires_in) else {
                return Err(invalid_tokens());
            };
            if wants_refresh && refresh_token.is_none() {
                return Err(invalid_tokens());
            }
            Some(Credentials {
                access_token,
                refresh_token,
                expires_at: now_ms + (expires_in * 1000.0) as i64,
                earliest_refresh_at: data.get("earliest_refresh_at").and_then(timestamp_ms),
            })
        }
        None if wants_refresh || scopes.iter().any(|s| s == SHARING_SCOPE) => {
            return Err(invalid_tokens());
        }
        None => None,
    };
    let id_token = match data.get("id_token") {
        None | Some(Value::Null) => None,
        Some(Value::String(token)) if !token.is_empty() => Some(token.clone()),
        Some(_) => return Err(invalid_identity()),
    };
    Ok(Tokens {
        scopes,
        credentials,
        id_token,
    })
}

/// Reads a timestamp given either as Unix seconds or as an RFC 3339 string.
fn timestamp_ms(value: &Value) -> Option<i64> {
    match value {
        Value::Number(n) => n.as_f64().map(|s| (s * 1000.0) as i64),
        Value::String(s) => s
            .parse::<f64>()
            .ok()
            .map(|s| (s * 1000.0) as i64)
            .or_else(|| parse_rfc3339(s)),
        _ => None,
    }
}

/// Parses `YYYY-MM-DDTHH:MM:SS[.fff](Z|±HH:MM)` into milliseconds since the epoch.
fn parse_rfc3339(s: &str) -> Option<i64> {
    let num = |range: std::ops::Range<usize>| s.get(range)?.parse::<i64>().ok();
    let bytes = s.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[13] != b':' {
        return None;
    }
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let mut rest = &s[19..];
    let mut millis = 0;
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        let padded = format!("{:0<3}", &fraction[..digits.min(3)]);
        millis = padded.parse::<i64>().ok()?;
        rest = &fraction[digits..];
    }
    let offset_minutes = match rest {
        "Z" | "z" => 0,
        _ => {
            let sign = match rest.as_bytes().first()? {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let (h, m) = rest[1..].split_once(':')?;
            sign * (h.parse::<i64>().ok()? * 60 + m.parse::<i64>().ok()?)
        }
    };
    // Days from the civil calendar date (Howard Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    Some(seconds * 1000 + millis)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// What the browser hands back after the person approves the sign-in.
#[derive(Debug, PartialEq, Eq)]
pub struct Callback {
    pub code: String,
    pub client_id: String,
}

/// The local listener the browser is redirected to when sign-in finishes.
pub struct Loopback {
    listener: TcpListener,
    port: u16,
}

impl Loopback {
    /// Binds the preferred port, or any free one if it's taken.
    pub async fn bind(preferred: u16) -> AppResult<Self> {
        let listener = match TcpListener::bind(("127.0.0.1", preferred)).await {
            Ok(listener) => listener,
            Err(_) => TcpListener::bind(("127.0.0.1", 0)).await.map_err(|_| {
                AppError::msg("Theoremis couldn't open a local port to finish signing in.")
            })?,
        };
        let port = listener.local_addr()?.port();
        Ok(Self { listener, port })
    }

    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}{CALLBACK_PATH}", self.port)
    }

    /// Waits for the browser's redirect. Requests that don't belong to this attempt are
    /// answered and ignored, so a stray request can't end the sign-in.
    pub async fn wait(&self, state: &str, saved_client_id: Option<&str>) -> AppResult<Callback> {
        loop {
            let Ok((mut socket, _)) = self.listener.accept().await else {
                continue;
            };
            let handled = tokio::time::timeout(
                Duration::from_secs(10),
                self.handle(&mut socket, state, saved_client_id),
            )
            .await;
            if let Ok(Some(result)) = handled {
                return result;
            }
        }
    }

    async fn handle(
        &self,
        socket: &mut TcpStream,
        state: &str,
        saved_client_id: Option<&str>,
    ) -> Option<AppResult<Callback>> {
        let head = read_head(socket).await?;
        let mut lines = head.split("\r\n");
        let mut request_line = lines.next()?.split(' ');
        let (method, target) = (request_line.next()?, request_line.next()?);
        let host = lines.find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("host").then(|| value.trim())
        });
        let origin = format!("127.0.0.1:{}", self.port);
        let url = Url::parse(&format!("http://{origin}{target}")).ok();
        let Some(url) = url.filter(|url| {
            method == "GET"
                && host == Some(origin.as_str())
                && url.path() == CALLBACK_PATH
                && url.host_str() == Some("127.0.0.1")
        }) else {
            respond(socket, "404 Not Found", "text/plain", "Not found").await;
            return None;
        };

        let values = |name: &str| -> Vec<String> {
            url.query_pairs()
                .filter(|(key, _)| key == name)
                .map(|(_, value)| value.into_owned())
                .collect()
        };
        let states = values("state");
        if states.len() != 1 || !constant_time_eq(states[0].as_bytes(), state.as_bytes()) {
            respond(
                socket,
                "400 Bad Request",
                "text/plain",
                "This sign-in link doesn't match the one Theoremis started. Return to the app and try again.",
            )
            .await;
            return None;
        }

        let errors = values("error");
        let codes = values("code");
        let client_ids = values("client_id");
        let result = if let Some(error) = errors.first() {
            Err(service_error(&serde_json::json!({ "error": error }), None))
        } else {
            let client_id = client_ids
                .first()
                .map(String::as_str)
                .or(saved_client_id)
                .unwrap_or_default();
            let valid_client = !client_id.is_empty()
                && client_id.len() <= 200
                && client_id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                && client_id != DYNAMIC_CLIENT
                && client_ids.len() <= 1
                && saved_client_id
                    .is_none_or(|saved| client_ids.is_empty() || client_ids[0] == saved);
            if codes.len() == 1 && !codes[0].is_empty() && valid_client {
                Ok(Callback {
                    code: codes[0].clone(),
                    client_id: client_id.to_string(),
                })
            } else {
                Err(AppError::msg(
                    "ChatGPT didn't finish registering Theoremis. Try signing in again.",
                ))
            }
        };
        let page = if result.is_ok() {
            finished_page(
                "You're signed in",
                "Theoremis is finishing your ChatGPT connection. You can close this tab.",
            )
        } else {
            finished_page(
                "Sign-in wasn't completed",
                "Return to Theoremis to try again. You can close this tab.",
            )
        };
        respond(socket, "200 OK", "text/html; charset=utf-8", &page).await;
        Some(result)
    }
}

const CLEAN_URL_SCRIPT: &str = r#"history.replaceState(null, "", "/auth/complete");"#;

fn finished_page(title: &str, body: &str) -> String {
    format!(
        "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">\
         <title>Theoremis</title><style>body{{margin:0;min-height:100vh;display:grid;place-items:center;\
         background:#141417;color:#e8e6e1;font:16px/1.55 system-ui,sans-serif}}main{{max-width:30rem;padding:24px}}\
         h1{{font:400 30px/1.15 Georgia,serif;margin:0 0 10px}}p{{margin:0;color:#a9a7b0}}</style>\
         <main><h1>{title}</h1><p>{body}</p></main><script>{CLEAN_URL_SCRIPT}</script></html>"
    )
}

async fn respond(socket: &mut TcpStream, status: &str, content_type: &str, body: &str) {
    let script_hash = STANDARD.encode(Sha256::digest(CLEAN_URL_SCRIPT.as_bytes()));
    let response = format!(
        "HTTP/1.1 {status}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\n\
         cache-control: no-store\r\nreferrer-policy: no-referrer\r\n\
         content-security-policy: default-src 'none'; script-src 'sha256-{script_hash}'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'\r\n\
         connection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.shutdown().await;
}

/// Reads up to the end of the request headers; `None` if the client sends something else.
async fn read_head(socket: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 2048];
    loop {
        let n = socket.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            return String::from_utf8(buf[..end].to_vec()).ok();
        }
        if buf.len() > 16 * 1024 {
            return None;
        }
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_authorization_url() {
        let discovery = Discovery {
            issuer: ISSUER.into(),
            authorization_endpoint: format!("{ISSUER}/oauth/authorize"),
            token_endpoint: format!("{ISSUER}/oauth/token"),
            revocation_endpoint: None,
            jwks_uri: format!("{ISSUER}/.well-known/jwks.json"),
        };
        let attempt = Attempt::new().unwrap();
        let server = AuthServer::new(reqwest::Client::new(), ISSUER);
        let first = server
            .authorization_url(
                &discovery,
                &attempt,
                "http://127.0.0.1:8619/auth/callback",
                None,
                None,
            )
            .unwrap();
        let url = Url::parse(&first).unwrap();
        let pairs: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(pairs["client_id"], DYNAMIC_CLIENT);
        assert_eq!(pairs["agent_name_hint"], "Theoremis");
        assert_eq!(pairs["code_challenge_method"], "S256");
        assert_eq!(pairs["resource"], RESOURCE);
        assert!(pairs["scope"].split(' ').any(|s| s == SHARING_SCOPE));
        // S256 of the verifier, base64url without padding (RFC 7636).
        assert_eq!(
            pairs["code_challenge"],
            URL_SAFE_NO_PAD.encode(Sha256::digest(attempt.verifier.as_bytes()))
        );

        let again = server
            .authorization_url(
                &discovery,
                &attempt,
                "http://x/",
                Some("app_123"),
                Some("a@b.c"),
            )
            .unwrap();
        let pairs: std::collections::HashMap<_, _> = Url::parse(&again)
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect();
        assert_eq!(pairs["client_id"], "app_123");
        assert_eq!(pairs["login_hint"], "a@b.c");
        assert!(!pairs.contains_key("agent_name_hint"));
    }

    #[test]
    fn pkce_challenge_matches_rfc_example() {
        let attempt = Attempt {
            state: String::new(),
            nonce: String::new(),
            verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".into(),
        };
        assert_eq!(
            attempt.challenge(),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn parses_token_responses() {
        let tokens = parse_tokens(
            &serde_json::json!({
                "access_token": "at", "token_type": "Bearer", "expires_in": 3600,
                "refresh_token": "rt", "id_token": "id", "scope": "openid offline_access",
                "earliest_refresh_at": "2026-01-01T00:00:00Z"
            }),
            false,
            None,
            1_000,
        )
        .unwrap();
        let credentials = tokens.credentials.unwrap();
        assert_eq!(credentials.expires_at, 1_000 + 3_600_000);
        assert_eq!(credentials.earliest_refresh_at, Some(1_767_225_600_000));
        assert_eq!(tokens.id_token.as_deref(), Some("id"));

        // offline_access without a refresh token is incomplete.
        assert!(
            parse_tokens(
                &serde_json::json!({ "access_token": "at", "token_type": "bearer", "expires_in": 60, "scope": "offline_access" }),
                false,
                None,
                0,
            )
            .is_err()
        );
        // A refresh may omit the scope; the previous grant stands.
        let refreshed = parse_tokens(
            &serde_json::json!({ "access_token": "at2", "token_type": "bearer", "expires_in": 60, "refresh_token": "rt2" }),
            true,
            Some("openid chatgpt.tokens.use.direct"),
            0,
        )
        .unwrap();
        assert_eq!(refreshed.scopes, vec!["openid", SHARING_SCOPE]);
    }

    #[test]
    fn parses_timestamps() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_rfc3339("2000-03-01T12:30:15.250Z"),
            Some(951_913_815_250)
        );
        assert_eq!(
            parse_rfc3339("2000-03-01T14:30:15.250+02:00"),
            Some(951_913_815_250)
        );
        assert_eq!(parse_rfc3339("yesterday"), None);
        assert_eq!(
            timestamp_ms(&serde_json::json!(1_700_000_000)),
            Some(1_700_000_000_000)
        );
    }

    async fn send(port: u16, request: String) -> String {
        let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        socket.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        socket.read_to_string(&mut response).await.unwrap();
        response
    }

    #[tokio::test]
    async fn loopback_accepts_only_the_matching_callback() {
        let loopback = Loopback::bind(0).await.unwrap();
        let port = loopback.port;
        let get = |path: &str, host: &str| format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n\r\n");
        let client = tokio::spawn(async move {
            let host = format!("127.0.0.1:{port}");
            let wrong_path = send(port, get("/favicon.ico", &host)).await;
            let wrong_host = send(port, get("/auth/callback?state=s1&code=c", "evil.test")).await;
            let wrong_state = send(port, get("/auth/callback?state=nope&code=c", &host)).await;
            let ok = send(
                port,
                get(
                    "/auth/callback?state=s1&code=the-code&client_id=app_42",
                    &host,
                ),
            )
            .await;
            (wrong_path, wrong_host, wrong_state, ok)
        });
        let callback = loopback.wait("s1", None).await.unwrap();
        assert_eq!(
            callback,
            Callback {
                code: "the-code".into(),
                client_id: "app_42".into()
            }
        );
        let (wrong_path, wrong_host, wrong_state, ok) = client.await.unwrap();
        assert!(wrong_path.starts_with("HTTP/1.1 404"));
        assert!(wrong_host.starts_with("HTTP/1.1 404"));
        assert!(wrong_state.starts_with("HTTP/1.1 400"));
        assert!(ok.starts_with("HTTP/1.1 200"));
        assert!(ok.contains("You're signed in"));
        assert!(ok.contains("content-security-policy: default-src 'none'"));
    }

    #[tokio::test]
    async fn loopback_reports_denied_and_unregistered_callbacks() {
        let loopback = Loopback::bind(0).await.unwrap();
        let port = loopback.port;
        let host = format!("127.0.0.1:{port}");
        let request = format!(
            "GET /auth/callback?state=s&error=access_denied HTTP/1.1\r\nHost: {host}\r\n\r\n"
        );
        let client = tokio::spawn(async move { send(port, request).await });
        let err = loopback.wait("s", None).await.unwrap_err();
        assert_eq!(err.to_string(), "Sign-in wasn't completed.");
        assert!(client.await.unwrap().contains("Sign-in wasn't completed"));

        // No client id on a first sign-in means registration didn't happen.
        let request = format!("GET /auth/callback?state=s&code=c HTTP/1.1\r\nHost: {host}\r\n\r\n");
        let client = tokio::spawn(async move { send(port, request).await });
        assert!(loopback.wait("s", None).await.is_err());
        client.await.unwrap();

        // A returning installation may omit it, but must not change it.
        let request = format!("GET /auth/callback?state=s&code=c HTTP/1.1\r\nHost: {host}\r\n\r\n");
        let client = tokio::spawn(async move { send(port, request).await });
        assert_eq!(
            loopback.wait("s", Some("app_1")).await.unwrap().client_id,
            "app_1"
        );
        client.await.unwrap();
        let request = format!(
            "GET /auth/callback?state=s&code=c&client_id=app_2 HTTP/1.1\r\nHost: {host}\r\n\r\n"
        );
        let client = tokio::spawn(async move { send(port, request).await });
        assert!(loopback.wait("s", Some("app_1")).await.is_err());
        client.await.unwrap();
    }
}
