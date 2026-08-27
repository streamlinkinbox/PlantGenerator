// Branch collision handling on the SKELETON, before any geometry exists.
// Two limbs whose capsules interpenetrate would produce a skin with parts
// buried inside other parts, which is exactly the "overlapping / intersecting
// pieces" failure. We (1) detect it with capsule-capsule tests on a uniform
// grid, (2) push offending branches apart by rotating their whole sub-tree
// about the junction they grew from, and (3) self-prune whatever still
// intersects afterwards - which is also what real trees do.

import * as V from './vec3.js';

/** Closest distance between segments [p1,q1] and [p2,q2] + the closest points. */
export function segSegDistance(p1, q1, p2, q2) {
  const d1 = V.sub(q1, p1);
  const d2 = V.sub(q2, p2);
  const r = V.sub(p1, p2);
  const a = V.dot(d1, d1);
  const e = V.dot(d2, d2);
  const f = V.dot(d2, r);
  let s;
  let t;
  const EPS = 1e-12;
  if (a <= EPS && e <= EPS) return { dist: V.len(r), c1: p1, c2: p2 };
  if (a <= EPS) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = V.dot(d1, r);
    if (e <= EPS) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = V.dot(d1, d2);
      const denom = a * e - b * b;
      s = denom > EPS ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  const c1 = V.add(p1, V.mul(d1, s));
  const c2 = V.add(p2, V.mul(d2, t));
  return { dist: V.dist(c1, c2), c1, c2 };
}

/**
 * All pairs of non-neighbouring bones whose capsules overlap.
 * Written allocation-free (flat typed arrays, numeric hashes) because the
 * resolver calls it dozens of times per generated tree.
 */
export function findCollisions(skel, clearance = 1.35) {
  const { nodes, bones } = skel;
  const n = bones.length;
  if (!n) return [];

  const ax = new Float64Array(n); const ay = new Float64Array(n); const az = new Float64Array(n);
  const bx = new Float64Array(n); const by = new Float64Array(n); const bz = new Float64Array(n);
  const rad = new Float64Array(n); const raw = new Float64Array(n);
  const ia = new Int32Array(n); const ib = new Int32Array(n);
  let cell = 0;
  for (let i = 0; i < n; i++) {
    const [a, b] = bones[i];
    const A = nodes[a].p; const B = nodes[b].p;
    ax[i] = A[0]; ay[i] = A[1]; az[i] = A[2];
    bx[i] = B[0]; by[i] = B[1]; bz[i] = B[2];
    const r0 = Math.max(nodes[a].r, nodes[b].r);
    raw[i] = r0;
    rad[i] = r0 * clearance;
    ia[i] = a; ib[i] = b;
    cell += Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]) + r0 * 2 * clearance;
  }
  cell = Math.max(cell / n, 1e-4);
  const inv = 1 / cell;

  const grid = new Map();
  const hash = (x, y, z) => ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) | 0;
  for (let i = 0; i < n; i++) {
    const lox = Math.floor((Math.min(ax[i], bx[i]) - rad[i]) * inv);
    const hix = Math.floor((Math.max(ax[i], bx[i]) + rad[i]) * inv);
    const loy = Math.floor((Math.min(ay[i], by[i]) - rad[i]) * inv);
    const hiy = Math.floor((Math.max(ay[i], by[i]) + rad[i]) * inv);
    const loz = Math.floor((Math.min(az[i], bz[i]) - rad[i]) * inv);
    const hiz = Math.floor((Math.max(az[i], bz[i]) + rad[i]) * inv);
    for (let x = lox; x <= hix; x++)
      for (let y = loy; y <= hiy; y++)
        for (let z = loz; z <= hiz; z++) {
          const k = hash(x, y, z);
          let bucket = grid.get(k);
          if (!bucket) { bucket = []; grid.set(k, bucket); }
          bucket.push(i);
        }
  }

  // tree metric: bones close ALONG the skeleton are allowed to touch
  const par = new Int32Array(nodes.length).fill(-1);
  const depth = new Int32Array(nodes.length);
  const arc = new Float64Array(nodes.length);
  {
    const seen = new Uint8Array(nodes.length);
    const q = new Int32Array(nodes.length);
    let tail = 0;
    q[tail++] = 0;
    seen[0] = 1;
    for (let head = 0; head < tail; head++) {
      const i = q[head];
      for (const j of nodes[i].neighbors) {
        if (seen[j]) continue;
        seen[j] = 1;
        par[j] = i;
        depth[j] = depth[i] + 1;
        arc[j] = arc[i] + V.dist(nodes[i].p, nodes[j].p);
        q[tail++] = j;
      }
    }
  }
  const treeDist = (u, v) => {
    let a = u; let b = v; let guard = 0;
    while (depth[a] > depth[b] && guard++ < 1e6) a = par[a];
    while (depth[b] > depth[a] && guard++ < 1e6) b = par[b];
    while (a !== b && guard++ < 1e6) {
      if (par[a] < 0 || par[b] < 0) { a = 0; b = 0; break; }
      a = par[a]; b = par[b];
    }
    return arc[u] + arc[v] - 2 * arc[a];
  };

  const seenPair = new Set();
  const hits = [];
  const cp = [0, 0, 0];
  const cq = [0, 0, 0];
  for (const bucket of grid.values()) {
    const m = bucket.length;
    for (let p = 0; p < m; p++) {
      const i = bucket[p];
      for (let q2 = p + 1; q2 < m; q2++) {
        const j = bucket[q2];
        const need = rad[i] + rad[j];
        // cheap reject before anything expensive
        if (Math.min(ax[i], bx[i]) - need > Math.max(ax[j], bx[j])) continue;
        if (Math.min(ax[j], bx[j]) - need > Math.max(ax[i], bx[i])) continue;
        if (Math.min(ay[i], by[i]) - need > Math.max(ay[j], by[j])) continue;
        if (Math.min(ay[j], by[j]) - need > Math.max(ay[i], by[i])) continue;
        const pk = i < j ? i * n + j : j * n + i;
        if (seenPair.has(pk)) continue;
        seenPair.add(pk);
        if (ia[i] === ia[j] || ia[i] === ib[j] || ib[i] === ia[j] || ib[i] === ib[j]) continue;
        const along = Math.min(
          treeDist(ia[i], ia[j]), treeDist(ia[i], ib[j]),
          treeDist(ib[i], ia[j]), treeDist(ib[i], ib[j])
        );
        if (along < 3.0 * (raw[i] + raw[j])) continue;
        const d = segSeg(
          ax[i], ay[i], az[i], bx[i], by[i], bz[i],
          ax[j], ay[j], az[j], bx[j], by[j], bz[j], cp, cq
        );
        if (d >= need) continue;
        hits.push({
          x: { i, a: ia[i], b: ib[i], r: rad[i], r0: raw[i] },
          y: { i: j, a: ia[j], b: ib[j], r: rad[j], r0: raw[j] },
          dist: d,
          need,
          c1: [cp[0], cp[1], cp[2]],
          c2: [cq[0], cq[1], cq[2]],
        });
      }
    }
  }
  return hits;
}

