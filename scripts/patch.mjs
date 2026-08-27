#!/usr/bin/env node
// Headless QC render of the bark patch (top-down + oblique), with vertex colours.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import zlib from 'node:zlib';
import { buildBarkPatch, PATCH_DEFAULTS } from '../src/core/barkpatch.js';
import * as V from '../src/core/vec3.js';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const opts = JSON.parse(arg('--opts', '{}'));
const W = Number(arg('--w', 900));
const H = Number(arg('--h', 900));
const pitch = (Number(arg('--pitch', 62)) * Math.PI) / 180;
const yaw = (Number(arg('--yaw', 25)) * Math.PI) / 180;

const { mesh, colors, stats } = buildBarkPatch({ ...PATCH_DEFAULTS, ...opts });
console.log('patch', JSON.stringify(stats));

const S = (opts.patchSize ?? PATCH_DEFAULTS.patchSize);
const centre = [0, 0, 0];
const dist = S * Number(arg('--zoom', 1.25));
const eye = V.add(centre, [
  Math.sin(yaw) * Math.cos(pitch) * dist,
  Math.sin(pitch) * dist,
  Math.cos(yaw) * Math.cos(pitch) * dist,
]);
const fwd = V.norm(V.sub(centre, eye));
const right = V.norm(V.cross(fwd, [0, 1, 0]));
const up = V.cross(right, fwd);
const f = (H * 0.5) / Math.tan(0.5);
const project = (p) => {
  const d = V.sub(p, eye);
  const z = V.dot(d, fwd);
  return [W / 2 + (V.dot(d, right) / z) * f, H / 2 - (V.dot(d, up) / z) * f, z];
};

const img = new Uint8Array(W * H * 3);
for (let i = 0; i < W * H; i++) { img[i * 3] = 14; img[i * 3 + 1] = 16; img[i * 3 + 2] = 20; }
const zbuf = new Float32Array(W * H).fill(Infinity);
const L = V.norm([0.4, 0.85, 0.35]);

const VN = mesh.positions.map(() => [0, 0, 0]);
for (const q of mesh.faces) {
  const p = q.map((i) => mesh.positions[i]);
  const nn = V.cross(V.sub(p[2], p[0]), V.sub(p[3], p[1]));
  for (const i of q) VN[i] = V.add(VN[i], nn);
}
for (let i = 0; i < VN.length; i++) VN[i] = V.len(VN[i]) > 1e-12 ? V.norm(VN[i]) : [0, 1, 0];

const proj = mesh.positions.map(project);
function tri(a, b, c, ia, ib, ic) {
  const minx = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
  const maxx = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
  const miny = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
  const maxy = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(area) < 1e-9) return;
  const sh = (i) => 0.18 + 0.82 * Math.max(0, V.dot(VN[i], L));
  const sa = sh(ia); const sb = sh(ib); const sc = sh(ic);
  for (let y = miny; y <= maxy; y++)
    for (let x = minx; x <= maxx; x++) {
      const px = x + 0.5; const py = y + 0.5;
      const w0 = ((b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0])) / area;
      const w1 = ((c[0] - b[0]) * (py - b[1]) - (c[1] - b[1]) * (px - b[0])) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w1 * a[2] + w2 * b[2] + w0 * c[2];
      const o = y * W + x;
      if (z >= zbuf[o]) continue;
      zbuf[o] = z;
      const s = w1 * sa + w2 * sb + w0 * sc;
      const r = w1 * colors[ia * 3] + w2 * colors[ib * 3] + w0 * colors[ic * 3];
      const g = w1 * colors[ia * 3 + 1] + w2 * colors[ib * 3 + 1] + w0 * colors[ic * 3 + 1];
      const bl = w1 * colors[ia * 3 + 2] + w2 * colors[ib * 3 + 2] + w0 * colors[ic * 3 + 2];
      img[o * 3] = Math.min(255, r * s * 340);
      img[o * 3 + 1] = Math.min(255, g * s * 340);
      img[o * 3 + 2] = Math.min(255, bl * s * 340);
    }
}
for (const q of mesh.faces) {
  const p = q.map((i) => mesh.positions[i]);
  if (q.some((i) => proj[i][2] <= 0.001)) continue;
  const nn = V.norm(V.cross(V.sub(p[2], p[0]), V.sub(p[3], p[1])));
  if (V.dot(nn, V.sub(p[0], eye)) > 0) continue;
  tri(proj[q[0]], proj[q[1]], proj[q[2]], q[0], q[1], q[2]);
  tri(proj[q[0]], proj[q[2]], proj[q[3]], q[0], q[2], q[3]);
}

const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; Buffer.from(img.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1); }
let table = null;
function crc32(buf) { if (!table) { table = new Int32Array(256); for (let n2 = 0; n2 < 256; n2++) { let c = n2; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n2] = c; } } let c = -1; for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return c ^ -1; }
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const b = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(b) >>> 0); return Buffer.concat([l, b, c]); };
const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 2;
const out = arg('--out', 'shots/patch.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log('wrote', out, mesh.faces.length, 'quads');
