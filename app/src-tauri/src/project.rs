//! Project management: a project is a folder that IS a database.
//! Standard file set: schema.sql (truth) · data.sql (seed) · journal.sql
//! (applied-change log) · queries/*.sql (saved selects) · .sqlstudio/ (app
//! state + engine datadir).

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct ProjectState(pub Mutex<Option<PathBuf>>);

#[derive(Serialize)]
pub struct QueryFile {
    pub name: String,
    pub content: String,
}

#[derive(Serialize)]
pub struct Project {
    pub root: String,
    pub name: String,
    pub schema: String,
    pub data: String,
    pub journal: String,
    pub queries: Vec<QueryFile>,
}

const SCHEMA_TEMPLATE: &str = "-- schema.sql — the database definition. SQL Studio edits this file in\n-- place as you work in the builder; you can also type here directly.\n\n";
const DATA_TEMPLATE: &str = "-- data.sql — the project's data. SQL Studio snapshots the live data here\n-- after every applied change, so the project can rebuild from its files.\n\n";
const JOURNAL_TEMPLATE: &str = "-- journal.sql — every change SQL Studio actually applied, in order.\n-- Replayable: run these against another server to reproduce the project's history.\n\n";

fn read_or(path: &Path, fallback: &str) -> String {
    fs::read_to_string(path).unwrap_or_else(|_| fallback.to_string())
}

/// Write via temp-file + rename so a crash mid-write can never leave a
/// truncated schema.sql/data.sql/journal.sql — the project IS these files.
fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    let tmp = path.with_extension("sql.tmp");
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    // std::fs::rename replaces existing files on Windows (MOVEFILE_REPLACE_EXISTING)
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

fn load(root: &Path) -> Result<Project, String> {
    let name = root
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "project".into());
    let mut queries = Vec::new();
    let qdir = root.join("queries");
    if let Ok(entries) = fs::read_dir(&qdir) {
        let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        paths.sort();
        for p in paths {
            if p.extension().map(|e| e == "sql").unwrap_or(false) {
                queries.push(QueryFile {
                    name: p
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    content: read_or(&p, ""),
                });
            }
        }
    }
    Ok(Project {
        root: root.to_string_lossy().to_string(),
        name,
        schema: read_or(&root.join("schema.sql"), ""),
        data: read_or(&root.join("data.sql"), ""),
        journal: read_or(&root.join("journal.sql"), ""),
        queries,
    })
}

/// Resolve a project-relative file path, refusing escapes. Only known project
/// files are writable through this API.
fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let ok = matches!(rel, "schema.sql" | "data.sql" | "journal.sql")
        || (rel.starts_with("queries/")
            && rel.ends_with(".sql")
            && !rel.contains("..")
            && !rel.contains('\\'));
    if !ok {
        return Err(format!("refusing to touch '{rel}' — not a project file"));
    }
    Ok(root.join(rel))
}

fn current_root(state: &tauri::State<ProjectState>) -> Result<PathBuf, String> {
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| "no project open".to_string())
}

#[tauri::command]
pub async fn project_create(
    state: tauri::State<'_, ProjectState>,
    path: String,
) -> Result<Project, String> {
    let root = PathBuf::from(&path);
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    if root.join("schema.sql").exists() {
        return Err("this folder already contains a SQL Studio project".into());
    }
    fs::write(root.join("schema.sql"), SCHEMA_TEMPLATE).map_err(|e| e.to_string())?;
    fs::write(root.join("data.sql"), DATA_TEMPLATE).map_err(|e| e.to_string())?;
    fs::write(root.join("journal.sql"), JOURNAL_TEMPLATE).map_err(|e| e.to_string())?;
    fs::create_dir_all(root.join("queries")).map_err(|e| e.to_string())?;
    fs::create_dir_all(root.join(".sqlstudio")).map_err(|e| e.to_string())?;
    *state.0.lock().map_err(|e| e.to_string())? = Some(root.clone());
    load(&root)
}

#[tauri::command]
pub async fn project_open(state: tauri::State<'_, ProjectState>, path: String) -> Result<Project, String> {
    let root = PathBuf::from(&path);
    if !root.join("schema.sql").exists() {
        return Err("no schema.sql here — not a SQL Studio project (use Create)".into());
    }
    fs::create_dir_all(root.join("queries")).map_err(|e| e.to_string())?;
    fs::create_dir_all(root.join(".sqlstudio")).map_err(|e| e.to_string())?;
    *state.0.lock().map_err(|e| e.to_string())? = Some(root.clone());
    load(&root)
}

#[tauri::command]
pub async fn file_write(
    state: tauri::State<'_, ProjectState>,
    rel: String,
    content: String,
) -> Result<(), String> {
    let root = current_root(&state)?;
    let path = resolve(&root, &rel)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    write_atomic(&path, &content)
}

#[tauri::command]
pub async fn file_read(state: tauri::State<'_, ProjectState>, rel: String) -> Result<String, String> {
    let root = current_root(&state)?;
    let path = resolve(&root, &rel)?;
    fs::read_to_string(path).map_err(|e| e.to_string())
}

/// Read a user-picked file for import (the path comes from the native file
/// dialog — outside the project on purpose, read-only).
#[tauri::command]
pub async fn import_read(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Rename a saved query file (queries/*.sql only — resolve() guards both ends).
#[tauri::command]
pub async fn query_rename(
    state: tauri::State<'_, ProjectState>,
    from: String,
    to: String,
) -> Result<(), String> {
    let root = current_root(&state)?;
    if !from.starts_with("queries/") || !to.starts_with("queries/") {
        return Err("only saved queries can be renamed".into());
    }
    let src = resolve(&root, &from)?;
    let dst = resolve(&root, &to)?;
    if dst.exists() {
        return Err("a query with that name already exists".into());
    }
    fs::rename(src, dst).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn journal_append(state: tauri::State<'_, ProjectState>, entry: String) -> Result<(), String> {
    let root = current_root(&state)?;
    let path = root.join("journal.sql");
    let mut cur = read_or(&path, JOURNAL_TEMPLATE);
    if !cur.ends_with('\n') {
        cur.push('\n');
    }
    cur.push_str(&entry);
    if !entry.ends_with('\n') {
        cur.push('\n');
    }
    write_atomic(&path, &cur)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_atomic_replaces_and_leaves_no_debris() {
        let dir = std::env::temp_dir().join("sqlstudio-atomic-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("schema.sql");
        write_atomic(&target, "first").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "first");
        // the rename must REPLACE an existing file (Windows historically balked)
        write_atomic(&target, "second").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "second");
        assert!(
            !dir.join("schema.sql.tmp").exists() && !target.with_extension("sql.tmp").exists(),
            "no temp debris"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
