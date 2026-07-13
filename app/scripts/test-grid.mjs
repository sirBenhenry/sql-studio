// Grid + overview logic test in jsdom: mounts the grid against a fake exec
// that emulates the sandbox, verifies UPDATE/INSERT/DELETE SQL generation,
// PK-based row addressing, NULL handling, and the read-only fallback.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<div id="host"></div><div id="ov"></div>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
window.confirm = () => true;

const { mountGrid } = await import('../src/grid.js');
const { renderOverview } = await import('../src/overview.js');

let fail = 0;
const ck = (n, c, e) => { if (c) console.log('ok:', n); else { fail++; console.log('FAIL:', n, e ?? ''); } };
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// fake sandbox: one table, three rows
const executed = [];
const journaled = [];
let rows = [
  ['1', 'lamp', '12.50'],
  ['2', 'chair', null],
  ['3', 'desk', '89.00']
];
const hooks = {
  exec: async sql => {
    executed.push(sql);
    if (/^SELECT \* FROM/.test(sql)) return { columns: ['id', 'name', 'price'], rows, affected: 0, elapsed_ms: 1 };
    return { columns: [], rows: [], affected: 1, elapsed_ms: 1 };
  },
  journal: (source, stmts) => journaled.push({ source, stmts })
};

const tableDef = {
  name: 'item',
  columns: [
    { name: 'id', pk: true, autoInc: true, numeric: true },
    { name: 'name', pk: false, numeric: false },
    { name: 'price', pk: false, numeric: true }
  ],
  fks: []
};

const host = document.querySelector('#host');
mountGrid(host, tableDef, hooks);
await tick(); await tick();

ck('grid loaded rows', host.querySelectorAll('tbody tr').length === 4, host.querySelectorAll('tbody tr').length); // 3 + new-row
ck('NULL cell styled', host.querySelector('td.null') && host.querySelector('td.null').textContent === 'NULL');
ck('PK header marked', host.querySelector('th.pk') && host.querySelector('th.pk').textContent === 'id');

// --- edit a cell: dblclick name of row 2 → type → Enter ---
const row2 = host.querySelectorAll('tbody tr')[1];
const nameTd = row2.children[1];
nameTd.dispatchEvent(new window.Event('dblclick', { bubbles: true }));
const inp = nameTd.querySelector('input');
ck('editor appears on dblclick', !!inp);
inp.value = 'armchair';
inp.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await tick(); await tick();
const upd = executed.find(s => s.startsWith('UPDATE'));
ck('UPDATE addressed by PK',
  upd === "UPDATE `item` SET `name` = 'armchair' WHERE `id` = 2 LIMIT 1", upd);
ck('update journaled', journaled.some(j => j.source.includes('edit item.name')));

// --- blur commits an edit (Excel rule); Escape cancels; no-change is a no-op ---
{
  executed.length = 0;
  const r2 = host.querySelectorAll('tbody tr')[1];
  const td = r2.children[1];
  td.dispatchEvent(new window.Event('dblclick', { bubbles: true }));
  const e1 = td.querySelector('input');
  e1.value = 'bench';
  e1.dispatchEvent(new window.Event('blur'));
  await tick(); await tick();
  ck('blur commits the edit', executed.some(s => s.includes("SET `name` = 'bench'")), JSON.stringify(executed));

  executed.length = 0;
  const r2b = host.querySelectorAll('tbody tr')[1];
  const td2 = r2b.children[1];
  td2.dispatchEvent(new window.Event('dblclick', { bubbles: true }));
  const e2 = td2.querySelector('input');
  e2.value = 'ignored';
  e2.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick(); await tick();
  ck('Escape cancels the edit', executed.length === 0, JSON.stringify(executed));

  executed.length = 0;
  const r2c = host.querySelectorAll('tbody tr')[1];
  const td3 = r2c.children[1];
  td3.dispatchEvent(new window.Event('dblclick', { bubbles: true }));
  const e3 = td3.querySelector('input');
  e3.dispatchEvent(new window.Event('blur')); // untouched value
  await tick(); await tick();
  ck('unchanged blur issues no UPDATE', executed.length === 0, JSON.stringify(executed));
}

// --- insert via the + row ---
const newRow = host.querySelector('tr.new-row');
const inputs = [...newRow.querySelectorAll('input')];
ck('auto-inc input disabled', inputs[0].disabled);
inputs[1].value = 'shelf';
inputs[2].value = '45';
inputs[1].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await tick(); await tick();
const ins = executed.find(s => s.startsWith('INSERT'));
ck('INSERT skips auto-inc, quotes text, bare number',
  ins === "INSERT INTO `item` (`name`, `price`) VALUES ('shelf', 45)", ins);

// --- delete row 1 ---
const delBtn = host.querySelectorAll('tbody tr')[0].querySelector('.row-del button');
delBtn.click();
await tick(); await tick();
const del = executed.find(s => s.startsWith('DELETE'));
ck('DELETE addressed by PK', del === 'DELETE FROM `item` WHERE `id` = 1 LIMIT 1', del);

// --- FK column search: type a name, pick a row, the id fills in ---
{
  const lookups = [];
  const hostFk = document.createElement('div');
  document.body.appendChild(hostFk);
  mountGrid(hostFk, {
    name: 'task',
    columns: [{ name: 'id', pk: true, autoInc: true, numeric: true }, { name: 'person_id', numeric: true }],
    fks: [{ col: 'person_id', refTable: 'person', refCol: 'id' }]
  }, {
    exec: async () => ({ columns: ['id', 'person_id'], rows: [], affected: 0, elapsed_ms: 0 }),
    journal: () => {},
    lookupFkRows: async (t, c, q) => { lookups.push({ t, c, q }); return [{ id: '2', label: '2 · Anna' }]; }
  });
  await tick(); await tick();
  const fkInp = [...hostFk.querySelectorAll('tr.new-row input')][1];
  ck('FK input announces its search', fkInp.placeholder.includes('search person'), fkInp.placeholder);
  fkInp.focus();
  fkInp.value = 'ann';
  fkInp.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(250);
  ck('FK search queried the referenced table',
    lookups.some(l => l.t === 'person' && l.c === 'id' && l.q === 'ann'), JSON.stringify(lookups));
  const sug = hostFk.querySelector('.grid-suggest');
  ck('suggestions visible', sug && sug.style.display === 'block', sug && sug.style.display);
  sug.querySelector('.grid-sug-item').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  ck('picking fills in the id', fkInp.value === '2', fkInp.value);
  ck('dropdown hidden after pick', sug.style.display === 'none', sug.style.display);
}

// --- read-only when no PK ---
const host2 = document.createElement('div');
document.body.appendChild(host2);
mountGrid(host2, { name: 'nopk', columns: [{ name: 'a' }], fks: [] }, hooks);
await tick(); await tick();
ck('no-PK grid is read-only', host2.textContent.includes('read-only'), host2.textContent.slice(0, 120));
ck('no + row without PK', !host2.querySelector('tr.new-row'));

// --- overview ---
const schema = { tables: [tableDef, { name: 'genre', columns: [{ name: 'id', pk: true }], fks: [] }], byName: {} };
let opened = null;
renderOverview(document.querySelector('#ov'), schema, { item: 3, genre: 0 }, { openTable: n => opened = n });
ck('overview renders cards', document.querySelectorAll('#ov .ov-card').length === 2);
document.querySelector('#ov .ov-card').click();
ck('card click opens table', opened === 'item', opened);

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');
process.exit(fail ? 1 : 0);
