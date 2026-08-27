// SKINNING: skeleton graph -> single watertight all-quad control cage.
//
// Method (B-Mesh / "skin modifier" style, no voxels, no booleans):
//   1. every junction vertex (degree >= 3) gets a BOX whose axes are fitted to
//      the outgoing bones;
//   2. each outgoing bone claims one distinct box FACE (optimal assignment),
//      that face is EXTRUDED into a socket ring -> the box stays a closed solid
//      and the socket is topologically welded into it (4 quads per socket);
//   3. limbs (chains of degree-2 vertices) are quad tubes swept with a
//      parallel-transport frame from socket to socket, rotationally matched so
//      the quad loops line up with no twist and no seam;
//   4. tips (degree 1) get a quad cap.
//
// Result: one shell, quads only, no boundary edges, no doubled/interpenetrating
// floating cylinders - branches are actually merged into the trunk.

import * as V from './vec3.js';
import { QuadMesh } from './quadmesh.js';
import { hubExtent } from './skeleton.js';

// cube corner sign table, corners indexed (i,j,k) -> ±a0, ±a1, ±a2
const CORNER = [];
for (let i = 0; i < 2; i++)
  for (let j = 0; j < 2; j++)
    for (let k = 0; k < 2; k++) CORNER.push([i * 2 - 1, j * 2 - 1, k * 2 - 1]);
const CI = (i, j, k) => i * 4 + j * 2 + k;

// 6 faces, CCW seen from outside, with their axis normal in (a0,a1,a2) space
const FACES = [
  { n: [1, 0, 0], c: [CI(1, 0, 0), CI(1, 1, 0), CI(1, 1, 1), CI(1, 0, 1)] },
  { n: [-1, 0, 0], c: [CI(0, 0, 0), CI(0, 0, 1), CI(0, 1, 1), CI(0, 1, 0)] },
  { n: [0, 1, 0], c: [CI(0, 1, 0), CI(0, 1, 1), CI(1, 1, 1), CI(1, 1, 0)] },
  { n: [0, -1, 0], c: [CI(0, 0, 0), CI(1, 0, 0), CI(1, 0, 1), CI(0, 0, 1)] },
  { n: [0, 0, 1], c: [CI(0, 0, 1), CI(1, 0, 1), CI(1, 1, 1), CI(0, 1, 1)] },
  { n: [0, 0, -1], c: [CI(0, 0, 0), CI(0, 1, 0), CI(1, 1, 0), CI(1, 0, 0)] },
];

export const SKIN_DEFAULTS = {
  radiusCompensation: 1.3, // square loops shrink under Catmull-Clark
  hubScale: 1.0,
  socketReach: 1.7,        // socket distance in hub half-extents
  tipTaper: 0.34,
  loopSpacing: 2.2,        // min distance between quad loops, in local radii
  maxTurn: 14,             // ...unless the limb bends more than this (degrees)
};

/** Split the skeleton into limbs: chains bounded by junctions/tips. */
export function buildLimbs(skel) {
  const { nodes } = skel;
  const isTerminal = (i) => nodes[i].neighbors.length !== 2;
  const doneBone = new Set();
  const bkey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const limbs = [];

  for (let t = 0; t < nodes.length; t++) {
    if (!isTerminal(t)) continue;
    for (const first of nodes[t].neighbors) {
      if (doneBone.has(bkey(t, first))) continue;
      const path = [t];
      let prev = t;
      let cur = first;
      doneBone.add(bkey(prev, cur));
      while (!isTerminal(cur)) {
        path.push(cur);
        const nxt = nodes[cur].neighbors.find((x) => x !== prev);
        if (nxt === undefined) break;
        doneBone.add(bkey(cur, nxt));
        prev = cur;
        cur = nxt;
      }
      path.push(cur);
      limbs.push({ path, a: path[0], b: path[path.length - 1] });
    }
  }
  // orient every limb root-first (thicker end first) so caps behave
  for (const l of limbs) {
    const ra = nodes[l.path[0]].r;
    const rb = nodes[l.path[l.path.length - 1]].r;
    if (l.path[l.path.length - 1] === 0 || (l.path[0] !== 0 && rb > ra)) {
      l.path.reverse();
      l.a = l.path[0];
      l.b = l.path[l.path.length - 1];
    }
  }
  return limbs.filter((l) => l.path.length >= 2);
}

