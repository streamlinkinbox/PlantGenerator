// Pure-quad mesh container + Catmull-Clark subdivision + topology validation.
// Faces are always arrays of exactly 4 vertex indices, wound counter-clockwise
// when seen from outside the surface.

import { add, sub, mul, dist, cross, dot, len, norm } from './vec3.js';

const key = (a, b) => (a < b ? a * 0x100000 + b : b * 0x100000 + a);

export class QuadMesh {
  constructor() {
    /** @type {number[][]} */ this.positions = [];
    /** @type {number[][]} */ this.faces = [];
    /** @type {string[]} */ this.groups = []; // per-face tag: 'hub' | 'limb' | 'cap'
  }

  addVertex(p) {
    this.positions.push([p[0], p[1], p[2]]);
    return this.positions.length - 1;
  }

  addRing(pts) {
    return pts.map((p) => this.addVertex(p));
  }

  addQuad(a, b, c, d, group = 'limb') {
    this.faces.push([a, b, c, d]);
    this.groups.push(group);
    return this.faces.length - 1;
  }

  /**
   * Bridge two 4-vertex rings with 4 quads.
   * `ringA` is expected to be wound CCW around the bridging direction,
   * `ringB` likewise; caller guarantees correspondence a[i] <-> b[i].
   */
  bridgeRings(ringA, ringB, group = 'limb') {
    const n = ringA.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.addQuad(ringA[i], ringA[j], ringB[j], ringB[i], group);
    }
  }

  /** Merge vertices closer than eps and drop degenerate/duplicate faces. */
  weld(eps = 1e-6) {
    const cell = Math.max(eps, 1e-9) * 2;
    const map = new Map();
    const remap = new Int32Array(this.positions.length);
    const out = [];
    for (let i = 0; i < this.positions.length; i++) {
      const p = this.positions[i];
      const gx = Math.floor(p[0] / cell);
      const gy = Math.floor(p[1] / cell);
      const gz = Math.floor(p[2] / cell);
      let found = -1;
      for (let dx = -1; dx <= 1 && found < 0; dx++)
        for (let dy = -1; dy <= 1 && found < 0; dy++)
          for (let dz = -1; dz <= 1 && found < 0; dz++) {
            const bucket = map.get(`${gx + dx},${gy + dy},${gz + dz}`);
            if (!bucket) continue;
            for (const vi of bucket) {
              if (dist(out[vi], p) <= eps) {
                found = vi;
                break;
              }
            }
          }
      if (found < 0) {
        out.push([p[0], p[1], p[2]]);
        found = out.length - 1;
        const k = `${gx},${gy},${gz}`;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(found);
      }
      remap[i] = found;
    }

    const faces = [];
    const groups = [];
    const seen = new Set();
    for (let f = 0; f < this.faces.length; f++) {
      const q = this.faces[f].map((i) => remap[i]);
      if (new Set(q).size !== 4) continue; // degenerate after welding
      const sig = [...q].sort((a, b) => a - b).join(',');
      if (seen.has(sig)) continue; // duplicated face (two shells glued flat)
      seen.add(sig);
      faces.push(q);
      groups.push(this.groups[f]);
    }
    this.positions = out;
    this.faces = faces;
    this.groups = groups;
    return this;
  }

  /** Unique undirected edges as [a,b] pairs (for wireframe drawing). */
  edges() {
    const seen = new Set();
    const out = [];
    for (const f of this.faces) {
      for (let i = 0; i < 4; i++) {
        const a = f[i];
        const b = f[(i + 1) % 4];
        const k = key(a, b);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push([a, b]);
      }
    }
    return out;
  }

  /**
   * Topology report. For a correct single watertight organic skin we want:
   * quadsOnly = true, manifold = true, closed = true, shells = 1,
   * and consistent winding (no edge traversed the same direction twice).
   */
  validate() {
    const dirEdge = new Map(); // "a,b" -> count of directed uses
    const undirected = new Map(); // key -> count
    for (const f of this.faces) {
      for (let i = 0; i < 4; i++) {
        const a = f[i];
        const b = f[(i + 1) % 4];
        dirEdge.set(`${a},${b}`, (dirEdge.get(`${a},${b}`) || 0) + 1);
        const k = key(a, b);
        undirected.set(k, (undirected.get(k) || 0) + 1);
      }
    }
    let boundary = 0;
    let nonManifold = 0;
    for (const c of undirected.values()) {
      if (c === 1) boundary++;
      else if (c > 2) nonManifold++;
    }
    let flipped = 0;
    for (const c of dirEdge.values()) if (c > 1) flipped += c - 1;

    // connected components over face adjacency (via shared vertices)
    const adj = new Map();
    for (let f = 0; f < this.faces.length; f++)
      for (const v of this.faces[f]) {
        if (!adj.has(v)) adj.set(v, []);
        adj.get(v).push(f);
      }
    const seen = new Uint8Array(this.faces.length);
    let shells = 0;
    for (let f = 0; f < this.faces.length; f++) {
      if (seen[f]) continue;
      shells++;
      const stack = [f];
      seen[f] = 1;
      while (stack.length) {
        const cur = stack.pop();
        for (const v of this.faces[cur])
          for (const nf of adj.get(v)) if (!seen[nf]) { seen[nf] = 1; stack.push(nf); }
      }
    }

    // unreferenced vertices
    const used = new Set();
    for (const f of this.faces) for (const v of f) used.add(v);

    const V = this.positions.length;
    const E = undirected.size;
    const F = this.faces.length;
    return {
      vertices: V,
      edges: E,
      faces: F,
      quadsOnly: this.faces.every((f) => f.length === 4),
      ngons: 0,
      tris: 0,
      boundaryEdges: boundary,
      nonManifoldEdges: nonManifold,
      flippedEdges: flipped,
      shells,
      looseVertices: V - used.size,
      euler: V - E + F,
      genus: shells > 0 ? (2 * shells - (V - E + F)) / 2 : 0,
      watertight: boundary === 0 && nonManifold === 0 && flipped === 0,
      singleMesh: shells === 1,
    };
  }

  /** Poles = vertices whose valence != 4 (a quality metric for quad topology). */
  valenceHistogram() {
    const val = new Map();
    const seen = new Set();
    for (const f of this.faces)
      for (let i = 0; i < 4; i++) {
        const a = f[i];
        const b = f[(i + 1) % 4];
        const k = key(a, b);
        if (seen.has(k)) continue;
        seen.add(k);
        val.set(a, (val.get(a) || 0) + 1);
        val.set(b, (val.get(b) || 0) + 1);
      }
    const hist = {};
    for (const v of val.values()) hist[v] = (hist[v] || 0) + 1;
    return hist;
  }

  /**
   * Per-quad geometric quality. Topology can be perfect while the shapes are
   * garbage, so this is audited separately:
   *  - sliver  : aspect ratio (longest / shortest edge) above `aspectLimit`
   *  - pinched : a quad with a (near) zero-length edge -> the "squeezed to a
   *              point" artefact
   *  - warp    : angle between the two triangle normals of the quad
   */
  geometryQuality(aspectLimit = 10, warpLimit = 50) {
    let minEdge = Infinity;
    let maxAspect = 0;
    let maxWarp = 0;
    let slivers = 0;
    let pinched = 0;
    let warped = 0;
    let worst = { face: -1, aspect: 0 };
    let scale = 0;
    for (const f of this.faces) {
      const p = f.map((i) => this.positions[i]);
      const e = [dist(p[0], p[1]), dist(p[1], p[2]), dist(p[2], p[3]), dist(p[3], p[0])];
      scale += (e[0] + e[1] + e[2] + e[3]) * 0.25;
    }
    scale = scale / Math.max(this.faces.length, 1);
    this.faces.forEach((f, fi) => {
      const p = f.map((i) => this.positions[i]);
      const e = [dist(p[0], p[1]), dist(p[1], p[2]), dist(p[2], p[3]), dist(p[3], p[0])];
      const lo = Math.min(...e);
      const hi = Math.max(...e);
      minEdge = Math.min(minEdge, lo);
      const aspect = hi / Math.max(lo, 1e-9);
      // judge each face against its OWN size, so a mesh with mixed resolution
      // does not have every fine quad flagged as degenerate
      if (lo < ((e[0] + e[1] + e[2] + e[3]) / 4) * 0.02) pinched++;
      if (aspect > aspectLimit) slivers++;
      if (aspect > worst.aspect) worst = { face: fi, aspect };
      maxAspect = Math.max(maxAspect, aspect);
      const n1 = cross(sub(p[1], p[0]), sub(p[2], p[0]));
      const n2 = cross(sub(p[2], p[0]), sub(p[3], p[0]));
      if (len(n1) > 1e-12 && len(n2) > 1e-12) {
        const c = Math.max(-1, Math.min(1, dot(norm(n1), norm(n2))));
        const w = (Math.acos(c) * 180) / Math.PI;
        maxWarp = Math.max(maxWarp, w);
        if (w > warpLimit) warped++;
      }
    });
    return {
      avgEdge: scale,
      minEdge,
      maxAspect,
      maxWarpDeg: maxWarp,
      slivers,
      pinched,
      warped,
      worstFace: worst.face,
      clean: pinched === 0 && slivers === 0,
    };
  }

  /** Centroid of a face (used by the QC renderer to aim at a bad quad). */
  faceCenter(fi) {
    let s = [0, 0, 0];
    for (const v of this.faces[fi]) s = add(s, this.positions[v]);
    return mul(s, 0.25);
  }

  /** Faces sorted worst-first by aspect ratio. */
  worstFaces(count = 10) {
    const scored = this.faces.map((f, fi) => {
      const p = f.map((i) => this.positions[i]);
      const e = [dist(p[0], p[1]), dist(p[1], p[2]), dist(p[2], p[3]), dist(p[3], p[0])];
      return { fi, aspect: Math.max(...e) / Math.max(Math.min(...e), 1e-9) };
    });
    scored.sort((a, b) => b.aspect - a.aspect);
    return scored.slice(0, count);
  }

  /** Catmull-Clark subdivision. Quad-in => quad-out, stays manifold. */
  subdivide(levels = 1) {
    let mesh = this;
    for (let l = 0; l < levels; l++) mesh = catmullClark(mesh);
    return mesh;
  }

  toOBJ(name = 'tree') {
    const lines = [`# PlantGenerator - all-quad skin`, `o ${name}`];
    for (const p of this.positions)
      lines.push(`v ${p[0].toFixed(6)} ${p[1].toFixed(6)} ${p[2].toFixed(6)}`);
    for (const f of this.faces) lines.push(`f ${f[0] + 1} ${f[1] + 1} ${f[2] + 1} ${f[3] + 1}`);
    return lines.join('\n') + '\n';
  }

  /** Triangulated index buffer for rendering only (topology stays quads). */
  triangles() {
    const idx = new Uint32Array(this.faces.length * 6);
    let k = 0;
    for (const f of this.faces) {
      idx[k++] = f[0]; idx[k++] = f[1]; idx[k++] = f[2];
      idx[k++] = f[0]; idx[k++] = f[2]; idx[k++] = f[3];
    }
    return idx;
  }
}

