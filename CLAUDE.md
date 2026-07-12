# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**SQL Studio** — a visual, "Lego-style" MySQL tool. The repo holds **two worlds**:

1. **The lite tool** (`sql-studio.html`) — a single self-contained HTML file. Everything (HTML, CSS, all JavaScript, demo database) is inlined. Runs fully offline by opening in a browser: **no build step, no bundler, no dependencies**. Do not add a build system or split it into modules — `file://` forbids ES modules/CORS; the single-file plain-`<script>` design is intentional. **This file is the source of truth for the parser/generator/builder logic** consumed by the IDE.
2. **The IDE** (`app/`) — a Tauri 2 Windows app (Rust host + webview) where a project folder IS a live database: bundled portable MySQL sandbox per project, `schema.sql`/`data.sql`/`journal.sql`/`queries/`, live tables designer, data grids, builder pane, console. Architecture rationale: `PLAN.md`; setup: `app/SETUP.md`.

`versions/vN/` holds frozen snapshots of the lite tool (v2 = the current frozen state); the root `sql-studio.html` is the working build. The lite tool is feature-frozen while the IDE is built — fixes only.

## The extraction contract (critical)

The IDE **never forks** the builder logic. `app/scripts/extract-core.mjs` copies the lite tool's script blocks **verbatim** into `app/src/core/` (`demo.js`, `parser.js`, `sqlgen.js`) plus the whole file as `core/builder.html` (embedded as an iframe by `app/src/builder-shim.js`, which adapts it entirely from the outside — hides chrome, rewords empty-states, adds the action bar, feeds schema). After ANY edit to `sql-studio.html`:

```bash
cd app && node scripts/extract-core.mjs && node scripts/test-core.mjs && node scripts/test-shim.mjs
```

Never hand-edit `app/src/core/*` — the drift gate fails byte-identical comparison.

## IDE development (`app/`)

- Dev loop: `cd app && npx tauri dev`. Debug exe: `npx tauri build --debug --no-bundle` → `src-tauri/target/debug/app.exe`. Installer: `npx tauri build`.
- **Before rebuilding, kill the running app** (the exe lock fails the build): stop `app.exe` processes whose path contains `sql-studio`.
- The bundled engine is NOT committed: `node scripts/fetch-engine.mjs` downloads MySQL Community and strips it (~90 MB incl. required bin DLLs — mysqld dies with 0xC0000135 without them) into `src-tauri/resources/engine/`.
- JS tests (jsdom, in `app/scripts/`): `test-core.mjs` (drift gate), `test-sync.mjs` (statement splitter/journal), `test-shim.mjs` (builder embedding flows), `test-grid.mjs` (data grid SQL shapes), `test-designer.mjs` (tables-designer semi-live diffs). Run each with plain `node`.
- Rust tests: `cd src-tauri && cargo test --lib` — real engine round-trip + datadir-persistence-across-restarts (needs fetched engine).

### IDE architecture

- **Frontend** is plain ES modules served from `app/src`, no bundler. `main.js` (bootstrap, settings, file tabs, console, sync glue), `sync.js` (pure helpers: `splitSQL` — string/comment-aware statement splitter, `findCurrentDb`, `journalEntry`), `builder-shim.js` (iframe adapter), `tables-designer.js` (live schema editing), `canvas-view.js` (FK diagram), `grid.js` (editable spreadsheet). The core modules load as plain scripts (`window.parseSchema`, `window.SqlGen`) before `main.js`.
- **Rust**: `project.rs` (project folder = guarded file set; only schema/data/journal/queries paths writable), `engine.rs` (engine-adapter around bundled `mysqld`: per-project datadir in `<project>/.sqlstudio/db`, free localhost port, `--initialize-insecure`, SHUTDOWN-then-kill on close).
- **Sync model ("apply, don't copy")**: every applied change executes on the sandbox AND lands in the files. `runScript` journals builder/designer actions to `journal.sql` (`-- @applied` stamps); INSERTs also append to `data.sql`; schema changes regenerate `schema.sql` (header `DROP/CREATE/USE <db>` preserved — the db name is chosen via modal on first open). Console input executes but is NOT journaled (ad-hoc).
- **The ⊞ database tab** has View (canvas: dependency-layered cards, FK bezier lines, draggable, positions persisted per project) and Edit (the designer). The designer commits **semi-live**: on focusout (250 ms debounce, focusin cancels); adding a column/table commits the previous edit first; drops confirm and commit immediately; diff-based so revert-before-blur emits nothing. The builder pane carries ONLY data modes (SELECT/INSERT/UPDATE/DELETE) — CREATE/ALTER live in the designer.

