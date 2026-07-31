//! Tauri commands that proxy renderer requests to the Node sidecar.
//!
//! Phase 2 wires a single path: `/v1/agent-runtime/thread/create`.
//! The allowlist is a Phase 2 hard-code; Phase 3 widens it to match
//! the full `agent-runtime-ipc` channel set.
//!
//! Allowlist logic is the unit-testable seam. The supervisor's
//! `post()` is exercised end-to-end through the real sidecar in
//! Task 2.6.

use serde_json::Value;
use tauri::State;

use crate::sidecar::SidecarSupervisor;

const ALLOWED_PATHS: &[&str] = &["/v1/agent-runtime/thread/create"];

/// Whether `path` is reachable in Phase 2. Exact-match only; partial
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
    fn rejects_unknown_paths() {
        // Other IPC channels
        assert!(!is_allowed_path("/v1/agent-runtime/thread/read"));
        assert!(!is_allowed_path("/v1/agent-runtime/turn/start"));
        assert!(!is_allowed_path("/v1/agent-runtime/turn/interrupt"));
        assert!(!is_allowed_path("/v1/agent-runtime/history/read"));
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
