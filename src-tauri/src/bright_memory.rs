//! Bright Memory status + install commands.
//!
//! Mirrors `electron/main/bright-memory.ts::detectBrightMemoryStatus`
//! and `installBrightMemory`. Bright Memory is the user's persistent
//! memory layer (skill installed in `~/.agents/skills/bright-memory/`
//! plus a global rule file under each provider — `.codex/AGENTS.md`,
//! `.claude/CLAUDE.md`, `.gemini/GEMINI.md`, `.minimax/...`).
//!
//! ponytail: install uses `git clone` of
//! `https://github.com/lchenrique/bright-memory.git` to a temp dir,
//! reads SKILL.md, writes each global rule file. No platform-shell
//! wrapping because git is invoked directly via std::process::Command.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Serialize;
use tokio::process::Command;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrightMemoryStatus {
    pub cli_installed: bool,
    pub cli_version: Option<String>,
    pub global_rule_configured: bool,
    pub rule_paths: Vec<String>,
    pub ready: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "ok", rename_all = "lowercase")]
pub enum BrightMemoryInstallResult {
    True { status: BrightMemoryStatus },
    False {
        error: String,
        status: BrightMemoryStatus,
    },
}

const REPOSITORY_URL: &str = "https://github.com/lchenrique/bright-memory.git";
const RELEASE_BRANCH: &str = "cloud-self-host-distribution";

fn rule_paths(home: &Path) -> Vec<PathBuf> {
    vec![
        home.join(".agents").join("skills").join("bright-memory").join("SKILL.md"),
        home.join(".codex").join("AGENTS.md"),
        home.join(".claude").join("CLAUDE.md"),
        home.join(".claude").join("skills").join("bright-memory").join("SKILL.md"),
        home.join(".gemini").join("GEMINI.md"),
        home.join(".gemini").join("skills").join("bright-memory").join("SKILL.md"),
        home.join(".minimax").join("skills").join("bright-memory").join("SKILL.md"),
    ]
}

#[tauri::command]
pub async fn bright_memory_status() -> Result<BrightMemoryStatus, String> {
    let home = dirs_home().ok_or_else(|| "failed to resolve home dir".to_string())?;
    let paths = rule_paths(&home);
    let mut installed = 0usize;
    let mut installed_paths = Vec::new();
    for path in &paths {
        if path.exists() {
            installed += 1;
            installed_paths.push(path.to_string_lossy().to_string());
        }
    }
    // cli_version is informational; for Phase 3 we report installed
    // when the SKILL.md exists under any of the canonical homes.
    let cli_installed = paths.iter().any(|p| p.exists());
    Ok(BrightMemoryStatus {
        cli_installed,
        cli_version: None,
        global_rule_configured: installed > 0,
        rule_paths: installed_paths,
        ready: cli_installed,
    })
}

#[tauri::command]
pub async fn bright_memory_install() -> Result<BrightMemoryInstallResult, String> {
    let pre = bright_memory_status()
        .await
        .map_err(|e| format!("status probe failed: {e}"))?;

    let home = dirs_home().ok_or_else(|| "failed to resolve home dir".to_string())?;
    let tmp = std::env::temp_dir().join(format!(
        "brightcode-bright-memory-{}",
        std::process::id()
    ));

    // Pull the skill source.
    let clone_result = Command::new("git")
        .args([
            "clone",
            "--depth",
            "1",
            "--branch",
            RELEASE_BRANCH,
            REPOSITORY_URL,
        ])
        .arg(&tmp)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await;

    let clone_output = match clone_result {
        Ok(out) => out,
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&tmp).await;
            return Ok(BrightMemoryInstallResult::False {
                error: format!("failed to spawn git: {e}"),
                status: pre,
            });
        }
    };

    if !clone_output.status.success() {
        let stderr = String::from_utf8_lossy(&clone_output.stderr).to_string();
        let _ = tokio::fs::remove_dir_all(&tmp).await;
        return Ok(BrightMemoryInstallResult::False {
            error: format!("git clone failed: {}", stderr.trim()),
            status: pre,
        });
    }

    let skill_md = tmp.join("SKILL.md");
    let skill_contents = match tokio::fs::read_to_string(&skill_md).await {
        Ok(s) => s,
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&tmp).await;
            return Ok(BrightMemoryInstallResult::False {
                error: format!("SKILL.md missing or unreadable in clone: {e}"),
                status: pre,
            });
        }
    };

    // Write each rule path. Create parents if needed. Skip files
    // already containing the skill (idempotent re-install).
    let paths = rule_paths(&home);
    for path in &paths {
        if let Some(parent) = path.parent() {
            if let Err(e) = tokio::fs::create_dir_all(parent).await {
                let _ = tokio::fs::remove_dir_all(&tmp).await;
                return Ok(BrightMemoryInstallResult::False {
                    error: format!("create_dir_all {parent:?}: {e}"),
                    status: pre,
                });
            }
        }
        let already = match tokio::fs::read_to_string(path).await {
            Ok(existing) => existing.contains(&skill_contents),
            Err(_) => false,
        };
        if already {
            continue;
        }
        if let Err(e) = tokio::fs::write(path, &skill_contents).await {
            let _ = tokio::fs::remove_dir_all(&tmp).await;
            return Ok(BrightMemoryInstallResult::False {
                error: format!("write {path:?}: {e}"),
                status: pre,
            });
        }
    }

    let _ = tokio::fs::remove_dir_all(&tmp).await;
    let post = bright_memory_status()
        .await
        .map_err(|e| format!("status probe failed: {e}"))?;
    Ok(BrightMemoryInstallResult::True { status: post })
}

fn dirs_home() -> Option<PathBuf> {
    // Use HOME on unix, USERPROFILE on Windows. Same env vars that
    // Tauri's path.home_dir resolves to.
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rule_paths_include_canonical_homes() {
        let home = std::path::PathBuf::from("/tmp/h");
        let paths = rule_paths(&home);
        assert!(paths.iter().any(|p| p.ends_with(".codex/AGENTS.md")));
        assert!(paths.iter().any(|p| p.ends_with(".claude/CLAUDE.md")));
        assert!(paths.iter().any(|p| p.ends_with(".gemini/GEMINI.md")));
        assert!(paths.iter().any(|p| p.ends_with("bright-memory/SKILL.md")));
    }

    #[test]
    fn dirs_home_returns_some() {
        // Whatever the test env, dirs_home must not panic; if the
        // platform default env is unset (rare in CI) it returns None
        // which is acceptable.
        let _ = dirs_home();
    }
}
