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
//!
//! Crash recovery (Task 2.5): if `post()` can't reach the sidecar
//! (connection refused / timeout), we treat it as a crash and ask
//! `RespawnTracker` for a verdict. After 3 failures within 60s we
//! emit `sidecar-fatal` and stop recovering so the user sees a
//! visible error rather than a silent forever-retry.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Wry};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::{oneshot, Mutex};
use tokio::time::timeout;

/// How long we wait for the sidecar to print its ready line before
/// giving up. Kept short so a broken sidecar fails the app boot
/// loudly instead of hanging the window.
const READY_TIMEOUT: Duration = Duration::from_secs(5);

/// Phase 2 crash policy (Task 2.5): 3 failures inside 60s = fatal.
const RESPAWN_WINDOW: Duration = Duration::from_secs(60);
const RESPAWN_MAX_RETRIES: u32 = 3;
/// Backoff cap so we don't wait minutes after a flapping sidecar.
const RESPAWN_BACKOFF_CAP: Duration = Duration::from_secs(5);

#[derive(Debug, Deserialize)]
struct SidecarReady {
    auth: String,
    port: u16,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RespawnDecision {
    /// Spawn again after `after`.
    Retry { after: Duration },
    /// Too many failures in the window — surface to renderer.
    Fatal,
}

/// Pure unit: decides whether one more failure is fatal or just a
/// retryable blip. Trimmed to a window, capped backoff. Lifted out
/// of the supervisor so we can unit-test it without a real Node
/// process.
///
/// ponytail: history is a `VecDeque<Instant>` rather than a ring
/// buffer or a sliding-window aggregate — N<=3 small, N>=max we
/// stop, the count is the only thing we read.
#[derive(Debug)]
pub(crate) struct RespawnTracker {
    window: Duration,
    max_retries: u32,
    failures: VecDeque<Instant>,
}

impl RespawnTracker {
    pub(crate) fn new() -> Self {
        Self {
            window: RESPAWN_WINDOW,
            max_retries: RESPAWN_MAX_RETRIES,
            failures: VecDeque::new(),
        }
    }

    pub(crate) fn record_failure(&mut self, now: Instant) -> RespawnDecision {
        while let Some(front) = self.failures.front() {
            if now.duration_since(*front) > self.window {
                self.failures.pop_front();
            } else {
                break;
            }
        }
        self.failures.push_back(now);
        let count = self.failures.len() as u32;
        if count >= self.max_retries {
            return RespawnDecision::Fatal;
        }
        // 100ms, 200ms, 400ms ... capped at RESPAWN_BACKOFF_CAP.
        let shift = count.saturating_sub(1).min(8);
        let backoff = Duration::from_millis(100u64 << shift).min(RESPAWN_BACKOFF_CAP);
        RespawnDecision::Retry { after: backoff }
    }

    pub(crate) fn failure_count(&self) -> usize {
        self.failures.len()
    }
}

#[derive(Clone)]
pub struct SidecarSupervisor {
    inner: Arc<SidecarInner>,
}

struct SidecarInner {
    /// (base_url, token). Swapped on respawn via `RwLock` — read on
    /// every `post()`, written rarely. Using `std::sync::RwLock`
    /// because we only hold it long enough to clone Strings.
    conn: RwLock<Conn>,
    app: AppHandle<Wry>,
    /// Held so the child stays alive while we use it. Replaced on
    /// respawn.
    child: Mutex<Option<CommandChild>>,
    /// Phase 2 crash policy state. Mutated on every connection
    /// failure; shared with the respawn task so retries reset the
    /// window only when a successful `post()` clears it.
    tracker: Mutex<RespawnTracker>,
    /// Last retry outcome (handy for `cargo run` log scraping).
    retries: Mutex<u32>,
    /// Fatal flag — once tripped, no further respawns.
    fatal: Mutex<bool>,
}

struct Conn {
    base_url: String,
    token: String,
}

impl SidecarSupervisor {
    /// Spawn the sidecar and block until it prints its ready line.
    /// Returns an error string if the sidecar exits, the contract
    /// is malformed, or the timeout elapses.
    pub async fn spawn(app: &AppHandle<Wry>) -> Result<Self, String> {
        let boot = Self::spawn_once(app).await?;
        Ok(Self {
            inner: Arc::new(SidecarInner {
                conn: RwLock::new(Conn {
                    base_url: format!("http://127.0.0.1:{}", boot.port),
                    token: boot.auth,
                }),
                app: app.clone(),
                child: Mutex::new(Some(boot.child)),
                tracker: Mutex::new(RespawnTracker::new()),
                retries: Mutex::new(0),
                fatal: Mutex::new(false),
            }),
        })
    }

