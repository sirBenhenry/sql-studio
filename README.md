# SQL Studio

A visual, **Lego-style builder for MySQL**. Two ways to use it:

1. **The IDE** (`app/`) — a Windows app where **a project folder IS a live database**: a bundled portable MySQL runs on your folder, and everything you do — designing tables, editing data in spreadsheets, building queries — applies to the database AND lands in plain files (`schema.sql`, `data.sql`, `journal.sql`, `queries/`) in the same breath. Copy the folder, and you've copied the database. Fully offline; nothing leaves your machine.
2. **The lite tool** (`sql-studio.html`) — the original single HTML file. No install, no server: open it in a browser, paste a dump, click queries together.

Built as a learning + productivity tool for writing MySQL by hand.

## The IDE

- **Live tables designer** — every table is an editable card; changes apply the moment you click away (drops ask first, Ctrl+Z/Ctrl+Y undo/redo). Properties like NOT NULL, defaults, allowed ranges and foreign keys are written out on each column — click a tag to remove it.
- **Database canvas** — tables as cards, foreign keys as real lines; drag to arrange, pan, zoom.
- **Spreadsheet grids** — double-click to edit (click-away commits), sort by header, foreign-key fields search the referenced table as you type.
- **The builder** — the lite tool's query builder, embedded: SELECT/INSERT/UPDATE/DELETE as clickable sentences (Natural ↔ SQL switch), run against the live database, save keepers to query files.
- **Everything synced** — edit `schema.sql` by hand and Ctrl+S applies the diff to the database (confirmed); every applied change is journaled; `data.sql` is a live snapshot, so any copy of the folder rebuilds the identical database.
- **Import** a `.sql` dump from Settings; friendly plain-language hints under MySQL errors; an onboarding tour that walks the whole workflow.

**Install it:** grab the latest `SQL Studio_x.x.x_x64-setup.exe` from [Releases](../../releases). Windows only for now.

Or build it yourself: `cd app && npm i && node scripts/fetch-engine.mjs && npx tauri build` (see `app/SETUP.md`).

## The lite tool: what it does

- **SELECT** — build a query as a sentence you click together (columns, conditions, joins, group by, having, sorting, limit, subqueries). Hover any piece to see the matching SQL light up.
- **INSERT / UPDATE / DELETE** — pick a table and build the statement visually, with safety warnings (e.g. a `DELETE` with no condition).
- **CREATE** — design tables like bricks: columns, types, and switches for `PRIMARY KEY`, `NOT NULL`, `AUTO_INCREMENT`, `UNIQUE`, `UNSIGNED`, `DEFAULT`, and foreign keys. Foreign keys auto-order the `CREATE TABLE` statements by dependency (circular references fall back to `ALTER TABLE`).
- **ALTER** — add / drop / rename / modify columns and keys; apply the change back into the loaded schema so every mode sees the new structure without re-uploading.
- **Extend an existing database** — with a schema loaded, design new tables that foreign-key into the existing ones and get just the new `CREATE` code.

## Feed it your database

Paste your SQL dump or upload a `.sql` file — only the `CREATE TABLE` structure is read, so dumps with or without data both work. Foreign keys are detected automatically and power the join suggestions. A small built-in **demo library** schema is included so you can try everything immediately.

## Use it

Download `sql-studio.html` and double-click it. That's the whole thing.

## Status

Actively developed. `versions/vN/` holds frozen snapshots; the root `sql-studio.html` is the current build.

**v2** (frozen in `versions/v2/`) delivered the big conceptual reshape: one unified **condition** dialog (WHERE + HAVING + subqueries + correlated "of its own group" comparisons), **foreign-key-by-name** lookups everywhere (reference rows by human columns — compiles to subqueries), a **Natural ↔ SQL** view switch (clickable sentence vs. a fillable statement skeleton), invisible FK-driven joins (also inside calculations, both directions), ALTER as a **before→after diff editor**, `CHECK` ranges in CREATE, and a wider function library.

---

Built with [Claude Code](https://claude.com/claude-code).