/** Scalar segment-segment distance; writes the closest points into c1/c2. */
function segSeg(p1x, p1y, p1z, q1x, q1y, q1z, p2x, p2y, p2z, q2x, q2y, q2z, c1, c2) {
  const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z;
  const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  const EPS = 1e-12;
  let s = 0; let t = 0;
  if (a <= EPS && e <= EPS) { s = 0; t = 0; }
  else if (a <= EPS) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > EPS ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  c1[0] = p1x + d1x * s; c1[1] = p1y + d1y * s; c1[2] = p1z + d1z * s;
  c2[0] = p2x + d2x * t; c2[1] = p2y + d2y * t; c2[2] = p2z + d2z * t;
  return Math.hypot(c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2]);
}

/** parent[] via BFS from the root, plus subtree collection helpers. */
function parents(skel) {
  const { nodes } = skel;
  const par = new Array(nodes.length).fill(-1);
  const seen = new Uint8Array(nodes.length);
  const q = [0];
  seen[0] = 1;
  for (let head = 0; head < q.length; head++) {
    const i = q[head];
    for (const j of nodes[i].neighbors) if (!seen[j]) { seen[j] = 1; par[j] = i; q.push(j); }
  }
  return par;
}

function subtree(skel, rootIdx, blockIdx) {
  const { nodes } = skel;
  const out = [rootIdx];
  const seen = new Set([blockIdx, rootIdx]);
  const stack = [rootIdx];
  while (stack.length) {
    const i = stack.pop();
    for (const j of nodes[i].neighbors) {
      if (seen.has(j)) continue;
      seen.add(j);
      out.push(j);
      stack.push(j);
    }
  }
  return out;
}

/** Walk up until the parent is a junction: that junction is the pivot. */
function branchBase(skel, par, nodeIdx) {
  const { nodes } = skel;
  let cur = nodeIdx;
  let guard = 0;
  while (par[cur] >= 0 && guard++ < 1e5) {
    const p = par[cur];
    if (nodes[p].neighbors.length >= 3) return { pivot: p, root: cur };
    cur = p;
  }
  return null;
}

