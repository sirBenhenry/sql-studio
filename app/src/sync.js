// sync.js — the apply pipeline's shared plumbing: SQL script splitting and
// current-database tracking. Pure functions, unit-tested in scripts/test-sync.mjs.
'use strict';

/** Split a SQL script into individual statements. Respects '…', "…", `…`
 *  (with '' and \' escapes), -- and # line comments, and C-style comments.
 *  Comments and whitespace-only fragments are dropped. */
export function splitSQL(text) {
  const out = [];
  let cur = '';
  let i = 0;
  const n = text.length;
  let mode = null; // null | "'" | '"' | '`' | '--' | '#' | '/*'

  while (i < n) {
    const ch = text[i];
    const two = text.substr(i, 2);

    if (mode === null) {
      if (two === '--') { mode = '--'; i += 2; continue; }
      if (ch === '#') { mode = '#'; i += 1; continue; }
      if (two === '/*') { mode = '/*'; i += 2; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { mode = ch; cur += ch; i++; continue; }
      if (ch === ';') {
        const s = cur.trim();
        if (s) out.push(s);
        cur = '';
        i++;
        continue;
      }
      cur += ch;
      i++;
    } else if (mode === '--' || mode === '#') {
      if (ch === '\n') { mode = null; cur += '\n'; }
      i++;
    } else if (mode === '/*') {
      if (two === '*/') { mode = null; i += 2; cur += ' '; } else i++;
    } else {
      // inside a quoted region
      if (ch === '\\' && mode !== '`') { cur += text.substr(i, 2); i += 2; continue; }
      if (ch === mode) {
        if (text[i + 1] === mode) { cur += ch + ch; i += 2; continue; } // '' escape
        mode = null;
      }
      cur += ch;
      i++;
    }
  }
  const s = cur.trim();
  if (s) out.push(s);
  return out;
}

/** The database a script leaves you in: the last CREATE DATABASE / USE. */
export function findCurrentDb(text) {
  let db = null;
  for (const stmt of splitSQL(text)) {
    let m = stmt.match(/^CREATE\s+DATABASE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([\w$]+)`?/i);
    if (m) { db = m[1]; continue; }
    m = stmt.match(/^USE\s+`?([\w$]+)`?/i);
    if (m) db = m[1];
  }
  return db;
}

/** Statements that must run OUTSIDE a database context. */
export function isDbAgnostic(stmt) {
  return /^(CREATE|DROP)\s+DATABASE\b|^USE\b|^SHOW\s+DATABASES\b|^SET\b|^SHUTDOWN\b/i.test(stmt.trim());
}

/** FK-dependency order for dumping data: referenced tables first, so the
 *  INSERTs replay without disabling foreign-key checks (which wouldn't stick
 *  across pooled connections anyway). Cycle-safe; stable within a layer. */
export function snapshotTableOrder(model) {
  const layer = {};
  const depth = (name, seen = new Set()) => {
    if (layer[name] != null) return layer[name];
    if (seen.has(name)) return 0; // FK cycle — break it
    seen.add(name);
    const t = model.byName[name];
    let d = 0;
    for (const fk of (t ? t.fks : [])) {
      if (fk.refTable !== name && model.byName[fk.refTable]) {
        d = Math.max(d, depth(fk.refTable, seen) + 1);
      }
    }
    layer[name] = d;
    return d;
  };
  return model.tables.map(t => t.name).sort((a, b) => depth(a) - depth(b));
}

/** The text data.sql gets on snapshot: one multi-row INSERT per non-empty
 *  table. dumps: [{name, columns, rows}] — order is fixed here, not by the
 *  caller. Values arrive as strings (or null) from db_exec.
 *  FK checks are suspended for the replay: dependency order handles the
 *  common case, but a self-reference to a HIGHER id (Anna invited by Carla)
 *  or an FK cycle can't be row-ordered away. Seeds run the whole file on one
 *  connection (db_exec_batch), so the session var actually holds. */
export function buildDataSnapshot(model, dumps) {
  const byName = {};
  for (const d of dumps) byName[d.name] = d;
  const order = snapshotTableOrder(model)
    .concat(dumps.map(d => d.name).filter(n => !model.byName[n]).sort());
  const lines = [
    '-- data.sql — the project\'s data. SQL Studio snapshots the live data here',
    '-- after every applied change, so the project can rebuild from its files.',
    '',
    'SET FOREIGN_KEY_CHECKS = 0;',
    ''
  ];
  for (const name of order) {
    const d = byName[name];
    if (!d || !d.rows.length) continue;
    const numeric = new Set(((model.byName[name] || {}).columns || [])
      .filter(c => c.numeric).map(c => c.name));
    const lit = (v, col) => {
      if (v == null) return 'NULL';
      if (numeric.has(col) && /^-?\d+(\.\d+)?$/.test(v)) return v;
      return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
    };
    lines.push('INSERT INTO `' + name + '` (' + d.columns.map(c => '`' + c + '`').join(', ') + ') VALUES');
    lines.push(d.rows.map(r => ' (' + r.map((v, i) => lit(v, d.columns[i])).join(', ') + ')').join(',\n') + ';');
    lines.push('');
  }
  lines.push('SET FOREIGN_KEY_CHECKS = 1;');
  lines.push('');
  return lines.join('\n');
}

/** A plain-language hint for a MySQL error message, or null when we have
 *  nothing better to say than the error itself. Matched on errno. */
export function explainError(msg) {
  const m = String(msg || '');
  const errno = (m.match(/ERROR (\d+)/) || [])[1];
  const q = re => { const x = m.match(re); return x ? x[1] : null; };
  switch (errno) {
    case '1062': {
      const entry = q(/Duplicate entry '([^']*)'/);
      return 'That value' + (entry != null ? ' (' + entry + ')' : '') +
        ' already exists in a column that must be unique. Use a different value, or remove UNIQUE from the column.';
    }
    case '1451':
      return 'Other rows still point at this one through a foreign key. Delete or re-point those rows first — or set the FK to ON DELETE CASCADE in the designer.';
    case '1452':
      return 'The row you are referencing does not exist. Check the foreign-key value — the search in FK fields picks only real rows.';
    case '1048': {
      const col = q(/Column '([^']*)'/);
      return (col ? "'" + col + "'" : 'A column') + ' requires a value (NOT NULL). Fill it in, give it a DEFAULT, or click its NOT NULL tag off in the designer.';
    }
    case '3819': {
      const chk = q(/constraint '([^']*)'/);
      return 'The value breaks an allowed range' + (chk ? ' (' + chk + ')' : '') +
        ' — a CHECK set on the column. Adjust the value, or widen the range in the column\'s properties.';
    }
    case '1064':
      return 'MySQL could not read that as SQL — usually a typo, a missing comma/quote, or a reserved word used as a name (wrap it in `backticks`).';
    case '1146':
      return 'That table does not exist in the live database. If it only exists in schema.sql, save the file to apply it — or check the spelling.';
    case '1049':
      return 'That database does not exist. Check the name — or create it first (CREATE DATABASE …).';
    case '1054':
      return 'No such column. Check the spelling — the schema may have changed since the query was written.';
    case '1075':
      return 'AUTO_INCREMENT only works on a key column. Make the column the PRIMARY KEY (or drop AUTO_INCREMENT).';
    case '3730':
      return 'Another table\'s foreign key depends on this one. Drop the dependent table (or its FK) first.';
    case '1366':
      return 'The value does not fit the column type (e.g. text into a number column). Check the value — or change the column type.';
    case '1406':
      return 'The text is longer than the column allows. Shorten it, or raise the length in the designer (e.g. VARCHAR(255)).';
    case '1265':
      return 'The value was cut off — it does not fit the column type/length.';
    case '1093':
      return 'MySQL cannot read the same table it is changing in a plain subquery. The builder wraps these automatically — for hand-written SQL, wrap the subquery: (SELECT … FROM (SELECT …) AS x).';
    case '1213':
      return 'Two changes blocked each other (deadlock) and this one was rolled back. Just run it again.';
    case '1205':
      return 'Timed out waiting for a lock — something else holds the row. Try again in a moment.';
    default:
      return null;
  }
}

/** journal entry text for a batch of applied statements */
export function journalEntry(source, statements) {
  const when = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return '\n-- @applied ' + when + ' (' + source + ')\n' +
    statements.map(s => (s.endsWith(';') ? s : s + ';')).join('\n') + '\n';
}