function catmullClark(mesh) {
  const P = mesh.positions;
  const F = mesh.faces;
  const out = new QuadMesh();

  // face points
  const facePoint = F.map((f) => {
    let s = [0, 0, 0];
    for (const v of f) s = add(s, P[v]);
    return mul(s, 1 / f.length);
  });

  // edge table
  const edgeMap = new Map();
  F.forEach((f, fi) => {
    for (let i = 0; i < 4; i++) {
      const a = f[i];
      const b = f[(i + 1) % 4];
      const k = key(a, b);
      let e = edgeMap.get(k);
      if (!e) {
        e = { a: Math.min(a, b), b: Math.max(a, b), faces: [] };
        edgeMap.set(k, e);
      }
      e.faces.push(fi);
    }
  });

  // edge points
  const edgeIndex = new Map();
  const edgePoint = [];
  for (const [k, e] of edgeMap) {
    let p;
    if (e.faces.length === 2) {
      p = mul(add(add(P[e.a], P[e.b]), add(facePoint[e.faces[0]], facePoint[e.faces[1]])), 0.25);
    } else {
      p = mul(add(P[e.a], P[e.b]), 0.5); // boundary / crease
    }
    edgeIndex.set(k, edgePoint.length);
    edgePoint.push(p);
  }

  // vertex points
  const nV = P.length;
  const fAvg = Array.from({ length: nV }, () => [0, 0, 0]);
  const fCount = new Int32Array(nV);
  F.forEach((f, fi) => {
    for (const v of f) {
      fAvg[v] = add(fAvg[v], facePoint[fi]);
      fCount[v]++;
    }
  });
  const eAvg = Array.from({ length: nV }, () => [0, 0, 0]);
  const eCount = new Int32Array(nV);
  const boundaryAcc = Array.from({ length: nV }, () => [0, 0, 0]);
  const boundaryCount = new Int32Array(nV);
  for (const [, e] of edgeMap) {
    const mid = mul(add(P[e.a], P[e.b]), 0.5);
    eAvg[e.a] = add(eAvg[e.a], mid); eCount[e.a]++;
    eAvg[e.b] = add(eAvg[e.b], mid); eCount[e.b]++;
    if (e.faces.length === 1) {
      boundaryAcc[e.a] = add(boundaryAcc[e.a], mid); boundaryCount[e.a]++;
      boundaryAcc[e.b] = add(boundaryAcc[e.b], mid); boundaryCount[e.b]++;
    }
  }
  const vertPoint = [];
  for (let v = 0; v < nV; v++) {
    if (boundaryCount[v] > 0) {
      vertPoint.push(mul(add(mul(boundaryAcc[v], 1 / boundaryCount[v]), mul(P[v], 1)), 0.5));
      continue;
    }
    const n = Math.max(fCount[v], 1);
    const Fp = mul(fAvg[v], 1 / n);
    const R = mul(eAvg[v], 1 / Math.max(eCount[v], 1));
    vertPoint.push(mul(add(add(Fp, mul(R, 2)), mul(P[v], n - 3)), 1 / n));
  }

  // emit
  const viNew = vertPoint.map((p) => out.addVertex(p));
  const fiNew = facePoint.map((p) => out.addVertex(p));
  const eiNew = edgePoint.map((p) => out.addVertex(p));

  F.forEach((f, fi) => {
    const g = mesh.groups[fi] || 'limb';
    for (let i = 0; i < 4; i++) {
      const prev = f[(i + 3) % 4];
      const cur = f[i];
      const next = f[(i + 1) % 4];
      const e0 = eiNew[edgeIndex.get(key(prev, cur))];
      const e1 = eiNew[edgeIndex.get(key(cur, next))];
      out.addQuad(viNew[cur], e1, fiNew[fi], e0, g);
    }
  });
  return out;
}
