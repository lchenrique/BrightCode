//! Agent team definitions + IPC commands.
//!
//! Mirrors the Electron `auth.agents` store (electron/main/index.ts, lines
//! 702-742). Persists `AgentDefinition` records as a JSON map under
//! `app_data_dir/agents.json`. Each write emits `agents:changed`.
//!
//! ponytail: hand-rolled JSON file. Schema is small, single writer, no
//! concurrent process can clobber state.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::OnceCell;

const STATE_FILE: &str = "agents.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    pub id: String,
    pub name: String,
    pub description: String,
    /// Deterministic seed used by DiceBear bottts to render the agent avatar.
    /// Replaces the older `emoji` field (see AGENTS.md "No emoji in the UI").
    pub avatar_seed: String,
    pub system_prompt: String,
    pub model: String,
    pub account_id: Option<String>,
    pub project_id: Option<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    pub enabled: bool,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct StoredAgentsState {
    pub agents: HashMap<String, AgentDefinition>,
}

#[derive(Clone)]
pub struct AgentsStore {
    inner: Arc<OnceCell<tokio::sync::Mutex<StoredAgentsState>>>,
}

impl AgentsStore {
    pub fn lazy() -> Self {
        Self {
            inner: Arc::new(OnceCell::new()),
        }
    }

    async fn state<R: Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<&tokio::sync::Mutex<StoredAgentsState>, String> {
        self.inner
            .get_or_try_init(|| async {
                let path = agents_path(app)?;
                let state = match tokio::fs::read(&path).await {
                    Ok(bytes) => serde_json::from_slice(&bytes)
                        .map_err(|e| format!("failed to parse {path:?}: {e}"))?,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        StoredAgentsState::default()
                    }
                    Err(e) => return Err(format!("failed to read {path:?}: {e}")),
                };
                Ok(tokio::sync::Mutex::new(state))
            })
            .await
    }
}

fn agents_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(STATE_FILE))
        .map_err(|e| format!("failed to resolve app data dir: {e}"))
}

async fn persist<R: Runtime>(
    app: &AppHandle<R>,
    state: &StoredAgentsState,
) -> Result<(), String> {
    let path = agents_path(app)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("failed to create {parent:?}: {e}"))?;
    }
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|e| format!("failed to serialise agents: {e}"))?;
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| format!("failed to write {path:?}: {e}"))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[allow(dead_code)]
fn new_id() -> String {
    format!("agent_{}", uuid::Uuid::new_v4())
}

fn emit_changed<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit("agents:changed", ());
}

// ── Commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn agents_list(
    state: State<'_, AgentsStore>,
    app: AppHandle<impl Runtime>,
) -> Result<Vec<AgentDefinition>, String> {
    let s = state.state(&app).await?.lock().await;
    Ok(s.agents.values().cloned().collect())
}

#[tauri::command]
pub async fn agents_get(
    state: State<'_, AgentsStore>,
    app: AppHandle<impl Runtime>,
    id: String,
) -> Result<Option<AgentDefinition>, String> {
    let s = state.state(&app).await?.lock().await;
    Ok(s.agents.get(&id).cloned())
}

