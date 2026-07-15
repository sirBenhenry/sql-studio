# DEVLOG — autonomous session 2026-07-13

Ben is away; instructions: identify issues / unfinished pieces / useful new
features, fix them one after another, keep this log. Every item ends with all
test suites green and a commit.

## Queue (planned)

1. Dead-code cleanup (appendSchema, overview.js, stray localStorage key)
2. Human error hints for common MySQL errors in the console
3. Grid polish: empty-string vs NULL, mutation echo in console, load-more, column sort
4. Builder Apply success feedback
5. Unsaved-changes guard on window close
6. currentDb validation (console USE + reconcile header check)
7. File→DB sync: apply schema.sql edits to the live database (the big one)
8. Import a .sql dump (Settings)
9. App icon set + final polish pass

## Done

1. **Dead-code cleanup** — removed `appendSchema` (no caller since CREATE/ALTER
   moved to the designer), `overview.js` + its CSS + its two tests (superseded
   by the canvas view), and the never-read `sqlstudio.lang` localStorage write.
2. **Human error hints** — `explainError` in sync.js (16 errnos: 1062 dup,
   1451/1452 FK both directions, 1048 NOT NULL, 3819 CHECK, 1064 syntax,
   1146/1049/1054 missing things, 1075, 3730, 1366/1406/1265 type/length,
   1093, 1213/1205 locks) → one-sentence hint with a suggested fix under the
   raw error in the console. Unknown errors stay silent. Tested.
3. **Grid polish** — click a header to sort (asc → desc → natural, arrow in
   the header); "+ load more" at the row limit (doubles it); typing `''`
   stores an actual empty string while blank stays NULL (tooltip explains);
   grid INSERT/UPDATE/DELETE echo statement + result in the console. Tested.
4. **Builder success feedback** — the action button flashes green "✓ applied"
   / "✓ ran" for 1.2s after success; refreshBar respects the flash. Tested.
5. **Unsaved-changes guard** — onCloseRequested lists dirty file tabs in a
   native ask-dialog before the window may close (view tabs + tour demo
   excluded).
6. **currentDb hardening** — console `USE` executes server-side first (a typo
   errors instead of poisoning the context); reconcile warns when schema.sql's
   header names a database the sandbox doesn't have and falls back to a real
   one.
7. **File→DB sync (the flagship gap)** — Ctrl+S on schema.sql diffs the file
   against SHOW CREATE TABLE truth (new exported `diffModels`, name-matched:
   a rename in text is a drop + add) through the designer's diff engine incl.
   constraint fixups, confirms the statement list (destructive ops flagged,
   header-db changes called out as rebuild-only), applies journaled; partial
   failure re-syncs the file from DB truth; unparseable file or declined
   confirm leaves everything untouched. `resolveFixups` hoisted + exported.
   7 new tests.
8. **Import a .sql dump** — Settings button → native file dialog → statement
   count + conflict confirm → runs against the live db → schema.sql +
   data.sql regenerated from DB truth (even after partial failure); journal
   gets one import note. New read-only `import_read` Rust command.
9. **App icon** — the brand's red asterisk on poster black, rendered by a
   dependency-free PNG writer (`scripts/make-icon.mjs`, supersampled), full
   platform set via `tauri icon`; debug exe rebuilt with it.

All 7 JS suites green after every step; cargo check clean; each item its own
pushed commit.

## Round 2 (same session, continuing)

10. **Batch execution + mutex fix** — `db_exec_batch` runs a whole statement
    list on one connection (USE persists, first-failure stop, applied count;
    semantics pinned in the real-engine cargo test). Seeds/imports use it via
    `runScriptFast`: one IPC round-trip per script instead of per statement.
    `db_exec`/`db_exec_batch` clone the pool and release the engine mutex
    before querying — a slow query no longer blocks db_status/shutdown.
11. **NSIS installer ships the engine** — `bundle.resources` now includes
    `resources/engine` (an installer built before this had NO MySQL in it —
    the app would ask for fetch-engine.mjs on first run); per-user install
    mode. Built and verified: all 53 engine files incl. mysqld.exe inside
    `SQL Studio_0.1.0_x64-setup.exe` (20 MB — LZMA squeezes the 91 MB engine).
12. **Query tabs manageable** — double-click renames (guarded `query_rename`
    Rust command, file follows), ✕ closes (file stays in queries/), and
    `+ query` checks the DISK for taken names so a closed query1's file can't
    be clobbered.
