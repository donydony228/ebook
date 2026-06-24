// Generates simple PNG app icons (no external deps) so the PWA has valid
// 192/512 icons. Draws a rounded purple square with a small "book" mark.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

function makeIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const r = size * 0.215; // corner radius
  const inside = (x, y) => {
    // rounded-rect test
    const cx = Math.min(Math.max(x, r), size - r);
    const cy = Math.min(Math.max(y, r), size - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inside(x, y)) {
        buf[i + 3] = 0; // transparent outside the rounded square
        continue;
      }
      // diagonal gradient 5b62d6 -> 9aa0ff
      const t = (x + y) / (2 * size);
      let R = Math.round(0x5b + (0x9a - 0x5b) * t);
      let G = Math.round(0x62 + (0xa0 - 0x62) * t);
      let B = Math.round(0xd6 + (0xff - 0xd6) * t);
      // book glyph (white rect with spine)
      const bx0 = size * 0.29, bx1 = size * 0.71, by0 = size * 0.235, by1 = size * 0.765;
      if (x >= bx0 && x <= bx1 && y >= by0 && y <= by1) {
        R = G = B = 246;
        if (x <= bx0 + size * 0.11) { R = 0x4f; G = 0x55; B = 0xc8; } // spine
      }
      buf[i] = R; buf[i + 1] = G; buf[i + 2] = B; buf[i + 3] = 255;
    }
  }
  return encodePng(size, size, buf);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // raw image data with filter byte 0 per scanline
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

mkdirSync(new URL('../public/', import.meta.url), { recursive: true });
for (const size of [192, 512]) {
  const out = new URL(`../public/icon-${size}.png`, import.meta.url);
  writeFileSync(out, makeIcon(size));
  console.log('wrote', out.pathname);
}
