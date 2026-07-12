//! The sandbox engine: a bundled portable MySQL Community Server, one process
//! per open project, datadir inside the project folder (.sqlstudio/db).
//! Behind this adapter the engine is swappable configuration — nothing
//! outside this module knows which server binary runs.

use mysql::prelude::*;
use mysql::{OptsBuilder, Pool, Value};
use serde::Serialize;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct EngineState(pub Mutex<Engine>);

#[derive(Default)]
pub struct Engine {
    child: Option<Child>,
    port: u16,
    pool: Option<Pool>,
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl Engine {
    /// public stop for the app-exit hook
    pub fn stop(&mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        if let Some(pool) = self.pool.take() {
            if let Ok(mut conn) = pool.get_conn() {
                let _ = conn.query_drop("SHUTDOWN");
            }
        }
        if let Some(mut child) = self.child.take() {
            // give mysqld a moment to stop cleanly, then make sure
            let deadline = Instant::now() + Duration::from_secs(8);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    _ if Instant::now() > deadline => {
                        let _ = child.kill();
                        break;
                    }
                    _ => std::thread::sleep(Duration::from_millis(150)),
                }
            }
        }
        self.port = 0;
    }
}

#[derive(Serialize)]
pub struct ExecResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub affected: u64,
    pub elapsed_ms: u128,
}

#[derive(Serialize)]
pub struct EngineInfo {
    pub running: bool,
    pub port: u16,
}

/// Locate the bundled engine. Dev: src-tauri/resources/engine.
/// Packaged: <resource_dir>/resources/engine.
fn engine_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("engine");
    if dev.join("bin").join("mysqld.exe").exists() {
        return Ok(dev);
    }
    use tauri::Manager;
    let res = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("resources")
        .join("engine");
    if res.join("bin").join("mysqld.exe").exists() {
        return Ok(res);
    }
    Err("bundled engine not found — run: node scripts/fetch-engine.mjs".into())
}

fn free_port() -> Result<u16, String> {
    let l = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    Ok(l.local_addr().map_err(|e| e.to_string())?.port())
}

fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
}

fn mysqld_args(engine: &Path, datadir: &Path, port: u16) -> Vec<String> {
    vec![
        "--no-defaults".into(),
        format!("--basedir={}", engine.display()),
        format!("--datadir={}", datadir.display()),
        format!("--lc-messages-dir={}", engine.join("share").display()),
        format!("--port={}", port),
        "--bind-address=127.0.0.1".into(),
        "--mysqlx=OFF".into(),
        "--disable-log-bin".into(),
        "--innodb-buffer-pool-size=64M".into(),
        "--innodb-flush-log-at-trx-commit=2".into(),
    ]
}

