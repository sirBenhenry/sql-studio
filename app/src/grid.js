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
    limit: (hooks.rowLimit && hooks.rowLimit()) || 500,
    sort: null,     // { col, dir: 'ASC'|'DESC' }
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
    if (v === "''") return "''"; // typed two quotes = an actual empty string
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
    const order = state.sort ? ' ORDER BY `' + state.sort.col + '` ' + state.sort.dir : '';
    const res = await hooks.exec('SELECT * FROM `' + state.table.name + '`' + order + ' LIMIT ' + state.limit);
    if (!res) {
      // never leave whatever was on screen before — show the failure
      host.textContent = '';
      host.appendChild(el('p', 'hint pad',
        'could not read ' + state.table.name + ' from the database — the console below has the exact error. ' +
        '(Does the table exist in the DATABASE, not just in schema.sql?)'));
      const retry = el('button', 'btn small', '↻ try again');
      retry.style.marginLeft = '14px';
      retry.addEventListener('click', load);
      host.appendChild(retry);
      return;
    }
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
      state.rows[rowIdx][colIdx] = newVal === '' ? null : newVal === "''" ? '' : newVal;
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

  /* ---- FK columns get live search: type a name, pick the row, the id
     fills in (hooks.lookupFkRows queries the referenced table) ---- */
  const sug = el('div', 'grid-suggest');
  sug.style.display = 'none';
  let sugFor = null;
  let sugT = null;
  let sugIdx = -1;
  function hideSug() { sug.style.display = 'none'; sugFor = null; sugIdx = -1; }
  function showSug(inp, items) {
    if (!items.length) { hideSug(); return; }
    sug.textContent = '';
    for (const it of items) {
      const line = el('div', 'grid-sug-item', it.label);
      line.addEventListener('mousedown', ev => {
        ev.preventDefault(); // keep focus — blur would commit the cell
        inp.value = it.id == null ? '' : String(it.id);
        // the input's own realm's Event — a foreign-realm Event throws in strict DOMs
        const Ev = inp.ownerDocument.defaultView.Event;
        inp.dispatchEvent(new Ev('input', { bubbles: true }));
        clearTimeout(sugT); // don't re-suggest the id that was just picked
        hideSug();
      });
      sug.appendChild(line);
    }
    const r = inp.getBoundingClientRect();
    sug.style.left = r.left + 'px';
    sug.style.top = (r.bottom + 2) + 'px';
    sug.style.minWidth = Math.max(r.width, 160) + 'px';
    sug.style.display = 'block';
    sugFor = inp;
  }
  function wireFkSearch(inp, colName) {
    const fk = (state.table.fks || []).find(f => f.col === colName);
    if (!fk || !hooks.lookupFkRows) return;
    if (!inp.disabled) inp.placeholder = colName + ' — type to search ' + fk.refTable;
    inp.title = 'foreign key to ' + fk.refTable + '.' + fk.refCol + ' — type a value to search that table';
    inp.addEventListener('input', () => {
      clearTimeout(sugT);
      const q = inp.value.trim();
      if (!q) { hideSug(); return; }
      sugT = setTimeout(async () => {
        try {
          const items = await hooks.lookupFkRows(fk.refTable, fk.refCol, q);
          if (document.activeElement === inp && inp.value.trim() === q) showSug(inp, items);
        } catch { hideSug(); }
      }, 150);
    });
    inp.addEventListener('blur', () => setTimeout(() => { if (sugFor === inp) hideSug(); }, 120));
    inp.addEventListener('keydown', e => {
      if (sugFor !== inp || sug.style.display === 'none') {
        if (e.key === 'Escape') hideSug();
        return;
      }
      const items = [...sug.querySelectorAll('.grid-sug-item')];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        sugIdx = e.key === 'ArrowDown' ? Math.min(items.length - 1, sugIdx + 1) : Math.max(0, sugIdx - 1);
        items.forEach((it, i) => it.classList.toggle('active', i === sugIdx));
      } else if (e.key === 'Enter' && sugIdx >= 0) {
        e.preventDefault();
        e.stopPropagation(); // Enter must pick, not commit the cell / insert the row
        items[sugIdx].dispatchEvent(new (inp.ownerDocument.defaultView.MouseEvent)('mousedown', { bubbles: true }));
      } else if (e.key === 'Escape') {
        hideSug();
      }
    }, true);
  }

  function cellEditor(td, rowIdx, colIdx) {
    if (!editable) return;
    td.addEventListener('dblclick', () => {
      if (td.querySelector('input')) return;
      const old = state.rows[rowIdx][colIdx];
      td.textContent = '';
      const inp = el('input', 'cell-edit');
      const oldStr = old == null ? '' : String(old);
      inp.value = oldStr;
      wireFkSearch(inp, state.columns[colIdx]);
      td.appendChild(inp);
      inp.focus();
      inp.select();
      // clicking away commits, like everywhere else in the app; Escape cancels
      let done = false;
      inp.title = 'blank = NULL · two quotes \'\' = an empty string';
      const commit = () => {
        if (done) return;
        done = true;
        if (inp.value === oldStr) { render(); return; } // nothing changed
        updateCell(rowIdx, colIdx, inp.value);
      };
      const cancel = () => { if (done) return; done = true; render(); };
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') cancel();
      });
      inp.addEventListener('blur', commit);
    });
  }

  function render() {
    host.textContent = '';

    const head = el('div', 'grid-head');
    head.appendChild(el('span', 'grid-title', state.table.name));
    head.appendChild(el('span', 'grid-note',
      state.rows.length + ' row' + (state.rows.length === 1 ? '' : 's') +
      (state.rows.length >= state.limit ? ' (first ' + state.limit + ')' : '') +
      (editable ? ' · double-click a cell to edit · click a header to sort' : ' · read-only (no primary key)')));
    if (state.rows.length >= state.limit) {
      const more = el('button', 'btn small', '+ load more');
      more.title = 'show ' + state.limit + ' more rows';
      more.addEventListener('click', () => { state.limit *= 2; load(); });
      head.appendChild(more);
    }
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
      const sorted = state.sort && state.sort.col === c;
      const th = el('th', null, c + (sorted ? (state.sort.dir === 'ASC' ? ' ▲' : ' ▼') : ''));
      const def = state.table.columns.find(x => x.name === c);
      if (def && def.pk) th.classList.add('pk');
      th.classList.add('sortable');
      th.title = 'sort by ' + c;
      th.addEventListener('click', () => {
        state.sort = sorted && state.sort.dir === 'ASC'
          ? { col: c, dir: 'DESC' }
          : sorted ? null : { col: c, dir: 'ASC' }; // asc → desc → natural
        load();
      });
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
        wireFkSearch(inp, c);
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
    host.appendChild(sug); // render() clears the host — keep the dropdown alive
  }

  load();
  return { reload: load };
}
