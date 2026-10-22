//! Requests that run on the person's ChatGPT plan: the model catalog and streaming Responses.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use super::service_error;
use crate::error::{AppError, AppResult};
use crate::providers::lines::{Flow, for_each_line};
use crate::providers::{ChatMessage, ModelInfo, Provider, Role, StreamEvent};

const LIST_TIMEOUT: Duration = Duration::from_secs(15);
/// A deadline for the whole reply, body included.
const REPLY_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Deserialize)]
struct Catalog {
    models: Vec<CatalogModel>,
}

#[derive(Deserialize)]
struct CatalogModel {
    slug: String,
    display_name: String,
    #[serde(default)]
    visibility: Option<String>,
}

pub async fn list_models(
    http: &reqwest::Client,
    base_url: &str,
    access_token: &str,
) -> AppResult<Vec<ModelInfo>> {
    let response = http
        .get(format!("{base_url}/models"))
        .bearer_auth(access_token)
        .header("accept", "application/json")
        .timeout(LIST_TIMEOUT)
        .send()
        .await
        .map_err(network_error)?;
    let status = response.status();
    let body = response.text().await.map_err(network_error)?;
    if !status.is_success() {
        let data = serde_json::from_str(&body).unwrap_or(Value::Null);
        return Err(service_error(&data, Some(status.as_u16())));
    }
    let catalog: Catalog = serde_json::from_str(&body)
        .map_err(|_| AppError::msg("ChatGPT returned an unexpected model list. Try again."))?;
    Ok(catalog
        .models
        .into_iter()
        .filter(|m| m.visibility.as_deref() == Some("list") && !m.slug.trim().is_empty())
        .map(|m| ModelInfo {
            provider: Provider::Chatgpt,
            id: m.slug,
            name: Some(m.display_name).filter(|n| !n.trim().is_empty()),
            detail: None,
        })
        .collect())
}

/// Streams a reply from the Responses API. System messages become `instructions`, and
/// nothing is stored on OpenAI's side (`store: false`).
pub async fn stream_chat(
    http: &reqwest::Client,
    base_url: &str,
    access_token: &str,
    model: &str,
    messages: &[ChatMessage],
    mut emit: impl FnMut(StreamEvent),
) -> AppResult<()> {
    let response = http
        .post(format!("{base_url}/responses"))
        .bearer_auth(access_token)
        .header("accept", "text/event-stream")
        .json(&request_body(model, messages))
        .timeout(REPLY_TIMEOUT)
        .send()
        .await
        .map_err(network_error)?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let data = serde_json::from_str(&body).unwrap_or(Value::Null);
        return Err(service_error(&data, Some(status.as_u16())));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            v.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
        });
    // The stream sometimes arrives without a content type; the events are validated either way.
    if content_type.is_some_and(|t| !t.is_empty() && t != "text/event-stream") {
        return Err(AppError::msg(
            "ChatGPT didn't return a reply stream. Try again.",
        ));
    }

    let mut completed = false;
    for_each_line(response, |line| match parse_line(line)? {
        Event::Text(text) => {
            emit(StreamEvent::Delta { text });
            Ok(Flow::Continue)
        }
        Event::Reasoning(text) => {
            emit(StreamEvent::Reasoning { text });
            Ok(Flow::Continue)
        }
        Event::Completed => {
            completed = true;
            Ok(Flow::Stop)
        }
        Event::Ignore => Ok(Flow::Continue),
    })
    .await
    .map_err(|err| match err {
        AppError::Http(_) => {
            AppError::msg("The connection to ChatGPT dropped mid-reply. Try again.")
        }
        other => other,
    })?;
    if !completed {
        return Err(AppError::msg(
            "The reply ended before ChatGPT finished it. Try again.",
        ));
    }
    Ok(())
}

fn request_body(model: &str, messages: &[ChatMessage]) -> Value {
    let instructions: Vec<&str> = messages
        .iter()
        .filter(|m| m.role == Role::System)
        .map(|m| m.content.as_str())
        .collect();
    let input: Vec<Value> = messages
        .iter()
        .filter(|m| m.role != Role::System)
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect();
    let mut body = json!({ "model": model, "input": input, "store": false, "stream": true });
    if !instructions.is_empty() {
        body["instructions"] = Value::String(instructions.join("\n\n"));
    }
    body
}

#[derive(Debug, PartialEq, Eq)]
enum Event {
    Text(String),
    Reasoning(String),
    Completed,
    Ignore,
}

