// make-icon.mjs — renders the SQL*Studio mark (the brand's red asterisk on
// the black SQL-poster square) as a 1024px PNG, dependency-free, then
// `npx tauri icon` turns it into the full platform icon set.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZE = 1024;
const BG = [13, 13, 13];        // the poster black (--sql-bg)
const RED = [232, 52, 44];      // --accent
const SS = 3;                   // supersampling per axis

// the typographic asterisk: three bars through the center at 90°, 30°, 150°
const CX = SIZE / 2, CY = SIZE / 2;
const HALF_LEN = SIZE * 0.30;
const HALF_W = SIZE * 0.085;
const ANGLES = [90, 30, 150].map(a => (a * Math.PI) / 180);

function inAsterisk(x, y) {
  const dx = x - CX, dy = y - CY;
  for (const t of ANGLES) {
    const u = dx * Math.cos(t) + dy * Math.sin(t);   // along the bar
    const v = -dx * Math.sin(t) + dy * Math.cos(t);  // across it
    if (Math.abs(u) <= HALF_LEN && Math.abs(v) <= HALF_W) return true;
  }
  return false;
}

// rows of RGBA with per-pixel coverage sampling (antialiasing)
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let o = 0;
for (let y = 0; y < SIZE; y++) {
  raw[o++] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    let hits = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        if (inAsterisk(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) hits++;
      }
    }
    const a = hits / (SS * SS);
    raw[o++] = Math.round(BG[0] + (RED[0] - BG[0]) * a);
    raw[o++] = Math.round(BG[1] + (RED[1] - BG[1]) * a);
    raw[o++] = Math.round(BG[2] + (RED[2] - BG[2]) * a);
    raw[o++] = 255;
  }
}

/* ---- minimal PNG writer ---- */
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
const crc32 = buf => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

const out = new URL('../src-tauri/icons/icon-source-1024.png', import.meta.url);
writeFileSync(out, png);
console.log('wrote', out.pathname, png.length, 'bytes — now run: npx tauri icon src-tauri/icons/icon-source-1024.png');
