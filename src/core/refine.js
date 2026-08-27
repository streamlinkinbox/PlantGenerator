// LOCAL, ALL-QUAD REFINEMENT
//
// Bark needs a dense grid, but only where the bark is. Subdividing the whole
// tree to that density is hopeless (millions of quads), so this refines a
// selected region and stitches it into the coarse mesh with transition
// templates that are still pure quads and still manifold - no triangles, no
// n-gons, no hanging nodes.
//
// Parity rule: a patch bounded by an odd number of edges cannot be filled with
// quads. A quad with k split edges has 4 + k boundary edges, so only even k
// works. The balancing pass promotes every odd case until every face has
// k in {0, 2, 4}:
//
//   k = 0           ->  untouched
//   k = 2 opposite  ->  2 quads
//   k = 2 adjacent  ->  3 quads (one interior point)
//   k = 4           ->  4 quads (regular Catmull-Clark split)
//
// New points use Catmull-Clark masks inside the region, so the refined patch
// converges to the smooth limit surface instead of staying faceted.

import { add, mul } from './vec3.js';
import { QuadMesh } from './quadmesh.js';

/** Edge table: unique edges, their endpoints and their (1 or 2) faces. */
function buildEdges(mesh) {
  const F = mesh.faces;
  const nf = F.length;
  const faceEdge = new Int32Array(nf * 4).fill(-1);
  const map = new Map();
  const eA = [];
  const eB = [];
  const eF0 = [];
  const eF1 = [];
  for (let fi = 0; fi < nf; fi++) {
    const f = F[fi];
    for (let i = 0; i < 4; i++) {
      const a = f[i];
      const b = f[(i + 1) % 4];
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      const k = lo * 4294967296 + hi;
      let e = map.get(k);
      if (e === undefined) {
        e = eA.length;
        map.set(k, e);
        eA.push(lo);
        eB.push(hi);
        eF0.push(fi);
        eF1.push(-1);
      } else if (eF1[e] < 0) eF1[e] = fi;
      faceEdge[fi * 4 + i] = e;
    }
  }
  return {
    faceEdge,
    eA: Int32Array.from(eA),
    eB: Int32Array.from(eB),
    eF0: Int32Array.from(eF0),
    eF1: Int32Array.from(eF1),
    count: eA.length,
  };
}

/**
 * @param {QuadMesh} mesh
 * @param {Set<number>} faceSel faces to refine
 * @returns {{mesh: QuadMesh, selection: Set<number>}}
 */
