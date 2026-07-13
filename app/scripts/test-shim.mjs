// End-to-end test of the shim's flow against the real extracted builder.html
// in jsdom: feed schema, drive SELECT/INSERT/CREATE, assert the sync hooks
// receive the right SQL and the schema merge works.
// (jsdom can't load iframes from disk, so this drives builder.html directly
//  through the same code paths the shim wires up.)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const ck = (n, c, e) => { if (c) console.log('ok:', n); else { fail++; console.log('FAIL:', n, e ?? ''); } };

const html = readFileSync(join(here, '..', 'src', 'core', 'builder.html'), 'utf8')
  .replace(/^<!-- AUTO-EXTRACTED[^\n]*-->\n/, '');
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
const d = window.document;
window.requestAnimationFrame = cb => cb();
window.localStorage.setItem('selectstudio.toured', '1');
window.localStorage.setItem('selectstudio.mode', 'select');
d.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
if (d.querySelector('#tour-skip')) d.querySelector('#tour-skip').click();

const calls = [];
const hooks = {
  runScript: (sql, source) => { calls.push({ kind: 'run', sql, source }); return Promise.resolve(true); },
  appendData: sql => calls.push({ kind: 'data', sql }),
  schemaChanged: t => calls.push({ kind: 'schema', len: t.length })
};

// api.setSchema equivalent
d.querySelector('#schema-input').value =
  'CREATE DATABASE shop;\nUSE shop;\nCREATE TABLE item (id INT UNSIGNED NOT NULL AUTO_INCREMENT, name VARCHAR(50) NOT NULL, PRIMARY KEY(id));';
d.querySelector('#btn-parse').click();
ck('schema fed', /1 table/.test(d.querySelector('#parse-status').textContent), d.querySelector('#parse-status').textContent);

// SELECT
[...d.querySelectorAll('.bank-btn')][0].click();
[...d.querySelectorAll('.popover .chip')].find(c => c.textContent === 'item').click();
ck('select built', d.querySelector('#sql-output').textContent === 'SELECT *\nFROM item;', d.querySelector('#sql-output').textContent);
await hooks.runScript(d.querySelector('#sql-output').textContent, 'builder: select');

// INSERT
d.querySelector('#tab-insert').click();
const inp = d.querySelector('#insert-rows .set-row input');
inp.value = 'Table lamp';
inp.dispatchEvent(new window.Event('input', { bubbles: true }));
const insertSQL = d.querySelector('#insert-sql').textContent;
ck('insert built', insertSQL.includes("('Table lamp')"), insertSQL);
await hooks.runScript(insertSQL, 'builder: insert');
hooks.appendData(insertSQL);
ck('data hook', calls.some(c => c.kind === 'data' && c.sql.includes('Table lamp')));

// CREATE (extend mode — no boilerplate)
d.querySelector('#tab-create').click();
d.querySelector('#chk-boiler').checked = false;
d.querySelector('#chk-boiler').dispatchEvent(new window.Event('change', { bubbles: true }));
d.querySelector('#btn-add-table').click();
const card = [...d.querySelectorAll('.tbl-card')].pop();
card.querySelector('.tname').value = 'category';
card.querySelector('.tname').dispatchEvent(new window.Event('input', { bubbles: true }));
card.querySelector('.tname').dispatchEvent(new window.Event('change', { bubbles: true }));
const createSQL = d.querySelector('#create-sql').textContent;
ck('create built', createSQL.includes('CREATE TABLE category'), createSQL);
await hooks.runScript(createSQL, 'builder: create');
d.querySelector('#btn-to-select').click(); // lite merges new tables into its schema text
hooks.schemaChanged(d.querySelector('#schema-input').value);
ck('schema merged', d.querySelector('#schema-input').value.includes('CREATE TABLE category'));
ck('hooks complete', calls.filter(c => c.kind === 'run').length >= 3 && calls.some(c => c.kind === 'schema'));

/* ==== the shim's own document wiring (wireBuilder): action bar, semi-live
   INSERT, live-value autocomplete ==== */
