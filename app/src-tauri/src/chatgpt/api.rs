//! Requests that run on the person's ChatGPT plan: the model catalog and streaming Responses.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use super::service_error;
use crate::error::{AppError, AppResult};
use crate::providers::lines::{Flow, for_each_line};
use crate::providers::{
    ChatMessage, Effort, ModelInfo, Provider, Role, StreamEvent, ToolSpec, sort_efforts,
};

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
    /// The reasoning efforts the model takes, e.g. `low` to `xhigh`.
    #[serde(default)]
    supported_reasoning_levels: Vec<CatalogLevel>,
    #[serde(default)]
    default_reasoning_level: Option<String>,
}

/// An effort as the catalog lists it: with a description, or as a bare name.
#[derive(Deserialize)]
#[serde(untagged)]
enum CatalogLevel {
    Described {
        effort: String,
        #[serde(default)]
        description: Option<String>,
    },
    Named(String),
}

impl From<CatalogLevel> for Effort {
    fn from(level: CatalogLevel) -> Self {
        match level {
            CatalogLevel::Described {
                effort,
                description,
            } => Effort {
                id: effort,
                description: description.filter(|d| !d.trim().is_empty()),
            },
            CatalogLevel::Named(effort) => Effort {
                id: effort,
                description: None,
            },
        }
    }
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
        .map(|m| {
            let efforts = sort_efforts(
                m.supported_reasoning_levels
                    .into_iter()
                    .map(Effort::from)
                    .collect(),
            );
            let default_effort = m
                .default_reasoning_level
                .filter(|d| efforts.iter().any(|e| &e.id == d));
            ModelInfo {
                provider: Provider::Chatgpt,
                id: m.slug,
                name: Some(m.display_name).filter(|n| !n.trim().is_empty()),
                detail: None,
                // Every model offered to ChatGPT plans reads images and calls tools.
                vision: Some(true),
                tools: Some(true),
                efforts,
                default_effort,
            }
        })
        .collect())
}

/// Streams a reply from the Responses API. System messages become `instructions`, and
/// nothing is stored on OpenAI's side (`store: false`).
///
/// With an `effort`, the model is asked to think that hard and to summarize its reasoning,
/// which the frontend shows as the model's thinking.
///
/// With tools, the reply's output items (reasoning, text and calls) are also sent to the
/// frontend as [`StreamEvent::Opaque`], to be passed back verbatim with the tool results.
/// Reasoning comes encrypted for that, so the model keeps its train of thought between calls
/// although nothing is stored.
///
/// A model that refuses one of these (encrypted reasoning, summaries, the effort) is asked
/// again without it.
#[allow(clippy::too_many_arguments)]
pub async fn stream_chat(
    http: &reqwest::Client,
    base_url: &str,
    access_token: &str,
    model: &str,
    effort: Option<&str>,
    messages: &[ChatMessage],
    tools: &[ToolSpec],
    mut emit: impl FnMut(StreamEvent),
) -> AppResult<()> {
    let mut options = Options {
        keep_items: !tools.is_empty(),
        effort,
        summary: effort.is_some(),
    };
    let response = loop {
        let body = request_body(model, messages, tools, options);
        match post(http, base_url, access_token, &body).await? {
            Sent::Accepted(response) => break response,
            Sent::Rejected(status, body) => match options.without_refused(&body) {
                Some(fewer) if status == 400 => options = fewer,
                _ => {
                    let data = serde_json::from_str(&body).unwrap_or(Value::Null);
                    return Err(service_error(&data, Some(status)));
                }
            },
        }
    };
    let keep_items = options.keep_items;
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
        Event::Item(item) => {
            if item.get("type").and_then(Value::as_str) == Some("function_call") {
                let field = |key: &str| item.get(key).and_then(Value::as_str).unwrap_or_default();
                emit(StreamEvent::ToolCall {
                    id: field("call_id").to_string(),
                    name: field("name").to_string(),
                    arguments: field("arguments").to_string(),
                });
            }
            if keep_items {
                emit(StreamEvent::Opaque { item });
            }
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

/// What a request asks of the model besides the conversation. Each can be dropped if refused.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Options<'a> {
    /// Send turns back as the items they came from, encrypted reasoning included.
    keep_items: bool,
    /// How hard to think (`low`, `high`…), for a model that offers a choice.
    effort: Option<&'a str>,
    /// Ask for summaries of the reasoning.
    summary: bool,
}

impl Options<'_> {
    /// The options without the one a 400 objects to, or `None` if it objects to none of them.
    fn without_refused(self, body: &str) -> Option<Self> {
        if self.keep_items && refuses_encrypted_reasoning(body) {
            return Some(Self {
                keep_items: false,
                ..self
            });
        }
        let param = refused_param(body);
        let names = |name: &str| param.as_deref() == Some(name) || body.contains(name);
        if self.summary && names("reasoning.summary") {
            return Some(Self {
                summary: false,
                ..self
            });
        }
        if self.effort.is_some()
            && (names("reasoning.effort") || param.as_deref() == Some("reasoning"))
        {
            return Some(Self {
                effort: None,
                summary: false,
                ..self
            });
        }
        None
    }
}

