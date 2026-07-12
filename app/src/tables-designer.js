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

/** parsed DEFAULT / CHECK bound → what the input fields display */
function displayLit(v) {
  v = String(v || '').trim();
  const m = v.match(/^'([\s\S]*)'$/);
  return m ? m[1].replace(/''/g, "'") : v;
}

/** designer model from the shared parser model */
function modelFromSchema(schema) {
  return (schema.tables || []).map(t => ({
    name: t.name,
    origName: t.name,
    fks: t.fks.map(fk => ({ ...fk })),
    origFkCols: t.fks.map(fk => fk.col),
    extras: (t.extras || []).slice(),
    cols: t.columns.map(c => {
      const st = splitType(c.type);
      // a parsed column CHECK in the designer's own shape becomes min/max;
      // anything else is carried verbatim so it never silently disappears
      let chkMin = '', chkMax = '', rawCheck = '';
      const chk = String(c.check || '').trim();
      if (chk) {
        let m;
        if ((m = chk.match(/^`?([\w$]+)`?\s+BETWEEN\s+(\S+)\s+AND\s+(\S+)$/i)) && m[1] === c.name) {
          chkMin = displayLit(m[2]); chkMax = displayLit(m[3]);
        } else if ((m = chk.match(/^`?([\w$]+)`?\s*>=\s*(\S+)$/i)) && m[1] === c.name) {
          chkMin = displayLit(m[2]);
        } else if ((m = chk.match(/^`?([\w$]+)`?\s*<=\s*(\S+)$/i)) && m[1] === c.name) {
          chkMax = displayLit(m[2]);
        } else {
          rawCheck = chk;
        }
      }
      const col = {
        name: c.name, type: st.type, args: st.args,
        uns: !!c.unsigned, nn: !!c.notNull, ai: !!c.autoInc, pk: !!c.pk,
        uq: !!c.unique, def: displayLit(c.dflt), chkMin, chkMax, rawCheck
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
    String(a.chkMax || '') === String(b.chkMax || '') &&
    String(a.rawCheck || '') === String(b.rawCheck || '');
}

function defaultLit(d) {
  d = String(d).trim();
  if (/^\(.*\)$/.test(d)) return d; // parenthesized expression — as-is
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
  else if (String(c.rawCheck || '').trim()) s += ' CHECK (' + String(c.rawCheck).trim() + ')';
  return s;
}

/** a kept-verbatim table-level line (KEY/INDEX/CHECK) is only re-emitted while
 *  every backticked column it names still exists */
function extraStillValid(extra, colNames) {
  const par = extra.match(/\(([\s\S]*)\)/);
  const src = par ? par[1] : extra;
  const ids = [...src.matchAll(/`([\w$]+)`/g)].map(m => m[1]);
  if (!ids.length && /^(UNIQUE|KEY|INDEX|FULLTEXT|SPATIAL)/i.test(extra.trim())) {
    for (const p of src.split(',')) {
      const id = p.trim().match(/^[\w$]+/);
      if (id) ids.push(id[0]);
    }
  }
  return ids.every(id => colNames.has(id));
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
  const colSet = new Set(t.cols.filter(c => String(c.name || '').trim()).map(c => cleanIdent(c.name, 'col')));
  for (const ex of t.extras || []) if (extraStillValid(ex, colSet)) lines.push(' ' + ex);
  for (const fk of t.fks || []) lines.push(' ' + fkDDL(fk));
  return 'CREATE TABLE `' + cleanIdent(t.name, 'table') + '` (\n' + lines.join(',\n') + '\n)';
}

/** MODIFY/CHANGE re-emit UNIQUE and CHECK from scratch, but MySQL only ever
 *  ADDS such constraints — the old ones must be dropped first or they pile
 *  up (and a range could never be widened). The fixups list says what to
 *  look up in information_schema and drop before the statement runs. */
function colFixup(t, c) {
  const hadCheck = String(c.orig.chkMin || '') || String(c.orig.chkMax || '') || String(c.orig.rawCheck || '');
  const f = { table: t.origName, col: c.orig.name, dropChecks: !!hadCheck, dropUnique: !!c.orig.uq };
  return (f.dropChecks || f.dropUnique) ? f : null;
}

/** the diff between the committed snapshot and the live cards */
function computeDiff(model, snapshotNames) {
  const stmts = [];
  const destructive = [];
  const fixups = [];

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
        if (c.pk) stmts.push('ALTER TABLE ' + tbl + ' ADD PRIMARY KEY(`' + cleanIdent(c.name, 'col') + '`)');
        continue;
      }
      seen.add(c.orig.name);
      if (c.name !== c.orig.name) {
        stmts.push('ALTER TABLE ' + tbl + ' CHANGE `' + c.orig.name + '` ' + colDDL(c));
        const f = colFixup(t, c);
        if (f) fixups.push(f);
      } else if (!sameCol(c, c.orig)) {
        stmts.push('ALTER TABLE ' + tbl + ' MODIFY ' + colDDL(c));
        const f = colFixup(t, c);
        if (f) fixups.push(f);
      }
    }
    for (const oc of t.origCols || []) {
      if (!seen.has(oc)) {
        stmts.push('ALTER TABLE ' + tbl + ' DROP COLUMN `' + oc + '`');
        destructive.push('drop column ' + t.origName + '.' + oc);
      }
    }
    // foreign keys: removed ones need their constraint name looked up;
    // new ones are a plain ADD
    for (const oc of t.origFkCols || []) {
      if (!(t.fks || []).some(f => f.col === oc)) {
        fixups.push({ table: t.origName, col: oc, dropFk: true });
      }
    }
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
  return { stmts, destructive, fixups };
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

  /** turn fixups into concrete DROP statements by asking information_schema
   *  for the auto-generated constraint/index names (best effort — if the
   *  lookup fails, the worst case is MySQL rejecting and the cards reverting) */
  async function resolveFixups(fixups) {
    const pre = [];
    if (!hooks.query) return pre;
    for (const f of fixups) {
      const tbl = '`' + f.table + '`';
      try {
        if (f.dropFk) {
          const r = await hooks.query(
            "SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE " +
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '" + f.table + "' " +
            "AND COLUMN_NAME = '" + f.col + "' AND REFERENCED_TABLE_NAME IS NOT NULL");
          for (const row of r.rows) pre.push('ALTER TABLE ' + tbl + ' DROP FOREIGN KEY `' + row[0] + '`');
        }
        if (f.dropChecks) {
          const like = f.col.replace(/([\\%_])/g, '\\$1');
          const r = await hooks.query(
            "SELECT cc.CONSTRAINT_NAME FROM information_schema.CHECK_CONSTRAINTS cc " +
            "JOIN information_schema.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA " +
            "AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME " +
            "WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.TABLE_NAME = '" + f.table + "' " +
            "AND cc.CHECK_CLAUSE LIKE '%`" + like + "`%'");
          for (const row of r.rows) pre.push('ALTER TABLE ' + tbl + ' DROP CHECK `' + row[0] + '`');
        }
        if (f.dropUnique) {
          const r = await hooks.query(
            "SELECT INDEX_NAME FROM information_schema.STATISTICS " +
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '" + f.table + "' " +
            "AND NON_UNIQUE = 0 AND INDEX_NAME <> 'PRIMARY' " +
            "GROUP BY INDEX_NAME HAVING COUNT(*) = 1 AND MAX(COLUMN_NAME) = '" + f.col + "'");
          for (const row of r.rows) pre.push('ALTER TABLE ' + tbl + ' DROP INDEX `' + row[0] + '`');
        }
      } catch { /* engine offline etc. — skip, MySQL will arbitrate */ }
    }
    return pre;
  }

  async function commit(reason) {
    if (committing) return;
    const { stmts, destructive, fixups } = computeDiff(model, snapshotNames);
    if (!stmts.length && !fixups.length) return;
    if (destructive.length &&
        !window.confirm('This will permanently:\n  · ' + destructive.join('\n  · ') + '\n\nContinue?')) {
      reload(); // revert the cards to the committed state
      return;
    }
    committing = true;
    try {
      let partial = 0;
      const all = (await resolveFixups(fixups)).concat(stmts);
      // an empty script (e.g. removing an FK the DB no longer has) still
      // refreshes the file below — runScript would just complain
      const ok = all.length
        ? await hooks.runScript(all.join(';\n') + ';', 'designer: ' + reason,
            { journal: true, onPartial: n => { partial = n; } })
        : true;
      if (ok) {
        // table renames: MySQL re-points dependents' FOREIGN KEYs itself —
        // follow suit in the model so schema.sql doesn't reference old names
        const renamed = {};
        for (const t of model) {
          if (t.origName) {
            const now = cleanIdent(t.name, t.origName);
            if (now !== t.origName) renamed[t.origName] = now;
          }
        }
        if (Object.keys(renamed).length) {
          for (const t of model) {
            for (const fk of t.fks || []) {
              if (renamed[fk.refTable]) fk.refTable = renamed[fk.refTable];
            }
          }
        }
        // column renames: follow them into FK references and kept-verbatim
        // KEY/CHECK lines (MySQL re-points all of these itself on CHANGE)
        for (const t of model) {
          for (const c of t.cols) {
            const from = c.orig && c.orig.name;
            const to = cleanIdent(c.name, from || 'col');
            if (!from || from === to) continue;
            for (const f of t.fks || []) if (f.col === from) f.col = to;
            for (const ot of model) {
              for (const f of ot.fks || []) {
                if (f.refTable === t.origName && f.refCol === from) f.refCol = to;
              }
            }
            if ((t.extras || []).length) {
              const esc = from.replace(/\$/g, '\\$');
              t.extras = t.extras.map(ex => ex
                .replace(new RegExp('`' + esc + '`', 'g'), '`' + to + '`')
                .replace(new RegExp('\\b' + esc + '\\b', 'g'), to));
            }
          }
        }
        await hooks.writeSchema(model);
        // refresh snapshots: everything on screen is now the committed truth
        for (const t of model) {
          t.origName = cleanIdent(t.name, t.origName || 'table');
          t.cols = t.cols.filter(c => String(c.name || '').trim());
          // note: c._open survives — a commit must never slam the popup shut
          for (const c of t.cols) { c.name = cleanIdent(c.name, 'col'); c.orig = { ...c }; delete c.orig.orig; delete c.orig._open; }
          t.origCols = t.cols.map(c => c.name);
          t.origFkCols = (t.fks || []).map(f => f.col);
        }
        model = model.filter(t => t.origName);
        snapshotNames = model.map(t => t.origName);
        render();
      } else {
        // DB said no. If some statements DID apply, the file no longer
        // matches the database — re-derive it from DB truth before reverting.
        if (partial > 0 && hooks.syncFromDb) await hooks.syncFromDb();
        reload(); // revert cards to reality
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

    /* property toggles live in the popup; they apply when it closes
       (or when focus leaves the designer — the usual semi-live rule) */
    const flag = (label, key, title) => {
      const b = el('button', 'flag' + (c[key] ? ' on' : ''), label);
      if (title) b.title = title;
      b.addEventListener('click', () => {
        c[key] = !c[key];
        b.classList.toggle('on', c[key]);
      });
      return b;
    };

    /* every property the column has, written out, right on the row */
    const existingFk = (t.fks || []).find(f => f.col === (c.orig ? c.orig.name : c.name));
    const tags = el('span', 'dz-tags');
    if (c.pk) tags.appendChild(el('b', 'keytag', 'PK'));
    if (existingFk) {
      tags.appendChild(el('b', 'keytag fk', 'FK → ' + existingFk.refTable + '.' + existingFk.refCol));
    }
    const tag = txt => tags.appendChild(el('span', 'dz-tag', txt));
    if (c.nn) tag('NOT NULL');
    if (c.ai) tag('AUTO_INCREMENT');
    if (c.uns) tag('UNSIGNED');
    if (c.uq) tag('UNIQUE');
    if (String(c.def || '').trim()) tag('DEFAULT ' + c.def);
    const mn = String(c.chkMin || '').trim(), mx = String(c.chkMax || '').trim();
    if (mn && mx) tag(mn + ' … ' + mx);
    else if (mn) tag('min ' + mn);
    else if (mx) tag('max ' + mx);
    if (String(c.rawCheck || '').trim()) {
      const g = el('span', 'dz-tag', 'CHECK (…)');
      g.title = c.rawCheck;
      tags.appendChild(g);
    }
    row.appendChild(tags);

    const more = el('button', 'flag dz-more', tags.childNodes.length ? 'properties' : '+ properties');
    more.title = 'not null, auto increment, unique, unsigned, default, allowed range, foreign key';
    more.addEventListener('click', () => {
      c._open = true;
      render();
    });
    row.appendChild(more);

    const del = el('button', 'iconbtn', '✕');
    del.title = 'drop this column';
    del.addEventListener('click', () => {
      t.cols.splice(ci, 1);
      // its foreign keys go with it (the DB won't drop an FK'd column)
      const cn = c.orig ? c.orig.name : c.name;
      t.fks = (t.fks || []).filter(f => f.col !== cn);
      render();
      commit('drop column');
    });
    row.appendChild(del);
    wrap.appendChild(row);

    /* --- the properties popup: everything settable in one place; closes on
       ✕ or a click anywhere outside, and that close applies the changes --- */
    if (c._open) {
      const closePop = () => {
        c._open = false;
        render();
        scheduleCommit('properties');
      };
      const back = el('div', 'dz-popback');
      back.addEventListener('click', closePop);
      wrap.appendChild(back);

      const pop = el('div', 'dz-pop');
      const popHead = el('div', 'dz-pop-head');
      popHead.appendChild(el('span', null, 'properties · ' + (String(c.name || '').trim() || 'new column')));
      const closeBtn = el('button', 'iconbtn', '✕');
      closeBtn.title = 'close — the changes apply now';
      closeBtn.addEventListener('click', closePop);
      popHead.appendChild(closeBtn);
      pop.appendChild(popHead);

      const opts = el('div', 'dz-opts');
      // PK is offered only where it can actually apply: a new column in a
      // table that doesn't have a primary key yet
      if (!c.orig && !t.cols.some(x => x !== c && x.pk)) {
        opts.appendChild(flag('PRIMARY KEY', 'pk', 'primary key (new columns only)'));
      }
      opts.appendChild(flag('NOT NULL', 'nn', 'a value is required'));
      opts.appendChild(flag('AUTO_INCREMENT', 'ai', 'the database numbers new rows itself'));
      opts.appendChild(flag('UNSIGNED', 'uns', 'no negative values'));
      opts.appendChild(flag('UNIQUE', 'uq', 'no duplicate values'));
      pop.appendChild(opts);

      const vals = el('div', 'dz-opts');
      const defIn = inp('dz-def', c.def, 'DEFAULT…', v => { c.def = v; });
      defIn.title = 'default value — number, text, TRUE/FALSE or NOW()';
      vals.appendChild(defIn);
      if (/^(DATE|DATETIME|TIMESTAMP|TIME)$/.test(c.type)) {
        const now = el('button', 'flag', '⏱ now');
        now.title = 'default to the current date/time';
        now.addEventListener('click', () => {
          c.def = c.type === 'DATE' ? 'CURDATE()' : c.type === 'TIME' ? 'CURTIME()' : 'NOW()';
          render();
        });
        vals.appendChild(now);
      }
      const minIn = inp('dz-range', c.chkMin, 'min…', v => { c.chkMin = v; });
      minIn.title = 'lowest allowed value (CHECK)';
      const maxIn = inp('dz-range', c.chkMax, 'max…', v => { c.chkMax = v; });
      maxIn.title = 'highest allowed value (CHECK)';
      vals.appendChild(minIn);
      vals.appendChild(maxIn);
      if (String(c.rawCheck || '').trim()) {
        const rc = el('span', 'dz-fkinfo', 'CHECK (' + c.rawCheck + ')');
        rc.title = 'a rule this designer cannot edit — kept as-is';
        vals.appendChild(rc);
      }
      pop.appendChild(vals);

      /* --- foreign key row --- */
      const fkRow = el('div', 'dz-fkrow');
      fkRow.appendChild(el('span', 'dz-fklabel', 'references →'));
      if (existingFk) {
        fkRow.appendChild(el('span', 'dz-fkinfo', existingFk.refTable + '.' + existingFk.refCol +
          (existingFk.onUpdate || existingFk.onDelete ? '  (upd ' + (existingFk.onUpdate || '–') + ' / del ' + (existingFk.onDelete || '–') + ')' : '')));
        const rmFk = el('button', 'iconbtn', '✕');
        rmFk.title = 'remove this foreign key (the column stays)';
        rmFk.addEventListener('click', () => {
          t.fks = (t.fks || []).filter(f => f !== existingFk);
          render();
          commit('remove foreign key');
        });
        fkRow.appendChild(rmFk);
      } else {
        const refSel = el('select');
        const none = el('option', null, '— nothing —');
        none.value = '';
        refSel.appendChild(none);
        for (const ot of model) {
          if (!ot.origName) continue; // committed tables only — incl. this one (self-reference)
          for (const oc of ot.cols) {
            if (!oc.pk || oc === c) continue;
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
      pop.appendChild(fkRow);
      wrap.appendChild(pop);
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
      live.cols.push({ name: '', type: 'VARCHAR', args: '255', uns: false, nn: true, ai: false, pk: false, uq: false, def: '', chkMin: '', chkMax: '', rawCheck: '', orig: null });
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
        name: '', origName: null, fks: [], origCols: [], extras: [],
        cols: [{ name: 'id', type: 'INT', args: '', uns: true, nn: true, ai: true, pk: true, uq: false, def: '', chkMin: '', chkMax: '', rawCheck: '', orig: null }]
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