const tick = ms => new Promise(r => setTimeout(r, ms));
const { wireBuilder } = await import('../src/builder-shim.js');
const calls2 = [];
const lookupCalls = [];
const fkSearches = [];
wireBuilder(d, window, {
  runScript: async (sql, source, opts) => { calls2.push({ sql, source, opts }); return true; },
  appendData: sql => calls2.push({ data: sql }),
  lookupValues: async (table, column, prefix) => {
    lookupCalls.push({ table, column, prefix });
    return ['Anna', 'Annabel'];
  },
  searchFkRows: async (refTable, q) => {
    fkSearches.push({ refTable, q });
    return [{ id: 2, label: '2 · Anna · anna@x.io' }];
  },
  queryFiles: () => ['reports'],
  saveToQueryFile: async (name, sql) => { saved.push({ name, sql }); }
});
const saved = [];
ck('action bar mounted', !!d.querySelector('#ide-actionbar'));

// a schema with a (self-referencing) FK for the lookup flows
d.querySelector('#schema-input').value =
  'CREATE DATABASE fc;\nUSE fc;\nCREATE TABLE member (id INT UNSIGNED NOT NULL AUTO_INCREMENT, name VARCHAR(40) NOT NULL, invited_by INT UNSIGNED, PRIMARY KEY(id), FOREIGN KEY(invited_by) REFERENCES member(id));';
d.querySelector('#btn-parse').click();
d.querySelector('#tab-insert').click();

// ---- + add row applies the built row first, then starts a fresh one ----
{
  const nameInp = [...d.querySelectorAll('#insert-rows .set-row input')].find(i => i.title === 'name');
  ck('insert row has the name input', !!nameInp);
  nameInp.value = 'Anna';
  nameInp.dispatchEvent(new window.Event('input', { bubbles: true }));
  calls2.length = 0;
  d.querySelector('#btn-add-insert-row').click();
  await tick(60);
  ck('+ row applies the current row', calls2.some(c => c.sql && c.sql.includes("'Anna'")), JSON.stringify(calls2));
  const rows = d.querySelectorAll('#insert-rows .set-row');
  ck('+ row leaves one fresh empty row',
    rows.length === 1 && [...rows[0].querySelectorAll('input')].every(i => !i.value),
    rows.length);
  ck('applied row stays visible as history',
    [...d.querySelectorAll('.ide-applied-line')].some(l => l.textContent.includes("'Anna'")),
    d.querySelector('#ide-applied') && d.querySelector('#ide-applied').textContent);
}

// ---- the add-row button says what it will do ----
{
  const btn = d.querySelector('#btn-add-insert-row');
  const empty = btn.textContent;
  ck('empty row: original label', !empty.includes('apply'), empty);
  const nameInp = [...d.querySelectorAll('#insert-rows .set-row input')].find(i => i.title === 'name');
  nameInp.value = 'Carla';
  nameInp.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(20);
  ck('built row: label announces apply + next', btn.textContent === '✓ apply + next row', btn.textContent);
  // clean up for the following tests
  nameInp.value = '';
  nameInp.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(20);
}

// ---- bottom-bar Apply also resets the rows (no double-insert) ----
{
  const nameInp = [...d.querySelectorAll('#insert-rows .set-row input')].find(i => i.title === 'name');
  nameInp.value = 'Ben';
  nameInp.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(10);
  calls2.length = 0;
  d.querySelector('#ide-actionbar button.primary').click();
  await tick(60);
  ck('Apply runs the insert', calls2.some(c => c.sql && c.sql.includes("'Ben'")), JSON.stringify(calls2));
  const rows = d.querySelectorAll('#insert-rows .set-row');
  ck('Apply clears the applied rows',
    rows.length === 1 && [...rows[0].querySelectorAll('input')].every(i => !i.value),
    rows.length);
}

