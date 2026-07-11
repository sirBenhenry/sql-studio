/* AUTO-EXTRACTED from sql-studio.html (script block 1) — DO NOT EDIT HERE.
   Edit the lite tool, then re-run: node scripts/extract-core.mjs
   Drift is caught by: npm run test:core */

/* ============================================================
   parser.js — reads MySQL dumps (CREATE TABLE / ALTER TABLE)
   and produces a schema object:
   {
     tables: [ { name, columns:[{name,type,numeric,pk,notNull,autoInc}], fks:[{col, refTable, refCol}] } ],
     byName: { tableName -> table }
   }
   ============================================================ */

(function () {
  'use strict';

  const NUMERIC_TYPES = /^(INT|INTEGER|TINYINT|SMALLINT|MEDIUMINT|BIGINT|DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL|BIT|YEAR|SERIAL)\b/i;

  function stripComments(sql) {
    return sql
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\n]*/g, '')
      .replace(/^\s*#[^\n]*/gm, '');
  }

  function unquote(id) {
    if (!id) return id;
    id = id.trim();
    // strip db prefix "db.table" and quotes/backticks
    const parts = id.split('.');
    id = parts[parts.length - 1].trim();
    return id.replace(/^[`"[]|[`"\]]$/g, '').replace(/^[`"]|[`"]$/g, '');
  }

  /* Split a CREATE TABLE body on commas at parenthesis depth 0,
     ignoring commas inside (...) and inside 'strings'. */
  function splitTopLevel(body) {
    const parts = [];
    let depth = 0, cur = '', inStr = false;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (inStr) {
        cur += ch;
        if (ch === "'" && body[i + 1] === "'") { cur += "'"; i++; }
        else if (ch === "'") inStr = false;
        continue;
      }
      if (ch === "'") { inStr = true; cur += ch; continue; }
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    return parts.map(p => p.trim()).filter(Boolean);
  }

  /* Find the balanced (...) body starting at openParenIndex. */
  function readBalanced(sql, openIdx) {
    let depth = 0, inStr = false;
    for (let i = openIdx; i < sql.length; i++) {
      const ch = sql[i];
      if (inStr) {
        if (ch === "'" && sql[i + 1] === "'") i++;
        else if (ch === "'") inStr = false;
        continue;
      }
      if (ch === "'") { inStr = true; continue; }
      if (ch === '(') depth++;
      if (ch === ')') {
        depth--;
        if (depth === 0) return { body: sql.slice(openIdx + 1, i), end: i };
      }
    }
    return null;
  }

  function parseColumnDef(def, table) {
    const m = def.match(/^[`"]?([\w$]+)[`"]?\s+([a-zA-Z]+(?:\s*\([^)]*\))?)/);
    if (!m) return;
    const col = {
      name: m[1],
      type: m[2].replace(/\s+/g, ''),
      numeric: NUMERIC_TYPES.test(m[2]),
      boolean: /^(BOOL(EAN)?\b|TINYINT\s*\(\s*1\s*\))/i.test(m[2]),
      unsigned: /\bUNSIGNED\b/i.test(def),
      pk: /PRIMARY\s+KEY/i.test(def),
      notNull: /NOT\s+NULL/i.test(def),
      autoInc: /AUTO_INCREMENT/i.test(def)
    };
    table.columns.push(col);
    // inline foreign key:  col INT REFERENCES other(col)
    const ref = def.match(/REFERENCES\s+[`"]?(?:[\w$]+[`"]?\.[`"]?)?([\w$]+)[`"]?\s*\(([^)]+)\)/i);
    if (ref) {
      table.fks.push({ col: col.name, refTable: unquote(ref[1]), refCol: unquote(ref[2].split(',')[0]) });
    }
  }

  function parseConstraintDef(def, table) {
    const fk = def.match(/FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+[`"]?(?:[\w$]+[`"]?\.[`"]?)?([\w$]+)[`"]?\s*\(([^)]+)\)/i);
    if (fk) {
      const cols = fk[1].split(',').map(unquote);
      const refCols = fk[3].split(',').map(unquote);
      // multi-column FKs: register the first pair (enough for join suggestions)
      table.fks.push({ col: cols[0], refTable: unquote(fk[2]), refCol: refCols[0] });
      return true;
    }
    const pk = def.match(/^PRIMARY\s+KEY\s*\(([^)]+)\)/i);
    if (pk) {
      pk[1].split(',').map(unquote).forEach(name => {
        const c = table.columns.find(c => c.name === name);
        if (c) c.pk = true;
      });
      return true;
    }
    return /^(UNIQUE|KEY|INDEX|FULLTEXT|SPATIAL|CHECK|CONSTRAINT)\b/i.test(def);
  }

  /* apply one comma-separated ALTER clause to a parsed table (mutates it) */
  function applyAlterClause(t, clause) {
    const c = clause.trim();
    if (!c) return;
    let mm;
    if (/^ADD\s+(CONSTRAINT\s+[`"\w$]+\s+)?FOREIGN\s+KEY/i.test(c)) {
      const fk = c.match(/FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+[`"]?(?:[\w$]+[`"]?\.[`"]?)?([\w$]+)[`"]?\s*\(([^)]+)\)/i);
      if (fk) t.fks.push({ col: unquote(fk[1].split(',')[0]), refTable: unquote(fk[2]), refCol: unquote(fk[3].split(',')[0]) });
      return;
    }
    if (/^ADD\s+PRIMARY\s+KEY/i.test(c)) {
      const pk = c.match(/\(([^)]+)\)/);
      if (pk) pk[1].split(',').map(unquote).forEach(n => { const col = t.columns.find(x => x.name === n); if (col) col.pk = true; });
      return;
    }
    if (/^ADD\s+(CONSTRAINT|UNIQUE|KEY|INDEX|FULLTEXT|SPATIAL|CHECK)\b/i.test(c)) return; // indexes: ignore
    mm = c.match(/^ADD\s+(?:COLUMN\s+)?([\s\S]+)/i);
    if (mm) { parseColumnDef(mm[1], t); return; }
    if (/^DROP\s+PRIMARY\s+KEY/i.test(c)) { t.columns.forEach(col => col.pk = false); return; }
    if (/^DROP\s+(FOREIGN\s+KEY|CONSTRAINT|INDEX|KEY|CHECK)\b/i.test(c)) return; // FK/index drops: not modelled
    mm = c.match(/^DROP\s+(?:COLUMN\s+)?[`"]?([\w$]+)[`"]?/i);
    if (mm) { t.columns = t.columns.filter(col => col.name !== mm[1]); t.fks = t.fks.filter(fk => fk.col !== mm[1]); return; }
    mm = c.match(/^MODIFY\s+(?:COLUMN\s+)?([\s\S]+)/i);
    if (mm) {
      const tmp = { columns: [], fks: [] }; parseColumnDef(mm[1], tmp);
      const nc = tmp.columns[0];
      if (nc) { const ex = t.columns.find(x => x.name === nc.name); if (ex) { ex.type = nc.type; ex.numeric = nc.numeric; ex.boolean = nc.boolean; } }
      return;
    }
    mm = c.match(/^CHANGE\s+(?:COLUMN\s+)?[`"]?([\w$]+)[`"]?\s+([\s\S]+)/i);
    if (mm) {
      const oldName = mm[1]; const tmp = { columns: [], fks: [] }; parseColumnDef(mm[2], tmp);
      const nc = tmp.columns[0]; const ex = t.columns.find(x => x.name === oldName);
      if (ex && nc) { ex.name = nc.name; ex.type = nc.type; ex.numeric = nc.numeric; ex.boolean = nc.boolean; t.fks.forEach(fk => { if (fk.col === oldName) fk.col = nc.name; }); }
      return;
    }
    mm = c.match(/^RENAME\s+COLUMN\s+[`"]?([\w$]+)[`"]?\s+TO\s+[`"]?([\w$]+)[`"]?/i);
    if (mm) { const ex = t.columns.find(x => x.name === mm[1]); if (ex) { ex.name = mm[2]; t.fks.forEach(fk => { if (fk.col === mm[1]) fk.col = mm[2]; }); } return; }
    mm = c.match(/^RENAME\s+(?:TO\s+|AS\s+)?[`"]?([\w$]+)[`"]?/i);
    if (mm) { t._renameTo = unquote(mm[1]); return; }
  }

  function parseSchema(sqlText) {
    const sql = stripComments(sqlText);
    const tables = [];
    const byName = {};

    // ---- CREATE TABLE ----
    const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"]?[\w$]+[`"]?(?:\.[`"]?[\w$]+[`"]?)?)\s*\(/gi;
    let m;
    while ((m = createRe.exec(sql)) !== null) {
      const name = unquote(m[1]);
      const bal = readBalanced(sql, createRe.lastIndex - 1);
      if (!bal) continue;
      createRe.lastIndex = bal.end + 1;

      const table = { name, columns: [], fks: [] };
      for (const def of splitTopLevel(bal.body)) {
        if (/^(PRIMARY|FOREIGN|UNIQUE|KEY|INDEX|FULLTEXT|SPATIAL|CHECK|CONSTRAINT)\b/i.test(def)) {
          parseConstraintDef(def, table);
        } else {
          parseColumnDef(def, table);
        }
      }
      if (table.columns.length) {
        tables.push(table);
        byName[table.name] = table;
      }
    }

    // ---- ALTER TABLE ... (applied in order so the model reflects the final state) ----
    const alterRe = /ALTER\s+TABLE\s+([`"]?[\w$]+[`"]?(?:\.[`"]?[\w$]+[`"]?)?)([\s\S]*?);/gi;
    while ((m = alterRe.exec(sql)) !== null) {
      const t = byName[unquote(m[1])];
      if (!t) continue;
      for (const clause of splitTopLevel(m[2])) applyAlterClause(t, clause);
      if (t._renameTo) {
        const oldName = t.name, neu = t._renameTo;
        delete t._renameTo;
        if (neu && neu !== oldName) {
          delete byName[oldName];
          t.name = neu;
          byName[neu] = t;
          for (const ot of tables) for (const fk of ot.fks) if (fk.refTable === oldName) fk.refTable = neu;
        }
      }
    }

    // drop FKs pointing at tables we don't know, and duplicates
    // (dumps often declare the same FK twice: inline + ALTER/CONSTRAINT)
    for (const t of tables) {
      const seen = new Set();
      t.fks = t.fks.filter(fk => {
        if (!byName[fk.refTable]) return false;
        const key = fk.col + '|' + fk.refTable + '|' + fk.refCol;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    return { tables, byName };
  }

  window.parseSchema = parseSchema;
})();

