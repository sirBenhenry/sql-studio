// The dependency-free .xlsx writer: ZIP structure validated byte-level
// (signatures, CRCs recomputed, central directory), workbook parts checked.
import { buildXlsx, bytesToB64 } from '../src/xlsx.js';
import zlib from 'node:zlib';

let fail = 0;
const ck = (n, c, e) => { if (c) console.log('ok:', n); else { fail++; console.log('FAIL:', n, e ?? ''); } };

const bytes = buildXlsx([
  { name: 'game', columns: ['id', 'title'], rows: [['1', 'Catan'], ['2', 'has <xml> & "quotes"']] },
  { name: 'visitor', columns: ['id', 'name'], rows: [['1', 'Anna']] },
  { name: 'game', columns: ['x'], rows: [['dupe name']] } // must dedupe
]);

/* ---- parse the zip ---- */
const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
const u16 = o => dv.getUint16(o, true);
const u32 = o => dv.getUint32(o, true);
const entries = [];
let at = 0;
while (u32(at) === 0x04034b50) {
  const crc = u32(at + 14), csize = u32(at + 18), size = u32(at + 22);
  const nameLen = u16(at + 26), extraLen = u16(at + 28);
  const name = Buffer.from(bytes.subarray(at + 30, at + 30 + nameLen)).toString('utf8');
  const data = bytes.subarray(at + 30 + nameLen + extraLen, at + 30 + nameLen + extraLen + csize);
  entries.push({ name, crc, size, data });
  at += 30 + nameLen + extraLen + csize;
}
ck('7 zip entries (4 parts + 3 sheets)', entries.length === 7, entries.map(e => e.name).join(','));
ck('central directory follows', u32(at) === 0x02014b50);

// CRCs must match a reference implementation (zlib's)
const crcOk = entries.every(e => (zlib.crc32(e.data) >>> 0) === e.crc);
ck('every entry CRC matches zlib reference', crcOk,
  entries.map(e => e.name + ':' + ((zlib.crc32(e.data) >>> 0) === e.crc)).join(','));

// EOCD present with the right count
let eocd = bytes.length - 22;
ck('end-of-central-directory record', u32(eocd) === 0x06054b50 && u16(eocd + 10) === 7);

/* ---- workbook semantics ---- */
const text = name => Buffer.from(entries.find(e => e.name === name).data).toString('utf8');
ck('workbook lists deduped sheet names',
  text('xl/workbook.xml').includes('name="game"') &&
  text('xl/workbook.xml').includes('name="visitor"') &&
  text('xl/workbook.xml').includes('name="game_2"'), text('xl/workbook.xml'));
const s1 = text('xl/worksheets/sheet1.xml');
ck('numbers are numeric cells', s1.includes('<c><v>1</v></c>'), s1);
ck('text is inline strings', s1.includes('<is><t xml:space="preserve">Catan</t></is>'), s1);
ck('XML-unsafe text escaped', s1.includes('has &lt;xml&gt; &amp; &quot;quotes&quot;'), s1);
ck('header row first', s1.indexOf('>title<') < s1.indexOf('>Catan<'), s1.slice(0, 300));

/* ---- base64 bridge ---- */
global.btoa = global.btoa || (b => Buffer.from(b, 'binary').toString('base64'));
const b64 = bytesToB64(bytes);
ck('base64 round-trips the bytes', Buffer.from(b64, 'base64').equals(Buffer.from(bytes)));

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');
process.exit(fail ? 1 : 0);
