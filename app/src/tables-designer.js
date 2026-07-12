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
    origFkCols: t.fks.map(fk => fk.col),
    cols: t.columns.map(c => {
      const st = splitType(c.type);
      const col = {
        name: c.name, type: st.type, args: st.args,
        uns: !!c.unsigned, nn: !!c.notNull, ai: !!c.autoInc, pk: !!c.pk,
        uq: false, def: '', chkMin: '', chkMax: ''
      };
      col.orig = { ...col };
      return col;
    })
  }));
}

function sameCol(a, b) {
  return a.type === b.type && String(a.args || '') === String(b.args || '') &&
    !!a.uns === !!b.uns && !!a.nn === !!b.nn && !!a.ai === !!b.ai && !!a.uq === !!b.uq &&
    String(a.def || '') === String(b.def || '') &&
    String(a.chkMin || '') === String(b.chkMin || '') &&
    String(a.chkMax || '') === String(b.chkMax || '');
}

function defaultLit(d) {
  d = String(d).trim();
  return /^(-?\d+(\.\d+)?|NOW\(\)|CURRENT_TIMESTAMP|CURDATE\(\)|CURTIME\(\)|TRUE|FALSE|NULL)$/i.test(d)
    ? d.toUpperCase()
    : "'" + d.replace(/'/g, "''") + "'";
}

export function colDDL(c) {
  const name = cleanIdent(c.name, 'col');
  let s = '`' + name + '` ' + c.type;
  if (String(c.args || '').trim()) s += '(' + String(c.args).trim() + ')';
  if (c.uns) s += ' UNSIGNED';
  if (c.nn) s += ' NOT NULL';
  if (c.uq) s += ' UNIQUE';
  if (c.ai) s += ' AUTO_INCREMENT';
  if (String(c.def || '').trim()) s += ' DEFAULT ' + defaultLit(c.def);
  const hasMin = String(c.chkMin || '').trim() !== '';
  const hasMax = String(c.chkMax || '').trim() !== '';
  if (hasMin && hasMax) s += ' CHECK (`' + name + '` BETWEEN ' + defaultLit(c.chkMin) + ' AND ' + defaultLit(c.chkMax) + ')';
  else if (hasMin) s += ' CHECK (`' + name + '` >= ' + defaultLit(c.chkMin) + ')';
  else if (hasMax) s += ' CHECK (`' + name + '` <= ' + defaultLit(c.chkMax) + ')';
  return s;
}

function fkDDL(fk) {
  let s = 'FOREIGN KEY(`' + fk.col + '`) REFERENCES `' + fk.refTable + '`(`' + fk.refCol + '`)';
  if (fk.onUpdate) s += ' ON UPDATE ' + fk.onUpdate;
  if (fk.onDelete) s += ' ON DELETE ' + fk.onDelete;
  return s;
}

export function createTableDDL(t) {
  const lines = t.cols.filter(c => String(c.name || '').trim()).map(c => ' ' + colDDL(c));
  const pks = t.cols.filter(c => c.pk && String(c.name || '').trim()).map(c => '`' + cleanIdent(c.name, 'col') + '`');
  if (pks.length) lines.push(' PRIMARY KEY(' + pks.join(', ') + ')');
  for (const fk of t.fks || []) lines.push(' ' + fkDDL(fk));
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
    // newly added foreign keys (removal needs the constraint name — later)
    for (const fk of t.fks || []) {
      if (!(t.origFkCols || []).includes(fk.col)) {
        stmts.push('ALTER TABLE ' + tbl + ' ADD ' + fkDDL(fk));
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
          for (const c of t.cols) { c.name = cleanIdent(c.name, 'col'); delete c._open; c.orig = { ...c }; delete c.orig.orig; }
          t.origCols = t.cols.map(c => c.name);
          t.origFkCols = (t.fks || []).map(f => f.col);
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
    const wrap = el('div', 'dz-colwrap');

    /* --- main row: name · type · args · expand · delete --- */
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

    if (c.pk) row.appendChild(el('b', 'keytag', 'PK'));
    const existingFk = (t.fks || []).find(f => f.col === (c.orig ? c.orig.name : c.name));
    if (existingFk) {
      const tag = el('b', 'keytag fk', 'FK');
      tag.title = '→ ' + existingFk.refTable + '.' + existingFk.refCol;
      row.appendChild(tag);
    }

    const more = el('button', 'iconbtn dz-more', '⋯');
    more.title = 'more options: unique, unsigned, default, allowed range, foreign key';
    more.addEventListener('click', () => {
      c._open = !c._open;
      render();
    });
    row.appendChild(more);

    const del = el('button', 'iconbtn', '✕');
    del.title = 'drop this column';
    del.addEventListener('click', () => {
      t.cols.splice(ci, 1);
      render();
      commit('drop column');
    });
    row.appendChild(del);
    wrap.appendChild(row);

    /* --- options row (⋯): unsigned/unique/default/range --- */
    const hasExtras = c.uns || c.uq || String(c.def || '') || String(c.chkMin || '') || String(c.chkMax || '') || existingFk;
    if (c._open || hasExtras) {
      const opts = el('div', 'dz-opts');
      if (!c.orig) opts.appendChild(flag('PK', 'pk', 'primary key (new columns only)'));
      opts.appendChild(flag('UNSIGNED', 'uns', 'no negative values'));
      opts.appendChild(flag('UNIQUE', 'uq', 'no duplicate values'));
      const defIn = inp('dz-def', c.def, 'DEFAULT…', v => { c.def = v; });
      defIn.title = 'default value — number, text, TRUE/FALSE or NOW()';
      opts.appendChild(defIn);
      if (/^(DATE|DATETIME|TIMESTAMP|TIME)$/.test(c.type)) {
        const now = el('button', 'flag', '⏱ now');
        now.title = 'default to the current date/time';
        now.addEventListener('click', () => {
          c.def = c.type === 'DATE' ? 'CURDATE()' : c.type === 'TIME' ? 'CURTIME()' : 'NOW()';
          render();
          scheduleCommit('default now');
        });
        opts.appendChild(now);
      }
      const minIn = inp('dz-range', c.chkMin, 'min…', v => { c.chkMin = v; });
      minIn.title = 'lowest allowed value (CHECK)';
      const maxIn = inp('dz-range', c.chkMax, 'max…', v => { c.chkMax = v; });
      maxIn.title = 'highest allowed value (CHECK)';
      opts.appendChild(minIn);
      opts.appendChild(maxIn);
      wrap.appendChild(opts);

      /* --- foreign key row --- */
      const fkRow = el('div', 'dz-fkrow');
      fkRow.appendChild(el('span', 'dz-fklabel', 'references →'));
      if (existingFk) {
        fkRow.appendChild(el('span', 'dz-fkinfo', existingFk.refTable + '.' + existingFk.refCol +
          (existingFk.onUpdate || existingFk.onDelete ? '  (upd ' + (existingFk.onUpdate || '–') + ' / del ' + (existingFk.onDelete || '–') + ')' : '')));
      } else {
        const refSel = el('select');
        const none = el('option', null, '— nothing —');
        none.value = '';
        refSel.appendChild(none);
        for (const ot of model) {
          if (ot === t || !ot.origName) continue;
          for (const oc of ot.cols) {
            if (!oc.pk) continue;
            const o = el('option', null, ot.origName + ' . ' + oc.name);
            o.value = ot.origName + '|' + oc.name;
            refSel.appendChild(o);
          }
        }
        const cascSel = key => {
          const s = el('select');
          for (const [v, label] of [['', '(default)'], ['CASCADE', 'CASCADE'], ['SET NULL', 'SET NULL'], ['RESTRICT', 'RESTRICT']]) {
            const o = el('option', null, label);
            o.value = v;
            s.appendChild(o);
          }
          s.value = 'CASCADE';
          return s;
        };
        const onUpd = cascSel();
        const onDel = cascSel();
        refSel.addEventListener('change', () => {
          if (!refSel.value) return;
          const [rt, rc] = refSel.value.split('|');
          const target = model.find(x => x.origName === rt);
          const tc = target && target.cols.find(x => x.name === rc);
          if (tc) { // FK column type must match its target
            c.type = tc.type; c.args = tc.args; c.uns = tc.uns;
            c.ai = false; c.pk = false; c.nn = true;
          }
          t.fks = t.fks || [];
          t.fks.push({ col: cleanIdent(c.name, 'col'), refTable: rt, refCol: rc, onUpdate: onUpd.value || null, onDelete: onDel.value || null });
          render();
          commit('add foreign key');
        });
        fkRow.appendChild(refSel);
        fkRow.appendChild(el('span', 'dz-fklabel', 'on upd'));
        fkRow.appendChild(onUpd);
        fkRow.appendChild(el('span', 'dz-fklabel', 'on del'));
        fkRow.appendChild(onDel);
      }
      wrap.appendChild(fkRow);
    }
    return wrap;
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
