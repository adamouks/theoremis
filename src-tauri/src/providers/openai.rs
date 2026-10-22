//! OpenAI's Chat Completions API: `GET /models` and streaming `POST /chat/completions` (SSE).
//!
//! Works with any OpenAI-compatible endpoint by changing the base URL.

use std::time::Duration;

use serde::Deserialize;
use serde_json::json;

use super::lines::{Flow, for_each_line};
use super::{ChatMessage, ModelInfo, Provider, ProviderStatus, StreamEvent, error_from_body};
use crate::error::{AppError, AppResult};
use crate::settings::DEFAULT_OPENAI_URL;

const LIST_TIMEOUT: Duration = Duration::from_secs(15);
const MISSING_KEY: &str = "Add your OpenAI API key in Settings to use ChatGPT models.";

#[derive(Deserialize)]
struct ModelsResponse {
    #[serde(default)]
    data: Vec<ApiModel>,
}

#[derive(Deserialize)]
struct ApiModel {
    id: String,
    #[serde(default)]
    created: i64,
}

pub async fn list_models(
    client: &reqwest::Client,
    base_url: &str,
    api_key: Option<&str>,
) -> ProviderStatus {
    let Some(api_key) = api_key else {
        return ProviderStatus {
            provider: Provider::Openai,
            available: false,
            models: Vec::new(),
            message: Some(MISSING_KEY.into()),
        };
    };
    match fetch_models(client, base_url, api_key).await {
        Ok(models) => ProviderStatus {
            provider: Provider::Openai,
            available: true,
            message: models
                .is_empty()
                .then(|| "This API key has no chat models available.".into()),
            models,
        },
        Err(err) => ProviderStatus {
            provider: Provider::Openai,
            available: false,
            models: Vec::new(),
            message: Some(err.to_string()),
        },
    }
}

async fn fetch_models(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
) -> AppResult<Vec<ModelInfo>> {
    let response = client
        .get(format!("{base_url}/models"))
        .bearer_auth(api_key)
        .timeout(LIST_TIMEOUT)
        .send()
        .await
        .map_err(|err| request_error(err, base_url))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::msg(error_from_body("OpenAI", status, &body)));
    }
    let list: ModelsResponse = response.json().await?;
    // Third-party compatible endpoints use their own naming, so only filter OpenAI's own list.
    let filter = base_url == DEFAULT_OPENAI_URL;
    Ok(models_from_list(list, filter))
}

fn models_from_list(list: ModelsResponse, only_chat: bool) -> Vec<ModelInfo> {
    let mut models: Vec<ApiModel> = list
        .data
        .into_iter()
        .filter(|m| !only_chat || is_chat_model(&m.id))
        .collect();
    // Newest first, so the latest models top the picker.
    models.sort_by(|a, b| b.created.cmp(&a.created).then_with(|| a.id.cmp(&b.id)));
    models
        .into_iter()
        .map(|m| ModelInfo {
            provider: Provider::Openai,
            id: m.id,
            detail: None,
        })
        .collect()
}

/// Whether an OpenAI model id can be used with streaming Chat Completions.
fn is_chat_model(id: &str) -> bool {
    let family = id.starts_with("gpt-")
        || id.starts_with("chatgpt-")
        || (id.starts_with('o') && id[1..].starts_with(|c: char| c.is_ascii_digit()));
    const EXCLUDED: &[&str] = &[
        "audio",
        "realtime",
        "tts",
        "transcribe",
        "image",
        "instruct",
        "search",
        "embedding",
        "moderation",
        "codex",
        "deep-research",
        "computer-use",
        "-pro",
    ];
    family && !EXCLUDED.iter().any(|word| id.contains(word))
}

