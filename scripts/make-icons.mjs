// Generates the PWA icons (no image tooling needed): a rounded page with text lines
// and a commit-dot accent. Run: node scripts/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BG = [0x1e, 0x1e, 0x24];
const ACCENT = [0xa3, 0x95, 0xff];
const PAGE = [0xf4, 0xf4, 0xf6];
const LINE = [0xb8, 0xb8, 0xc4];

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      // 4x supersampling for smooth edges
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const p = pixel((x + (sx + 0.5) / 4) / size, (y + (sy + 0.5) / 4) / size);
          if (p) (r += p[0]), (g += p[1]), (b += p[2]), (a += 255);
        }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const n = a / 255 || 1;
      raw[o] = r / n; raw[o + 1] = g / n; raw[o + 2] = b / n; raw[o + 3] = a / 16;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

/** `scale` < 1 shrinks the glyph into the maskable safe zone. */
function glyph(scale, rounded) {
  return (u, v) => {
    if (rounded && !inRoundRect(u, v, 0, 0, 1, 1, 0.22)) return null;
    const x = (u - 0.5) / scale + 0.5;
    const y = (v - 0.5) / scale + 0.5;
    if (Math.hypot(x - 0.7, y - 0.72) < 0.12) return ACCENT;
    if (Math.hypot(x - 0.7, y - 0.72) < 0.155) return BG;
    if (inRoundRect(x, y, 0.24, 0.16, 0.72, 0.84, 0.06)) {
      for (const [ly, lx1] of [[0.32, 0.62], [0.44, 0.62], [0.56, 0.52]])
        if (inRoundRect(x, y, 0.33, ly - 0.025, lx1, ly + 0.025, 0.025)) return LINE;
      return PAGE;
    }
    return BG;
  };
}

writeFileSync('public/icon-192.png', png(192, glyph(1, true)));
writeFileSync('public/icon-512.png', png(512, glyph(1, true)));
writeFileSync('public/icon-maskable-512.png', png(512, glyph(0.72, false)));
console.log('icons written');
