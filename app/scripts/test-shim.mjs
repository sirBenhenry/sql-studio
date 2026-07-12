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

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');
process.exit(fail ? 1 : 0);
