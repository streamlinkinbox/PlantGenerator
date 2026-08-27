#!/usr/bin/env node
// Tiny software renderer (z-buffer, flat+wire) used for headless QC screenshots.
//   node scripts/render.mjs --seed 7 --subdiv 2 --out shots/a.png [--wire] [--skeleton]

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import zlib from 'node:zlib';
import { generateSkeleton } from '../src/core/skeleton.js';
import { skinSkeleton } from '../src/core/skin.js';
import { growBark } from '../src/core/bark.js';
import * as V from '../src/core/vec3.js';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);

const W = Number(arg('--w', 900));
const H = Number(arg('--h', 900));
const seed = Number(arg('--seed', 7));
const subdiv = Number(arg('--subdiv', 2));
const yaw = (Number(arg('--yaw', 35)) * Math.PI) / 180;
const pitch = (Number(arg('--pitch', 8)) * Math.PI) / 180;

const extra = JSON.parse(arg('--json', '{}'));
const skel = generateSkeleton({ seed, ...extra });
const { mesh } = skinSkeleton(skel);
let out = subdiv > 0 ? mesh.subdivide(subdiv) : mesh;
if (has('--bark')) {
  const t = Date.now();
  const r = growBark(out, skel, JSON.parse(arg('--barkopts', '{}')));
  out = r.mesh;
  console.log('bark', JSON.stringify(r.stats), 'in', Date.now() - t, 'ms');
}

// camera
let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
for (const p of out.positions) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
const center = V.mul(V.add(lo, hi), 0.5);
const radius = V.len(V.sub(hi, lo)) * 0.5;
let camCenter = center;
let camDist = radius * 2.6;
const worst = Number(arg('--worst', -1));
if (worst >= 0) {
  const w = mesh.worstFaces(24)[worst];
  camCenter = mesh.faceCenter(w.fi);
  camDist = mesh.geometryQuality().avgEdge * Number(arg('--zoom', 14));
  console.log('worst face', w.fi, 'aspect', w.aspect.toFixed(2), 'at', camCenter.map((x) => x.toFixed(2)).join(','));
}
if (has('--trunk')) {
  // frame the lower trunk
  let lo = [1e9, 1e9, 1e9];
  for (const p of out.positions) for (let i = 0; i < 3; i++) lo[i] = Math.min(lo[i], p[i]);
  const h = Number(arg('--th', 1.2));
  camCenter = [skel.nodes[0].p[0], lo[1] + h, skel.nodes[0].p[2]];
  camDist = skel.nodes[0].r * Number(arg('--zoom', 9));
}
const focus = Number(arg('--focus', -1));
if (focus >= 0) {
  const js = skel.nodes.filter((n) => n.neighbors.length >= 3).sort((a, b) => b.r - a.r);
  const n = js[Math.min(focus, js.length - 1)];
  camCenter = n.p;
  camDist = n.r * Number(arg('--zoom', 9));
}
const eye = V.add(camCenter, V.mul([Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)], camDist));
const fwd = V.norm(V.sub(camCenter, eye));
const right = V.norm(V.cross(fwd, [0, 1, 0]));
const up = V.cross(right, fwd);
const f = (H * 0.5) / Math.tan(0.42);

const project = (p) => {
  const d = V.sub(p, eye);
  const z = V.dot(d, fwd);
  const x = V.dot(d, right);
  const y = V.dot(d, up);
  return [W / 2 + (x / z) * f, H / 2 - (y / z) * f, z];
};

const color = new Uint8Array(W * H * 3);
for (let i = 0; i < W * H; i++) {
  const t = Math.floor(i / W) / H;
  color[i * 3] = 18 + t * 14; color[i * 3 + 1] = 20 + t * 16; color[i * 3 + 2] = 26 + t * 20;
}
const zbuf = new Float32Array(W * H).fill(Infinity);
const L = V.norm([0.45, 0.8, 0.5]);

// per-vertex normals for Gouraud shading (flat quads at 3px look like noise)
const VN = out.positions.map(() => [0, 0, 0]);
for (const q of out.faces) {
  const p = q.map((i) => out.positions[i]);
  const n = V.cross(V.sub(p[2], p[0]), V.sub(p[3], p[1]));
  for (const i of q) VN[i] = V.add(VN[i], n);
}
for (let i = 0; i < VN.length; i++) VN[i] = V.len(VN[i]) > 1e-12 ? V.norm(VN[i]) : [0, 1, 0];

