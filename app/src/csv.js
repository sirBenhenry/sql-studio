// csv.js — CSV in and out, pure functions (tested in scripts/test-csv.mjs).
// Import: parse → infer a table (types, PK) → CREATE + chunked INSERTs.
// Export: rows → RFC-4180-ish text Excel opens cleanly.
'use strict';

/** Parse delimiter-separated text: quoted fields, "" escapes, the delimiter
 *  and newlines inside quotes, CRLF, trailing newline. Returns rows of
 *  strings. CSV uses ','; spreadsheet-clipboard paste uses '\t'. */
function parseDSV(text, delim) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQ = false;
  let started = false; // the current row has content (guards a trailing \n)
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"') { inQ = true; started = true; continue; }
    if (ch === delim) { row.push(cur); cur = ''; started = true; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') {
      if (started || cur !== '' || row.length) { row.push(cur); rows.push(row); }
      row = []; cur = ''; started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started || cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

export const parseCSV = text => parseDSV(text, ',');
/** what Excel/Sheets put on the clipboard when you copy a cell block */
export const parseTSV = text => parseDSV(text, '\t');

const cleanIdent = (s, fallback) => {
  const c = String(s || '').trim().replace(/\s+/g, '_').replace(/[^\w$]/g, '');
  return c || fallback;
};

/** column type from every value in it (empty = NULL, ignored) */
function inferType(values) {
  let isInt = true, isNum = true, isDate = true, isDateTime = true, maxLen = 1;
  let any = false;
  for (const v of values) {
    const t = String(v ?? '').trim();
    if (t === '') continue;
    any = true;
    maxLen = Math.max(maxLen, t.length);
    if (!/^-?\d{1,18}$/.test(t)) isInt = false;
    if (!/^-?\d+(\.\d+)?$/.test(t)) isNum = false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) isDate = false;
    if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(t)) isDateTime = false;
  }
  if (!any) return 'VARCHAR(80)';
  if (isInt) return 'INT';
  if (isNum) {
    // enough scale for what was seen
    let scale = 0;
    for (const v of values) {
      const m = String(v ?? '').trim().match(/\.(\d+)$/);
      if (m) scale = Math.max(scale, m[1].length);
    }
    return 'DECIMAL(' + Math.min(maxLen + 2, 20) + ',' + Math.min(scale, 6) + ')';
  }
  if (isDate) return 'DATE';
  if (isDateTime) return 'DATETIME';
  if (maxLen > 255) return 'TEXT';
  for (const n of [40, 80, 255]) if (maxLen <= n) return 'VARCHAR(' + n + ')';
  return 'VARCHAR(255)';
}

/** rows (first row = headers) → { ddl, inserts:[sql…], columns, rowCount }.
 *  A unique-integer first column becomes the PK; otherwise a synthetic
 *  auto-increment id is prepended so the grid stays editable. */
export function inferCsvTable(tableName, rows) {
  if (!rows.length || rows.length < 2) return null;
  const name = cleanIdent(tableName, 'imported');
  const headers = rows[0].map((h, i) => cleanIdent(h, 'col' + (i + 1)));
  // dedupe header names
  const seen = {};
  for (let i = 0; i < headers.length; i++) {
    let h = headers[i];
    while (seen[h]) h = h + '_' + i;
    seen[h] = true;
    headers[i] = h;
  }
  const data = rows.slice(1).filter(r => r.some(v => String(v ?? '').trim() !== ''));
  if (!data.length) return null;
  const colValues = headers.map((_, i) => data.map(r => r[i]));
  const types = colValues.map(inferType);

  // PK: first column if integer + unique + all present
  let pkFirst = false;
  if (types[0] === 'INT') {
    const vals = colValues[0].map(v => String(v ?? '').trim());
    pkFirst = vals.every(v => v !== '') && new Set(vals).size === vals.length;
  }
  const lines = [];
  if (!pkFirst) lines.push(' `id` INT UNSIGNED NOT NULL AUTO_INCREMENT');
  headers.forEach((h, i) => lines.push(' `' + h + '` ' + types[i]));
  lines.push(' PRIMARY KEY(`' + (pkFirst ? headers[0] : 'id') + '`)');
  const ddl = 'CREATE TABLE `' + name + '` (\n' + lines.join(',\n') + '\n);';

  const numeric = types.map(t => /^(INT|DECIMAL)/.test(t));
  const lit = (v, i) => {
    const t = String(v ?? '').trim();
    if (t === '') return 'NULL';
    if (numeric[i] && /^-?\d+(\.\d+)?$/.test(t)) return t;
    return "'" + t.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
  };
  const inserts = [];
  for (let at = 0; at < data.length; at += 200) {
    const chunk = data.slice(at, at + 200);
    inserts.push(
      'INSERT INTO `' + name + '` (' + headers.map(h => '`' + h + '`').join(', ') + ') VALUES\n' +
      chunk.map(r => ' (' + headers.map((_, i) => lit(r[i], i)).join(', ') + ')').join(',\n') + ';');
  }
  return { name, ddl, inserts, columns: headers, rowCount: data.length };
}

/** rows (+ header) → CSV text. Cells with commas/quotes/newlines get quoted;
 *  null becomes an empty cell. CRLF so Excel is happy. */
export function toCSV(columns, rows) {
  const cell = v => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [columns.map(cell).join(',')]
    .concat(rows.map(r => r.map(cell).join(',')))
    .join('\r\n') + '\r\n';
}
