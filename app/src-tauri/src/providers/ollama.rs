//! Ollama's native API: `GET /api/tags` and streaming `POST /api/chat` (NDJSON).

use std::time::Duration;

use serde::Deserialize;
use serde_json::json;

use super::lines::{Flow, for_each_line};
use super::{
    ChatMessage, ModelInfo, Provider, ProviderStatus, Role, StreamEvent, ToolSpec, data_url_base64,
    error_from_body,
};
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
    let mut models = models_from_tags(tags);
    let capabilities = futures_util::future::join_all(
        models
            .iter()
            .map(|m| fetch_capabilities(client, base_url, &m.id)),
    )
    .await;
    for (model, capabilities) in models.iter_mut().zip(capabilities) {
        if let Some(capabilities) = capabilities {
            model.vision = Some(capabilities.iter().any(|c| c == "vision"));
            model.tools = Some(capabilities.iter().any(|c| c == "tools"));
        }
    }
    Ok(models)
}

#[derive(Deserialize)]
struct ShowResponse {
    #[serde(default)]
    capabilities: Option<Vec<String>>,
}

/// What a model can do (`vision`, `tools`, …), from `/api/show`. Older Ollama versions don't say.
async fn fetch_capabilities(
    client: &reqwest::Client,
    base_url: &str,
    model: &str,
) -> Option<Vec<String>> {
    let response = client
        .post(format!("{base_url}/api/show"))
        .json(&json!({ "model": model }))
        .timeout(LIST_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let show: ShowResponse = response.json().await.ok()?;
    show.capabilities
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
                name: None,
                detail,
                vision: None,
                tools: None,
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
    tools: &[ToolSpec],
    mut emit: impl FnMut(StreamEvent),
) -> AppResult<()> {
    let response = client
        .post(format!("{base_url}/api/chat"))
        .json(&request_body(model, messages, tools))
        .send()
        .await
        .map_err(|err| request_error(err, base_url))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::msg(error_from_body("Ollama", status, &body)));
    }

    let mut finished = false;
    let mut calls = 0;
    for_each_line(response, |line| {
        let (events, done) = parse_line(line)?;
        for mut event in events {
            // Ollama doesn't always number its calls; the results must name the call they answer.
            if let StreamEvent::ToolCall { id, .. } = &mut event {
                calls += 1;
                if id.is_empty() {
                    *id = format!("call_{calls}");
                }
            }
            emit(event);
        }
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

/// Ollama's default context (2–4k tokens, depending on the version) silently cuts long
/// prompts, such as pages of a paper. Requests that won't fit get a larger window, in a few
/// steps so the model is reloaded rarely.
fn context_window(messages: &[ChatMessage]) -> Option<u32> {
    let chars: usize = messages.iter().map(|m| m.content.chars().count()).sum();
    let images: usize = messages.iter().map(|m| m.images.len()).sum();
    // About three characters a token for prose and LaTeX; images cost roughly a page of text.
    let estimate = chars / 3 + images * 1500 + 2048;
    match estimate {
        0..=3500 => None,
        3501..=7000 => Some(8192),
        7001..=14000 => Some(16384),
        _ => Some(32768),
    }
}

/// Ollama takes images as bare base64 next to the text, tool arguments as JSON objects, and
/// tool results as `tool` messages naming the tool.
fn request_body(model: &str, messages: &[ChatMessage], tools: &[ToolSpec]) -> serde_json::Value {
    let wire: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            let mut message = json!({ "role": m.role, "content": m.content });
            if !m.images.is_empty() {
                message["images"] = m.images.iter().map(|i| data_url_base64(i)).collect();
            }
            if !m.tool_calls.is_empty() {
                message["tool_calls"] = m
                    .tool_calls
                    .iter()
                    .map(|call| {
                        let arguments = serde_json::from_str::<serde_json::Value>(&call.arguments)
                            .ok()
                            .filter(serde_json::Value::is_object)
                            .unwrap_or_else(|| json!({}));
                        json!({ "function": { "name": call.name, "arguments": arguments } })
                    })
                    .collect();
            }
            if m.role == Role::Tool
                && let Some(name) = &m.name
            {
                message["tool_name"] = json!(name);
            }
            message
        })
        .collect();
    let mut body = json!({ "model": model, "messages": wire, "stream": true });
    if !tools.is_empty() {
        body["tools"] = tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    },
                })
            })
            .collect();
    }
    if let Some(num_ctx) = context_window(messages) {
        body["options"] = json!({ "num_ctx": num_ctx });
    }
    body
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
    #[serde(default)]
    tool_calls: Vec<ChunkToolCall>,
}

#[derive(Deserialize)]
struct ChunkToolCall {
    #[serde(default)]
    id: Option<String>,
    function: ChunkFunction,
}

