# SQL Studio IDE — Master Plan

*The plan for turning the single-file SQL Studio into an installable Windows IDE.
Written overnight 2026-07-11 → 12, after the brainstorm + question session with Ben.
The single-file `sql-studio.html` stays alive as the "lite" web version; the IDE
lives in `app/` in this same repo.*

> **Historical document.** This is the original design rationale — read it for the
> WHY. For the architecture as actually built, `CLAUDE.md`; for what's fixed and
> what's still open, `AUDIT.md` (its STATUS section is the live work queue).
> Phases P0–P7 shipped (with design pivots: CREATE/ALTER became the live tables
> designer, the overview became the pan/zoom canvas, data.sql became a snapshot);
> P8 (error hints, tour, icons, installer) and P9 (external deploy) remain.

---

## 1. What this is

**A MySQL creation tool for people who don't want to learn MySQL.**
Software developers who need a backend, students, tinkerers. Every concept in the
app must be operable two ways at once: the **intuitive way** (builder, canvas,
spreadsheet) and the **real way** (SQL files you can read and type into) — and the
two must never disagree.

### Product principles (in priority order)
1. **Fast.** Startup in well under a second, every interaction instant. This kills
   Electron and anything JVM. No loading spinners for local work, ever.
2. **Intuitive.** The v2 builder's "thinks like you" model is the soul of the app.
3. **Nothing SQL can do that this can't.** The files are plain SQL; the escape
   hatch is always just typing.
4. **Offline.** No network needed for anything except (optionally) connecting to
   the user's own external server.
5. **Trustworthy.** It edits the user's files and database — reliability of the
   apply-pipeline beats every feature.

---

## 2. Locked decisions (from the question session)

| Decision | Choice |
|---|---|
| Shell / stack | **Tauri 2** (Rust host + system webview). Keeps the whole v2 builder codebase, starts in ms, real .exe installer |
| SQL engine | **Bundled portable MySQL Community Server** (authentic dialect — Ben explicitly rejected defaulting to MariaDB, which was only a school coincidence) behind an **engine-adapter layer** so the engine is swappable config, not an assumption. P2 ends with a measured evaluation checkpoint; a swap would be recorded here as a reasoned decision. Plus optional connection to any real MySQL/MariaDB server later |
| Project files | `schema.sql` (truth, edited in place) · `data.sql` (seed inserts) · `journal.sql` (auto-log of applied changes, replayable) · `queries/*.sql` (saved selects = tabs) |
| Data grid | **Editable spreadsheet** — cell edit = UPDATE, new row = INSERT, delete = DELETE (destructive ops confirm) |
| Sync model | **Live: the project IS the database.** Builder action or manual file edit → schema.sql updated → sandbox altered instantly → journal appended. Destructive changes always confirm |
| Layout | Left: file/tab editor · Right: the builder · Bottom: execution console with pretty result tables · Canvas: database diagram view, click table → grid |
| Design | The Swiss-minimal system from v2 carries over unchanged (Ben likes it) — hairline rules, one red accent, black SQL panels |
| Language toggle | The **Natural ↔ SQL** view switch (abstracted wording vs. fillable statement skeleton) carries into the IDE: quick switch in the UI + persistent preference in Settings |

---

## 3. Architecture

```
┌────────────────────────────────────────────────────────────┐
│ Tauri window (Rust host)                                   │
│                                                            │
│  Rust side                        Web side (one SPA)       │
│  ─────────                        ────────────────────     │
│  · process manager: starts/stops  · v2 builder (ported)    │
│    the engine per project         · editor (CodeMirror 6)  │
│  · mysql client (rust `mysql`     · tabs & file UI         │
│    crate) → sandbox / external    · results console        │
│  · fs: read/write/watch project   · canvas (DOM+SVG)       │
│  · tauri commands (IPC)           · data grid              │
│                                   · sync engine (JS)       │
└────────────────────────────────────────────────────────────┘
```

### 3.1 The sandbox engine
- Ship a **stripped portable MySQL** (mysqld.exe + minimal share/,
  ~80–150 MB unpacked) as a Tauri *resource*.
