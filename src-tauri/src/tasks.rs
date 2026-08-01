use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::{Mutex, OnceCell};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub project_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub selected_model: Option<String>,
    #[serde(default)]
    pub selected_account_id: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StoredTasksState {
    pub tasks: Vec<Task>,
    pub messages_by_task_id: HashMap<String, Vec<serde_json::Value>>,
}

#[derive(Clone)]
pub struct TasksStore {
    inner: Arc<OnceCell<Mutex<StoredTasksState>>>,
}

impl TasksStore {
    pub fn lazy() -> Self {
        Self {
            inner: Arc::new(OnceCell::new()),
        }
    }

    async fn state<R: Runtime>(&self, app: &AppHandle<R>) -> Result<&Mutex<StoredTasksState>, String> {
        self.inner
            .get_or_try_init(|| async {
                let path = tasks_path(app)?;
                let state = match tokio::fs::read(&path).await {
                    Ok(bytes) => serde_json::from_slice(&bytes)
                        .map_err(|e| format!("failed to parse {path:?}: {e}"))?,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => StoredTasksState::default(),
                    Err(e) => return Err(format!("failed to read {path:?}: {e}")),
                };
                Ok(Mutex::new(state))
            })
            .await
    }
}

fn tasks_path<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("tasks.json"))
        .map_err(|e| format!("failed to resolve app data dir: {e}"))
}

async fn persist<R: Runtime>(app: &AppHandle<R>, state: &StoredTasksState) -> Result<(), String> {
    let path = tasks_path(app)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("failed to create {parent:?}: {e}"))?;
    }
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|e| format!("failed to serialize tasks: {e}"))?;
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| format!("failed to write {path:?}: {e}"))
}

#[allow(dead_code)] // used in task_id_new_unique test below
fn task_id_new() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("task_{nanos}")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn tasks_for_project(state: &StoredTasksState, project_id: Option<&str>) -> Vec<Task> {
    state
        .tasks
        .iter()
        .filter(|task| project_id.is_none_or(|id| task.project_id.as_deref() == Some(id)))
        .cloned()
        .collect()
}

fn merge_json(base: serde_json::Value, patch: serde_json::Value) -> serde_json::Value {
    match (base, patch) {
        (serde_json::Value::Object(mut base), serde_json::Value::Object(patch)) => {
            base.extend(patch);
            serde_json::Value::Object(base)
        }
        (_, patch) => patch,
    }
}

#[tauri::command]
pub async fn tasks_list(
    state: State<'_, TasksStore>,
    app: AppHandle<impl Runtime>,
    project_id: Option<String>,
) -> Result<Vec<Task>, String> {
    let state = state.state(&app).await?.lock().await;
    Ok(tasks_for_project(&state, project_id.as_deref()))
}

#[tauri::command]
pub async fn tasks_create(
    state: State<'_, TasksStore>,
    app: AppHandle<impl Runtime>,
    mut task: Task,
) -> Result<Task, String> {
    if task.id.trim().is_empty() || task.title.trim().is_empty() {
        return Err("task id and title are required".into());
    }
    if task.created_at == 0 {
        task.created_at = now_ms();
    }
    task.updated_at = now_ms();
    let mut stored = state.state(&app).await?.lock().await;
    stored.tasks.retain(|existing| existing.id != task.id);
    stored.tasks.insert(0, task.clone());
    persist(&app, &stored).await?;
    let _ = app.emit("tasks:changed", ());
    Ok(task)
}

#[tauri::command]
pub async fn tasks_remove(
    state: State<'_, TasksStore>,
    app: AppHandle<impl Runtime>,
    task_id: String,
) -> Result<(), String> {
    let mut stored = state.state(&app).await?.lock().await;
    stored.tasks.retain(|task| task.id != task_id);
    stored.messages_by_task_id.remove(&task_id);
    persist(&app, &stored).await?;
    let _ = app.emit("tasks:changed", ());
    Ok(())
}

