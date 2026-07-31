//! Projects store + IPC commands.
//!
//! Mirrors `electron/main/projects.ts::ProjectsStore`: a persisted
//! JSON file under the app config dir holding the user's project
//! registry plus the active project id. State lives behind a
//! `tokio::sync::Mutex` so the multi-command concurrent calls don't
//! race on disk or on `activeProjectId`.
//!
//! ponytail: replaces `electron-store` with a hand-rolled JSON file.
//! Avoids pulling in `tauri-plugin-store` (yet) — schema is tiny,
//! read/write happens on every command, and we want to keep the
//! Phase 3 surface lean while we find what actually needs storage.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub label: String,
    /// Absolute, realpath-resolved path to the project root.
    pub path: String,
    pub created_at: u64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct StoredProjectsState {
    projects: Vec<Project>,
    active_project_id: Option<String>,
}

#[derive(Clone)]
pub struct ProjectsStore {
    inner: Arc<Mutex<StoredProjectsState>>,
    file_path: PathBuf,
}

const STATE_FILE: &str = "projects.json";

impl ProjectsStore {
    /// In-memory empty store — fallback when disk load fails. State
    /// writes still attempt to persist and re-create the file.
    pub fn empty() -> Self {
        Self {
            inner: Arc::new(Mutex::new(StoredProjectsState::default())),
            file_path: PathBuf::new(),
        }
    }

    pub async fn load(app: &AppHandle<impl Runtime>) -> Result<Self, String> {
        let dir = app
            .path()
            .app_config_dir()
            .map_err(|e| format!("failed to resolve app config dir: {e}"))?;
        let file_path = dir.join(STATE_FILE);
        let state = if file_path.exists() {
            let bytes = tokio::fs::read(&file_path)
                .await
                .map_err(|e| format!("failed to read {file_path:?}: {e}"))?;
            serde_json::from_slice(&bytes).unwrap_or_default()
        } else {
            // First boot — try to create the directory lazily so the
            // first write doesn't fail with ENOENT.
            let _ = tokio::fs::create_dir_all(&dir).await;
            StoredProjectsState::default()
        };
        Ok(Self {
            inner: Arc::new(Mutex::new(state)),
            file_path,
        })
    }

    async fn persist(&self, state: &StoredProjectsState) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(state)
            .map_err(|e| format!("failed to serialise projects: {e}"))?;
        if let Some(parent) = self.file_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("failed to create {parent:?}: {e}"))?;
        }
        tokio::fs::write(&self.file_path, bytes)
            .await
            .map_err(|e| format!("failed to write {:?}: {e}", self.file_path))
    }

    async fn snapshot(&self) -> StoredProjectsState {
        self.inner.lock().await.clone()
    }

    async fn commit(
        &self,
        new_state: StoredProjectsState,
        app: &AppHandle<impl Runtime>,
    ) -> Result<(), String> {
        self.persist(&new_state).await?;
        *self.inner.lock().await = new_state;
        let _ = app.emit("projects:changed", ());
        Ok(())
    }
}

#[tauri::command]
pub async fn projects_list(state: State<'_, ProjectsStore>) -> Result<Vec<Project>, String> {
    Ok(state.snapshot().await.projects)
}

#[tauri::command]
pub async fn projects_get_active(
    state: State<'_, ProjectsStore>,
) -> Result<Option<Project>, String> {
    Ok(state.snapshot().await.active_project())
}

#[derive(Debug, Serialize)]
#[serde(tag = "ok", rename_all = "lowercase")]
pub enum AddProjectResult {
    True { project: Project },
    False { error: String },
}

