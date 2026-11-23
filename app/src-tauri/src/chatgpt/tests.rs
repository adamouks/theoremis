//! The whole sign-in lifecycle against a mock authorization server and API.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jsonwebtoken::{EncodingKey, Header};
use reqwest::Url;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::vault::tests::MemoryKeys;
use super::*;
use crate::providers::test_server::client;

/// A throwaway RSA key used only to sign ID tokens in these tests.
const SIGNING_KEY: &str = include_str!("testdata/test-signing-key.pem");
/// The public modulus of [`SIGNING_KEY`], base64url-encoded as in a JWK.
const MODULUS: &str = "wjr8XwmeU2BLivatQghmgBz7Au_ZrOcflOYBa1e_EmpM3zH70X-Z0kyEJFJVOFdJ6QcAQ0mn-anRXdJDbGESqoggDYCFP165GcEdwCcxyexvH-bKkkxeifT6pwR01Kt5oKn_GaihGhecM7Kn0b0BWJ6p1dYpfDpIqq5PwXAv3ffKMzbcyypFSg0o256tNFaHB-ONadwBTvgfrg9H7NCAUlZavPGlPXCkpcAkOTwwooazMcxPL0q2bgAPBP3JOkrtx39r38Qy0iOWg5sCnzA5A-wTIxc3PguL-Mha1wxX80V1wienUO3na6yubVuAFgOsDLpzYKuPrZrCElIxY8Zn2w";
const ALL_SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

struct Request {
    method: String,
    path: String,
    headers: String,
    form: HashMap<String, String>,
}

/// What the mock server knows and how it should misbehave.
#[derive(Default)]
struct Mock {
    base: Mutex<String>,
    challenge: Mutex<Option<String>>,
    nonce: Mutex<Option<String>>,
    /// Serve the signing keys or fail as if the key service were down.
    keys_down: AtomicBool,
    /// Reject refresh tokens as if they had been revoked.
    refresh_revoked: AtomicBool,
    refreshes: AtomicUsize,
    revoked: Mutex<Vec<String>>,
    authorized_with: Mutex<Vec<String>>,
}

impl Mock {
    fn id_token(&self, kid: &str, nonce: Option<String>) -> String {
        let now = now_ms() / 1000;
        let mut claims = json!({
            "iss": self.base.lock().unwrap().clone(),
            "aud": "app_1",
            "sub": "user-ada",
            "email": "ada@example.com",
            "name": "Ada Lovelace",
            "iat": now,
            "exp": now + 3600,
        });
        if let Some(nonce) = nonce {
            claims["nonce"] = json!(nonce);
        }
        let mut header = Header::new(jsonwebtoken::Algorithm::RS256);
        header.kid = Some(kid.into());
        let key = EncodingKey::from_rsa_pem(SIGNING_KEY.as_bytes()).unwrap();
        jsonwebtoken::encode(&header, &claims, &key).unwrap()
    }

    fn handle(&self, req: &Request) -> (u16, String) {
        let base = self.base.lock().unwrap().clone();
        let bearer = |token: &str| {
            req.headers
                .to_ascii_lowercase()
                .contains(&format!("authorization: bearer {token}"))
        };
        match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/.well-known/openid-configuration") => (
                200,
                json!({
                    "issuer": base,
                    "authorization_endpoint": format!("{base}/oauth/authorize"),
                    "token_endpoint": format!("{base}/oauth/token"),
                    "revocation_endpoint": format!("{base}/oauth/revoke"),
                    "jwks_uri": format!("{base}/jwks"),
                })
                .to_string(),
            ),
            ("GET", "/jwks") if self.keys_down.load(Ordering::SeqCst) => (503, String::new()),
            ("GET", "/jwks") => {
                let key = |kid: &str| json!({ "kty": "RSA", "kid": kid, "alg": "RS256", "use": "sig", "n": MODULUS, "e": "AQAB" });
                // Refreshed ID tokens are signed with a key published after the sign-in.
                let mut keys = vec![key("k1")];
                if self.refreshes.load(Ordering::SeqCst) > 0 {
                    keys.push(key("k2"));
                }
                (200, json!({ "keys": keys }).to_string())
            }
            ("POST", "/oauth/token") => match req.form["grant_type"].as_str() {
                "authorization_code" => {
                    let challenge = URL_SAFE_NO_PAD
                        .encode(Sha256::digest(req.form["code_verifier"].as_bytes()));
                    let valid = req.form["code"] == "code-1"
                        && req.form["client_id"] == "app_1"
                        && Some(challenge) == *self.challenge.lock().unwrap();
                    if !valid {
                        return (400, json!({ "error": "invalid_grant" }).to_string());
                    }
                    let nonce = self.nonce.lock().unwrap().clone();
                    (
                        200,
                        json!({
                            "access_token": "at-1", "refresh_token": "rt-1", "token_type": "Bearer",
                            "expires_in": 3600, "scope": ALL_SCOPES, "id_token": self.id_token("k1", nonce),
                        })
                        .to_string(),
                    )
                }
                "refresh_token" => {
                    let n = self.refreshes.fetch_add(1, Ordering::SeqCst) + 1;
                    if self.refresh_revoked.load(Ordering::SeqCst)
                        || req.form["refresh_token"] != format!("rt-{n}")
                    {
                        return (400, json!({ "error": "invalid_grant" }).to_string());
                    }
                    (
                        200,
                        json!({
                            "access_token": format!("at-{}", n + 1), "refresh_token": format!("rt-{}", n + 1),
                            "token_type": "bearer", "expires_in": 3600, "id_token": self.id_token("k2", None),
                        })
                        .to_string(),
                    )
                }
                _ => (
                    400,
                    json!({ "error": "unsupported_grant_type" }).to_string(),
                ),
            },
            ("POST", "/oauth/revoke") => {
                self.revoked.lock().unwrap().push(req.form["token"].clone());
                (200, String::new())
            }
            ("GET", "/v1/models") => {
                let token = (1..10).map(|n| format!("at-{n}")).find(|t| bearer(t));
                self.authorized_with.lock().unwrap().extend(token.clone());
                match token {
                    Some(_) => (
                        200,
                        json!({ "models": [{ "slug": "gpt-6", "display_name": "GPT-6", "visibility": "list" }] })
                            .to_string(),
                    ),
                    None => (401, json!({ "error": { "code": "invalid_token" } }).to_string()),
                }
            }
            _ => (404, String::new()),
        }
    }
}

