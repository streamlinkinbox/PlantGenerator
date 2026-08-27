// SKINNING: skeleton graph -> single watertight all-quad control cage.
//
// Method (B-Mesh / "skin modifier" style, no voxels, no booleans):
//   1. every junction vertex (degree >= 3) gets a BOX whose axes are fitted to
//      the outgoing bones;
//   2. each outgoing bone claims one distinct box FACE (optimal assignment),
//      that face is EXTRUDED into a socket ring -> the box stays a closed solid
//      and the socket is topologically welded into it (4 quads per socket);
//   3. limbs (chains of degree-2 vertices) are quad tubes, uniformly resampled
//      and swept with a parallel-transport frame;
//   4. tips (degree 1) get a quad cap.
//
// THE IMPORTANT PART - frame propagation.
// Hubs are built lazily in breadth-first order *while* the limbs are swept, so
// every hub inherits the rotation of the tube that arrives at it: its box is
// spun about the incoming bone until the parent-facing socket loop lands exactly
// on the arriving loop. Residual twist is therefore 0 instead of an arbitrary
// 0-45 degrees, which is what used to make the quads shear and pinch to a point
// at the splits ("box A at a different rotation than box B").

import * as V from './vec3.js';
import { QuadMesh } from './quadmesh.js';
import { hubExtent } from './skeleton.js';

// cube corner sign table, corners indexed (i,j,k) -> ±a0, ±a1, ±a2
const CORNER = [];
for (let i = 0; i < 2; i++)
  for (let j = 0; j < 2; j++)
    for (let k = 0; k < 2; k++) CORNER.push([i * 2 - 1, j * 2 - 1, k * 2 - 1]);
const CI = (i, j, k) => i * 4 + j * 2 + k;

// 6 faces, CCW seen from outside, with their axis normal in (a0,a1,a2) space.
// FACES[0] (+a0) is the one reserved for the incoming/parent bone.
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
  socketReach: 2.1,        // socket distance in hub half-extents
  tipTaper: 0.34,
  loopSpacing: 2.0,        // target loop spacing, in local radii
  maxTurn: 12,             // extra loops when the limb bends more than this
  minLoops: 2,             // never bridge two hubs with a single stretched span
  hubFit: 1.0,             // 0 = raw cube hub, 1 = corners fitted to the branch envelope
  collarRows: 1,           // graded rings between a box face and its socket (auto-scaled)
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
      let guard = 0;
      while (!isTerminal(cur) && guard++ < 1e6) {
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
  return limbs.filter((l) => l.path.length >= 2);
}

function polylineLength(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += V.dist(pts[i], pts[i - 1]);
  return s;
}

/** Optimal (brute force) assignment of N directions to distinct faces of `pool`. */
function assignFaces(localDirs, pool) {
  const n = localDirs.length;
  const used = new Array(pool.length).fill(false);
  const best = { score: -Infinity, pick: null };
  const cur = new Array(n);
  (function rec(i, score) {
    if (i === n) {
      if (score > best.score) { best.score = score; best.pick = cur.slice(); }
      return;
    }
    for (let f = 0; f < pool.length; f++) {
      if (used[f]) continue;
      used[f] = true;
      cur[i] = pool[f];
      rec(i + 1, score + V.dot(localDirs[i], FACES[pool[f]].n));
      used[f] = false;
    }
  })(0, 0);
  return best.pick;
}

function ringPoints(center, dir, u, radius) {
  const w = V.norm(V.cross(dir, u));
  return [0, 1, 2, 3].map((t) => {
    const ang = (t * Math.PI) / 2;
    return V.add(center, V.add(V.mul(u, Math.cos(ang) * radius), V.mul(w, Math.sin(ang) * radius)));
  });
}

/**
 * Clip a polyline to the part strictly between the two socket planes and
 * resample it uniformly - even spacing means even quads, no stretching.
 */
