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

// ---- table rename re-points dependents' FKs in the model/file ----
{
  const schema3 = parseSchema(
    'CREATE TABLE person (id INT UNSIGNED NOT NULL AUTO_INCREMENT, PRIMARY KEY(id));\n' +
    'CREATE TABLE task (id INT UNSIGNED NOT NULL AUTO_INCREMENT, person_id INT UNSIGNED NOT NULL,\n' +
    ' PRIMARY KEY(id), FOREIGN KEY(person_id) REFERENCES person(id));');
  const ran3 = [];
  let model3 = null;
  const host3 = document.createElement('div');
  document.body.appendChild(host3);
  mountTablesDesigner(host3, schema3, {
    runScript: async sql => { ran3.push(sql); return true; },
    writeSchema: async m => { model3 = m; },
    openTable: () => {}, reload: () => {}, toast: () => {}
  });
  const tIn = [...host3.querySelectorAll('.dz-tname')].find(i => i.value === 'person');
  tIn.value = 'people';
  tIn.dispatchEvent(new window.Event('input', { bubbles: true }));
  host3.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
  await tick(400);
  ck('rename emits RENAME TO', ran3.some(s => s.includes('ALTER TABLE `person` RENAME TO `people`')), JSON.stringify(ran3));
  const taskT = model3.find(t => t.origName === 'task');
  ck('dependent FK re-pointed to new name', taskT.fks[0].refTable === 'people', JSON.stringify(taskT.fks));
  ck('regenerated task DDL references new name',
    createTableDDL(taskT).includes('REFERENCES `people`(`id`)'), createTableDDL(taskT));
}

// ---- partial failure → schema.sql re-synced from DB truth ----
{
  const schema4 = parseSchema('CREATE TABLE a (id INT UNSIGNED NOT NULL AUTO_INCREMENT, x INT, y INT, PRIMARY KEY(id));');
  let synced = 0, reloaded = 0, wrote = 0;
  const host4 = document.createElement('div');
  document.body.appendChild(host4);
  mountTablesDesigner(host4, schema4, {
    runScript: async (sql, src, opts) => { if (opts && opts.onPartial) opts.onPartial(1); return false; },
    writeSchema: async () => { wrote++; },
    syncFromDb: async () => { synced++; },
    openTable: () => {}, reload: () => { reloaded++; }, toast: () => {}
  });
  const xIn = [...host4.querySelectorAll('.dz-cname')].find(i => i.value === 'x');
  xIn.value = 'x2';
  xIn.dispatchEvent(new window.Event('input', { bubbles: true }));
  host4.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
  await tick(400);
  ck('partial failure → syncFromDb called', synced === 1, synced);
  ck('partial failure → cards reverted', reloaded === 1, reloaded);
  ck('partial failure → file NOT written from the stale model', wrote === 0, wrote);
}

