//! Smoke tests for Tauri build prerequisites.
//!
//! Intentionally validates JSON syntax + icon presence only,
//! not full schema conformance (see plan 2026-07-30-brightcode-tauri-migration-plan).

use std::path::Path;

fn manifest_dir() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

#[test]
fn tauri_config_is_valid_json() {
    let path = manifest_dir().join("tauri.conf.json");
    let config = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {:?} failed: {}", path, e));
    let _: serde_json::Value = serde_json::from_str(&config)
        .unwrap_or_else(|e| panic!("tauri.conf.json invalid JSON: {}", e));
}

#[test]
fn icons_exist() {
    let dir = manifest_dir().join("icons");
    assert!(dir.join("icon.png").exists(), "icons/icon.png missing");
    assert!(dir.join("icon.ico").exists(), "icons/icon.ico missing");
}
