// Tables-designer test: mounts against a real parsed schema in jsdom, drives
// edits with Ben's semi-live rules, and asserts the committed SQL diffs.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const dom = new JSDOM('<div id="host"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
window.confirm = () => true;

// real parser from core
const sb = { window: {} };
vm.createContext(sb);
vm.runInContext(readFileSync(join(here, '..', 'src', 'core', 'parser.js'), 'utf8'), sb);
const parseSchema = sb.window.parseSchema;

const { mountTablesDesigner } = await import('../src/tables-designer.js');

let fail = 0;
const ck = (n, c, e) => { if (c) console.log('ok:', n); else { fail++; console.log('FAIL:', n, e ?? ''); } };
const tick = ms => new Promise(r => setTimeout(r, ms));

const schema = parseSchema(`
CREATE DATABASE shop; USE shop;
CREATE TABLE item (
 id INT UNSIGNED NOT NULL AUTO_INCREMENT,
 name VARCHAR(50) NOT NULL,
 price DECIMAL(6,2),
 PRIMARY KEY(id)
);
CREATE TABLE tag (
 id INT UNSIGNED NOT NULL AUTO_INCREMENT,
 label VARCHAR(30) NOT NULL,
 PRIMARY KEY(id)
);`);

const ran = [];
const written = [];
const hooks = {
  runScript: async (sql, source) => { ran.push({ sql, source }); return true; },
  writeSchema: async model => written.push(model.map(t => t.origName).join(',')),
  openTable: () => {},
  reload: () => {},
  toast: () => {}
};

const host = document.querySelector('#host');
mountTablesDesigner(host, schema, hooks);

ck('cards for existing tables', host.querySelectorAll('.dz-card').length === 2, host.querySelectorAll('.dz-card').length);
ck('columns prefilled', [...host.querySelectorAll('.dz-card')][0].querySelectorAll('.dz-col').length === 3);

// ---- rename a column, then blur (focus leaves) → CHANGE ----
const nameInput = [...host.querySelectorAll('.dz-cname')].find(i => i.value === 'name');
nameInput.value = 'title';
nameInput.dispatchEvent(new window.Event('input', { bubbles: true }));
host.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
await tick(400);
ck('rename → CHANGE on blur',
  ran.some(r => r.sql.includes('ALTER TABLE `item` CHANGE `name` `title` VARCHAR(50) NOT NULL')),
  JSON.stringify(ran.map(r => r.sql)));
ck('schema.sql regenerated', written.length >= 1);

// ---- rename + immediately rename back before blur → nothing committed ----
ran.length = 0;
const titleInput = [...host.querySelectorAll('.dz-cname')].find(i => i.value === 'title');
titleInput.value = 'temp';
titleInput.dispatchEvent(new window.Event('input', { bubbles: true }));
titleInput.value = 'title';
titleInput.dispatchEvent(new window.Event('input', { bubbles: true }));
host.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
await tick(400);
ck('no-op edit commits nothing', ran.length === 0, JSON.stringify(ran.map(r => r.sql)));

// ---- + column commits pending, then adds a draft; naming + blur → ADD ----
ran.length = 0;
const itemCard = [...host.querySelectorAll('.dz-card')][0];
[...itemCard.querySelectorAll('button')].find(b => b.textContent === '+ column').click();
await tick(50);
const draft = [...host.querySelectorAll('.dz-cname')].find(i => i.value === '');
ck('draft column input focused-ish', !!draft);
draft.value = 'stock';
draft.dispatchEvent(new window.Event('input', { bubbles: true }));
host.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
await tick(400);
ck('new column → ADD',
  ran.some(r => r.sql.includes('ALTER TABLE `item` ADD `stock` VARCHAR(255) NOT NULL')),
  JSON.stringify(ran.map(r => r.sql)));

// ---- drop a column → immediate confirmed commit ----
ran.length = 0;
const tagCard = [...host.querySelectorAll('.dz-card')][1];
const labelRow = [...tagCard.querySelectorAll('.dz-col')].find(r => r.querySelector('.dz-cname').value === 'label');
labelRow.querySelector('.iconbtn').click();
await tick(100);
ck('drop column → DROP COLUMN', ran.some(r => r.sql.includes('ALTER TABLE `tag` DROP COLUMN `label`')), JSON.stringify(ran.map(r => r.sql)));

// ---- add a whole new table: + table, name it, blur → CREATE ----
ran.length = 0;
[...host.querySelectorAll('button')].find(b => b.textContent === '+ add table').click();
await tick(100);
const newName = [...host.querySelectorAll('.dz-tname')].find(i => i.value === '');
newName.value = 'category';
newName.dispatchEvent(new window.Event('input', { bubbles: true }));
host.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
await tick(400);
ck('new table → CREATE with id PK',
  ran.some(r => /CREATE TABLE `category` \(\n `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,\n PRIMARY KEY\(`id`\)\n\)/.test(r.sql)),
  JSON.stringify(ran.map(r => r.sql)));

// ---- drop a whole table ----
ran.length = 0;
const tagCard2 = [...host.querySelectorAll('.dz-card')].find(c => c.querySelector('.dz-tname').value === 'tag');
[...tagCard2.querySelectorAll('.dz-head .iconbtn')].pop().click();
await tick(100);
ck('drop table → DROP TABLE', ran.some(r => r.sql.includes('DROP TABLE `tag`')), JSON.stringify(ran.map(r => r.sql)));

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');
process.exit(fail ? 1 : 0);
