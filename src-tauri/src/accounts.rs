//! Accounts store + IPC commands.
//!
//! Mirrors the Electron `auth` store (electron/main/index.ts, lines 333-700).
//! Persists provider accounts + active-account selection as JSON under
//! `app_data_dir/accounts.json`. All writes emit `accounts:changed` so the
//! renderer can re-hydrate the cache.
//!
//! ponytail: replaces `electron-store` with a hand-rolled JSON file.
//! The persisted shape mirrors Electron's `StoredAccount` so the
//! renderer-side `accountStore` does not need migration.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::OnceCell;

const STATE_FILE: &str = "accounts.json";

/// Account record persisted on disk. Field names match the Electron
/// `StoredAccount` shape (camelCase) so the renderer can consume the
/// bridge response without an adapter.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInput {
    pub id: String,
    pub provider_id: String,
    pub label: String,
    #[serde(default)]
    pub email: Option<String>,
    pub auth_method: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub access_token: Option<String>,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_at: Option<u64>,
    #[serde(default)]
    pub cli_source: Option<String>,
    #[serde(default)]
    pub cli_email: Option<String>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
    pub enabled: bool,
    #[serde(default)]
    pub last_used_at: Option<u64>,
    pub created_at: u64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAccountsState {
    /// providerId -> (accountId -> AccountInput).
    pub accounts: HashMap<String, HashMap<String, AccountInput>>,
    /// providerId -> active accountId.
    pub active_accounts: HashMap<String, String>,
}

#[derive(Clone)]
pub struct AccountsStore {
    inner: Arc<OnceCell<tokio::sync::Mutex<StoredAccountsState>>>,
}

impl AccountsStore {
    pub fn lazy() -> Self {
        Self {
            inner: Arc::new(OnceCell::new()),
        }
    }

    async fn state<R: Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<&tokio::sync::Mutex<StoredAccountsState>, String> {
        self.inner
            .get_or_try_init(|| async {
                let path = accounts_path(app)?;
                let state = match tokio::fs::read(&path).await {
                    Ok(bytes) => serde_json::from_slice(&bytes)
                        .map_err(|e| format!("failed to parse {path:?}: {e}"))?,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        StoredAccountsState::default()
                    }
                    Err(e) => return Err(format!("failed to read {path:?}: {e}")),
                };
                Ok(tokio::sync::Mutex::new(state))
            })
            .await
    }
}

fn accounts_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(STATE_FILE))
        .map_err(|e| format!("failed to resolve app data dir: {e}"))
}

async fn persist<R: Runtime>(
    app: &AppHandle<R>,
    state: &StoredAccountsState,
) -> Result<(), String> {
    let path = accounts_path(app)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("failed to create {parent:?}: {e}"))?;
    }
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|e| format!("failed to serialise accounts: {e}"))?;
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|e| format!("failed to write {path:?}: {e}"))
}

#[allow(dead_code)]
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn emit_changed<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit("accounts:changed", ());
}

// ── Commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn accounts_list_all(
    state: State<'_, AccountsStore>,
    app: AppHandle<impl Runtime>,
) -> Result<HashMap<String, HashMap<String, AccountInput>>, String> {
    let s = state.state(&app).await?.lock().await;
    Ok(s.accounts.clone())
}

#[tauri::command]
pub async fn accounts_list(
    state: State<'_, AccountsStore>,
    app: AppHandle<impl Runtime>,
    provider_id: String,
) -> Result<Vec<AccountInput>, String> {
    let s = state.state(&app).await?.lock().await;
    Ok(s.accounts
        .get(&provider_id)
        .map(|m| m.values().cloned().collect())
        .unwrap_or_default())
}

#[tauri::command]
pub async fn accounts_get(
    state: State<'_, AccountsStore>,
    app: AppHandle<impl Runtime>,
    provider_id: String,
    account_id: String,
) -> Result<Option<AccountInput>, String> {
    let s = state.state(&app).await?.lock().await;
    Ok(s.accounts.get(&provider_id).and_then(|m| m.get(&account_id)).cloned())
}

