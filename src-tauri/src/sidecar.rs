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
//! Crash recovery (Task 2.5): when `post()` can't reach the
//! sidecar — connection refused, timeout, refused-port — we treat
//! it as a crash. `RespawnTracker` records the timestamp; after 3
//! failures within 60s we emit `sidecar-fatal` to the renderer
//! and stop retrying. Otherwise a background task re-spawns the
//! sidecar (exponential backoff: 100ms, 200ms, 400ms ... capped at
//! 5s) and swaps `base_url` + `token` in place.
//!
//! ponytail: a singleton `reqwest::Client` lives on `SidecarInner`
//! so we keep the connection pool across requests — building a new
//! client per `post()` would discard keep-alive for the sidecar.
//! ponytail: no `child.wait()` background watcher here because
//! `tauri_plugin_shell::CommandChild` plus the event stream makes
//! a Send-safe watcher expensive to wire correctly. The post()
//! failure path catches a dead sidecar on the next proxy request —
//! acceptable for loopback traffic in Phase 2; a true watcher is
//! queued for the prod sidecar in Phase 6.

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
}

#[derive(Clone)]
pub struct SidecarSupervisor {
    inner: Arc<SidecarInner>,
}

struct SidecarInner {
    /// (base_url, token). Swapped on respawn via `RwLock` — read on
    /// every `post()`, written rarely. `std::sync` is fine: writes
    /// only hold the lock for a String assignment.
    conn: RwLock<Conn>,
    /// Long-lived HTTP client for connection pooling.
    http: reqwest::Client,
    app: AppHandle<Wry>,
    /// Held so the child stays alive while we use it. Replaced on
    /// respawn. ponytail: `CommandChild`'s `Drop` kills the
    /// process, so this field's only job is to keep the child
    /// alive while the supervisor is alive.
    child: Mutex<Option<CommandChild>>,
    /// Phase 2 crash policy state. Mutated on every connection
    /// failure.
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

impl SidecarInner {
    fn new(app: AppHandle<Wry>) -> Self {
        Self {
            conn: RwLock::new(Conn {
                base_url: String::new(),
                token: String::new(),
            }),
            http: reqwest::Client::new(),
            app,
            child: Mutex::new(None),
            tracker: Mutex::new(RespawnTracker::new()),
            retries: Mutex::new(0),
            fatal: Mutex::new(false),
        }
    }
}

impl SidecarSupervisor {
    /// Spawn the sidecar and block until it prints its ready line.
    /// Returns an error string if the sidecar exits, the contract
    /// is malformed, or the timeout elapses.
    pub async fn spawn(app: &AppHandle<Wry>) -> Result<Self, String> {
        let inner = Arc::new(SidecarInner::new(app.clone()));
        Self::spawn_once(&inner).await?;
        let (url, auth_prefix) = {
            let conn = inner.conn.read().map_err(|e| e.to_string())?;
            (
                conn.base_url.clone(),
                conn.token[..conn.token.len().min(8)].to_string(),
            )
        };
        eprintln!("[sidecar] ready: url={url} auth={auth_prefix}…");
        Ok(Self { inner })
    }

    async fn spawn_once(inner: &Arc<SidecarInner>) -> Result<(), String> {
        let entry = resolve_entry()?;
        eprintln!("[sidecar] launching: node {}", entry.display());
        let (rx, child) = inner
            .app
            .shell()
            .command("node")
            .args([entry.to_string_lossy().to_string()])
            .spawn()
            .map_err(|e| format!("failed to spawn node: {e}"))?;
        // Park the child on the supervisor so it lives until the
        // app exits. Drop + respawn replaces it during recovery.
        *inner.child.lock().await = Some(child);

        let (ready_tx, ready_rx) = oneshot::channel::<Result<SidecarReady, String>>();
        let inner_for_watcher = inner.clone();

        // Phase 2 watcher is fire-and-forget: parse the ready line
        // and signal it. The post() failure path handles crash
        // recovery — see module-level note.
        tauri::async_runtime::spawn(async move {
            let mut rx = rx;
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(line) => {
                        let text = std::str::from_utf8(&line).map(str::trim).unwrap_or("");
                        match serde_json::from_str::<SidecarReady>(text) {
                            Ok(parsed) => {
                                {
                                    let Ok(mut conn) = inner_for_watcher.conn.write() else {
                                        continue;
                                    };
                                    conn.base_url = format!("http://127.0.0.1:{}", parsed.port);
                                    conn.token = parsed.auth.clone();
                                }
                                let _ = ready_tx.send(Ok(parsed));
                                return;
                            }
                            Err(_) => continue,
                        }
                    }
                    CommandEvent::Error(e) => {
                        let _ = ready_tx.send(Err(format!("sidecar error: {e}")));
                        return;
                    }
                    CommandEvent::Terminated(payload) => {
                        let _ = ready_tx.send(Err(format!(
                            "sidecar exited before ready (code={:?})",
                            payload.code
                        )));
                        return;
                    }
                    _ => {}
                }
            }
            let _ = ready_tx.send(Err("sidecar stdout closed before ready".to_string()));
        });

        timeout(READY_TIMEOUT, ready_rx)
            .await
            .map_err(|_| format!("sidecar ready timeout ({:?})", READY_TIMEOUT))?
            .map_err(|e| format!("sidecar channel dropped: {e}"))??;
        Ok(())
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
        let res = self
            .inner
            .http
            .post(&url)
            .header("authorization", format!("Bearer {}", token))
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await;

        match res {
            Ok(resp) => {
                let status = resp.status();
                if !status.is_success() {
                    // Read body as text first so we surface the
                    // server's message even if it isn't JSON.
                    let text = resp.text().await.unwrap_or_default();
                    return Err(format!("sidecar returned {status}: {text}"));
                }
                let json: serde_json::Value = resp
                    .json()
                    .await
                    .map_err(|e| format!("sidecar response parse: {e}"))?;
                // Healthy sidecar — clear the failure window.
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
                    RespawnDecision::Fatal => Err(format!("sidecar fatal: {e}")),
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
            }
            RespawnDecision::Retry { after } => {
                eprintln!(
                    "[sidecar] connection failure (retry {} of {}, backoff {:?}): {}",
                    *retries, RESPAWN_MAX_RETRIES, after, e
                );
                let inner = self.inner.clone();
                tauri::async_runtime::spawn(async move {
                    Self::respawn_after(inner, after).await;
                });
            }
        }
        decision
    }

    /// Background respawn driven by `post()`'s failure path. Drops
    /// the dead child, sleeps the policy's backoff, then re-spawns
    /// and swaps conn. ponytail: a `child.wait()` watcher would
    /// catch crashes earlier (before the next request) — deferred
    /// to Phase 6 because `tauri_plugin_shell::CommandChild` over
    /// the event stream is awkward to wire into a `Send` future.
    async fn respawn_after(inner: Arc<SidecarInner>, after: Duration) {
        tokio::time::sleep(after).await;
        *inner.child.lock().await = None;
        if let Err(e) = Self::spawn_once(&inner).await {
            eprintln!("[sidecar] respawn failed: {e}");
        }
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