async fn serve(mock: Arc<Mock>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    *mock.base.lock().unwrap() = base.clone();
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mock = mock.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let head_end = loop {
                    let n = socket.read(&mut chunk).await.unwrap();
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break pos + 4;
                    }
                };
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let length = head
                    .lines()
                    .find_map(|l| {
                        let (k, v) = l.split_once(':')?;
                        k.eq_ignore_ascii_case("content-length")
                            .then(|| v.trim().parse::<usize>().ok())?
                    })
                    .unwrap_or(0);
                while buf.len() < head_end + length {
                    let n = socket.read(&mut chunk).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let mut parts = head.split(' ');
                let method = parts.next().unwrap().to_string();
                let target = parts.next().unwrap().to_string();
                let url = Url::parse(&format!("http://mock{target}")).unwrap();
                let form = Url::parse(&format!(
                    "http://mock/?{}",
                    String::from_utf8_lossy(&buf[head_end..])
                ))
                .unwrap()
                .query_pairs()
                .into_owned()
                .collect();
                let request = Request {
                    method,
                    path: url.path().to_string(),
                    headers: head,
                    form,
                };
                let (status, body) = mock.handle(&request);
                let response = format!(
                    "HTTP/1.1 {status} Mock\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    base
}

fn app(base: &str, dir: &std::path::Path, keys: &MemoryKeys) -> ChatGpt {
    let vault = Vault::new(dir.join("chatgpt.json"), Box::new(keys.clone()));
    ChatGpt::with_endpoints(client(), base, &format!("{base}/v1"), vault, 0)
}

/// Plays the browser: approves the sign-in by following the redirect with a code.
fn approve(mock: &Arc<Mock>) -> impl FnOnce(&str) -> AppResult<()> + use<> {
    let mock = mock.clone();
    move |url: &str| {
        let url = Url::parse(url).unwrap();
        let params: HashMap<String, String> = url.query_pairs().into_owned().collect();
        assert_eq!(params["client_id"], "dynamic_agent_client");
        assert_eq!(params["agent_name_hint"], "Theoremis");
        *mock.challenge.lock().unwrap() = Some(params["code_challenge"].clone());
        *mock.nonce.lock().unwrap() = Some(params["nonce"].clone());
        let callback = format!(
            "{}?state={}&code=code-1&client_id=app_1",
            params["redirect_uri"], params["state"]
        );
        tokio::spawn(async move { client().get(callback).send().await.unwrap() });
        Ok(())
    }
}

async fn expire_access_token(chatgpt: &ChatGpt) {
    let mut state = chatgpt.0.state.lock().await;
    state.connection.credentials.as_mut().unwrap().expires_at = 0;
}

#[tokio::test]
async fn signs_in_refreshes_and_signs_out() {
    let mock = Arc::new(Mock::default());
    let base = serve(mock.clone()).await;
    let dir = tempfile::tempdir().unwrap();
    let keys = MemoryKeys::default();
    let chatgpt = app(&base, dir.path(), &keys);
    assert_eq!(chatgpt.session().await.status, SessionStatus::SignedOut);

    let session = chatgpt.sign_in(false, approve(&mock)).await.unwrap();
    assert_eq!(session.status, SessionStatus::Connected);
    assert_eq!(session.email.as_deref(), Some("ada@example.com"));
    assert_eq!(session.name.as_deref(), Some("Ada Lovelace"));
    assert!(session.sharing);

    let status = chatgpt.provider_status().await;
    assert!(status.available, "{:?}", status.message);
    assert_eq!(status.models[0].id, "gpt-6");

    // An expiring token is refreshed (and its new identity verified) before use.
    expire_access_token(&chatgpt).await;
    assert!(chatgpt.provider_status().await.available);
    assert_eq!(*mock.authorized_with.lock().unwrap(), vec!["at-1", "at-2"]);

    // The rotated tokens were saved, encrypted: a new run picks them up.
    let on_disk = std::fs::read_to_string(dir.path().join("chatgpt.json")).unwrap();
    assert!(!on_disk.contains("rt-2"));
    let reopened = app(&base, dir.path(), &keys);
    assert_eq!(reopened.session().await.status, SessionStatus::Connected);
    assert!(reopened.provider_status().await.available);
    assert_eq!(mock.authorized_with.lock().unwrap().last().unwrap(), "at-2");

    let session = reopened.sign_out().await.unwrap();
    assert_eq!(session.status, SessionStatus::SignedOut);
    assert!(session.notice.is_none());
    assert_eq!(session.email.as_deref(), Some("ada@example.com"));
    assert_eq!(*mock.revoked.lock().unwrap(), vec!["rt-2"]);
    assert!(!reopened.provider_status().await.available);
}

#[tokio::test]
async fn a_revoked_session_needs_a_new_sign_in() {
    let mock = Arc::new(Mock::default());
    let base = serve(mock.clone()).await;
    let dir = tempfile::tempdir().unwrap();
    let chatgpt = app(&base, dir.path(), &MemoryKeys::default());
    chatgpt.sign_in(false, approve(&mock)).await.unwrap();

    mock.refresh_revoked.store(true, Ordering::SeqCst);
    expire_access_token(&chatgpt).await;
    let status = chatgpt.provider_status().await;
    assert!(!status.available);
    assert!(status.message.unwrap().contains("expired"));
    assert_eq!(chatgpt.session().await.status, SessionStatus::Expired);
}

#[tokio::test]
async fn a_refresh_survives_a_key_service_outage() {
    let mock = Arc::new(Mock::default());
    let base = serve(mock.clone()).await;
    let dir = tempfile::tempdir().unwrap();
    let keys = MemoryKeys::default();
    let chatgpt = app(&base, dir.path(), &keys);
    chatgpt.sign_in(false, approve(&mock)).await.unwrap();

    // The refreshed ID token is signed with a key that can't be fetched right now.
    mock.keys_down.store(true, Ordering::SeqCst);
    expire_access_token(&chatgpt).await;
    let status = chatgpt.provider_status().await;
    assert!(!status.available);
    assert!(status.message.unwrap().contains("temporarily unavailable"));
    assert_eq!(chatgpt.session().await.status, SessionStatus::Connected);

    // After a restart and the outage, verification resumes without spending another refresh.
    mock.keys_down.store(false, Ordering::SeqCst);
    let reopened = app(&base, dir.path(), &keys);
    assert!(reopened.provider_status().await.available);
    assert_eq!(mock.refreshes.load(Ordering::SeqCst), 1);
    assert_eq!(mock.authorized_with.lock().unwrap().last().unwrap(), "at-2");
}

#[tokio::test]
async fn sign_in_can_be_cancelled() {
    let mock = Arc::new(Mock::default());
    let base = serve(mock.clone()).await;
    let dir = tempfile::tempdir().unwrap();
    let chatgpt = app(&base, dir.path(), &MemoryKeys::default());
    let other = chatgpt.clone();
    let pending = tokio::spawn(async move { other.sign_in(false, |_| Ok(())).await });
    while chatgpt.session().await.status != SessionStatus::SigningIn {
        tokio::task::yield_now().await;
    }
    assert!(chatgpt.cancel_sign_in());
    let err = pending.await.unwrap().unwrap_err();
    assert_eq!(err.to_string(), "Sign-in was cancelled.");
    assert_eq!(chatgpt.session().await.status, SessionStatus::SignedOut);
}

#[test]
fn explains_service_errors_by_code() {
    let err = service_error(
        &json!({ "error": { "code": "subscription_sharing_v2_user_not_eligible", "message": "echo of your text" } }),
        Some(403),
    );
    assert!(err.to_string().contains("can't share its plan"));
    assert!(!err.to_string().contains("echo"));
    assert!(matches!(
        service_error(&json!({ "error": "invalid_grant" }), Some(400)),
        AppError::Auth { ref code, .. } if code == "invalid_grant"
    ));
    assert_eq!(
        service_error(&json!({ "error": { "code": "weird_thing" } }), Some(400)).to_string(),
        "ChatGPT rejected this request (weird_thing)"
    );
    assert_eq!(
        service_error(&Value::Null, Some(503)).to_string(),
        "ChatGPT is temporarily unavailable. Try again shortly."
    );
}
