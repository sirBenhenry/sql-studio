# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**SQL Studio** — a visual, "Lego-style" MySQL tool. The repo holds **two worlds**:

1. **The lite tool** (`sql-studio.html`) — a single self-contained HTML file. Everything (HTML, CSS, all JavaScript, demo database) is inlined. Runs fully offline by opening in a browser: **no build step, no bundler, no dependencies**. Do not add a build system or split it into modules — `file://` forbids ES modules/CORS; the single-file plain-`<script>` design is intentional. **This file is the source of truth for the parser/generator/builder logic** consumed by the IDE.
2. **The IDE** (`app/`) — a Tauri 2 Windows app (Rust host + webview) where a project folder IS a live database: bundled portable MySQL sandbox per project, `schema.sql`/`data.sql`/`journal.sql`/`queries/`, live tables designer, data grids, builder pane, console. Architecture rationale: `PLAN.md`; setup: `app/SETUP.md`.

`versions/vN/` holds frozen snapshots of the lite tool (v2 = the current frozen state); the root `sql-studio.html` is the working build. The lite tool is feature-frozen while the IDE is built — fixes only (the parser has since gained additive fields for the IDE; that counts as a fix because the IDE consumes it).

**Where the work stands:** `PLAN.md` and `AUDIT.md` are both **completed, archival documents** — the plan was executed and every audit finding addressed; don't treat either as a work queue. New work comes from the user. `test_project_1`/`test_project_2` are the user's local test projects (gitignored); test 2 holds the "film club" schema (member/movie/screening) used for interactive debugging.

## The extraction contract (critical)

The IDE **never forks** the builder logic. `app/scripts/extract-core.mjs` copies the lite tool's script blocks **verbatim** into `app/src/core/` (`demo.js`, `parser.js`, `sqlgen.js`) plus the whole file as `core/builder.html` (embedded as an iframe by `app/src/builder-shim.js`, which adapts it entirely from the outside). After ANY edit to `sql-studio.html`:

```bash
cd app && node scripts/extract-core.mjs && node scripts/test-core.mjs && node scripts/test-shim.mjs
```

Never hand-edit `app/src/core/*` — the drift gate fails byte-identical comparison.

Verify the lite tool headlessly with Node — syntax check:
```bash
node -e "const fs=require('fs'),vm=require('vm');[...fs.readFileSync('sql-studio.html','utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach(m=>new vm.Script(m[1]));console.log('OK')"
```

## IDE development (`app/`)

- Dev loop: `cd app && npx tauri dev`. Debug exe: `npx tauri build --debug --no-bundle` → `src-tauri/target/debug/app.exe`. Installer: `npx tauri build`.
- **Before rebuilding, kill the running app** (the exe lock fails the build): stop `app.exe` processes whose path contains `sql-studio`.
- The bundled engine is NOT committed: `node scripts/fetch-engine.mjs` downloads MySQL Community 8.4.10 and strips it (~90 MB incl. required bin DLLs — mysqld dies with 0xC0000135 without them) into `src-tauri/resources/engine/`.
- JS tests (jsdom, in `app/scripts/`, run each with plain `node` **from the `app/` directory**):
  - `test-core.mjs` — extraction drift gate
  - `test-sync.mjs` — statement splitter, journal entries, **data-snapshot builder** (`buildDataSnapshot`/`snapshotTableOrder`)
  - `test-shim.mjs` — drives the extracted `builder.html` directly in jsdom, then calls the exported `wireBuilder()` for the shim's own wiring (action bar, semi-live INSERT, FK-by-name autocomplete)
  - `test-grid.mjs` — data-grid SQL shapes, blur-commit/Escape semantics
  - `test-designer.mjs` — the big one (~60 assertions): diffs, round-trip preservation, constraint lifecycle, undo, tag clicks, regression pins for past bugs
  - `test-canvas.mjs` — layered layout, pan/zoom persistence
- Rust tests: `cd src-tauri && cargo test --lib` — three tests against the REAL engine: sandbox round-trip, datadir persistence across restarts, and `designer_constraint_lifecycle_sql` (validates the exact SQL shapes the designer emits — extend this test whenever the designer emits a new statement shape).

### IDE architecture