#[derive(Deserialize)]
struct ChunkFunction {
    name: String,
    #[serde(default)]
    arguments: serde_json::Value,
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
        for call in message.tool_calls {
            let arguments = match call.function.arguments {
                serde_json::Value::Null => "{}".to_string(),
                serde_json::Value::String(text) => text,
                value => value.to_string(),
            };
            events.push(StreamEvent::ToolCall {
                id: call.id.unwrap_or_default(),
                name: call.function.name,
                arguments,
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
            images: vec!["data:image/png;base64,iVBOR".into()],
            ..Default::default()
        }];
        let mut events = Vec::new();
        stream_chat(&client(), &url, "qwen3:8b", &messages, &[], |e| {
            events.push(e)
        })
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
        assert_eq!(body["messages"][0]["images"][0], "iVBOR");
    }

    #[tokio::test]
    async fn reports_truncated_streams_and_http_errors() {
        let (url, _server) = serve_once(
            200,
            "application/x-ndjson",
            vec!["{\"message\":{\"content\":\"partial\"},\"done\":false}\n"],
        )
        .await;
        let err = stream_chat(&client(), &url, "m", &[], &[], |_| {})
            .await
            .unwrap_err();
        assert!(err.to_string().contains("before finishing"));

        let (url, _server) = serve_once(
            404,
            "application/json",
            vec![r#"{"error":"model \"nope\" not found, try pulling it first"}"#],
        )
        .await;
        let err = stream_chat(&client(), &url, "nope", &[], &[], |_| {})
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

    #[tokio::test]
    async fn streams_tool_calls_and_numbers_them() {
        let (url, server) = serve_once(
            200,
            "application/x-ndjson",
            vec![
                "{\"message\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"function\":{\"name\":\"read_document\",\"arguments\":{}}},{\"function\":{\"name\":\"check_lean\",\"arguments\":{\"code\":\"example : 1 = 1 := rfl\"}}}]},\"done\":false}\n",
                "{\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true}\n",
            ],
        )
        .await;
        let tools = [ToolSpec {
            name: "check_lean".into(),
            description: "Check a Lean file.".into(),
            parameters: json!({ "type": "object" }),
        }];
        let history = [
            ChatMessage::text(Role::User, "Formalize it."),
            ChatMessage {
                role: Role::Assistant,
                tool_calls: vec![crate::providers::ToolCall {
                    id: "call_1".into(),
                    name: "check_lean".into(),
                    arguments: r#"{"code":"x"}"#.into(),
                }],
                ..Default::default()
            },
            ChatMessage {
                role: Role::Tool,
                content: "errors".into(),
                tool_call_id: Some("call_1".into()),
                name: Some("check_lean".into()),
                ..Default::default()
            },
        ];
        let mut events = Vec::new();
        stream_chat(&client(), &url, "qwen3:8b", &history, &tools, |e| {
            events.push(e)
        })
        .await
        .unwrap();
        assert_eq!(
            events,
            vec![
                StreamEvent::ToolCall {
                    id: "call_1".into(),
                    name: "read_document".into(),
                    arguments: "{}".into(),
                },
                StreamEvent::ToolCall {
                    id: "call_2".into(),
                    name: "check_lean".into(),
                    arguments: r#"{"code":"example : 1 = 1 := rfl"}"#.into(),
                },
            ]
        );

        let body: serde_json::Value = serde_json::from_str(&server.await.unwrap().body).unwrap();
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["function"]["name"], "check_lean");
        // Arguments go back as objects, and results name their tool.
        assert_eq!(
            body["messages"][1]["tool_calls"][0]["function"]["arguments"]["code"],
            "x"
        );
        assert_eq!(body["messages"][2]["role"], "tool");
        assert_eq!(body["messages"][2]["tool_name"], "check_lean");
    }

    #[test]
    fn surfaces_stream_errors() {
        let err = parse_line(r#"{"error":"model requires more system memory"}"#).unwrap_err();
        assert_eq!(err.to_string(), "Ollama: model requires more system memory");
        assert!(parse_line("   ").unwrap().0.is_empty());
    }

    #[test]
    fn sizes_the_context_to_the_request() {
        let short = [ChatMessage::text(Role::User, "Prove it.")];
        assert_eq!(request_body("m", &short, &[]).get("options"), None);
        let pages = [ChatMessage {
            role: Role::User,
            content: "x".repeat(9000),
            images: vec!["data:image/jpeg;base64,AAAA".into(); 3],
            ..Default::default()
        }];
        let body = request_body("m", &pages, &[]);
        assert_eq!(body["options"]["num_ctx"], 16384);
        assert_eq!(body["messages"][0]["images"][2], "AAAA");
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
