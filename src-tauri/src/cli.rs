//! CLI credential detection.
//!
//! Mirrors `electron/main/cli-detect.ts`. Reads credential files written
//! by the official AI CLIs (Codex / Claude Code / Gemini CLI / Antigravity /
//! OpenCode). Each detector is a small file probe + JSON parse; keyring
//! fallback is intentionally out of scope here (no native deps on the
//! Rust side).
//!
//! ponytail: no storage, no lock. Each call walks the FS synchronously.
//! The renderer is responsible for throttling.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CLIDetection {
    pub provider_id: String,
    pub source: String,
    #[serde(default)]
    pub account_label: Option<String>,
    #[serde(default)]
    pub access_token: Option<String>,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_at: Option<u64>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
}

fn read_json(path: &std::path::Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn parse_expires_at(v: Option<&serde_json::Value>) -> Option<u64> {
    match v {
        Some(serde_json::Value::Number(n)) => n.as_u64(),
        Some(serde_json::Value::String(s)) => {
            let ms = chrono_like_parse(s);
            if ms > 0 {
                Some(ms as u64)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Cheap ISO-8601 / RFC-3339-ish parser without pulling chrono. Accepts
/// `2025-01-02T03:04:05Z` / `2025-01-02T03:04:05+00:00` style strings.
/// Returns 0 on failure — callers should treat 0 as "unparseable" and
/// drop the value.
fn chrono_like_parse(s: &str) -> i64 {
    // DateTime::parse_from_rfc3339 would be cleaner but requires chrono.
    // Hand-rolling the common shapes keeps the dependency surface flat.
    let bytes = s.as_bytes();
    if bytes.len() < 20 {
        return 0;
    }
    let year = match std::str::from_utf8(&bytes[0..4]).ok().and_then(|s| s.parse::<i32>().ok()) {
        Some(y) => y,
        None => return 0,
    };
    let month = match std::str::from_utf8(&bytes[5..7]).ok().and_then(|s| s.parse::<u32>().ok()) {
        Some(m) => m,
        None => return 0,
    };
    let day = match std::str::from_utf8(&bytes[8..10]).ok().and_then(|s| s.parse::<u32>().ok()) {
        Some(d) => d,
        None => return 0,
    };
    let hour = bytes.get(11..13).and_then(|b| std::str::from_utf8(b).ok()).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    let min = bytes.get(14..16).and_then(|b| std::str::from_utf8(b).ok()).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    let sec = bytes.get(17..19).and_then(|b| std::str::from_utf8(b).ok()).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);

    // Days since 1970-01-01 (Gregorian) using the Howard Hinnant date algorithm.
    let (y, m) = if month <= 2 { (year - 1, month + 9) } else { (year, month - 3) };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64; // [0, 399]
    let doy = (153 * (m as i64 - 3) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy as u64;
    let days = (era as i64) * 146097 + doe as i64 - 719468;
    let secs = days * 86_400 + (hour as i64) * 3600 + (min as i64) * 60 + sec as i64;
    secs * 1000
}

// ── Detectors ────────────────────────────────────────────────────────

fn detect_codex(home: &std::path::Path) -> Option<CLIDetection> {
    let path = home.join(".codex").join("auth.json");
    let v = read_json(&path)?;
    if let Some(key) = v.get("OPENAI_API_KEY").and_then(|x| x.as_str()) {
        return Some(CLIDetection {
            provider_id: "openai".into(),
            source: "codex-auth.json".into(),
            account_label: Some("Codex (API key)".into()),
            access_token: Some(key.into()),
            refresh_token: None,
            expires_at: None,
            project_id: None,
            account_id: None,
        });
    }
    let tokens = v.get("tokens")?;
    let access = tokens.get("access_token").and_then(|x| x.as_str())?;
    Some(CLIDetection {
        provider_id: "openai".into(),
        source: "codex-auth.json".into(),
        account_label: None,
        access_token: Some(access.into()),
        refresh_token: tokens.get("refresh_token").and_then(|x| x.as_str()).map(String::from),
        expires_at: parse_expires_at(tokens.get("expires_at")),
        project_id: None,
        account_id: tokens.get("account_id").and_then(|x| x.as_str()).map(String::from),
    })
}

fn detect_claude_code(home: &std::path::Path) -> Option<CLIDetection> {
    let path = home.join(".claude").join(".credentials.json");
    let v = read_json(&path)?;
    let oauth = v.get("claudeAiOauth").unwrap_or(&v);
    let access = oauth.get("accessToken").and_then(|x| x.as_str())?;
    Some(CLIDetection {
        provider_id: "anthropic".into(),
        source: "claude-credentials".into(),
        account_label: None,
        access_token: Some(access.into()),
        refresh_token: oauth.get("refreshToken").and_then(|x| x.as_str()).map(String::from),
        expires_at: parse_expires_at(oauth.get("expiresAt")),
        project_id: None,
        account_id: None,
    })
}

fn detect_gemini_cli(home: &std::path::Path) -> Option<CLIDetection> {
    let path = home.join(".gemini").join("oauth_creds.json");
    let v = read_json(&path)?;
    let access = v.get("access_token").and_then(|x| x.as_str())?;
    Some(CLIDetection {
        provider_id: "gemini-cli".into(),
        source: "gemini-oauth-creds".into(),
        account_label: None,
        access_token: Some(access.into()),
        refresh_token: v.get("refresh_token").and_then(|x| x.as_str()).map(String::from),
        expires_at: parse_expires_at(v.get("expiry_date").or_else(|| v.get("expires_at"))),
        project_id: v.get("project_id").and_then(|x| x.as_str()).map(String::from),
        account_id: None,
    })
}

fn detect_opencode(home: &std::path::Path) -> Vec<CLIDetection> {
    let path = home.join(".local").join("share").join("opencode").join("auth.json");
    let Some(v) = read_json(&path) else {
        return vec![];
    };
    let mut out = Vec::new();
    if let Some(key) = v.get("opencode-go").and_then(|x| x.get("key")).and_then(|x| x.as_str()) {
        out.push(CLIDetection {
            provider_id: "opencode-go".into(),
            source: "opencode-auth".into(),
            account_label: Some("OpenCode Go".into()),
            access_token: Some(key.into()),
            refresh_token: None,
            expires_at: None,
            project_id: None,
            account_id: None,
        });
    }
    if let Some(key) = v.get("opencode-zen").and_then(|x| x.get("key")).and_then(|x| x.as_str()) {
        out.push(CLIDetection {
            provider_id: "opencode-zen".into(),
            source: "opencode-auth".into(),
            account_label: Some("OpenCode Zen".into()),
            access_token: Some(key.into()),
            refresh_token: None,
            expires_at: None,
            project_id: None,
            account_id: None,
        });
    }
    if let Some(key) = v.get("minimax-coding-plan").and_then(|x| x.get("key")).and_then(|x| x.as_str()) {
        out.push(CLIDetection {
            provider_id: "minimax".into(),
            source: "opencode-auth".into(),
            account_label: Some("MiniMax (OpenCode)".into()),
            access_token: Some(key.into()),
            refresh_token: None,
            expires_at: None,
            project_id: None,
            account_id: None,
        });
    }
    out
}

// ── Commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn cli_detect(provider_id: String) -> Result<Option<CLIDetection>, String> {
    let Some(home) = home_dir() else {
        return Ok(None);
    };
    let detection = match provider_id.as_str() {
        "openai" => detect_codex(&home),
        "anthropic" => detect_claude_code(&home),
        "gemini-cli" => detect_gemini_cli(&home),
        "opencode-go" | "opencode-zen" | "minimax" => detect_opencode(&home)
            .into_iter()
            .find(|d| d.provider_id == provider_id),
        // Antigravity: keyring only — return None on Rust side.
        _ => None,
    };
    Ok(detection)
}

#[tauri::command]
pub async fn cli_detect_all() -> Result<Vec<CLIDetection>, String> {
    let Some(home) = home_dir() else {
        return Ok(vec![]);
    };
    let mut out = Vec::new();
    out.extend(detect_codex(&home));
    out.extend(detect_claude_code(&home));
    out.extend(detect_gemini_cli(&home));
    out.extend(detect_opencode(&home));
    Ok(out)
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir() -> std::path::PathBuf {
        let base = std::env::temp_dir();
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        base.join(format!("brightcode-cli-test-{pid}-{nanos}"))
    }

    #[test]
    fn parse_expires_at_accepts_number() {
        let v = serde_json::json!(1234567890u64);
        assert_eq!(parse_expires_at(Some(&v)), Some(1234567890));
    }

    #[test]
    fn parse_expires_at_accepts_iso_string() {
        let v = serde_json::json!("2025-01-01T00:00:00Z");
        let out = parse_expires_at(Some(&v));
        assert!(out.is_some());
        assert!(out.unwrap() > 0);
    }

    #[test]
    fn parse_expires_at_rejects_garbage() {
        let v = serde_json::json!("not-a-date");
        assert_eq!(parse_expires_at(Some(&v)), None);
    }

    #[test]
    fn detect_codex_reads_oauth_tokens() {
        let dir = tmpdir();
        std::fs::create_dir_all(dir.join(".codex")).unwrap();
        std::fs::write(
            dir.join(".codex/auth.json"),
            r#"{"tokens":{"access_token":"abc","refresh_token":"rt","expires_at":1234,"account_id":"acc"}}"#,
        )
        .unwrap();
        let det = detect_codex(&dir).expect("should detect");
        assert_eq!(det.provider_id, "openai");
        assert_eq!(det.access_token.as_deref(), Some("abc"));
        assert_eq!(det.refresh_token.as_deref(), Some("rt"));
        assert_eq!(det.account_id.as_deref(), Some("acc"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn detect_opencode_returns_all_three_keys() {
        let dir = tmpdir();
        std::fs::create_dir_all(dir.join(".local/share/opencode")).unwrap();
        std::fs::write(
            dir.join(".local/share/opencode/auth.json"),
            r#"{"opencode-go":{"key":"k-go"},"opencode-zen":{"key":"k-zen"},"minimax-coding-plan":{"key":"k-min"}}"#,
        )
        .unwrap();
        let dets = detect_opencode(&dir);
        assert_eq!(dets.len(), 3);
        assert!(dets.iter().any(|d| d.provider_id == "opencode-go"));
        assert!(dets.iter().any(|d| d.provider_id == "opencode-zen"));
        assert!(dets.iter().any(|d| d.provider_id == "minimax"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unknown_provider_returns_none() {
        let r = tauri::async_runtime::block_on(cli_detect("nope-not-real".into())).unwrap();
        assert!(r.is_none());
    }
}