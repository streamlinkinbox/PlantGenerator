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

function buildBoneList(skel, clearance) {
  const { nodes, bones } = skel;
  return bones.map(([a, b], i) => ({
    i,
    a,
    b,
    r: Math.max(nodes[a].r, nodes[b].r) * clearance,
    r0: Math.max(nodes[a].r, nodes[b].r),
  }));
}

/** All pairs of non-neighbouring bones whose capsules overlap. */
export function findCollisions(skel, clearance = 1.35) {
  const { nodes } = skel;
  const list = buildBoneList(skel, clearance);
  if (!list.length) return [];

  // uniform grid over bone AABBs
  let cell = 0;
  for (const bn of list) cell += V.dist(nodes[bn.a].p, nodes[bn.b].p) + bn.r * 2;
  cell = Math.max(cell / list.length, 1e-4);
  const grid = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  const cellsOf = (bn) => {
    const A = nodes[bn.a].p;
    const B = nodes[bn.b].p;
    const out = [];
    const lo = [0, 1, 2].map((k) => Math.floor((Math.min(A[k], B[k]) - bn.r) / cell));
    const hi = [0, 1, 2].map((k) => Math.floor((Math.max(A[k], B[k]) + bn.r) / cell));
    for (let x = lo[0]; x <= hi[0]; x++)
      for (let y = lo[1]; y <= hi[1]; y++)
        for (let z = lo[2]; z <= hi[2]; z++) out.push(key(x, y, z));
    return out;
  };
  for (const bn of list) {
    for (const k of cellsOf(bn)) {
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(bn.i);
    }
  }

  // Tree metric: two bones that are close ALONG the skeleton are supposed to
  // touch (consecutive segments of one fat limb, or two branches sharing a
  // junction). Only bones that are far apart along the tree but close in space
  // are real intersections.
  const par = new Array(nodes.length).fill(-1);
  const depth = new Int32Array(nodes.length);
  const arc = new Float64Array(nodes.length);
  {
    const seen = new Uint8Array(nodes.length);
    const q = [0];
    seen[0] = 1;
    while (q.length) {
      const i = q.shift();
      for (const j of nodes[i].neighbors) {
        if (seen[j]) continue;
        seen[j] = 1;
        par[j] = i;
        depth[j] = depth[i] + 1;
        arc[j] = arc[i] + V.dist(nodes[i].p, nodes[j].p);
        q.push(j);
      }
    }
  }
  const lca = (u, v) => {
    let a = u;
    let b = v;
    let guard = 0;
    while (depth[a] > depth[b] && guard++ < 1e6) a = par[a];
    while (depth[b] > depth[a] && guard++ < 1e6) b = par[b];
    while (a !== b && guard++ < 1e6) {
      if (par[a] < 0 || par[b] < 0) return 0;
      a = par[a];
      b = par[b];
    }
    return a;
  };
  const treeDist = (u, v) => {
    const l = lca(u, v);
    return arc[u] + arc[v] - 2 * arc[l];
  };
  const related = (x, y) => {
    if (x.a === y.a || x.a === y.b || x.b === y.a || x.b === y.b) return true;
    const along = Math.min(
      treeDist(x.a, y.a), treeDist(x.a, y.b), treeDist(x.b, y.a), treeDist(x.b, y.b)
    );
    // use the raw radii so the "what counts as neighbouring" rule does not
    // change when the test clearance changes
    return along < 3.0 * (x.r0 + y.r0);
  };

  const seen = new Set();
  const hits = [];
  for (const bucket of grid.values()) {
    for (let i = 0; i < bucket.length; i++)
      for (let j = i + 1; j < bucket.length; j++) {
        const x = list[bucket[i]];
        const y = list[bucket[j]];
        const pk = x.i < y.i ? `${x.i}_${y.i}` : `${y.i}_${x.i}`;
        if (seen.has(pk)) continue;
        seen.add(pk);
        if (related(x, y)) continue;
        const need = x.r + y.r;
        const res = segSegDistance(nodes[x.a].p, nodes[x.b].p, nodes[y.a].p, nodes[y.b].p);
        if (res.dist >= need) continue;
        hits.push({ x, y, ...res, need });
      }
  }
  return hits;
}

/** parent[] via BFS from the root, plus subtree collection helpers. */
function parents(skel) {
  const { nodes } = skel;
  const par = new Array(nodes.length).fill(-1);
  const seen = new Uint8Array(nodes.length);
  const q = [0];
  seen[0] = 1;
  while (q.length) {
    const i = q.shift();
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