fn initialize_datadir(engine: &Path, datadir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(datadir.parent().unwrap()).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(engine.join("bin").join("mysqld.exe"));
    cmd.args([
        "--no-defaults".to_string(),
        format!("--basedir={}", engine.display()),
        format!("--datadir={}", datadir.display()),
        format!("--lc-messages-dir={}", engine.join("share").display()),
        "--initialize-insecure".to_string(),
    ]);
    no_window(&mut cmd);
    let out = cmd.output().map_err(|e| format!("failed to run mysqld --initialize: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "engine initialize failed:\n{}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

fn connect(port: u16) -> Result<Pool, String> {
    let opts = OptsBuilder::new()
        .ip_or_hostname(Some("127.0.0.1"))
        .tcp_port(port)
        .user(Some("root"))
        .pass(Some(""))
        .prefer_socket(false);
    Pool::new(opts).map_err(|e| e.to_string())
}

fn wait_ready(port: u16, timeout: Duration) -> Result<Pool, String> {
    let deadline = Instant::now() + timeout;
    let mut last = String::new();
    loop {
        match connect(port) {
            Ok(pool) => match pool.get_conn() {
                Ok(mut c) => {
                    if c.query_drop("SELECT 1").is_ok() {
                        return Ok(pool);
                    }
                }
                Err(e) => last = e.to_string(),
            },
            Err(e) => last = e,
        }
        if Instant::now() > deadline {
            return Err(format!("engine did not become ready: {last}"));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn value_to_string(v: Value) -> Option<String> {
    match v {
        Value::NULL => None,
        Value::Bytes(b) => Some(String::from_utf8_lossy(&b).to_string()),
        Value::Int(i) => Some(i.to_string()),
        Value::UInt(u) => Some(u.to_string()),
        Value::Float(f) => Some(f.to_string()),
        Value::Double(d) => Some(d.to_string()),
        Value::Date(y, mo, d, h, mi, s, us) => Some(if h == 0 && mi == 0 && s == 0 && us == 0 {
            format!("{y:04}-{mo:02}-{d:02}")
        } else {
            format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}")
        }),
        Value::Time(neg, d, h, m, s, _us) => {
            let sign = if neg { "-" } else { "" };
            Some(format!("{sign}{:02}:{m:02}:{s:02}", u32::from(h) + d * 24))
        }
    }
}

/// If a previous SQL Studio session died without a clean shutdown, its mysqld
/// keeps running and holds the datadir lock — a new engine would then hang at
/// startup. mysqld writes `<hostname>.pid` into the datadir; kill that stale
/// process before starting ours.
fn reclaim_stale_engine(datadir: &Path) {
    let Ok(entries) = std::fs::read_dir(datadir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().map(|x| x == "pid").unwrap_or(false) {
            if let Ok(pid_txt) = std::fs::read_to_string(&p) {
                if let Ok(pid) = pid_txt.trim().parse::<u32>() {
                    let mut cmd = Command::new("taskkill");
                    cmd.args(["/PID", &pid.to_string(), "/F"]);
                    no_window(&mut cmd);
                    let _ = cmd.output(); // best-effort; fails harmlessly if gone
                }
            }
            let _ = std::fs::remove_file(&p);
        }
    }
}

#[tauri::command]
pub async fn db_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, EngineState>,
    project_root: String,
) -> Result<EngineInfo, String> {
    let mut eng = state.0.lock().map_err(|e| e.to_string())?;
    eng.shutdown(); // one engine at a time; switching projects restarts it

    let engine = engine_dir(&app)?;
    let datadir = PathBuf::from(&project_root).join(".sqlstudio").join("db");
    if !datadir.join("mysql.ibd").exists() {
        initialize_datadir(&engine, &datadir)?;
    } else {
        reclaim_stale_engine(&datadir);
    }

    let port = free_port()?;
    let mut cmd = Command::new(engine.join("bin").join("mysqld.exe"));
    cmd.args(mysqld_args(&engine, &datadir, port));
    no_window(&mut cmd);
    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to start engine: {e}"))?;
    eng.child = Some(child);
    eng.port = port;

    match wait_ready(port, Duration::from_secs(40)) {
        Ok(pool) => {
            eng.pool = Some(pool);
            Ok(EngineInfo {
                running: true,
                port,
            })
        }
        Err(e) => {
            eng.shutdown();
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn db_stop(state: tauri::State<'_, EngineState>) -> Result<(), String> {
    state.0.lock().map_err(|e| e.to_string())?.shutdown();
    Ok(())
}

#[tauri::command]
pub async fn db_status(state: tauri::State<'_, EngineState>) -> Result<EngineInfo, String> {
    let eng = state.0.lock().map_err(|e| e.to_string())?;
    Ok(EngineInfo {
        running: eng.pool.is_some(),
        port: eng.port,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Project-lifecycle integration: scaffold a project folder, start the
    /// engine on it (as db_start does), build the DB from a schema.sql-like
    /// script, restart the engine, and confirm the data SURVIVED in the
    /// project's own datadir (folder = database).
    #[test]
    fn project_datadir_persists_across_restarts() {
        let engine = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("engine");
        if !engine.join("bin").join("mysqld.exe").exists() {
            panic!("engine missing — run: node scripts/fetch-engine.mjs");
        }
        let proj = std::env::temp_dir().join("sqlstudio-proj-test");
        let _ = std::fs::remove_dir_all(&proj);
        let datadir = proj.join(".sqlstudio").join("db");
        initialize_datadir(&engine, &datadir).expect("initialize");

        // session 1: create schema + data
        {
            let port = free_port().unwrap();
            let mut cmd = Command::new(engine.join("bin").join("mysqld.exe"));
            cmd.args(mysqld_args(&engine, &datadir, port));
            no_window(&mut cmd);
            let child = cmd.spawn().unwrap();
            let pool = wait_ready(port, Duration::from_secs(60)).unwrap();
            let mut conn = pool.get_conn().unwrap();
            conn.query_drop("CREATE DATABASE shop").unwrap();
            conn.query_drop("USE shop").unwrap();
            conn.query_drop("CREATE TABLE item (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50))")
                .unwrap();
            conn.query_drop("INSERT INTO item (name) VALUES ('lamp'),('chair')")
                .unwrap();
            drop(conn);
            let mut e = Engine { child: Some(child), port, pool: Some(pool) };
            e.shutdown();
        }

        // session 2: same datadir, new port — data must still be there
        {
            let port = free_port().unwrap();
            let mut cmd = Command::new(engine.join("bin").join("mysqld.exe"));
            cmd.args(mysqld_args(&engine, &datadir, port));
            no_window(&mut cmd);
            let child = cmd.spawn().unwrap();
            let pool = wait_ready(port, Duration::from_secs(60)).unwrap();
            let mut conn = pool.get_conn().unwrap();
            let names: Vec<String> = conn
                .query("SELECT name FROM shop.item ORDER BY id")
                .unwrap();
            assert_eq!(names, vec!["lamp".to_string(), "chair".to_string()]);
            drop(conn);
            let mut e = Engine { child: Some(child), port, pool: Some(pool) };
            e.shutdown();
        }
        let _ = std::fs::remove_dir_all(&proj);
    }

    /// Full sandbox round-trip against the bundled engine:
    /// initialize → start → DDL/DML → query → clean shutdown.
    #[test]
    fn sandbox_roundtrip() {
        let engine = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("engine");
        assert!(
            engine.join("bin").join("mysqld.exe").exists(),
            "engine missing — run: node scripts/fetch-engine.mjs"
        );
        let td = std::env::temp_dir().join("sqlstudio-engine-test");
        let _ = std::fs::remove_dir_all(&td);
        let datadir = td.join("db");
        initialize_datadir(&engine, &datadir).expect("initialize");

        let port = free_port().expect("port");
        let mut cmd = Command::new(engine.join("bin").join("mysqld.exe"));
        cmd.args(mysqld_args(&engine, &datadir, port));
        no_window(&mut cmd);
        let child = cmd.spawn().expect("spawn");
        let mut eng = Engine {
            child: Some(child),
            port,
            pool: None,
        };

        let pool = wait_ready(port, Duration::from_secs(60)).expect("ready");
        let mut conn = pool.get_conn().expect("conn");
        conn.query_drop("CREATE DATABASE t").unwrap();
        conn.query_drop("USE t").unwrap();
        conn.query_drop("CREATE TABLE x (id INT PRIMARY KEY, name VARCHAR(20))")
            .unwrap();
        conn.query_drop("INSERT INTO x VALUES (1,'a'),(2,NULL)").unwrap();
        let rows: Vec<(i32, Option<String>)> =
            conn.query("SELECT id, name FROM x ORDER BY id").unwrap();
        assert_eq!(rows, vec![(1, Some("a".into())), (2, None)]);
        drop(conn);

        eng.pool = Some(pool);
        eng.shutdown();
        let _ = std::fs::remove_dir_all(&td);
    }
}

#[tauri::command]
pub async fn db_exec(
    state: tauri::State<'_, EngineState>,
    sql: String,
    db: Option<String>,
) -> Result<ExecResult, String> {
    let eng = state.0.lock().map_err(|e| e.to_string())?;
    let pool = eng.pool.as_ref().ok_or("engine not running")?;
    let mut conn = pool.get_conn().map_err(|e| e.to_string())?;

    // pooled connections don't remember USE across checkouts — select the
    // project's current database explicitly for every statement
    if let Some(db) = db {
        let ident = db.replace('`', "");
        if !ident.is_empty() {
            conn.query_drop(format!("USE `{ident}`"))
                .map_err(|e| e.to_string())?;
        }
    }

    let start = Instant::now();
    let result = conn.query_iter(&sql).map_err(|e| e.to_string())?;

    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let affected = result.affected_rows();

    for col in result.columns().as_ref() {
        columns.push(col.name_str().to_string());
    }
    for row in result {
        let row = row.map_err(|e| e.to_string())?;
        let mut out = Vec::with_capacity(row.len());
        for i in 0..row.len() {
            out.push(row.get::<Value, usize>(i).and_then(value_to_string));
        }
        rows.push(out);
    }

    Ok(ExecResult {
        columns,
        rows,
        affected,
        elapsed_ms: start.elapsed().as_millis(),
    })
}