function polylineLength(skel, path) {
  let s = 0;
  for (let i = 1; i < path.length; i++) s += V.dist(skel.nodes[path[i]].p, skel.nodes[path[i - 1]].p);
  return s;
}

/** Optimal (brute force) assignment of N directions to distinct cube faces. */
function assignFaces(localDirs) {
  const n = localDirs.length;
  const used = new Array(6).fill(false);
  const best = { score: -Infinity, pick: null };
  const cur = new Array(n);
  (function rec(i, score) {
    if (i === n) {
      if (score > best.score) {
        best.score = score;
        best.pick = cur.slice();
      }
      return;
    }
    for (let f = 0; f < 6; f++) {
      if (used[f]) continue;
      used[f] = true;
      cur[i] = f;
      rec(i + 1, score + V.dot(localDirs[i], FACES[f].n));
      used[f] = false;
    }
  })(0, 0);
  return best.pick;
}

/**
 * Build the all-quad control cage for a skeleton.
 * @returns {{mesh: QuadMesh, limbs: Array, hubs: Array}}
 */
export function skinSkeleton(skel, opts = {}) {
  const O = { ...SKIN_DEFAULTS, ...opts };
  const { nodes } = skel;
  const mesh = new QuadMesh();
  const comp = O.radiusCompensation;

  const limbs = buildLimbs(skel);

  // ---- per-junction socket planning -------------------------------------
  // socket[nodeIndex][neighborNodeIndex] = { L, r, dir }
  const plan = new Map();
  const getPlan = (i) => {
    if (!plan.has(i)) plan.set(i, new Map());
    return plan.get(i);
  };

  for (const limb of limbs) {
    limb.length = polylineLength(skel, limb.path);
    const ends = [
      { node: limb.path[0], next: limb.path[1] },
      { node: limb.path[limb.path.length - 1], next: limb.path[limb.path.length - 2] },
    ];
    for (const e of ends) {
      const n = nodes[e.node];
      if (n.neighbors.length < 3) continue;
      const R = hubExtent(n) * O.hubScale;
      const dir = V.norm(V.sub(nodes[e.next].p, n.p));
      getPlan(e.node).set(e.next, {
        R,
        L: R * O.socketReach,
        r: Math.min(nodes[e.next].r, n.r * 0.92) * comp,
        dir,
      });
    }
  }
  // clamp socket reach so two hubs on the same short bone never pass through
  for (const limb of limbs) {
    const a = limb.path[0];
    const b = limb.path[limb.path.length - 1];
    const pa = getPlan(a).get(limb.path[1]);
    const pb = getPlan(b).get(limb.path[limb.path.length - 2]);
    const La = pa ? pa.L : 0;
    const Lb = pb ? pb.L : 0;
    const budget = limb.length * 0.82;
    if (La + Lb > budget && La + Lb > 0) {
      const k = budget / (La + Lb);
      if (pa) pa.L *= k;
      if (pb) pb.L *= k;
    }
  }

  // ---- hubs --------------------------------------------------------------
  const hubs = [];
  const sockets = new Map(); // `${node}_${neighbor}` -> socket record

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.neighbors.length < 3) continue;
    const R = hubExtent(n) * O.hubScale;
    const nbs = n.neighbors.slice();
    const dirs = nbs.map((j) => V.norm(V.sub(nodes[j].p, n.p)));

    // hub frame: thickest limb defines a0
    let heavy = 0;
    for (let k = 1; k < nbs.length; k++) if (nodes[nbs[k]].r > nodes[nbs[heavy]].r) heavy = k;
    const a0 = dirs[heavy];
    let second = -1;
    let bestPerp = -1;
    for (let k = 0; k < dirs.length; k++) {
      if (k === heavy) continue;
      const pp = V.len(V.cross(dirs[k], a0));
      if (pp > bestPerp) { bestPerp = pp; second = k; }
    }
    const a1 = second >= 0 ? V.orthoNorm(dirs[second], a0) : V.perp(a0);
    const a2 = V.norm(V.cross(a0, a1));
    const axes = [a0, a1, a2];
    const toWorld = (l) => V.add(V.add(V.mul(a0, l[0]), V.mul(a1, l[1])), V.mul(a2, l[2]));
    const toLocal = (w) => [V.dot(w, a0), V.dot(w, a1), V.dot(w, a2)];

    // cube corners
    const corner = CORNER.map((s) => mesh.addVertex(V.add(n.p, V.mul(toWorld(s), R))));

    const localDirs = dirs.map(toLocal);
    const pick = assignFaces(localDirs.slice(0, 6));

    const usedFace = new Set();
    for (let k = 0; k < nbs.length && k < 6; k++) {
      const fi = pick[k];
      usedFace.add(fi);
      const face = FACES[fi];
      const d = dirs[k];
      const rec = getPlan(i).get(nbs[k]);
      const axisAlign = Math.max(0.45, Math.abs(V.dot(d, toWorld(face.n))));
      const L = Math.max(R * 1.05, rec.L / axisAlign * 0.85);
      const C = V.add(n.p, V.mul(d, L));
      const rr = rec.r;

      // ring frame aligned with the source face so the extrusion has no twist
      const faceVerts = face.c.map((ci) => mesh.positions[corner[ci]]);
      const u = V.orthoNorm(V.sub(faceVerts[0], n.p), d);
      const w = V.norm(V.cross(d, u));
      // the face is CCW around its normal ~ d, so its 2nd corner sits at +90deg
      const s = V.dot(V.orthoNorm(V.sub(faceVerts[1], n.p), d), w) >= 0 ? 1 : -1;
      const ringPts = [0, 1, 2, 3].map((t) => {
        const ang = (s * t * Math.PI) / 2;
        return V.add(C, V.add(V.mul(u, Math.cos(ang) * rr), V.mul(w, Math.sin(ang) * rr)));
      });
      const ring = mesh.addRing(ringPts);
      // extrude: old face is replaced by the 4 side quads
      mesh.bridgeRings(face.c.map((ci) => corner[ci]), ring, 'hub');

      sockets.set(`${i}_${nbs[k]}`, { ring, center: C, dir: d, u: s > 0 ? u : V.mul(u, 1), radius: rr, s });
    }

    // keep the unused box faces so the hub is still a closed solid
    for (let fi = 0; fi < 6; fi++) {
      if (usedFace.has(fi)) continue;
      const f = FACES[fi];
      mesh.addQuad(corner[f.c[0]], corner[f.c[1]], corner[f.c[2]], corner[f.c[3]], 'hub');
    }

    hubs.push({ node: i, center: n.p, R, axes });
  }

  // ---- limbs -------------------------------------------------------------
  for (const limb of limbs) {
    sweepLimb(mesh, skel, limb, sockets, O);
  }

  mesh.weld(1e-7);
  return { mesh, limbs, hubs, sockets };
}

