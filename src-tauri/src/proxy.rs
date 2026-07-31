//! Tauri commands that proxy renderer requests to the Node sidecar.
//!
//! Phase 3 wires the full `agent-runtime-ipc` channel set so the renderer
//! can drive the sidecar the same way Electron's preload does. Event
//! subscription (`/v1/agent-runtime/events/subscribe`) is intentionally
//! out of scope here — it returns a stream that Tauri delivers via the
//! `app.emit` event bus instead of through this proxy.
//!
//! Allowlist logic is the unit-testable seam. The supervisor's
//! `post()` is exercised end-to-end through the real sidecar.

use serde_json::Value;
use tauri::State;

use crate::sidecar::SidecarSupervisor;

const ALLOWED_PATHS: &[&str] = &[
    "/v1/agent-runtime/thread/create",
    "/v1/agent-runtime/thread/read",
    "/v1/agent-runtime/history/read",
    "/v1/agent-runtime/turn/start",
    "/v1/agent-runtime/turn/interrupt",
];

/// Whether `path` is reachable in Phase 3. Exact-match only; partial
/// segments don't count, so `/v1/agent-runtime/thread/create/extra`
/// and `v1/agent-runtime/thread/create` (no leading slash) are out.
fn is_allowed_path(path: &str) -> bool {
    ALLOWED_PATHS.iter().any(|p| *p == path)
}

#[tauri::command]
pub async fn proxy_agent_runtime(
    state: State<'_, SidecarSupervisor>,
    path: String,
    body: Value,
) -> Result<Value, String> {
    if !is_allowed_path(&path) {
        return Err(format!("path not allowed in phase 2: {path}"));
    }
    state.post(&path, body).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_thread_create_path() {
        assert!(is_allowed_path("/v1/agent-runtime/thread/create"));
    }

    #[test]
    fn allows_all_phase3_runtime_paths() {
        for path in ALLOWED_PATHS {
            assert!(is_allowed_path(path), "expected {path} to be allowed");
        }
    }

    #[test]
    fn rejects_unknown_paths() {
        // Subscription is delivered via Tauri events, not this proxy.
        assert!(!is_allowed_path("/v1/agent-runtime/events/subscribe"));
        assert!(!is_allowed_path("/v1/agent-runtime/events/unsubscribe"));
        // Trailing path injection
        assert!(!is_allowed_path("/v1/agent-runtime/thread/create/extra"));
        // Missing leading slash
        assert!(!is_allowed_path("v1/agent-runtime/thread/create"));
        // Empty
        assert!(!is_allowed_path(""));
        // Root
        assert!(!is_allowed_path("/"));
    }
}
