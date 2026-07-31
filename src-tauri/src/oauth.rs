//! PKCE OAuth 2.0 Authorization Code flow.
//!
//! Mirrors `electron/main/oauth.ts::runOAuthFlow`:
//!   1. Generate PKCE verifier + S256 challenge + random state.
//!   2. Start a transient 127.0.0.1 HTTP listener for the provider
//!      redirect. Accept exactly one connection; return a tiny HTML
//!      page and shut down.
//!   3. Open the system browser with the authorize URL.
//!   4. POST to the provider's token endpoint with the verifier.
//!   5. Return `{ accessToken, refreshToken?, expiresAt?, email?, ... }`.
//!
//! `oauth_cancel` aborts the in-flight flow by closing the listener and
//! resolving the pending future with an error.
//!
//! ponytail: no `tauri_plugin_shell::open` here — `ShellExt::open` is
//! not in scope of `tauri-plugin-shell`'s stable surface in 2.x, so we
//! shell out via `std::process::Command`. On Windows we use
//! `rundll32 url.dll,FileProtocolHandler` instead of `cmd /C start` to
//! avoid the cmd shell parsing `&` / `|` / `>` characters in the URL.
//! ponytail: we accept at most one TCP connection. The browser may make
//! multiple requests (favicon, etc.) — we drain them with a 404 so the
//! first `/callback` wins.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthConfig {
    pub provider_id: String,
    pub client_id: String,
    pub authorize_url: String,
    pub token_url: String,
    pub scopes: Vec<String>,
    pub code_challenge_method: Option<String>,
    pub content_type: Option<String>,
    pub extra_auth_params: Option<HashMap<String, String>>,
    pub fixed_port: Option<u16>,
    pub callback_path: Option<String>,
    pub callback_host: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl OAuthResult {
    fn ok(token: TokenResponse) -> Self {
        let expires_at = token
            .expires_in
            .and_then(|s| u64::try_from(s).ok())
            .and_then(|s| chrono_now_ms().checked_add(s * 1000));
        let account_id = extract_openai_account_id(token.id_token.as_deref())
            .or_else(|| extract_openai_account_id(token.access_token.as_deref()));
        OAuthResult {
            ok: true,
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            expires_at,
            email: token.email,
            account_id,
            id_token: token.id_token,
            error: None,
        }
    }

    fn err(msg: impl Into<String>) -> Self {
        OAuthResult {
            ok: false,
            access_token: None,
            refresh_token: None,
            expires_at: None,
            email: None,
            account_id: None,
            id_token: None,
            error: Some(msg.into()),
        }
    }
}

#[derive(Debug, Default)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    email: Option<String>,
    id_token: Option<String>,
}

#[derive(Default)]
pub struct OAuthState {
    inner: Mutex<Option<PendingFlow>>,
}

struct PendingFlow {
    cancel_tx: oneshot::Sender<()>,
}

impl OAuthState {
    pub fn new() -> Self {
        Self::default()
    }
}

// ── PKCE helpers ────────────────────────────────────────────────────────

pub(crate) fn generate_pkce() -> (String, String, String) {
    let mut verifier = [0u8; 32];
    let mut state_bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut verifier);
    rand::thread_rng().fill_bytes(&mut state_bytes);
    let code_verifier = URL_SAFE_NO_PAD.encode(verifier);
    let code_challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));
    let state = URL_SAFE_NO_PAD.encode(state_bytes);
    (code_verifier, code_challenge, state)
}

