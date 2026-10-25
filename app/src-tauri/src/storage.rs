//! The workspace on disk: `projects.json`, one JSON file per document, each document's media
//! (figures, images, the original of an imported file) in `assets/<document id>/`, and its
//! earlier versions in `history/<document id>/`.
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

/// An earlier version of a document, as the history lists it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub id: String,
    /// When it was kept, in milliseconds since the epoch.
    pub at: i64,
    /// Why it was kept, when it wasn't simply time: "Before an Auto reply".
    #[serde(default)]
    pub label: Option<String>,
    pub title: String,
    pub blocks: usize,
    pub words: usize,
}

/// How often saving keeps a version, at most: one every ten minutes of work.
const VERSION_EVERY_MS: i64 = 10 * 60 * 1000;
/// How many versions a document keeps. Past it the oldest go, unlabelled ones first.
const MAX_VERSIONS: usize = 60;

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

    fn history_dir(&self, document_id: &str) -> AppResult<PathBuf> {
        if !is_valid_id(document_id) {
            return Err(AppError::msg("Invalid document id"));
        }
        Ok(self.dir.join("history").join(document_id))
    }

    fn assets_dir(&self, document_id: &str) -> AppResult<PathBuf> {
        if !is_valid_id(document_id) {
            return Err(AppError::msg("Invalid document id"));
        }
        Ok(self.dir.join("assets").join(document_id))
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
        // Keep a version now and then, once there's something to keep. Losing one is no reason
        // to fail the save.
        let versions = self.versions(&summary.id).await.unwrap_or_default();
        let now = now_ms();
        let empty = summary.title.trim().is_empty() && words(document) == 0;
        if !empty
            && versions
                .first()
                .is_none_or(|v| now - v.at >= VERSION_EVERY_MS)
        {
            let _ = self.keep_version(&summary.id, document, None, now).await;
        }
        Ok(summary)
    }

    /// Deletes a document, its media and its history.
    pub async fn delete_document(&self, id: &str) -> AppResult<()> {
        ignore_missing(tokio::fs::remove_file(self.document_path(id)?).await)?;
        ignore_missing(tokio::fs::remove_dir_all(self.assets_dir(id)?).await)?;
        ignore_missing(tokio::fs::remove_dir_all(self.history_dir(id)?).await)
    }

    /// A document's kept versions, newest first.
    pub async fn versions(&self, document_id: &str) -> AppResult<Vec<Version>> {
        let index = self.history_dir(document_id)?.join("index.json");
        match tokio::fs::read(&index).await {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or_default()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(err) => Err(err.into()),
        }
    }

    /// Keeps the document as it is on disk now as a version, with why, e.g. before an Auto reply.
    pub async fn snapshot(&self, document_id: &str, label: &str) -> AppResult<Version> {
        let document = self.load_document(document_id).await?;
        self.keep_version(document_id, &document, Some(label.to_string()), now_ms())
            .await
    }

    pub async fn load_version(&self, document_id: &str, version: &str) -> AppResult<Value> {
        if !is_valid_id(version) {
            return Err(AppError::msg("Invalid version id"));
        }
        let path = self
            .history_dir(document_id)?
            .join(format!("{version}.json"));
        match tokio::fs::read(&path).await {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                Err(AppError::msg("That version is no longer kept."))
            }
            Err(err) => Err(err.into()),
        }
    }

    async fn keep_version(
        &self,
        document_id: &str,
        document: &Value,
        label: Option<String>,
        at: i64,
    ) -> AppResult<Version> {
        let dir = self.history_dir(document_id)?;
        let mut versions = self.versions(document_id).await?;
        // Two versions in one millisecond get distinct ids.
        let mut id = at.to_string();
        while versions.iter().any(|v| v.id == id) {
            id.push('b');
        }
        write_atomic(
            &dir.join(format!("{id}.json")),
            &serde_json::to_vec(document)?,
        )
        .await?;
        let blocks = document["blocks"].as_array();
        let version = Version {
            id,
            at,
            label,
            title: document["title"].as_str().unwrap_or("").to_string(),
            blocks: blocks.map_or(0, Vec::len),
            words: words(document),
        };
        versions.insert(0, version.clone());
        while versions.len() > MAX_VERSIONS {
            let at = versions
                .iter()
                .rposition(|v| v.label.is_none())
                .unwrap_or(versions.len() - 1);
            let gone = versions.remove(at);
            ignore_missing(tokio::fs::remove_file(dir.join(format!("{}.json", gone.id))).await)?;
        }
        write_atomic(&dir.join("index.json"), &serde_json::to_vec(&versions)?).await?;
        Ok(version)
    }

    /// Saves a file of a document's media under `name`, e.g. `3f2a….png`.
    pub async fn save_asset(&self, document_id: &str, name: &str, bytes: &[u8]) -> AppResult<()> {
        if bytes.len() > MAX_ASSET_BYTES {
            return Err(AppError::msg(format!(
                "That file is too large to keep with the document (the limit is {} MB).",
                MAX_ASSET_BYTES / 1_000_000
            )));
        }
        let path = self.asset_path(document_id, name)?;
        write_atomic(&path, bytes).await
    }

    /// A file of a document's media and its MIME type.
    pub async fn read_asset(
        &self,
        document_id: &str,
        name: &str,
    ) -> AppResult<(Vec<u8>, &'static str)> {
        let path = self.asset_path(document_id, name)?;
        let mime = asset_mime(name).ok_or_else(|| AppError::msg("Unsupported file type"))?;
        Ok((tokio::fs::read(path).await?, mime))
    }

    pub async fn delete_asset(&self, document_id: &str, name: &str) -> AppResult<()> {
        ignore_missing(tokio::fs::remove_file(self.asset_path(document_id, name)?).await)
    }

    fn asset_path(&self, document_id: &str, name: &str) -> AppResult<PathBuf> {
        if !is_valid_asset_name(name) {
            return Err(AppError::msg(format!("Invalid file name \"{name}\"")));
        }
        Ok(self.assets_dir(document_id)?.join(name))
    }

    fn document_path(&self, id: &str) -> AppResult<PathBuf> {
        if !is_valid_id(id) {
            return Err(AppError::msg("Invalid document id"));
        }
        Ok(self.documents_dir().join(format!("{id}.json")))
    }
}