    async fn spawn_once(app: &AppHandle<Wry>) -> Result<ReadyBoot, String> {
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

        let token_prefix = &ready.auth[..ready.auth.len().min(8)];
        eprintln!(
            "[sidecar] ready: url=http://127.0.0.1:{} auth={token_prefix}…",
            ready.port
        );

        Ok(ReadyBoot {
            port: ready.port,
            auth: ready.auth,
            child,
        })
    }

    /// POST `body` to `<base_url><path>` with the bearer token. Used
    /// by `proxy_agent_runtime` (Task 2.4). On connection error we
    /// ask the respawn tracker for a verdict — if it's `Retry`, a
    /// background task re-spawns the sidecar; if `Fatal`, we emit
    /// `sidecar-fatal` and keep returning errors so the renderer
    /// sees the breakage.
    pub async fn post(
        &self,
        path: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        // If we already gave up, short-circuit so the renderer gets a
        // meaningful error instead of more timeouts.
        if *self.inner.fatal.lock().await {
            return Err("sidecar fatal: too many crashes, restart the app".to_string());
        }

        let (url, token) = {
            let conn = self.inner.conn.read().map_err(|e| e.to_string())?;
            (format!("{}{}", conn.base_url, path), conn.token.clone())
        };
        let client = reqwest::Client::new();
        let res = client
            .post(&url)
            .header("authorization", format!("Bearer {}", token))
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await;

        match res {
            Ok(resp) => {
                let status = resp.status();
                let json: serde_json::Value = resp
                    .json()
                    .await
                    .map_err(|e| format!("sidecar response parse: {e}"))?;
                if !status.is_success() {
                    return Err(format!("sidecar returned {status}: {json}"));
                }
                // Successful post — a healthy sidecar is no longer
                // suspect, so clear the failure window.
                self.inner.tracker.lock().await.failures.clear();
                Ok(json)
            }
            Err(e) => {
                let verdict = self.handle_failure(&e).await;
                match verdict {
                    RespawnDecision::Retry { after } => Err(format!(
                        "sidecar request failed (will retry in {:?}): {e}",
                        after
                    )),
                    RespawnDecision::Fatal => {
                        Err(format!("sidecar fatal: {e}"))
                    }
                }
            }
        }
    }

