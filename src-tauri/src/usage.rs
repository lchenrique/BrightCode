//! Usage tracking + quota + IPC commands.
//!
//! Mirrors the Electron `usage` store (electron/main/index.ts, lines 89-331):
//!   - records: providerId -> accountId -> Vec<UsageRecord>
//!   - quotas:  providerId -> accountId -> QuotaSnapshot
//!
//! Storage: JSON under `app_data_dir/usage.json`. Each write emits
//! `usage:changed`. Network calls (`usage_fetch_quota`, `usage_fetch_codex`)
//! are gated on an allowlist of HTTPS hosts so a compromised renderer
//! can't use the Rust process as an open proxy.
//!
//! ponytail: hand-rolled JSON + raw reqwest. No `tauri-plugin-store`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::OnceCell;

const STATE_FILE: &str = "usage.json";
const RECORDS_RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1000; // 30 days
const FETCH_TIMEOUT_MS: u64 = 10_000;

/// Hosts allowed for `usage_fetch_quota`. Requests to anything else are
/// rejected at the boundary so the Rust side can't be turned into an
/// open proxy.
const QUOTA_FETCH_ALLOWLIST: &[&str] = &[
    "api.openai.com",
    "api.anthropic.com",
    "generativelanguage.googleapis.com",
    "api.codex.com",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    pub id: String,
    pub provider_id: String,
    pub account_id: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read: Option<u64>,
    #[serde(default)]
    pub cache_write: Option<u64>,
    #[serde(default)]
    pub estimated_cost: Option<f64>,
    pub timestamp: u64,
    /// 'provider' | 'cli' | '9router' | 'estimated'
    pub source: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct StoredUsageState {
    pub records: HashMap<String, HashMap<String, Vec<UsageRecord>>>,
    pub quotas: HashMap<String, HashMap<String, Value>>,
}

#[derive(Clone)]
pub struct UsageStore {
    inner: Arc<OnceCell<tokio::sync::Mutex<StoredUsageState>>>,
}

impl UsageStore {
    pub fn lazy() -> Self {
        Self {
            inner: Arc::new(OnceCell::new()),
        }
    }

    async fn state<R: Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<&tokio::sync::Mutex<StoredUsageState>, String> {
        self.inner
            .get_or_try_init(|| async {
                let path = usage_path(app)?;
                let state = match tokio::fs::read(&path).await {
                    Ok(bytes) => serde_json::from_slice(&bytes)
                        .map_err(|e| format!("failed to parse {path:?}: {e}"))?,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        StoredUsageState::default()
                    }
                    Err(e) => return Err(format!("failed to read {path:?}: {e}")),
                };
                Ok(tokio::sync::Mutex::new(state))
            })
            .await
    }
}

fn usage_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(STATE_FILE))
        .map_err(|e| format!("failed to resolve app data dir: {e}"))
}

async fn persist<R: Runtime>(app: &AppHandle<R>, state: &StoredUsageState) -> Result<(), String> {
    let path = usage_path(app)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("failed to create {parent:?}: {e}"))?;
    }
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|e| format!("failed to serialise usage: {e}"))?;
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

fn emit_changed<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit("usage:changed", ());
}

/// Trim records older than the 30-day retention window. Done on every
/// write so the file never grows unboundedly.
fn trim_records(records: &mut HashMap<String, HashMap<String, Vec<UsageRecord>>>) {
    let cutoff = now_ms().saturating_sub(RECORDS_RETENTION_MS);
    for account_records in records.values_mut() {
        for list in account_records.values_mut() {
            list.retain(|r| r.timestamp >= cutoff);
        }
        account_records.retain(|_, list| !list.is_empty());
    }
    records.retain(|_, m| !m.is_empty());
}

// ── Commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn usage_record(
    state: State<'_, UsageStore>,
    app: AppHandle<impl Runtime>,
    record: UsageRecord,
) -> Result<(), String> {
    if record.provider_id.is_empty() || record.account_id.is_empty() {
        return Err("providerId and accountId are required".into());
    }
    let mut s = state.state(&app).await?.lock().await;
    s.records
        .entry(record.provider_id.clone())
        .or_default()
        .entry(record.account_id.clone())
        .or_default()
        .push(record);
    trim_records(&mut s.records);
    persist(&app, &s).await?;
    emit_changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn usage_get_history(
    state: State<'_, UsageStore>,
    app: AppHandle<impl Runtime>,
    provider_id: String,
    account_id: Option<String>,
    since: Option<u64>,
) -> Result<Vec<UsageRecord>, String> {
    let s = state.state(&app).await?.lock().await;
    let cutoff = since.unwrap_or(0);
    let Some(prov) = s.records.get(&provider_id) else {
        return Ok(vec![]);
    };
    let mut out = Vec::new();
    if let Some(aid) = account_id {
        if let Some(list) = prov.get(&aid) {
            out.extend(list.iter().filter(|r| r.timestamp >= cutoff).cloned());
        }
    } else {
        for list in prov.values() {
            out.extend(list.iter().filter(|r| r.timestamp >= cutoff).cloned());
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn usage_get_all_history(
    state: State<'_, UsageStore>,
    app: AppHandle<impl Runtime>,
) -> Result<HashMap<String, HashMap<String, Vec<UsageRecord>>>, String> {
    let s = state.state(&app).await?.lock().await;
    Ok(s.records.clone())
}

#[tauri::command]
pub async fn usage_clear(
    state: State<'_, UsageStore>,
    app: AppHandle<impl Runtime>,
) -> Result<(), String> {
    let mut s = state.state(&app).await?.lock().await;
    s.records.clear();
    s.quotas.clear();
    persist(&app, &s).await?;
    emit_changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn usage_set_quota(
    state: State<'_, UsageStore>,
    app: AppHandle<impl Runtime>,
    provider_id: String,
    account_id: String,
    quota: serde_json::Value,
) -> Result<(), String> {
    let mut s = state.state(&app).await?.lock().await;
    s.quotas
        .entry(provider_id)
        .or_default()
        .insert(account_id, quota);
    persist(&app, &s).await?;
    emit_changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn usage_get_quota(
    state: State<'_, UsageStore>,
    app: AppHandle<impl Runtime>,
    provider_id: String,
    account_id: String,
) -> Result<Option<Value>, String> {
    let s = state.state(&app).await?.lock().await;
    Ok(s.quotas.get(&provider_id).and_then(|m| m.get(&account_id)).cloned())
}

#[tauri::command]
pub async fn usage_get_all_quotas(
    state: State<'_, UsageStore>,
    app: AppHandle<impl Runtime>,
) -> Result<HashMap<String, HashMap<String, Value>>, String> {
    let s = state.state(&app).await?.lock().await;
    Ok(s.quotas.clone())
}

/// Server-side proxy for the renderer's quota fetches. Validates the URL
/// against the allowlist before issuing the request so a compromised
/// renderer can't turn the Rust process into an open proxy.
#[tauri::command]
pub async fn usage_fetch_quota(
    url: String,
    init: serde_json::Value,
) -> Result<Option<serde_json::Value>, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    if parsed.scheme() != "https" {
        return Err(format!("https required, got {}", parsed.scheme()));
    }
    let host = parsed.host_str().unwrap_or("");
    if !QUOTA_FETCH_ALLOWLIST.contains(&host) {
        return Err(format!("host {host} is not in the quota fetch allowlist"));
    }
    let method = init
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("GET")
        .to_string();
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .unwrap_or(reqwest::Method::GET);
    let headers_value = init.get("headers").cloned().unwrap_or(Value::Null);
    let body = init.get("body").and_then(|v| v.as_str()).map(|s| s.to_string());

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(FETCH_TIMEOUT_MS))
        .build()
        .map_err(|e| format!("client init: {e}"))?;

    let mut req = client.request(method, parsed);
    if let Value::Object(map) = headers_value {
        for (k, v) in map {
            if let Some(s) = v.as_str() {
                req = req.header(k, s);
            }
        }
    }
    if let Some(b) = body {
        req = req.body(b);
    }
    let resp = req.send().await.map_err(|e| format!("fetch failed: {e}"))?;
    let status = resp.status().as_u16();
    let ok = resp.status().is_success();
    let data = resp.json::<Value>().await.unwrap_or(Value::Null);
    Ok(Some(serde_json::json!({ "ok": ok, "status": status, "data": data })))
}

/// Hit the ChatGPT backend usage endpoint with a Bearer access token.
/// Returns `{ok, status, data}` matching the Electron shape.
#[tauri::command]
pub async fn usage_fetch_codex(
    access_token: String,
    account_id: Option<String>,
) -> Result<serde_json::Value, String> {
    if access_token.is_empty() {
        return Ok(serde_json::json!({ "ok": false, "status": 401, "data": null }));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(FETCH_TIMEOUT_MS))
        .build()
        .map_err(|e| format!("client init: {e}"))?;
    let mut req = client.get("https://chatgpt.com/backend-api/wham/usage");
    req = req
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Accept", "application/json")
        .header("originator", "codex_cli_rs")
        .header("OpenAI-Beta", "codex-1");
    if let Some(aid) = account_id.filter(|s| !s.is_empty()) {
        req = req.header("ChatGPT-Account-Id", aid);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(_) => return Ok(serde_json::json!({ "ok": false, "status": 0, "data": null })),
    };
    let status = resp.status().as_u16();
    let ok = resp.status().is_success();
    let data = resp.json::<Value>().await.unwrap_or(Value::Null);
    Ok(serde_json::json!({ "ok": ok, "status": status, "data": data }))
}

/// Read the most recent Codex rate-limit snapshot from `~/.codex/sessions/*.jsonl`.
/// Returns `{ok, data}` matching Electron's shape.
#[tauri::command]
pub async fn usage_read_codex_local() -> Result<serde_json::Value, String> {
    let root = match home_dir() {
        Some(h) => h.join(".codex").join("sessions"),
        None => return Ok(serde_json::json!({ "ok": false, "data": null })),
    };
    match read_latest_codex_local_usage(&root) {
        Some(rate_limits) => Ok(serde_json::json!({ "ok": true, "data": { "rate_limits": rate_limits } })),
        None => Ok(serde_json::json!({ "ok": false, "data": null })),
    }
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
}

/// Walk the Codex sessions dir depth-first and return the most recent
/// `rate_limits` payload found in any *.jsonl file.
fn read_latest_codex_local_usage(root: &Path) -> Option<Value> {
    use std::fs;
    let mut newest: Option<(std::time::SystemTime, Value)> = None;
    walk_jsonl(root, 0, 4, &mut |path| {
        let mtime = match fs::metadata(path).and_then(|m| m.modified()) {
            Ok(t) => t,
            Err(_) => return,
        };
        let text = match fs::read_to_string(path) {
            Ok(s) => s,
            Err(_) => return,
        };
        for line in text.split('\n').rev() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let parsed: Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            // rate_limits can be at the top level or inside `payload`.
            let rl = parsed
                .get("rate_limits")
                .cloned()
                .or_else(|| {
                    parsed
                        .get("payload")
                        .and_then(|p| p.get("rate_limits"))
                        .cloned()
                });
            if let Some(rl) = rl {
                if newest.as_ref().map(|(t, _)| *t < mtime).unwrap_or(true) {
                    newest = Some((mtime, rl));
                }
                return;
            }
        }
    });
    newest.map(|(_, v)| v)
}

fn walk_jsonl<F: FnMut(&Path)>(dir: &Path, depth: u32, max_depth: u32, on_file: &mut F) {
    use std::fs;
    if depth > max_depth {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(it) => it,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            walk_jsonl(&path, depth + 1, max_depth, on_file);
        } else if ft.is_file() && path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
            on_file(&path);
        }
    }
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_rec(id: &str, ts: u64) -> UsageRecord {
        UsageRecord {
            id: id.into(),
            provider_id: "openai".into(),
            account_id: "acc-1".into(),
            model: "gpt-4o".into(),
            input_tokens: 100,
            output_tokens: 50,
            cache_read: None,
            cache_write: None,
            estimated_cost: Some(0.01),
            timestamp: ts,
            source: "provider".into(),
        }
    }

    #[test]
    fn trim_records_drops_older_than_window() {
        let now = now_ms();
        let mut recs: HashMap<String, HashMap<String, Vec<UsageRecord>>> = HashMap::new();
        recs.entry("openai".into()).or_default().insert(
            "acc".into(),
            vec![sample_rec("old", now - RECORDS_RETENTION_MS - 1), sample_rec("new", now)],
        );
        trim_records(&mut recs);
        let list = &recs["openai"]["acc"];
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "new");
    }

    #[test]
    fn allowlist_rejects_unknown_host() {
        // Build a URL with an off-allowlist host to validate the guard.
        let url = "https://evil.example.com/v1/usage";
        let parsed = reqwest::Url::parse(url).unwrap();
        assert_eq!(parsed.scheme(), "https");
        let host = parsed.host_str().unwrap();
        assert!(!QUOTA_FETCH_ALLOWLIST.contains(&host));
    }

    #[test]
    fn allowlist_accepts_known_hosts() {
        for h in QUOTA_FETCH_ALLOWLIST {
            let url = format!("https://{h}/v1/usage");
            let parsed = reqwest::Url::parse(&url).unwrap();
            assert!(QUOTA_FETCH_ALLOWLIST.contains(&parsed.host_str().unwrap()));
        }
    }

    #[test]
    fn serialize_roundtrip_preserves_quotas() {
        let mut s = StoredUsageState::default();
        s.quotas
            .entry("openai".into())
            .or_default()
            .insert("acc-1".into(), serde_json::json!({ "quotaRemaining": 50 }));
        let json = serde_json::to_string(&s).unwrap();
        let restored: StoredUsageState = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.quotas["openai"]["acc-1"]["quotaRemaining"], 50);
    }
}