/// Whether a 400 is about the `include` of encrypted reasoning, which some models don't support.
fn refuses_encrypted_reasoning(body: &str) -> bool {
    let body = body.to_ascii_lowercase();
    body.contains("encrypted") || body.contains("\"param\":\"include\"")
}

/// The request parameter an error names, as in `{"error":{"param":"reasoning.effort"}}`.
fn refused_param(body: &str) -> Option<String> {
    let data: Value = serde_json::from_str(body).ok()?;
    data.pointer("/error/param")?.as_str().map(str::to_string)
}

enum Sent {
    Accepted(reqwest::Response),
    /// The status and body of a refusal.
    Rejected(u16, String),
}

async fn post(
    http: &reqwest::Client,
    base_url: &str,
    access_token: &str,
    body: &Value,
) -> AppResult<Sent> {
    let response = http
        .post(format!("{base_url}/responses"))
        .bearer_auth(access_token)
        .header("accept", "text/event-stream")
        .json(body)
        .timeout(REPLY_TIMEOUT)
        .send()
        .await
        .map_err(network_error)?;
    let status = response.status();
    if status.is_success() {
        Ok(Sent::Accepted(response))
    } else {
        let body = response.text().await.unwrap_or_default();
        Ok(Sent::Rejected(status.as_u16(), body))
    }
}

/// The request for `messages`. With `keep_items`, an assistant turn that carries the output
/// items it came from is sent as those items, encrypted reasoning included; otherwise its text
/// and tool calls are written out afresh.
fn request_body(
    model: &str,
    messages: &[ChatMessage],
    tools: &[ToolSpec],
    options: Options,
) -> Value {
    let keep_items = options.keep_items;
    let instructions: Vec<&str> = messages
        .iter()
        .filter(|m| m.role == Role::System)
        .map(|m| m.content.as_str())
        .collect();
    let mut input: Vec<Value> = Vec::new();
    for m in messages {
        match m.role {
            Role::System => {}
            Role::User if !m.images.is_empty() => {
                let mut content = vec![json!({ "type": "input_text", "text": m.content })];
                content.extend(m.images.iter().map(
                    |url| json!({ "type": "input_image", "image_url": url, "detail": "high" }),
                ));
                input.push(json!({ "role": m.role, "content": content }));
            }
            Role::User => input.push(json!({ "role": m.role, "content": m.content })),
            Role::Assistant if keep_items && !m.opaque.is_empty() => {
                input.extend(m.opaque.iter().cloned());
            }
            Role::Assistant => {
                if !m.content.is_empty() || m.tool_calls.is_empty() {
                    input.push(json!({ "role": m.role, "content": m.content }));
                }
                input.extend(m.tool_calls.iter().map(|call| {
                    json!({
                        "type": "function_call",
                        "call_id": call.id,
                        "name": call.name,
                        "arguments": call.arguments,
                    })
                }));
            }
            Role::Tool => input.push(json!({
                "type": "function_call_output",
                "call_id": m.tool_call_id.as_deref().unwrap_or_default(),
                "output": m.content,
            })),
        }
    }
    let mut body = json!({ "model": model, "input": input, "store": false, "stream": true });
    if !instructions.is_empty() {
        body["instructions"] = Value::String(instructions.join("\n\n"));
    }
    if !tools.is_empty() {
        body["tools"] = tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                    "strict": false,
                })
            })
            .collect();
        if keep_items {
            body["include"] = json!(["reasoning.encrypted_content"]);
        }
    }
    if let Some(effort) = options.effort {
        body["reasoning"] = if options.summary {
            json!({ "effort": effort, "summary": "auto" })
        } else {
            json!({ "effort": effort })
        };
    }
    body
}

