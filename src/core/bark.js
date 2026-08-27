// BARK AS GEOMETRY.
//
// Each plate of bark is its OWN closed, all-quad solid: it has a top surface,
// four-plus side walls with real thickness, and a bottom surface that is hidden
// against the wood. Nothing here is a texture, a height field or a displaced
// grid - a height field cannot produce a gap, a thickness or a lifted edge, and
// that is exactly what makes plated bark read as plated bark.
//
// Pipeline
//   1. ride the frames the skinner actually swept (skin.js -> result.tubes), so
//      the seat of every plate is on the rendered surface, not on a guessed
//      cylinder;
//   2. unroll each limb into a periodic (x = arc around, y = arc along) strip;
//   3. fracture that strip with sequential crack growth (crack2d.js) -> convex
//      polygonal cells, T junctions only;
//   4. inset each cell by half the fissure width -> the crack becomes a real
//      OPEN GAP with two free faces instead of a dark line;
//   5. loft each inset polygon into one closed solid: base ring (sunk into the
//      wood) -> outer top ring -> inner top ring -> apex, giving a bevelled,
//      slightly domed plate. 3m quads per plate, no triangles, no n-gons;
//   6. give each plate a bond state - bonded / peeling (one edge lifts and
//      curls off the stem) / shed (absent, exposing the fresh wood underneath),
//      which is where the orange patches in real Platanus bark come from.
//
// Background: Federl & Prusinkiewicz 1996/2004 (bark as a fracturing layer on a
// growing stem), Dale et al. 2014 (biomechanics of bark), Bohn/Pauchard/Couder
// 2005 and Goehring & Morris 2014 (hierarchical crack networks, T junctions),
// Lefebvre & Neyret EGSR 2002 (fissure treated as an explicit widening element).
// See public/bark-research.html for the full write-up.

import * as V from './vec3.js';
import { QuadMesh } from './quadmesh.js';
import { makeRng } from './rng.js';
import { fragmentStrip, polyArea, polyCentroid, polyBBox, pointInPoly, isSimple } from './crack2d.js';
import { buildLimbs } from './skin.js';

export const BARK_DEFAULTS = {
  barkPlateHeight: 0.30,  // target plate size along the stem (world units)
  barkElongation: 2.0,    // plate height / width
  barkFissure: 0.008,     // width of the open gap between plates
  barkThickness: 0.022,   // plate thickness (real geometry, not displacement)
  barkMeander: 0.45,      // crack waviness 0..1
  barkSizeVar: 0.5,       // spread of plate sizes
  barkSizeGrade: 0.7,     // how much plate size follows the local stem radius
  barkShed: 0.06,         // fraction of plates missing (exposes the wood)
  barkPeel: 0.14,         // fraction of plates lifted along one edge
  barkPeelAmount: 1.1,    // lift height, in plate thicknesses
  barkDome: 0.20,         // top-surface doming, in plate thicknesses
  barkMinRadius: 0.07,    // stems thinner than this stay smooth
  barkClearance: 0.3,     // bare gap kept at each end of a limb, in radii
  barkSeat: 0.45,         // how deep the base is sunk into the wood, in thicknesses
  barkBevel: 0.45,        // width of the top bevel, as a fraction of the plate
  barkSeed: 11,
  barkMaxPlates: 6000,
  barkDebug: 0,
  barkSeatRatio: 2.4,
  barkSeatDrift: 0.40,   // max deviation from the limb's own radius profile   // max radius spread across one plate before it is dropped
  barkAspectLimit: 22,   // a plate with a worse quad than this is discarded
};

// ---------------------------------------------------------------------------
// The cross section the subdivided skin actually renders.
// A limb loop is a square of 4 control points; Catmull-Clark on a regular quad
// tube is tensor-product cubic B-spline refinement, so along the ring it is
// exactly the closed cubic B-spline rule. Refining `levels` times gives the
// polygon the renderer draws - radius 1.0 at level 0, 0.707..0.75 at level 1,
// 0.657..0.667 in the limit. Seating the plates on THAT curve is why they do
// not float off the thin sides or sink through the fat corners.
// ---------------------------------------------------------------------------
function sectionPolygon(levels) {
  let p = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  for (let l = 0; l < Math.max(0, Math.min(6, levels)); l++) {
    const n = p.length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = p[(i + n - 1) % n];
      const b = p[i];
      const c = p[(i + 1) % n];
      out.push([(a[0] + 6 * b[0] + c[0]) / 8, (a[1] + 6 * b[1] + c[1]) / 8]);
      out.push([(b[0] + c[0]) / 2, (b[1] + c[1]) / 2]);
    }
    p = out;
  }
  return p;
}

