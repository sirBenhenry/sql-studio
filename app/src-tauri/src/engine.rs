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
    lock_path: Option<PathBuf>,
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
        if let Some(lock) = self.lock_path.take() {
            let _ = std::fs::remove_file(lock);
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

#[cfg(test)] // production startup uses the child-watching loop in db_start
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

/// The image name (e.g. "mysqld.exe") of a live process, or None if no such
/// process exists. Used to avoid killing an innocent PID-reuse victim.
fn pid_image_name(pid: u32) -> Option<String> {
    let mut cmd = Command::new("tasklist");
    cmd.args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"]);
    no_window(&mut cmd);
    let out = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let line = text.lines().find(|l| l.contains(','))?;
    let name = line.split(',').next()?.trim().trim_matches('"').to_string();
    if name.is_empty() { None } else { Some(name) }
}

/// If a previous SQL Studio session died without a clean shutdown, its mysqld
/// keeps running and holds the datadir lock — a new engine would then hang at
/// startup. mysqld writes `<hostname>.pid` into the datadir; kill that stale
/// process before starting ours — but only if the PID really is a mysqld
/// (PIDs get reused; the file may be ancient).
fn reclaim_stale_engine(datadir: &Path) {
    let Ok(entries) = std::fs::read_dir(datadir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().map(|x| x == "pid").unwrap_or(false) {
            if let Ok(pid_txt) = std::fs::read_to_string(&p) {
                if let Ok(pid) = pid_txt.trim().parse::<u32>() {
                    let is_mysqld = pid_image_name(pid)
                        .map(|n| n.eq_ignore_ascii_case("mysqld.exe"))
                        .unwrap_or(false);
                    if is_mysqld {
                        let mut cmd = Command::new("taskkill");
                        cmd.args(["/PID", &pid.to_string(), "/F"]);
                        no_window(&mut cmd);
                        let _ = cmd.output(); // best-effort; fails harmlessly if gone
                    }
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
    let sdir = PathBuf::from(&project_root).join(".sqlstudio");
    let datadir = sdir.join("db");

    // one window per project: a live lock holder means this project's engine
    // belongs to someone else — refuse instead of killing it out from under them
    let lockfile = sdir.join("studio.lock");
    if let Ok(txt) = std::fs::read_to_string(&lockfile) {
        if let Ok(pid) = txt.trim().parse::<u32>() {
            if pid != std::process::id() && pid_image_name(pid).is_some() {
                return Err(format!(
                    "this project is already open in another SQL Studio window (pid {pid}). \
                     If that's not true, delete .sqlstudio\\studio.lock and try again."
                ));
            }
        }
    }
    std::fs::create_dir_all(&sdir).map_err(|e| e.to_string())?;
    std::fs::write(&lockfile, std::process::id().to_string()).map_err(|e| e.to_string())?;
    eng.lock_path = Some(lockfile);

    if !datadir.join("mysql.ibd").exists() {
        // an interrupted --initialize leaves debris that fails every retry —
        // a datadir without mysql.ibd is unusable anyway, so clear it
        if datadir.exists()
            && std::fs::read_dir(&datadir)
                .map(|mut d| d.next().is_some())
                .unwrap_or(false)
        {
            std::fs::remove_dir_all(&datadir)
                .map_err(|e| format!("could not clear a broken datadir: {e}"))?;
        }
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

    // readiness wait that also watches the child: a mysqld that exits
    // immediately (port conflict, corrupt datadir) must fail NOW with a
    // pointer to its error log, not after the full 40s
    let deadline = Instant::now() + Duration::from_secs(40);
    let mut last = String::new();
    loop {
        if let Some(child) = eng.child.as_mut() {
            if let Ok(Some(status)) = child.try_wait() {
                eng.shutdown();
                return Err(format!(
                    "the engine exited during startup ({status}) — check the newest .err file in {}",
                    datadir.display()
                ));
            }
        }
        match connect(port) {
            Ok(pool) => match pool.get_conn() {
                Ok(mut c) => {
                    if c.query_drop("SELECT 1").is_ok() {
                        eng.pool = Some(pool);
                        return Ok(EngineInfo { running: true, port });
                    }
                }
                Err(e) => last = e.to_string(),
            },
            Err(e) => last = e,
        }
        if Instant::now() > deadline {
            eng.shutdown();
            return Err(format!("engine did not become ready: {last}"));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

#[tauri::command]
pub async fn db_stop(state: tauri::State<'_, EngineState>) -> Result<(), String> {
    state.0.lock().map_err(|e| e.to_string())?.shutdown();
    Ok(())
}

#[tauri::command]
pub async fn db_status(state: tauri::State<'_, EngineState>) -> Result<EngineInfo, String> {
    let mut eng = state.0.lock().map_err(|e| e.to_string())?;
    // a dead child means not running, whatever the pool believes — the
    // heartbeat relies on this being honest
    if let Some(child) = eng.child.as_mut() {
        if let Ok(Some(_)) = child.try_wait() {
            eng.child = None;
            eng.pool = None;
            eng.port = 0;
        }
    }
    Ok(EngineInfo {
        running: eng.pool.is_some() && eng.child.is_some(),
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
            let mut e = Engine { child: Some(child), port, pool: Some(pool), lock_path: None };
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
            let mut e = Engine { child: Some(child), port, pool: Some(pool), lock_path: None };
            e.shutdown();
        }
        let _ = std::fs::remove_dir_all(&proj);
    }

    /// The exact SQL shapes the tables designer emits for its constraint
    /// lifecycle, validated against the real engine: drop-then-re-add CHECK
    /// (so ranges can widen), drop a unique index found via STATISTICS,
    /// drop an FK found via KEY_COLUMN_USAGE, ADD PRIMARY KEY after ADD.
    #[test]
    fn designer_constraint_lifecycle_sql() {
        let engine = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("engine");
        if !engine.join("bin").join("mysqld.exe").exists() {
            panic!("engine missing — run: node scripts/fetch-engine.mjs");
        }
        let td = std::env::temp_dir().join("sqlstudio-lifecycle-test");
        let _ = std::fs::remove_dir_all(&td);
        let datadir = td.join("db");
        initialize_datadir(&engine, &datadir).expect("initialize");

        let port = free_port().unwrap();
        let mut cmd = Command::new(engine.join("bin").join("mysqld.exe"));
        cmd.args(mysqld_args(&engine, &datadir, port));
        no_window(&mut cmd);
        let child = cmd.spawn().unwrap();
        let pool = wait_ready(port, Duration::from_secs(60)).unwrap();
        let mut conn = pool.get_conn().unwrap();

        conn.query_drop("CREATE DATABASE d").unwrap();
        conn.query_drop("USE d").unwrap();
        conn.query_drop(
            "CREATE TABLE u (\
             id INT UNSIGNED NOT NULL AUTO_INCREMENT,\
             code VARCHAR(10) NOT NULL UNIQUE,\
             qty INT NOT NULL CHECK (`qty` BETWEEN 0 AND 10),\
             ref_id INT UNSIGNED,\
             PRIMARY KEY(id),\
             FOREIGN KEY(ref_id) REFERENCES u(id))",
        )
        .unwrap();

        // --- CHECK: look up auto name, drop, re-add wider via MODIFY ---
        let checks: Vec<String> = conn
            .query(
                "SELECT cc.CONSTRAINT_NAME FROM information_schema.CHECK_CONSTRAINTS cc \
                 JOIN information_schema.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA \
                 AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME \
                 WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.TABLE_NAME = 'u' \
                 AND cc.CHECK_CLAUSE LIKE '%`qty`%'",
            )
            .unwrap();
        assert_eq!(checks.len(), 1, "one auto-named check expected");
        conn.query_drop(format!("ALTER TABLE `u` DROP CHECK `{}`", checks[0]))
            .unwrap();
        conn.query_drop("ALTER TABLE `u` MODIFY `qty` INT NOT NULL CHECK (`qty` BETWEEN 0 AND 500)")
            .unwrap();
        // widened range must actually be accepted now
        conn.query_drop("INSERT INTO u (code, qty) VALUES ('a', 400)").unwrap();
        let n: Vec<u32> = conn
            .query(
                "SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS cc \
                 JOIN information_schema.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA \
                 AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME \
                 WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.TABLE_NAME = 'u' \
                 AND cc.CHECK_CLAUSE LIKE '%`qty`%'",
            )
            .unwrap();
        assert_eq!(n[0], 1, "checks must not accumulate");

        // --- UNIQUE: find the single-column unique index and drop it ---
        let idx: Vec<String> = conn
            .query(
                "SELECT INDEX_NAME FROM information_schema.STATISTICS \
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'u' \
                 AND NON_UNIQUE = 0 AND INDEX_NAME <> 'PRIMARY' \
                 GROUP BY INDEX_NAME HAVING COUNT(*) = 1 AND MAX(COLUMN_NAME) = 'code'",
            )
            .unwrap();
        assert_eq!(idx.len(), 1, "one unique index on code expected");
        conn.query_drop(format!("ALTER TABLE `u` DROP INDEX `{}`", idx[0])).unwrap();
        conn.query_drop("ALTER TABLE `u` MODIFY `code` VARCHAR(10) NOT NULL").unwrap();
        conn.query_drop("INSERT INTO u (code, qty) VALUES ('a', 1)").unwrap(); // duplicate now fine

        // --- FK: find the constraint name and drop it ---
        let fks: Vec<String> = conn
            .query(
                "SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE \
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'u' \
                 AND COLUMN_NAME = 'ref_id' AND REFERENCED_TABLE_NAME IS NOT NULL",
            )
            .unwrap();
        assert_eq!(fks.len(), 1, "one FK on ref_id expected");
        conn.query_drop(format!("ALTER TABLE `u` DROP FOREIGN KEY `{}`", fks[0])).unwrap();

        // --- PK on a fresh table via ADD then ADD PRIMARY KEY ---
        conn.query_drop("CREATE TABLE nopk (a INT)").unwrap();
        conn.query_drop("ALTER TABLE `nopk` ADD `id` INT UNSIGNED NOT NULL").unwrap();
        conn.query_drop("ALTER TABLE `nopk` ADD PRIMARY KEY(`id`)").unwrap();

        // --- self-referential FK-by-name: reading the INSERT's own target
        // table needs the derived-table wrap (bare subquery = error 1093) ---
        conn.query_drop(
            "INSERT INTO u (code, qty, ref_id) VALUES ('self', 1, \
             (SELECT id FROM (SELECT id FROM u WHERE id = 1) AS `_lookup`))",
        )
        .unwrap();

        // --- batch semantics: one connection so USE persists; stops at the
        // first failure and reports how far it got ---
        {
            let mut bconn = pool.get_conn().unwrap();
            let good: Vec<String> = vec![
                "CREATE DATABASE batchdb".into(),
                "USE batchdb".into(),
                "CREATE TABLE b (id INT PRIMARY KEY)".into(),
                "INSERT INTO b VALUES (1),(2)".into(),
            ];
            let (applied, err) = run_batch(&mut bconn, &good);
            assert_eq!((applied, err), (4, None), "clean batch applies fully");
            let bad: Vec<String> = vec![
                "INSERT INTO b VALUES (3)".into(),
                "INSERT INTO nope VALUES (1)".into(),
                "INSERT INTO b VALUES (4)".into(),
            ];
            let (applied, err) = run_batch(&mut bconn, &bad);
            assert_eq!(applied, 1, "stops at the first failure");
            assert!(err.unwrap().contains("1146"), "reports the failing error");
            let n: Vec<u32> = bconn.query("SELECT COUNT(*) FROM b").unwrap();
            assert_eq!(n[0], 3, "statement after the failure did NOT run");
        }

        // --- date/time defaults, exactly as the designer emits them:
        // CURRENT_TIMESTAMP bare; CURDATE/CURTIME as (expression) defaults ---
        conn.query_drop(
            "CREATE TABLE dt (\
             d DATE NOT NULL DEFAULT (CURDATE()),\
             tm TIME DEFAULT (CURTIME()),\
             ts DATETIME DEFAULT CURRENT_TIMESTAMP)",
        )
        .unwrap();
        conn.query_drop("ALTER TABLE `dt` MODIFY `d` DATE NOT NULL DEFAULT (CURDATE())")
            .unwrap();
        conn.query_drop("INSERT INTO dt () VALUES ()").unwrap();

        // pin HOW MySQL echoes defaults — the JS diff canonicalizer (canonDef/
        // canonType in tables-designer.js) relies on exactly these spellings;
        // if an engine upgrade changes them, this must fail loudly
        conn.query_drop("CREATE TABLE spell (ok BOOLEAN NOT NULL DEFAULT TRUE, p DECIMAL(4,2) DEFAULT 3.50)")
            .unwrap();
        let sc: Vec<(String, String)> = conn.query("SHOW CREATE TABLE spell").unwrap();
        let ddl = &sc[0].1;
        assert!(ddl.contains("tinyint(1)"), "BOOLEAN echoes as tinyint(1): {ddl}");
        assert!(ddl.contains("DEFAULT '1'"), "TRUE echoes as '1': {ddl}");
        assert!(ddl.contains("DEFAULT '3.50'"), "decimal default echoes quoted: {ddl}");
        let sc2: Vec<(String, String)> = conn.query("SHOW CREATE TABLE dt").unwrap();
        assert!(sc2[0].1.contains("DEFAULT (curdate())"), "expression default echoes lowercase in parens: {}", sc2[0].1);

        // --- the data.sql replay shape: FK checks suspended on ONE
        // connection lets a self-reference to a HIGHER id rebuild ---
        conn.query_drop("CREATE DATABASE replaydb").unwrap();
        conn.query_drop("USE replaydb").unwrap();
        conn.query_drop(
            "CREATE TABLE member (id INT UNSIGNED NOT NULL AUTO_INCREMENT, \
             invited_by INT UNSIGNED, PRIMARY KEY(id), \
             FOREIGN KEY(invited_by) REFERENCES member(id))",
        )
        .unwrap();
        let replay = [
            "SET FOREIGN_KEY_CHECKS = 0",
            "INSERT INTO `member` (`id`, `invited_by`) VALUES (1, 3), (2, 1), (3, NULL)",
            "SET FOREIGN_KEY_CHECKS = 1",
        ];
        let (applied, err) = run_batch(
            &mut conn,
            &replay.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        );
        assert_eq!((applied, err), (3, None), "forward-referencing self-FK replays");
        let inv: Vec<Option<u32>> = conn
            .query("SELECT invited_by FROM member ORDER BY id")
            .unwrap();
        assert_eq!(inv, vec![Some(3), Some(1), None]);
        // and the checks are really back on afterwards
        assert!(conn
            .query_drop("INSERT INTO member (invited_by) VALUES (999)")
            .is_err());

        drop(conn);
        let mut e = Engine { child: Some(child), port, pool: Some(pool), lock_path: None };
        e.shutdown();
        let _ = std::fs::remove_dir_all(&td);
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
            lock_path: None,
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

/// Grab a cheap Pool handle and RELEASE the engine lock before touching the
/// database — a slow query must not block db_status or a shutdown request.
fn pool_handle(state: &tauri::State<'_, EngineState>) -> Result<Pool, String> {
    let eng = state.0.lock().map_err(|e| e.to_string())?;
    eng.pool.clone().ok_or_else(|| "engine not running".to_string())
}

#[tauri::command]
pub async fn db_exec(
    state: tauri::State<'_, EngineState>,
    sql: String,
    db: Option<String>,
) -> Result<ExecResult, String> {
    let pool = pool_handle(&state)?;
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

#[derive(Serialize)]
pub struct BatchResult {
    pub applied: usize,
    pub error: Option<String>,
    pub elapsed_ms: u128,
}

/// Run many statements on ONE connection (so `USE` persists across them) with
/// a single IPC round-trip — imports and file-seeds would otherwise pay per
/// statement. Stops at the first failure; `applied` says how far it got.
#[tauri::command]
pub async fn db_exec_batch(
    state: tauri::State<'_, EngineState>,
    stmts: Vec<String>,
    db: Option<String>,
) -> Result<BatchResult, String> {
    let pool = pool_handle(&state)?;
    let mut conn = pool.get_conn().map_err(|e| e.to_string())?;
    if let Some(db) = db {
        let ident = db.replace('`', "");
        if !ident.is_empty() {
            conn.query_drop(format!("USE `{ident}`"))
                .map_err(|e| e.to_string())?;
        }
    }
    let start = Instant::now();
    let (applied, error) = run_batch(&mut conn, &stmts);
    Ok(BatchResult {
        applied,
        error,
        elapsed_ms: start.elapsed().as_millis(),
    })
}

/// sequential batch on one connection: stops at the first failure,
/// reports how far it got
fn run_batch(conn: &mut mysql::PooledConn, stmts: &[String]) -> (usize, Option<String>) {
    let mut applied = 0usize;
    for stmt in stmts {
        // query_iter so multi-result statements drain cleanly
        match conn.query_iter(stmt) {
            Ok(r) => {
                drop(r);
                applied += 1;
            }
            Err(e) => return (applied, Some(e.to_string())),
        }
    }
    (applied, None)
}
