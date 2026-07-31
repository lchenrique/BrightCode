#[tauri::command]
fn ping() -> String {
    "pong".into()
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

mod bright_memory;
mod fs_ops;
mod projects;
mod proxy;
mod sidecar;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            ping,
            app_version,
            proxy::proxy_agent_runtime,
            projects::projects_list,
            projects::projects_get_active,
            projects::projects_add,
            projects::projects_remove,
            projects::projects_set_active,
            fs_ops::fs_home,
            fs_ops::fs_default_projects_dir,
            fs_ops::fs_list_dirs,
            fs_ops::fs_browse_file,
            fs_ops::fs_validate,
            fs_ops::fs_clone,
            fs_ops::fs_canonicalize,
            bright_memory::bright_memory_status,
            bright_memory::bright_memory_install,
        ])
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

            // Load the projects store from disk; failing here is
            // recoverable (empty list). We log + fall through with an
            // empty store so the app still boots; a corrupted config
            // file would be the usual cause.
            let app_handle_for_projects = app.handle().clone();
            let projects_store = tauri::async_runtime::block_on(async move {
                projects::ProjectsStore::load(&app_handle_for_projects).await
            });
            match projects_store {
                Ok(store) => {
                    app.manage(store);
                }
                Err(e) => {
                    eprintln!("[projects] failed to load store, starting empty: {e}");
                    app.manage(projects::ProjectsStore::empty());
                }
            }

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
        assert_eq!(app_version(), "0.1.0");
    }
}
