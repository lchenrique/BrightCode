//! Workspace-level filesystem commands.
//!
//! Replaces the project-scoped operations that used to live in
//! `electron/main/fs-ops.ts::listProjectTree` / `readProjectFile` /
//! `writeProjectFile` / `openProjectTarget`. Every command takes a
//! `projectId` and resolves it against `ProjectsStore`; the
//! `relativePath` is validated against the project's real root to
//! prevent path traversal.
//!
//! ponytail: std `Path::starts_with` + lexical normalisation for the
//! within-root check. Avoids pulling in `dunce`/`path-clean` —
//! canonicalize the root, canonicalize the candidate if it exists,
//! otherwise compare lexically. Bounded by `max_depth` so the tree
//! can't run away on huge repos.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Runtime, State};

use crate::projects::ProjectsStore;

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const BINARY_PROBE_BYTES: usize = 8 * 1024;
const DEFAULT_MAX_DEPTH: usize = 4;
const HARD_MAX_DEPTH: usize = 16;
const MAX_TREE_ENTRIES: usize = 5000;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub name: String,
    pub path: String,
    pub relative_path: String,
    pub kind: String, // "file" | "directory"
    pub children: Option<Vec<WorkspaceEntry>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReadResult {
    pub contents: String,
    pub size_bytes: u64,
    pub is_binary: bool,
}

// ── Commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn workspace_list_tree(
    state: State<'_, ProjectsStore>,
    project_id: String,
    max_depth: Option<usize>,
) -> Result<WorkspaceEntry, String> {
    let (project_root, project_label) = resolve_project(&state, &project_id).await?;
    let requested = max_depth.unwrap_or(DEFAULT_MAX_DEPTH);
    let depth = requested.min(HARD_MAX_DEPTH);
    let root_path = tokio::fs::canonicalize(&project_root)
        .await
        .map_err(|e| format!("failed to canonicalize {project_root:?}: {e}"))?;
    let mut total: usize = 0;
    let children = build_tree(&root_path, "", 0, depth, &mut total).await?;
    Ok(WorkspaceEntry {
        name: project_label,
        path: root_path.to_string_lossy().to_string(),
        relative_path: String::new(),
        kind: "directory".to_string(),
        children: Some(children),
    })
}

