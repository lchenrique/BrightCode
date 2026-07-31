//! Skills discovery + read/write IPC commands.
//!
//! Mirrors `electron/main/skills.ts` (a subset). Two roots:
//! - User: `<home>/.agents/skills/`
//! - Project: `<project.path>/.agents/skills/`
//!
//! Each subdirectory under either root is one skill. `id` = directory
//! name, `path` = full path to its `SKILL.md`.
//!
//! ponytail: flat list under each root, no deep walk + multi-source
//! juggling like Electron does. Phase 3 needs only the two `.agents`
//! roots the renderer actually asks for.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::projects::ProjectsStore;

const SKILL_SUBDIR: &str = ".agents/skills";
const SKILL_FILE: &str = "SKILL.md";
const MAX_BYTES: usize = 512 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRecord {
    pub id: String,
    pub name: String,
    pub description: String,
    pub path: String,
    /// "project" | "user"
    pub source: String,
    pub exists: bool,
}

/// Renderer-shape return for `skills.list` so legacy callers (SkillsView,
/// ChatSurface system prompt) can keep using `skillFilePath` /
/// `folderPath` / `sourceLabel`. Built on top of `SkillRecord`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub source: String,
    pub source_label: String,
    pub folder_path: String,
    pub skill_file_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillReadResult {
    pub contents: String,
    pub path: String,
}

pub(crate) fn source_label_for(source: &str) -> &'static str {
    match source {
        "user" => "User Library",
        "project" => "Project Local",
        _ => "Skills Library",
    }
}

fn to_discovered(record: SkillRecord) -> DiscoveredSkill {
    let folder_path = PathBuf::from(&record.path)
        .parent()
        .map(|p| path_to_string(p))
        .unwrap_or_default();
    let name = if record.source == "user" {
        record.id.clone()
    } else {
        record.name.clone()
    };
    DiscoveredSkill {
        id: record.id,
        name,
        description: record.description,
        source: record.source.clone(),
        source_label: source_label_for(&record.source).to_string(),
        folder_path,
        skill_file_path: record.path,
    }
}

#[tauri::command]
pub async fn skills_list(
    state: State<'_, ProjectsStore>,
    project_id: Option<String>,
) -> Result<Vec<DiscoveredSkill>, String> {
    let mut records: Vec<SkillRecord> = Vec::new();

    if let Some(root) = user_skill_root() {
        collect_from_root(&root, "user", &mut records);
    }

    if let Some(pid) = project_id {
        let project = state
            .find_by_id(&pid)
            .await
            .ok_or_else(|| format!("project not found: {pid}"))?;
        let root = project_root(&project.path);
        collect_from_root(&root, "project", &mut records);
    }

    Ok(records.into_iter().map(to_discovered).collect())
}

#[tauri::command]
pub async fn skills_read(
    state: State<'_, ProjectsStore>,
    skill_id: String,
    project_id: Option<String>,
) -> Result<SkillReadResult, String> {
    let (root, _src) = resolve_root(&state, project_id).await?;
    let skill_dir = skill_id_safe(&skill_id)?;
    let skill_md = root.join(&skill_dir).join(SKILL_FILE);
    let path_str = path_to_string(&skill_md);
    ensure_within_skill_root(&root, &skill_md)?;
    let bytes = tokio::fs::read(&skill_md)
        .await
        .map_err(|e| format!("failed to read {path_str}: {e}"))?;
    if bytes.len() > MAX_BYTES {
        return Err(format!(
            "skill file exceeds {MAX_BYTES} bytes ({} bytes)",
            bytes.len()
        ));
    }
    let contents = String::from_utf8(bytes)
        .map_err(|e| format!("skill file is not valid UTF-8: {e}"))?;
    Ok(SkillReadResult {
        contents,
        path: path_str,
    })
}