/** radius(theta) of that polygon, theta measured from the loop's u axis. */
export function makeSectionRadius(levels) {
  const p = sectionPolygon(levels);
  const n = p.length;
  const ang = p.map((q) => Math.atan2(q[1], q[0]));
  // make the angle list strictly increasing so a binary search is exact
  for (let i = 1; i < n; i++) while (ang[i] <= ang[i - 1]) ang[i] += Math.PI * 2;
  const a0 = ang[0];
  return (theta) => {
    let t = a0 + (((theta - a0) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ang[mid] <= t) lo = mid; else hi = mid - 1;
    }
    const i = lo;
    const A = p[i];
    const B = p[(i + 1) % n];
    const dx = Math.cos(t);
    const dy = Math.sin(t);
    const ex = B[0] - A[0];
    const ey = B[1] - A[1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) return Math.hypot(A[0], A[1]);
    const s = (dy * A[0] - dx * A[1]) / den;
    if (!(s >= -1e-6 && s <= 1 + 1e-6)) return Math.hypot(A[0], A[1]);
    const r = (A[0] + ex * s) * dx + (A[1] + ey * s) * dy;
    return r > 0 ? r : Math.hypot(A[0], A[1]);
  };
}

// ---------------------------------------------------------------------------
// limb parameterisation
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// polygon inset (the fissure gap)
// ---------------------------------------------------------------------------
function insetPolygon(poly, d) {
  const n = poly.length;
  if (n < 3 || d <= 0) return poly.map((p) => [p[0], p[1]]);
  const sign = polyArea(poly) >= 0 ? 1 : -1;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const L = Math.hypot(ex, ey);
    if (L < 1e-12) return null;
    // inward normal for a CCW ring is (-ey, ex) rotated the right way
    const nx = (sign * ey) / L;
    const ny = (-sign * ex) / L;
    lines.push([a[0] + nx * d, a[1] + ny * d, ex / L, ey / L]);
  }
  const out = [];
  const miter = 2.2 * d; // a sharp corner must not shoot the vertex off to infinity
  for (let i = 0; i < n; i++) {
    const A = lines[(i + n - 1) % n];
    const B = lines[i];
    const den = A[2] * B[3] - A[3] * B[2];
    let q;
    if (Math.abs(den) < 1e-9) q = [B[0], B[1]];
    else {
      const t = ((B[0] - A[0]) * B[3] - (B[1] - A[1]) * B[2]) / den;
      q = [A[0] + A[2] * t, A[1] + A[3] * t];
    }
    const vx = q[0] - poly[i][0];
    const vy = q[1] - poly[i][1];
    const L = Math.hypot(vx, vy);
    if (L > miter) q = [poly[i][0] + (vx / L) * miter, poly[i][1] + (vy / L) * miter];
    out.push(q);
  }
  const a0 = Math.abs(polyArea(poly));
  const a1 = Math.abs(polyArea(out));
  if (!(a1 > a0 * 0.05) || a1 > a0 || !isSimple(out)) {
    // sharp corner blew the offset up: fall back to a centroid shrink
    const c = polyCentroid(poly);
    const per = poly.reduce((acc, p, i) => acc + Math.hypot(
      poly[(i + 1) % n][0] - p[0], poly[(i + 1) % n][1] - p[1]), 0);
    const k = Math.max(0.2, 1 - (d * per) / Math.max(a0 * 2, 1e-9));
    const shrunk = poly.map((p) => [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k]);
    return isSimple(shrunk) ? shrunk : null;
  }
  return out;
}

/** Drop near-duplicate and near-collinear vertices - they are what turn into
 *  zero-length edges and needle quads further down. */
function tidyRing(poly, eps) {
  let out = [];
  for (const p of poly) {
    if (!out.length || Math.hypot(p[0] - out[out.length - 1][0], p[1] - out[out.length - 1][1]) > eps)
      out.push(p);
  }
  while (out.length > 3 &&
    Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= eps) out.pop();
  // collinear pass
  const keep = [];
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const a = out[(i + n - 1) % n];
    const b = out[i];
    const c = out[(i + 1) % n];
    const ax = b[0] - a[0];
    const ay = b[1] - a[1];
    const bx = c[0] - b[0];
    const by = c[1] - b[1];
    const area2 = Math.abs(ax * by - ay * bx);
    const scale = Math.hypot(ax, ay) * Math.hypot(bx, by);
    if (scale < 1e-18 || area2 / Math.max(scale, 1e-18) > 0.02) keep.push(b);
  }
  return keep.length >= 3 ? keep : (out.length >= 3 ? out : null);
}

