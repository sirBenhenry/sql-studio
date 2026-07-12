// Zero-drift gate: the extracted core files must match the lite tool's script
// blocks byte-for-byte (minus the AUTO-EXTRACTED header), and must actually
// load + produce correct SQL in a bare VM (no DOM).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const liteFile = join(here, '..', '..', 'sql-studio.html');
const coreDir = join(here, '..', 'src', 'core');

let fail = 0;
const ck = (name, cond, extra) => {
  if (cond) console.log('ok:', name);
  else { fail++; console.log('FAIL:', name, extra ?? ''); }
};

const html = readFileSync(liteFile, 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);

const stripHeader = s => s.replace(/^\/\* AUTO-EXTRACTED[\s\S]*?\*\/\n/, '');
const files = { 'demo.js': 0, 'parser.js': 1, 'sqlgen.js': 2 };
for (const [f, i] of Object.entries(files)) {
  const extracted = stripHeader(readFileSync(join(coreDir, f), 'utf8'));
  ck(`${f} identical to lite block ${i}`, extracted === blocks[i],
    extracted === blocks[i] ? '' : `lengths ${extracted.length} vs ${blocks[i].length}`);
}
const builderHtml = readFileSync(join(coreDir, 'builder.html'), 'utf8')
  .replace(/^<!-- AUTO-EXTRACTED[^\n]*-->\n/, '');
ck('builder.html identical to lite tool', builderHtml === html,
  builderHtml === html ? '' : `lengths ${builderHtml.length} vs ${html.length}`);

// functional smoke in a bare VM
const sb = { window: {} };
vm.createContext(sb);
vm.runInContext(readFileSync(join(coreDir, 'demo.js'), 'utf8'), sb);
vm.runInContext(readFileSync(join(coreDir, 'parser.js'), 'utf8'), sb);
vm.runInContext(readFileSync(join(coreDir, 'sqlgen.js'), 'utf8'), sb);

const DEMO_SQL = vm.runInContext('DEMO_SQL', sb); // top-level const lives in the context's lexical scope
const S = sb.window.parseSchema(DEMO_SQL);
ck('demo parses: 5 tables', S.tables.length === 5, S.tables.length);
ck('FKs detected: 4', S.tables.reduce((n, t) => n + t.fks.length, 0) === 4);

const G = sb.window.SqlGen;
const T = segs => G.segmentsToText(segs);
const q = {
  distinct: false, from: 'book', joins: [], groupBy: [], having: [], orderBy: [], limit: null,
  select: [],
  where: [{ table: 'book', col: 'price', op: 'gt', src: 'sub',
            sub: { table: 'book', fn: 'AVG', col: 'price', hasCond: true, cSame: true, cCol: 'fk_genre_id' } }]
};
ck('correlated subquery generates',
  T(G.generateSegments(q, S)) === 'SELECT *\nFROM book\nWHERE price > (SELECT AVG(x.price) FROM book x WHERE x.fk_genre_id = book.fk_genre_id);',
  T(G.generateSegments(q, S)));

ck('DELETE generator',
  T(G.generateDeleteSegments({ table: 'loan', where: [{ col: 'id', op: 'eq', v1: '5' }] }, S)) === 'DELETE FROM loan\nWHERE id = 5;');

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');
process.exit(fail ? 1 : 0);
