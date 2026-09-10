// Generates the Tauri app icons (PNG + multi-size ICO) without external deps.
// Run once: node scripts/generate-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'src-tauri', 'icons');
mkdirSync(outDir, { recursive: true });

const BG = [26, 27, 38, 255]; // dark slate
const FG = [86, 156, 255, 255]; // speed blue

// Lightning bolt polygon in normalized coordinates.
const BOLT = [
  [0.58, 0.06],
  [0.30, 0.56],
  [0.47, 0.56],
  [0.38, 0.94],
  [0.70, 0.44],
  [0.53, 0.44],
];

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    pixels.copy(raw, row + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5) / size;
      const ny = (y + 0.5) / size;
      const color = pointInPolygon(nx, ny, BOLT) ? FG : BG;
      const o = (y * size + x) * 4;
      buf[o] = color[0];
      buf[o + 1] = color[1];
      buf[o + 2] = color[2];
      buf[o + 3] = color[3];
    }
  }
  return buf;
}

function ico(sizes) {
  const entries = sizes.map((s) => ({ size: s, data: png(s, render(s)) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(entries.length, 4);
  const dirSize = 16;
  const offset = 6 + dirSize * entries.length;
  const dir = Buffer.alloc(dirSize * entries.length);
  entries.forEach((e, i) => {
    const o = i * dirSize;
    dir[o] = e.size === 256 ? 0 : e.size; // 0 means 256
    dir[o + 1] = e.size === 256 ? 0 : e.size;
    dir[o + 2] = 0; // palette
    dir[o + 3] = 0; // reserved
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(e.data.length, o + 8);
    dir.writeUInt32LE(offset + entries.slice(0, i).reduce((a, x) => a + x.data.length, 0), o + 12);
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

writeFileSync(join(outDir, '32x32.png'), png(32, render(32)));
writeFileSync(join(outDir, '128x128.png'), png(128, render(128)));
writeFileSync(join(outDir, 'icon.png'), png(512, render(512)));
writeFileSync(join(outDir, 'icon.ico'), ico([16, 32, 48, 64, 128, 256]));
console.log('icons written to', outDir);