/**
 * Split counts per edge so no segment is longer than `seg`, always EVEN (the
 * cap quadrangulation needs an even ring), and the same counts are then used
 * for the inset rings so the four rings stay in correspondence.
 */
function ringCounts(poly, seg) {
  const n = poly.length;
  const k = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    k.push(Math.max(1, Math.min(4, Math.round(L / Math.max(seg, 1e-6)))) * 2);
  }
  return k;
}

function refineWith(poly, counts) {
  const n = poly.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    for (let j = 0; j < counts[i]; j++) {
      const t = j / counts[i];
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// one plate -> one closed all-quad solid
// ---------------------------------------------------------------------------
function buildPlate(coarse, place, opt) {
  const c = polyCentroid(coarse);
  const mesh = new QuadMesh();

  const th = opt.thickness;
  const sink = opt.seat * th;

  // Concentric rings inward: outer -> draft (top edge) -> bevel -> mid -> apex.
  // The insets are taken on the COARSE outline and only then refined, so an
  // inset can never eat a whole segment and collapse a quad.
  const minEdge = (poly) => {
    let mn = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      mn = Math.min(mn, Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    return mn;
  };
  // an offset larger than a third of the shortest edge collapses that edge and
  // leaves a needle quad, so it is clamped rather than clipped afterwards
  const insetOr = (poly, want) => {
    const d = Math.min(want, minEdge(poly) * 0.33);
    const r = insetPolygon(poly, d);
    if (r && r.length === poly.length && isSimple(r) &&
        Math.abs(polyArea(r)) > Math.abs(polyArea(poly)) * 0.15) return r;
    const k = Math.max(0.2, 1 - (2 * d) / Math.max(opt.size, 1e-6));
    return poly.map((p) => [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k]);
  };
  const cTop = insetOr(coarse, opt.draftDist);
  const cBev = insetOr(cTop, opt.bevelDist);
  const cMid = cBev.map((p) => [c[0] + (p[0] - c[0]) * 0.36, c[1] + (p[1] - c[1]) * 0.36]);

  const counts = ringCounts(coarse, opt.seg);
  const ring = refineWith(coarse, counts);
  const topRing = refineWith(cTop, counts);
  const bevelRing = refineWith(cBev, counts);
  const midRing = refineWith(cMid, counts);
  const m = ring.length;
  if (m < 4 || m % 2) return null;

  // peel: one edge of the plate lifts off the stem and curls out
  let peelAxis = null;
  let halfSpan = 1;
  if (opt.peel > 0) {
    peelAxis = [Math.cos(opt.peelAngle), Math.sin(opt.peelAngle)];
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of ring) {
      const d = (p[0] - c[0]) * peelAxis[0] + (p[1] - c[1]) * peelAxis[1];
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    halfSpan = Math.max(hi - lo, 1e-6);
  }
  const peelAt = (p) => {
    if (!peelAxis) return 0;
    const d = (p[0] - c[0]) * peelAxis[0] + (p[1] - c[1]) * peelAxis[1];
    const t = Math.max(0, Math.min(1, (d + halfSpan / 2) / halfSpan));
    const e = Math.max(0, (t - 0.35) / 0.65);
    return opt.peel * th * e * e;
  };

  let miss = false;
  const pos = (p, h) => {
    const q = place(p[0], p[1], h);
    if (!q) { miss = true; return [0, 0, 0]; }
    return q;
  };
  const base = [];
  const top = [];
  const bev = [];
  const mid = [];
  for (let i = 0; i < m; i++) {
    const lift = peelAt(ring[i]);
    base.push(mesh.addVertex(pos(ring[i], -sink + lift)));
    top.push(mesh.addVertex(pos(topRing[i], th + lift)));
    bev.push(mesh.addVertex(pos(bevelRing[i], th + lift * 0.96 + opt.dome * th * 0.4)));
    mid.push(mesh.addVertex(pos(midRing[i], th + lift * 0.9 + opt.dome * th * 0.8)));
  }
  const apexLift = peelAt(c);
  const topC = mesh.addVertex(pos(c, th + apexLift + opt.dome * th));
  const botC = mesh.addVertex(pos(c, -sink + apexLift));
  if (miss) return null;

  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    mesh.addQuad(base[i], base[j], top[j], top[i], 'bark');       // side wall
    mesh.addQuad(top[i], top[j], bev[j], bev[i], 'bark');         // top rim bevel
    mesh.addQuad(bev[i], bev[j], mid[j], mid[i], 'bark');         // top face
  }
  for (let i = 0; i < m; i += 2) {
    const prev = (i + m - 1) % m;
    mesh.addQuad(topC, mid[prev], mid[i], mid[(i + 1) % m], 'bark');    // apex fan
    mesh.addQuad(botC, base[(i + 1) % m], base[i], base[prev], 'bark'); // underside
  }
  return { mesh, ring };
}

/** Signed volume; used to check every plate came out inside-out-free. */
function meshVolume(mesh) {
  let vol = 0;
  for (const f of mesh.faces) {
    const p = f.map((i) => mesh.positions[i]);
    for (const [a, b, c] of [[p[0], p[1], p[2]], [p[0], p[2], p[3]]]) {
      vol += V.dot(a, V.cross(b, c)) / 6;
    }
  }
  return vol;
}

// ---------------------------------------------------------------------------
// SEATING: a plate is placed on the surface the renderer actually draws, by
// casting a ray outward from the stem axis and landing on the skin. That is
// what keeps the plates on the wood through the root flare, the branch collars
// and the taper, instead of on an idealised cylinder that only matches in the
// middle of a straight tube.
// ---------------------------------------------------------------------------
function buildRayGrid(mesh, boxes) {
  const tris = [];
  const inBox = (c) => {
    for (const b of boxes) {
      if (c[0] >= b[0] && c[0] <= b[3] && c[1] >= b[1] && c[1] <= b[4] && c[2] >= b[2] && c[2] <= b[5])
        return true;
    }
    return false;
  };
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  let edgeSum = 0;
  for (const f of mesh.faces) {
    const p = f.map((i) => mesh.positions[i]);
    const c = [
      (p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4,
      (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4,
      (p[0][2] + p[1][2] + p[2][2] + p[3][2]) / 4,
    ];
    if (!inBox(c)) continue;
    tris.push([p[0], p[1], p[2]], [p[0], p[2], p[3]]);
    edgeSum += V.dist(p[0], p[1]);
    for (const q of p)
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], q[k]); hi[k] = Math.max(hi[k], q[k]); }
  }
  if (!tris.length) return null;
  const cell = Math.max((edgeSum / (tris.length / 2)) * 1.5, 1e-4);
  const grid = new Map();
  const key = (i, j, k) => `${i},${j},${k}`;
  const idx = (p) => [
    Math.floor((p[0] - lo[0]) / cell),
    Math.floor((p[1] - lo[1]) / cell),
    Math.floor((p[2] - lo[2]) / cell),
  ];
  tris.forEach((t, ti) => {
    const a = idx(t[0]);
    const b = idx(t[1]);
    const c = idx(t[2]);
    for (let i = Math.min(a[0], b[0], c[0]); i <= Math.max(a[0], b[0], c[0]); i++)
      for (let j = Math.min(a[1], b[1], c[1]); j <= Math.max(a[1], b[1], c[1]); j++)
        for (let k = Math.min(a[2], b[2], c[2]); k <= Math.max(a[2], b[2], c[2]); k++) {
          const kk = key(i, j, k);
          let arr = grid.get(kk);
          if (!arr) grid.set(kk, (arr = []));
          arr.push(ti);
        }
  });

  /** nearest hit of the ray o + t*d with t in [tMin, tMax]; null if none. */
  function hit(o, d, tMin, tMax) {
    const step = cell * 0.6;
    const seen = new Set();
    let best = null;
    for (let t = tMin; t <= tMax + step; t += step) {
      const p = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
      const c = idx(p);
      for (let i = -1; i <= 1; i++)
        for (let j = -1; j <= 1; j++)
          for (let k = -1; k <= 1; k++) {
            const arr = grid.get(key(c[0] + i, c[1] + j, c[2] + k));
            if (!arr) continue;
            for (const ti of arr) {
              if (seen.has(ti)) continue;
              seen.add(ti);
              const T = tris[ti];
              const h = rayTri(o, d, T[0], T[1], T[2]);
              if (h === null || h < tMin || h > tMax) continue;
              if (!best || h < best.t) {
                const n = V.norm(V.cross(V.sub(T[1], T[0]), V.sub(T[2], T[0])));
                best = { t: h, n: V.dot(n, d) < 0 ? V.mul(n, -1) : n };
              }
            }
          }
      if (best && t > best.t + cell * 2) break;
    }
    return best;
  }
  return { hit, triangles: tris.length };
}

function rayTri(o, d, a, b, c) {
  const e1 = V.sub(b, a);
  const e2 = V.sub(c, a);
  const pv = V.cross(d, e2);
  const det = V.dot(e1, pv);
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const tv = V.sub(o, a);
  const u = V.dot(tv, pv) * inv;
  if (u < -1e-6 || u > 1 + 1e-6) return null;
  const qv = V.cross(tv, e1);
  const v = V.dot(d, qv) * inv;
  if (v < -1e-6 || u + v > 1 + 1e-6) return null;
  const t = V.dot(e2, qv) * inv;
  return t > 0 ? t : null;
}

/** Resample a skeleton limb into a rail with a rotation-minimising frame. */
function makeRail(nodes, path, step) {
  const pts = path.map((i) => nodes[i].p);
  const rad = path.map((i) => nodes[i].r);
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + V.dist(pts[i], pts[i - 1]));
  const total = acc[acc.length - 1];
  if (total < 1e-6) return null;
  const n = Math.max(2, Math.ceil(total / Math.max(step, 1e-4)));
  const samples = [];
  for (let k = 0; k <= n; k++) {
    const s = (total * k) / n;
    let i = 1;
    while (i < acc.length - 1 && acc[i] < s) i++;
    const t = (s - acc[i - 1]) / Math.max(acc[i] - acc[i - 1], 1e-9);
    samples.push({ s, p: V.lerp(pts[i - 1], pts[i], t), r: rad[i - 1] + (rad[i] - rad[i - 1]) * t });
  }
  for (let k = 0; k < samples.length; k++) {
    const a = samples[Math.max(k - 1, 0)].p;
    const b = samples[Math.min(k + 1, samples.length - 1)].p;
    samples[k].t = V.norm(V.sub(b, a));
  }
  samples[0].u = V.perp(samples[0].t);
  for (let k = 1; k < samples.length; k++)
    samples[k].u = V.orthoNorm(V.rotateFromTo(samples[k - 1].u, samples[k - 1].t, samples[k].t), samples[k].t);
  for (const f of samples) f.w = V.cross(f.t, f.u);

  const at = (y) => {
    const yy = Math.max(0, Math.min(total, y));
    const g = (yy / total) * n;
    const i = Math.min(n - 1, Math.floor(g));
    const t = g - i;
    const A = samples[i];
    const B = samples[i + 1];
    const tan = V.norm(V.lerp(A.t, B.t, t));
    return {
      p: V.lerp(A.p, B.p, t),
      t: tan,
      u: V.orthoNorm(V.lerp(A.u, B.u, t), tan),
      w: null,
      r: A.r + (B.r - A.r) * t,
    };
  };
  return { length: total, at, rMax: Math.max(...rad), rMin: Math.min(...rad) };
}