### Tauri gotchas (learned the hard way)

- **Commands must be `async`** — sync Tauri v2 commands run on the main/UI thread; a blocking `db_start` froze the whole window. State params then need explicit lifetimes: `tauri::State<'_, T>`.
- **Engines outlive crashes**: `Drop` isn't reliable on process exit. The `RunEvent::Exit` hook stops the engine; `reclaim_stale_engine()` kills the pidfile owner before starting on an existing datadir (an orphan holds the datadir lock and hangs the next start for 40 s).
- **`[hidden]` vs `display:grid`**: a CSS `display` on an element overrides the HTML `hidden` attribute — the app stylesheet has `[hidden]{display:none!important}` for this reason.
- No horizontal scrolling anywhere is a product rule: cells wrap, editors `pre-wrap`, panes clip x.

## Editing & running the lite tool

- Edit `sql-studio.html` directly; open in a browser to see it. Four `<script>` blocks in order: **(0)** inline demo SQL, **(1)** `parseSchema`, **(2)** `SqlGen`, **(3)** the app IIFE. They share top-level globals (`DEMO_SQL`, `window.parseSchema`, `window.SqlGen`).
- Verify headlessly with Node — syntax check:
  ```bash
  node -e "const fs=require('fs'),vm=require('vm');[...fs.readFileSync('sql-studio.html','utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach(m=>new vm.Script(m[1]));console.log('OK')"
  ```
- Full UI behavior: load into **jsdom** (`runScripts:'dangerously'`), dispatch `DOMContentLoaded`, drive the real DOM. Gotchas: define `window.requestAnimationFrame`; `scrollIntoView`/`getBoundingClientRect` are missing/empty — guard or mock. The tour auto-runs on first load (it sets no `selectstudio.toured`) — click `#tour-skip` first in tests.

## Lite-tool architecture (the big picture)

1. **`parseSchema(sqlText)`** (block 1) → `{ tables:[{name, columns:[{name,type,numeric,boolean,unsigned,pk,notNull,autoInc}], fks:[{col,refTable,refCol}]}], byName }`. Reads only `CREATE TABLE` structure (dumps with or without data), handles phpMyAdmin dumps, and **applies column-level `ALTER TABLE`** in document order via `applyAlterClause`. Dedupes double-declared FKs.

2. **`SqlGen`** (block 2) — generation is **segment-based**: each `generate*Segments()` returns `[{t:text, c:cssClass, p:partId}]`; `segmentsToText()` flattens to SQL; the shared `data-part` id powers two-way hover highlighting. Generators for SELECT/CREATE/INSERT/UPDATE/DELETE/ALTER. Shared helpers: `OPS`, `AGG_FNS` (incl. `COUNT_D` → `COUNT(DISTINCT …)`), `CALCS`, `pushLiteral`/`pushWhere`/`pushOp`, `pushLookup` (FK-by-name → scalar subquery), `pushSub` (mini-queries incl. correlated `cSame`), `SQL_FUNC_RE` (NOW()/CURDATE()… emitted unquoted), `highlightStatic` (also used by the IDE editor).

3. **App IIFE** (block 3) — state + UI. SELECT state `Q` renders as a clickable **sentence** (Natural) or **clause skeleton** (SQL mode) driven by the `LANG` toggle; the word bank opens **popovers** (`popCondition` = the one unified conditional with column/calculation sides, FK-by-name, mini-queries, inline grouping). INSERT/UPDATE/DELETE/ALTER/CREATE have their own state (`I`,`U`,`D`,`A`,`C`). State persists in `localStorage` (`selectstudio.*`).

## Conventions that bite

- **CSS variables:** the surface variable is `--bg`; there is **no `--card`** — an undefined var yields silently-transparent backgrounds (this shipped a real bug once). Design is Swiss-minimal: hairline rules, one red accent `--accent`, black SQL "poster" panels. Theme via `prefers-color-scheme`; the IDE adds `:root[data-theme=light|dark]` overrides that must outrank the media query.
- **Foreign keys** drive most smart behavior: join suggestions, FK-follow in the column picker, dependency-ordered CREATE, canvas layering, and FK type-sync (FK column type derives from its referenced column so `INT UNSIGNED` matches — avoids errno 150).
- **The principle:** anything expressible in SQL should be buildable here. Every abstraction was designed by walking through the user's mental model in scenarios — when a flow feels wrong to him, that's a bug, not preference.