#[derive(Debug, PartialEq)]
enum Event {
    Text(String),
    Reasoning(String),
    /// A finished output item: reasoning, a message or a tool call.
    Item(Value),
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
        Some("response.output_item.done") => event
            .get("item")
            .filter(|item| item.is_object())
            .cloned()
            .map_or(Event::Ignore, Event::Item),
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
    use crate::providers::ToolCall;
    use crate::providers::test_server::{client, serve_each, serve_once};

    fn messages() -> Vec<ChatMessage> {
        vec![
            ChatMessage::text(Role::System, "Be rigorous."),
            ChatMessage::text(Role::User, "Define a limit."),
            ChatMessage::text(Role::Assistant, "Let ε > 0."),
            ChatMessage {
                role: Role::User,
                content: "Go on.".into(),
                images: vec!["data:image/png;base64,iVBOR".into()],
                ..Default::default()
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
        stream_chat(
            &client(),
            &url,
            "tok",
            "gpt-test",
            None,
            &messages(),
            &[],
            |e| events.push(e),
        )
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
        assert_eq!(body["input"][0]["content"], "Define a limit.");
        assert_eq!(body["input"][1]["role"], "assistant");
        let parts = body["input"][2]["content"].as_array().unwrap();
        assert_eq!(parts[0], json!({ "type": "input_text", "text": "Go on." }));
        assert_eq!(parts[1]["type"], "input_image");
        assert_eq!(parts[1]["image_url"], "data:image/png;base64,iVBOR");
        assert!(body.get("tools").is_none());
        assert!(body.get("include").is_none());
    }

    fn tools() -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: "check_lean".into(),
            description: "Check a Lean file.".into(),
            parameters: json!({ "type": "object", "properties": { "code": { "type": "string" } } }),
        }]
    }

    #[tokio::test]
    async fn streams_tool_calls_and_the_items_to_send_back() {
        let (url, server) = serve_once(
            200,
            "text/event-stream",
            vec![
                "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"reasoning\",\"id\":\"rs_1\",\"summary\":[],\"encrypted_content\":\"gAAA\"}}\n\n",
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Checking.\"}\n\n",
                "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"function_call\",\"id\":\"fc_1\",\"call_id\":\"call_1\",\"name\":\"check_lean\",\"arguments\":\"{\\\"code\\\":\\\"example : 1 = 1 := rfl\\\"}\"}}\n\n",
                "data: {\"type\":\"response.completed\",\"response\":{}}\n\n",
            ],
        )
        .await;
        let mut events = Vec::new();
        stream_chat(
            &client(),
            &url,
            "tok",
            "m",
            None,
            &messages(),
            &tools(),
            |e| events.push(e),
        )
        .await
        .unwrap();
        assert_eq!(events.len(), 4);
        assert!(
            matches!(&events[0], StreamEvent::Opaque { item } if item["encrypted_content"] == "gAAA")
        );
        assert_eq!(
            events[1],
            StreamEvent::Delta {
                text: "Checking.".into()
            }
        );
        assert_eq!(
            events[2],
            StreamEvent::ToolCall {
                id: "call_1".into(),
                name: "check_lean".into(),
                arguments: r#"{"code":"example : 1 = 1 := rfl"}"#.into(),
            }
        );
        assert!(matches!(&events[3], StreamEvent::Opaque { item } if item["id"] == "fc_1"));

        let body: Value = serde_json::from_str(&server.await.unwrap().body).unwrap();
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["name"], "check_lean");
        assert_eq!(body["tools"][0]["parameters"]["type"], "object");
        assert_eq!(body["include"], json!(["reasoning.encrypted_content"]));
    }

    #[test]
    fn sends_tool_turns_back() {
        let call = ToolCall {
            id: "call_1".into(),
            name: "check_lean".into(),
            arguments: "{}".into(),
        };
        let history = vec![
            ChatMessage::text(Role::User, "Formalize it."),
            ChatMessage {
                role: Role::Assistant,
                content: "Checking.".into(),
                tool_calls: vec![call],
                opaque: vec![
                    json!({ "type": "reasoning", "id": "rs_1", "summary": [], "encrypted_content": "gAAA" }),
                    json!({ "type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "check_lean", "arguments": "{}" }),
                ],
                ..Default::default()
            },
            ChatMessage {
                role: Role::Tool,
                content: "accepted".into(),
                tool_call_id: Some("call_1".into()),
                name: Some("check_lean".into()),
                ..Default::default()
            },
        ];
        // The items as ChatGPT produced them, encrypted reasoning included.
        let kept = request_body(
            "m",
            &history,
            &tools(),
            Options {
                keep_items: true,
                effort: None,
                summary: false,
            },
        );
        let input = kept["input"].as_array().unwrap();
        assert_eq!(input.len(), 4);
        assert_eq!(input[1]["encrypted_content"], "gAAA");
        assert_eq!(input[2]["id"], "fc_1");
        assert_eq!(
            input[3],
            json!({ "type": "function_call_output", "call_id": "call_1", "output": "accepted" })
        );
        // Without them, the turn is written out from its text and calls.
        let fresh = request_body(
            "m",
            &history,
            &tools(),
            Options {
                keep_items: false,
                effort: None,
                summary: false,
            },
        );
        let input = fresh["input"].as_array().unwrap();
        assert_eq!(input.len(), 4);
        assert_eq!(
            input[1],
            json!({ "role": "assistant", "content": "Checking." })
        );
        assert_eq!(
            input[2],
            json!({ "type": "function_call", "call_id": "call_1", "name": "check_lean", "arguments": "{}" })
        );
        assert!(fresh.get("include").is_none());
    }

    #[tokio::test]
    async fn asks_again_without_encrypted_reasoning_when_refused() {
        let (url, server) = serve_each(vec![
            (
                400,
                "application/json",
                vec![
                    r#"{"error":{"message":"Encrypted content is not supported with this model.","param":"include","code":"unsupported_parameter"}}"#,
                ],
            ),
            (
                200,
                "text/event-stream",
                vec![
                    "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"function_call\",\"id\":\"fc_1\",\"call_id\":\"call_1\",\"name\":\"check_lean\",\"arguments\":\"{}\"}}\n\n",
                    "data: {\"type\":\"response.completed\",\"response\":{}}\n\n",
                ],
            ),
        ])
        .await;
        let mut events = Vec::new();
        stream_chat(
            &client(),
            &url,
            "tok",
            "m",
            None,
            &messages(),
            &tools(),
            |e| events.push(e),
        )
        .await
        .unwrap();
        // Only the call: without encrypted reasoning there is nothing to send back verbatim.
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0], StreamEvent::ToolCall { name, .. } if name == "check_lean"));
        let requests = server.await.unwrap();
        let first: Value = serde_json::from_str(&requests[0].body).unwrap();
        let second: Value = serde_json::from_str(&requests[1].body).unwrap();
        assert!(first.get("include").is_some());
        assert!(second.get("include").is_none());
        assert!(second.get("tools").is_some());
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
        let err = stream_chat(&client(), &url, "tok", "m", None, &messages(), &[], |e| {
            events.push(e)
        })
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
        let err = stream_chat(&client(), &url, "tok", "m", None, &messages(), &[], |_| {})
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
        assert!(models[0].efforts.is_empty());
        assert!(server.await.unwrap().head.starts_with("GET /models "));
    }

    #[tokio::test]
    async fn lists_each_models_efforts_least_first() {
        let (url, _server) = serve_once(
            200,
            "application/json",
            vec![
                r#"{"models":[{"slug":"gpt-6","display_name":"GPT-6","visibility":"list","default_reasoning_level":"medium","supported_reasoning_levels":[{"effort":"high","description":"Thinks hard"},{"effort":"low","description":""},"xhigh",{"effort":"medium"}]},{"slug":"gpt-6-mini","display_name":"Mini","visibility":"list","default_reasoning_level":"max"}]}"#,
            ],
        )
        .await;
        let models = list_models(&client(), &url, "tok").await.unwrap();
        let ids: Vec<&str> = models[0].efforts.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["low", "medium", "high", "xhigh"]);
        assert_eq!(
            models[0].efforts[2].description.as_deref(),
            Some("Thinks hard")
        );
        assert_eq!(models[0].efforts[0].description, None);
        assert_eq!(models[0].default_effort.as_deref(), Some("medium"));
        // A default the model doesn't list is no default.
        assert!(models[1].efforts.is_empty());
        assert_eq!(models[1].default_effort, None);
    }

    #[test]
    fn asks_for_the_effort_and_reasoning_summaries() {
        let options = |effort, summary| Options {
            keep_items: false,
            effort,
            summary,
        };
        let body = request_body("m", &messages(), &[], options(Some("high"), true));
        assert_eq!(
            body["reasoning"],
            json!({ "effort": "high", "summary": "auto" })
        );
        let body = request_body("m", &messages(), &[], options(Some("low"), false));
        assert_eq!(body["reasoning"], json!({ "effort": "low" }));
        assert!(
            request_body("m", &messages(), &[], options(None, false))
                .get("reasoning")
                .is_none()
        );
    }

    #[test]
    fn drops_only_what_a_refusal_names() {
        let all = Options {
            keep_items: true,
            effort: Some("xhigh"),
            summary: true,
        };
        let refusal =
            |param: &str| format!(r#"{{"error":{{"message":"Unsupported.","param":"{param}"}}}}"#);
        assert_eq!(
            all.without_refused(&refusal("include")),
            Some(Options {
                keep_items: false,
                ..all
            })
        );
        assert_eq!(
            all.without_refused(&refusal("reasoning.summary")),
            Some(Options {
                summary: false,
                ..all
            })
        );
        assert_eq!(
            all.without_refused(&refusal("reasoning.effort")),
            Some(Options {
                effort: None,
                summary: false,
                ..all
            })
        );
        assert_eq!(all.without_refused(&refusal("tools")), None);
        assert_eq!(all.without_refused("not json"), None);
    }

    #[tokio::test]
    async fn asks_again_without_an_effort_the_model_refuses() {
        let (url, server) = serve_each(vec![
            (
                400,
                "application/json",
                vec![r#"{"error":{"message":"Reasoning summaries are not supported.","param":"reasoning.summary"}}"#],
            ),
            (
                400,
                "application/json",
                vec![r#"{"error":{"message":"Unsupported value: 'xhigh'.","param":"reasoning.effort"}}"#],
            ),
            (
                200,
                "text/event-stream",
                vec![
                    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Done.\"}\n\n",
                    "data: {\"type\":\"response.completed\",\"response\":{}}\n\n",
                ],
            ),
        ])
        .await;
        let mut events = Vec::new();
        stream_chat(
            &client(),
            &url,
            "tok",
            "m",
            Some("xhigh"),
            &messages(),
            &[],
            |e| events.push(e),
        )
        .await
        .unwrap();
        assert_eq!(
            events,
            vec![StreamEvent::Delta {
                text: "Done.".into()
            }]
        );
        let bodies: Vec<Value> = server
            .await
            .unwrap()
            .iter()
            .map(|r| serde_json::from_str(&r.body).unwrap())
            .collect();
        assert_eq!(
            bodies[0]["reasoning"],
            json!({ "effort": "xhigh", "summary": "auto" })
        );
        assert_eq!(bodies[1]["reasoning"], json!({ "effort": "xhigh" }));
        assert!(bodies[2].get("reasoning").is_none());
    }
}