pub async fn stream_chat(
    client: &reqwest::Client,
    base_url: &str,
    api_key: Option<&str>,
    model: &str,
    messages: &[ChatMessage],
    mut emit: impl FnMut(StreamEvent),
) -> AppResult<()> {
    let api_key = api_key.ok_or_else(|| AppError::msg(MISSING_KEY))?;
    let response = client
        .post(format!("{base_url}/chat/completions"))
        .bearer_auth(api_key)
        .json(&json!({ "model": model, "messages": messages, "stream": true }))
        .send()
        .await
        .map_err(|err| request_error(err, base_url))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::msg(error_from_body("OpenAI", status, &body)));
    }

    for_each_line(response, |line| match parse_sse_line(line)? {
        SseLine::Ignore => Ok(Flow::Continue),
        SseLine::Events(events) => {
            events.into_iter().for_each(&mut emit);
            Ok(Flow::Continue)
        }
        SseLine::Done => Ok(Flow::Stop),
    })
    .await
}

#[derive(Debug, PartialEq, Eq)]
enum SseLine {
    Ignore,
    Events(Vec<StreamEvent>),
    Done,
}

#[derive(Deserialize)]
struct Chunk {
    #[serde(default)]
    choices: Vec<Choice>,
    #[serde(default)]
    error: Option<ApiError>,
}

#[derive(Deserialize)]
struct Choice {
    #[serde(default)]
    delta: Option<Delta>,
}

#[derive(Deserialize)]
struct Delta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    refusal: Option<String>,
    // Not part of OpenAI's API, but common among compatible providers.
    #[serde(default)]
    reasoning_content: Option<String>,
    #[serde(default)]
    reasoning: Option<String>,
}

#[derive(Deserialize)]
struct ApiError {
    message: String,
}

fn parse_sse_line(line: &str) -> AppResult<SseLine> {
    let Some(data) = line.strip_prefix("data:") else {
        // Blank separators, `event:` / `id:` fields and `:` comments carry no content here.
        return Ok(SseLine::Ignore);
    };
    let data = data.trim();
    if data == "[DONE]" {
        return Ok(SseLine::Done);
    }
    if data.is_empty() {
        return Ok(SseLine::Ignore);
    }
    let chunk: Chunk = serde_json::from_str(data)?;
    if let Some(error) = chunk.error {
        return Err(AppError::msg(format!("OpenAI: {}", error.message)));
    }
    let mut events = Vec::new();
    for delta in chunk.choices.into_iter().filter_map(|c| c.delta) {
        if let Some(text) = delta
            .reasoning_content
            .or(delta.reasoning)
            .filter(|t| !t.is_empty())
        {
            events.push(StreamEvent::Reasoning { text });
        }
        if let Some(text) = delta.content.or(delta.refusal).filter(|t| !t.is_empty()) {
            events.push(StreamEvent::Delta { text });
        }
    }
    Ok(SseLine::Events(events))
}

