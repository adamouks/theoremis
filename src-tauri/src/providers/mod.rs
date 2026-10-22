pub mod lines;
pub mod ollama;
pub mod openai;
#[cfg(test)]
mod test_server;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Ollama,
    Openai,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

/// Incremental output sent to the frontend while a reply streams in.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    /// A piece of the visible answer.
    Delta { text: String },
    /// A piece of the model's reasoning, for models that expose it.
    Reasoning { text: String },
    /// Always the last event. Channel messages and the command's result travel separately,
    /// so this tells the frontend that no more deltas are in flight.
    Done,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub provider: Provider,
    pub id: String,
    /// Short secondary text, e.g. parameter size and quantization.
    pub detail: Option<String>,
}

/// Models offered by one provider, or why none are available.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: Provider,
    pub available: bool,
    pub models: Vec<ModelInfo>,
    pub message: Option<String>,
}

/// Turns a non-success HTTP response body into a readable message.
///
/// Understands OpenAI's `{"error":{"message":…}}` and Ollama's `{"error":"…"}` shapes.
pub fn error_from_body(service: &str, status: reqwest::StatusCode, body: &str) -> String {
    let detail = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            let error = value.get("error")?;
            error
                .get("message")
                .and_then(|m| m.as_str())
                .or_else(|| error.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.trim().chars().take(300).collect());
    let reason = status.canonical_reason().unwrap_or("");
    if detail.is_empty() {
        format!("{service} returned {} {reason}", status.as_u16())
    } else {
        format!("{service} returned {} {reason}: {detail}", status.as_u16())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::StatusCode;

    #[test]
    fn error_body_shapes() {
        assert_eq!(
            error_from_body(
                "OpenAI",
                StatusCode::UNAUTHORIZED,
                r#"{"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}"#
            ),
            "OpenAI returned 401 Unauthorized: Incorrect API key provided"
        );
        assert_eq!(
            error_from_body(
                "Ollama",
                StatusCode::NOT_FOUND,
                r#"{"error":"model 'llama9' not found"}"#
            ),
            "Ollama returned 404 Not Found: model 'llama9' not found"
        );
        assert_eq!(
            error_from_body("Ollama", StatusCode::BAD_GATEWAY, ""),
            "Ollama returned 502 Bad Gateway"
        );
    }

    #[test]
    fn stream_event_wire_format() {
        let json = serde_json::to_string(&StreamEvent::Delta { text: "hi".into() }).unwrap();
        assert_eq!(json, r#"{"type":"delta","text":"hi"}"#);
        let json = serde_json::to_string(&StreamEvent::Done).unwrap();
        assert_eq!(json, r#"{"type":"done"}"#);
    }
}