/// The words in a document's blocks.
fn words(document: &Value) -> usize {
    document["blocks"].as_array().map_or(0, |blocks| {
        blocks
            .iter()
            .filter_map(|b| b["source"].as_str())
            .map(|s| s.split_whitespace().count())
            .sum()
    })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// Imported PDFs are kept whole, so allow for long papers and scans.
const MAX_ASSET_BYTES: usize = 200_000_000;

/// The kinds of media a document can hold, by extension.
const ASSET_TYPES: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("webp", "image/webp"),
    ("gif", "image/gif"),
    ("avif", "image/avif"),
    ("bmp", "image/bmp"),
    ("svg", "image/svg+xml"),
    ("pdf", "application/pdf"),
    ("txt", "text/plain; charset=utf-8"),
    ("md", "text/markdown; charset=utf-8"),
    ("tex", "text/x-tex; charset=utf-8"),
    ("bin", "application/octet-stream"),
];

pub fn asset_mime(name: &str) -> Option<&'static str> {
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    ASSET_TYPES.iter().find(|(e, _)| *e == ext).map(|(_, m)| *m)
}

/// An id-like stem and a known extension: these become file names inside the workspace.
fn is_valid_asset_name(name: &str) -> bool {
    match name.rsplit_once('.') {
        Some((stem, _)) => is_valid_id(stem) && asset_mime(name).is_some(),
        None => false,
    }
}

fn ignore_missing(result: std::io::Result<()>) -> AppResult<()> {
    match result {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err.into()),
        _ => Ok(()),
    }
}

async fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    tokio::fs::write(&tmp, bytes).await?;
    // On Windows a file another program has open (a sync client, an indexer, antivirus) can't
    // be replaced for a moment; try again briefly before giving up.
    let mut attempt = 0;
    loop {
        match tokio::fs::rename(&tmp, path).await {
            Ok(()) => return Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied && attempt < 5 => {
                attempt += 1;
                tokio::time::sleep(std::time::Duration::from_millis(40 * attempt)).await;
            }
            Err(err) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(err.into());
            }
        }
    }
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
    async fn keeps_media_with_its_document() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(dir.path().join("workspace"));
        store.save_document(&document("d1", 1)).await.unwrap();
        store
            .save_asset("d1", "fig-1.png", b"\x89PNG")
            .await
            .unwrap();
        store
            .save_asset("d1", "paper.pdf", b"%PDF-1.7")
            .await
            .unwrap();

        let (bytes, mime) = store.read_asset("d1", "fig-1.png").await.unwrap();
        assert_eq!(bytes, b"\x89PNG");
        assert_eq!(mime, "image/png");
        assert_eq!(
            store.read_asset("d1", "paper.pdf").await.unwrap().1,
            "application/pdf"
        );
        // Media isn't listed as a document.
        assert_eq!(store.load().await.unwrap().documents.len(), 1);

        store.delete_asset("d1", "paper.pdf").await.unwrap();
        assert!(store.read_asset("d1", "paper.pdf").await.is_err());
        store.delete_document("d1").await.unwrap();
        assert!(store.read_asset("d1", "fig-1.png").await.is_err());
        assert!(!dir.path().join("workspace/assets/d1").exists());
    }

    #[tokio::test]
    async fn rejects_unsafe_media_names() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(dir.path().to_path_buf());
        for name in [
            "../x.png", "a/b.png", "x.exe", "noext", ".png", "x.png/..", "x.html",
        ] {
            assert!(store.save_asset("d1", name, b"x").await.is_err(), "{name}");
        }
        assert!(store.save_asset("../d", "x.png", b"x").await.is_err());
        assert!(store.read_asset("d1", "../../settings.json").await.is_err());
        assert_eq!(asset_mime("Figure.JPG"), Some("image/jpeg"));
    }

    #[tokio::test]
    async fn keeps_versions_as_documents_are_saved() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(dir.path().to_path_buf());
        // A new, empty document has nothing worth keeping yet.
        let mut blank = document("d0", 1);
        blank["title"] = json!("");
        blank["blocks"] = json!([{ "id": "b1", "source": "" }]);
        store.save_document(&blank).await.unwrap();
        assert!(store.versions("d0").await.unwrap().is_empty());

        let mut doc = document("d1", 1);
        store.save_document(&doc).await.unwrap();
        // A save soon after keeps no new version; a labelled snapshot always does.
        doc["title"] = json!("Second");
        store.save_document(&doc).await.unwrap();
        let versions = store.versions("d1").await.unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].title, "Doc d1");
        assert_eq!((versions[0].blocks, versions[0].words), (1, 6));
        let kept = store.snapshot("d1", "Before an Auto reply").await.unwrap();
        assert_eq!(kept.label.as_deref(), Some("Before an Auto reply"));
        assert_eq!(kept.title, "Second");
        let versions = store.versions("d1").await.unwrap();
        assert_eq!(versions[0].id, kept.id);
        let old = store.load_version("d1", &versions[1].id).await.unwrap();
        assert_eq!(old["title"], "Doc d1");
        assert!(store.load_version("d1", "../x").await.is_err());
        assert!(store.load_version("d1", "123").await.is_err());

        // Old enough, and the next save keeps one.
        let mut aged = store.versions("d1").await.unwrap();
        for v in &mut aged {
            v.at -= VERSION_EVERY_MS;
        }
        write_atomic(
            &dir.path().join("history/d1/index.json"),
            &serde_json::to_vec(&aged).unwrap(),
        )
        .await
        .unwrap();
        doc["title"] = json!("Third");
        store.save_document(&doc).await.unwrap();
        assert_eq!(store.versions("d1").await.unwrap()[0].title, "Third");

        // Past the limit the oldest unlabelled versions go, with their files.
        for n in 0..MAX_VERSIONS {
            store
                .keep_version("d1", &doc, None, 10_000 + n as i64)
                .await
                .unwrap();
        }
        let versions = store.versions("d1").await.unwrap();
        assert_eq!(versions.len(), MAX_VERSIONS);
        assert!(versions.iter().any(|v| v.label.is_some()));
        let files = std::fs::read_dir(dir.path().join("history/d1"))
            .unwrap()
            .count();
        assert_eq!(files, MAX_VERSIONS + 1);

        store.delete_document("d1").await.unwrap();
        assert!(!dir.path().join("history/d1").exists());
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
