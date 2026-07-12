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

/** journal entry text for a batch of applied statements */
export function journalEntry(source, statements) {
  const when = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return '\n-- @applied ' + when + ' (' + source + ')\n' +
    statements.map(s => (s.endsWith(';') ? s : s + ';')).join('\n') + '\n';
}