- **Frontend** is plain ES modules served from `app/src`, no bundler. The core modules load as plain scripts (`window.parseSchema`, `window.SqlGen`) before `main.js`.
  - `main.js` — bootstrap, settings, file tabs, editor highlight, console (with ↑/↓ history), engine status, the sync glue: `runScript` (per-statement db context + `opts.onPartial`), `journal()`, `snapshotData()` (debounced full data.sql regeneration), `writeSchemaFromModel()` (with parse-back **self-check**), `syncSchemaFromDb()` (file ← SHOW CREATE TABLE fallback), `reconcile()` (fresh sandbox → build from files; brand-new project → name-the-database modal writes the DROP/CREATE/USE header).
  - `sync.js` — pure helpers, unit-tested: `splitSQL` (string/comment-aware), `findCurrentDb`, `isDbAgnostic`, `journalEntry` (`-- @applied <timestamp> (<source>)` stamps), `snapshotTableOrder` (FK-dependency order), `buildDataSnapshot` (multi-row INSERT dump; numeric-aware quoting, backslash escaping).
  - `builder-shim.js` — `mountBuilder()` creates the iframe; the document wiring lives in the exported **`wireBuilder(d, win, hooks)`** (testable without an iframe): hides website chrome AND the lite tool's `#toast` (a small `#builder-sync` "· schema synced" flash in the pane head replaces it), one bottom action bar (▶ Run for SELECT, ✓ Apply for writes), **semi-live INSERT** ("+ add row" applies the built row first, then starts a fresh one; Apply clears applied rows so double-Apply can't duplicate), **live-value autocomplete** for FK-by-name lookups (hooks.lookupValues → SELECT DISTINCT … LIKE; the dropdown must live INSIDE the lite tool's `.popover` or its outside-mousedown close kills it).
  - `tables-designer.js` — the unified live designer (CREATE/ALTER never appear in the builder). See "designer semantics" below.
  - `canvas-view.js` — ⊞ View mode: dependency-layered cards, SVG bezier FK lines, drag cards by header, drag background to pan, wheel pans / ctrl+wheel zooms (0.25×–2.5×, cursor-anchored), all persisted per project as positions + `__pan {x,y,z}`; reset-layout button in the bar.
  - `grid.js` — editable spreadsheet; PK-addressed UPDATE/DELETE with `LIMIT 1`; blur COMMITS a cell edit (Escape cancels; unchanged value is a no-op); rowLimit and confirmDelete come from Settings via hooks.
- **Rust** (`app/src-tauri/src/`):
  - `project.rs` — project folder = guarded file set; only schema/data/journal/queries paths writable through the API.
  - `engine.rs` — engine-adapter around bundled `mysqld`: per-project datadir in `<project>/.sqlstudio/db`, free localhost port, `--initialize-insecure`. Hardening: a datadir without `mysql.ibd` is debris and gets wiped before re-initialize; stale-engine reclaim verifies the pidfile PID is actually `mysqld.exe` before taskkill; `.sqlstudio/studio.lock` (holder PID) makes a second app instance error instead of killing the first one's engine. SHUTDOWN-then-kill on close; `RunEvent::Exit` hook releases everything.

### The sync model ("apply, don't copy")

Every applied change executes on the sandbox AND lands in the files — the project rebuilds from its files alone:

- **journal.sql** — append-only log of every applied change (`-- @applied` stamps). Console input executes but is NOT journaled (ad-hoc by design).
- **data.sql** — a full **snapshot** of the live data, regenerated (debounced 800 ms) after every journaled change: dependency-ordered multi-row INSERTs, referenced tables first (deliberately NO `SET FOREIGN_KEY_CHECKS` — session vars don't survive the pooled connections). Never append to it; the snapshot owns it.
- **schema.sql** — regenerated from the designer model on schema commits; the DROP/CREATE/USE header survives (db name chosen via modal on first open). **Invariant: `writeSchemaFromModel` parses its own output back and refuses to write if any table would be lost** (falls back to `syncSchemaFromDb`). A partial designer commit (some statements applied, then a failure) also re-syncs the file from `SHOW CREATE TABLE` — the DB is the only honest source at that point.

### Designer semantics (⊞ database tab → Edit)

- **Semi-live commits (the product's signature rule):** focusout commits after a 250 ms debounce (focusin cancels); adding a column/table commits the previous edit first; drops confirm and commit immediately; diff-based so revert-before-blur emits nothing. A commit must NEVER slam the properties popup shut (`c._open` survives the refresh — regression-tested).
- **Column rows** show name · type · args (tolerantly normalized: `3.4` → `DECIMAL(3,4)`, red warning while off-pattern) · **written-out property tags** (NOT NULL, AUTO_INCREMENT, UNSIGNED, UNIQUE, DEFAULT x, ranges, FK → target). **Clicking a tag removes that property**; the FK tag opens the popup instead.
- **The properties popup** (per-row "properties" button): all flags + DEFAULT (+ ⏱ now) + min/max range + the FK row (target dropdown incl. self-reference, editable ON UPDATE/ON DELETE — changing a rule re-creates the constraint — and a remove ✕). Closes via ✕ or clicking outside; closing applies. Toggles inside do NOT commit mid-popup.
- **Constraint lifecycle:** MySQL only ever ADDS checks/unique indexes from a column definition, so before a MODIFY/CHANGE that re-emits them, the designer looks up the old auto-named constraint/index via `hooks.query` (information_schema: CHECK_CONSTRAINTS, STATISTICS, KEY_COLUMN_USAGE) and emits DROPs first. This is what makes ranges widenable and UNIQUE-off real.
- **Renames follow everywhere:** table renames re-point dependents' `fk.refTable`; column renames follow into `fk.col`, other tables' `fk.refCol`, and kept-verbatim KEY/CHECK lines (`extras`). Compare CLEANED names — a trailing space must not emit RENAMEs forever (this happened).
- **Undo:** every committed state is snapshotted (max 100, session-scoped — remounting the tab resets it) with `_uid` lineage on tables/columns so renames reverse as renames. Ctrl+Z outside a text field, or the ↶ button; replays through the normal commit pipeline (fixups, confirms, journal). Dropped tables recreate structure-only.

### MySQL gotchas that already bit

- **`DEFAULT` grammar:** only `CURRENT_TIMESTAMP` may stand bare; CURDATE()/CURTIME() must be parenthesized expression defaults — `DEFAULT (CURDATE())`. `defaultLit` normalizes all of it and refuses unbalanced parens.
- **The parser's DEFAULT capture must read balanced parens** (`readBalanced`), never a regex — a truncated `(CURDATE()` once corrupted schema.sql and made a whole table unparseable/invisible while the DB kept it. Decimal defaults (`3.50`) also need the explicit number alternative (dot isn't `\w`).
- CHECK constraints and UNIQUE indexes accumulate on re-emission (drop-first, see lifecycle above); FK actions can't be edited in place (drop + re-add).
- Modifying/dropping columns that participate in FKs errors — the designer drops the FK with the column.

### Tauri gotchas (learned the hard way)

- **Commands must be `async`** — sync Tauri v2 commands run on the main/UI thread; a blocking `db_start` froze the whole window. State params then need explicit lifetimes: `tauri::State<'_, T>`.
- **Engines outlive crashes**: `Drop` isn't reliable on process exit. The `RunEvent::Exit` hook stops the engine; `reclaim_stale_engine()` kills the pidfile owner (verified to be mysqld.exe) before starting on an existing datadir.
- **`[hidden]` vs `display:grid`**: a CSS `display` on an element overrides the HTML `hidden` attribute — the app stylesheet has `[hidden]{display:none!important}` for this reason.
- **No horizontal scrolling anywhere is a product rule**: cells wrap, editors `pre-wrap`, panes clip x; wide content (canvas) pans instead of scrolling.

## Lite-tool architecture (the big picture)

1. **`parseSchema(sqlText)`** (script block 1) → `{ tables: [{name, columns, fks, extras}], byName }`. Columns carry `{name,type,numeric,boolean,unsigned,pk,notNull,autoInc,unique,dflt,check}`; fks carry `{col,refTable,refCol,onUpdate,onDelete}`; `extras` holds raw table-level KEY/INDEX/CHECK lines verbatim so regeneration can't lose them. Reads CREATE TABLE structure, phpMyAdmin dumps, and applies column-level `ALTER TABLE` in document order. Dedupes double-declared FKs.
2. **`SqlGen`** (block 2) — segment-based generation: each `generate*Segments()` returns `[{t,c,p}]`; `segmentsToText()` flattens; the shared `data-part` id powers two-way hover highlighting. Generators for SELECT/CREATE/INSERT/UPDATE/DELETE/ALTER. Shared helpers: `OPS`, `AGG_FNS`, `CALCS`, `pushLookup` (FK-by-name → scalar subquery), `pushSub` (mini-queries incl. correlated), `SQL_FUNC_RE`, `highlightStatic` (also used by the IDE editor).
3. **App IIFE** (block 3) — state + UI. SELECT state `Q` renders as a clickable sentence (Natural) or clause skeleton (SQL mode); the word bank opens popovers (`popCondition`, `popLookup`, …). Popovers close on ANY outside mousedown (`outsideClose`) — anything injected from the IDE that must survive a click has to live inside `.popover`. State persists in `localStorage` (`selectstudio.*`); the shim neutralizes it on mount.

For full-UI behavior tests: load into jsdom (`runScripts:'dangerously'`), dispatch `DOMContentLoaded`, click `#tour-skip` first, define `window.requestAnimationFrame`, guard `scrollIntoView`/`getBoundingClientRect`.

## Conventions that bite

- **CSS variables:** the surface variable is `--bg`; there is **no `--card`** — an undefined var yields silently-transparent backgrounds (this shipped a real bug once). Design is Swiss-minimal: hairline rules, one red accent `--accent`, black SQL "poster" panels. Theme via `prefers-color-scheme`; the IDE adds `:root[data-theme=light|dark]` overrides that must outrank the media query.
- **Foreign keys** drive most smart behavior: join suggestions, FK-follow, FK-by-name lookups with live-value autocomplete, dependency-ordered CREATE and data dumps, canvas layering, FK type-sync (FK column type derives from its referenced column — avoids errno 150).
- **The principle:** anything expressible in SQL should be buildable here. Every abstraction was designed by walking through the user's mental model in scenarios — when a flow feels wrong to him, that's a bug, not preference.
