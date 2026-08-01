//! Agent-side tool dispatch.
//!
//! Mirrors `electron/main/tools.ts::executeTool`. Sandboxed to the active
//! project root: every `path` arg must resolve inside the root.
//!
//! Tools:
//!   read_file, write_file, edit_file, list_files, search_files,
//!   list_skills, read_skill, read_skill_file, bash.
//!
//! Bash requires per-call user approval: the renderer is asked via
//! `tool:bash-approval-request` and answers via
//! `tools_respond_bash_approval(approvalId, approved)`.
//!
//! ponytail: the dispatch is a `match` on `name` instead of a registry
//! or trait table — exactly one tool per variant, no future-proofing.
//! The toolset is fixed by the agent contract; if it changes, this file
//! changes too. Adding indirection would just hide the surface.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncReadExt;
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

use crate::projects::{Project, ProjectsStore};

const BASH_APPROVAL_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const BASH_OUTPUT_BYTE_LIMIT: usize = 200_000;

#[derive(Debug)]
pub struct ToolsState {
    pending_bash: Arc<Mutex<std::collections::HashMap<String, PendingBash>>>,
}

#[derive(Debug)]
struct PendingBash {
    sender: oneshot::Sender<bool>,
}

impl Default for ToolsState {
    fn default() -> Self {
        Self {
            pending_bash: Arc::new(Mutex::new(std::collections::HashMap::new())),
        }
    }
}

impl ToolsState {
    pub fn new() -> Self {
        Self::default()
    }
}

#[tauri::command]
pub async fn tools_execute(
    state: State<'_, ProjectsStore>,
    app: AppHandle,
    tools_state: State<'_, ToolsState>,
    request: Value,
) -> Result<Value, String> {
    let project = state.active_project().await;
    let name = request
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing tool name".to_string())?
        .to_string();
    let args = request.get("args").cloned().unwrap_or(Value::Null);

    match name.as_str() {
        "list_skills" => return Ok(list_skills(&state, &args).await),
        "read_skill" => return Ok(read_skill_tool(&state, &args).await),
        "read_skill_file" => {
            return Ok(json!({
                "ok": false,
                "error": "read_skill_file: not implemented in Rust sidecar yet"
            }));
        }
        _ => {}
    }

    let project = project.ok_or_else(|| {
        "No active project — pick one in the sidebar first.".to_string()
    })?;
    let project_root = project.path.clone();

    match name.as_str() {
        "read_file" => {
            let rel = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "path is required".to_string())?;
            Ok(read_file(&project_root, rel).await)
        }
        "write_file" => {
            let rel = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "path is required".to_string())?;
            let content = args
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "content is required".to_string())?;
            Ok(write_file(&project_root, rel, content).await)
        }
        "edit_file" => {
            let rel = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "path is required".to_string())?;
            let old_text = args
                .get("oldText")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "oldText is required".to_string())?;
            let new_text = args
                .get("newText")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "newText is required".to_string())?;
            let replace_all = args
                .get("replaceAll")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            Ok(edit_file(&project_root, rel, old_text, new_text, replace_all).await)
        }
        "list_files" => {
            let rel = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
            let recursive = args
                .get("recursive")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            Ok(list_files(&project_root, rel, recursive).await)
        }
        "search_files" => {
            let query = args
                .get("query")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "query is required".to_string())?;
            let rel = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
            let include = args.get("includePattern").and_then(|v| v.as_str());
            Ok(search_files(&project_root, query, rel, include).await)
        }
        "bash" => {
            let command = args
                .get("command")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "command is required".to_string())?
                .to_string();
            let cwd_rel = args.get("cwd").and_then(|v| v.as_str()).map(|s| s.to_string());
            let timeout_ms = args.get("timeoutMs").and_then(|v| v.as_u64());
            Ok(run_bash(
                &project_root,
                cwd_rel,
                command,
                timeout_ms,
                &app,
                tools_state.pending_bash.clone(),
            )
            .await)
        }
        other => Ok(json!({ "ok": false, "error": format!("unknown tool: {other}") })),
    }
}

#[tauri::command]
pub async fn tools_respond_bash_approval(
    tools_state: State<'_, ToolsState>,
    approval_id: String,
    approved: bool,
) -> Result<(), String> {
    let mut g = tools_state.pending_bash.lock().await;
    if let Some(p) = g.remove(&approval_id) {
        let _ = p.sender.send(approved);
    }
    Ok(())
}

