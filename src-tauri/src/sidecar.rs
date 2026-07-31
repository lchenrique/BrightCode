//! Sidecar supervisor.
//!
//! Spawns the Node sidecar (`node-sidecar/bin/server.js`), parses the
//! ready contract printed to stdout, and exposes `post()` for the
//! Rust proxy command (added in Task 2.4).
//!
//! Ready contract:
//!   stdout line containing {\"auth\":\"<64-hex>\",\"port\":<int>}
//!
//! In dev we launch `node` directly against the built JS bundle
//! (no externalBin yet — that lands with the prod bundle in
//! Phase 6). When externalBin is wired up, switch
//! `app.shell().command("node")` to `app.shell().sidecar("brightcode-sidecar")`.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::{oneshot, Mutex};
use tokio::time::timeout;

/// How long we wait for the sidecar to print its ready line before
/// giving up. Kept short so a broken sidecar fails the app boot
/// loudly instead of hanging the window.
const READY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Deserialize)]
struct SidecarReady {
    auth: String,
    port: u16,
}

#[derive(Clone)]
pub struct SidecarSupervisor {
    inner: Arc<SidecarInner>,
}

struct SidecarInner {
    base_url: String,
    token: String,
    /// Held so the child stays alive while we use it. Task 2.5
    /// consumes this in the respawn watcher.
    #[allow(dead_code)]
    child: Mutex<Option<CommandChild>>,
}

impl SidecarSupervisor {
    /// Spawn the sidecar and block until it prints its ready line.
    /// Returns an error string if the sidecar exits, the contract
    /// is malformed, or the timeout elapses.
    pub async fn spawn<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        let entry = resolve_entry()?;
        eprintln!("[sidecar] launching: node {}", entry.display());

        let (mut rx, child) = app
            .shell()
            .command("node")
            .args([entry.to_string_lossy().to_string()])
            .spawn()
            .map_err(|e| format!("failed to spawn node: {e}"))?;

        let (tx, ready_rx) = oneshot::channel::<Result<SidecarReady, String>>();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(line) => {
                        let text = match std::str::from_utf8(&line) {
                            Ok(t) => t.trim(),
                            Err(_) => continue,
                        };
                        match serde_json::from_str::<SidecarReady>(text) {
                            Ok(ready) => {
                                let _ = tx.send(Ok(ready));
                                return;
                            }
                            Err(_) => continue,
                        }
                    }
                    CommandEvent::Error(e) => {
                        let _ = tx.send(Err(format!("sidecar error: {e}")));
                        return;
                    }
                    CommandEvent::Terminated(payload) => {
                        let _ = tx.send(Err(format!(
                            "sidecar exited before ready (code={:?})",
                            payload.code
                        )));
                        return;
                    }
                    _ => {}
                }
            }
            let _ = tx.send(Err("sidecar stdout closed before ready".to_string()));
        });

        let ready = timeout(READY_TIMEOUT, ready_rx)
            .await
            .map_err(|_| format!("sidecar ready timeout ({:?})", READY_TIMEOUT))?
            .map_err(|e| format!("sidecar channel dropped: {e}"))??;

        let base_url = format!("http://127.0.0.1:{}", ready.port);
        let token_prefix = &ready.auth[..ready.auth.len().min(8)];
        eprintln!("[sidecar] ready: url={base_url} auth={token_prefix}…");

        Ok(Self {
            inner: Arc::new(SidecarInner {
                base_url,
                token: ready.auth,
                child: Mutex::new(Some(child)),
            }),
        })
    }

    /// POST `body` to `<base_url><path>` with the bearer token. Used
    /// by `proxy_agent_runtime` (Task 2.4). Returns the parsed JSON
    /// body or an error string with the status code on non-2xx.
    pub async fn post(
        &self,
        path: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let url = format!("{}{}", self.inner.base_url, path);
        let client = reqwest::Client::new();
        let res = client
            .post(&url)
            .header("authorization", format!("Bearer {}", self.inner.token))
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("sidecar request failed: {e}"))?;
        let status = res.status();
        let json: serde_json::Value = res
            .json()
            .await
            .map_err(|e| format!("sidecar response parse: {e}"))?;
        if !status.is_success() {
            return Err(format!("sidecar returned {status}: {json}"));
        }
        Ok(json)
    }

    #[allow(dead_code)]
    pub fn base_url(&self) -> &str {
        &self.inner.base_url
    }

    #[allow(dead_code)]
    pub fn token(&self) -> &str {
        &self.inner.token
    }
}

fn resolve_entry() -> Result<PathBuf, String> {
    // Dev only: resolve relative to src-tauri/Cargo.toml. Cargo sets
    // cwd to src-tauri/ when `cargo run` is invoked by `tauri dev`,
    // so cwd-based resolution is wrong. Prod uses Tauri's sidecar
    // mechanism (Phase 6).
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let entry = manifest_dir
        .parent()
        .ok_or("CARGO_MANIFEST_DIR has no parent")?
        .join("node-sidecar")
        .join("bin")
        .join("server.js");
    if !entry.exists() {
        return Err(format!(
            "sidecar entry not found at {} (run `npm run sidecar:build`)",
            entry.display()
        ));
    }
    Ok(entry)
}
