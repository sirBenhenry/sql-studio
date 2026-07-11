# SQL Studio

A visual, **Lego-style builder for MySQL** — click your query together and read the SQL. Runs **fully offline** as a single HTML file: no install, no server, no internet. Just open `sql-studio.html` in a browser.

Built as a learning + productivity tool for writing MySQL by hand.

## What it does

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
