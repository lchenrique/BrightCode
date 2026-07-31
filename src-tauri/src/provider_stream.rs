//! Server-Sent Events (SSE) streaming proxy for LLM providers.
//!
//! Mirrors `electron/main/provider-proxy.ts`. The renderer builds the
//! upstream URL/headers/body (it knows the provider's wire format);
//! this module makes the authenticated, no-CORS request and forwards
//! `data: <chunk>` lines back as Tauri events.
//!
//! Events emitted (one event name per active requestId):
//!   `provider:stream-chunk:{requestId}` → `{ raw: <string> }`
//!   `provider:stream-end:{requestId}`   → `null`
//!   `provider:stream-error:{requestId}` → `{ message: <string> }`
//!
//! Allowlist: only https URLs whose host is on the supported-providers
//! list are accepted. Adding a provider is a one-line change here.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::{Method, Url};
use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, Mutex};

const STREAM_TIMEOUT: Duration = Duration::from_secs(10 * 60);

const ALLOWED_HOSTS: &[&str] = &[
    "api.openai.com",
    "api.anthropic.com",
    "generativelanguage.googleapis.com",
    "api.codex.com",
    "api.cerebras.ai",
    "api.groq.com",
    "openrouter.ai",
    "api.deepseek.com",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamStartPayload {
    pub request_id: String,
    pub provider_id: String,
    pub api_format: String,
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub body: String,
}

pub struct StreamState {
    active: Arc<Mutex<HashMap<String, ActiveStream>>>,
}

struct ActiveStream {
    cancel: oneshot::Sender<()>,
}

impl Default for StreamState {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamState {
    pub fn new() -> Self {
        Self {
            active: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// Validate the upstream URL: https scheme, host in the allowlist.
/// Uses `reqwest::Url::parse` so we handle userinfo, ports, and IPv6
/// correctly instead of hand-parsing.
pub(crate) fn is_allowed_url(url: &str) -> Result<(), String> {
    let parsed = Url::parse(url).map_err(|e| format!("invalid url: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("url must be https".into());
    }
    // ignore username/password — renderer can authenticate via headers
    let host = parsed
        .host_str()
        .ok_or_else(|| "missing host".to_string())?;
    if !ALLOWED_HOSTS.iter().any(|h| *h == host) {
        return Err(format!("host not in allowlist: {host}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn provider_stream_start(
    app: AppHandle,
    state: tauri::State<'_, StreamState>,
    payload: StreamStartPayload,
) -> Result<(), String> {
    is_allowed_url(&payload.url)?;

    let (cancel_tx, mut cancel_rx) = oneshot::channel();
    {
        let mut g = state.active.lock().await;
        // If there's an active stream with the same id, cancel it first.
        if let Some(prev) = g.remove(&payload.request_id) {
            let _ = prev.cancel.send(());
        }
        g.insert(
            payload.request_id.clone(),
            ActiveStream {
                cancel: cancel_tx,
            },
        );
    }

    let app_handle = app.clone();
    let request_id = payload.request_id.clone();
    let url = payload.url.clone();
    let method = payload.method.clone();
    let headers = payload.headers.clone();
    let body = payload.body.clone();

    let active = state.active.clone();

    tokio::spawn(async move {
        let mut req = match reqwest::Client::builder()
            .timeout(STREAM_TIMEOUT)
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                emit_error(&app_handle, &request_id, &format!("client build: {e}"));
                cleanup(&active, &request_id).await;
                return;
            }
        }
        .request(
            Method::from_bytes(method.to_uppercase().as_bytes())
                .unwrap_or(Method::GET),
            &url,
        );

        for (k, v) in &headers {
            req = req.header(k.as_str(), v.as_str());
        }
        if !body.is_empty() {
            req = req.body(body);
        }

        // Wrap send() in select so cancel during DNS/connect/TLS works.
        let send_fut = req.send();
        tokio::pin!(send_fut);
        let res = tokio::select! {
            r = &mut send_fut => match r {
                Ok(r) => r,
                Err(e) => {
                    emit_error(&app_handle, &request_id, &format!("request: {e}"));
                    cleanup(&active, &request_id).await;
                    return;
                }
            },
            _ = &mut cancel_rx => {
                cleanup(&active, &request_id).await;
                return;
            }
        };

        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            emit_error(
                &app_handle,
                &request_id,
                &format!("HTTP {}: {}", status.as_u16(), &text[..text.len().min(500)]),
            );
            cleanup(&active, &request_id).await;
            return;
        }

        let mut stream = res.bytes_stream();
        let mut buffer = String::new();
        loop {
            let next = stream.next();
            tokio::pin!(next);
            tokio::select! {
                _ = &mut cancel_rx => {
                    cleanup(&active, &request_id).await;
                    return;
                }
                next = &mut next => match next {
                    Some(Ok(chunk)) => {
                        buffer.push_str(&String::from_utf8_lossy(&chunk));
                        while let Some(idx) = buffer.find("\n\n") {
                            let raw = buffer[..idx].to_string();
                            buffer = buffer[idx + 2..].to_string();
                            for line in raw.lines() {
                                if let Some(rest) = line.strip_prefix("data:") {
                                    let data = rest.trim();
                                    if data == "[DONE]" {
                                        continue;
                                    }
                                    let _ = app_handle.emit(
                                        &format!("provider:stream-chunk:{request_id}"),
                                        json!({ "raw": data }),
                                    );
                                }
                            }
                        }
                    }
                    Some(Err(e)) => {
                        emit_error(&app_handle, &request_id, &format!("stream: {e}"));
                        cleanup(&active, &request_id).await;
                        return;
                    }
                    None => {
                        let _ = app_handle.emit(
                            &format!("provider:stream-end:{request_id}"),
                            serde_json::Value::Null,
                        );
                        cleanup(&active, &request_id).await;
                        return;
                    }
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn provider_stream_cancel(
    state: tauri::State<'_, StreamState>,
    request_id: String,
) -> Result<(), String> {
    let mut g = state.active.lock().await;
    if let Some(active) = g.remove(&request_id) {
        let _ = active.cancel.send(());
    }
    Ok(())
}

/// Errors are emitted as `{ message: string }` so the renderer's
/// `new Error(e.payload.message)` reads correctly.
fn emit_error(app: &AppHandle, request_id: &str, msg: &str) {
    let _ = app.emit(
        &format!("provider:stream-error:{request_id}"),
        json!({ "message": msg }),
    );
}

async fn cleanup(active: &Arc<Mutex<HashMap<String, ActiveStream>>>, request_id: &str) {
    let mut g = active.lock().await;
    g.remove(request_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_allowed_url_accepts_https_allowlist() {
        assert!(is_allowed_url("https://api.openai.com/v1/chat").is_ok());
        assert!(is_allowed_url("https://api.anthropic.com/v1/messages").is_ok());
        assert!(is_allowed_url("https://openrouter.ai/api/v1/chat").is_ok());
    }

    #[test]
    fn is_allowed_url_rejects_http_and_unknown_host() {
        assert!(is_allowed_url("http://api.openai.com/v1/chat").is_err());
        assert!(is_allowed_url("https://malicious.example.com").is_err());
        assert!(is_allowed_url("ftp://api.openai.com").is_err());
        assert!(is_allowed_url("not a url").is_err());
    }

    #[test]
    fn is_allowed_url_strips_port_and_userinfo() {
        // Port is part of URL but doesn't change host match.
        assert!(is_allowed_url("https://api.openai.com:443/v1").is_ok());
        assert!(is_allowed_url("https://user:pass@api.openai.com/v1").is_ok());
        // Unknown host with a port is still rejected.
        assert!(is_allowed_url("https://evil.example.com:443/").is_err());
    }
}