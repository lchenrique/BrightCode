use std::collections::HashMap;

use futures_util::StreamExt;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{oneshot, Mutex};

use crate::sidecar::SidecarSupervisor;

#[derive(Default)]
pub struct RuntimeEventsState {
    subscriptions: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

impl RuntimeEventsState {
    pub fn new() -> Self {
        Self::default()
    }
}

#[tauri::command]
pub async fn agent_runtime_subscribe(
    app: AppHandle,
    runtime_events: State<'_, RuntimeEventsState>,
    sidecar: State<'_, SidecarSupervisor>,
    command: Value,
) -> Result<Value, String> {
    let subscription_id = required_string(&command, "subscriptionId")?;
    let thread_id = required_string(&command, "threadId")?;
    let after_sequence = command
        .get("afterSequence")
        .and_then(Value::as_i64)
        .unwrap_or(-1);

    let response = sidecar
        .event_stream(&subscription_id, &thread_id)
        .await?;
    let state = sidecar
        .post(
            "/v1/agent-runtime/thread/read",
            json!({ "threadId": thread_id }),
        )
        .await?;
    let history = sidecar
        .post(
            "/v1/agent-runtime/history/read",
            json!({ "threadId": thread_id, "afterSequence": after_sequence }),
        )
        .await?;

    let (cancel, mut cancelled) = oneshot::channel();
    if let Some(previous) = runtime_events
        .subscriptions
        .lock()
        .await
        .insert(subscription_id.clone(), cancel)
    {
        let _ = previous.send(());
    }

    let channel = format!("agent-runtime:event:{subscription_id}");
    tauri::async_runtime::spawn(async move {
        let mut bytes = response.bytes_stream();
        let mut buffer = String::new();
        loop {
            tokio::select! {
                _ = &mut cancelled => break,
                next = bytes.next() => match next {
                    Some(Ok(chunk)) => {
                        buffer.push_str(&String::from_utf8_lossy(&chunk));
                        for envelope in drain_sse(&mut buffer) {
                            let _ = app.emit(&channel, envelope);
                        }
                    }
                    Some(Err(error)) => {
                        eprintln!("[agent-runtime] event stream failed: {error}");
                        break;
                    }
                    None => break,
                }
            }
        }
    });

    Ok(json!({ "state": state, "history": history }))
}

#[tauri::command]
pub async fn agent_runtime_unsubscribe(
    runtime_events: State<'_, RuntimeEventsState>,
    subscription_id: String,
) -> Result<(), String> {
    if let Some(cancel) = runtime_events.subscriptions.lock().await.remove(&subscription_id) {
        let _ = cancel.send(());
    }
    Ok(())
}

fn required_string(command: &Value, key: &str) -> Result<String, String> {
    command
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("missing {key}"))
}

fn drain_sse(buffer: &mut String) -> Vec<Value> {
    let mut values = Vec::new();
    while let Some(boundary) = buffer.find("\n\n") {
        let frame = buffer[..boundary].to_string();
        buffer.drain(..boundary + 2);
        for line in frame.lines() {
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            if let Ok(value) = serde_json::from_str(data.trim()) {
                values.push(value);
            }
        }
    }
    values
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_state_is_empty() {
        let state = RuntimeEventsState::new();
        assert!(state.subscriptions.try_lock().unwrap().is_empty());
    }

    #[test]
    fn subscribe_command_requires_subscription_id() {
        let bad = json!({ "threadId": "t-1" });
        assert!(required_string(&bad, "subscriptionId").is_err());
        let good = json!({ "subscriptionId": "s-1", "threadId": "t-1" });
        assert_eq!(required_string(&good, "subscriptionId").unwrap(), "s-1");
    }

    #[test]
    fn drain_sse_preserves_partial_frames() {
        let mut buffer = ": connected\n\ndata: {\"event\":{\"type\":\"turn-start\"}}\n".into();
        assert!(drain_sse(&mut buffer).is_empty());
        buffer.push('\n');
        let values = drain_sse(&mut buffer);
        assert_eq!(values[0]["event"]["type"], "turn-start");
        assert!(buffer.is_empty());
    }
}
