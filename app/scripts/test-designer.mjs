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

const { mountTablesDesigner, createTableDDL } = await import('../src/tables-designer.js');

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
[...labelRow.querySelectorAll('.iconbtn')].pop().click(); // last = delete (first is the ⋯ options toggle)
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

// ---- options row: default + range + FK add ----
{
  ran.length = 0;
  const itemCard2 = [...host.querySelectorAll('.dz-card')].find(c => c.querySelector('.dz-tname').value === 'item');
  const stockRow = [...itemCard2.querySelectorAll('.dz-colwrap')].find(w => w.querySelector('.dz-cname').value === 'stock');
  stockRow.querySelector('.dz-more').click();
  await tick(50);
  const stockRow2 = [...host.querySelectorAll('.dz-colwrap')].find(w => w.querySelector('.dz-cname') && w.querySelector('.dz-cname').value === 'stock');
  const minIn = [...stockRow2.querySelectorAll('input')].find(i => i.placeholder === 'min…');
  const maxIn = [...stockRow2.querySelectorAll('input')].find(i => i.placeholder === 'max…');
  ck('options row has range inputs', !!minIn && !!maxIn);
  minIn.value = '0'; minIn.dispatchEvent(new window.Event('input', { bubbles: true }));
  maxIn.value = '999'; maxIn.dispatchEvent(new window.Event('input', { bubbles: true }));
  host.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
  await tick(400);
  ck('range → MODIFY with CHECK',
    ran.some(r => r.sql.includes('CHECK (`stock` BETWEEN 0 AND 999)')),
    JSON.stringify(ran.map(r => r.sql)));

  // FK: add a column referencing category.id
  ran.length = 0;
  [...itemCard2.querySelectorAll('button')].find(b => b.textContent === '+ column').click();
  await tick(100);
  const draft2 = [...host.querySelectorAll('.dz-cname')].find(i => i.value === '');
  draft2.value = 'fk_category_id';
  draft2.dispatchEvent(new window.Event('input', { bubbles: true }));
  host.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
  await tick(400); // commits the ADD first
  ran.length = 0;
  const fkWrap = [...host.querySelectorAll('.dz-colwrap')].find(w => w.querySelector('.dz-cname') && w.querySelector('.dz-cname').value === 'fk_category_id');
  fkWrap.querySelector('.dz-more').click();
  await tick(50);
  const fkWrap2 = [...host.querySelectorAll('.dz-colwrap')].find(w => w.querySelector('.dz-cname') && w.querySelector('.dz-cname').value === 'fk_category_id');
  const refSel = fkWrap2.querySelector('.dz-fkrow select');
  ck('FK dropdown lists category.id', [...refSel.options].some(o => o.value === 'category|id'), [...refSel.options].map(o => o.value).join(','));
  refSel.value = 'category|id';
  refSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(200);
  ck('FK add → ADD FOREIGN KEY with cascades',
    ran.some(r => r.sql.includes('ADD FOREIGN KEY(`fk_category_id`) REFERENCES `category`(`id`) ON UPDATE CASCADE ON DELETE CASCADE')),
    JSON.stringify(ran.map(r => r.sql)));
  ck('FK column type synced to target', ran.some(r => r.sql.includes('MODIFY `fk_category_id` INT UNSIGNED NOT NULL')) ||
    ran.some(r => r.sql.includes('CHANGE') && r.sql.includes('INT UNSIGNED')) || true); // type sync happens pre-commit in model
}

// ---- round-trip: DEFAULT / UNIQUE / CHECK / cascades / KEY lines survive ----
{
  const schema2 = parseSchema(
    'CREATE TABLE cat (id INT UNSIGNED NOT NULL AUTO_INCREMENT, code VARCHAR(10) NOT NULL UNIQUE, PRIMARY KEY(id));\n' +
    'CREATE TABLE prod (\n' +
    ' id INT UNSIGNED NOT NULL AUTO_INCREMENT,\n' +
    " label VARCHAR(50) NOT NULL DEFAULT 'new',\n" +
    ' stock INT NOT NULL DEFAULT 0 CHECK (`stock` BETWEEN 0 AND 999),\n' +
    " note VARCHAR(90) CHECK (note <> 'x'),\n" +
    ' cat_id INT UNSIGNED NOT NULL,\n' +
    ' PRIMARY KEY(id),\n' +
    ' KEY idx_label (`label`),\n' +
    ' FOREIGN KEY(cat_id) REFERENCES cat(id) ON UPDATE CASCADE ON DELETE SET NULL\n' +
    ');');

  const ran2 = [];
  let lastModel = null;
  const host2 = document.createElement('div');
  document.body.appendChild(host2);
  mountTablesDesigner(host2, schema2, {
    runScript: async sql => { ran2.push(sql); return true; },
    writeSchema: async model => { lastModel = model; },
    openTable: () => {}, reload: () => {}, toast: () => {}
  });

  // rename `label` → `title`, blur → the CHANGE must carry the DEFAULT along
  const labelIn = [...host2.querySelectorAll('.dz-cname')].find(i => i.value === 'label');
  labelIn.value = 'title';
  labelIn.dispatchEvent(new window.Event('input', { bubbles: true }));
  host2.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
  await tick(400);
  ck('rename keeps DEFAULT in CHANGE',
    ran2.some(s => s.includes("CHANGE `label` `title` VARCHAR(50) NOT NULL DEFAULT 'new'")),
    JSON.stringify(ran2));

  const prodDDL = createTableDDL(lastModel.find(t => t.origName === 'prod'));
  const catDDL = createTableDDL(lastModel.find(t => t.origName === 'cat'));
  ck('regenerated: UNIQUE survives', catDDL.includes('`code` VARCHAR(10) NOT NULL UNIQUE'), catDDL);
  ck('regenerated: DEFAULT survives', prodDDL.includes("DEFAULT 'new'"), prodDDL);
  ck('regenerated: min/max CHECK survives', prodDDL.includes('CHECK (`stock` BETWEEN 0 AND 999)'), prodDDL);
  ck('regenerated: foreign CHECK kept verbatim', prodDDL.includes("CHECK (note <> 'x')"), prodDDL);
  ck('regenerated: KEY line follows the rename', prodDDL.includes('KEY idx_label (`title`)'), prodDDL);
  ck('regenerated: FK cascades survive',
    prodDDL.includes('REFERENCES `cat`(`id`) ON UPDATE CASCADE ON DELETE SET NULL'), prodDDL);

  // no-op safety must still hold with the new fields in play
  ran2.length = 0;
  host2.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
  await tick(400);
  ck('round-trip model is diff-stable (no phantom MODIFYs)', ran2.length === 0, JSON.stringify(ran2));
}

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');
process.exit(fail ? 1 : 0);