// ── Skill helpers (inline; avoid coupling to skills::State plumbing) ──

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn skill_roots_for(project: Option<&Project>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = dirs_home() {
        roots.push(home.join(".agents/skills"));
    }
    if let Some(p) = project {
        roots.push(PathBuf::from(&p.path).join(".agents/skills"));
    }
    roots
}

async fn list_skills(state: &State<'_, ProjectsStore>, args: &Value) -> Value {
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .map(|s| s.to_lowercase());
    let project = state.active_project().await;
    let roots = skill_roots_for(project.as_ref());
    let mut out: Vec<Value> = Vec::new();
    for root in &roots {
        let label = if root.ends_with(".agents/skills") && root.starts_with(dirs_home().unwrap_or_default()) {
            "user"
        } else {
            "project"
        };
        let Ok(mut rd) = tokio::fs::read_dir(root).await else {
            continue;
        };
        while let Ok(Some(entry)) = rd.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            let skill_md = entry.path().join("SKILL.md");
            if !skill_md.exists() {
                continue;
            }
            let contents = match tokio::fs::read_to_string(&skill_md).await {
                Ok(c) => c,
                Err(_) => continue,
            };
            let (display_name, description) = parse_skill_frontmatter(&contents);
            let hay = format!("{name} {display_name} {description} {label}").to_lowercase();
            if let Some(q) = &query {
                if !hay.contains(q) {
                    continue;
                }
            }
            out.push(json!({
                "selector": name,
                "name": display_name,
                "description": description,
                "source": label,
                "sourceLabel": label,
                "tags": Value::Null,
            }));
        }
    }
    json!({ "ok": true, "result": out })
}

async fn read_skill_tool(state: &State<'_, ProjectsStore>, args: &Value) -> Value {
    let skill = match args.get("skill").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return json!({ "ok": false, "error": "missing skill" }),
    };
    let project = state.active_project().await;
    let roots = skill_roots_for(project.as_ref());
    for root in &roots {
        let candidate = root.join(skill).join("SKILL.md");
        if let Ok(content) = tokio::fs::read_to_string(&candidate).await {
            return json!({ "ok": true, "result": content });
        }
    }
    json!({ "ok": false, "error": format!("skill not found: {skill}") })
}

fn parse_skill_frontmatter(contents: &str) -> (String, String) {
    let mut name = String::new();
    let mut description = String::new();
    let mut in_frontmatter = false;
    let mut frontmatter_done = false;
    for line in contents.lines() {
        if !in_frontmatter && line.trim_start().starts_with("---") {
            in_frontmatter = true;
            continue;
        }
        if in_frontmatter && line.trim_start().starts_with("---") {
            frontmatter_done = true;
            in_frontmatter = false;
            continue;
        }
        if in_frontmatter && !frontmatter_done {
            if let Some(rest) = line.strip_prefix("name:") {
                name = rest.trim().trim_matches('"').to_string();
            } else if let Some(rest) = line.strip_prefix("description:") {
                description = rest.trim().trim_matches('"').to_string();
            }
        } else if !frontmatter_done && name.is_empty() {
            // No frontmatter; first non-empty line is the name.
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                name = trimmed.trim_start_matches("#").trim().to_string();
            }
        }
    }
    if name.is_empty() {
        name = "(unnamed)".to_string();
    }
    (name, description)
}

// ── Sandbox ─────────────────────────────────────────────────────────────

fn resolve_in_project(project_root: &str, rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() {
        return Err("path is required".into());
    }
    let p = Path::new(rel);
    if p.is_absolute() {
        return Err("absolute paths are not allowed — pass a path relative to the project root".into());
    }
    let normalized = crate::workspace::safe_relative_path(rel)?;
    let root = std::fs::canonicalize(project_root)
        .map_err(|e| format!("failed to resolve project root: {e}"))?;
    crate::workspace::resolve_within_root(&root, &normalized)
}