13. **Designer redo** — ↷ button + Ctrl+Y / Ctrl+Shift+Z; undo pushes onto a
    redo stack, redo replays through the commit pipeline, any fresh change
    forks history and clears redo. Found + fixed a stale-render bug (button
    states updated before the stacks changed). 6 new tests.

Final state: 7 JS suites + 3 cargo tests green; debug exe rebuilt and
running; release installer in src-tauri/target/release/bundle/nsis/.

## Round 3 — documentation + last touches

14. **CLAUDE.md re-synced** — sync model gained its file→DB direction and the
    import path; module map covers tour.js/batch/query tabs/redo/error hints;
    test list current; installer-verification step recorded. Memory updated.
15. **README covers the IDE** — the repo front page only described the lite
    tool; the IDE now gets top billing (features + build line). SETUP.md test
    list completed (all 7 suites).
16. **Journal tab opens at its newest entries** (scroll-to-bottom on
    activate).

## Round 4 — hardening sweep (continued autonomy)

17. **Round-trip fuzz net** — 60 random designer models (deterministic seed)
    → DDL → parser → model, every column property asserted; the invariant
    that broke twice before is now permanently watched. It immediately
    flagged the NOW()→CURRENT_TIMESTAMP canonicalization (asserted equal).
18. **Undo/redo survives View↔Edit remounts** — per-project history store,
    adopted only when the stored last snapshot still structurally matches
    the incoming schema (external changes reset it; the tour demo gets its
    own lane). Tested incl. the reset path.