/**
 * Rotate/prune until nothing intersects.
 * @returns {{initial:number, remaining:number, rotated:number, pruned:number}}
 */
export function resolveCollisions(skel, opts = {}) {
  const { clearance = 1.35, iterations = 14, maxStep = 0.14, prune = true } = opts;
  const initial = findCollisions(skel, clearance).length;
  let rotated = 0;

  for (let it = 0; it < iterations; it++) {
    const hits = findCollisions(skel, clearance);
    if (!hits.length) break;
    const par = parents(skel);
    const touched = new Set();
    // deal with the thinnest offender first
    hits.sort((h1, h2) => Math.min(h1.x.r, h1.y.r) - Math.min(h2.x.r, h2.y.r));
    for (const h of hits) {
      // move the thinner of the two branches
      const younger = h.x.r <= h.y.r ? h.x : h.y;
      const other = younger === h.x ? h.y : h.x;
      const cp = younger === h.x ? h.c1 : h.c2;
      const cq = younger === h.x ? h.c2 : h.c1;
      const deepNode = skel.nodes[younger.a].r <= skel.nodes[younger.b].r ? younger.a : younger.b;
      const base = branchBase(skel, par, deepNode);
      if (!base || base.root === 0) continue;
      if (touched.has(base.root)) continue;
      touched.add(base.root);

      const push = V.len(V.sub(cp, cq)) > 1e-9 ? V.norm(V.sub(cp, cq)) : V.perp([0, 1, 0]);
      const rv = V.sub(cp, skel.nodes[base.pivot].p);
      const lever = V.len(rv);
      if (lever < 1e-6) continue;
      const axis = V.cross(rv, push);
      if (V.len(axis) < 1e-9) continue;
      const need = h.need - h.dist + Math.min(younger.r, other.r) * 0.15;
      const ang = Math.min(maxStep, need / lever);
      const k = V.norm(axis);
      const pivotP = skel.nodes[base.pivot].p;
      for (const idx of subtree(skel, base.root, base.pivot)) {
        skel.nodes[idx].p = V.add(pivotP, V.rotAxis(V.sub(skel.nodes[idx].p, pivotP), k, ang));
      }
      rotated++;
    }
  }

  let pruned = 0;
  if (prune) {
    let guard = 0;
    while (guard++ < 40) {
      const hits = findCollisions(skel, clearance);
      if (!hits.length) break;
      const par = parents(skel);
      const kill = new Set();
      for (const h of hits) {
        // prune the thinner branch; if it has no prunable base (it is the trunk
        // itself) fall back to the other one, so a pair can always be resolved
        const order = h.x.r <= h.y.r ? [h.x, h.y] : [h.y, h.x];
        for (const cand of order) {
          const deepNode = skel.nodes[cand.a].r <= skel.nodes[cand.b].r ? cand.a : cand.b;
          const base = branchBase(skel, par, deepNode);
          if (!base || base.root === 0) continue;
          for (const idx of subtree(skel, base.root, base.pivot)) kill.add(idx);
          break;
        }
      }
      if (!kill.size) break;
      kill.delete(0);
      pruned += kill.size;
      removeNodes(skel, kill);
    }
  }

  return { initial, remaining: findCollisions(skel, clearance).length, rotated, pruned };
}

/** Delete a set of vertices and rebuild the skeleton arrays compactly. */
export function removeNodes(skel, kill) {
  const { nodes, bones } = skel;
  const keep = [];
  const remap = new Array(nodes.length).fill(-1);
  for (let i = 0; i < nodes.length; i++) {
    if (kill.has(i)) continue;
    remap[i] = keep.length;
    keep.push(nodes[i]);
  }
  const newBones = [];
  for (const [a, b] of bones) {
    if (remap[a] < 0 || remap[b] < 0) continue;
    newBones.push([remap[a], remap[b]]);
  }
  keep.forEach((n, i) => {
    n.index = i;
    n.neighbors = n.neighbors.map((j) => remap[j]).filter((j) => j >= 0);
  });
  skel.nodes = keep;
  skel.bones = newBones;
  return skel;
}

/** Cheap report used by the audit UI. */
export function collisionReport(skel, clearance = 1.2) {
  const hits = findCollisions(skel, clearance);
  let worst = 0;
  for (const h of hits) worst = Math.max(worst, (h.need - h.dist) / h.need);
  return { pairs: hits.length, worstPenetration: worst };
}
