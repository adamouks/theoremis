pub mod lines;
pub mod ollama;
#[cfg(test)]
pub mod test_server;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Ollama,
    /// The person's ChatGPT plan, via Sign in with ChatGPT. Older settings call it `openai`.
    #[serde(alias = "openai")]
    Chatgpt,
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
    /// Images the message shows the model, as `data:image/…;base64,…` URLs: pages of an
    /// imported paper, a photo of handwritten notes, an attached figure.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
}

impl ChatMessage {
    #[cfg(test)]
    pub fn text(role: Role, content: &str) -> Self {
        Self {
            role,
            content: content.into(),
            images: Vec::new(),
        }
    }
}

/// The base64 payload of a `data:` URL, for APIs that take bare base64.
pub fn data_url_base64(url: &str) -> &str {
    match url.split_once(";base64,") {
        Some((head, data)) if head.starts_with("data:") => data,
        _ => url,
    }
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
    /// A friendlier display name, when the provider has one.
    pub name: Option<String>,
    /// Short secondary text, e.g. parameter size and quantization.
    pub detail: Option<String>,
    /// Whether the model reads images, when the provider says.
    pub vision: Option<bool>,
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
/// Understands `{"error":{"message":…}}` and Ollama's `{"error":"…"}` shapes.
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
    fn data_urls() {
        assert_eq!(data_url_base64("data:image/png;base64,iVBOR"), "iVBOR");
        assert_eq!(data_url_base64("iVBOR"), "iVBOR");
        let message: ChatMessage =
            serde_json::from_str(r#"{"role":"user","content":"hi"}"#).unwrap();
        assert!(message.images.is_empty());
        assert_eq!(
            serde_json::to_string(&message).unwrap(),
            r#"{"role":"user","content":"hi"}"#
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