function shadeOf(n) {
  const diff = Math.max(0, V.dot(n, L));
  return 0.16 + 0.84 * diff;
}

function triS(a, b, c, na, nb, nc) {
  const minx = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
  const maxx = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
  const miny = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
  const maxy = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(area) < 1e-9) return;
  const sa = shadeOf(na);
  const sb = shadeOf(nb);
  const sc = shadeOf(nc);
  for (let y = miny; y <= maxy; y++)
    for (let x = minx; x <= maxx; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0])) / area;
      const w1 = ((c[0] - b[0]) * (py - b[1]) - (c[1] - b[1]) * (px - b[0])) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w1 * a[2] + w2 * b[2] + w0 * c[2];
      const idx = y * W + x;
      if (z >= zbuf[idx]) continue;
      zbuf[idx] = z;
      const sh = w1 * sa + w2 * sb + w0 * sc;
      color[idx * 3] = sh * 214; color[idx * 3 + 1] = sh * 178; color[idx * 3 + 2] = sh * 132;
    }
}

function tri(a, b, c, n) {
  const minx = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
  const maxx = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
  const miny = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
  const maxy = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(area) < 1e-9) return;
  const diff = Math.max(0, V.dot(n, L));
  const shade = 0.16 + 0.84 * diff;
  const rgb = [shade * 214, shade * 178, shade * 132];
  for (let y = miny; y <= maxy; y++)
    for (let x = minx; x <= maxx; x++) {
      const px = x + 0.5, py = y + 0.5;
      let w0 = ((b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0])) / area;
      let w1 = ((c[0] - b[0]) * (py - b[1]) - (c[1] - b[1]) * (px - b[0])) / area;
      let w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w1 * a[2] + w2 * b[2] + w0 * c[2];
      const idx = y * W + x;
      if (z >= zbuf[idx]) continue;
      zbuf[idx] = z;
      color[idx * 3] = rgb[0]; color[idx * 3 + 1] = rgb[1]; color[idx * 3 + 2] = rgb[2];
    }
}

const proj = out.positions.map(project);
for (const q of out.faces) {
  const P = q.map((i) => out.positions[i]);
  if (q.some((i) => proj[i][2] <= 0.01)) continue;
  const n = V.norm(V.cross(V.sub(P[1], P[0]), V.sub(P[2], P[0])));
  if (V.dot(n, V.sub(P[0], eye)) > 0) continue; // backface
  if (has('--flat')) {
    tri(proj[q[0]], proj[q[1]], proj[q[2]], n);
    tri(proj[q[0]], proj[q[2]], proj[q[3]], n);
  } else {
    triS(proj[q[0]], proj[q[1]], proj[q[2]], VN[q[0]], VN[q[1]], VN[q[2]]);
    triS(proj[q[0]], proj[q[2]], proj[q[3]], VN[q[0]], VN[q[2]], VN[q[3]]);
  }
}

if (has('--wire')) {
  const line = (p0, p1, rgb) => {
    const steps = Math.ceil(Math.max(Math.abs(p1[0] - p0[0]), Math.abs(p1[1] - p0[1]))) + 1;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = Math.round(p0[0] + (p1[0] - p0[0]) * t);
      const y = Math.round(p0[1] + (p1[1] - p0[1]) * t);
      const z = p0[2] + (p1[2] - p0[2]) * t;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const idx = y * W + x;
      if (z > zbuf[idx] * 1.004) continue;
      color[idx * 3] = rgb[0]; color[idx * 3 + 1] = rgb[1]; color[idx * 3 + 2] = rgb[2];
    }
  };
  for (const [a, b] of out.edges()) {
    if (proj[a][2] <= 0.01 || proj[b][2] <= 0.01) continue;
    line(proj[a], proj[b], [30, 250, 190]);
  }
}

if (has('--skeleton')) {
  for (const n of skel.nodes) {
    const p = project(n.p);
    if (p[2] <= 0.01) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = Math.round(p[0]) + dx, y = Math.round(p[1]) + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const idx = y * W + x;
      color[idx * 3] = 255; color[idx * 3 + 1] = 90; color[idx * 3 + 2] = 60;
    }
  }
}

// --- PNG encode ---
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0;
  Buffer.from(color.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1);
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
};
let table = null;
function crc32(buf) {
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
const file = arg('--out', 'shots/render.png');
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, png);
console.log('wrote', file, `${out.positions.length} verts / ${out.faces.length} quads`);