async fn read_file(root: &str, rel: &str) -> Value {
    let abs = match resolve_in_project(root, rel) {
        Ok(p) => p,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    match tokio::fs::read_to_string(&abs).await {
        Ok(content) => json!({ "ok": true, "result": content }),
        Err(e) => match e.kind() {
            std::io::ErrorKind::NotFound => {
                json!({ "ok": false, "error": format!("File not found: {rel}") })
            }
            _ => json!({ "ok": false, "error": format!("Read failed: {e}") }),
        },
    }
}

async fn write_file(root: &str, rel: &str, content: &str) -> Value {
    let abs = match resolve_in_project(root, rel) {
        Ok(p) => p,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    if let Some(parent) = abs.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    match tokio::fs::write(&abs, content).await {
        Ok(_) => json!({
            "ok": true,
            "result": { "path": rel, "bytes": content.len() }
        }),
        Err(e) => json!({ "ok": false, "error": format!("Write failed: {e}") }),
    }
}

async fn edit_file(root: &str, rel: &str, old: &str, new: &str, replace_all: bool) -> Value {
    let abs = match resolve_in_project(root, rel) {
        Ok(p) => p,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    let content = match tokio::fs::read_to_string(&abs).await {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "error": format!("Read failed: {e}") }),
    };
    if !content.contains(old) {
        return json!({ "ok": false, "error": "oldText not found in file (no replacement made)" });
    }
    let (updated, replacements) = if replace_all {
        let n = content.matches(old).count();
        (content.replace(old, new), n)
    } else {
        let mut out = String::with_capacity(content.len());
        let mut rest = content.as_str();
        let mut n = 0;
        while let Some(idx) = rest.find(old) {
            out.push_str(&rest[..idx]);
            out.push_str(new);
            rest = &rest[idx + old.len()..];
            n += 1;
        }
        out.push_str(rest);
        (out, n)
    };
    if let Err(e) = tokio::fs::write(&abs, &updated).await {
        return json!({ "ok": false, "error": format!("Write failed: {e}") });
    }
    json!({ "ok": true, "result": { "path": rel, "replacements": replacements } })
}

async fn list_files(root: &str, rel: &str, recursive: bool) -> Value {
    let abs = match resolve_in_project(root, rel) {
        Ok(p) => p,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    let mut entries: Vec<Value> = Vec::new();
    let base_label = if rel == "." { "" } else { rel };
    let walk_res = if recursive {
        walk_dir(&abs, base_label, &mut entries).await
    } else {
        one_shot_dir(&abs, &mut entries).await
    };
    if let Err(e) = walk_res {
        return json!({ "ok": false, "error": format!("{e}") });
    }
    entries.sort_by(|a, b| {
        let ad = a.get("isDir").and_then(|v| v.as_bool()).unwrap_or(false);
        let bd = b.get("isDir").and_then(|v| v.as_bool()).unwrap_or(false);
        match (ad, bd) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .cmp(b.get("name").and_then(|v| v.as_str()).unwrap_or("")),
        }
    });
    json!({ "ok": true, "result": entries })
}

fn should_skip_entry(name: &str) -> bool {
    name == "node_modules" || name == ".git" || name.starts_with('.')
}

async fn one_shot_dir(abs: &Path, out: &mut Vec<Value>) -> std::io::Result<()> {
    let mut rd = tokio::fs::read_dir(abs).await?;
    while let Some(entry) = rd.next_entry().await? {
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip_entry(&name) {
            continue;
        }
        let ft = entry.file_type().await.ok();
        out.push(json!({
            "name": name,
            "path": entry.file_name().to_string_lossy(),
            "isDir": ft.map(|t| t.is_dir()).unwrap_or(false),
        }));
    }
    Ok(())
}

async fn walk_dir(abs: &Path, base: &str, out: &mut Vec<Value>) -> std::io::Result<()> {
    let mut stack = vec![(abs.to_path_buf(), base.to_string())];
    while let Some((dir, rel_base)) = stack.pop() {
        let mut rd = tokio::fs::read_dir(&dir).await?;
        while let Some(entry) = rd.next_entry().await? {
            let name = entry.file_name().to_string_lossy().to_string();
            if should_skip_entry(&name) {
                continue;
            }
            let full = entry.path();
            let child_rel = if rel_base.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", rel_base, name)
            };
            let ft = entry.file_type().await.ok();
            let is_dir = ft.map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                out.push(json!({ "name": name, "path": child_rel, "isDir": true }));
                stack.push((full, child_rel));
            } else {
                let size = entry.metadata().await.ok().map(|m| m.len());
                out.push(json!({
                    "name": name,
                    "path": child_rel,
                    "isDir": false,
                    "size": size,
                }));
            }
        }
    }
    Ok(())
}

