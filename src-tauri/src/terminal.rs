//! PTY-backed terminal sessions.
//!
//! Mirrors `electron/main/terminal.ts` but using `portable-pty` so the
//! same code runs on Windows (ConPTY), macOS, and Linux without native
//! node-pty bindings.
//!
//! Events:
//!   emit(`terminal:data`, { sessionId, data })
//!   emit(`terminal:exit`, { sessionId, exitCode, signal })
//!
//! State lives in `TerminalState.sessions: HashMap<sessionId, SessionHandle>`.
//! `terminal_kill` removes from the map and kills the child.

use std::collections::HashMap;
use std::sync::Arc;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use crate::projects::ProjectsStore;

#[derive(Default)]
pub struct TerminalState {
    sessions: Arc<Mutex<HashMap<String, SessionHandle>>>,
}

struct SessionHandle {
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn portable_pty::ChildKiller + Send>,
}

impl std::fmt::Debug for SessionHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionHandle").finish()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dimensions {
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCreateResult {
    pub session_id: String,
    pub shell: String,
    pub cwd: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalEvent {
    Data { session_id: String, data: String },
    Exit {
        session_id: String,
        exit_code: u32,
        signal: Option<u32>,
    },
}

fn clamp_dimension(value: Option<u16>, fallback: u16, min: u16, max: u16) -> u16 {
    match value {
        Some(v) if (min..=max).contains(&v) => v,
        Some(v) if v < min => min,
        Some(_) => max,
        None => fallback,
    }
}

fn shell_config() -> (String, Vec<String>, &'static str) {
    if cfg!(target_os = "windows") {
        return (
            "powershell.exe".to_string(),
            vec!["-NoLogo".to_string()],
            "PowerShell",
        );
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(target_os = "macos") {
            "/bin/zsh".to_string()
        } else {
            "/bin/bash".to_string()
        }
    });
    let label = shell
        .rsplit('/')
        .next()
        .unwrap_or("Terminal")
        .to_string();
    (shell, vec!["-l".to_string()], Box::leak(label.into_boxed_str()))
}

fn terminal_env() -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    env.insert("TERM".into(), "xterm-256color".into());
    env.insert("COLORTERM".into(), "truecolor".into());
    env
}

#[tauri::command]
pub async fn terminal_create(
    app: AppHandle,
    state: State<'_, ProjectsStore>,
    terminal_state: State<'_, TerminalState>,
    project_id: String,
    dimensions: Option<Dimensions>,
) -> Result<TerminalCreateResult, String> {
    let project = state
        .find_by_id(&project_id)
        .await
        .ok_or_else(|| "project not found".to_string())?;
    let cwd = project.path.clone();

    let cols = clamp_dimension(dimensions.as_ref().and_then(|d| d.cols), 80, 2, 500);
    let rows = clamp_dimension(dimensions.as_ref().and_then(|d| d.rows), 24, 1, 300);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let (exe, args, label) = shell_config();
    let mut cmd = CommandBuilder::new(&exe);
    for a in &args {
        cmd.arg(a);
    }
    cmd.cwd(&cwd);
    for (k, v) in terminal_env() {
        cmd.env(k, v);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn: {e}"))?;
    drop(pair.slave); // close slave in this process

    let session_id = uuid::Uuid::new_v4().to_string();
    let killer = child.clone_killer();
    let master = pair.master;
    let killer: Box<dyn portable_pty::ChildKiller + Send> = killer;

    // Reader thread emits terminal:data events.
    {
        let session_id = session_id.clone();
        let app = app.clone();
        let mut reader = match master.try_clone_reader() {
            Ok(r) => r,
            Err(e) => return Err(format!("clone_reader: {e}")),
        };
        std::thread::spawn(move || {
            use std::io::Read;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = app.emit(
                            "terminal:data",
                            serde_json::json!({ "sessionId": session_id, "data": data }),
                        );
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // Waiter thread emits terminal:exit and removes the session.
    {
        let session_id = session_id.clone();
        let app = app.clone();
        let sessions: Arc<Mutex<HashMap<String, SessionHandle>>> = terminal_state.sessions.clone();
        std::thread::spawn(move || {
            let status = child.wait();
            let (exit_code, signal) = match status {
                Ok(s) => (s.exit_code(), None::<u32>),
                Err(_) => (1, None::<u32>),
            };
            let _ = app.emit(
                "terminal:exit",
                serde_json::json!({
                    "sessionId": session_id,
                    "exitCode": exit_code,
                    "signal": signal,
                }),
            );
            // Remove from state synchronously (best-effort).
            if let Ok(mut g) = sessions.try_lock() {
                g.remove(&session_id);
            }
        });
    }

    {
        let mut g = terminal_state.sessions.lock().await;
        g.insert(
            session_id.clone(),
            SessionHandle {
                master,
                killer,
            },
        );
    }

    Ok(TerminalCreateResult {
        session_id,
        shell: label.to_string(),
        cwd,
    })
}

#[tauri::command]
pub async fn terminal_write(
    terminal_state: State<'_, TerminalState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    if data.len() > 1024 * 1024 {
        return Err("data too large".into());
    }
    let mut g = terminal_state.sessions.lock().await;
    let session = g.get_mut(&session_id).ok_or_else(|| "unknown session".to_string())?;
    let mut writer = session
        .master
        .take_writer()
        .map_err(|e| format!("take_writer: {e}"))?;
    use std::io::Write;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write: {e}"))?;
    writer.flush().map_err(|e| format!("flush: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn terminal_resize(
    terminal_state: State<'_, TerminalState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let cols = clamp_dimension(Some(cols), 80, 2, 500);
    let rows = clamp_dimension(Some(rows), 24, 1, 300);
    let g = terminal_state.sessions.lock().await;
    let session = g.get(&session_id).ok_or_else(|| "unknown session".to_string())?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn terminal_kill(
    terminal_state: State<'_, TerminalState>,
    session_id: String,
) -> Result<bool, String> {
    let mut g = terminal_state.sessions.lock().await;
    if let Some(mut session) = g.remove(&session_id) {
        let _ = session.killer.kill();
        return Ok(true);
    }
    Ok(false)
}

impl TerminalState {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_dimension_uses_fallback_for_invalid() {
        assert_eq!(clamp_dimension(None, 80, 2, 500), 80);
        // Below min clamps to min, above max clamps to max (no fallback).
        assert_eq!(clamp_dimension(Some(0), 80, 2, 500), 2);
        assert_eq!(clamp_dimension(Some(1000), 80, 2, 500), 500);
        assert_eq!(clamp_dimension(Some(120), 80, 2, 500), 120);
    }

    #[test]
    fn shell_config_returns_known_default() {
        let (_exe, args, label) = shell_config();
        if cfg!(target_os = "windows") {
            assert_eq!(label, "PowerShell");
            assert!(args.contains(&"-NoLogo".to_string()));
        } else {
            assert!(!label.is_empty());
        }
    }

    #[test]
    fn terminal_env_has_term_and_colorterm() {
        let env = terminal_env();
        assert_eq!(env.get("TERM").map(String::as_str), Some("xterm-256color"));
        assert_eq!(env.get("COLORTERM").map(String::as_str), Some("truecolor"));
    }
}