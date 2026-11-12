// Renders the EditorNG icon (node triangle on a dark rounded square) into build/icon.ico and build/icon.png.
// Pure JS: signed-distance rasterizer + PNG encoder, so no image tooling is needed.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

function render(size) {
  const out = Buffer.alloc(size * size * 4);
  const SS = 4;
  const bg = [21, 23, 26], acc = [255, 122, 26], hi = [255, 176, 112];
  // unit coordinates 0..1
  const A = [0.2, 0.74], B = [0.5, 0.24], C = [0.8, 0.74];
  const lw = size <= 32 ? 0.075 : 0.05;
  const nr = size <= 32 ? 0.105 : 0.085;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const u = (x + (sx + 0.5) / SS) / size, v = (y + (sy + 0.5) / SS) / size;
        // rounded square
        const rr = 0.2;
        const qx = Math.max(Math.abs(u - 0.5) - (0.5 - rr), 0), qy = Math.max(Math.abs(v - 0.5) - (0.5 - rr), 0);
        if (Math.hypot(qx, qy) > rr) continue;
        let col = bg;
        const dEdge = Math.min(segDist(u, v, ...A, ...B), segDist(u, v, ...B, ...C), segDist(u, v, ...C, ...A));
        if (dEdge < lw / 2) col = acc;
        const dNode = Math.min(Math.hypot(u - A[0], v - A[1]), Math.hypot(u - B[0], v - B[1]), Math.hypot(u - C[0], v - C[1]));
        if (dNode < nr) col = dNode < nr * 0.45 ? hi : acc;
        r += col[0]; g += col[1]; b += col[2]; a += 255;
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      const cov = a / 255;
      out[o] = cov ? Math.round(r / cov) : 0;
      out[o + 1] = cov ? Math.round(g / cov) : 0;
      out[o + 2] = cov ? Math.round(b / cov) : 0;
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((s) => png(s, render(s)));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
const dir = Buffer.alloc(16 * sizes.length);
let offset = 6 + dir.length;
sizes.forEach((s, i) => {
  const e = i * 16;
  dir[e] = s >= 256 ? 0 : s;
  dir[e + 1] = s >= 256 ? 0 : s;
  dir.writeUInt16LE(1, e + 4);
  dir.writeUInt16LE(32, e + 6);
  dir.writeUInt32LE(pngs[i].length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += pngs[i].length;
});
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build', 'icon.ico'), Buffer.concat([header, dir, ...pngs]));
fs.writeFileSync(path.join(root, 'build', 'icon.png'), pngs[pngs.length - 1]);
console.log('icon written');
