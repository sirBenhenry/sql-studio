# AUDIT.md — full findings pass (2026-07-12)

A complete read of the IDE (`app/src/*`, `app/src-tauri/src/*`, shell, styles, scripts)
plus the extraction/parser surface it depends on. Ranked by severity. Baseline:
all five JS suites + both cargo tests green before and after this audit.

## STATUS after the implementation pass (same day, commits 2351e7c…)

**FIXED — Severity 1: all nine.**
#1 parser captures DEFAULT/UNIQUE/CHECK/cascades + raw KEY/CHECK passthrough
(`extras`), designer round-trip lossless · #2 data.sql is a live snapshot
(dependency-ordered dump after every journaled change; journal replay made
unnecessary) · #3 renames re-point FK refTable/refCol + KEY lines · #4 partial
commits re-sync schema.sql from SHOW CREATE TABLE · #5 CHECK/UNIQUE drop-then-
re-add via information_schema (real-engine cargo test) · #6 PK flag gated +
ADD PRIMARY KEY emitted · #7 canvas pans by background-drag, reset-layout
button · #8 debris datadir cleared before initialize · #9 studio.lock +
mysqld-verified reclaim.

**FIXED — lower severity:** #11 (FK removal, self-FK), #16 (grid blur commits,
Escape cancels, no-change no-op), #18 (console ↑/↓ history), #22 (new cards
placed below saved ones; stale positions pruned on save), #23 (askDbName
listener leak), #24 (splitter text-selection).

**STILL OPEN:** #10 (typing in schema.sql → DB diff — the missing P4 half),
#12 (unsaved-changes guard on close), #13 (currentDb fragility), #14 (dead
code cleanup), #15 (import-a-dump), #17 (grid: empty-string vs NULL,
pagination, sort/filter, console echo), #19 (builder Apply success feedback),
#20/#21 (human error hints — P8), #25–#28 (perf/robustness niceties).

---

Fixed during the audit itself (commit 742d93d):
- stale builder empty-state text pointed to the removed CREATE tab (`builder-shim.js`)
- the grid now respects the Settings row limit instead of a hardcoded 500 (`grid.js`, `main.js`)

---

## Severity 1 — broken logic (data loss or corruption paths)

### 1. Any designer commit strips DEFAULT / UNIQUE / CHECK / FK cascades from schema.sql — for EVERY table
The parser model (`app/src/core/parser.js:9`) captures only
`{name,type,numeric,boolean,unsigned,pk,notNull,autoInc}` — no DEFAULT, no UNIQUE,
no CHECK, no FK `ON UPDATE/ON DELETE`. The designer builds its model from that
(`tables-designer.js modelFromSchema`, seeds `uq:false, def:'', chk:''`), and every
commit regenerates **all** table blocks via `writeSchemaFromModel` (`main.js:290`).
Net effect: touch anything in the designer and every hand-written or previously
committed DEFAULT/UNIQUE/CHECK/cascade vanishes from schema.sql. The live DB keeps
them — until the next rebuild-from-file, which then loses them permanently.
Also immediate DB-side loss: renaming a column that has a DEFAULT emits
`CHANGE` without the DEFAULT clause, dropping it right away (CHANGE replaces the
whole column definition).
**Fix direction:** either teach the parser to capture these (lite-tool change →
extraction ripple, but it is *the* fix), or stop regenerating untouched tables —
splice only changed blocks, keeping original text for the rest.

### 2. Rebuild-from-files silently loses all grid work (journal is never replayed)
Grid INSERT/UPDATE/DELETE are journaled only (`grid.js` hooks); `data.sql` receives
builder inserts only. `reconcile()` (`main.js:556`) rebuilds a fresh sandbox from
schema.sql + data.sql and **never replays journal.sql**. Copy the project without
`.sqlstudio/` (or lose the datadir) → every grid edit is gone even though the
journal recorded it. The plan's "Snapshot data → data.sql" feature was never built.
**Fix direction:** replay journal.sql after data.sql on fresh rebuild, and/or
implement the data snapshot command.

### 3. Renaming a table corrupts other tables' FK references in schema.sql
MySQL updates dependents' FKs on `RENAME TO`, but the designer model does not:
other tables' `fk.refTable` still holds the old name, and `writeSchemaFromModel`
writes `REFERENCES old_name` into schema.sql → the file no longer rebuilds
(errno 1824). **Fix:** after a rename commit, walk the model and rewrite matching
`refTable` values before regenerating.

### 4. A partially-failed designer commit leaves file ↔ DB drift
`commit()` (`tables-designer.js:161`) sends the whole diff as one script. If
statement N fails, 1…N-1 are applied + journaled "(partial)", but `writeSchema`
never runs and `reload()` re-renders from the now-stale file. The next commit
diffs against a reality that no longer exists (e.g. a rename applied in the DB but
absent from the file → the re-emitted `CHANGE` fails). **Fix direction:** on
partial failure, fold the succeeded statements into the model/file before
reloading (or re-derive the block from `SHOW CREATE TABLE`).

### 5. CHECK ranges and UNIQUE are one-way toggles against a real MySQL
- Every min/max edit emits `MODIFY … CHECK (…)` — MySQL adds a **new** auto-named
  constraint each time and keeps the old ones, so constraints accumulate and a
  range can never be widened (the old CHECK still enforces).
- Unchecking UNIQUE emits `MODIFY` without UNIQUE, which does **not** drop the
  unique index — the toggle appears to work and does nothing.
(`tables-designer.js colDDL` + `computeDiff`; note test-designer mocks `runScript`,
so real-engine acceptance of these flows is untested.)
**Fix direction:** query `information_schema` for existing CHECK/index names and
emit `DROP CONSTRAINT`/`DROP INDEX` first.

