// Extracts the core script blocks from the lite tool (../sql-studio.html)
// into app/src/core/ VERBATIM. The lite tool remains the single source of
// truth for parser + generator logic until the IDE stabilizes; run this
// after changing them there. `npm run test:core` verifies zero drift.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const liteFile = join(here, '..', '..', 'sql-studio.html');
const outDir = join(here, '..', 'src', 'core');

const html = readFileSync(liteFile, 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (blocks.length !== 4) throw new Error('expected 4 script blocks in sql-studio.html, got ' + blocks.length);

const HEADER = (n, name) =>
  `/* AUTO-EXTRACTED from sql-studio.html (script block ${n}) — DO NOT EDIT HERE.\n` +
  `   Edit the lite tool, then re-run: node scripts/extract-core.mjs\n` +
  `   Drift is caught by: npm run test:core */\n`;

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'demo.js'), HEADER(0, 'demo') + blocks[0], 'utf8');
writeFileSync(join(outDir, 'parser.js'), HEADER(1, 'parser') + blocks[1], 'utf8');
writeFileSync(join(outDir, 'sqlgen.js'), HEADER(2, 'sqlgen') + blocks[2], 'utf8');
// the complete lite tool, verbatim — embedded as an iframe in the builder
// pane; the IDE shim adapts it from the outside (hide chrome, wire Run/Apply)
writeFileSync(join(outDir, 'builder.html'),
  '<!-- AUTO-EXTRACTED: verbatim copy of sql-studio.html — DO NOT EDIT HERE -->\n' + html, 'utf8');
console.log('extracted: core/demo.js, core/parser.js, core/sqlgen.js, core/builder.html');