#[tauri::command]
pub async fn accounts_add(
    state: State<'_, AccountsStore>,
    app: AppHandle<impl Runtime>,
    provider_id: String,
    account: AccountInput,
) -> Result<(), String> {
    if account.id.trim().is_empty() || account.provider_id != provider_id {
        return Err("account id must match and be non-empty".into());
    }
    let mut s = state.state(&app).await?.lock().await;
    s.accounts
        .entry(provider_id)
        .or_default()
        .insert(account.id.clone(), account);
    persist(&app, &s).await?;
    emit_changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn accounts_update(
    state: State<'_, AccountsStore>,
    app: AppHandle<impl Runtime>,
    provider_id: String,
    account_id: String,
    patch: serde_json::Value,
) -> Result<(), String> {
    let mut s = state.state(&app).await?.lock().await;
    let Some(entry) = s.accounts.get_mut(&provider_id).and_then(|m| m.get_mut(&account_id)) else {
        return Ok(()); // unknown id → no-op, matches Electron
    };
    let value = serde_json::to_value(entry.clone())
        .map_err(|e| format!("failed to encode account: {e}"))?;
    let merged = merge_json(value, patch);
    *entry = serde_json::from_value(merged)
        .map_err(|e| format!("invalid account patch: {e}"))?;
    persist(&app, &s).await?;
    emit_changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn accounts_remove(
    state: State<'_, AccountsStore>,
    app: AppHandle<impl Runtime>,
    provider_id: String,
    account_id: String,
) -> Result<(), String> {
    let mut s = state.state(&app).await?.lock().await;
    if let Some(map) = s.accounts.get_mut(&provider_id) {
        map.remove(&account_id);
        if map.is_empty() {
            s.accounts.remove(&provider_id);
        }
    }
    if s.active_accounts.get(&provider_id) == Some(&account_id) {
        s.active_accounts.remove(&provider_id);
    }
    persist(&app, &s).await?;
    emit_changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn accounts_set_active(
    state: State<'_, AccountsStore>,
    app: AppHandle<impl Runtime>,
    provider_id: String,
    account_id: String,
) -> Result<(), String> {
    let mut s = state.state(&app).await?.lock().await;
    let exists = s
        .accounts
        .get(&provider_id)
        .map(|m| m.contains_key(&account_id))
        .unwrap_or(false);
    if !exists {
        return Err(format!("unknown account {account_id} for provider {provider_id}"));
    }
    s.active_accounts.insert(provider_id, account_id);
    persist(&app, &s).await?;
    emit_changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn accounts_list_active(
    state: State<'_, AccountsStore>,
    app: AppHandle<impl Runtime>,
) -> Result<HashMap<String, String>, String> {
    let s = state.state(&app).await?.lock().await;
    Ok(s.active_accounts.clone())
}

#[tauri::command]
pub async fn accounts_get_active(
    state: State<'_, AccountsStore>,
    app: AppHandle<impl Runtime>,
    provider_id: String,
) -> Result<Option<AccountInput>, String> {
    let s = state.state(&app).await?.lock().await;
    if let Some(active_id) = s.active_accounts.get(&provider_id) {
        if let Some(acc) = s.accounts.get(&provider_id).and_then(|m| m.get(active_id)) {
            return Ok(Some(acc.clone()));
        }
    }
    // Fallback: default account, or first. Matches Electron behaviour.
    if let Some(map) = s.accounts.get(&provider_id) {
        if let Some(d) = map.get("default") {
            return Ok(Some(d.clone()));
        }
        if let Some(first) = map.values().next() {
            return Ok(Some(first.clone()));
        }
    }
    Ok(None)
}

// ── Helpers ──────────────────────────────────────────────────────────

/// Shallow-merge a JSON patch into a JSON object. Nested objects are
/// replaced wholesale; primitives are overwritten. Mirrors the Electron
/// handler which spread `existing` over `patch`.
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

    fn sample(id: &str, provider: &str) -> AccountInput {
        AccountInput {
            id: id.into(),
            provider_id: provider.into(),
            label: id.into(),
            email: None,
            auth_method: "api_key".into(),
            api_key: Some("sk-test".into()),
            access_token: None,
            refresh_token: None,
            expires_at: None,
            cli_source: None,
            cli_email: None,
            metadata: None,
            enabled: true,
            last_used_at: None,
            created_at: 1,
        }
    }

    #[test]
    fn clock_returns_epoch_milliseconds() {
        assert_ne!(now_ms(), 0);
    }

    #[test]
    fn serialize_roundtrip_preserves_credentials() {
        let mut state = StoredAccountsState::default();
        state
            .accounts
            .entry("openai".into())
            .or_default()
            .insert("acc-1".into(), sample("acc-1", "openai"));
        state.active_accounts.insert("openai".into(), "acc-1".into());

        let json = serde_json::to_string(&state).unwrap();
        let restored: StoredAccountsState = serde_json::from_str(&json).unwrap();
        let acc = &restored.accounts["openai"]["acc-1"];
        assert_eq!(acc.provider_id, "openai");
        assert_eq!(acc.auth_method, "api_key");
        assert_eq!(acc.api_key.as_deref(), Some("sk-test"));
        assert_eq!(restored.active_accounts["openai"], "acc-1");
    }

    #[test]
    fn merge_json_overwrites_and_adds_fields() {
        let base = serde_json::json!({ "a": 1, "b": 2 });
        let patch = serde_json::json!({ "b": 3, "c": 4 });
        let merged = merge_json(base, patch);
        assert_eq!(merged["a"], 1);
        assert_eq!(merged["b"], 3);
        assert_eq!(merged["c"], 4);
    }

    #[test]
    fn accepts_renderer_provider_account_shape() {
        let account = serde_json::from_value::<AccountInput>(serde_json::json!({
            "id": "default",
            "providerId": "minimax",
            "label": "Default",
            "authMethod": "api_key",
            "apiKey": "test-key",
            "enabled": true,
            "createdAt": 1
        }));
        assert!(account.is_ok(), "ProviderAccount must cross Tauri unchanged");
    }
}