// ---------------------------------------------------------------------------
/**
 * @param {object} skel   the skeleton (nodes + bones)
 * @param {QuadMesh} skin the mesh that is actually rendered (subdivided skin)
 * @param {object} opts   BARK_DEFAULTS overrides
 */
export function buildBark(skel, skin, opts = {}) {
  const O = { ...BARK_DEFAULTS, ...opts };
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const rng = makeRng(Math.round(O.barkSeed) * 7919 + 13);
  const { nodes } = skel;

  // ---- which limbs get bark, and over what stretch
  const limbs = buildLimbs(skel);
  const rails = [];
  const boxes = [];
  for (const limb of limbs) {
    const path = limb.path;
    if (path.length < 2) continue;
    if (Math.max(...path.map((i) => nodes[i].r)) < O.barkMinRadius) continue;
    const rail = makeRail(nodes, path, Math.max(O.barkPlateHeight * 0.25, 0.02));
    if (!rail) continue;
    // keep clear of the hub box at either end - that is where two limbs share
    // the same piece of surface, and two rails would fight over it
    const endPad = (idx) => {
      const nd = nodes[idx];
      // a fork needs the whole hub box cleared; a free end just needs to stay
      // off the rounded cap
      return nd.neighbors.length >= 3 ? nd.r * 0.88 * (1 + O.barkClearance) : nd.r * 0.75;
    };
    const y0 = Math.min(endPad(path[0]), rail.length * 0.45);
    const y1 = rail.length - Math.min(endPad(path[path.length - 1]), rail.length * 0.45);
    if (y1 - y0 < O.barkPlateHeight * 0.7) continue;
    rails.push({ rail, y0, y1 });
    let lo = [Infinity, Infinity, Infinity];
    let hi = [-Infinity, -Infinity, -Infinity];
    for (const i of path) {
      const m = nodes[i].r * 2.6 + O.barkThickness * 4;
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], nodes[i].p[k] - m);
        hi[k] = Math.max(hi[k], nodes[i].p[k] + m);
      }
    }
    boxes.push([...lo, ...hi]);
  }

  const grid = rails.length ? buildRayGrid(skin, boxes) : null;
  const plates = [];
  const stats = {
    limbs: 0, cells: 0, plates: 0, shed: 0, peeled: 0, splits: 0,
    cellArea: 0, plateArea: 0, tJunctions: 0, xJunctions: 0, dropped: 0, missed: 0, missNoHit: 0, missStep: 0, rejected: 0, quads: 0, vertices: 0,
    gridTris: grid ? grid.triangles : 0,
  };
  const sizes = [];
  const overlapCheck = [];

  for (const R of rails) {
    if (plates.length >= O.barkMaxPlates) break;
    const { rail, y0, y1 } = R;
    const limbId = ++stats.limbs;

    // mean seated radius over the stretch, used to unroll the strip
    let rSum = 0;
    let rN = 0;
    const probe = 9;
    for (let k = 0; k < probe; k++) {
      const y = y0 + ((y1 - y0) * k) / (probe - 1);
      const f = rail.at(y);
      const w = V.cross(f.t, f.u);
      for (let a = 0; a < 4; a++) {
        const th = (a / 4) * Math.PI * 2;
        const d = V.norm(V.add(V.mul(f.u, Math.cos(th)), V.mul(w, Math.sin(th))));
        const h = grid && grid.hit(f.p, d, f.r * 0.2, f.r * 3.2);
        if (h) { rSum += h.t; rN++; }
      }
    }
    if (rN < probe) continue;              // this limb is not really on the skin
    const rRef = rSum / rN;
    const W = 2 * Math.PI * rRef;

    // local seated radius, so both the plate size and the unwrap distortion
    // can be corrected where the stem tapers
    const localR = (y) => {
      const f = rail.at(y);
      const w = V.cross(f.t, f.u);
      let sum = 0;
      let hits = 0;
      for (let a = 0; a < 4; a++) {
        const th = ((a + 0.5) / 4) * Math.PI * 2;
        const d = V.norm(V.add(V.mul(f.u, Math.cos(th)), V.mul(w, Math.sin(th))));
        const h = grid.hit(f.p, d, f.r * 0.2, Math.max(f.r, rRef) * 3.2);
        if (h) { sum += h.t; hits++; }
      }
      return hits ? sum / hits : f.r;
    };
    const rTable = [];
    const RT = 12;
    for (let k = 0; k <= RT; k++) rTable.push(localR(y0 + ((y1 - y0) * k) / RT));
    const rAt = (y) => {
      const g = Math.max(0, Math.min(RT, ((y - y0) / Math.max(y1 - y0, 1e-9)) * RT));
      const i = Math.min(RT - 1, Math.floor(g));
      return rTable[i] + (rTable[i + 1] - rTable[i]) * (g - i);
    };
    const grade = (y) => {
      const k = Math.pow(Math.max(rAt(y), 1e-6) / Math.max(rRef, 1e-6), 0.7);
      return 1 + (k - 1) * O.barkSizeGrade;
    };

    const frag = fragmentStrip({
      W,
      y0,
      y1,
      // parameter-space aspect corrected for the local circumference, so a
      // plate is the same shape on a thin stem as on a fat one
      elongation: (y) => O.barkElongation * Math.max(rAt(y) / Math.max(rRef, 1e-9), 0.15),
      meander: O.barkMeander,
      sizeVar: O.barkSizeVar,
      cellHeight: (y) => O.barkPlateHeight * grade(y),
      rng,
      maxCells: Math.max(32, Math.round(O.barkMaxPlates)),
    });
    stats.cells += frag.stats.cells;
    stats.splits += frag.stats.splits;
    stats.tJunctions += frag.stats.tJunctions;
    stats.xJunctions += frag.stats.xJunctions;

    // (x, y) -> a point on the real skin, plus its outward normal
    const seatCache = new Map();
    const seat = (x, y) => {
      const f = rail.at(Math.max(y0 - 0.02, Math.min(y1 + 0.02, y)));
      const w = V.cross(f.t, f.u);
      const theta = (x / W) * Math.PI * 2;
      const d = V.norm(V.add(V.mul(f.u, Math.cos(theta)), V.mul(w, Math.sin(theta))));
      const h = grid.hit(f.p, d, f.r * 0.25, Math.max(f.r, rRef) * 3.2);
      if (!h) return null;
      return {
        p: [f.p[0] + d[0] * h.t, f.p[1] + d[1] * h.t, f.p[2] + d[2] * h.t],
        n: h.n,
        t: h.t,
      };
    };
    const place = (x, y, height) => {
      const k = `${Math.round(x * 4096)},${Math.round(y * 4096)}`;
      let s = seatCache.get(k);
      if (s === undefined) { s = seat(x, y); seatCache.set(k, s); }
      if (!s) return null;
      return [s.p[0] + s.n[0] * height, s.p[1] + s.n[1] * height, s.p[2] + s.n[2] * height];
    };

    const inset = O.barkFissure * 0.5;
    // plates already placed on this limb, so a new one can be proved not to
    // touch them before it is built
    const placed = [];
    const bbHit = (a, b) => !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
    const clashes = (poly) => {
      const bb = polyBBox(poly);
      for (const q of placed) if (bbHit(bb, q.bb) && polysOverlap(poly, q.poly)) return true;
      return false;
    };
    for (const cell of frag.cells) {
      stats.cellArea += Math.abs(polyArea(cell));
      if (plates.length >= O.barkMaxPlates) break;
      if (Math.abs(polyArea(cell)) < (O.barkFissure * 3) ** 2) { stats.dropped++; continue; }
      const ring0 = insetPolygon(cell, inset);
      if (!ring0) { stats.dropped++; continue; }
      const bb = polyBBox(ring0);
      const dx = bb[2] - bb[0];
      const dy = bb[3] - bb[1];
      if (dx < O.barkFissure || dy < O.barkFissure) { stats.dropped++; continue; }

      if (rng() < O.barkShed) { stats.shed++; continue; }   // this plate has fallen off
      const peeling = rng() < O.barkPeel;

      const size = Math.sqrt(Math.abs(polyArea(ring0)));
      const peelAngle = rng() * Math.PI * 2;

      // Build the plate, and if its own quads come out badly shaped, rebuild it
      // coarser instead of throwing it away - a missing plate is a hole in the
      // bark, and holes are what made the first attempts look moth-eaten.
      let mesh = null;
      let tidy = null;
      let attempt = 0;
      let failure = '';
      for (; attempt < 3 && !mesh; attempt++) {
        const seg = Math.max(size * 0.5 * (1 + attempt * 0.45), O.barkFissure * 1.5);
        let tr = tidyRing(ring0, seg * (0.3 + attempt * 0.12));
        if (!tr || !isSimple(tr) || tr.length < 3) { failure = 'ring'; continue; }
        // simplifying the outline can push a corner back out towards the
        // neighbour; shrink until it provably clears, or give up on this plate
        if (clashes(tr)) {
          const cc = polyCentroid(tr);
          let cleared = false;
          for (let k = 0; k < 4 && !cleared; k++) {
            tr = tr.map((q) => [cc[0] + (q[0] - cc[0]) * 0.94, cc[1] + (q[1] - cc[1]) * 0.94]);
            cleared = !clashes(tr);
          }
          if (!cleared) { failure = 'clash'; continue; }
        }

        // reject anything that cannot be seated cleanly (a crotch, a hole, a
        // stretch of surface the axis cannot see) instead of shipping a plate
        // that floats or dives through the wood
        let rLo = Infinity;
        let rHi = 0;
        let drift = 0;
        let ok = true;
        for (const q of tr) {
          const st = seat(q[0], q[1]);
          if (!st) { ok = false; break; }
          rLo = Math.min(rLo, st.t);
          rHi = Math.max(rHi, st.t);
          drift = Math.max(drift, Math.abs(st.t - rAt(q[1])) / Math.max(rAt(q[1]), 1e-6));
        }
        if (!ok) { failure = 'nohit'; break; }
        if (rHi > rLo * O.barkSeatRatio || drift > O.barkSeatDrift) { failure = 'step'; break; }

        const th = O.barkThickness * (0.75 + 0.5 * Math.pow(Math.min(1, rLo / Math.max(rRef, 1e-6)), 0.5));
        const built = buildPlate(tr, place, {
          thickness: th,
          seat: O.barkSeat,
          dome: O.barkDome,
          size,
          seg,
          draftDist: Math.min(th * 0.4, size * 0.06),
          bevelDist: Math.min(size * 0.16 * (0.4 + O.barkBevel), Math.min(dx, dy) * 0.22),
          peel: peeling ? O.barkPeelAmount : 0,
          peelAngle,
        });
        if (!built) { failure = 'nohit'; break; }
        const m = built.mesh;
        if (meshVolume(m) < 0) for (const f of m.faces) f.reverse();
        const q = m.geometryQuality(O.barkAspectLimit);
        const v = m.validate();
        if (q.pinched || q.maxAspect > O.barkAspectLimit || !v.quadsOnly ||
            v.boundaryEdges || v.nonManifoldEdges || v.flippedEdges || v.shells !== 1 || v.euler !== 2) {
          failure = 'quality';
          continue;
        }
        mesh = m;
        tidy = built.ring;
      }
      if (!mesh) {
        if (failure === 'nohit') { stats.missNoHit++; stats.missed++; }
        else if (failure === 'step') { stats.missStep++; stats.missed++; }
        else stats.rejected++;
        continue;
      }
      placed.push({ poly: tidy, bb: polyBBox(tidy) });
      sizes.push([dx, dy]);
      stats.plateArea += Math.abs(polyArea(tidy));
      if (peeling) stats.peeled++;
      overlapCheck.push({ limb: limbId, poly: tidy, bb: polyBBox(tidy) });
      plates.push({
        mesh,
        ring2d: tidy,
        limb: limbId,
        peeling,
        y: polyCentroid(ring0)[1] / Math.max(rail.length, 1e-6),
        shade: rng(),
      });
      stats.quads += mesh.faces.length;
      stats.vertices += mesh.positions.length;
    }
  }
  stats.plates = plates.length;

  // ---- audit: two plates sharing parameter space on one limb is the only way
  // this construction can interpenetrate, so that is what gets measured
  stats.overlaps = countOverlaps(overlapCheck);
  if (sizes.length) {
    const hs = sizes.map((s) => s[1]).sort((a, b) => a - b);
    const ws = sizes.map((s) => s[0]).sort((a, b) => a - b);
    stats.medianHeight = hs[hs.length >> 1];
    stats.medianWidth = ws[ws.length >> 1];
    stats.aspect = stats.medianHeight / Math.max(stats.medianWidth, 1e-9);
  }
  stats.ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return { plates, stats, options: O };
}