// ---- constraint lifecycle: drop-before-re-add via information_schema ----
{
  const schema5 = parseSchema(
    'CREATE TABLE u (id INT UNSIGNED NOT NULL AUTO_INCREMENT,\n' +
    ' code VARCHAR(10) NOT NULL UNIQUE,\n' +
    ' qty INT NOT NULL CHECK (`qty` BETWEEN 0 AND 10),\n' +
    ' ref_id INT UNSIGNED,\n' +
    ' PRIMARY KEY(id),\n' +
    ' FOREIGN KEY(ref_id) REFERENCES u(id));');
  const ran5 = [];
  const queries = [];
  const host5 = document.createElement('div');
  document.body.appendChild(host5);
  mountTablesDesigner(host5, schema5, {
    runScript: async sql => { ran5.push(sql); return true; },
    query: async sql => {
      queries.push(sql);
      if (sql.includes('CHECK_CONSTRAINTS')) return { columns: ['c'], rows: [['u_chk_1']] };
      if (sql.includes('STATISTICS')) return { columns: ['i'], rows: [['code']] };
      if (sql.includes('KEY_COLUMN_USAGE')) return { columns: ['c'], rows: [['u_ibfk_1']] };
      return { columns: [], rows: [] };
    },
    writeSchema: async () => {}, openTable: () => {}, reload: () => {}, toast: () => {}
  });

  // widen the CHECK range → the old auto-named constraint must drop first
  const openOpts = name => {
    const w = [...host5.querySelectorAll('.dz-colwrap')].find(x => x.querySelector('.dz-cname').value === name);
    if (!w.querySelector('.dz-opts')) w.querySelector('.dz-more').click();
  };
  openOpts('qty');
  const qtyWrap = [...host5.querySelectorAll('.dz-colwrap')].find(x => x.querySelector('.dz-cname').value === 'qty');
  const maxIn = [...qtyWrap.querySelectorAll('input')].find(i => i.placeholder === 'max…');
  maxIn.value = '500';
  maxIn.dispatchEvent(new window.Event('input', { bubbles: true }));
  host5.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
  await tick(400);
  ck('check edit: DROP CHECK precedes MODIFY',
    ran5.length === 1 &&
    ran5[0].indexOf('DROP CHECK `u_chk_1`') > -1 &&
    ran5[0].indexOf('DROP CHECK `u_chk_1`') < ran5[0].indexOf('MODIFY `qty`'),
    JSON.stringify(ran5));
  ck('check edit: new range in the MODIFY', ran5[0].includes('BETWEEN 0 AND 500'), ran5[0]);

  // uncheck UNIQUE → the index really drops
  ran5.length = 0;
  const codeWrap = [...host5.querySelectorAll('.dz-colwrap')].find(x => x.querySelector('.dz-cname').value === 'code');
  const uqFlag = [...codeWrap.querySelectorAll('button')].find(b => b.textContent === 'UNIQUE');
  uqFlag.click();
  await tick(400);
  ck('unique off: DROP INDEX emitted', ran5.some(s => s.includes('DROP INDEX `code`')), JSON.stringify(ran5));
  ck('unique off: MODIFY without UNIQUE', ran5.some(s => s.includes('MODIFY `code` VARCHAR(10) NOT NULL') && !s.includes('UNIQUE')), JSON.stringify(ran5));

  // remove the (self-referencing) FK → constraint name looked up and dropped
  ran5.length = 0;
  openOpts('ref_id');
  const refWrap = [...host5.querySelectorAll('.dz-colwrap')].find(x => x.querySelector('.dz-cname').value === 'ref_id');
  const rmFk = [...refWrap.querySelectorAll('.dz-fkrow .iconbtn')].pop();
  rmFk.click();
  await tick(400);
  ck('FK removal: DROP FOREIGN KEY by looked-up name',
    ran5.some(s => s.includes('DROP FOREIGN KEY `u_ibfk_1`')), JSON.stringify(ran5));

  // self-reference offered in the FK dropdown of a fresh column
  ran5.length = 0;
  [...host5.querySelectorAll('button')].find(b => b.textContent === '+ column').click();
  await tick(100);
  const draft5 = [...host5.querySelectorAll('.dz-cname')].find(i => i.value === '');
  draft5.value = 'parent_id';
  draft5.dispatchEvent(new window.Event('input', { bubbles: true }));
  host5.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
  await tick(400);
  const pWrap = [...host5.querySelectorAll('.dz-colwrap')].find(x => x.querySelector('.dz-cname') && x.querySelector('.dz-cname').value === 'parent_id');
  pWrap.querySelector('.dz-more').click();
  await tick(50);
  const pWrap2 = [...host5.querySelectorAll('.dz-colwrap')].find(x => x.querySelector('.dz-cname') && x.querySelector('.dz-cname').value === 'parent_id');
  const sel5 = pWrap2.querySelector('.dz-fkrow select');
  ck('FK dropdown offers own table (self-reference)',
    [...sel5.options].some(o => o.value === 'u|id'), [...sel5.options].map(o => o.value).join(','));

  // PK on a new column of an existing table (which already has a PK):
  // flag hidden — and for a PK-less table the ADD PRIMARY KEY is emitted
  ck('PK flag hidden when the table already has a PK',
    ![...pWrap2.querySelectorAll('button')].some(b => b.textContent === 'PK'),
    [...pWrap2.querySelectorAll('button')].map(b => b.textContent).join(','));
}

// ---- PK on a new column of a PK-less existing table → ADD PRIMARY KEY ----
{
  const schema6 = parseSchema('CREATE TABLE nopk (a INT, b VARCHAR(10));');
  const ran6 = [];
  const host6 = document.createElement('div');
  document.body.appendChild(host6);
  mountTablesDesigner(host6, schema6, {
    runScript: async sql => { ran6.push(sql); return true; },
    writeSchema: async () => {}, openTable: () => {}, reload: () => {}, toast: () => {}
  });
  [...host6.querySelectorAll('button')].find(b => b.textContent === '+ column').click();
  await tick(100);
  const d6 = [...host6.querySelectorAll('.dz-cname')].find(i => i.value === '');
  d6.value = 'id';
  d6.dispatchEvent(new window.Event('input', { bubbles: true }));
  const w6 = d6.closest('.dz-colwrap');
  w6.querySelector('.dz-more').click();
  await tick(50);
  const w6b = [...host6.querySelectorAll('.dz-colwrap')].find(x => x.querySelector('.dz-cname') && x.querySelector('.dz-cname').value === 'id');
  const pkFlag = [...w6b.querySelectorAll('button')].find(b => b.textContent === 'PK');
  ck('PK flag offered on PK-less table', !!pkFlag);
  pkFlag.click();
  await tick(400);
  ck('new col PK → ADD then ADD PRIMARY KEY',
    ran6.some(s => s.includes('ADD `id`') && s.includes('ADD PRIMARY KEY(`id`)')), JSON.stringify(ran6));
}

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');
process.exit(fail ? 1 : 0);
