// grid.js — the Excel-like table view: browse a table's rows, edit cells
// (UPDATE), add rows (INSERT), delete rows (DELETE). Every change executes
// against the live sandbox and is journaled through the hooks the host
// provides. Requires the table to have a primary key for editing; without
// one the grid is read-only (shown in the header).
'use strict';

export function mountGrid(host, table, hooks) {
  // hooks: { exec(sql) -> Promise<res|null>, journal(source, stmts), refreshCount() }
  const state = {
    table,          // {name, columns:[{name,pk,autoInc,numeric,boolean}], pkCols:[names]}
    rows: [],
    columns: [],
    limit: 500,
    dirty: false
  };

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  const esc = v => String(v).replace(/'/g, "''");
  const lit = (v, colName) => {
    if (v == null || v === '') return 'NULL';
    const col = state.table.columns.find(c => c.name === colName);
    if (col && col.numeric && /^-?\d+(\.\d+)?$/.test(String(v).trim())) return String(v).trim();
    if (/^(NOW\(\)|CURRENT_TIMESTAMP|CURDATE\(\)|CURTIME\(\))$/i.test(String(v).trim())) return String(v).trim().toUpperCase();
    return "'" + esc(v) + "'";
  };

  const pkCols = state.table.columns.filter(c => c.pk).map(c => c.name);
  const editable = pkCols.length > 0;

  function whereForRow(rowIdx) {
    // match by primary key values captured at load time
    return pkCols
      .map(pk => {
        const ci = state.columns.indexOf(pk);
        const v = state.rows[rowIdx][ci];
        return '`' + pk + '` ' + (v == null ? 'IS NULL' : '= ' + lit(v, pk));
      })
      .join(' AND ');
  }

  async function load() {
    const res = await hooks.exec('SELECT * FROM `' + state.table.name + '` LIMIT ' + state.limit);
    if (!res) return;
    state.columns = res.columns;
    state.rows = res.rows;
    render();
  }

  async function updateCell(rowIdx, colIdx, newVal) {
    const col = state.columns[colIdx];
    const sql = 'UPDATE `' + state.table.name + '` SET `' + col + '` = ' + lit(newVal, col) +
      ' WHERE ' + whereForRow(rowIdx) + ' LIMIT 1';
    const res = await hooks.exec(sql);
    if (res) {
      hooks.journal('grid: edit ' + state.table.name + '.' + col, [sql]);
      state.rows[rowIdx][colIdx] = newVal === '' ? null : newVal;
    }
    render();
  }

  async function insertRow(values) {
    const cols = [];
    const vals = [];
    state.columns.forEach((c, i) => {
      const colDef = state.table.columns.find(x => x.name === c);
      if (colDef && colDef.autoInc) return; // db assigns
      if (values[i] === '' || values[i] == null) return; // DEFAULT
      cols.push('`' + c + '`');
      vals.push(lit(values[i], c));
    });
    const sql = cols.length
      ? 'INSERT INTO `' + state.table.name + '` (' + cols.join(', ') + ') VALUES (' + vals.join(', ') + ')'
      : 'INSERT INTO `' + state.table.name + '` () VALUES ()';
    const res = await hooks.exec(sql);
    if (res) {
      hooks.journal('grid: insert into ' + state.table.name, [sql]);
      await load();
    }
  }

  async function deleteRow(rowIdx) {
    const sql = 'DELETE FROM `' + state.table.name + '` WHERE ' + whereForRow(rowIdx) + ' LIMIT 1';
    const needConfirm = !hooks.shouldConfirm || hooks.shouldConfirm();
    if (needConfirm && !window.confirm('Delete this row from ' + state.table.name + '?\n\n' + sql)) return;
    const res = await hooks.exec(sql);
    if (res) {
      hooks.journal('grid: delete from ' + state.table.name, [sql]);
      state.rows.splice(rowIdx, 1);
    }
    render();
  }

  function cellEditor(td, rowIdx, colIdx) {
    if (!editable) return;
    td.addEventListener('dblclick', () => {
      if (td.querySelector('input')) return;
      const old = state.rows[rowIdx][colIdx];
      td.textContent = '';
      const inp = el('input', 'cell-edit');
      inp.value = old == null ? '' : old;
      td.appendChild(inp);
      inp.focus();
      inp.select();
      const commit = () => updateCell(rowIdx, colIdx, inp.value);
      const cancel = () => render();
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') cancel();
      });
      inp.addEventListener('blur', cancel);
    });
  }

  function render() {
    host.textContent = '';

    const head = el('div', 'grid-head');
    head.appendChild(el('span', 'grid-title', state.table.name));
    head.appendChild(el('span', 'grid-note',
      state.rows.length + ' row' + (state.rows.length === 1 ? '' : 's') +
      (state.rows.length >= state.limit ? ' (first ' + state.limit + ')' : '') +
      (editable ? ' · double-click a cell to edit' : ' · read-only (no primary key)')));
    const reload = el('button', 'btn small', '↻');
    reload.title = 'reload';
    reload.addEventListener('click', load);
    head.appendChild(reload);
    host.appendChild(head);

    const scroll = el('div', 'grid-scroll');
    const table = el('table', 'result-table grid-table');
    const thead = el('thead');
    const hr = el('tr');
    for (const c of state.columns) {
      const th = el('th', null, c);
      const def = state.table.columns.find(x => x.name === c);
      if (def && def.pk) th.classList.add('pk');
      hr.appendChild(th);
    }
    if (editable) hr.appendChild(el('th', null, ''));
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = el('tbody');
    state.rows.forEach((row, ri) => {
      const tr = el('tr');
      row.forEach((cell, ci) => {
        const td = el('td', cell == null ? 'null' : null, cell == null ? 'NULL' : cell);
        cellEditor(td, ri, ci);
        tr.appendChild(td);
      });
      if (editable) {
        const td = el('td', 'row-del');
        const x = el('button', 'iconbtn', '✕');
        x.title = 'delete row';
        x.addEventListener('click', () => deleteRow(ri));
        td.appendChild(x);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });

    // the + row: type values, press Enter → INSERT
    if (editable) {
      const tr = el('tr', 'new-row');
      const inputs = [];
      state.columns.forEach(c => {
        const td = el('td');
        const def = state.table.columns.find(x => x.name === c);
        const inp = el('input', 'cell-edit');
        inp.placeholder = def && def.autoInc ? 'auto' : c;
        inp.disabled = !!(def && def.autoInc);
        inputs.push(inp);
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter') insertRow(inputs.map(i => i.value));
        });
        td.appendChild(inp);
        tr.appendChild(td);
      });
      const td = el('td', 'row-del');
      const add = el('button', 'iconbtn', '+');
      add.title = 'insert row';
      add.addEventListener('click', () => insertRow(inputs.map(i => i.value)));
      td.appendChild(add);
      tr.appendChild(td);
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    scroll.appendChild(table);
    host.appendChild(scroll);
  }

  load();
  return { reload: load };
}