- One engine process per open project, started by Rust on project open:
  `--datadir=<project>/.sqlstudio/db --port=<random free 127.0.0.1 port>
  --skip-networking=0 --bind-address=127.0.0.1 --skip-grant-tables` (local
  sandbox; no credentials friction — it is the user's own machine and data).
- **Durable datadir inside the project folder** → copying the folder clones the
  whole database, opening is instant (no re-import), and `schema.sql`/`data.sql`
  stay the human-readable truth. `.sqlstudio/` also holds app state (open tabs,
  canvas positions) and is `.gitignore`-suggested.
- Clean shutdown on project close/app exit; on crash, the engine recovers its own
  datadir (InnoDB does this natively). Stale-pid/port handling on open.
- Rust exposes: `db_start(project)`, `db_stop()`, `db_exec(sql) → {columns,
  rows, affected, error{message, position}}`, `db_ping()`.

### 3.2 The sync engine — "apply, don't copy" (the core rework)
The heart of the app. One JS module owns the pipeline; everything funnels
through it. Two directions:

**Builder → world** (user acts in the builder):
1. Builder produces an *intent* (e.g. `renameColumn(book, name → title)`).
2. Sync engine renders three artifacts from the intent:
   - **file edit**: `schema.sql` regenerated *for that table only* (surgical
     replacement of the table's CREATE block, preserving user formatting
     elsewhere in the file),
   - **DB statements**: the real `ALTER TABLE …` (reusing v2's
     `computeAlterOps` machinery),
   - **journal entry**: the executed statements + timestamp appended to
     `journal.sql`.
3. Destructive intents (drop column/table with data, type narrowing) show the
   confirm dialog *before* anything is touched. Then all three artifacts commit
   together; if the DB rejects the statement, the file edit is rolled back and
   the error is shown at the exact position — **no partial states.**

**Files → world** (user types in schema.sql):
1. Debounced parse (the v2 `parseSchema`, which already applies ALTERs).
2. Diff old model ↔ new model (the v2 ALTER-diff generalized to whole-schema:
   added/dropped/renamed tables & columns, type changes, key changes).
3. Rename ambiguity (drop+add vs rename) resolved by a small inline prompt only
   when data would be lost otherwise.
4. Same confirm-then-apply-then-journal pipeline.

`data.sql` = **seed data**, written by the builder's INSERT mode (and executed).
Grid edits execute + journal but do *not* rewrite data.sql; an explicit
**“Snapshot data → data.sql”** action regenerates the seed from the live DB.
This keeps one clear rule: *files describe the reproducible project; the journal
describes its history; the DB is the living instance.*

### 3.3 Porting the v2 builder
- Extract the four script blocks of `sql-studio.html` into modules
  (`parser.js`, `sqlgen.js`, `builder.js`) with **zero behavior change** —
  the regression suite runs against the extracted modules to prove it.
- Replace every "copy SQL" endpoint with sync-engine intents:
  - CREATE mode → writes table blocks into schema.sql (+ CREATE in DB),
  - ALTER designer → intents (already diff-based — perfect fit),
  - INSERT → appends to data.sql + executes,
  - UPDATE/DELETE → execute + journal (with affected-row count preview),
  - SELECT → **Run** button → results console.
- The builder's schema always comes from the sync engine's live model —
  the "upload your schema" step disappears entirely inside the IDE.

### 3.4 UI composition
- **Left: editor pane.** Tabs: `schema.sql`, `data.sql`, `journal.sql`
  (read-only tail-view), plus one tab per saved query. CodeMirror 6 with our
  SQL highlighting theme; the builder↔SQL hover-link carries over where cheap.
- **Right: builder pane** (collapsible). Modes contextual to active tab: on a
  query tab you get SELECT; on schema.sql you get CREATE/ALTER; INSERT/UPDATE/
  DELETE always reachable.
- **Bottom: console.** Every execution logged as a card: the statement (grey,
  collapsible), then either a **result grid** (virtualized, sortable client-
  side, copy as CSV) or an ok/affected-rows line, or a red error card with
  MySQL's message translated to a human hint where we can (duplicate key, FK
  violation, syntax position highlighted in the editor).
- **Canvas** (main-area tab “Database”): tables as cards (name + columns +
  key badges), FK lines as SVG paths, pan/zoom, auto-layout with saved manual
  positions. Click table → opens its **grid tab**.
- **Grid tab:** virtualized rows (fast at 100k+), inline cell editing, `+` row,
  multi-row delete, NULL styling, FK cells show the looked-up display column
  with the raw id on hover (the FK-by-name idea, inverted for reading).
- **Status bar:** sandbox state (● running · port), current project, dialect.

### 3.5 Connect to a real server (phase-late)
- Connection manager (host/port/user/password, stored in Windows Credential
  Manager via Tauri plugin — never plaintext).
- Two operations only, both explicit: **Deploy** (replay journal from a marked
  checkpoint, or push full schema+data dump to an empty database) and
  **Query against server** (run the current query tab remotely; results marked
  as remote). No live-sync against production — deliberate safety line.