fn parse_line(line: &str) -> AppResult<Event> {
    let Some(data) = line.strip_prefix("data:").map(str::trim) else {
        // `event:` names repeat the payload's `type`; blank lines and comments carry nothing.
        return Ok(Event::Ignore);
    };
    if data.is_empty() || data == "[DONE]" {
        return Ok(Event::Ignore);
    }
    let event: Value = serde_json::from_str(data)
        .map_err(|_| AppError::msg("ChatGPT sent a malformed reply. Try again."))?;
    let delta = || {
        event
            .get("delta")
            .and_then(Value::as_str)
            .filter(|d| !d.is_empty())
            .map(str::to_string)
    };
    Ok(match event.get("type").and_then(Value::as_str) {
        Some("response.output_text.delta" | "response.refusal.delta") => {
            delta().map_or(Event::Ignore, Event::Text)
        }
        Some("response.reasoning_summary_text.delta") => {
            delta().map_or(Event::Ignore, Event::Reasoning)
        }
        Some("response.completed") => Event::Completed,
        Some("response.failed") => {
            let detail = event.get("response").cloned().unwrap_or(Value::Null);
            return Err(service_error(&detail, None));
        }
        Some("error") => return Err(service_error(&event, None)),
        Some("response.incomplete") => {
            let reason = event
                .pointer("/response/incomplete_details/reason")
                .and_then(Value::as_str);
            return Err(AppError::msg(match reason {
                Some("max_output_tokens") => {
                    "ChatGPT hit its length limit before finishing this reply."
                }
                Some("content_filter") => {
                    "ChatGPT stopped this reply because of its content filter."
                }
                _ => "ChatGPT stopped before finishing this reply. Try again.",
            }));
        }
        _ => Event::Ignore,
    })
}

fn network_error(err: reqwest::Error) -> AppError {
    if err.is_timeout() {
        AppError::msg("ChatGPT took too long to answer. Try again.")
    } else {
        AppError::msg("Couldn't reach ChatGPT. Check your internet connection and try again.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::test_server::{client, serve_once};

    fn messages() -> Vec<ChatMessage> {
        vec![
            ChatMessage {
                role: Role::System,
                content: "Be rigorous.".into(),
            },
            ChatMessage {
                role: Role::User,
                content: "Define a limit.".into(),
            },
            ChatMessage {
                role: Role::Assistant,
                content: "Let ε > 0.".into(),
            },
            ChatMessage {
                role: Role::User,
                content: "Go on.".into(),
            },
        ]
    }

    #[tokio::test]
    async fn streams_a_reply_end_to_end() {
        let (url, server) = serve_once(
            200,
            "text/event-stream",
            vec![
                "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{}}\n\n",
                "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"For every \"}\n\n",
                "data: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"thinking\"}\n\ndata: {\"type\":\"response.output_",
                "text.delta\",\"delta\":\"ε > 0\"}\n\n",
                "data: {\"type\":\"response.completed\",\"response\":{}}\n\n",
            ],
        )
        .await;
        let mut events = Vec::new();
        stream_chat(&client(), &url, "tok", "gpt-test", &messages(), |e| {
            events.push(e)
        })
        .await
        .unwrap();
        assert_eq!(
            events,
            vec![
                StreamEvent::Delta {
                    text: "For every ".into()
                },
                StreamEvent::Reasoning {
                    text: "thinking".into()
                },
                StreamEvent::Delta {
                    text: "ε > 0".into()
                },
            ]
        );

        let request = server.await.unwrap();
        assert!(request.head.starts_with("POST /responses "));
        assert!(
            request
                .head
                .to_ascii_lowercase()
                .contains("authorization: bearer tok")
        );
        let body: Value = serde_json::from_str(&request.body).unwrap();
        assert_eq!(body["model"], "gpt-test");
        assert_eq!(body["store"], false);
        assert_eq!(body["stream"], true);
        assert_eq!(body["instructions"], "Be rigorous.");
        assert_eq!(body["input"].as_array().unwrap().len(), 3);
        assert_eq!(body["input"][1]["role"], "assistant");
    }

    #[tokio::test]
    async fn requires_completion() {
        let (url, _server) = serve_once(
            200,
            "text/event-stream",
            vec!["data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n"],
        )
        .await;
        let mut events = Vec::new();
        let err = stream_chat(&client(), &url, "tok", "m", &messages(), |e| events.push(e))
            .await
            .unwrap_err();
        assert_eq!(events.len(), 1);
        assert!(err.to_string().contains("ended before ChatGPT finished"));
    }

    #[tokio::test]
    async fn explains_plan_errors() {
        let (url, _server) = serve_once(
            429,
            "application/json",
            vec![r#"{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"limit"}}"#],
        )
        .await;
        let err = stream_chat(&client(), &url, "tok", "m", &messages(), |_| {})
            .await
            .unwrap_err();
        assert!(err.to_string().contains("usage limit"), "{err}");
    }

    #[test]
    fn surfaces_failures_mid_stream() {
        let err = parse_line(
            r#"data: {"type":"response.failed","response":{"error":{"code":"model_not_found","message":"no"}}}"#,
        )
        .unwrap_err();
        assert!(err.to_string().contains("isn't available"), "{err}");
        let err = parse_line(
            r#"data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}"#,
        )
        .unwrap_err();
        assert!(err.to_string().contains("length limit"));
        assert_eq!(
            parse_line("event: response.completed").unwrap(),
            Event::Ignore
        );
        assert_eq!(parse_line(": ping").unwrap(), Event::Ignore);
    }

    #[tokio::test]
    async fn lists_visible_models() {
        let (url, server) = serve_once(
            200,
            "application/json",
            vec![
                r#"{"models":[{"slug":"gpt-6","display_name":"GPT-6","visibility":"list"},{"slug":"internal","display_name":"Hidden","visibility":"hide"}]}"#,
            ],
        )
        .await;
        let models = list_models(&client(), &url, "tok").await.unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-6");
        assert_eq!(models[0].name.as_deref(), Some("GPT-6"));
        assert!(server.await.unwrap().head.starts_with("GET /models "));
    }
}