fn chrono_now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn extract_openai_account_id(token: Option<&str>) -> Option<String> {
    let token = token?;
    let payload_b64 = token.split('.').nth(1)?;
    let padded = payload_b64.replace('-', "+").replace('_', "/");
    let pad = (4 - padded.len() % 4) % 4;
    let padded = format!("{padded}{}", "=".repeat(pad));
    let bytes = URL_SAFE_NO_PAD
        .decode(padded.as_bytes())
        .ok()
        .or_else(|| base64::engine::general_purpose::STANDARD.decode(padded.as_bytes()).ok())?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let auth = v.get("https://api.openai.com/auth")?;
    auth.get("chatgpt_account_id")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

// ── Browser opener ──────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn open_browser(url: &str) -> std::io::Result<()> {
    // `cmd /C start "" {url}` would let cmd.exe interpret `&` / `|` /
    // `>` in the URL. rundll32+url.dll is a no-shell protocol handler.
    std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_browser(url: &str) -> std::io::Result<()> {
    std::process::Command::new("open").arg(url).spawn()?;
    Ok(())
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn open_browser(url: &str) -> std::io::Result<()> {
    std::process::Command::new("xdg-open").arg(url).spawn()?;
    Ok(())
}

// ── Local callback listener ─────────────────────────────────────────────

const CALLBACK_TIMEOUT: Duration = Duration::from_secs(5 * 60);

async fn accept_one_with_path(
    listener: TcpListener,
    path: String,
) -> Result<HashMap<String, String>, String> {
    accept_one(listener, Arc::new(path)).await
}

async fn accept_one(
    listener: TcpListener,
    path: Arc<String>,
) -> Result<HashMap<String, String>, String> {
    let accept = tokio::time::timeout(CALLBACK_TIMEOUT, async {
        loop {
            let (mut sock, _addr) = listener
                .accept()
                .await
                .map_err(|e| format!("accept: {e}"))?;
            let params = handle_one(&mut sock, &path).await;
            // Drain any keep-alive retry: do one quick accept-and-close.
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(50)) => return params,
                _ = async {
                    if let Ok((mut s, _)) = listener.accept().await {
                        let _ = tokio::time::timeout(Duration::from_millis(500), async {
                            let mut buf = [0u8; 1024];
                            let _ = s.read(&mut buf).await;
                            let _ = s.shutdown().await;
                        }).await;
                    }
                } => return params,
            }
        }
    })
    .await;
    match accept {
        Ok(r) => r,
        Err(_) => Err(format!(
            "Authentication timed out ({} seconds)",
            CALLBACK_TIMEOUT.as_secs()
        )),
    }
}

async fn handle_one(
    sock: &mut tokio::net::TcpStream,
    expected_path: &str,
) -> Result<HashMap<String, String>, String> {
    let mut buf = vec![0u8; 8192];
    let mut total = Vec::new();
    loop {
        let n = sock
            .read(&mut buf)
            .await
            .map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            break;
        }
        total.extend_from_slice(&buf[..n]);
        if total.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let request = String::from_utf8_lossy(&total);
    let mut lines = request.lines();
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let _method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    let (path_only, query) = match target.split_once('?') {
        Some((p, q)) => (p, q),
        None => (target, ""),
    };

    if path_only == expected_path {
        let html = SUCCESS_HTML;
        let _ = sock
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    html.len(),
                    html
                )
                .as_bytes(),
            )
            .await;
        let _ = sock.shutdown().await;
        let mut out = HashMap::new();
        for (k, v) in url_form_decode(query) {
            out.insert(k, v);
        }
        Ok(out)
    } else {
        let body = b"Not found";
        let _ = sock
            .write_all(
                format!(
                    "HTTP/1.1 404 Not Found\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .as_bytes(),
            )
            .await;
        let _ = sock.write_all(body).await;
        let _ = sock.shutdown().await;
        // Drain retry: tell caller to keep listening.
        Err("__not_callback".into())
    }
}

const SUCCESS_HTML: &str = r#"<!DOCTYPE html><html><head><meta charset="utf-8"><title>BrightCode</title></head><body><h1>Authentication Successful</h1><p>Return to BrightCode.</p><script>setTimeout(()=>window.close(),3000);</script></body></html>"#;

fn url_form_decode(q: &str) -> Vec<(String, String)> {
    q.split('&')
        .filter(|s| !s.is_empty())
        .filter_map(|kv| {
            let (k, v) = kv.split_once('=')?;
            Some((urldecode(k), urldecode(v)))
        })
        .collect()
}

fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                if let Ok(b) = u8::from_str_radix(hex, 16) {
                    out.push(b);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ── Token exchange ──────────────────────────────────────────────────────

async fn exchange_code(
    config: &OAuthConfig,
    code: &str,
    redirect_uri: &str,
    code_verifier: &str,
) -> Result<TokenResponse, String> {
    let is_json = config.content_type.as_deref() == Some("application/json");
    let (body, content_type) = if is_json {
        let body = serde_json::json!({
            "grant_type": "authorization_code",
            "client_id": config.client_id,
            "code": code,
            "redirect_uri": redirect_uri,
            "code_verifier": code_verifier,
        })
        .to_string();
        (body, "application/json".to_string())
    } else {
        let body = url_form_encode(&[
            ("grant_type", "authorization_code"),
            ("client_id", &config.client_id),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("code_verifier", code_verifier),
        ]);
        (body, "application/x-www-form-urlencoded".to_string())
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("reqwest build: {e}"))?;
    let res = client
        .post(&config.token_url)
        .header("Content-Type", content_type)
        .header("Accept", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("token POST: {e}"))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("token read: {e}"))?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), text));
    }
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("token JSON: {e}"))?;
    Ok(TokenResponse {
        access_token: v
            .get("access_token")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
        refresh_token: v
            .get("refresh_token")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
        expires_in: v.get("expires_in").and_then(|x| x.as_i64()),
        email: v
            .get("email")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
            .or_else(|| {
                v.get("user")
                    .and_then(|u| u.get("email"))
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string())
            }),
        id_token: v
            .get("id_token")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
    })
}

fn url_form_encode(pairs: &[(&str, &str)]) -> String {
    let mut out = String::new();
    for (i, (k, v)) in pairs.iter().enumerate() {
        if i > 0 {
            out.push('&');
        }
        out.push_str(&url_encode(k));
        out.push('=');
        out.push_str(&url_encode(v));
    }
    out
}

fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

// ── Tauri commands ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn oauth_start(
    _app: AppHandle,
    state: tauri::State<'_, OAuthState>,
    config: OAuthConfig,
) -> Result<OAuthResult, String> {
    // Cancel any prior flow first.
    {
        let mut g = state.inner.lock().await;
        if let Some(pending) = g.take() {
            let _ = pending.cancel_tx.send(());
        }
    }

    let (code_verifier, code_challenge, oauth_state) = generate_pkce();

    let port_to_bind = config.fixed_port.unwrap_or(0);
    let bind_result = TcpListener::bind(("127.0.0.1", port_to_bind)).await;
    let listener = match bind_result {
        Ok(l) => l,
        Err(e) => {
            if config.fixed_port.is_some() {
                TcpListener::bind(("127.0.0.1", 0))
                    .await
                    .map_err(|e2| format!("bind fallback: {e} / {e2}"))?
            } else {
                return Err(format!("bind: {e}"));
            }
        }
    };
    let actual_port = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?
        .port();

    let (cancel_tx, mut cancel_rx) = oneshot::channel();
    {
        let mut g = state.inner.lock().await;
        *g = Some(PendingFlow { cancel_tx });
    }

    let callback_path = config
        .callback_path
        .clone()
        .unwrap_or_else(|| "/callback".to_string());
    let callback_host = config
        .callback_host
        .clone()
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let redirect_uri = format!("http://{callback_host}:{actual_port}{callback_path}");

    let mut auth_params: Vec<(String, String)> = vec![
        ("client_id".into(), config.client_id.clone()),
        ("response_type".into(), "code".into()),
        ("redirect_uri".into(), redirect_uri.clone()),
        ("state".into(), oauth_state.clone()),
        ("code_challenge".into(), code_challenge.clone()),
        (
            "code_challenge_method".into(),
            config
                .code_challenge_method
                .clone()
                .unwrap_or_else(|| "S256".into()),
        ),
        ("scope".into(), config.scopes.join(" ")),
    ];
    if let Some(extra) = &config.extra_auth_params {
        for (k, v) in extra {
            auth_params.push((k.clone(), v.clone()));
        }
    }
    let query = auth_params
        .iter()
        .map(|(k, v)| format!("{}={}", url_encode(k), url_encode(v).replace('+', "%20")))
        .collect::<Vec<_>>()
        .join("&");
    let authorize_url = format!("{}?{}", config.authorize_url, query);

    // Spawn callback waiter; keep its AbortHandle so cancel / browser-fail
    // can stop it without waiting for the 5-min timeout.
    let listener_path = callback_path.clone();
    let listener_handle = tokio::spawn(async move {
        accept_one_with_path(listener, listener_path).await
    });
    let listener_abort = listener_handle.abort_handle();

    // Open browser.
    if let Err(e) = open_browser(&authorize_url) {
        listener_abort.abort();
        let mut g = state.inner.lock().await;
        *g = None;
        return Ok(OAuthResult::err(format!("Failed to open browser: {e}")));
    }

    // Wait for callback OR cancel.
    let callback_params: HashMap<String, String> = tokio::select! {
        r = listener_handle => match r {
            Ok(Ok(p)) => p,
            Ok(Err(e)) if e == "__not_callback" => {
                return Ok(OAuthResult::err("internal: wrong path"));
            }
            Ok(Err(e)) => return Ok(OAuthResult::err(e)),
            Err(e) => return Ok(OAuthResult::err(format!("join: {e}"))),
        },
        _ = &mut cancel_rx => {
            listener_abort.abort();
            let mut g = state.inner.lock().await;
            *g = None;
            return Ok(OAuthResult::err("Cancelled by user"));
        }
    };

    {
        let mut g = state.inner.lock().await;
        *g = None;
    }

    if let Some(err) = callback_params.get("error") {
        let desc = callback_params
            .get("error_description")
            .cloned()
            .unwrap_or_else(|| err.clone());
        return Ok(OAuthResult::err(desc));
    }
    if callback_params.get("state").map(String::as_str) != Some(oauth_state.as_str()) {
        return Ok(OAuthResult::err("OAuth state mismatch (CSRF warning)"));
    }
    let code = match callback_params.get("code") {
        Some(c) if !c.is_empty() => c.clone(),
        _ => return Ok(OAuthResult::err("No authorization code received")),
    };

    match exchange_code(&config, &code, &redirect_uri, &code_verifier).await {
        Ok(token) => {
            if token.access_token.is_none() {
                return Ok(OAuthResult::err("Response missing access_token"));
            }
            Ok(OAuthResult::ok(token))
        }
        Err(e) => Ok(OAuthResult::err(format!("Token exchange failed: {e}"))),
    }
}

