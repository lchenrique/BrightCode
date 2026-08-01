//! Filesystem commands backing `window.electronAPI.fs.*`.
//!
//! Replaces `electron/main/fs-ops.ts`. The simple cases (home,
//! listDirs, validate, browseFile) are stateless commands; `clone`
//! spawns `git` via `std::process::Command` (Windows-safe).
//!
//! Out of scope for F1+F2: projectTree / projectRead / projectWrite /
//! projectOpen (file viewer + shell-open). Those land with the chat
//! integration.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;
use tokio::process::Command;

#[derive(Debug, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "ok", rename_all = "lowercase")]
pub enum BrowseFileResult {
    True { path: String },
    False,
}

#[derive(Debug, Serialize)]
#[serde(tag = "ok", rename_all = "lowercase")]
pub enum ValidateResult {
    True {
        exists: bool,
        is_dir: bool,
        is_file: bool,
        real_path: String,
    },
    False { error: String },
}

#[derive(Debug, Serialize)]
#[serde(tag = "ok", rename_all = "lowercase")]
pub enum CloneResult {
    True { path: String },
    False { error: String },
}

#[tauri::command]
pub async fn fs_home(app: AppHandle<impl Runtime>) -> Result<String, String> {
    app.path()
        .home_dir()
        .map_err(|e| format!("failed to resolve home dir: {e}"))
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn fs_default_projects_dir(app: AppHandle<impl Runtime>) -> Result<String, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("failed to resolve home dir: {e}"))?;
    let dir = home.join("BrightCodeProjects");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("failed to create {dir:?}: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn fs_list_dirs(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries = Vec::new();
    let mut read_dir = tokio::fs::read_dir(&path)
        .await
        .map_err(|e| format!("failed to read {path:?}: {e}"))?;
    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|e| format!("read_dir error: {e}"))?
    {
        let file_type = match entry.file_type().await {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        entries.push(DirEntry {
            path: entry.path().to_string_lossy().to_string(),
            name,
        });
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(entries)
}

#[tauri::command]
pub async fn fs_browse_file(app: AppHandle<impl Runtime>) -> Result<BrowseFileResult, String> {
    let dialog = app.dialog().clone();
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<PathBuf>>();
    dialog
        .file()
        .pick_file(move |path| {
            let _ = tx.send(path.and_then(|p| p.into_path().ok()));
        });
    match rx.await.map_err(|e| format!("dialog cancelled: {e}"))? {
        Some(p) => Ok(BrowseFileResult::True {
            path: p.to_string_lossy().to_string(),
        }),
        None => Ok(BrowseFileResult::False),
    }
}

#[tauri::command]
pub async fn fs_validate(path: String) -> Result<ValidateResult, String> {
    let p = Path::new(&path);
    let meta = match tokio::fs::metadata(p).await {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ValidateResult::True {
                exists: false,
                is_dir: false,
                is_file: false,
                real_path: String::new(),
            });
        }
        Err(e) => {
            return Ok(ValidateResult::False {
                error: e.to_string(),
            });
        }
    };
    // Canonicalize (resolve symlinks) to give the renderer the real path;
    // fall back to the raw input if canonicalize fails (e.g. UNC paths).
    let real_path = tokio::fs::canonicalize(p)
        .await
        .map(|cp| cp.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.clone());
    Ok(ValidateResult::True {
        exists: true,
        is_dir: meta.is_dir(),
        is_file: meta.is_file(),
        real_path,
    })
}

#[tauri::command]
pub async fn fs_clone(url: String, dest: String) -> Result<CloneResult, String> {
    // Sanitise: only accept https:// or git@ or file:// URLs to avoid
    // shell injection. Windows-safe because git is invoked directly
    // (not via cmd.exe).
    if !is_safe_clone_url(&url) {
        return Ok(CloneResult::False {
            error: format!("clone url not allowed: {url}"),
        });
    }
    let dest_path = PathBuf::from(&dest);
    if let Some(parent) = dest_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("failed to create parent {parent:?}: {e}"))?;
    }
    let child = Command::new("git")
        .args(["clone", &url, &dest])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn git: {e}"))?;
    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("git wait failed: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).to_string();
        return Ok(CloneResult::False {
            error: format!("git clone exited {:?}: {}", output.status.code(), err.trim()),
        });
    }
    Ok(CloneResult::True {
        path: dest,
    })
}

fn is_safe_clone_url(url: &str) -> bool {
    let url = url.trim();
    url.starts_with("https://") || url.starts_with("ssh://") || url.starts_with("file://")
        || url.starts_with("git@")
}

/// Round-trip a path: canonicalize if it exists, otherwise echo back.
#[tauri::command]
pub async fn fs_canonicalize(path: String) -> Result<String, String> {
    match tokio::fs::canonicalize(&path).await {
        Ok(p) => Ok(p.to_string_lossy().to_string()),
        Err(e) => Err(format!("canonicalize {path:?}: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_shell_injection_in_clone_url() {
        // Allowed schemes — git handles the rest of the URL safely
        // because we invoke it via Command::new("git").args(...) which
        // does NOT spawn a shell.
        assert!(is_safe_clone_url("https://example.com/repo"));
        assert!(is_safe_clone_url("ssh://git@github.com/foo/bar"));
        assert!(is_safe_clone_url("git@github.com:foo/bar"));
        assert!(is_safe_clone_url("file:///c:/dev/null"));
        // Reject anything that doesn't have an explicit scheme prefix:
        assert!(!is_safe_clone_url(""));
        assert!(!is_safe_clone_url("rm -rf /"));
        assert!(!is_safe_clone_url("../etc/passwd"));
        assert!(!is_safe_clone_url("ftp://example.com/repo"));
        assert!(!is_safe_clone_url("/absolute/path"));
    }
}
