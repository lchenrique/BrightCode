#[tauri::command]
fn ping() -> String {
    "pong".into()
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

mod sidecar;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![ping, app_version])
        .setup(|app| {
            // Spawn the Node sidecar synchronously so a broken
            // sidecar fails app boot loudly. The 5s ready timeout in
            // `sidecar::spawn` bounds the worst case.
            let app_handle = app.handle().clone();
            let supervisor = tauri::async_runtime::block_on(async move {
                sidecar::SidecarSupervisor::spawn(&app_handle).await
            })
            .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            app.manage(supervisor);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_returns_pong() {
        assert_eq!(ping(), "pong");
    }

    #[test]
    fn app_version_matches_package_version() {
        // Hardcoded literal — catches drift if app_version() and Cargo.toml diverge.
        assert_eq!(app_version(), "0.1.0");
    }
}