#[tauri::command]
pub async fn tasks_update(
    state: State<'_, TasksStore>,
    app: AppHandle<impl Runtime>,
    task_id: String,
    patch: serde_json::Value,
) -> Result<Task, String> {
    let mut stored = state.state(&app).await?.lock().await;
    let existing = stored
        .tasks
        .iter()
        .find(|task| task.id == task_id)
        .cloned()
        .ok_or_else(|| "Task not found".to_string())?;
    let mut updated: Task = serde_json::from_value(merge_json(
        serde_json::to_value(existing).map_err(|e| e.to_string())?,
        patch,
    ))
    .map_err(|e| format!("invalid task patch: {e}"))?;
    if updated.id != task_id || updated.title.trim().is_empty() {
        return Err("task id cannot change and title is required".into());
    }
    updated.updated_at = now_ms();
    let result = updated.clone();
    let index = stored.tasks.iter().position(|task| task.id == task_id).unwrap();
    stored.tasks[index] = updated;
    persist(&app, &stored).await?;
    let _ = app.emit("tasks:changed", ());
    Ok(result)
}

#[tauri::command]
pub async fn tasks_get_messages(
    state: State<'_, TasksStore>,
    app: AppHandle<impl Runtime>,
    task_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let stored = state.state(&app).await?.lock().await;
    Ok(stored.messages_by_task_id.get(&task_id).cloned().unwrap_or_default())
}

#[tauri::command]
pub async fn tasks_save_messages(
    state: State<'_, TasksStore>,
    app: AppHandle<impl Runtime>,
    task_id: String,
    messages: Vec<serde_json::Value>,
) -> Result<(), String> {
    let mut stored = state.state(&app).await?.lock().await;
    stored.messages_by_task_id.insert(task_id, messages);
    persist(&app, &stored).await?;
    let _ = app.emit("tasks:changed", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_task(id: &str, project_id: &str) -> Task {
        Task {
            id: id.into(),
            project_id: Some(project_id.into()),
            title: id.into(),
            selected_model: None,
            selected_account_id: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn task_id_new_unique() {
        assert_ne!(task_id_new(), task_id_new());
    }

    #[test]
    fn serialize_roundtrip() {
        let mut state = StoredTasksState::default();
        state.tasks.push(sample_task("task-1", "project-1"));
        state.messages_by_task_id.insert(
            "task-1".into(),
            vec![serde_json::json!({
                "id": "message-1",
                "role": "user",
                "content": "hello"
            })],
        );

        let json = serde_json::to_string(&state).unwrap();
        let restored: StoredTasksState = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.tasks[0].id, "task-1");
        assert_eq!(restored.messages_by_task_id["task-1"][0]["content"], "hello");
    }

    #[test]
    fn tasks_for_project_filter() {
        let state = StoredTasksState {
            tasks: vec![sample_task("a", "one"), sample_task("b", "two")],
            ..Default::default()
        };
        let filtered = tasks_for_project(&state, Some("one"));
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, "a");
    }

    #[test]
    fn accepts_renderer_task_shape() {
        let task: Task = serde_json::from_value(serde_json::json!({
            "id": "renderer-id",
            "projectId": null,
            "title": "Agent chat",
            "selectedModel": "minimax/MiniMax-M2.5",
            "selectedAccountId": "default",
            "createdAt": 1,
            "updatedAt": 2
        }))
        .expect("renderer task shape must deserialize");
        assert_eq!(task.id, "renderer-id");
    }

    #[test]
    fn accepts_full_renderer_message_shape() {
        let state = serde_json::from_value::<StoredTasksState>(serde_json::json!({
            "tasks": [],
            "messagesByTaskId": {
                "renderer-id": [{
                    "id": "message-1",
                    "role": "error",
                    "content": "request failed",
                    "errorDetails": "stack",
                    "toolCalls": [{ "id": "tool-1", "name": "bash", "input": {} }]
                }]
            }
        }));
        assert!(state.is_ok(), "renderer messages must persist without lossy reshaping");
    }
}
