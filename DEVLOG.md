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
