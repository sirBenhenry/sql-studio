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

## Deliberately NOT done (needs Ben)

- P9 external-server deploy (connection manager, credentials) — too much
  invented UX to build unsupervised, and no server here to test against.
- A run affordance for saved query files — Ben redirected the last proposal
  to "+ to file"; whether re-running belongs on the tab needs his call.
- Editor line numbers, canvas relationship labels — cosmetic inventions,
  his taste decides.
