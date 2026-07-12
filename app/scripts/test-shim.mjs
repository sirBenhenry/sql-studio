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
wireBuilder(d, window, {
  runScript: async (sql, source, opts) => { calls2.push({ sql, source, opts }); return true; },
  appendData: sql => calls2.push({ data: sql }),
  lookupValues: async (table, column, prefix) => {
    lookupCalls.push({ table, column, prefix });
    return ['Anna', 'Annabel'];
  }
});
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
}

// ---- bottom-bar Apply also resets the rows (no double-insert) ----
{
  const nameInp = [...d.querySelectorAll('#insert-rows .set-row input')].find(i => i.title === 'name');
  nameInp.value = 'Ben';
  nameInp.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(10);
  calls2.length = 0;
  d.querySelector('#ide-actionbar button').click();
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

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');
process.exit(fail ? 1 : 0);