19. **Console capped at 600 nodes** (long sessions can't crawl); file-save
    warns when changed KEY/INDEX lines won't apply live; editor highlight
    perf measured (3.7 ms @ 1400 lines) and left alone.
20. **Phantom-MODIFY class killed** — SHOW CREATE TABLE spells things its own
    way (BOOLEAN→tinyint(1), INTEGER→int, expression defaults lowercase in
    parens, TRUE→'1', decimals quoted); without canonicalization every
    Ctrl+S re-emitted the same MODIFYs forever. canonType + canonDef in the
    diff, tested in JS, and MySQL's exact spellings PINNED in the cargo test
    so an engine upgrade fails loudly instead of silently breaking the diff.

## Round 5 — resilience + safety (second solo stretch)

21. **data.sql replay hardened** — snapshot wraps inserts in
    `SET FOREIGN_KEY_CHECKS = 0/1` (safe now that seeds replay on ONE
    connection via batch): a self-reference to a higher id (Anna invited by
    Carla) or an FK cycle rebuilds. Validated on the real engine, including
    that the checks actually re-enable afterwards.
22. **Engine-loss handling** — connection-class errors flip the status to
    "● engine: lost — click to restart" (all three exec paths report it);
    clicking restarts without an app restart; re-entry guarded; Ctrl+S with
    a dead engine says loudly that only the FILE was updated.
23. **Window title** = project name; dead recents prune themselves off the
    welcome screen; grid FK dropdown gets ↓/↑ + Enter keyboard nav
    (capture-phase so Enter picks instead of committing).
24. **THE CATCH: unfiltered UPDATE/DELETE gate.** The lite tool's "deletes
    EVERY row" warning is a comment — which the shim strips — so the IDE
    applied condition-less UPDATE/DELETE with zero friction. Apply now
    confirms, tested both ways. Plus errno 1046 hint (import without USE).
    Clippy: clean.

## Round 6 — generator sweep

25. **Backslash corruption fixed (lite tool, fix-level change):** `escStr`
    only doubled quotes — MySQL's default sql_mode treats backslash as an
    escape, so every builder literal containing one (paths!) silently
    corrupted ('C:\tmp' stored a TAB). Now doubled, matching the snapshot's
    escaping; pinned in test-core; extraction re-run.
26. **Console multiline** — the input is a textarea: Shift+Enter for a new
    line, Enter runs, auto-grows to 120px; ↑/↓ history stays on single-line
    drafts.

## Rounds 7–9 — third solo stretch

27. **Atomic file writes** — schema/data/journal/query writes go through
    temp + rename (a crash mid-write could truncate the files the project
    IS); Windows replace-on-rename pinned in a cargo unit test.
28. **Renames carry their world** — a table rename migrates its saved canvas
    position and retitles an open ▦ grid tab (hooks.onRenames) instead of
    orphaning both.
29. **Editor Tab indents** (two spaces) instead of walking focus away.
30. **Statusbar shows the active database**; **drop a project folder on the
    welcome screen to open it**; tour text covers the multiline console.
31. **Engine honesty** — db_status now checks the actual process (a dead
    mysqld reported "running" before); a 30s heartbeat flips the UI to
    click-to-restart even when nothing is executed; startup fails
    IMMEDIATELY with a pointer to the .err log when mysqld exits at launch
    (was: a silent 40-second wait). Clippy clean, all 4 cargo tests green.

## Round 10

32. **Canvas layout travels with the project** — positions/pan/zoom move from
    this machine's localStorage into `<project>/.sqlstudio/ui.json`
    (new guarded ui_state_read/write commands, atomic writes, debounced;
    one-time migration from the old localStorage key). Copy or move the
    folder and your arranged diagram comes along — matching the product's
    core promise.

## Round 11 — loose ends

33. **Tour demo can't linger** — closing the app mid-tour now drops the demo
    library before the window goes (onCloseRequested), so an abandoned tour
    leaves no `library` db in the sandbox.
34. **Engine download URL verified alive** (200 via cdn.mysql.com — no rot;
    checked, no change needed).

## Consumer round (Ben present, buckets confirmed via question)

35. **CSV import** — Settings → "import a .csv as a table…": RFC-4180 parser,
    type inference (INT/DECIMAL/DATE/DATETIME/VARCHAR/TEXT), unique-int first
    column becomes the PK (else synthetic auto-id so the grid stays
    editable), header sanitize/dedupe, chunked INSERTs, journaled = ONE
    Ctrl+Z step, grid opens on finish. Pure module `csv.js` + 15-test
    `test-csv.mjs`.
36. **CSV out** — every grid gets "⇪ csv" (full matching table via save
    dialog, not just the loaded page; respects the filter); every console
    result gets "⧉ copy csv" (all rows, Excel-pasteable). New `export_write`
    Rust command.
37. **Grid find box** — server-side contains-filter across ALL columns
    (works past the row limit), debounced, Escape clears, focus survives the
    reload-render, export respects it.
38. **Canvas row counts** — live COUNT(*) per card, filled in async.
39. **Share as one .sql** — Settings → "export project as one .sql…"
    (schema + data concatenated, dated header, save dialog).
40. **? shortcuts overlay** — topbar ? button or the ? key: one-screen cheat
    sheet (global undo, console, grids, designer, builder).
41. **Settings expansion** — text size S/M/L (editor+console via
    --code-size), reopen-last-project on start, default FK rules for new
    foreign keys (designer reads them), undo-depth (global undo honors it).

## Ask-then-build loop (Ben approving each item)

42. **Run saved queries** — Ctrl+Enter runs the selection anywhere / a query
    tab whole (▶ in the tab bar); whole-file locked to query tabs (schema.sql
    starts with DROP DATABASE); writes journaled, reads not.
43. **Spreadsheet paste** — a copied Excel block pasted into the + row
    becomes rows: confirmed with count, auto-inc columns skipped, empty
    cells NULL, ONE journaled INSERT (= one Ctrl+Z). parseTSV shares the
    quoted-field parser with CSV.
44. **Diagram → .svg** — buildDiagramSvg renders the arranged canvas (cards,
    PK/FK tags, types, bezier lines) standalone on white; '⇪ svg' in the bar.
45. **Excel everywhere** — xlsx.js: dependency-free .xlsx writer (STORED zip
    hand-built, CRCs verified against zlib in test-xlsx; export_write_b64
    Rust command with a vector-tested base64 decoder). '⇪ excel' on every
    grid; Settings → whole database as ONE workbook, sheet per table,
    parents before dependents.
46. **Global search** — 'find in all tables…' in the ⊞ bar; per-table hit
    chips; click/Enter opens the grid pre-filtered (openTableGrid carries a
    filter; grids accept initialFilter).

## Deliberately NOT done (needs Ben)

- P9 external-server deploy (connection manager, credentials) — too much
  invented UX to build unsupervised, and no server here to test against.
- A run affordance for saved query files — Ben redirected the last proposal
  to "+ to file"; whether re-running belongs on the tab needs his call.
- Editor line numbers, canvas relationship labels — cosmetic inventions,
  his taste decides.
- Reserved-word identifiers in the BUILDER (a table named `order` generates
  unbackticked SQL → 1064 with a hint). The designer backticks everything;
  backticking the builder's output changes the lite tool's whole rendered
  aesthetic — Ben's call.