async fn search_files(root: &str, query: &str, rel: &str, include: Option<&str>) -> Value {
    if query.is_empty() {
        return json!({ "ok": false, "error": "query is required" });
    }
    let abs = match resolve_in_project(root, rel) {
        Ok(p) => p,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    let include_re = match include {
        Some(p) => match glob_to_regex(p) {
            Ok(re) => Some(re),
            Err(e) => return json!({ "ok": false, "error": e }),
        },
        None => None,
    };
    let mut hits = Vec::new();
    if walk_search(&abs, rel, query, include_re.as_ref(), &mut hits, 200)
        .await
        .is_err()
    {
        return json!({ "ok": false, "error": "search failed" });
    }
    json!({ "ok": true, "result": hits })
}

async fn walk_search(
    abs: &Path,
    base: &str,
    query: &str,
    include_re: Option<&regex_lite::Regex>,
    hits: &mut Vec<Value>,
    cap: usize,
) -> std::io::Result<()> {
    let mut stack = vec![(abs.to_path_buf(), base.to_string())];
    while let Some((dir, rel_base)) = stack.pop() {
        if hits.len() >= cap {
            break;
        }
        let mut rd = match tokio::fs::read_dir(&dir).await {
            Ok(r) => r,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = rd.next_entry().await {
            if hits.len() >= cap {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if should_skip_entry(&name) {
                continue;
            }
            let full = entry.path();
            let child_rel = if rel_base.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", rel_base, name)
            };
            let ft = entry.file_type().await.ok();
            let is_dir = ft.map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                stack.push((full, child_rel));
                continue;
            }
            if let Some(re) = include_re {
                if !re.is_match(&name) {
                    continue;
                }
            }
            if name.ends_with(".png")
                || name.ends_with(".jpg")
                || name.ends_with(".gif")
                || name.ends_with(".pdf")
                || name.ends_with(".zip")
            {
                continue;
            }
            let mut f = match tokio::fs::File::open(&full).await {
                Ok(f) => f,
                Err(_) => continue,
            };
            let mut buf = String::new();
            if f.read_to_string(&mut buf).await.is_err() {
                continue;
            }
            for (i, line) in buf.lines().enumerate() {
                if hits.len() >= cap {
                    break;
                }
                if let Some(idx) = line.find(query) {
                    let start = idx.saturating_sub(30);
                    let end = (idx + query.len() + 30).min(line.len());
                    let snippet = format!(
                        "{}{}{}",
                        if start > 0 { "…" } else { "" },
                        &line[start..end],
                        if end < line.len() { "…" } else { "" }
                    );
                    hits.push(json!({ "path": child_rel, "line": i + 1, "snippet": snippet }));
                }
            }
        }
    }
    Ok(())
}

// Tiny glob matcher — `*` and `?` only. Replaces a real regex crate for
// the agent tool's `includePattern` which is always `*.ts`/`*.tsx`-ish.
mod regex_lite {
    pub struct Regex {
        glob: String,
    }

    impl Regex {
        pub fn new(pattern: &str) -> Result<Self, String> {
            Ok(Self {
                glob: pattern.to_string(),
            })
        }
        pub fn is_match(&self, name: &str) -> bool {
            glob_match(name, &self.glob)
        }
    }

    fn glob_match(name: &str, pattern: &str) -> bool {
        let pat: Vec<char> = pattern.chars().collect();
        let nam: Vec<char> = name.chars().collect();
        let mut pi = 0usize;
        let mut ni = 0usize;
        let mut star_pi: Option<usize> = None;
        let mut star_ni: usize = 0;
        while ni < nam.len() {
            if pi < pat.len() && pat[pi] == '?' {
                pi += 1;
                ni += 1;
            } else if pi < pat.len() && pat[pi] == '*' {
                star_pi = Some(pi);
                star_ni = ni;
                pi += 1;
            } else if pi < pat.len() && pat[pi] == nam[ni] {
                pi += 1;
                ni += 1;
            } else if let Some(sp) = star_pi {
                pi = sp + 1;
                star_ni += 1;
                ni = star_ni;
            } else {
                return false;
            }
        }
        while pi < pat.len() && pat[pi] == '*' {
            pi += 1;
        }
        pi == pat.len()
    }
}

fn glob_to_regex(pattern: &str) -> Result<regex_lite::Regex, String> {
    regex_lite::Regex::new(pattern).map_err(|e| format!("invalid pattern: {e}"))
}

// ── Bash with approval ──────────────────────────────────────────────────

async fn run_bash(
    project_root: &str,
    cwd_rel: Option<String>,
    command: String,
    timeout_ms: Option<u64>,
    app: &AppHandle,
    pending_bash: Arc<Mutex<std::collections::HashMap<String, PendingBash>>>,
) -> Value {
    if command.is_empty() || command.len() > 8_000 {
        return json!({ "ok": false, "error": "command is required (max 8000 chars)" });
    }
    let workdir = match cwd_rel {
        Some(rel) => match resolve_in_project(project_root, &rel) {
            Ok(p) => p,
            Err(e) => return json!({ "ok": false, "error": e }),
        },
        None => PathBuf::from(project_root),
    };

    let approval_id = Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel::<bool>();
    {
        let mut g = pending_bash.lock().await;
        g.insert(
            approval_id.clone(),
            PendingBash { sender: tx },
        );
    }

    let _ = app.emit(
        "tool:bash-approval-request",
        json!({
            "approvalId": approval_id,
            "command": command,
            "workdir": workdir.to_string_lossy(),
            "timeoutMs": timeout_ms.unwrap_or(60_000),
        }),
    );

    let approved = match tokio::time::timeout(BASH_APPROVAL_TIMEOUT, rx).await {
        Ok(Ok(v)) => v,
        Ok(Err(_)) => false,
        Err(_) => {
            let mut g = pending_bash.lock().await;
            g.remove(&approval_id);
            return json!({ "ok": false, "error": "bash approval timed out" });
        }
    };
    if !approved {
        return json!({ "ok": false, "error": "User denied the command. Ask before retrying." });
    }

    let effective_timeout = timeout_ms.unwrap_or(60_000).clamp(1_000, 5 * 60_000);

    let mut cmd = tokio::process::Command::new("cmd");
    cmd.arg("/C")
        .arg(&command)
        .current_dir(&workdir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "error": format!("Failed to start command: {e}") }),
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_task = tokio::spawn(async move {
        let mut s = match stdout { Some(s) => s, None => return Vec::new() };
        let mut buf = Vec::new();
        let _ = tokio::io::copy(&mut s, &mut buf).await;
        buf
    });
    let stderr_task = tokio::spawn(async move {
        let mut s = match stderr { Some(s) => s, None => return Vec::new() };
        let mut buf = Vec::new();
        let _ = tokio::io::copy(&mut s, &mut buf).await;
        buf
    });

    let wait_result = tokio::time::timeout(Duration::from_millis(effective_timeout), child.wait()).await;
    let timed_out = wait_result.is_err();
    let exit_status = if timed_out {
        let _ = child.start_kill();
        let _ = child.wait().await;
        None
    } else {
        wait_result.ok().and_then(|r| r.ok())
    };
    let stdout_bytes = stdout_task.await.unwrap_or_default();
    let stderr_bytes = stderr_task.await.unwrap_or_default();

    if timed_out {
        return json!({
            "ok": false,
            "error": format!("Command exceeded timeout ({effective_timeout}ms) and was killed.")
        });
    }

    let stdout = truncate(&stdout_bytes, BASH_OUTPUT_BYTE_LIMIT);
    let stderr = truncate(&stderr_bytes, BASH_OUTPUT_BYTE_LIMIT);
    let exit_code = exit_status.and_then(|s| s.code()).unwrap_or(-1);
    if exit_code == 0 {
        json!({
            "ok": true,
            "result": { "stdout": stdout, "stderr": stderr, "exitCode": exit_code }
        })
    } else {
        json!({
            "ok": false,
            "error": format!("Command exited with code {exit_code}. stderr:\n{}\n\nstdout:\n{}", stderr, stdout)
        })
    }
}