function ringPoints(center, dir, u, radius) {
  const w = V.norm(V.cross(dir, u));
  return [0, 1, 2, 3].map((t) => {
    const ang = (t * Math.PI) / 2;
    return V.add(center, V.add(V.mul(u, Math.cos(ang) * radius), V.mul(w, Math.sin(ang) * radius)));
  });
}

function sweepLimb(mesh, skel, limb, sockets, O) {
  const { nodes } = skel;
  const path = limb.path;
  const A = path[0];
  const B = path[path.length - 1];
  const startSock = sockets.get(`${A}_${path[1]}`);
  const endSock = sockets.get(`${B}_${path[path.length - 2]}`);
  const comp = O.radiusCompensation;

  // sample centers along the polyline
  const pts = path.map((i) => nodes[i].p);
  const rads = path.map((i) => Math.max(nodes[i].r, 1e-4) * comp);

  let curCenter;
  let curDir;
  let curU;
  let prevRing;

  if (startSock) {
    curCenter = startSock.center;
    curDir = startSock.dir;
    curU = V.orthoNorm(V.sub(mesh.positions[startSock.ring[0]], curCenter), curDir);
    prevRing = startSock.ring;
  } else {
    // free tip: start the tube at the tip vertex itself and cap it
    const d = V.norm(V.sub(pts[1], pts[0]));
    curCenter = pts[0];
    curDir = d;
    curU = V.perp(d);
    const r0 = rads[0];
    prevRing = mesh.addRing(ringPoints(curCenter, curDir, curU, r0));
    // cap faces backwards
    mesh.addQuad(prevRing[3], prevRing[2], prevRing[1], prevRing[0], 'cap');
  }

  const endCenter = endSock ? endSock.center : pts[pts.length - 1];
  const stopDir = endSock ? V.mul(endSock.dir, -1) : V.norm(V.sub(pts[pts.length - 1], pts[pts.length - 2]));

  // intermediate loops
  const startIdx = startSock ? 1 : 1;
  const lastIdx = endSock ? path.length - 2 : path.length - 2;
  const maxTurn = Math.cos((O.maxTurn * Math.PI) / 180);
  let sinceLast = 0;
  let refDir = curDir;
  for (let k = startIdx; k <= lastIdx; k++) {
    const p = pts[k];
    // skip samples that fall behind the current loop or beyond the end socket
    if (V.dot(V.sub(p, curCenter), curDir) < Math.max(rads[k], 1e-3) * 0.35) continue;
    if (V.dot(V.sub(endCenter, p), stopDir) < Math.max(rads[k], 1e-3) * 0.35) continue;

    const tangent = V.norm(V.sub(pts[Math.min(k + 1, pts.length - 1)], pts[Math.max(k - 1, 0)]));
    // loop budget: only drop a quad loop where it is actually needed
    sinceLast += V.dist(p, curCenter);
    const bendy = V.dot(tangent, refDir) < maxTurn;
    const spaced = sinceLast >= rads[k] * O.loopSpacing;
    if (!bendy && !spaced) continue;

    const u = V.orthoNorm(V.rotateFromTo(curU, curDir, tangent), tangent);
    const ring = mesh.addRing(ringPoints(p, tangent, u, rads[k]));
    mesh.bridgeRings(prevRing, ring, 'limb');
    prevRing = ring;
    curCenter = p;
    curDir = tangent;
    curU = u;
    sinceLast = 0;
    refDir = tangent;
  }

  if (endSock) {
    // rotationally match the two loops, then bridge - no twist, no seam
    const target = endSock.ring.slice().reverse(); // faces back down the limb
    let bestOff = 0;
    let bestCost = Infinity;
    for (let off = 0; off < 4; off++) {
      let c = 0;
      for (let i = 0; i < 4; i++)
        c += V.dist(mesh.positions[prevRing[i]], mesh.positions[target[(i + off) % 4]]);
      if (c < bestCost) { bestCost = c; bestOff = off; }
    }
    const matched = [0, 1, 2, 3].map((i) => target[(i + bestOff) % 4]);
    mesh.bridgeRings(prevRing, matched, 'limb');
  } else {
    // taper into a tip and cap with a single quad
    const tip = pts[pts.length - 1];
    const dir = V.norm(V.sub(tip, curCenter));
    const u = V.orthoNorm(V.rotateFromTo(curU, curDir, dir), dir);
    const rTip = Math.max(rads[rads.length - 1] * O.tipTaper, 1e-3);
    const shrink = mesh.addRing(ringPoints(V.lerp(curCenter, tip, 0.72), dir, u, rTip * 1.6));
    mesh.bridgeRings(prevRing, shrink, 'limb');
    const end = mesh.addRing(ringPoints(tip, dir, u, rTip));
    mesh.bridgeRings(shrink, end, 'limb');
    mesh.addQuad(end[0], end[1], end[2], end[3], 'cap');
  }
}
