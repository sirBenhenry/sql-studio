// tables-designer.js — the unified live designer that replaces the builder's
// CREATE and ALTER tabs. Every table in the schema is an editable card; a new
// card is a new table. Changes commit SEMI-LIVE (Ben's rule): when focus
// leaves the designer, and before a new column/table is added. Committing
// executes the diff (CREATE/ALTER/DROP) on the sandbox, journals it, and
// regenerates schema.sql — the file, the database and the cards never drift.
'use strict';

const TYPES = ['INT', 'TINYINT', 'SMALLINT', 'BIGINT', 'DECIMAL', 'FLOAT', 'DOUBLE',
  'VARCHAR', 'CHAR', 'TEXT', 'DATE', 'DATETIME', 'TIME', 'TIMESTAMP', 'BOOLEAN'];
const ARGS_DEFAULT = { VARCHAR: '255', CHAR: '10', DECIMAL: '6,2' };

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

function splitType(typeStr) {
  const m = String(typeStr || 'INT').match(/^([a-zA-Z]+)(?:\(([^)]*)\))?/);
  return { type: m ? m[1].toUpperCase() : 'INT', args: m && m[2] ? m[2] : '' };
}

function cleanIdent(s, fallback) {
  const c = String(s || '').trim().replace(/\s+/g, '_').replace(/[^\w$]/g, '');
  return c || fallback;
}

/** designer model from the shared parser model */
function modelFromSchema(schema) {
  return (schema.tables || []).map(t => ({
    name: t.name,
    origName: t.name,
    fks: t.fks.map(fk => ({ ...fk })),
    cols: t.columns.map(c => {
      const st = splitType(c.type);
      const col = {
        name: c.name, type: st.type, args: st.args,
        uns: !!c.unsigned, nn: !!c.notNull, ai: !!c.autoInc, pk: !!c.pk, def: ''
      };
      col.orig = { ...col };
      return col;
    })
  }));
}

function sameCol(a, b) {
  return a.type === b.type && String(a.args || '') === String(b.args || '') &&
    !!a.uns === !!b.uns && !!a.nn === !!b.nn && !!a.ai === !!b.ai &&
    String(a.def || '') === String(b.def || '');
}

