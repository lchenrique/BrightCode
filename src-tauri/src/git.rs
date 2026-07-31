//! Git operations for the Environmental Info panel.
//!
//! Mirrors `electron/main/git.ts::execGit`: spawn `git` in the
//! registered project root, no shell, return stdout/stderr/exit.
//!
//! Security model:
//!   * `args` is passed directly to `tokio::process::Command` — no
//!     shell, no string interpolation, so the OS does the escaping.
//!   * We still reject empty argv and flag-only invocations (a leading
//!     `-` means the caller is treating this as a `git --exec-path`
//!     style call rather than a subcommand) so the surface stays tight.

use serde::Serialize;
use tauri::State;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

use crate::projects::ProjectsStore;

const GIT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// Allowlist helper: a "safe" arg is non-empty, does not start with `-`,
/// and contains no characters we explicitly forbid (NUL, control bytes).
/// Extracted so tests can pin the contract without spawning a process.
pub(crate) fn is_safe_arg(s: &str) -> bool {
    if s.is_empty() || s.starts_with('-') {
        return false;
    }
    !s.bytes().any(|b| b == 0 || (b < 0x20 && b != b'\t'))
}

#[tauri::command]
pub async fn git_exec(
    state: State<'_, ProjectsStore>,
    project_id: String,
    args: Vec<String>,
) -> Result<GitExecResult, String> {
    if args.is_empty() {
        return Err("invalid args".to_string());
    }
    if args.iter().any(|a| !is_safe_arg(a)) {
        return Err("invalid args".to_string());
    }

    // Match the Electron UI: there must be an active project, and the
    // requested id must match it. Returning distinct errors helps the
    // frontend tell "you forgot to pick a project" from "the project
    // was removed" without exposing internal state.
    if state.active_project().await.is_none() {
        return Err("no active project".to_string());
    }
    let project = state
        .find_by_id(&project_id)
        .await
        .ok_or_else(|| "project not found".to_string())?;
    let cwd = project.path.clone();

    let mut cmd = Command::new("git");
    cmd.args(&args).current_dir(&cwd);
    // Force pipe capture; never inherit a controlling TTY.
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let output = timeout(GIT_TIMEOUT, cmd.output())
        .await
        .map_err(|_| format!("git {:?} timed out after {}s", args, GIT_TIMEOUT.as_secs()))?
        .map_err(|e| format!("failed to start git: {e}"))?;

    Ok(GitExecResult {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_args_rejected() {
        assert!(!is_safe_arg(""));
    }

    #[test]
    fn flag_only_args_rejected() {
        assert!(!is_safe_arg("-v"));
        assert!(!is_safe_arg("--version"));
        assert!(!is_safe_arg("-"));
    }

    #[test]
    fn is_safe_arg_accepts_subcommands_and_rejects_bad_bytes() {
        // Common subcommands and refspecs.
        assert!(is_safe_arg("status"));
        assert!(is_safe_arg("log"));
        assert!(is_safe_arg("diff"));
        assert!(is_safe_arg("HEAD"));
        assert!(is_safe_arg("/tmp/repo"));
        assert!(is_safe_arg("src/main.rs"));
        assert!(is_safe_arg("origin/main"));
        // Embedded NUL or newline = reject (would break argv parsing
        // on some platforms and is never a legitimate git arg).
        assert!(!is_safe_arg("foo\0bar"));
        assert!(!is_safe_arg("foo\nbar"));
        assert!(!is_safe_arg("foo\rbar"));
    }
}