function clipAndResample(pts, rads, startC, startD, endC, endD, count) {
  const P = [startC];
  const R = [rads[0]];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const m = Math.max(rads[i] * 0.4, 1e-4);
    if (V.dot(V.sub(p, startC), startD) <= m) continue;
    if (V.dot(V.sub(endC, p), endD) <= m) continue;
    P.push(p);
    R.push(rads[i]);
  }
  P.push(endC);
  R.push(rads[rads.length - 1]);

  // arc-length table
  const acc = [0];
  for (let i = 1; i < P.length; i++) acc.push(acc[i - 1] + V.dist(P[i], P[i - 1]));
  const total = acc[acc.length - 1];
  const out = [];
  if (total < 1e-9) return out;
  for (let k = 1; k <= count; k++) {
    const s = (total * k) / (count + 1);
    let i = 1;
    while (i < acc.length - 1 && acc[i] < s) i++;
    const t = (s - acc[i - 1]) / Math.max(acc[i] - acc[i - 1], 1e-9);
    out.push({ p: V.lerp(P[i - 1], P[i], t), r: R[i - 1] + (R[i] - R[i - 1]) * t });
  }
  return out;
}

function totalTurn(pts) {
  let a = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d0 = V.norm(V.sub(pts[i], pts[i - 1]));
    const d1 = V.norm(V.sub(pts[i + 1], pts[i]));
    a += Math.acos(Math.max(-1, Math.min(1, V.dot(d0, d1))));
  }
  return a;
}

/**
 * Build the all-quad control cage for a skeleton.
 * @returns {{mesh: QuadMesh, limbs: Array, hubs: Array, sockets: Map}}
 */
