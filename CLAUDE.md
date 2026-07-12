# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**SQL Studio** — a visual, "Lego-style" MySQL tool. The repo holds **two worlds**:

1. **The lite tool** (`sql-studio.html`) — a single self-contained HTML file. Everything (HTML, CSS, all JavaScript, demo database) is inlined. Runs fully offline by opening in a browser: **no build step, no bundler, no dependencies**. Do not add a build system or split it into modules — `file://` forbids ES modules/CORS; the single-file plain-`<script>` design is intentional. **This file is also the source of truth for the parser/generator/builder logic** consumed by the IDE (see below).
2. **The IDE** (`app/`) — a Tauri 2 Windows app (Rust host + webview) where a project folder IS a live database: bundled portable MySQL sandbox per project, `schema.sql`/`data.sql`/`journal.sql`/`queries/`, builder pane (the lite tool embedded via iframe + shim), console with result tables. Architecture: see `PLAN.md`.

`versions/vN/` holds frozen snapshots of the lite tool; the root `sql-studio.html` is the working build.

## The extraction contract (critical)

The IDE **never forks** the builder logic. `app/scripts/extract-core.mjs` copies the lite tool's script blocks **verbatim** into `app/src/core/` (`demo.js`, `parser.js`, `sqlgen.js`) plus the whole file as `core/builder.html` (embedded as an iframe by `app/src/builder-shim.js`, which adapts it from the outside — hides chrome, adds Run/Apply buttons, feeds schema). After ANY edit to `sql-studio.html`: re-run the extraction, then `node app/scripts/test-core.mjs` (zero-drift gate) and `node app/scripts/test-shim.mjs`. Never hand-edit `app/src/core/*`.

## IDE development (`app/`)

- Dev loop: `cd app && npx tauri dev`. Build: `npx tauri build --debug --no-bundle` (exe in `src-tauri/target/debug/`), installer via `npx tauri build`.
- The bundled engine is NOT committed: `node scripts/fetch-engine.mjs` downloads + strips MySQL Community (~90 MB) into `src-tauri/resources/engine/`. Engine behavior is tested by `cargo test --lib` in `src-tauri/` (full init→start→query→shutdown round-trip).
- Frontend is plain ES modules served from `app/src` (no bundler yet): `main.js` (bootstrap, tabs, console, sync glue), `sync.js` (splitSQL/journal helpers — tested by `scripts/test-sync.mjs`), `builder-shim.js`.
- Rust: `src-tauri/src/project.rs` (project folder = file set, guarded IO), `src-tauri/src/engine.rs` (engine-adapter: per-project mysqld on a free localhost port, datadir in `<project>/.sqlstudio/db`).

## Editing & running

- Edit `sql-studio.html` directly. To see it, open the file in a browser (double-click). There is nothing to compile.
- The file is organized as four `<script>` blocks in order: **(0)** inline demo SQL, **(1)** `parseSchema`, **(2)** `SqlGen`, **(3)** the app IIFE. They share top-level globals (e.g. `DEMO_SQL`, `window.parseSchema`, `window.SqlGen`).

## Verifying changes (no test runner in-repo)

There is no test framework committed. Verify headlessly with Node:

- **Syntax check** — extract and compile each script block:
  ```bash
  node -e "const fs=require('fs'),vm=require('vm');[...fs.readFileSync('sql-studio.html','utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach(m=>new vm.Script(m[1]));console.log('OK')"
  ```
- **Pure logic** (parser + generators) — run script blocks 1 & 2 in a `vm` context, then call `parseSchema(sql)` and `SqlGen.generate*Segments(...)`, comparing `SqlGen.segmentsToText(segs)` to expected SQL.
- **Full UI behavior** — load the file into **jsdom** (`runScripts:'dangerously'`), dispatch `DOMContentLoaded`, then drive the real DOM (`$('#btn-demo').click()`, set inputs + dispatch `input`/`change`, read `#sql-output`/`#create-sql`/etc.). jsdom gotchas: define `window.requestAnimationFrame`, and `scrollIntoView`/`getBoundingClientRect` return nothing — guard or mock them.

Always run the syntax check plus a jsdom smoke test (load demo, build one query per touched mode) before considering a change done.

## Architecture (the big picture)

Three layers inside the one file:

1. **`parseSchema(sqlText)`** (block 1) → `{ tables:[{name, columns:[{name,type,numeric,boolean,unsigned,pk,notNull,autoInc}], fks:[{col,refTable,refCol}]}], byName }`. Reads only `CREATE TABLE` structure (data dumps and structure-only dumps both work), handles phpMyAdmin dumps, and **applies column-level `ALTER TABLE`** in document order via `applyAlterClause` (ADD/DROP/MODIFY/CHANGE/RENAME column, RENAME table, ADD FK/PK). Dedupes double-declared FKs.

2. **`SqlGen`** (block 2) — generation is **segment-based**, not string concatenation. Each `generate*Segments()` returns `[{t:text, c:cssClass, p:partId}]`. `renderSegments()` turns segments into spans with `data-part` ids; `segmentsToText()` flattens to plain SQL. The shared `data-part` id is what powers **two-way hover highlighting** between the builder and the SQL panel. Generators: `generateSegments` (SELECT), `generateCreate/Insert/Update/Delete/AlterSegments`. Shared helpers: `OPS` (operators), `AGG_FNS`, `CALCS` (formula columns), `pushLiteral`/`pushWhere`/`pushOp`, `SQL_FUNC_RE` (functions like `NOW()`/`CURDATE()` emitted unquoted).

3. **App IIFE** (block 3) — state + UI. SELECT uses a state object `Q` rendered as a clickable **sentence** + a **word bank** of buttons that open **popovers** (`popCondition`, `popCompare`, `popColumns`, `popJoin`, `popAgg`, `popCalc`, …). INSERT/UPDATE/DELETE/ALTER/CREATE have their own state (`I`,`U`,`D`,`A`,`C`) rendered as compact inline forms. `setMode()` toggles the six modes; a shared step-1 schema panel feeds every mode except CREATE. State persists in `localStorage` (`selectstudio.schema`, `.mode`, `.create`, `.insert/.update/.delete/.alter`, `.toured`).

## Conventions that bite

- **CSS variables:** the surface/background variable is `--bg` (white/near-black by theme). There is **no `--card`** — referencing an undefined var silently yields transparent backgrounds. Design is deliberately Swiss-minimal (hairline rules, one red accent `--accent`, black SQL "poster" panels). Theme via `prefers-color-scheme`.
- **Foreign keys** drive most smart behavior: join suggestions, FK-follow in the column picker, dependency-ordered `CREATE`, and FK type-sync (a FK column's type is derived from its referenced column so `INT UNSIGNED` matches — avoids MariaDB errno 150).
- **Onboarding tour** (`#tour`): a fixed hole-punch ring (`box-shadow: 0 0 0 9999px`) positioned from `getBoundingClientRect` — not by raising page elements. `startTour()` loads the demo first so every step has content. Plays once (localStorage `selectstudio.toured`); the `?` tab-bar button replays it.

## Direction (v2, in progress)

A larger reshape is planned: a **Natural ↔ SQL toggle** (same builder, two labelings), one unified **"big conditional"** (fuses WHERE/HAVING/subqueries/aggregates) reused as the "which rows" picker across UPDATE/DELETE, **foreign-key-by-name** lookups (set/match a FK by a human column, compiling to a subquery), a two-part layout for write modes (action on top, conditional below), `CHECK`/range in CREATE, ALTER-as-before/after-diff, and broader function coverage. Preserve the principle: **anything expressible in SQL should be buildable here.**