#[tauri::command]
pub async fn agents_add(
    state: State<'_, AgentsStore>,
    app: AppHandle<impl Runtime>,
    mut agent: Value,
) -> Result<AgentDefinition, String> {
    let object = agent
        .as_object_mut()
        .ok_or_else(|| "agent must be an object".to_string())?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(new_id);
    object.insert("id".into(), Value::String(id));
    let ts = now_ms();
    object.entry("createdAt").or_insert(Value::from(ts));
    object.insert("updatedAt".into(), Value::from(ts));
    if !object.contains_key("avatarSeed") {
        let seed = object
            .remove("emoji")
            .and_then(|value| value.as_str().map(str::to_owned))
            .or_else(|| object.get("name").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_else(|| "agent".into());
        object.insert("avatarSeed".into(), Value::String(seed));
    }
    if !object.contains_key("model") {
        if let Some(model) = object.remove("modelId") {
            object.insert("model".into(), model);
        }
    }
    let def: AgentDefinition = serde_json::from_value(agent)
        .map_err(|e| format!("invalid agent: {e}"))?;
    if def.name.trim().is_empty() || def.avatar_seed.trim().is_empty() {
        return Err("agent name and avatarSeed must be non-empty".into());
    }
    let mut s = state.state(&app).await?.lock().await;
    if s.agents.contains_key(&def.id) {
        return Err(format!("agent id {} already exists", def.id));
    }
    s.agents.insert(def.id.clone(), def.clone());
    persist(&app, &s).await?;
    emit_changed(&app);
    Ok(def)
}

#[tauri::command]
pub async fn agents_update(
    state: State<'_, AgentsStore>,
    app: AppHandle<impl Runtime>,
    id: String,
    patch: serde_json::Value,
) -> Result<(), String> {
    let mut s = state.state(&app).await?.lock().await;
    let Some(existing) = s.agents.get(&id) else {
        return Ok(()); // unknown id → no-op, matches Electron
    };
    let base = serde_json::to_value(existing.clone())
        .map_err(|e| format!("failed to encode agent: {e}"))?;
    let merged = merge_json(base, patch);
    let mut updated: AgentDefinition = serde_json::from_value(merged)
        .map_err(|e| format!("invalid agent patch: {e}"))?;
    updated.updated_at = now_ms();
    s.agents.insert(id, updated);
    persist(&app, &s).await?;
    emit_changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn agents_remove(
    state: State<'_, AgentsStore>,
    app: AppHandle<impl Runtime>,
    id: String,
) -> Result<(), String> {
    let mut s = state.state(&app).await?.lock().await;
    if s.agents.remove(&id).is_none() {
        return Ok(()); // unknown id → no-op
    }
    persist(&app, &s).await?;
    emit_changed(&app);
    Ok(())
}

// ── Helpers ──────────────────────────────────────────────────────────

fn merge_json(base: Value, patch: Value) -> Value {
    match (base, patch) {
        (Value::Object(mut base), Value::Object(patch)) => {
            for (k, v) in patch {
                base.insert(k, v);
            }
            Value::Object(base)
        }
        (_, patch) => patch,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str, seed: &str) -> AgentDefinition {
        AgentDefinition {
            id: id.into(),
            name: id.into(),
            description: format!("{id} description"),
            avatar_seed: seed.into(),
            system_prompt: "you are".into(),
            model: "minimax/MiniMax-M2.5".into(),
            account_id: None,
            project_id: None,
            tools: vec![],
            enabled: true,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn id_factory_yields_distinct_ids() {
        let a = new_id();
        let b = new_id();
        assert_ne!(a, b);
        assert!(a.starts_with("agent_"));
    }

    #[test]
    fn serialize_roundtrip_preserves_avatar_seed() {
        let mut state = StoredAgentsState::default();
        state.agents.insert("a".into(), sample("a", "seed-a"));
        let json = serde_json::to_string(&state).unwrap();
        let restored: StoredAgentsState = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.agents["a"].avatar_seed, "seed-a");
        assert!(restored.agents["a"].enabled);
    }

    #[test]
    fn merge_json_handles_partial_patch() {
        let base = serde_json::json!({ "id": "x", "name": "old", "enabled": true });
        let patch = serde_json::json!({ "name": "new" });
        let merged = merge_json(base, patch);
        assert_eq!(merged["name"], "new");
        assert_eq!(merged["enabled"], true);
    }

    #[test]
    fn uses_renderer_model_field() {
        let agent: AgentDefinition = serde_json::from_value(serde_json::json!({
            "id": "agent-1",
            "name": "Builder",
            "avatarSeed": "builder",
            "description": "Builds",
            "systemPrompt": "Build",
            "model": "minimax/MiniMax-M2.5",
            "tools": [],
            "enabled": true,
            "createdAt": 1,
            "updatedAt": 1
        }))
        .expect("renderer AgentDefinition must deserialize");
        let value = serde_json::to_value(agent).unwrap();
        assert_eq!(value["model"], "minimax/MiniMax-M2.5");
        assert!(value.get("modelId").is_none());
    }
}