export function skinSkeleton(skel, opts = {}) {
  const O = { ...SKIN_DEFAULTS, ...opts };
  const { nodes } = skel;
  const mesh = new QuadMesh();
  const comp = O.radiusCompensation;

  const limbs = buildLimbs(skel);
  if (!limbs.length) return { mesh, limbs, hubs: [], sockets: new Map() };

  // limbs incident to each node
  const incident = new Map();
  limbs.forEach((l, i) => {
    for (const end of [l.path[0], l.path[l.path.length - 1]]) {
      if (!incident.has(end)) incident.set(end, []);
      incident.get(end).push(i);
    }
  });

  // socket reach budget per (junction, neighbour) so two hubs on one short bone
  // can never pass through each other
  const reach = new Map();
  const rkey = (a, b) => `${a}_${b}`;
  for (const limb of limbs) {
    const pts = limb.path.map((i) => nodes[i].p);
    limb.length = polylineLength(pts);
    for (const [end, nb] of [
      [limb.path[0], limb.path[1]],
      [limb.path[limb.path.length - 1], limb.path[limb.path.length - 2]],
    ]) {
      if (nodes[end].neighbors.length < 3) continue;
      const R = hubExtent(nodes[end]) * O.hubScale;
      reach.set(rkey(end, nb), { R, L: R * O.socketReach });
    }
  }
  for (const limb of limbs) {
    const a = reach.get(rkey(limb.path[0], limb.path[1]));
    const b = reach.get(rkey(limb.path[limb.path.length - 1], limb.path[limb.path.length - 2]));
    const sum = (a ? a.L : 0) + (b ? b.L : 0);
    const budget = limb.length * 0.8;
    if (sum > budget && sum > 0) {
      const k = budget / sum;
      if (a) a.L *= k;
      if (b) b.L *= k;
    }
  }

  const hubs = [];
  const tubes = []; // per-limb sweep frames, handed to the bark builder
  let backwardSockets = 0;
  const sockets = new Map(); // `${node}_${neighbour}` -> { ring, center, dir, u }
  const builtHub = new Set();
  const doneLimb = new Set();

  /**
   * Create the hub box at junction `ni`.
   * @param parentNb neighbour the incoming tube came from (may be -1 for the root hub)
   * @param uIn      frame of the arriving tube, the box is spun to match it
   */
  function buildHub(ni, parentNb, dirIn, uIn) {
    const n = nodes[ni];
    const R = hubExtent(n) * O.hubScale;
    const nbs = n.neighbors.slice();

    // a0 always points back down the incoming bone, so FACES[0] is the parent
    const a0 = parentNb >= 0 ? V.norm(V.sub(nodes[parentNb].p, n.p)) : V.mul(dirIn, -1);

    // ---- pick the box roll.
    // The box is spun about the incoming bone so that corner 0 of FACES[0]
    // projects onto uIn: the arriving tube then lands on the parent socket with
    // zero twist. The box has 4-fold symmetry about a0, so a residual roll in
    // (-45,45] is still free - we spend it on making every child sit on a face
    // that actually points the way it grows. A socket on a face pointing away
    // from its branch hands back a mirrored loop, and that is what sheared and
    // pinched the splits. Whatever roll we take is returned and spread as a
    // gentle twist along the incoming limb.
    const kidsAll = nbs.filter((nb) => nb !== parentNb).slice(0, 5);
    const kidWorld = kidsAll.map((nb) => V.norm(V.sub(nodes[nb].p, n.p)));
    const frameFor = (delta) => {
      const u0 = V.orthoNorm(V.rotAxis(uIn, dirIn, delta), a0);
      const b1 = V.norm(V.rotAxis(V.mul(u0, -1), a0, -Math.PI / 4));
      return [a0, b1, V.norm(V.cross(a0, b1))];
    };
    let best = { delta: 0, score: -Infinity, axes: frameFor(0), pick: [] };
    const rollSteps = 18;
    for (let k = 0; k <= rollSteps; k++) {
      const delta = -Math.PI / 4 + (Math.PI / 2) * (k / rollSteps);
      const ax = frameFor(delta);
      const loc = kidWorld.map((d) => [V.dot(d, ax[0]), V.dot(d, ax[1]), V.dot(d, ax[2])]);
      const pick = loc.length ? assignFaces(loc, [1, 2, 3, 4, 5]) : [];
      let minDot = 1;
      let sumDot = 0;
      pick.forEach((fi, i) => {
        const dd = V.dot(loc[i], FACES[fi].n);
        minDot = Math.min(minDot, dd);
        sumDot += dd;
      });
      const score = minDot * 3 + sumDot * 0.25 - (0.35 * Math.abs(delta)) / (Math.PI / 4);
      if (score > best.score) best = { delta, score, axes: ax, pick };
    }
    const a1 = best.axes[1];
    const a2 = best.axes[2];
    const toWorld = (l) => V.add(V.add(V.mul(a0, l[0]), V.mul(a1, l[1])), V.mul(a2, l[2]));

    // face assignment (parent = FACES[0]) as solved by the roll search above
    const pairs = [];
    if (parentNb >= 0) pairs.push([parentNb, 0]);
    kidsAll.forEach((nb, i) => pairs.push([nb, best.pick[i]]));

    // socket plane distance for each branch (needed before fitting the corners)
    const branch = pairs.map(([nb, fi]) => {
      const d = V.norm(V.sub(nodes[nb].p, n.p));
      const rec = reach.get(rkey(ni, nb)) || { L: R * O.socketReach };
      const align = Math.max(0.5, V.dot(d, toWorld(FACES[fi].n)));
      return {
        nb,
        fi,
        d,
        L: Math.min(R * 3, Math.max(R * 1.08, (rec.L / align) * 0.9)),
        r: Math.min(nodes[nb].r, n.r * 0.95) * comp,
      };
    });

    // ---- fit the box corners to the envelope of the outgoing branches.
    // A raw cube leaves a blobby crotch and a visible collar; pushing each
    // corner out to the union of the branch cylinders builds the saddle/fillet
    // a split actually needs, without touching the topology. Each contribution
    // is clamped by that branch's own socket plane, so a corner can never shoot
    // past the socket and spike.
    const envelope = (dc) => {
      let t = R;
      for (const b of branch) {
        const c = V.dot(dc, b.d);
        const sinA = Math.sqrt(Math.max(1 - c * c, 1e-6));
        const ti = c > 0 ? Math.min(b.r / Math.max(sinA, 1e-3), b.L / Math.max(c, 1e-3)) : b.r;
        t = Math.max(t, Math.min(ti, R * 1.9));
      }
      return t;
    };
    const cube = R * Math.sqrt(3);
    const dirs8 = CORNER.map((sgn) => V.norm(toWorld(sgn)));
    let scale8 = dirs8.map((dc) => cube + (envelope(dc) - cube) * O.hubFit);
    // smooth the corner-scale field over the cube graph: neighbouring corners
    // with wildly different radii are what folds the box faces over
    for (let it = 0; it < 3; it++) {
      const nxt = scale8.slice();
      for (let c = 0; c < 8; c++) {
        let sum = 0;
        for (let bit = 0; bit < 3; bit++) sum += scale8[c ^ (1 << bit)];
        nxt[c] = scale8[c] * 0.45 + (sum / 3) * 0.55;
      }
      scale8 = nxt;
    }
    const corner = dirs8.map((dc, ci) =>
      mesh.addVertex(V.add(n.p, V.mul(dc, Math.min(Math.max(scale8[ci], cube * 0.92), cube * 1.6))))
    );

    const usedFace = new Set();
    for (const b of branch) {
      const fi = b.fi;
      usedFace.add(fi);
      const face = FACES[fi];
      const fp = face.c.map((ci) => mesh.positions[corner[ci]]);

      // the socket plane must clear every corner of its own face, otherwise the
      // ring lands on top of a corner and the quad collapses to a point
      let maxProj = 0;
      for (const q of fp) maxProj = Math.max(maxProj, V.dot(V.sub(q, n.p), b.d));
      const L = Math.max(b.L, maxProj + Math.max(b.r * 0.55, R * 0.35));
      const C = V.add(n.p, V.mul(b.d, L));
      const rr = b.r;

      // Ring frame taken from the source face, measured around the FACE CENTRE.
      // Measuring around the hub centre (as this used to) makes the four corners
      // of a tilted face project into a half plane, so corner order 0-1-2-3 came
      // out as a bow tie and the collar quads crossed over each other - the
      // sheared, pinched splits. Around the face centre the projection of a
      // convex face is always monotonic.
      const fc = V.mul(V.add(V.add(fp[0], fp[1]), V.add(fp[2], fp[3])), 0.25);
      const ru = V.orthoNorm(V.sub(fp[0], fc), b.d);
      const rw = V.norm(V.cross(b.d, ru));
      const sgn = V.dot(V.orthoNorm(V.sub(fp[1], fc), b.d), rw) >= 0 ? 1 : -1;
      const ringPts = [0, 1, 2, 3].map((t) => {
        const ang = (sgn * t * Math.PI) / 2;
        return V.add(C, V.add(V.mul(ru, Math.cos(ang) * rr), V.mul(rw, Math.sin(ang) * rr)));
      });

      // graded collar: a fat box face never drops onto a thin branch in one
      // row of quads - that is what produced the sheared, pinched splits
      const fRad = fp.reduce((a, q) => a + V.dist(q, fc), 0) * 0.25;
      const span = V.dist(fc, C);
      // enough rows for (a) the length of the collar and (b) how much the
      // section has to shrink - a fat trunk dropping onto a twig needs several
      const spanRows = Math.round(span / Math.max(0.75 * (fRad + rr), 1e-6));
      const shrinkRows = Math.ceil(Math.log(Math.max(fRad / Math.max(rr, 1e-6), 1)) / Math.log(1.7));
      let rows = Math.max(spanRows, shrinkRows, 1) * Math.max(1, Math.round(O.collarRows));
      rows = Math.min(rows, 6);

      let prev = face.c.map((ci) => corner[ci]);
      for (let k = 1; k <= rows; k++) {
        const t = k / (rows + 1);
        // shrink the section geometrically so every collar row keeps a similar
        // aspect ratio instead of one long sheared row at the thin end
        let e;
        if (Math.abs(fRad - rr) < 1e-9) e = t;
        else {
          const radK = fRad * Math.pow(Math.max(rr, 1e-6) / Math.max(fRad, 1e-6), t);
          e = Math.min(1, Math.max(0, (fRad - radK) / (fRad - rr)));
        }
        const pts = [0, 1, 2, 3].map((i) => V.lerp(fp[i], ringPts[i], e));
        const mid = mesh.addRing(pts);
        mesh.bridgeRings(prev, mid, 'hub');
        prev = mid;
      }
      const ring = mesh.addRing(ringPts);
      mesh.bridgeRings(prev, ring, 'hub');
      // Hand the limb sweeper a loop that is always wound CCW around the bone.
      // A face whose winding runs the other way used to hand back a mirrored
      // loop, and the tube then bridged onto it with a half-quad twist - the
      // sheared/squeezed branches.
      if (sgn < 0) backwardSockets++;
      sockets.set(rkey(ni, b.nb), { ring, center: C, dir: b.d, u: ru, radius: rr, sgn });
    }

    for (let fi = 0; fi < 6; fi++) {
      if (usedFace.has(fi)) continue;
      const f = FACES[fi];
      mesh.addQuad(corner[f.c[0]], corner[f.c[1]], corner[f.c[2]], corner[f.c[3]], 'hub');
    }
    hubs.push({ node: ni, center: n.p, R, axes: [a0, a1, a2] });
    builtHub.add(ni);
    return best.delta;
  }

  /** Sweep one limb from its already-known start frame to the far end. */
  function sweep(job, queue) {
    const path = job.path;
    const pts = path.map((i) => nodes[i].p);
    const rads = path.map((i) => Math.max(nodes[i].r, 1e-4) * comp);
    const endNode = path[path.length - 1];
    const endIsHub = nodes[endNode].neighbors.length >= 3;

    // ---- start frame
    let startRing;
    let startC;
    let startD;
    let startU;
    if (job.socket) {
      startRing = job.socket.ring;
      startC = job.socket.center;
      startD = job.socket.dir;
      startU = V.orthoNorm(V.sub(mesh.positions[startRing[0]], startC), startD);
    } else {
      startD = V.norm(V.sub(pts[1], pts[0]));
      startC = pts[0];
      startU = V.perp(startD);
      startRing = mesh.addRing(ringPoints(startC, startD, startU, rads[0]));
      mesh.addQuad(startRing[3], startRing[2], startRing[1], startRing[0], 'cap');
    }

    // ---- end plane
    const arriveD = V.norm(V.sub(pts[pts.length - 1], pts[pts.length - 2]));
    let endC = pts[pts.length - 1];
    if (endIsHub) {
      const rec = reach.get(rkey(endNode, path[path.length - 2])) ||
        { L: hubExtent(nodes[endNode]) * O.socketReach };
      const R = hubExtent(nodes[endNode]) * O.hubScale;
      endC = V.add(nodes[endNode].p, V.mul(V.mul(arriveD, -1), Math.max(R * 1.08, rec.L)));
    }

    // ---- how many loops
    const span = Math.max(V.dist(startC, endC), 1e-6);
    const avgR = Math.max((rads[0] + rads[rads.length - 1]) * 0.5, 1e-4);
    let count = Math.ceil(span / Math.max(avgR * O.loopSpacing, 1e-4)) - 1;
    count = Math.max(count, Math.ceil((totalTurn(pts) * 180) / Math.PI / O.maxTurn));
    if (endIsHub) count = Math.max(count, O.minLoops);
    // never pack loops closer than ~0.8 of the local radius: crowded loops make
    // zero-height quads (a ring pair 200x wider than it is tall)
    const maxCount = Math.max(0, Math.floor(span / Math.max(avgR * 0.8, 1e-6)) - 1);
    count = Math.max(0, Math.min(count, maxCount, 96));

    const loops = clipAndResample(pts, rads, startC, startD, endC, arriveD, count);

    // ---- phase 1: transport the frame through the planned loops, no geometry
    const plan = [];
    {
      let curC = startC;
      let curD = startD;
      let curU = startU;
      for (let i = 0; i < loops.length; i++) {
        const nxt = i + 1 < loops.length ? loops[i + 1].p : endC;
        const tangent = V.norm(V.sub(nxt, curC));
        const u = V.orthoNorm(V.rotateFromTo(curU, curD, tangent), tangent);
        plan.push({ p: loops[i].p, r: loops[i].r, t: tangent, u });
        curC = loops[i].p;
        curD = tangent;
        curU = u;
      }
      var uEnd = V.orthoNorm(V.rotateFromTo(curU, curD, arriveD), arriveD);
    }

    // ---- build the far hub first, so we know the roll it wants
    let roll = 0;
    let sock = null;
    if (endIsHub) {
      const pnb = path[path.length - 2];
      if (!builtHub.has(endNode)) roll = buildHub(endNode, pnb, arriveD, uEnd);
      sock = sockets.get(rkey(endNode, pnb));
      if (sock && builtHub.has(endNode) && roll === 0) {
        // hub already existed: recover the roll from its socket frame
        const uSock = V.orthoNorm(V.sub(mesh.positions[sock.ring[0]], sock.center), arriveD);
        const w = V.norm(V.cross(arriveD, uEnd));
        roll = Math.atan2(V.dot(uSock, w), V.dot(uSock, uEnd));
        while (roll > Math.PI / 4) roll -= Math.PI / 2;
        while (roll < -Math.PI / 4) roll += Math.PI / 2;
      }
    }

    // ---- phase 2: emit, spreading `roll` evenly over the loops so the twist
    // is a gentle spiral instead of one sheared row of quads at the split
    let prevRing = startRing;
    // frames of the emitted loops - the exact circles the tube was built on.
    // The bark builder rides these, so its plates sit on the skin instead of
    // on a guessed cylinder.
    const frames = [{ p: startC, t: startD, u: startU, r: job.socket ? job.socket.radius : rads[0] }];
    for (let i = 0; i < plan.length; i++) {
      const f = plan[i];
      const frac = (i + 1) / (plan.length + 1);
      const u = V.orthoNorm(V.rotAxis(f.u, f.t, roll * frac), f.t);
      const ring = mesh.addRing(ringPoints(f.p, f.t, u, f.r));
      mesh.bridgeRings(prevRing, ring, 'limb');
      prevRing = ring;
      frames.push({ p: f.p, t: f.t, u, r: f.r });
    }
    if (frames.length >= 2) tubes.push({ frames, endIsHub, node: endNode });
    const curC = plan.length ? plan[plan.length - 1].p : startC;
    const curD = plan.length ? plan[plan.length - 1].t : startD;
    const curU = plan.length
      ? V.orthoNorm(
          V.rotAxis(plan[plan.length - 1].u, plan[plan.length - 1].t, (roll * plan.length) / (plan.length + 1)),
          plan[plan.length - 1].t
        )
      : startU;

    if (endIsHub) {
      const target = sock.ring.slice().reverse();
      let bestOff = 0;
      let bestCost = Infinity;
      for (let off = 0; off < 4; off++) {
        let c = 0;
        for (let i = 0; i < 4; i++)
          c += V.dist(mesh.positions[prevRing[i]], mesh.positions[target[(i + off) % 4]]);
        if (c < bestCost) { bestCost = c; bestOff = off; }
      }
      mesh.bridgeRings(prevRing, [0, 1, 2, 3].map((i) => target[(i + bestOff) % 4]), 'limb');

      // queue the other limbs leaving this hub
      for (const li of incident.get(endNode) || []) {
        if (doneLimb.has(li)) continue;
        const l = limbs[li];
        const p = l.path[0] === endNode ? l.path.slice() : l.path.slice().reverse();
        const s = sockets.get(rkey(endNode, p[1]));
        if (!s) continue;
        doneLimb.add(li);
        queue.push({ path: p, socket: s });
      }
    } else {
      // taper into the tip with evenly spaced loops, then one quad cap.
      // Spacing the loops by their own width keeps the last quads square
      // instead of needle shaped.
      const tip = pts[pts.length - 1];
      const dir = V.norm(V.sub(tip, curC));
      const u0 = V.orthoNorm(V.rotateFromTo(curU, curD, dir), dir);
      const rEnd = Math.max(rads[rads.length - 1] * O.tipTaper, 1e-3);
      const rStart = Math.max(rads[rads.length - 1], rEnd);
      const gap = V.dist(curC, tip);
      const steps = Math.max(1, Math.min(5, Math.round(gap / Math.max(rStart * 1.1, 1e-6))));
      let prevTip = prevRing;
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        const rr = rStart + (rEnd - rStart) * Math.sin((t * Math.PI) / 2);
        const ring = mesh.addRing(ringPoints(V.lerp(curC, tip, t), dir, u0, rr));
        mesh.bridgeRings(prevTip, ring, 'limb');
        prevTip = ring;
      }
      mesh.addQuad(prevTip[0], prevTip[1], prevTip[2], prevTip[3], 'cap');
    }
  }

  // ---- breadth-first traversal from the root -----------------------------
  const queue = [];
  let seedLimb = limbs.findIndex((l) => l.path[0] === 0 || l.path[l.path.length - 1] === 0);
  if (seedLimb < 0) seedLimb = 0;
  {
    const l = limbs[seedLimb];
    const p = l.path[0] === 0 ? l.path.slice() : l.path.slice().reverse();
    doneLimb.add(seedLimb);
    queue.push({ path: p, socket: null });
  }
  while (queue.length) sweep(queue.shift(), queue);

  // any limb not reachable from the root (should not happen on a tree) is still
  // skinned so nothing is silently dropped
  for (let i = 0; i < limbs.length; i++) {
    if (doneLimb.has(i)) continue;
    doneLimb.add(i);
    const sub = [{ path: limbs[i].path.slice(), socket: null }];
    while (sub.length) sweep(sub.shift(), sub);
  }

  mesh.weld(1e-7);
  return { mesh, limbs, hubs, sockets, backwardSockets, tubes };
}