#[tauri::command]
pub async fn skills_write(
    state: State<'_, ProjectsStore>,
    skill_id: String,
    contents: String,
    project_id: Option<String>,
) -> Result<(), String> {
    if contents.len() > MAX_BYTES {
        return Err(format!(
            "skill contents exceed {MAX_BYTES} bytes ({} bytes)",
            contents.len()
        ));
    }
    let (root, _src) = resolve_root(&state, project_id).await?;
    let skill_dir = skill_id_safe(&skill_id)?;
    let skill_md = root.join(&skill_dir).join(SKILL_FILE);
    ensure_within_skill_root(&root, &skill_md)?;
    if let Some(parent) = skill_md.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("failed to create {parent:?}: {e}"))?;
    }
    tokio::fs::write(&skill_md, contents.as_bytes())
        .await
        .map_err(|e| format!("failed to write {skill_md:?}: {e}"))?;
    Ok(())
}

// --- internal helpers (pub(crate) so tests can reach them) ---

fn user_skill_root() -> Option<PathBuf> {
    let home = home_dir()?;
    Some(home.join(SKILL_SUBDIR))
}

fn project_root(project_path: &str) -> PathBuf {
    PathBuf::from(project_path).join(SKILL_SUBDIR)
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    // ponytail: avoid pulling in the `dirs` crate; env vars are enough
    // for home and that's all `dirs::home_dir()` consults on Win/macOS/Linux.
    if let Ok(home) = std::env::var("USERPROFILE") {
        if !home.is_empty() {
            return Some(PathBuf::from(home));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return Some(PathBuf::from(home));
        }
    }
    None
}

async fn resolve_root(
    state: &State<'_, ProjectsStore>,
    project_id: Option<String>,
) -> Result<(PathBuf, &'static str), String> {
    if let Some(pid) = project_id {
        let project = state
            .find_by_id(&pid)
            .await
            .ok_or_else(|| format!("project not found: {pid}"))?;
        Ok((project_root(&project.path), "project"))
    } else {
        let root = user_skill_root()
            .ok_or_else(|| "could not resolve user home directory".to_string())?;
        Ok((root, "user"))
    }
}

fn collect_from_root(root: &Path, source: &str, out: &mut Vec<SkillRecord>) {
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let id = match entry.file_name().into_string() {
            Ok(s) => s,
            Err(_) => continue,
        };
        let skill_md = path.join(SKILL_FILE);
        let exists = skill_md.is_file();
        let (name, description) = if exists {
            match std::fs::read_to_string(&skill_md) {
                Ok(raw) => {
                    let (fm, body) = parse_skill_frontmatter(&raw);
                    let fallback = id.clone();
                    let name = fm
                        .get("name")
                        .cloned()
                        .unwrap_or(fallback);
                    let description = fm.get("description").cloned().unwrap_or_else(|| {
                        body.lines()
                            .find(|l| !l.trim().is_empty() && !l.trim().starts_with('#'))
                            .map(|l| l.trim().to_string())
                            .unwrap_or_else(|| "No description available".to_string())
                    });
                    (name, description)
                }
                Err(_) => (id.clone(), "No description available".to_string()),
            }
        } else {
            (id.clone(), "No description available".to_string())
        };
        out.push(SkillRecord {
            id,
            name,
            description,
            path: path_to_string(&skill_md),
            source: source.to_string(),
            exists,
        });
    }
}