function countOverlaps(items) {
  let n = 0;
  const byLimb = new Map();
  for (const it of items) {
    if (!byLimb.has(it.limb)) byLimb.set(it.limb, []);
    byLimb.get(it.limb).push(it);
  }
  for (const list of byLimb.values()) {
    list.sort((a, b) => a.bb[1] - b.bb[1]);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i];
        const B = list[j];
        if (B.bb[1] > A.bb[3]) break;
        if (B.bb[0] > A.bb[2] || A.bb[0] > B.bb[2]) continue;
        if (polysOverlap(A.poly, B.poly)) n++;
      }
    }
  }
  return n;
}

function polysOverlap(a, b) {
  for (const p of a) if (pointInPoly(b, p)) return true;
  for (const p of b) if (pointInPoly(a, p)) return true;
  for (let i = 0; i < a.length; i++) {
    const a0 = a[i];
    const a1 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const b0 = b[j];
      const b1 = b[(j + 1) % b.length];
      if (segInt(a0, a1, b0, b1)) return true;
    }
  }
  return false;
}
function segInt(a, b, c, d) {
  const cr = (px, py, qx, qy) => px * qy - py * qx;
  const d1 = cr(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]);
  const d2 = cr(b[0] - a[0], b[1] - a[1], d[0] - a[0], d[1] - a[1]);
  const d3 = cr(d[0] - c[0], d[1] - c[1], a[0] - c[0], a[1] - c[1]);
  const d4 = cr(d[0] - c[0], d[1] - c[1], b[0] - c[0], b[1] - c[1]);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/** Every plate as its own object in one OBJ file - they stay separate meshes. */
