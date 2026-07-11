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
            engine::db_start,
            engine::db_stop,
            engine::db_status,
            engine::db_exec
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