### 6. PK flag on a new column of an existing table is silently ignored
The options row offers PK for any uncommitted column (`tables-designer.js:289`),
but the ALTER path emits `ADD ` + `colDDL(c)` and `colDDL` never emits PRIMARY KEY
(only `createTableDDL` does, for whole new tables). The flag is dropped without a
word. **Fix:** emit `ADD PRIMARY KEY (…)` (guarding the table-already-has-one
case) or hide the flag outside new tables.

### 7. The canvas view clips — cards can become unreachable
`#view-host` is `overflow-x: hidden` (`styles.css:297`, the no-sideways-scroll
product rule), but the canvas stage grows by ~320px per dependency layer and cards
are draggable to any x. A schema 3+ layers deep (or one careless drag) puts cards
where they can never be seen or grabbed again. **Fix:** pan by dragging the canvas
background (keeps the no-scrollbar rule), plus a "reset layout" button.

### 8. An interrupted engine initialization bricks the project
`db_start` (`engine.rs:230`) picks initialize-vs-reclaim by `mysql.ibd` existing.
If `--initialize-insecure` was interrupted, the datadir exists *without* mysql.ibd
→ every subsequent start re-runs initialize on a non-empty dir, which mysqld
refuses — permanently, until the user hand-deletes `.sqlstudio/db`. **Fix:** treat
missing-`mysql.ibd`-but-non-empty as debris and wipe the dir before initializing.

### 9. A second app instance on the same project kills the first one's engine
`reclaim_stale_engine` (`engine.rs:201`) taskkills whatever PID the pidfile names —
including the **live** engine of another SQL Studio window, corrupting its session.
There is no single-instance/project-lock guard, and PID-reuse makes a blind
`taskkill /F` slightly risky. **Fix:** verify the PID is a mysqld under
`.sqlstudio` before killing; add a project lockfile.

---

## Severity 2 — design holes

10. **Typing in schema.sql never reaches the database.** Editor input feeds the
    builder model (600ms debounce, `main.js:403`) but no ALTER diff is computed
    against the DB, and the file isn't even saved until Ctrl+S. On existing
    projects, editing schema.sql affects the DB *never* (reconcile only builds
    fresh sandboxes). The "file and DB never drift" promise currently holds only
    for designer/builder/grid paths. This is the missing half of P4.
11. **FK lifecycle is incomplete:** removal impossible (needs the constraint name
    from information_schema), self-referencing FKs impossible (the dropdown
    excludes the column's own table, `tables-designer.js:325`), composite FK/PK
    not representable.
12. **No unsaved-changes guard.** Dirty tabs live only in memory; closing the app
    or opening another project discards them silently.
13. **currentDb fragility.** If the schema.sql header names a DB that doesn't
    exist in the sandbox (hand-edit), every statement fails "Unknown database"
    with no recovery hint; console `USE nodb` sets currentDb without validating
    (`main.js:458`); identifiers are `[\w$]+` only.
14. **Dead code:** `appendSchema` hook (`main.js:679`) has no caller since
    CREATE/ALTER left the builder; `overview.js` is superseded but still in the
    tree; localStorage key `sqlstudio.lang` is written but never read.
15. **Import-a-dump** (requested as a Settings feature) does not exist yet.

---

## Severity 3 — pain points / UX

16. **Grid: blur cancels a cell edit** (`grid.js:117`) — the opposite of the
    designer's blur-commits rule and of every spreadsheet; a typed value is
    silently lost unless Enter is pressed.
17. Grid: `''` becomes NULL (no way to store an empty string, `grid.js:27`); no
    pagination past the row limit; no sort/filter; successful grid statements
    never echo in the console (the exec hook logs errors only).
18. Console: single-line input — no multiline, no ↑ history.
19. Builder Apply: no success feedback in the pane itself, and a second click
    happily re-runs the INSERT (duplicate rows + duplicate data.sql lines).
20. Designer error UX: AUTO_INCREMENT without a key (errno 1075), dropping a
    referenced table (errno 3730) → raw server text and a full revert, no human
    hint (P8 material).
21. Query tabs: no rename/delete; closing one hides it until reopen (file stays);
    names are always query1/2/….
22. Canvas: newly created tables auto-place without regard to saved positions
    (can overlap dragged cards); positions of dropped tables are never pruned.
23. `askDbName` modal: no cancel path, Escape does nothing, and the Enter
    listener re-registers on each call (harmless leak today, `main.js:529`).
24. Splitter drag doesn't `preventDefault()` → selects text while resizing; no
    double-click-to-reset (`main.js:709`).
25. Large scripts run one IPC round-trip per statement — a big data.sql import
    will crawl. Batch execution (or server-side splitting) before the import
    feature lands.
26. `db_exec` holds the engine mutex for the whole query (`engine.rs:388`) — one
    slow query blocks all other IPC including `db_status`.
27. journal tab: whole-text re-render per append; fine now, slow on long-lived
    projects.
28. `"csp": null` in tauri.conf.json — acceptable offline, tighten for release
    (P8).

---

## Suggested attack order

1. Parser captures DEFAULT/UNIQUE/CHECK/cascades (#1) — unlocks honest round-trips;
   everything designer-related stands on this.
2. Journal replay on rebuild or data snapshot (#2).
3. Rename→FK rewrite (#3) + partial-commit reconciliation (#4) — same code area.
4. Canvas panning (#7) + engine hardening (#8, #9) — small, isolated.
5. CHECK/UNIQUE lifecycle (#5), PK-on-ALTER (#6), FK removal (#11) — one
   information_schema helper in Rust serves all three.
6. Grid blur-commits (#16) and console history (#18) — quick UX wins.