#[tauri::command]
pub async fn workspace_read_file(
    state: State<'_, ProjectsStore>,
    project_id: String,
    relative_path: String,
) -> Result<WorkspaceReadResult, String> {
    let (project_root, _) = resolve_project(&state, &project_id).await?;
    let rel = safe_relative_path(&relative_path)?;
    let root = tokio::fs::canonicalize(&project_root)
        .await
        .map_err(|e| format!("failed to canonicalize {project_root:?}: {e}"))?;
    let absolute = resolve_within_root(&root, &rel)?;

    let meta = tokio::fs::metadata(&absolute)
        .await
        .map_err(|e| format!("stat {absolute:?}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("Path is not a file: {rel}"));
    }

    // Read up to MAX_FILE_BYTES + 1 so we can detect a file that grew
    // between metadata and read, instead of silently returning a
    // partial decode as success.
    let file = tokio::fs::File::open(&absolute)
        .await
        .map_err(|e| format!("open {absolute:?}: {e}"))?;
    use tokio::io::AsyncReadExt;
    let mut buf = Vec::with_capacity(meta.len().min(MAX_FILE_BYTES + 1) as usize);
    let mut handle = file.take(MAX_FILE_BYTES + 1);
    handle
        .read_to_end(&mut buf)
        .await
        .map_err(|e| format!("read {absolute:?}: {e}"))?;
    if buf.len() as u64 > MAX_FILE_BYTES {
        return Err(format!(
            "File is larger than {} MB",
            MAX_FILE_BYTES / (1024 * 1024)
        ));
    }
    let size_bytes = buf.len() as u64;
    let is_binary = detect_binary(&buf);
    let contents = if is_binary {
        String::new()
    } else {
        String::from_utf8_lossy(&buf).into_owned()
    };
    Ok(WorkspaceReadResult {
        contents,
        size_bytes,
        is_binary,
    })
}

#[tauri::command]
pub async fn workspace_write_file(
    state: State<'_, ProjectsStore>,
    project_id: String,
    relative_path: String,
    contents: String,
) -> Result<(), String> {
    let (project_root, _) = resolve_project(&state, &project_id).await?;
    let rel = safe_relative_path(&relative_path)?;
    let root = tokio::fs::canonicalize(&project_root)
        .await
        .map_err(|e| format!("failed to canonicalize {project_root:?}: {e}"))?;
    let absolute = resolve_within_root(&root, &rel)?;

    if contents.as_bytes().len() as u64 > MAX_FILE_BYTES {
        return Err(format!("File is larger than {} MB", MAX_FILE_BYTES / (1024 * 1024)));
    }

    let parent = absolute
        .parent()
        .ok_or_else(|| "Path has no parent directory".to_string())?;
    let parent_exists = tokio::fs::try_exists(parent)
        .await
        .map_err(|e| format!("stat parent {parent:?}: {e}"))?;
    if !parent_exists {
        return Err(format!("Parent directory does not exist: {}", parent.display()));
    }
    tokio::fs::write(&absolute, contents.as_bytes())
        .await
        .map_err(|e| format!("write {absolute:?}: {e}"))?;
    Ok(())
}

#[tauri::command]
#[allow(unused_variables)]
pub async fn workspace_open_project(
    _app: AppHandle<impl Runtime>,
    state: State<'_, ProjectsStore>,
    project_id: String,
) -> Result<(), String> {
    let (project_root, _) = resolve_project(&state, &project_id).await?;
    let root = tokio::fs::canonicalize(&project_root)
        .await
        .map_err(|e| format!("failed to canonicalize {project_root:?}: {e}"))?;
    // Best-effort shell-open. Failure is non-fatal; UI shows whatever
    // the OS does. Spec says "just return Ok(())".
    open_in_shell(&root);
    Ok(())
}

#[cfg(target_os = "windows")]
fn open_in_shell(path: &Path) {
    // Use explorer.exe directly — no cmd.exe shell, so path metachars
    // like `&` can't inject commands. explorer.exe accepts the folder
    // as a single argv entry.
    let _ = std::process::Command::new("explorer.exe")
        .arg(path)
        .spawn();
}

#[cfg(target_os = "macos")]
fn open_in_shell(path: &Path) {
    let _ = std::process::Command::new("open")
        .arg(path.to_string_lossy().as_ref())
        .spawn();
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_in_shell(path: &Path) {
    let _ = std::process::Command::new("xdg-open")
        .arg(path.to_string_lossy().as_ref())
        .spawn();
}

// ── Internals ─────────────────────────────────────────────────────────

async fn resolve_project(
    state: &State<'_, ProjectsStore>,
    project_id: &str,
) -> Result<(String, String), String> {
    let project = state
        .find_by_id(project_id)
        .await
        .ok_or_else(|| "Project not found".to_string())?;
    Ok((project.path, project.label))
}

/// Build the nested workspace tree. Each directory entry carries its
/// own `children`; leaf files carry `children: None`. Propagates
/// read_dir errors instead of swallowing them. Bounded by `max_depth`
/// and a global entry cap (`MAX_TREE_ENTRIES`) so a hostile project
/// can't exhaust memory or I/O.
async fn build_tree(
    dir: &Path,
    base: &str,
    depth: usize,
    max_depth: usize,
    total: &mut usize,
) -> Result<Vec<WorkspaceEntry>, String> {
    let mut out: Vec<WorkspaceEntry> = Vec::new();
    if depth >= max_depth || *total >= MAX_TREE_ENTRIES {
        return Ok(out);
    }
    let mut read_dir = tokio::fs::read_dir(dir)
        .await
        .map_err(|e| format!("read_dir {dir:?}: {e}"))?;
    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|e| format!("next_entry {dir:?}: {e}"))?
    {
        if *total >= MAX_TREE_ENTRIES {
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if is_hidden_or_ignored(&name) {
            continue;
        }
        let file_type = entry
            .file_type()
            .await
            .map_err(|e| format!("file_type {dir:?}/{name}: {e}"))?;
        let absolute = entry.path();
        let relative = if base.is_empty() {
            name.clone()
        } else {
            format!("{base}/{name}")
        };
        if file_type.is_dir() {
            // Count the directory itself first, so a subtree that
            // alone exceeds the cap can be skipped entirely.
            if *total + 1 > MAX_TREE_ENTRIES {
                break;
            }
            *total += 1;
            let children = Box::pin(build_tree(&absolute, &relative, depth + 1, max_depth, total)).await?;
            out.push(WorkspaceEntry {
                name,
                path: absolute.to_string_lossy().to_string(),
                relative_path: relative,
                kind: "directory".to_string(),
                children: Some(children),
            });
        } else if file_type.is_file() {
            if *total + 1 > MAX_TREE_ENTRIES {
                break;
            }
            *total += 1;
            out.push(WorkspaceEntry {
                name,
                path: absolute.to_string_lossy().to_string(),
                relative_path: relative,
                kind: "file".to_string(),
                children: None,
            });
        }
    }
    out.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
        ("directory", "file") => std::cmp::Ordering::Less,
        ("file", "directory") => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

/// True when the entry name should be skipped in a project tree.
/// Hidden (`.git`, `.gitignore`) and noisy (`node_modules`, `target`,
/// `dist`) per the spec.
fn is_hidden_or_ignored(name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    matches!(name, "node_modules" | "target" | "dist")
}

/// True if `bytes` look like a binary file. Heuristic: a NUL byte in
/// the first `BINARY_PROBE_BYTES` (universal "not text" marker).
fn detect_binary(bytes: &[u8]) -> bool {
    let probe = &bytes[..bytes.len().min(BINARY_PROBE_BYTES)];
    probe.contains(&0)
}

/// Normalise a relative path: reject absolute, resolve `.`/`..`
/// segments lexically, fold backslashes.
pub(crate) fn safe_relative_path(input: &str) -> Result<String, String> {
    if input.is_empty() {
        return Err("A relative project path is required".to_string());
    }
    let normalised = input.replace('\\', "/");
    // Reject absolute BEFORE stripping a leading slash — on Unix,
    // trimming `/etc/passwd` to `etc/passwd` would otherwise make it
    // look relative.
    if normalised.starts_with('/') || Path::new(&normalised).is_absolute() {
        return Err("Absolute paths are not allowed".to_string());
    }
    let trimmed = normalised.trim_start_matches('/');
    let mut stack: Vec<&str> = Vec::new();
    for segment in trimmed.split('/').filter(|s| !s.is_empty()) {
        match segment {
            "." => continue,
            ".." => {
                if stack.pop().is_none() {
                    return Err("Path escapes the project root".to_string());
                }
            }
            other => stack.push(other),
        }
    }
    if stack.is_empty() {
        return Err("Path escapes the project root".to_string());
    }
    Ok(stack.join("/"))
}

/// Resolve `relative` against `root` and verify it stays inside the
/// (canonicalised) project root. Symlink/junction defence: we walk up
/// the candidate path until we find an existing ancestor, canonicalise
/// *that*, and verify it lives inside the canonicalised root. Then
/// re-attach the non-existing tail. This blocks `root/link/new.txt`
/// where `link` is a symlink pointing outside the project.
pub(crate) fn resolve_within_root(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let candidate = root.join(relative);
    // Find the longest existing prefix and canonicalise it. The
    // remaining tail is appended as-is (it must be created later).
    let (existing_prefix, tail) = find_existing_prefix(&candidate);
    let canon_prefix = std::fs::canonicalize(&existing_prefix)
        .map_err(|e| format!("canonicalize {existing_prefix:?}: {e}"))?;
    if !canon_prefix.starts_with(root) {
        return Err("Path escapes the project root".to_string());
    }
    if tail.components().count() == 0 {
        Ok(canon_prefix)
    } else {
        Ok(canon_prefix.join(tail))
    }
}

fn find_existing_prefix(path: &Path) -> (PathBuf, PathBuf) {
    let mut existing = path.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        let Some(name) = existing.file_name() else {
            // Reached a path that has no file_name (e.g. the root
            // itself on Unix). Fall back to the original path; the
            // canonicalise call will surface the real error.
            return (path.to_path_buf(), PathBuf::new());
        };
        tail.insert(0, name.to_os_string());
        existing.pop();
    }
    let tail_path: PathBuf = tail.iter().collect();
    (existing, tail_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_within_root_accepts_child_rejects_escape() {
        // Real tempdir so canonicalize succeeds on every OS.
        let tmp = std::env::temp_dir().join(format!(
            "bc_ws_test_{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&tmp);
        let root = tmp.canonicalize().unwrap();
        // Valid child that does NOT exist yet: find_existing_prefix
        // walks up to root and re-attaches the tail.
        let ok = resolve_within_root(&root, "src/main.rs").unwrap();
        assert!(ok.starts_with(&root));
        let _ = std::fs::remove_dir_all(&tmp);

        // safe_relative_path still rejects absolute inputs.
        #[cfg(unix)]
        assert!(safe_relative_path("/etc/passwd").is_err());
        #[cfg(windows)]
        assert!(safe_relative_path("C:\\Windows\\System32").is_err());
    }

    #[test]
    fn is_hidden_or_ignored_matches_spec() {
        assert!(is_hidden_or_ignored(".gitignore"));
        assert!(is_hidden_or_ignored(".git"));
        assert!(is_hidden_or_ignored("node_modules"));
        assert!(is_hidden_or_ignored("target"));
        assert!(is_hidden_or_ignored("dist"));
        assert!(!is_hidden_or_ignored("src/main.rs"));
        assert!(!is_hidden_or_ignored("README.md"));
        assert!(!is_hidden_or_ignored("src"));
    }

    #[test]
    fn detect_binary_finds_nul_and_accepts_text() {
        assert!(!detect_binary(b"hello world"));
        assert!(detect_binary(b"hello\0world"));
        assert!(detect_binary(&vec![0u8; 16]));
        assert!(!detect_binary(b"line1\nline2\n"));
        // NUL past the probe window still detected? No — only probe.
        let mut bytes = vec![b'a'; BINARY_PROBE_BYTES + 100];
        bytes[BINARY_PROBE_BYTES + 5] = 0;
        assert!(!detect_binary(&bytes));
    }

    #[test]
    fn safe_relative_path_rejects_absolute_and_dotdot() {
        // On Unix a leading "/" is absolute; on Windows it isn't
        // (drive letters are absolute there).
        #[cfg(unix)]
        assert!(safe_relative_path("/etc/passwd").is_err());
        #[cfg(windows)]
        assert!(safe_relative_path("C:\\Windows\\System32").is_err());
        assert!(safe_relative_path("..").is_err());
        assert!(safe_relative_path("../outside").is_err());
        assert!(safe_relative_path("a/../../outside").is_err());
        assert!(safe_relative_path("").is_err());
        // Valid relative paths:
        assert_eq!(safe_relative_path("src/main.rs").unwrap(), "src/main.rs");
        assert_eq!(
            safe_relative_path("./src/./main.rs").unwrap(),
            "src/main.rs"
        );
        assert_eq!(safe_relative_path("a\\b\\c").unwrap(), "a/b/c");
        assert_eq!(safe_relative_path("file.txt").unwrap(), "file.txt");
    }
}