fn truncate(bytes: &[u8], limit: usize) -> String {
    let s = String::from_utf8_lossy(bytes);
    if s.len() <= limit {
        return s.into_owned();
    }
    let mut out = s.into_owned();
    out.truncate(limit);
    out.push_str("\n\n[output truncated]");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_in_project_rejects_absolute_and_traversal() {
        // Prefer CARGO_MANIFEST_DIR (set by `cargo test`); fall back to
        // current_dir() otherwise. Either way the path must exist for
        // canonicalize() to return a usable root.
        let root = std::env::var("CARGO_MANIFEST_DIR")
            .ok()
            .map(std::path::PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .unwrap();
        let root_str = root.to_string_lossy().to_string();
        assert!(resolve_in_project(&root_str, "/etc/passwd").is_err());
        assert!(resolve_in_project(&root_str, "../../../etc/passwd").is_err());
        assert!(resolve_in_project(&root_str, "a/../../b").is_err());
        assert!(resolve_in_project(&root_str, "ok/path.txt").is_ok());
    }

    #[test]
    fn glob_to_regex_matches_basic_patterns() {
        let re = glob_to_regex("*.ts").unwrap();
        assert!(re.is_match("foo.ts"));
        assert!(!re.is_match("foo.tsx"));
        let re = glob_to_regex("foo?bar").unwrap();
        assert!(re.is_match("foo-bar"));
        assert!(!re.is_match("foo--bar"));
    }

    #[test]
    fn parse_skill_frontmatter_extracts_name_and_description() {
        let md = "---\nname: My Skill\ndescription: does the thing\n---\nbody";
        let (n, d) = parse_skill_frontmatter(md);
        assert_eq!(n, "My Skill");
        assert_eq!(d, "does the thing");
    }
}