---

## 4. Repo & build layout

```
sql-studio/
├─ sql-studio.html          ← the lite single-file tool (unchanged, kept)
├─ versions/                ← frozen snapshots
├─ app/                     ← THE IDE
│  ├─ src/                  ← web frontend (Vite + vanilla JS modules)
│  │  ├─ core/parser.js     ← extracted from v2 (shared, tested)
│  │  ├─ core/sqlgen.js     ←   "
│  │  ├─ core/sync.js       ← the apply pipeline
│  │  ├─ ui/…               ← builder port, editor, console, canvas, grid
│  ├─ src-tauri/            ← Rust host
│  │  ├─ src/main.rs, db.rs, project.rs
│  │  ├─ resources/engine/ ← stripped portable engine (not committed;
│  │  │                        fetched by scripts/fetch-engine)
│  │  └─ tauri.conf.json
│  └─ package.json
└─ PLAN.md                  ← this file
```

- The lite tool keeps its no-build rule. The app uses Vite + npm — normal for a
  shipped product; CLAUDE.md gets updated to describe both worlds.
- Engine binaries are **not** committed (size + license hygiene); a fetch
  script downloads + strips them into resources at build time. MySQL Community is GPL —
  fine alongside our repo; we ship it unmodified as a separate process.
- Installer: `tauri build` → NSIS .exe installer. App name **SQL Studio**.

## 5. Build phases (each ends committed + verified)

| Phase | Deliverable | Verification |
|---|---|---|
| **P0** | Toolchain (Rust, Node) installed; Tauri app scaffolds, builds, opens an empty Swiss-styled window | `cargo tauri build` produces an exe that launches |
| **P1** | Project manager (create/open recent), file set scaffolding, editor pane with tabs + CodeMirror + SQL theme, files load/save | open project → edit schema.sql → saved to disk |
| **P2** | Sandbox engine: fetch-script, process manager, db_exec IPC; console executes typed SQL and renders result grids | run `SELECT 1`; create table via console; restart survives |
| **P3** | Core modules extracted from v2 + regression suite green against them; builder pane ported and rendering | suite passes on extracted modules; builder visible & clicking |
| **P4** | **Sync engine**: builder intents → file edit + DB + journal, atomically; file-edit diffing → confirm → apply; destructive confirms | scripted end-to-end: rename column via builder → file/db/journal all correct; type same rename in file → no-op |
| **P5** | SELECT Run→console; INSERT→data.sql+exec; UPDATE/DELETE with row-count preview | each mode round-trips against sandbox |
| **P6** | Data grid (virtualized, editable) wired to sandbox | edit cell → UPDATE visible in journal + re-query |
| **P7** | Canvas: diagram, FK lines, pan/zoom, click-through to grid | renders demo library; positions persist |
| **P8** | Error handling polish (position-mapped errors, human hints), onboarding tour, installer build, icons | fresh-machine install test |
| **P9** | Connect-to-server (deploy + remote query) | against a local “real” MariaDB acting as prod |

Phases P0–P2 are infrastructure; the product becomes *feelable* at P4–P5.
Order chosen so every phase leaves a runnable, committable app.

## 6. Risks & mitigations
- **Toolchain install on Ben's machine** (Rust ~1.5 GB, MSVC build tools):
  winget-scripted; if MSVC linker missing, install VS Build Tools component.
  Longest unattended step — done first, overnight.
- **Antivirus vs mysqld.exe** spawned from AppData: documented; installer
  puts resources under Program Files which is friendlier.
- **Port collisions / zombie engine processes:** random free port + pidfile in
  `.sqlstudio/`, health-check + reclaim on open.
- **Schema file edited while app closed:** on open, parse + diff against DB
  schema, present reconciliation (apply file → DB, the file is truth).
- **Webview2 runtime:** ships with Win 10/11 practically always; installer can
  bootstrap it if missing.
- **CodeMirror/canvas perf:** virtualized grid mandatory; canvas uses CSS
  transforms (no re-layout on pan).

## 7. Open micro-decisions (my picks, changeable)
- Journal format: plain SQL with `-- @applied 2026-07-12T02:14 (builder: rename column)` comment headers — readable AND replayable.
- Query tab files live as real files in `queries/` named after the tab.
- Bundled engine: MySQL Community 8.4 LTS portable win64, stripped; adapter interface keeps MariaDB or others pluggable.
- The lite web tool gains nothing new for now; it's feature-frozen at v2 until the IDE stabilizes, then interesting bits can flow back.
