mod engine;
mod project;

use engine::EngineState;
use project::ProjectState;
use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ProjectState(Mutex::new(None)))
        .manage(EngineState(Mutex::new(engine::Engine::default())))
        .invoke_handler(tauri::generate_handler![
            project::project_create,
            project::project_open,
            project::file_read,
            project::file_write,
            project::journal_append,
            project::import_read,
            project::query_rename,
            engine::db_start,
            engine::db_stop,
            engine::db_status,
            engine::db_exec,
            engine::db_exec_batch
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // guarantee the engine dies with the app — Drop isn't reliable on
            // process exit, and an orphaned mysqld locks the project datadir
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                if let Some(state) = app.try_state::<engine::EngineState>() {
                    if let Ok(mut eng) = state.0.lock() {
                        eng.stop();
                    }
                }
            }
        });
}
