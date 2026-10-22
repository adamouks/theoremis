//! Ollama's native API: `GET /api/tags` and streaming `POST /api/chat` (NDJSON).

use std::time::Duration;

use serde::Deserialize;
use serde_json::json;

use super::lines::{Flow, for_each_line};
use super::{ChatMessage, ModelInfo, Provider, ProviderStatus, StreamEvent, error_from_body};
use crate::error::{AppError, AppResult};

const LIST_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Deserialize)]
struct TagsResponse {
    #[serde(default)]
    models: Vec<TagModel>,
}

#[derive(Deserialize)]
struct TagModel {
    name: String,
    #[serde(default)]
    details: Option<TagDetails>,
}

#[derive(Deserialize)]
struct TagDetails {
    #[serde(default)]
    parameter_size: Option<String>,
    #[serde(default)]
    quantization_level: Option<String>,
}

pub async fn list_models(client: &reqwest::Client, base_url: &str) -> ProviderStatus {
    match fetch_models(client, base_url).await {
        Ok(models) if models.is_empty() => ProviderStatus {
            provider: Provider::Ollama,
            available: true,
            models,
            message: Some(
                "Ollama is running but has no models. Try `ollama pull llama3.2`.".into(),
            ),
        },
        Ok(models) => ProviderStatus {
            provider: Provider::Ollama,
            available: true,
            models,
            message: None,
        },
        Err(err) => ProviderStatus {
            provider: Provider::Ollama,
            available: false,
            models: Vec::new(),
            message: Some(err.to_string()),
        },
    }
}

async fn fetch_models(client: &reqwest::Client, base_url: &str) -> AppResult<Vec<ModelInfo>> {
    let response = client
        .get(format!("{base_url}/api/tags"))
        .timeout(LIST_TIMEOUT)
        .send()
        .await
        .map_err(|err| request_error(err, base_url))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::msg(error_from_body("Ollama", status, &body)));
    }
    let tags: TagsResponse = response.json().await?;
    Ok(models_from_tags(tags))
}

fn models_from_tags(tags: TagsResponse) -> Vec<ModelInfo> {
    let mut models: Vec<ModelInfo> = tags
        .models
        .into_iter()
        // Embedding models can't chat; their names conventionally say so.
        .filter(|m| !m.name.contains("embed"))
        .map(|m| {
            let detail = m.details.and_then(|d| {
                let parts: Vec<String> = [d.parameter_size, d.quantization_level]
                    .into_iter()
                    .flatten()
                    .filter(|s| !s.is_empty())
                    .collect();
                (!parts.is_empty()).then(|| parts.join(" · "))
            });
            ModelInfo {
                provider: Provider::Ollama,
                id: m.name,
                detail,
            }
        })
        .collect();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models
}

pub async fn stream_chat(
    client: &reqwest::Client,
    base_url: &str,
    model: &str,
    messages: &[ChatMessage],
    mut emit: impl FnMut(StreamEvent),
) -> AppResult<()> {
    let response = client
        .post(format!("{base_url}/api/chat"))
        .json(&json!({ "model": model, "messages": messages, "stream": true }))
        .send()
        .await
        .map_err(|err| request_error(err, base_url))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::msg(error_from_body("Ollama", status, &body)));
    }

    let mut finished = false;
    for_each_line(response, |line| {
        let (events, done) = parse_line(line)?;
        events.into_iter().for_each(&mut emit);
        if done {
            finished = true;
            return Ok(Flow::Stop);
        }
        Ok(Flow::Continue)
    })
    .await?;

    if finished {
        Ok(())
    } else {
        Err(AppError::msg(
            "Ollama closed the connection before finishing the reply.",
        ))
    }
}

#[derive(Deserialize)]
struct ChatChunk {
    #[serde(default)]
    message: Option<ChunkMessage>,
    #[serde(default)]
    done: bool,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize)]
struct ChunkMessage {
    #[serde(default)]
    content: String,
    #[serde(default)]
    thinking: Option<String>,
}

/// Parses one NDJSON line from `/api/chat`, returning its events and whether the reply is done.
fn parse_line(line: &str) -> AppResult<(Vec<StreamEvent>, bool)> {
    let line = line.trim();
    if line.is_empty() {
        return Ok((Vec::new(), false));
    }
    let chunk: ChatChunk = serde_json::from_str(line)?;
    if let Some(error) = chunk.error {
        return Err(AppError::msg(format!("Ollama: {error}")));
    }
    let mut events = Vec::new();
    if let Some(message) = chunk.message {
        if let Some(thinking) = message.thinking.filter(|t| !t.is_empty()) {
            events.push(StreamEvent::Reasoning { text: thinking });
        }
        if !message.content.is_empty() {
            events.push(StreamEvent::Delta {
                text: message.content,
            });
        }
    }
    Ok((events, chunk.done))
}