#[tauri::command]
pub async fn projects_add(
    state: State<'_, ProjectsStore>,
    app: AppHandle<impl Runtime>,
    path: String,
    label: Option<String>,
) -> Result<AddProjectResult, String> {
    if path.trim().is_empty() {
        return Ok(AddProjectResult::False {
            error: "Path is required".to_string(),
        });
    }
    // Resolve to a real path so symlinks/relative inputs collapse to a stable canonical form.
    let real = match tokio::fs::canonicalize(&path).await {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(e) => {
            return Ok(AddProjectResult::False {
                error: match e.kind() {
                    std::io::ErrorKind::NotFound => "Directory not found".to_string(),
                    std::io::ErrorKind::PermissionDenied => "Access denied".to_string(),
                    _ => e.to_string(),
                },
            });
        }
    };

    let mut snapshot = state.snapshot().await;
    if snapshot.projects.iter().any(|p| p.path == real) {
        return Ok(AddProjectResult::False {
            error: "Project is already added".to_string(),
        });
    }

    let label_owned = label.unwrap_or_else(|| {
        std::path::Path::new(&real)
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| real.clone())
    });
    let project = Project {
        id: new_id(),
        label: label_owned,
        path: real,
        created_at: now_ms(),
    };
    snapshot.projects.push(project.clone());
    if snapshot.projects.len() == 1 {
        snapshot.active_project_id = Some(project.id.clone());
    }
    state.commit(snapshot, &app).await?;
    Ok(AddProjectResult::True { project })
}

#[derive(Debug, Serialize)]
#[serde(tag = "ok", rename_all = "lowercase")]
pub enum RemoveResult {
    True,
    False { error: String },
}

#[tauri::command]
pub async fn projects_remove(
    state: State<'_, ProjectsStore>,
    app: AppHandle<impl Runtime>,
    id: String,
) -> Result<RemoveResult, String> {
    let mut snapshot = state.snapshot().await;
    let idx = snapshot
        .projects
        .iter()
        .position(|p| p.id == id);
    let Some(idx) = idx else {
        return Ok(RemoveResult::False {
            error: "Project not found".to_string(),
        });
    };
    snapshot.projects.remove(idx);
    if snapshot.active_project_id.as_deref() == Some(&id) {
        snapshot.active_project_id = snapshot.projects.first().map(|p| p.id.clone());
    }
    state.commit(snapshot, &app).await?;
    Ok(RemoveResult::True)
}

#[tauri::command]
pub async fn projects_set_active(
    state: State<'_, ProjectsStore>,
    app: AppHandle<impl Runtime>,
    id: Option<String>,
) -> Result<(), String> {
    let mut snapshot = state.snapshot().await;
    if let Some(ref target) = id {
        if !snapshot.projects.iter().any(|p| &p.id == target) {
            return Ok(()); // silently ignore unknown ids, matching Electron behaviour
        }
    }
    snapshot.active_project_id = id;
    state.commit(snapshot, &app).await
}

impl StoredProjectsState {
    fn active_project(&self) -> Option<Project> {
        if let Some(id) = &self.active_project_id {
            if let Some(p) = self.projects.iter().find(|p| &p.id == id) {
                return Some(p.clone());
            }
        }
        self.projects.first().cloned()
    }
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn new_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("proj_{nanos}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str, path: &str) -> Project {
        Project {
            id: id.to_string(),
            label: id.to_string(),
            path: path.to_string(),
            created_at: 0,
        }
    }

    #[test]
    fn active_project_falls_back_to_first_when_id_missing() {
        let mut state = StoredProjectsState::default();
        state.projects.push(sample("a", "/tmp/a"));
        state.projects.push(sample("b", "/tmp/b"));
        state.active_project_id = Some("missing".to_string());
        assert_eq!(state.active_project().unwrap().id, "a");
    }

    #[test]
    fn active_project_returns_explicit_id() {
        let mut state = StoredProjectsState::default();
        state.projects.push(sample("a", "/tmp/a"));
        state.projects.push(sample("b", "/tmp/b"));
        state.active_project_id = Some("b".to_string());
        assert_eq!(state.active_project().unwrap().id, "b");
    }

    #[test]
    fn active_project_none_when_empty() {
        let state = StoredProjectsState::default();
        assert!(state.active_project().is_none());
    }

    #[test]
    fn remove_clears_active_when_active_was_removed() {
        let mut state = StoredProjectsState::default();
        state.projects.push(sample("a", "/tmp/a"));
        state.projects.push(sample("b", "/tmp/b"));
        state.active_project_id = Some("a".to_string());

        // Mirror projects_remove logic
        let id = "a".to_string();
        let idx = state.projects.iter().position(|p| p.id == id).unwrap();
        state.projects.remove(idx);
        if state.active_project_id.as_deref() == Some(&id) {
            state.active_project_id = state.projects.first().map(|p| p.id.clone());
        }
        assert_eq!(state.active_project_id, Some("b".to_string()));
    }
}
