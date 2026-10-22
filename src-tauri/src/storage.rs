//! Conversations, one JSON file each under the app data directory.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::providers::Role;
use crate::settings::ModelRef;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub id: String,
    pub role: Role,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub model: Option<ModelRef>,
    #[serde(default)]
    pub messages: Vec<StoredMessage>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub updated_at: i64,
    pub model: Option<ModelRef>,
}

pub struct ConversationStore {
    dir: PathBuf,
}

impl ConversationStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub async fn list(&self) -> AppResult<Vec<ConversationSummary>> {
        let mut entries = match tokio::fs::read_dir(&self.dir).await {
            Ok(entries) => entries,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(err.into()),
        };
        let mut summaries = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            // A single unreadable file shouldn't hide every other conversation.
            if let Ok(conversation) = read_conversation(&path).await {
                summaries.push(ConversationSummary {
                    id: conversation.id,
                    title: conversation.title,
                    updated_at: conversation.updated_at,
                    model: conversation.model,
                });
            }
        }
        summaries.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
        Ok(summaries)
    }

    pub async fn load(&self, id: &str) -> AppResult<Conversation> {
        read_conversation(&self.path_for(id)?).await
    }

    pub async fn save(&self, conversation: &Conversation) -> AppResult<()> {
        let path = self.path_for(&conversation.id)?;
        tokio::fs::create_dir_all(&self.dir).await?;
        let tmp = path.with_extension("json.tmp");
        tokio::fs::write(&tmp, serde_json::to_vec(conversation)?).await?;
        tokio::fs::rename(&tmp, &path).await?;
        Ok(())
    }

    pub async fn delete(&self, id: &str) -> AppResult<()> {
        match tokio::fs::remove_file(self.path_for(id)?).await {
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err.into()),
            _ => Ok(()),
        }
    }

    fn path_for(&self, id: &str) -> AppResult<PathBuf> {
        if !is_valid_id(id) {
            return Err(AppError::msg("Invalid conversation id"));
        }
        Ok(self.dir.join(format!("{id}.json")))
    }
}

async fn read_conversation(path: &Path) -> AppResult<Conversation> {
    let bytes = tokio::fs::read(path).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

/// Ids become file names, so only allow a conservative character set.
fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conversation(id: &str, updated_at: i64) -> Conversation {
        Conversation {
            id: id.into(),
            title: format!("Chat {id}"),
            created_at: 1,
            updated_at,
            model: None,
            messages: vec![StoredMessage {
                id: "m1".into(),
                role: Role::User,
                content: "Prove that √2 is irrational.".into(),
                reasoning: None,
                model: None,
                error: None,
                created_at: 1,
            }],
        }
    }

    #[test]
    fn rejects_path_traversal_ids() {
        assert!(is_valid_id("3f2a9c1e-7b4d-4e8a-9f10-1234567890ab"));
        assert!(!is_valid_id("../settings"));
        assert!(!is_valid_id("a/b"));
        assert!(!is_valid_id(""));
        assert!(!is_valid_id(&"x".repeat(65)));
    }

    #[tokio::test]
    async fn save_list_load_delete() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConversationStore::new(dir.path().join("conversations"));
        assert!(store.list().await.unwrap().is_empty());

        store.save(&conversation("a", 10)).await.unwrap();
        store.save(&conversation("b", 20)).await.unwrap();
        std::fs::write(dir.path().join("conversations/broken.json"), b"{not json").unwrap();

        let ids: Vec<String> = store
            .list()
            .await
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(ids, vec!["b", "a"]);

        let loaded = store.load("a").await.unwrap();
        assert_eq!(loaded.messages[0].content, "Prove that √2 is irrational.");

        store.delete("a").await.unwrap();
        store.delete("a").await.unwrap();
        assert_eq!(store.list().await.unwrap().len(), 1);
        assert!(store.load("../x").await.is_err());
    }
}
