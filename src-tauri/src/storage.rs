//! The workspace on disk: `projects.json` plus one JSON file per document.
//!
//! Documents are stored as the frontend sends them. The backend only reads the few header
//! fields it needs to list them, so the document format can grow without touching Rust.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    #[serde(default)]
    pub collapsed: bool,
}

/// The header fields of a document, enough to list it in the sidebar.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSummary {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// The document's overall standing (open, draft, proved, …), as computed by the frontend.
    #[serde(default)]
    pub status: Option<String>,
    /// Collaborator suggestions still waiting for a decision.
    #[serde(default)]
    pub pending: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub projects: Vec<Project>,
    pub documents: Vec<DocumentSummary>,
}

pub struct WorkspaceStore {
    dir: PathBuf,
}

impl WorkspaceStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn projects_path(&self) -> PathBuf {
        self.dir.join("projects.json")
    }

    fn documents_dir(&self) -> PathBuf {
        self.dir.join("documents")
    }

    pub async fn load(&self) -> AppResult<Workspace> {
        let projects = match tokio::fs::read(self.projects_path()).await {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(err) => return Err(err.into()),
        };
        Ok(Workspace {
            projects,
            documents: self.list_documents().await?,
        })
    }

    async fn list_documents(&self) -> AppResult<Vec<DocumentSummary>> {
        let mut entries = match tokio::fs::read_dir(self.documents_dir()).await {
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
            // A single unreadable file shouldn't hide every other document.
            if let Ok(bytes) = tokio::fs::read(&path).await
                && let Ok(summary) = serde_json::from_slice::<DocumentSummary>(&bytes)
            {
                summaries.push(summary);
            }
        }
        summaries.sort_by_key(|s| s.created_at);
        Ok(summaries)
    }

    pub async fn save_projects(&self, projects: &[Project]) -> AppResult<()> {
        if let Some(bad) = projects.iter().find(|p| !is_valid_id(&p.id)) {
            return Err(AppError::msg(format!("Invalid project id \"{}\"", bad.id)));
        }
        write_atomic(&self.projects_path(), &serde_json::to_vec_pretty(projects)?).await
    }

    pub async fn load_document(&self, id: &str) -> AppResult<Value> {
        let bytes = tokio::fs::read(self.document_path(id)?).await?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    /// Saves a document and returns its summary. The document must carry the summary fields.
    pub async fn save_document(&self, document: &Value) -> AppResult<DocumentSummary> {
        let summary: DocumentSummary = serde_json::from_value(document.clone())
            .map_err(|err| AppError::msg(format!("Invalid document: {err}")))?;
        if !is_valid_id(&summary.project_id) {
            return Err(AppError::msg("Invalid project id"));
        }
        let path = self.document_path(&summary.id)?;
        write_atomic(&path, &serde_json::to_vec(document)?).await?;
        Ok(summary)
    }

    pub async fn delete_document(&self, id: &str) -> AppResult<()> {
        match tokio::fs::remove_file(self.document_path(id)?).await {
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err.into()),
            _ => Ok(()),
        }
    }

    fn document_path(&self, id: &str) -> AppResult<PathBuf> {
        if !is_valid_id(id) {
            return Err(AppError::msg("Invalid document id"));
        }
        Ok(self.documents_dir().join(format!("{id}.json")))
    }
}

async fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, bytes).await?;
    tokio::fs::rename(&tmp, path).await?;
    Ok(())
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
    use serde_json::json;

    fn document(id: &str, created_at: i64) -> Value {
        json!({
            "id": id,
            "projectId": "p1",
            "title": format!("Doc {id}"),
            "createdAt": created_at,
            "updatedAt": created_at + 5,
            "status": "draft",
            "pending": 1,
            "blocks": [{ "id": "b1", "source": "Prove that $\\sqrt 2$ is irrational." }],
            "threads": []
        })
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
    async fn empty_workspace_loads() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(dir.path().join("workspace"));
        let ws = store.load().await.unwrap();
        assert!(ws.projects.is_empty());
        assert!(ws.documents.is_empty());
    }

    #[tokio::test]
    async fn round_trips_projects_and_documents() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(dir.path().join("workspace"));
        let projects = vec![Project {
            id: "p1".into(),
            name: "Figurate numbers".into(),
            created_at: 1,
            collapsed: false,
        }];
        store.save_projects(&projects).await.unwrap();

        let summary = store.save_document(&document("b", 20)).await.unwrap();
        assert_eq!(summary.status.as_deref(), Some("draft"));
        assert_eq!(summary.pending, 1);
        store.save_document(&document("a", 10)).await.unwrap();
        std::fs::write(
            dir.path().join("workspace/documents/broken.json"),
            b"{not json",
        )
        .unwrap();

        let ws = store.load().await.unwrap();
        assert_eq!(ws.projects, projects);
        let ids: Vec<&str> = ws.documents.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b"]);

        // Fields the backend doesn't know about survive a round trip untouched.
        let loaded = store.load_document("a").await.unwrap();
        assert_eq!(
            loaded["blocks"][0]["source"],
            "Prove that $\\sqrt 2$ is irrational."
        );

        store.delete_document("a").await.unwrap();
        store.delete_document("a").await.unwrap();
        assert_eq!(store.load().await.unwrap().documents.len(), 1);
    }

    #[tokio::test]
    async fn rejects_bad_documents() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(dir.path().to_path_buf());
        assert!(
            store
                .save_document(&json!({ "id": "x", "title": "No project" }))
                .await
                .is_err()
        );
        let mut doc = document("../escape", 1);
        assert!(store.save_document(&doc).await.is_err());
        doc = document("ok", 1);
        doc["projectId"] = json!("../p");
        assert!(store.save_document(&doc).await.is_err());
        assert!(store.load_document("../x").await.is_err());
        assert!(
            store
                .save_projects(&[Project {
                    id: "a/b".into(),
                    name: "x".into(),
                    created_at: 0,
                    collapsed: false
                }])
                .await
                .is_err()
        );
    }
}
