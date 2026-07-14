// xlsx.js — a dependency-free Excel workbook writer. An .xlsx is a ZIP of
// OOXML parts; entries are STORED (no compression) so the ZIP is trivial.
// buildXlsx([{name, columns, rows}]) → Uint8Array ready to save.
'use strict';

/* ---- CRC-32 (the ZIP flavor) ---- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();

/** files: [{name, text}] → a STORED zip as Uint8Array */
function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const u16 = n => [n & 0xff, (n >> 8) & 0xff];
  const u32 = n => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
  for (const f of files) {
    const nameB = enc.encode(f.name);
    const data = enc.encode(f.text);
    const crc = crc32(data);
    const local = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameB.length), ...u16(0)
    ]);
    chunks.push(local, nameB, data);
    central.push({ nameB, crc, size: data.length, offset });
    offset += local.length + nameB.length + data.length;
  }
  const centralStart = offset;
  for (const c of central) {
    const hdr = new Uint8Array([
      0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(c.crc), ...u32(c.size), ...u32(c.size),
      ...u16(c.nameB.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(c.offset)
    ]);
    chunks.push(hdr, c.nameB);
    offset += hdr.length + c.nameB.length;
  }
  chunks.push(new Uint8Array([
    0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0),
    ...u16(central.length), ...u16(central.length),
    ...u32(offset - centralStart), ...u32(centralStart), ...u16(0)
  ]));
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

const escXml = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  // control chars are illegal in XML 1.0 — Excel refuses the file
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

/** worksheet XML: numbers as numbers, everything else as inline strings */
function sheetXml(columns, rows) {
  const cell = v => {
    if (v == null) return '<c/>';
    const s = String(v);
    if (/^-?\d+(\.\d+)?$/.test(s.trim()) && s.trim().length < 16) {
      return '<c><v>' + s.trim() + '</v></c>';
    }
    return '<c t="inlineStr"><is><t xml:space="preserve">' + escXml(s) + '</t></is></c>';
  };
  const rowXml = cells => '<row>' + cells.map(cell).join('') + '</row>';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetData>' + rowXml(columns) + rows.map(rowXml).join('') + '</sheetData></worksheet>';
}

/** Excel sheet names: ≤31 chars, no []:*?/\ , unique, non-empty */
function sheetNames(sheets) {
  const seen = {};
  return sheets.map((s, i) => {
    let n = String(s.name || 'Sheet' + (i + 1)).replace(/[[\]:*?/\\]/g, '_').slice(0, 31) || 'Sheet' + (i + 1);
    let base = n;
    let k = 2;
    while (seen[n.toLowerCase()]) n = (base.slice(0, 28) + '_' + k++);
    seen[n.toLowerCase()] = true;
    return n;
  });
}

/** sheets: [{name, columns, rows}] → .xlsx bytes */
export function buildXlsx(sheets) {
  const names = sheetNames(sheets);
  const files = [];
  files.push({
    name: '[Content_Types].xml',
    text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets.map((_, i) =>
        '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') +
      '</Types>'
  });
  files.push({
    name: '_rels/.rels',
    text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>'
  });
  files.push({
    name: 'xl/workbook.xml',
    text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      names.map((n, i) => '<sheet name="' + escXml(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') +
      '</sheets></workbook>'
  });
  files.push({
    name: 'xl/_rels/workbook.xml.rels',
    text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((_, i) =>
        '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') +
      '</Relationships>'
  });
  sheets.forEach((s, i) => {
    files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', text: sheetXml(s.columns, s.rows) });
  });
  return buildZip(files);
}

/** Uint8Array → base64 (chunked — the spread form overflows on big arrays) */
export function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