// ---- FK-by-name lookup gets live-value suggestions ----
{
  const lookupBtn = d.querySelector('#insert-rows .lookup-btn');
  ck('FK column offers 🔎 by name', !!lookupBtn);
  lookupBtn.click();
  const pop = d.querySelector('.popover');
  ck('lookup popover opened', !!pop && pop.querySelector('h4').textContent.startsWith('Look up member'), pop && pop.querySelector('h4').textContent);
  const valInp = [...pop.querySelectorAll('input')].find(i => i.placeholder === 'value');
  const colSel = valInp.closest('.row').querySelector('select');
  colSel.value = 'name';
  colSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  valInp.focus();
  valInp.value = 'ann';
  valInp.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(250); // debounce
  ck('live values queried for member.name',
    lookupCalls.some(c => c.table === 'member' && c.column === 'name' && c.prefix === 'ann'),
    JSON.stringify(lookupCalls));
  const sug = d.querySelector('#ide-suggest');
  ck('suggestions shown inside the popover (outside-click safe)',
    sug && sug.style.display === 'block' && sug.closest('.popover') === pop,
    sug && sug.style.display);
  sug.querySelector('.ide-sug-item').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  ck('picking a suggestion fills the value', valInp.value === 'Anna', valInp.value);
  ck('dropdown hidden after pick', sug.style.display === 'none', sug.style.display);
}

// ---- the grid's whole-row FK search, on the insert tab's id-input ----
{
  // close any open popover first
  d.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  await tick(20);
  const fkInp = [...d.querySelectorAll('#insert-rows .set-row input')]
    .find(i => i.title === 'invited_by');
  ck('FK id-input present', !!fkInp);
  fkInp.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }));
  ck('placeholder announces the search', fkInp.placeholder === 'invited_by — type to search member', fkInp.placeholder);
  fkInp.focus();
  fkInp.value = 'ann';
  fkInp.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(250);
  ck('row search queried the referenced table',
    fkSearches.some(s => s.refTable === 'member' && s.q === 'ann'), JSON.stringify(fkSearches));
  const sug = d.querySelector('#ide-suggest');
  ck('row suggestions shown with all values',
    sug.style.display === 'block' && sug.querySelector('.ide-sug-item').textContent === '2 · Anna · anna@x.io',
    sug.textContent);
  sug.querySelector('.ide-sug-item').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  ck('picking fills the id, not the label', fkInp.value === '2', fkInp.value);
}

// ---- "+ to file": pick an existing query file or create a new one ----
{
  const fileBtn = [...d.querySelectorAll('#ide-actionbar button')].find(b => b.textContent === '+ to file');
  ck('+ to file button exists', !!fileBtn);
  ck('hidden outside SELECT mode', fileBtn.style.display === 'none', fileBtn.style.display);

  // build a fresh SELECT on the current (member) schema
  d.querySelector('#tab-select').click();
  await tick(20);
  [...d.querySelectorAll('.bank-btn')][0].click();
  [...d.querySelectorAll('.popover .chip')].find(c => c.textContent === 'member').click();
  await tick(20);
  ck('visible in SELECT mode with SQL built', fileBtn.style.display !== 'none' && !fileBtn.disabled,
    fileBtn.style.display + '/' + fileBtn.disabled);

  // existing file path
  fileBtn.click();
  const menu = d.querySelector('#ide-filemenu');
  ck('picker opens with existing files', menu.style.display === 'block' &&
    [...menu.querySelectorAll('.ide-fm-item')].some(i => i.textContent === 'reports.sql'), menu.textContent);
  [...menu.querySelectorAll('.ide-fm-item')].find(i => i.textContent === 'reports.sql').click();
  await tick(20);
  ck('appends to the picked file', saved.some(s => s.name === 'reports' && s.sql.includes('SELECT') && s.sql.includes('member')),
    JSON.stringify(saved));
  ck('picker closed after pick', menu.style.display === 'none');

  // new-file path
  saved.length = 0;
  fileBtn.click();
  const inp = menu.querySelector('.ide-fm-new input');
  inp.value = 'best sellers';
  inp.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick(20);
  ck('creates a new file by name', saved.some(s => s.name === 'best sellers' && s.sql.includes('member')),
    JSON.stringify(saved));
}

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');
process.exit(fail ? 1 : 0);