fn path_to_string(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

/// Rejects anything that isn't a single safe relative segment.
/// Blocks `..`, `/`, `\`, NUL, and absolute paths.
pub(crate) fn skill_id_safe(id: &str) -> Result<String, String> {
    if id.is_empty() {
        return Err("skill id is required".to_string());
    }
    let path = Path::new(id);
    let mut components = path.components();
    let first = components
        .next()
        .ok_or_else(|| "skill id is required".to_string())?;
    let Component::Normal(_) = first else {
        return Err(format!("invalid skill id: {id:?}"));
    };
    if components.next().is_some() {
        return Err(format!("invalid skill id (path traversal?): {id:?}"));
    }
    if id.contains('\0') {
        return Err(format!("invalid skill id (NUL byte): {id:?}"));
    }
    Ok(id.to_string())
}

/// Returns (`name`, `description`) parsed from the first `---` block.
/// Falls back to empty strings if no frontmatter.
pub(crate) fn parse_skill_frontmatter(raw: &str) -> (std::collections::HashMap<String, String>, String) {
    let mut fm: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let stripped = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let Some(rest) = stripped.strip_prefix("---\n").or_else(|| stripped.strip_prefix("---\r\n")) else {
        return (fm, stripped.to_string());
    };
    let Some(end_idx) = find_frontmatter_close(rest) else {
        return (fm, stripped.to_string());
    };
    let block = &rest[..end_idx];
    let body = rest[end_idx..].trim_start_matches(|c| c == '\n' || c == '\r').to_string();
    for line in block.lines() {
        let Some(colon) = line.find(':') else { continue };
        let key = line[..colon].trim();
        if key.is_empty() {
            continue;
        }
        let mut val = line[colon + 1..].trim().to_string();
        if val.len() >= 2
            && ((val.starts_with('"') && val.ends_with('"'))
                || (val.starts_with('\'') && val.ends_with('\'')))
        {
            val = val[1..val.len() - 1].to_string();
        }
        fm.insert(key.to_string(), val);
    }
    (fm, body)
}

fn find_frontmatter_close(s: &str) -> Option<usize> {
    let mut idx = 0;
    for line in s.split_inclusive('\n') {
        if line.trim_end_matches(['\n', '\r']) == "---" {
            return Some(idx + line.len());
        }
        idx += line.len();
    }
    None
}

/// Confirms `candidate` resolves to a path under `root` (lexical — we
/// rely on `skill_id_safe` upstream to forbid traversal).
pub(crate) fn is_within_skill_root(root: &Path, candidate: &Path) -> bool {
    let root_norm = normalize_path(root);
    let cand_norm = normalize_path(candidate);
    if cand_norm == root_norm {
        return true;
    }
    cand_norm.starts_with(&root_norm)
}

fn normalize_path(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn ensure_within_skill_root(root: &Path, candidate: &Path) -> Result<(), String> {
    if is_within_skill_root(root, candidate) {
        Ok(())
    } else {
        Err(format!(
            "path escapes skill root: {} -> {}",
            candidate.display(),
            root.display()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_id_safe_rejects_path_traversal() {
        assert!(skill_id_safe("../etc").is_err());
        assert!(skill_id_safe("foo/bar").is_err());
        assert!(skill_id_safe("..").is_err());
        assert!(skill_id_safe("/absolute").is_err());
        assert!(skill_id_safe("").is_err());
    }

    #[test]
    fn skill_id_safe_accepts_simple_names() {
        assert_eq!(skill_id_safe("bright-code").unwrap(), "bright-code");
        assert_eq!(skill_id_safe("my_skill").unwrap(), "my_skill");
        assert_eq!(skill_id_safe("skill.v2").unwrap(), "skill.v2");
    }

    #[test]
    fn parse_skill_frontmatter_extracts_name_and_description() {
        let raw = "---\nname: Bright Code\ndescription: A coding helper.\n---\n# Body\nMore body.\n";
        let (fm, body) = parse_skill_frontmatter(raw);
        assert_eq!(fm.get("name").map(String::as_str), Some("Bright Code"));
        assert_eq!(
            fm.get("description").map(String::as_str),
            Some("A coding helper.")
        );
        assert!(body.starts_with("# Body"));
    }

    #[test]
    fn parse_skill_frontmatter_returns_body_when_missing() {
        let raw = "# Just body\nNo frontmatter here.\n";
        let (fm, body) = parse_skill_frontmatter(raw);
        assert!(fm.is_empty());
        assert_eq!(body, raw);
    }

    #[test]
    fn is_within_skill_root_accepts_inside() {
        let root = Path::new("/home/u/.agents/skills");
        let inside = Path::new("/home/u/.agents/skills/bright-code/SKILL.md");
        assert!(is_within_skill_root(root, inside));
    }

    #[test]
    fn is_within_skill_root_rejects_outside() {
        let root = Path::new("/home/u/.agents/skills");
        let outside = Path::new("/home/u/.agents/skills-evil/SKILL.md");
        let escape = Path::new("/home/u/.agents/skills/../escape/SKILL.md");
        assert!(!is_within_skill_root(root, outside));
        assert!(!is_within_skill_root(root, escape));
    }
}