#[tauri::command]
fn ping() -> String {
    "pong".into()
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

mod accounts;
mod agent_runtime_events;
mod agents;
mod bright_memory;
mod cli;
mod fs_ops;
mod git;
mod logging;
mod oauth;
mod projects;
mod provider_stream;
mod proxy;
mod sidecar;
mod skills;
mod tasks;
mod terminal;
mod tools;
mod usage;
mod workspace;

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
            workspace::workspace_list_tree,
            workspace::workspace_read_file,
            workspace::workspace_write_file,
            workspace::workspace_open_project,
            bright_memory::bright_memory_status,
            bright_memory::bright_memory_install,
            tasks::tasks_list,
            tasks::tasks_create,
            tasks::tasks_remove,
            tasks::tasks_update,
            tasks::tasks_get_messages,
            tasks::tasks_save_messages,
            git::git_exec,
            skills::skills_list,
            skills::skills_read,
            skills::skills_write,
            oauth::oauth_start,
            oauth::oauth_cancel,
            tools::tools_execute,
            tools::tools_respond_bash_approval,
            terminal::terminal_create,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_kill,
            provider_stream::provider_stream_start,
            provider_stream::provider_stream_cancel,
            agent_runtime_events::agent_runtime_subscribe,
            agent_runtime_events::agent_runtime_unsubscribe,
            logging::renderer_log,
            accounts::accounts_list_all,
            accounts::accounts_list,
            accounts::accounts_get,
            accounts::accounts_add,
            accounts::accounts_update,
            accounts::accounts_remove,
            accounts::accounts_set_active,
            accounts::accounts_list_active,
            accounts::accounts_get_active,
            agents::agents_list,
            agents::agents_get,
            agents::agents_add,
            agents::agents_update,
            agents::agents_remove,
            usage::usage_record,
            usage::usage_get_history,
            usage::usage_get_all_history,
            usage::usage_clear,
            usage::usage_set_quota,
            usage::usage_get_quota,
            usage::usage_get_all_quotas,
            usage::usage_fetch_quota,
            usage::usage_fetch_codex,
            usage::usage_read_codex_local,
            cli::cli_detect,
            cli::cli_detect_all,
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

            app.manage(tasks::TasksStore::lazy());
            app.manage(oauth::OAuthState::new());
            app.manage(tools::ToolsState::new());
            app.manage(terminal::TerminalState::new());
            app.manage(provider_stream::StreamState::new());
            app.manage(agent_runtime_events::RuntimeEventsState::new());
            app.manage(accounts::AccountsStore::lazy());
            app.manage(agents::AgentsStore::lazy());
            app.manage(usage::UsageStore::lazy());

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