export function refineRegion(mesh, faceSel, opts = {}) {
  const P = mesh.positions;
  const F = mesh.faces;
  const nf = F.length;
  const E = buildEdges(mesh);
  const aniso = opts.aniso ?? 0; // >0: only split the long direction of a
                                 // stretched quad, so we do not waste faces
                                 // refining a direction that is already fine

  const split = new Uint8Array(E.count);
  const full = new Uint8Array(nf);
  const queue = [];
  const elen = (fi, i) => {
    const f = F[fi];
    const a = P[f[i]];
    const b = P[f[(i + 1) % 4]];
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  };
  for (const fi of faceSel) {
    let pairs = [0, 1, 2, 3];
    if (opts.preferDir) {
      // Split only the edges that are PARALLEL to the given direction, i.e.
      // refine across it. In a quad mesh an edge split propagates along its
      // whole edge ring; for a tube, the ring of an axis-parallel edge runs
      // around the tube and is therefore contained in the region, while the
      // ring of a hoop edge escapes up the tree and shreds it into slivers.
      const f = F[fi];
      const c = [
        (P[f[0]][0] + P[f[1]][0] + P[f[2]][0] + P[f[3]][0]) * 0.25,
        (P[f[0]][1] + P[f[1]][1] + P[f[2]][1] + P[f[3]][1]) * 0.25,
        (P[f[0]][2] + P[f[1]][2] + P[f[2]][2] + P[f[3]][2]) * 0.25,
      ];
      const d = opts.preferDir(c);
      const dirDot = (i) => {
        const a = P[f[i]];
        const b = P[f[(i + 1) % 4]];
        const ex = b[0] - a[0];
        const ey = b[1] - a[1];
        const ez = b[2] - a[2];
        const l = Math.hypot(ex, ey, ez) || 1e-9;
        return Math.abs((ex * d[0] + ey * d[1] + ez * d[2]) / l);
      };
      pairs = dirDot(0) + dirDot(2) > dirDot(1) + dirDot(3) ? [0, 2] : [1, 3];
    } else if (aniso > 1) {
      const la = elen(fi, 0) + elen(fi, 2);
      const lb = elen(fi, 1) + elen(fi, 3);
      if (la > lb * aniso) pairs = [0, 2];
      else if (lb > la * aniso) pairs = [1, 3];
    }
    for (const i of pairs) {
      const e = E.faceEdge[fi * 4 + i];
      if (!split[e]) {
        split[e] = 1;
        const o = E.eF0[e] === fi ? E.eF1[e] : E.eF0[e];
        if (o >= 0) queue.push(o);
      }
    }
    queue.push(fi);
  }

  // ---- balance: every face must end up with an even number of split edges
  const countSplit = (fi) => {
    let k = 0;
    for (let i = 0; i < 4; i++) if (split[E.faceEdge[fi * 4 + i]]) k++;
    return k;
  };
  for (let head = 0; head < queue.length; head++) {
    const fi = queue[head];
    const k = countSplit(fi);
    if (k === 4) { full[fi] = 1; continue; }
    if (opts.squareProp && k > 0 && k < 4) {
      // Splitting an edge in an all-quad mesh propagates along the whole edge
      // loop (a pentagon cannot be quadrangulated, so a lone hanging node is
      // impossible). Left alone the loop faces get halved in one direction at
      // every level and degenerate into slivers, so instead they are promoted
      // to a full square split and the loop stays well shaped.
      let added = false;
      for (let i = 0; i < 4; i++) {
        const e = E.faceEdge[fi * 4 + i];
        if (split[e]) continue;
        split[e] = 1;
        added = true;
        const o = E.eF0[e] === fi ? E.eF1[e] : E.eF0[e];
        if (o >= 0) queue.push(o);
      }
      full[fi] = 1;
      if (added) queue.push(fi);
      continue;
    }
    if (k % 2 === 0) continue;
    // odd -> split one more edge; the opposite one keeps the count at 2
    let first = -1;
    for (let i = 0; i < 4; i++) if (split[E.faceEdge[fi * 4 + i]]) { first = i; break; }
    let target = -1;
    if (k === 1) target = (first + 2) % 4;
    else for (let i = 0; i < 4; i++) if (!split[E.faceEdge[fi * 4 + i]]) { target = i; break; }
    const e = E.faceEdge[fi * 4 + target];
    split[e] = 1;
    const o = E.eF0[e] === fi ? E.eF1[e] : E.eF0[e];
    if (o >= 0) queue.push(o);
    queue.push(fi); // re-check: it may now have 4
  }
  for (let fi = 0; fi < nf; fi++) if (countSplit(fi) === 4) full[fi] = 1;

  // ---- new point positions
  const facePoint = new Array(nf).fill(null);
  for (let fi = 0; fi < nf; fi++) {
    if (!full[fi]) continue;
    const f = F[fi];
    facePoint[fi] = mul(add(add(P[f[0]], P[f[1]]), add(P[f[2]], P[f[3]])), 0.25);
  }
  const edgePoint = new Array(E.count).fill(null);
  for (let e = 0; e < E.count; e++) {
    if (!split[e]) continue;
    const a = E.eA[e];
    const b = E.eB[e];
    const f0 = E.eF0[e];
    const f1 = E.eF1[e];
    const smoothMask = f1 >= 0 && (full[f0] || faceSel.has(f0)) && (full[f1] || faceSel.has(f1));
    if (smoothMask && full[f0] && full[f1]) {
      edgePoint[e] = mul(add(add(P[a], P[b]), add(facePoint[f0], facePoint[f1])), 0.25);
    } else {
      edgePoint[e] = mul(add(P[a], P[b]), 0.5);
    }
  }

  // ---- Catmull-Clark vertex mask for vertices strictly inside the region
  const nv = P.length;
  const incident = new Int32Array(nv);
  const insideAll = new Uint8Array(nv).fill(1);
  for (let fi = 0; fi < nf; fi++) {
    const f = F[fi];
    for (const v of f) {
      incident[v]++;
      if (!full[fi]) insideAll[v] = 0;
    }
  }
  const fAcc = new Float64Array(nv * 3);
  const rAcc = new Float64Array(nv * 3);
  const rCnt = new Int32Array(nv);
  for (let fi = 0; fi < nf; fi++) {
    if (!full[fi]) continue;
    const fp = facePoint[fi];
    for (const v of F[fi]) {
      fAcc[v * 3] += fp[0]; fAcc[v * 3 + 1] += fp[1]; fAcc[v * 3 + 2] += fp[2];
    }
  }
  for (let e = 0; e < E.count; e++) {
    const a = E.eA[e];
    const b = E.eB[e];
    const mx = (P[a][0] + P[b][0]) * 0.5;
    const my = (P[a][1] + P[b][1]) * 0.5;
    const mz = (P[a][2] + P[b][2]) * 0.5;
    rAcc[a * 3] += mx; rAcc[a * 3 + 1] += my; rAcc[a * 3 + 2] += mz; rCnt[a]++;
    rAcc[b * 3] += mx; rAcc[b * 3 + 1] += my; rAcc[b * 3 + 2] += mz; rCnt[b]++;
  }

  // ---- emit
  const out = new QuadMesh();
  const vmap = new Int32Array(nv).fill(-1);
  const vertexOf = (v) => {
    if (vmap[v] >= 0) return vmap[v];
    let p = P[v];
    if (insideAll[v] && incident[v] >= 3) {
      const n = incident[v];
      const fp = [fAcc[v * 3] / n, fAcc[v * 3 + 1] / n, fAcc[v * 3 + 2] / n];
      const rp = [rAcc[v * 3] / rCnt[v], rAcc[v * 3 + 1] / rCnt[v], rAcc[v * 3 + 2] / rCnt[v]];
      p = mul(add(add(fp, mul(rp, 2)), mul(P[v], n - 3)), 1 / n);
    }
    vmap[v] = out.addVertex(p);
    return vmap[v];
  };
  const emap = new Int32Array(E.count).fill(-1);
  const edgeOf = (e) => {
    if (emap[e] < 0) emap[e] = out.addVertex(edgePoint[e]);
    return emap[e];
  };
  const fmap = new Int32Array(nf).fill(-1);
  const centreOf = (fi) => {
    if (fmap[fi] < 0) fmap[fi] = out.addVertex(facePoint[fi]);
    return fmap[fi];
  };

  const selection = new Set();
  const push = (a, b, c, d, group, keep) => {
    const fi = out.addQuad(a, b, c, d, group);
    if (keep) selection.add(fi);
  };

  for (let fi = 0; fi < nf; fi++) {
    const f = F[fi];
    const group = mesh.groups[fi] || 'limb';
    const keep = faceSel.has(fi);
    const flags = [0, 1, 2, 3].map((i) => !!split[E.faceEdge[fi * 4 + i]]);
    const k = flags[0] + flags[1] + flags[2] + flags[3];
    const V4 = [vertexOf(f[0]), vertexOf(f[1]), vertexOf(f[2]), vertexOf(f[3])];

    if (k === 0) {
      push(V4[0], V4[1], V4[2], V4[3], group, keep);
      continue;
    }
    const M = [0, 1, 2, 3].map((i) => (flags[i] ? edgeOf(E.faceEdge[fi * 4 + i]) : -1));
    if (k === 4) {
      const C = centreOf(fi);
      for (let i = 0; i < 4; i++) push(V4[i], M[i], C, M[(i + 3) % 4], group, keep);
      continue;
    }
    // k === 2
    const idx = [0, 1, 2, 3].filter((i) => flags[i]);
    if ((idx[1] - idx[0]) % 2 === 0) {
      const i = idx[0];
      const j = idx[1];
      push(V4[i], M[i], M[j], V4[(j + 1) % 4], group, keep);
      push(M[i], V4[(i + 1) % 4], V4[j], M[j], group, keep);
      continue;
    }
    // adjacent pair: i and i+1 are split
    const i = flags[3] && flags[0] ? 3 : idx[0];
    const j = (i + 1) % 4;
    const a = V4[i];
    const b = V4[j];
    const c = V4[(i + 2) % 4];
    const d = V4[(i + 3) % 4];
    const m1 = M[i];
    const m2 = M[j];
    const Pin = out.addVertex(
      mul(add(add(out.positions[m1], out.positions[m2]), add(out.positions[c], out.positions[d])), 0.25)
    );
    push(a, m1, Pin, d, group, keep);
    push(m1, b, m2, Pin, group, keep);
    push(Pin, m2, c, d, group, keep);
  }

  return { mesh: out, selection };
}

