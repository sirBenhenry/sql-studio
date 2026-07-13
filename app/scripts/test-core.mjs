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

// string escaping: backslashes must double (MySQL default sql_mode) and
// quotes must double — 'C:\tmp' once stored a TAB
const insEsc = T(G.generateInsertSegments({
  table: 'book', cols: ['title'],
  rows: [{ title: "C:\\tmp says 'hi'" }]
}, S));
ck('literals escape backslashes and quotes',
  insEsc.includes("('C:\\\\tmp says ''hi''')"), insEsc);

// FK-by-name into ANOTHER table: stays a plain scalar subquery
const insOther = T(G.generateInsertSegments({
  table: 'loan', cols: ['book_id'],
  rows: [{ book_id: { lookup: { table: 'book', ret: 'id', matches: [{ col: 'title', val: 'Dune' }] } } }]
}, S));
ck('lookup into another table stays a plain subquery',
  insOther.includes("(SELECT id FROM book WHERE title = 'Dune')"), insOther);

// FK-by-name into the SAME table: derived-table wrap (MySQL error 1093)
const insSelf = T(G.generateInsertSegments({
  table: 'member', cols: ['name', 'invited_by'],
  rows: [{ name: 'Ben', invited_by: { lookup: { table: 'member', ret: 'id', matches: [{ col: 'name', val: 'Anna' }] } } }]
}, S));
ck('self-table lookup wrapped against error 1093',
  insSelf.includes("(SELECT id FROM (SELECT id FROM member WHERE name = 'Anna') AS _lookup)"), insSelf);

// same rule for UPDATE/DELETE WHERE lookups
const updSelf = T(G.generateUpdateSegments({
  table: 'member', sets: [{ col: 'name', mode: 'value', value: 'Benny' }],
  where: [{ col: 'invited_by', lookup: { table: 'member', ret: 'id', matches: [{ col: 'name', val: 'Anna' }] } }]
}, S));
ck('UPDATE self-lookup wrapped too',
  updSelf.includes('FROM (SELECT id FROM member WHERE') && updSelf.includes('AS _lookup'), updSelf);

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');
process.exit(fail ? 1 : 0);