export function barkToOBJ(bark, name = 'bark') {
  const lines = [`# PlantGenerator - bark: ${bark.plates.length} separate all-quad plates`];
  let base = 0;
  bark.plates.forEach((pl, i) => {
    lines.push(`o ${name}_${String(i).padStart(5, '0')}`);
    for (const p of pl.mesh.positions)
      lines.push(`v ${p[0].toFixed(6)} ${p[1].toFixed(6)} ${p[2].toFixed(6)}`);
    for (const f of pl.mesh.faces)
      lines.push(`f ${f[0] + 1 + base} ${f[1] + 1 + base} ${f[2] + 1 + base} ${f[3] + 1 + base}`);
    base += pl.mesh.positions.length;
  });
  return lines.join('\n') + '\n';
}

/** Topology audit over every plate. */
export function auditBark(bark) {
  let closed = 0;
  let quadsOnly = 0;
  let single = 0;
  let euler2 = 0;
  let worstAspect = 0;
  let pinched = 0;
  for (const pl of bark.plates) {
    const v = pl.mesh.validate();
    const q = pl.mesh.geometryQuality(14);
    if (v.boundaryEdges === 0 && v.nonManifoldEdges === 0 && v.flippedEdges === 0) closed++;
    if (v.quadsOnly) quadsOnly++;
    if (v.shells === 1) single++;
    if (v.euler === 2) euler2++;
    worstAspect = Math.max(worstAspect, q.maxAspect);
    pinched += q.pinched;
  }
  const n = bark.plates.length || 1;
  return {
    plates: bark.plates.length,
    closed,
    quadsOnly,
    single,
    euler2,
    worstAspect,
    pinched,
    allClosed: closed === bark.plates.length,
    allQuads: quadsOnly === bark.plates.length,
    allSingle: single === bark.plates.length,
    allSphere: euler2 === bark.plates.length,
    perPlateQuads: bark.stats.quads / n,
  };
}