    async fn handle_failure(&self, e: &reqwest::Error) -> RespawnDecision {
        let mut tracker = self.inner.tracker.lock().await;
        let mut retries = self.inner.retries.lock().await;
        *retries = retries.saturating_add(1);
        let decision = tracker.record_failure(Instant::now());
        match decision {
            RespawnDecision::Fatal => {
                *self.inner.fatal.lock().await = true;
                eprintln!(
                    "[sidecar] FATAL after {} retries: {}",
                    *retries, e
                );
                let _ = self.inner.app.emit(
                    "sidecar-fatal",
                    serde_json::json!({
                        "retries": *retries,
                        "lastError": e.to_string(),
                    }),
                );
                RespawnDecision::Fatal
            }
            RespawnDecision::Retry { after } => {
                eprintln!(
                    "[sidecar] connection failure (retry {} of {}, backoff {:?}): {}",
                    *retries, RESPAWN_MAX_RETRIES, after, e
                );
                let inner = self.inner.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(after).await;
                    if let Err(re) = Self::respawn(&inner).await {
                        eprintln!("[sidecar] respawn failed: {re}");
                    }
                });
                RespawnDecision::Retry { after }
            }
        }
    }

    async fn respawn(inner: &SidecarInner) -> Result<(), String> {
        let app = inner.app.clone();
        // Drop the old child before spawning a new one to release
        // the bound port.
        *inner.child.lock().await = None;
        let boot = Self::spawn_once(&app).await?;
        {
            let mut conn = inner.conn.write().map_err(|e| e.to_string())?;
            conn.base_url = format!("http://127.0.0.1:{}", boot.port);
            conn.token = boot.auth;
        }
        *inner.child.lock().await = Some(boot.child);
        let token_prefix_len = inner.conn.read().map_err(|e| e.to_string())?.token.len().min(8);
        let auth_prefix = &inner.conn.read().map_err(|e| e.to_string())?.token[..token_prefix_len];
        eprintln!(
            "[sidecar] respawned: url=http://127.0.0.1:{} auth={auth_prefix}…",
            boot.port
        );
        Ok(())
    }

    pub async fn retry_count(&self) -> u32 {
        *self.inner.retries.lock().await
    }

    #[allow(dead_code)]
    pub fn base_url(&self) -> String {
        self.inner
            .conn
            .read()
            .map(|c| c.base_url.clone())
            .unwrap_or_default()
    }

    #[allow(dead_code)]
    pub fn token(&self) -> String {
        self.inner
            .conn
            .read()
            .map(|c| c.token.clone())
            .unwrap_or_default()
    }
}

struct ReadyBoot {
    port: u16,
    auth: String,
    child: CommandChild,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_first_failure_is_short_retry() {
        let mut t = RespawnTracker::new();
        let now = Instant::now();
        assert!(matches!(
            t.record_failure(now),
            RespawnDecision::Retry { after } if after == Duration::from_millis(100)
        ));
    }

    #[test]
    fn allowlist_backoff_doubles_each_retry() {
        let mut t = RespawnTracker::new();
        let now = Instant::now();
        // First failure → 100ms backoff.
        assert!(matches!(
            t.record_failure(now),
            RespawnDecision::Retry { after } if after == Duration::from_millis(100)
        ));
        // Second failure within window → 200ms backoff.
        let after = match t.record_failure(now) {
            RespawnDecision::Retry { after } => after,
            other => panic!("second failure should retry, got {other:?}"),
        };
        // Doubled vs first retry (100ms).
        assert_eq!(after, Duration::from_millis(200));
    }

    #[test]
    fn three_failures_within_window_is_fatal() {
        let mut t = RespawnTracker::new();
        let now = Instant::now();
        assert!(matches!(t.record_failure(now), RespawnDecision::Retry { .. }));
        assert!(matches!(t.record_failure(now), RespawnDecision::Retry { .. }));
        assert!(matches!(t.record_failure(now), RespawnDecision::Fatal));
    }

    #[test]
    fn failures_outside_window_reset_count() {
        let mut t = RespawnTracker::new();
        let now = Instant::now();
        let _ = t.record_failure(now);
        let _ = t.record_failure(now);
        // Simulate "61s later" — both should fall out of the window.
        let later = now + RESPAWN_WINDOW + Duration::from_secs(1);
        assert!(matches!(
            t.record_failure(later),
            RespawnDecision::Retry { after } if after == Duration::from_millis(100)
        ));
    }

    #[test]
    fn backoff_never_exceeds_cap() {
        let mut fresh = RespawnTracker::new();
        if let RespawnDecision::Retry { after } = fresh.record_failure(Instant::now()) {
            assert!(after <= RESPAWN_BACKOFF_CAP);
        } else {
            panic!("first failure should be a retry, not fatal");
        }
    }
}