#[tauri::command]
pub async fn oauth_cancel(state: tauri::State<'_, OAuthState>) -> Result<(), String> {
    let mut g = state.inner.lock().await;
    if let Some(p) = g.take() {
        let _ = p.cancel_tx.send(());
    }
    Ok(())
}

#[allow(dead_code)]
pub(crate) fn is_https_url(s: &str) -> bool {
    s.starts_with("https://")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_verifier_is_correct_length_and_url_safe() {
        let (verifier, challenge, state) = generate_pkce();
        assert_eq!(verifier.len(), 43);
        assert_eq!(state.len(), 22);
        assert!(!verifier.contains('+') && !verifier.contains('/') && !verifier.contains('='));
        assert_eq!(challenge.len(), 43);
        let mut hasher = Sha256::new();
        hasher.update(verifier.as_bytes());
        let expected = URL_SAFE_NO_PAD.encode(hasher.finalize());
        assert_eq!(challenge, expected);
    }

    #[test]
    fn url_form_decode_parses_kv_and_decodes_special_chars() {
        let pairs = url_form_decode("code=abc%20def&state=xyz&scope=a%2Bb&empty=");
        let map: std::collections::HashMap<_, _> = pairs.into_iter().collect();
        assert_eq!(map.get("code").map(String::as_str), Some("abc def"));
        assert_eq!(map.get("state").map(String::as_str), Some("xyz"));
        assert_eq!(map.get("scope").map(String::as_str), Some("a+b"));
        assert_eq!(map.get("empty").map(String::as_str), Some(""));
    }

    #[test]
    fn is_https_url_only_accepts_https_scheme() {
        assert!(is_https_url("https://api.example.com/oauth"));
        assert!(!is_https_url("http://api.example.com"));
        assert!(!is_https_url("ftp://x"));
    }

    #[test]
    fn openai_account_id_extracted_from_jwt_payload() {
        let header = URL_SAFE_NO_PAD.encode(b"{}");
        let payload = serde_json::json!({
            "sub": "user-1",
            "https://api.openai.com/auth": { "chatgpt_account_id": "acc-xyz" }
        })
        .to_string();
        let payload_b64 = URL_SAFE_NO_PAD.encode(payload.as_bytes());
        let sig = URL_SAFE_NO_PAD.encode(b"sig");
        let jwt = format!("{header}.{payload_b64}.{sig}");
        assert_eq!(
            extract_openai_account_id(Some(&jwt)).as_deref(),
            Some("acc-xyz")
        );
    }
}