//! Agent Runtime event subscription bookkeeping.
//!
//! Phase 1 stub: `subscribe` validates the command, returns an empty
//! history + a fresh state placeholder, and stores the subscription in
//! a map keyed by `subscriptionId`. `unsubscribe` removes it. Real
//! event delivery is Phase 2 (via the Node sidecar's SSE endpoint or
//! a webhook that the sidecar POSTs to a Rust HTTP listener — both
//! are out of scope here).
//!
//! The Tauri command surface is intentionally tiny so the renderer
//! side of the bridge can wire against it without depending on Phase 2
//! details.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::sync::Mutex;

#[derive(Default)]
pub struct RuntimeEventsState {
    subs: Mutex<HashMap<String, Subscription>>,
}

#[derive(Clone)]
struct Subscription {
    subscription_id: String,
    thread_id: String,
    created_at_ms: u64,
}

impl RuntimeEventsState {
    pub fn new() -> Self {
        Self::default()
    }
}

#[tauri::command]
pub async fn agent_runtime_subscribe(
    _app: AppHandle,
    state: tauri::State<'_, RuntimeEventsState>,
    command: Value,
) -> Result<Value, String> {
    let subscription_id = command
        .get("subscriptionId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing subscriptionId".to_string())?
        .to_string();
    let thread_id = command
        .get("threadId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing threadId".to_string())?
        .to_string();

    let sub = Subscription {
        subscription_id: subscription_id.clone(),
        thread_id,
        created_at_ms: now_ms(),
    };
    let mut g = state.subs.lock().await;
    g.insert(subscription_id.clone(), sub);

    Ok(json!({
        "state": { "threadId": command.get("threadId"), "phase": "idle" },
        "history": [],
    }))
}

#[tauri::command]
pub async fn agent_runtime_unsubscribe(
    state: tauri::State<'_, RuntimeEventsState>,
    subscription_id: String,
) -> Result<(), String> {
    let mut g = state.subs.lock().await;
    g.remove(&subscription_id);
    Ok(())
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// Helper for tests.
#[allow(dead_code)]
pub(crate) fn active_subscription_count(state_arc: &Arc<RuntimeEventsState>) -> usize {
    if let Ok(g) = state_arc.subs.try_lock() {
        g.len()
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_state_is_empty() {
        let s = RuntimeEventsState::new();
        let g = s.subs.try_lock().unwrap();
        assert!(g.is_empty());
    }

    #[test]
    fn subscribe_command_requires_subscription_id() {
        let bad = serde_json::json!({ "threadId": "t-1" });
        assert!(bad.get("subscriptionId").is_none());
        let good = serde_json::json!({ "subscriptionId": "s-1", "threadId": "t-1" });
        assert_eq!(good.get("subscriptionId").unwrap().as_str(), Some("s-1"));
    }

    #[test]
    fn now_ms_is_monotonic_and_positive() {
        let a = now_ms();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let b = now_ms();
        assert!(a > 0);
        assert!(b >= a);
    }
}