function colDDL(c) {
  let s = '`' + cleanIdent(c.name, 'col') + '` ' + c.type;
  if (String(c.args || '').trim()) s += '(' + String(c.args).trim() + ')';
  if (c.uns) s += ' UNSIGNED';
  if (c.nn) s += ' NOT NULL';
  if (c.ai) s += ' AUTO_INCREMENT';
  if (String(c.def || '').trim()) {
    const d = String(c.def).trim();
    const lit = /^(-?\d+(\.\d+)?|NOW\(\)|CURRENT_TIMESTAMP|CURDATE\(\)|CURTIME\(\)|TRUE|FALSE|NULL)$/i.test(d)
      ? d.toUpperCase().replace(/^(-?\d+(\.\d+)?)$/, d)
      : "'" + d.replace(/'/g, "''") + "'";
    s += ' DEFAULT ' + lit;
  }
  return s;
}

function createTableDDL(t) {
  const lines = t.cols.filter(c => String(c.name || '').trim()).map(c => ' ' + colDDL(c));
  const pks = t.cols.filter(c => c.pk && String(c.name || '').trim()).map(c => '`' + cleanIdent(c.name, 'col') + '`');
  if (pks.length) lines.push(' PRIMARY KEY(' + pks.join(', ') + ')');
  for (const fk of t.fks || []) {
    lines.push(' FOREIGN KEY(`' + fk.col + '`) REFERENCES `' + fk.refTable + '`(`' + fk.refCol + '`)');
  }
  return 'CREATE TABLE `' + cleanIdent(t.name, 'table') + '` (\n' + lines.join(',\n') + '\n)';
}

/** the diff between the committed snapshot and the live cards */
function computeDiff(model, snapshotNames) {
  const stmts = [];
  const destructive = [];

  for (const t of model) {
    const ready = String(t.name || '').trim() && t.cols.some(c => String(c.name || '').trim());
    if (!t.origName) {
      if (ready) stmts.push(createTableDDL(t));
      continue;
    }
    const tbl = '`' + t.origName + '`';
    const seen = new Set();
    for (const c of t.cols) {
      if (!String(c.name || '').trim()) continue;
      if (!c.orig) {
        stmts.push('ALTER TABLE ' + tbl + ' ADD ' + colDDL(c));
        continue;
      }
      seen.add(c.orig.name);
      if (c.name !== c.orig.name) {
        stmts.push('ALTER TABLE ' + tbl + ' CHANGE `' + c.orig.name + '` ' + colDDL(c));
      } else if (!sameCol(c, c.orig)) {
        stmts.push('ALTER TABLE ' + tbl + ' MODIFY ' + colDDL(c));
      }
    }
    for (const oc of t.origCols || []) {
      if (!seen.has(oc)) {
        stmts.push('ALTER TABLE ' + tbl + ' DROP COLUMN `' + oc + '`');
        destructive.push('drop column ' + t.origName + '.' + oc);
      }
    }
    if (t.name !== t.origName && String(t.name || '').trim()) {
      stmts.push('ALTER TABLE ' + tbl + ' RENAME TO `' + cleanIdent(t.name, t.origName) + '`');
    }
  }

  const liveOrig = new Set(model.map(t => t.origName).filter(Boolean));
  for (const name of snapshotNames) {
    if (!liveOrig.has(name)) {
      stmts.push('DROP TABLE `' + name + '`');
      destructive.push('drop table ' + name);
    }
  }
  return { stmts, destructive };
}

export function mountTablesDesigner(host, schema, hooks) {
  // hooks: { runScript(sql, source, opts)->Promise<bool>, writeSchema(model),
  //          openTable(name), toast(msg) }
  let model = modelFromSchema(schema);
  for (const t of model) t.origCols = t.cols.map(c => c.orig.name);
  let snapshotNames = model.map(t => t.origName);
  let committing = false;
  let commitTimer = null;

  /* ---------- semi-live commit ---------- */

  async function commit(reason) {
    if (committing) return;
    const { stmts, destructive } = computeDiff(model, snapshotNames);
    if (!stmts.length) return;
    if (destructive.length &&
        !window.confirm('This will permanently:\n  · ' + destructive.join('\n  · ') + '\n\nContinue?')) {
      reload(); // revert the cards to the committed state
      return;
    }
    committing = true;
    try {
      const ok = await hooks.runScript(stmts.join(';\n') + ';', 'designer: ' + reason, { journal: true });
      if (ok) {
        await hooks.writeSchema(model);
        // refresh snapshots: everything on screen is now the committed truth
        for (const t of model) {
          t.origName = cleanIdent(t.name, t.origName || 'table');
          t.cols = t.cols.filter(c => String(c.name || '').trim());
          for (const c of t.cols) { c.name = cleanIdent(c.name, 'col'); c.orig = { ...c }; delete c.orig.orig; }
          t.origCols = t.cols.map(c => c.name);
        }
        model = model.filter(t => t.origName);
        snapshotNames = model.map(t => t.origName);
        render();
      } else {
        reload(); // DB said no → revert cards to reality
      }
    } finally {
      committing = false;
    }
  }

  function scheduleCommit(reason) {
    clearTimeout(commitTimer);
    commitTimer = setTimeout(() => commit(reason), 250);
  }

  function cancelScheduled() {
    clearTimeout(commitTimer);
  }

  function reload() {
    if (hooks.reload) hooks.reload();
  }

  /* focus leaves the designer → commit; focus returns → hold */
  host.addEventListener('focusout', () => scheduleCommit('edit'));
  host.addEventListener('focusin', cancelScheduled);

  /* ---------- rendering ---------- */

  function inp(cls, value, ph, oninput) {
    const i = el('input', cls);
    i.type = 'text';
    i.spellcheck = false;
    i.value = value != null ? value : '';
    if (ph) i.placeholder = ph;
    i.addEventListener('input', () => oninput(i.value));
    return i;
  }

  function colRow(t, c, ci) {
    const row = el('div', 'dz-col');
    row.appendChild(inp('dz-cname', c.name, 'column_name', v => { c.name = v; }));

    const typeSel = el('select');
    for (const ty of TYPES) {
      const o = el('option', null, ty);
      o.value = ty;
      typeSel.appendChild(o);
    }
    typeSel.value = TYPES.includes(c.type) ? c.type : 'VARCHAR';
    typeSel.addEventListener('change', () => {
      c.type = typeSel.value;
      c.args = ARGS_DEFAULT[c.type] || '';
      render();
      scheduleCommit('type change');
    });
    row.appendChild(typeSel);

    row.appendChild(inp('dz-args', c.args, '(…)', v => { c.args = v; }));

    const flag = (label, key, title) => {
      const b = el('button', 'flag' + (c[key] ? ' on' : ''), label);
      if (title) b.title = title;
      b.addEventListener('click', () => {
        c[key] = !c[key];
        b.classList.toggle('on', c[key]);
        scheduleCommit('flag');
      });
      return b;
    };
    row.appendChild(flag('NN', 'nn', 'NOT NULL'));
    row.appendChild(flag('AI', 'ai', 'AUTO_INCREMENT'));
    row.appendChild(flag('U', 'uns', 'UNSIGNED'));
    if (c.pk) row.appendChild(el('b', 'keytag', 'PK'));
    const fk = (t.fks || []).find(f => f.col === (c.orig ? c.orig.name : c.name));
    if (fk) {
      const tag = el('b', 'keytag fk', 'FK');
      tag.title = '→ ' + fk.refTable + '.' + fk.refCol;
      row.appendChild(tag);
    }

    const del = el('button', 'iconbtn', '✕');
    del.title = 'drop this column';
    del.addEventListener('click', () => {
      t.cols.splice(ci, 1);
      render();
      commit('drop column');
    });
    row.appendChild(del);
    return row;
  }

  function tableCard(t) {
    const card = el('div', 'dz-card');
    const head = el('div', 'dz-head');
    const nameIn = inp('dz-tname', t.name, 'table_name', v => { t.name = v; });
    head.appendChild(nameIn);

    if (t.origName) {
      const dataBtn = el('button', 'iconbtn', '▦ data');
      dataBtn.title = 'open as spreadsheet';
      dataBtn.addEventListener('click', () => hooks.openTable(t.origName));
      head.appendChild(dataBtn);
    }
    const drop = el('button', 'iconbtn', '✕');
    drop.title = t.origName ? 'drop this table' : 'discard';
    drop.addEventListener('click', () => {
      model.splice(model.indexOf(t), 1);
      render();
      commit('drop table');
    });
    head.appendChild(drop);
    card.appendChild(head);

    const colsBox = el('div', 'dz-cols');
    t.cols.forEach((c, ci) => colsBox.appendChild(colRow(t, c, ci)));
    card.appendChild(colsBox);

    const add = el('button', 'btn small', '+ column');
    add.addEventListener('click', async () => {
      cancelScheduled();
      await commit('new column');       // Ben's rule: adding a row commits the last one
      const live = model.find(x => x === t) || model.find(x => x.origName === t.origName);
      if (!live) return;
      live.cols.push({ name: '', type: 'VARCHAR', args: '255', uns: false, nn: true, ai: false, pk: false, def: '', orig: null });
      render();
      const cards = [...host.querySelectorAll('.dz-card')];
      const idx = model.indexOf(live);
      const last = cards[idx] && [...cards[idx].querySelectorAll('.dz-cname')].pop();
      if (last) last.focus();
    });
    card.appendChild(add);
    return card;
  }

  function render() {
    host.textContent = '';
    const wrap = el('div', 'dz-wrap');
    const bar = el('div', 'dz-bar');
    bar.appendChild(el('span', 'dz-hint',
      model.length
        ? 'Edit anything — changes apply when you click away. Dropping things asks first.'
        : 'No tables yet. Add your first one:'));
    const addT = el('button', 'btn small primary', '+ add table');
    addT.addEventListener('click', async () => {
      cancelScheduled();
      await commit('new table');
      model.push({
        name: '', origName: null, fks: [], origCols: [],
        cols: [{ name: 'id', type: 'INT', args: '', uns: true, nn: true, ai: true, pk: true, def: '', orig: null }]
      });
      render();
      const first = [...host.querySelectorAll('.dz-tname')].pop();
      if (first) { first.focus(); first.select(); }
    });
    bar.appendChild(addT);
    wrap.appendChild(bar);

    const grid = el('div', 'dz-grid');
    for (const t of model) grid.appendChild(tableCard(t));
    wrap.appendChild(grid);
    host.appendChild(wrap);
  }

  render();
  return {
    refresh(newSchema) {
      if (committing) return;
      model = modelFromSchema(newSchema);
      for (const t of model) t.origCols = t.cols.map(c => c.orig.name);
      snapshotNames = model.map(t => t.origName);
      render();
    }
  };
}