fn request_error(err: reqwest::Error, base_url: &str) -> AppError {
    if err.is_connect() || err.is_timeout() {
        AppError::msg(format!(
            "Couldn't reach Ollama at {base_url}. Make sure it's installed (ollama.com) and running (`ollama serve`)."
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
            "application/x-ndjson",
            vec![
                "{\"message\":{\"role\":\"assistant\",\"content\":\"By contra\"},\"done\":false}\n{\"mess",
                "age\":{\"role\":\"assistant\",\"content\":\"diction…\"},\"done\":false}\n",
                "{\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true}\n",
            ],
        )
        .await;
        let messages = vec![ChatMessage {
            role: Role::User,
            content: "Prove √2 is irrational".into(),
        }];
        let mut events = Vec::new();
        stream_chat(&client(), &url, "qwen3:8b", &messages, |e| events.push(e))
            .await
            .unwrap();
        assert_eq!(
            events,
            vec![
                StreamEvent::Delta {
                    text: "By contra".into()
                },
                StreamEvent::Delta {
                    text: "diction…".into()
                },
            ]
        );

        let request = server.await.unwrap();
        assert!(request.head.starts_with("POST /api/chat "));
        let body: serde_json::Value = serde_json::from_str(&request.body).unwrap();
        assert_eq!(body["model"], "qwen3:8b");
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"][0]["role"], "user");
    }

    #[tokio::test]
    async fn reports_truncated_streams_and_http_errors() {
        let (url, _server) = serve_once(
            200,
            "application/x-ndjson",
            vec!["{\"message\":{\"content\":\"partial\"},\"done\":false}\n"],
        )
        .await;
        let err = stream_chat(&client(), &url, "m", &[], |_| {})
            .await
            .unwrap_err();
        assert!(err.to_string().contains("before finishing"));

        let (url, _server) = serve_once(
            404,
            "application/json",
            vec![r#"{"error":"model \"nope\" not found, try pulling it first"}"#],
        )
        .await;
        let err = stream_chat(&client(), &url, "nope", &[], |_| {})
            .await
            .unwrap_err();
        assert!(err.to_string().contains("try pulling it first"), "{err}");
    }

    #[tokio::test]
    async fn explains_when_ollama_is_not_running() {
        // Bind then drop a listener to get a local port nobody is listening on.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let status = list_models(&client(), &format!("http://127.0.0.1:{port}")).await;
        assert!(!status.available);
        assert!(status.message.unwrap().contains("Couldn't reach Ollama"));
    }

    #[test]
    fn parses_content_thinking_and_done() {
        let (events, done) = parse_line(
            r#"{"model":"qwen3","message":{"role":"assistant","content":"","thinking":"Let n be"},"done":false}"#,
        )
        .unwrap();
        assert_eq!(
            events,
            vec![StreamEvent::Reasoning {
                text: "Let n be".into()
            }]
        );
        assert!(!done);

        let (events, done) =
            parse_line(r#"{"message":{"role":"assistant","content":"QED"},"done":false}"#).unwrap();
        assert_eq!(events, vec![StreamEvent::Delta { text: "QED".into() }]);
        assert!(!done);

        let (events, done) = parse_line(
            r#"{"message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","eval_count":42}"#,
        )
        .unwrap();
        assert!(events.is_empty());
        assert!(done);
    }

    #[test]
    fn surfaces_stream_errors() {
        let err = parse_line(r#"{"error":"model requires more system memory"}"#).unwrap_err();
        assert_eq!(err.to_string(), "Ollama: model requires more system memory");
        assert!(parse_line("   ").unwrap().0.is_empty());
    }

    #[test]
    fn builds_model_list() {
        let tags: TagsResponse = serde_json::from_str(
            r#"{"models":[
                {"name":"qwen3:8b","details":{"parameter_size":"8.2B","quantization_level":"Q4_K_M"}},
                {"name":"nomic-embed-text:latest","details":{}},
                {"name":"llama3.2:latest"}
            ]}"#,
        )
        .unwrap();
        let models = models_from_tags(tags);
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["llama3.2:latest", "qwen3:8b"]);
        assert_eq!(models[0].detail, None);
        assert_eq!(models[1].detail.as_deref(), Some("8.2B · Q4_K_M"));
    }
}
