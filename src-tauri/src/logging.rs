//! Renderer log forwarding.
//!
//! Mirrors the small block in `electron/main/index.ts` that prints
//! `console.log/warn/error` from the renderer with a `[renderer:<level>]`
//! prefix. The renderer can keep calling its existing logger — this
//! just lands the messages in the same stdout/stderr stream as the
//! Rust process so devtools + terminal output stay aligned.

use serde_json::Value;

#[tauri::command]
pub fn renderer_log(level: String, args: Value) -> Result<(), String> {
    let level = match level.as_str() {
        "log" | "info" => "info",
        "warn" => "warn",
        "error" => "error",
        "debug" => "debug",
        other => other,
    };
    let printable = match args {
        Value::Array(items) => items
            .iter()
            .map(format_one)
            .collect::<Vec<_>>()
            .join(" "),
        other => format_one(&other),
    };
    let prefix = format!("[renderer:{level}]");
    match level {
        "error" => eprintln!("{prefix} {printable}"),
        "warn" => eprintln!("{prefix} {printable}"),
        _ => println!("{prefix} {printable}"),
    }
    Ok(())
}

fn format_one(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renderer_log_accepts_string_level_and_args() {
        // Pure check: command signature accepts (String, Value) and returns Ok.
        // We don't capture stdout in unit tests; the contract is "doesn't panic".
        let r = renderer_log("info".into(), serde_json::json!(["hello", 42]));
        assert!(r.is_ok());
    }

    #[test]
    fn format_one_renders_each_json_shape() {
        assert_eq!(format_one(&serde_json::json!(null)), "null");
        assert_eq!(format_one(&serde_json::json!(true)), "true");
        assert_eq!(format_one(&serde_json::json!(42)), "42");
        assert_eq!(format_one(&serde_json::json!("x")), "x");
        let obj = format_one(&serde_json::json!({ "a": 1 }));
        assert!(obj.contains("\"a\""));
    }

    #[test]
    fn unknown_level_is_passed_through() {
        // Just exercise the call; we don't assert on stdout.
        let r = renderer_log("trace".into(), serde_json::json!("hi"));
        assert!(r.is_ok());
    }
}