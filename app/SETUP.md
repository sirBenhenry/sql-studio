# SQL Studio IDE — dev setup

## Prerequisites (already present on this machine)
- Rust (rustc/cargo ≥ 1.80) with the MSVC toolchain
- Node.js ≥ 20
- WebView2 runtime (ships with Windows 10/11)

## First-time setup
```
cd app
npm install
node scripts/fetch-engine.mjs     # downloads + strips MySQL Community (~600 MB download, ~90 MB kept)
```

## Run / build
```
npx tauri dev                     # live dev window
npx tauri build --debug --no-bundle   # debug exe → src-tauri/target/debug/
npx tauri build                   # NSIS installer → src-tauri/target/release/bundle/nsis/
```

## Tests (run each from `app/`)
```
node scripts/test-core.mjs        # zero-drift gate: core/ matches the lite tool + generator pins
node scripts/test-sync.mjs        # sync plumbing (splitSQL, journal, data snapshot, error hints)
node scripts/test-shim.mjs        # builder-shim flows against the real builder.html
node scripts/test-grid.mjs        # data-grid semantics
node scripts/test-designer.mjs    # tables designer: diffs, lifecycle, undo/redo, file→DB
node scripts/test-canvas.mjs      # canvas layout, pan/zoom
node scripts/test-tour.mjs        # onboarding engine
cd src-tauri && cargo test --lib  # 3 tests against the REAL engine (needs fetched engine)
```

## After editing the lite tool (../sql-studio.html)
```
node scripts/extract-core.mjs && node scripts/test-core.mjs && node scripts/test-shim.mjs
```