fn request_error(err: reqwest::Error, base_url: &str) -> AppError {
    if err.is_connect() || err.is_timeout() {
        AppError::msg(format!(
            "Couldn't reach {base_url}. Check your internet connection and the API base URL in Settings."
        ))
    } else {
        AppError::Http(err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::Role;
    use crate::providers::test_server::{client, serve_once};

    #[tokio::test]
    async fn streams_a_reply_end_to_end() {
        let (url, server) = serve_once(
            200,
            "text/event-stream",
            vec![
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n",
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Let \"}}]}\n\ndata: {\"choi",
                "ces\":[{\"index\":0,\"delta\":{\"content\":\"ε > 0\"}}]}\n\n",
                "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                "data: [DONE]\n\n",
            ],
        )
        .await;
        let messages = vec![
            ChatMessage {
                role: Role::System,
                content: "Be rigorous.".into(),
            },
            ChatMessage {
                role: Role::User,
                content: "Define a limit.".into(),
            },
        ];
        let mut events = Vec::new();
        stream_chat(
            &client(),
            &url,
            Some("sk-test"),
            "gpt-test",
            &messages,
            |e| events.push(e),
        )
        .await
        .unwrap();
        assert_eq!(
            events,
            vec![
                StreamEvent::Delta {
                    text: "Let ".into()
                },
                StreamEvent::Delta {
                    text: "ε > 0".into()
                },
            ]
        );

        let request = server.await.unwrap();
        assert!(request.head.starts_with("POST /chat/completions "));
        assert!(
            request
                .head
                .to_ascii_lowercase()
                .contains("authorization: bearer sk-test")
        );
        let body: serde_json::Value = serde_json::from_str(&request.body).unwrap();
        assert_eq!(body["model"], "gpt-test");
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"][0]["role"], "system");
    }

    #[tokio::test]
    async fn surfaces_api_errors() {
        let (url, _server) = serve_once(
            401,
            "application/json",
            vec![r#"{"error":{"message":"Incorrect API key provided: sk-bad.","type":"invalid_request_error"}}"#],
        )
        .await;
        let err = stream_chat(&client(), &url, Some("sk-bad"), "gpt-test", &[], |_| {})
            .await
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "OpenAI returned 401 Unauthorized: Incorrect API key provided: sk-bad."
        );
    }

    #[tokio::test]
    async fn requires_an_api_key() {
        let err = stream_chat(
            &client(),
            "http://127.0.0.1:9",
            None,
            "gpt-test",
            &[],
            |_| {},
        )
        .await
        .unwrap_err();
        assert_eq!(err.to_string(), MISSING_KEY);
        let status = list_models(&client(), "http://127.0.0.1:9", None).await;
        assert!(!status.available);
    }

    #[test]
    fn parses_sse_deltas() {
        let line = r#"data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}"#;
        assert_eq!(
            parse_sse_line(line).unwrap(),
            SseLine::Events(vec![StreamEvent::Delta {
                text: "Hello".into()
            }])
        );
        assert_eq!(
            parse_sse_line(
                r#"data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}"#
            )
            .unwrap(),
            SseLine::Events(vec![])
        );
        assert_eq!(
            parse_sse_line(r#"data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}"#).unwrap(),
            SseLine::Events(vec![StreamEvent::Reasoning { text: "hmm".into() }])
        );
    }

    #[test]
    fn handles_control_lines() {
        assert_eq!(parse_sse_line("data: [DONE]").unwrap(), SseLine::Done);
        assert_eq!(parse_sse_line("").unwrap(), SseLine::Ignore);
        assert_eq!(parse_sse_line(": keep-alive").unwrap(), SseLine::Ignore);
        assert_eq!(parse_sse_line("event: message").unwrap(), SseLine::Ignore);
    }

    #[test]
    fn surfaces_mid_stream_errors() {
        let err =
            parse_sse_line(r#"data: {"error":{"message":"Rate limit reached","type":"tokens"}}"#)
                .unwrap_err();
        assert_eq!(err.to_string(), "OpenAI: Rate limit reached");
    }

    #[test]
    fn filters_chat_models() {
        for id in [
            "gpt-4o",
            "gpt-4.1-mini",
            "gpt-5",
            "o3",
            "o4-mini",
            "chatgpt-4o-latest",
        ] {
            assert!(is_chat_model(id), "{id} should be a chat model");
        }
        for id in [
            "text-embedding-3-large",
            "whisper-1",
            "dall-e-3",
            "gpt-4o-realtime-preview",
            "gpt-4o-mini-tts",
            "gpt-3.5-turbo-instruct",
            "gpt-image-1",
            "o1-pro",
            "gpt-5-codex",
            "omni-moderation-latest",
            "babbage-002",
        ] {
            assert!(!is_chat_model(id), "{id} should not be a chat model");
        }
    }

    #[test]
    fn sorts_newest_first() {
        let list: ModelsResponse = serde_json::from_str(
            r#"{"data":[{"id":"gpt-4o","created":100},{"id":"whisper-1","created":300},{"id":"gpt-5","created":200}]}"#,
        )
        .unwrap();
        let ids: Vec<String> = models_from_list(list, true)
            .into_iter()
            .map(|m| m.id)
            .collect();
        assert_eq!(ids, vec!["gpt-5", "gpt-4o"]);
    }
}