/**
 * Grow a face selection by `rings` layers of vertex-adjacent faces.
 * Refining an expanded set is what keeps the transition band square: the faces
 * the parity rule drags in are then split in BOTH directions instead of being
 * halved the same way at every level until they are slivers.
 */
export function expandSelection(mesh, faceSel, rings = 1) {
  let sel = new Set(faceSel);
  for (let r = 0; r < rings; r++) {
    const vs = new Set();
    for (const fi of sel) for (const v of mesh.faces[fi]) vs.add(v);
    const next = new Set(sel);
    mesh.faces.forEach((f, fi) => {
      if (next.has(fi)) return;
      for (const v of f) if (vs.has(v)) { next.add(fi); return; }
    });
    sel = next;
  }
  return sel;
}

/** Refine the same physical region `levels` times. */
export function refineRegionLevels(mesh, faceSel, levels, opts = {}) {
  let m = mesh;
  let sel = faceSel;
  for (let l = 0; l < levels; l++) {
    const r = refineRegion(m, sel, opts);
    m = r.mesh;
    sel = r.selection;
  }
  return { mesh: m, selection: sel };
}

/** Longest edge currently present in the region (drives the refinement loop). */
export function regionMaxEdge(mesh, faceSel) {
  let mx = 0;
  for (const fi of faceSel) {
    const f = mesh.faces[fi];
    for (let i = 0; i < 4; i++) {
      const a = mesh.positions[f[i]];
      const b = mesh.positions[f[(i + 1) % 4]];
      mx = Math.max(mx, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
  }
  return mx;
}

/** Median edge length in the region - the typical quad size, not the worst. */
export function regionMedianEdge(mesh, faceSel) {
  const lens = [];
  for (const fi of faceSel) {
    const f = mesh.faces[fi];
    for (let i = 0; i < 4; i++) {
      const a = mesh.positions[f[i]];
      const b = mesh.positions[f[(i + 1) % 4]];
      lens.push(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
  }
  if (!lens.length) return 0;
  lens.sort((x, y) => x - y);
  return lens[lens.length >> 1];
}

/**
 * Laplacian smoothing restricted to the interior of a region. The cage's trunk
 * cross-section is a square; a few passes of this round it off before the bark
 * relief is carved in, without touching the rest of the mesh.
 */
export function smoothRegion(mesh, faceSel, iters = 6, factor = 0.55) {
  const inRegion = new Set();
  for (const fi of faceSel) for (const v of mesh.faces[fi]) inRegion.add(v);
  const pinned = new Set();
  mesh.faces.forEach((f, fi) => {
    if (faceSel.has(fi)) return;
    for (const v of f) if (inRegion.has(v)) pinned.add(v);
  });
  const nbr = new Map();
  for (const fi of faceSel) {
    const f = mesh.faces[fi];
    for (let i = 0; i < 4; i++) {
      const a = f[i];
      const b = f[(i + 1) % 4];
      if (!nbr.has(a)) nbr.set(a, new Set());
      if (!nbr.has(b)) nbr.set(b, new Set());
      nbr.get(a).add(b);
      nbr.get(b).add(a);
    }
  }
  for (let it = 0; it < iters; it++) {
    const next = new Map();
    for (const [v, ns] of nbr) {
      if (pinned.has(v) || ns.size < 2) continue;
      let x = 0; let y = 0; let z = 0;
      for (const u of ns) {
        const p = mesh.positions[u];
        x += p[0]; y += p[1]; z += p[2];
      }
      const n = ns.size;
      const p = mesh.positions[v];
      next.set(v, [
        p[0] + (x / n - p[0]) * factor,
        p[1] + (y / n - p[1]) * factor,
        p[2] + (z / n - p[2]) * factor,
      ]);
    }
    for (const [v, p] of next) mesh.positions[v] = p;
  }
}
