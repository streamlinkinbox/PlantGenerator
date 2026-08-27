// Procedural tree SKELETON (the "vertex" stage).
// Produces a graph of vertices in space: no geometry yet, only points + bones.
// Everything downstream (skinning) reads this structure.

import { makeRng } from './rng.js';
import * as V from './vec3.js';
import { resolveCollisions, collisionReport } from './collide.js';

export const DEFAULTS = {
  seed: 7,
  levels: 4,             // recursion depth (0 = trunk only)
  trunkHeight: 5.0,
  trunkRadius: 0.42,
  segmentsPerBranch: 6,  // skeleton vertices per branch span
  childrenPerBranch: 3,  // splits at a branch point
  branchStart: 0.35,     // fraction along parent before children appear
  branchAngle: 46,       // degrees away from parent direction
  angleVariance: 12,
  phyllotaxis: 137.5,    // roll between siblings, degrees
  lengthFalloff: 0.68,
  radiusFalloff: 0.62,
  minRadius: 0.028,
  curl: 0.22,            // per-segment random bend (radians-ish)
  gravitropism: 0.16,    // upward bias for children (negative = droop)
  taper: 0.72,           // radius at the tip of a span vs its base
  splitCount: 2,         // extra forks at the end of a span
  wobble: 0.06,
  maxVertices: 20000, // hard budget: branches queue breadth-first and stop here
  collisionClearance: 1.32, // capsule radius multiplier used for overlap tests
  selfPrune: 1,       // 1 = delete branches that still overlap after pushing

  // ---- thickness model (see assignPipeRadii) -----------------------------
  pipeExponent: 2.1,  // Leonardo/da Vinci exponent: r_parent^a = sum(r_child^a)
  taperRate: 0.16,    // how much a stem thickens per unit length between forks
  tipScale: 1.0,      // relative radius demanded by a twig tip
  collarFlare: 0.42,  // swelling at a branch base (branch collar)
  collarLength: 2.4,  // collar length, in child radii
  rootFlare: 0.6,     // buttressing at the foot of the trunk
  rootFlareLength: 5, // root flare length, in trunk radii
  radiusJitter: 0.08, // correlated per-vertex thickness noise
  skipCollisions: 0,  // 1 = fast preview: skip the (expensive) overlap solver
};

let uid = 0;

function makeNode(p, r) {
  return { id: uid++, p, r, neighbors: [], depth: 0 };
}

/**
 * @returns {{nodes:Array, bones:Array<[number,number]>, params:object}}
 */
export function generateSkeleton(userParams = {}) {
  const P = { ...DEFAULTS, ...userParams };
  // sanity clamps: a twig can never be fatter than the trunk it hangs on
  P.minRadius = Math.min(P.minRadius, P.trunkRadius * 0.45);
  P.radiusFalloff = Math.min(Math.max(P.radiusFalloff, 0.3), 0.95);
  const rnd = makeRng(P.seed);
  uid = 0;

  const nodes = [];
  const bones = [];
  const push = (n) => { n.index = nodes.length; nodes.push(n); return n.index; };
  const link = (a, b) => {
    bones.push([a, b]);
    nodes[a].neighbors.push(b);
    nodes[b].neighbors.push(a);
  };

  const root = makeNode([0, 0, 0], P.trunkRadius);
  push(root);

  const deg = Math.PI / 180;

  // Spans are expanded breadth-first out of a queue so that hitting the vertex
  // budget truncates the whole crown evenly instead of eating one sub-tree.
  const queue = [];
  const spawn = (startIdx, dir, up, length, radius, depth) =>
    queue.push({ startIdx, dir, up, length, radius, depth });

  function grow(startIdx, dir, up, length, radius, depth) {
    const segs = Math.max(2, Math.round(P.segmentsPerBranch * (depth === 0 ? 1 : 0.8)));
    const segLen = length / segs;
    let cur = startIdx;
    let d = V.norm(dir);
    let side = V.orthoNorm(up, d);

    // where along this span children are spawned
    const childSlots = [];
    if (depth < P.levels) {
      const n = Math.max(0, Math.round(P.childrenPerBranch));
      for (let i = 0; i < n; i++) {
        const t = P.branchStart + (1 - P.branchStart) * ((i + 0.5) / n) + rnd.sym(0.04);
        childSlots.push(Math.min(segs - 1, Math.max(1, Math.round(t * segs))));
      }
    }

    let roll = rnd.range(0, Math.PI * 2);

    for (let s = 1; s <= segs; s++) {
      // bend the direction: random curl + gravitropism, kept smooth
      const bendAxis = V.norm([rnd.sym(1), rnd.sym(1), rnd.sym(1)]);
      d = V.norm(V.rotAxis(d, V.orthoNorm(bendAxis, d), rnd.sym(P.curl) * (0.5 + depth * 0.25)));
      const grav = depth === 0 ? P.gravitropism * 0.25 : P.gravitropism;
      d = V.norm(V.add(d, [0, grav * 0.35, 0]));
      d = V.norm(V.add(d, [rnd.sym(P.wobble), 0, rnd.sym(P.wobble)]));

      const t = s / segs;
      const r = radius * (1 - (1 - P.taper) * t);
      const p = V.add(nodes[cur].p, V.mul(d, segLen));
      const ni = push(makeNode(p, Math.max(P.minRadius, r)));
      nodes[ni].depth = depth;
      link(cur, ni);
      cur = ni;

      // spawn lateral children at this vertex
      const count = childSlots.filter((c) => c === s).length;
      for (let c = 0; c < count; c++) {
        if (depth >= P.levels) break;
        roll += P.phyllotaxis * deg + rnd.sym(0.25);
        const ax = V.rotAxis(V.orthoNorm(side, d), d, roll);
        const ang = (P.branchAngle + rnd.sym(P.angleVariance)) * deg;
        let cd = V.norm(V.rotAxis(d, V.norm(V.cross(d, ax)), ang));
        cd = V.norm(V.add(cd, [0, P.gravitropism, 0]));
        const cl = length * P.lengthFalloff * rnd.range(0.82, 1.12);
        const cr = Math.max(P.minRadius, nodes[cur].r * P.radiusFalloff);
        if (cr <= P.minRadius * 1.01 && depth > 1) continue;
        spawn(cur, cd, d, cl, cr, depth + 1);
      }
    }

    // terminal fork so tips don't just dead-end in a single stick
    if (depth < P.levels && P.splitCount > 0) {
      const n = Math.max(1, Math.round(P.splitCount));
      const baseRoll = rnd.range(0, Math.PI * 2);
      for (let i = 0; i < n; i++) {
        const ax = V.rotAxis(V.orthoNorm(side, d), d, baseRoll + (i / n) * Math.PI * 2);
        const ang = (P.branchAngle * 0.62 + rnd.sym(P.angleVariance)) * deg;
        let cd = V.norm(V.rotAxis(d, V.norm(V.cross(d, ax)), ang));
        cd = V.norm(V.add(cd, [0, P.gravitropism * 1.2, 0]));
        const cr = Math.max(P.minRadius, nodes[cur].r * (P.radiusFalloff + 0.12));
        spawn(cur, cd, d, length * P.lengthFalloff * rnd.range(0.7, 1.0), cr, depth + 1);
      }
    }
  }

  spawn(0, [0, 1, 0], [1, 0, 0], P.trunkHeight, P.trunkRadius, 0);
  for (let head = 0; head < queue.length; head++) {
    if (nodes.length >= P.maxVertices) break;
    const job = queue[head];
    grow(job.startIdx, job.dir, job.up, job.length, job.radius, job.depth);
  }

  const skel = { nodes, bones, params: P };
  limitJunctionDegree(skel, 4);
  assignPipeRadii(skel, P);
  separateJunctions(skel);
  smoothChains(skel, 2, 0.28);
  // Lengthening bones can push branches back into each other, so relax first
  // (rotation only), then do the final pass AFTER the last length fix - that
  // pass ends with a prune loop, which is what guarantees a clean result.
  const stats = { initial: 0, rotated: 0, pruned: 0, remaining: 0, skipped: !!P.skipCollisions };
  // radii drive the collision tests, so they must be current before relaxing
  if (P.skipCollisions) {
    enforceBoneLength(skel);
    skel.collisions = stats;
    skel.overlap = { pairs: 0, worstPenetration: 0, skipped: true };
    return skel;
  }
  const big = nodes.length > 4000; // keep the interactive rebuild responsive
  for (let pass = 0; pass < (big ? 1 : 2); pass++) {
    enforceBoneLength(skel);
    const r = resolveCollisions(skel, {
      clearance: P.collisionClearance,
      iterations: big ? 6 : 12,
      prune: false,
    });
    if (pass === 0) stats.initial = r.initial;
    stats.rotated += r.rotated;
    if (r.remaining === 0) break;
  }
  enforceBoneLength(skel);
  const last = resolveCollisions(skel, {
    clearance: P.collisionClearance,
    iterations: big ? 4 : 8,
    prune: !!P.selfPrune,
  });
  stats.rotated += last.rotated;
  stats.pruned += last.pruned;
  stats.remaining = last.remaining;
  skel.collisions = stats;
  // pruning removed whole sub-trees, so the pipe sums changed: recompute
  if (last.pruned) {
    assignPipeRadii(skel, P);
    enforceBoneLength(skel);
  }
  // audit at the radius the *surface* actually occupies (the resolver works
  // with a safety margin on top of that)
  skel.overlap = collisionReport(skel, P.collisionClearance * 0.8);
  return skel;
}

/**
 * A hub box only has 6 faces, so no skeleton vertex may carry more than 6
 * bones. Over-crowded junctions are split into two junctions joined by a short
 * bone - the classic fix, and it keeps the skin all-quad.
 */
export function limitJunctionDegree(skel, max = 4) {
  const { nodes, bones } = skel;
  const parent = new Array(nodes.length).fill(-1);
  const seen = new Uint8Array(nodes.length);
  const q = [0];
  seen[0] = 1;
  for (let head = 0; head < q.length; head++) {
    const i = q[head];
    for (const j of nodes[i].neighbors) if (!seen[j]) { seen[j] = 1; parent[j] = i; q.push(j); }
  }

  const unlink = (a, b) => {
    nodes[a].neighbors = nodes[a].neighbors.filter((x) => x !== b);
    nodes[b].neighbors = nodes[b].neighbors.filter((x) => x !== a);
    for (let k = bones.length - 1; k >= 0; k--) {
      const [x, y] = bones[k];
      if ((x === a && y === b) || (x === b && y === a)) bones.splice(k, 1);
    }
  };
  const link = (a, b) => {
    bones.push([a, b]);
    nodes[a].neighbors.push(b);
    nodes[b].neighbors.push(a);
  };

  for (let i = 0; i < nodes.length; i++) {
    let guard = 0;
    while (nodes[i].neighbors.length > max && guard++ < 8) {
      const n = nodes[i];
      const par = parent[i];
      const kids = n.neighbors.filter((x) => x !== par);
      const inDir = par >= 0 ? V.norm(V.sub(n.p, nodes[par].p)) : [0, 1, 0];
      kids.sort(
        (a, b) =>
          V.dot(V.norm(V.sub(nodes[b].p, n.p)), inDir) -
          V.dot(V.norm(V.sub(nodes[a].p, n.p)), inDir)
      );
      const keep = kids.slice(0, max - 2);
      const move = kids.slice(max - 2);
      let avg = [0, 0, 0];
      for (const m of move) avg = V.add(avg, V.norm(V.sub(nodes[m].p, n.p)));
      const dir = V.len(avg) > 1e-6 ? V.norm(avg) : inDir;
      const relay = makeNode(V.add(n.p, V.mul(dir, n.r * 2.2)), n.r * 0.92);
      relay.depth = n.depth;
      relay.index = nodes.length;
      nodes.push(relay);
      parent[relay.index] = i;
      for (const m of move) {
        unlink(i, m);
        link(relay.index, m);
        parent[m] = relay.index;
      }
      link(i, relay.index);
      void keep;
    }
  }
}

/**
 * THICKNESS MODEL - this is what makes branches read as branches.
 *
 * Leonardo da Vinci's rule / the pipe model: the cross sections of the daughter
 * branches sum to the cross section of their mother branch,
 *
 *      r_parent^a = sum(r_child^a)
 *
 * with the "Leonardo exponent" a measured between 1.8 and 2.3 for real species
 * (2 = exact area preservation; higher values give chunkier boughs). On top of
 * that, real stems do taper between forks (WBE / Makela), so each bone adds a
 * length-proportional term. Everything is computed in units of "one twig tip",
 * then scaled so the root ends up at the requested trunk radius - which means
 * a twig is thin because of how little tree hangs off it, not because of an
 * arbitrary falloff constant.
 *
 * Two morphological features are layered on top:
 *  - the BRANCH COLLAR: the swelling where a branch joins its parent, where the
 *    two sets of growth rings overlap. Strongest on thin laterals, almost
 *    absent on a dominant leader.
 *  - the ROOT FLARE: the trunk thickening towards the ground.
 * Plus correlated per-vertex noise so no two twigs are identical cylinders.
 */
export function assignPipeRadii(skel, P) {
  const { nodes } = skel;
  const n = nodes.length;
  if (!n) return;
  const a = Math.max(1.2, Math.min(3.2, P.pipeExponent ?? 2.1));

  // rooted order
  const par = new Int32Array(n).fill(-1);
  const order = new Int32Array(n);
  {
    const seen = new Uint8Array(n);
    let tail = 0;
    order[tail++] = 0;
    seen[0] = 1;
    for (let head = 0; head < tail; head++) {
      const i = order[head];
      for (const j of nodes[i].neighbors) {
        if (seen[j]) continue;
        seen[j] = 1;
        par[j] = i;
        order[tail++] = j;
      }
    }
    for (let k = tail; k < n; k++) order[k] = k; // detached safety
  }

  // ---- pipe sums, leaves -> root
  const pipe = new Float64Array(n); // r^a in tip units
  const tip = Math.pow(Math.max(P.tipScale ?? 1, 0.05), a);
  const taper = Math.max(0, P.taperRate ?? 0.16);
  for (let k = n - 1; k >= 0; k--) {
    const i = order[k];
    const kids = nodes[i].neighbors.filter((j) => j !== par[i]);
    if (!kids.length) {
      pipe[i] = tip;
      continue;
    }
    let sum = 0;
    for (const j of kids) sum += pipe[j] + taper * V.dist(nodes[i].p, nodes[j].p);
    pipe[i] = sum;
  }

  const scale = P.trunkRadius / Math.max(Math.pow(pipe[0], 1 / a), 1e-9);
  for (let i = 0; i < n; i++) nodes[i].r = Math.pow(pipe[i], 1 / a) * scale;

  // ---- branch collar: distance from the fork this limb grew out of
  const flare = Math.max(0, P.collarFlare ?? 0);
  if (flare > 0) {
    const collarLen = Math.max(0.2, P.collarLength ?? 2.4);
    const baseDist = new Float64Array(n).fill(Infinity);
    const lateral = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const i = order[k];
      const p = par[i];
      if (p < 0) continue;
      if (nodes[p].neighbors.length >= 3) {
        baseDist[i] = V.dist(nodes[i].p, nodes[p].p);
        // a thin lateral gets a pronounced collar, a dominant leader hardly any
        lateral[i] = Math.max(0, 1 - nodes[i].r / Math.max(nodes[p].r, 1e-9));
      } else if (baseDist[p] !== Infinity) {
        baseDist[i] = baseDist[p] + V.dist(nodes[i].p, nodes[p].p);
        lateral[i] = lateral[p];
      }
    }
    for (let i = 0; i < n; i++) {
      if (baseDist[i] === Infinity || lateral[i] <= 0) continue;
      const d = baseDist[i] / Math.max(nodes[i].r * collarLen, 1e-9);
      nodes[i].r *= 1 + flare * lateral[i] * Math.exp(-d * d);
    }
  }

  // ---- root flare
  const rf = Math.max(0, P.rootFlare ?? 0);
  if (rf > 0) {
    const len = Math.max(0.2, P.rootFlareLength ?? 5) * P.trunkRadius;
    const arc = new Float64Array(n);
    for (let k = 1; k < n; k++) {
      const i = order[k];
      if (par[i] >= 0) arc[i] = arc[par[i]] + V.dist(nodes[i].p, nodes[par[i]].p);
    }
    for (let i = 0; i < n; i++) {
      const t = arc[i] / len;
      if (t > 3) continue;
      nodes[i].r *= 1 + rf * Math.exp(-t * t);
    }
  }

  // ---- correlated thickness noise (twigs are not perfect cylinders)
  const jit = Math.max(0, P.radiusJitter ?? 0);
  if (jit > 0) {
    const rnd = makeRng((P.seed || 1) * 7919 + 13);
    let noise = new Float64Array(n);
    for (let i = 0; i < n; i++) noise[i] = rnd.sym(1);
    for (let pass = 0; pass < 2; pass++) {
      const next = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let sum = noise[i];
        let cnt = 1;
        for (const j of nodes[i].neighbors) { sum += noise[j]; cnt++; }
        next[i] = sum / cnt;
      }
      noise = next;
    }
    for (let i = 0; i < n; i++) nodes[i].r *= 1 + jit * noise[i] * 1.8;
  }

  // renormalise so the user's trunkRadius is exactly the radius at the base
  const fix = P.trunkRadius / Math.max(nodes[0].r, 1e-9);
  const floor = Math.max(P.trunkRadius * 0.004, 1e-4);
  for (let i = 0; i < n; i++) nodes[i].r = Math.max(nodes[i].r * fix, floor);
}

/**
 * At a junction, push outgoing bones apart until neighbouring limbs no longer
 * overlap. This is the "handle the intersections" step at the skeleton level:
 * if two children leave at nearly the same angle their tubes would interpenetrate.
 */
function separateJunctions(skel, iterations = 24) {
  const { nodes } = skel;
  for (const n of nodes) {
    if (n.neighbors.length < 3) continue;
    const dirs = n.neighbors.map((j) => V.norm(V.sub(nodes[j].p, n.p)));
    const rad = n.neighbors.map((j) => nodes[j].r);
    for (let it = 0; it < iterations; it++) {
      let moved = false;
      for (let a = 0; a < dirs.length; a++) {
        for (let b = a + 1; b < dirs.length; b++) {
          const c = Math.max(-1, Math.min(1, V.dot(dirs[a], dirs[b])));
          const ang = Math.acos(c);
          // required separation grows with the two radii relative to hub size
          const need = Math.min(
            2.2,
            1.15 * Math.atan2(rad[a] + rad[b], Math.max(n.r, 1e-4) * 1.9)
          );
          if (ang >= need) continue;
          const axis = V.len(V.cross(dirs[a], dirs[b])) > 1e-6
            ? V.norm(V.cross(dirs[a], dirs[b]))
            : V.perp(dirs[a]);
          const half = (need - ang) * 0.5;
          dirs[a] = V.norm(V.rotAxis(dirs[a], axis, -half));
          dirs[b] = V.norm(V.rotAxis(dirs[b], axis, half));
          moved = true;
        }
      }
      if (!moved) break;
    }
    // rigidly rotate each sub-branch so the whole limb follows its new direction
    for (let k = 0; k < n.neighbors.length; k++) {
      const j = n.neighbors[k];
      const old = V.norm(V.sub(nodes[j].p, n.p));
      if (V.dot(old, dirs[k]) > 0.99999) continue;
      rotateSubtree(skel, n.index, j, old, dirs[k]);
    }
  }
}

/** Rotate everything hanging off bone (from -> to) so the bone points `nd`. */
function rotateSubtree(skel, fromIdx, toIdx, od, nd) {
  const { nodes } = skel;
  const pivot = nodes[fromIdx].p;
  const stack = [toIdx];
  const seen = new Set([fromIdx, toIdx]);
  const list = [toIdx];
  while (stack.length) {
    const i = stack.pop();
    for (const j of nodes[i].neighbors) {
      if (seen.has(j)) continue;
      seen.add(j);
      list.push(j);
      stack.push(j);
    }
  }
  for (const i of list) {
    const rel = V.sub(nodes[i].p, pivot);
    nodes[i].p = V.add(pivot, V.rotateFromTo(rel, od, nd));
  }
}

/**
 * Guarantee every bone is long enough that the two hub boxes at its ends cannot
 * overlap. Short bones are the #1 cause of self-intersecting skins.
 */
function enforceBoneLength(skel) {
  const { nodes, bones } = skel;
  for (let pass = 0; pass < 6; pass++) {
    let fixed = 0;
    for (const [a, b] of bones) {
      const na = nodes[a];
      const nb = nodes[b];
      // a junction end needs room for its box AND for the socket that sits
      // beyond the box corners, otherwise the collar quads pinch
      const need =
        hubExtent(na) * (na.neighbors.length >= 3 ? 2.7 : 0.35) +
        hubExtent(nb) * (nb.neighbors.length >= 3 ? 2.7 : 0.35) +
        1e-3;
      const d = V.sub(nb.p, na.p);
      const l = V.len(d);
      if (l >= need || l < 1e-9) continue;
      // push the far side (and its subtree) outwards
      const shift = V.mul(V.norm(d), need - l);
      translateSubtree(skel, a, b, shift);
      fixed++;
    }
    if (!fixed) break;
  }
}

/**
 * Laplacian smoothing of degree-2 (chain) vertices only. Junctions and tips are
 * pinned. Kinky skeletons produce folded quads, so this is a geometry-quality
 * pass, not a cosmetic one.
 */
export function smoothChains(skel, iterations = 2, factor = 0.28) {
  const { nodes } = skel;
  for (let it = 0; it < iterations; it++) {
    const next = nodes.map((n) => n.p);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.neighbors.length !== 2) continue;
      const mid = V.mul(V.add(nodes[n.neighbors[0]].p, nodes[n.neighbors[1]].p), 0.5);
      next[i] = V.lerp(n.p, mid, factor);
    }
    for (let i = 0; i < nodes.length; i++) nodes[i].p = next[i];
  }
}

export function hubExtent(node) {
  return node.r * 0.88;
}

function translateSubtree(skel, fromIdx, toIdx, shift) {
  const { nodes } = skel;
  const stack = [toIdx];
  const seen = new Set([fromIdx, toIdx]);
  const list = [toIdx];
  while (stack.length) {
    const i = stack.pop();
    for (const j of nodes[i].neighbors) {
      if (seen.has(j)) continue;
      seen.add(j);
      list.push(j);
      stack.push(j);
    }
  }
  for (const i of list) nodes[i].p = V.add(nodes[i].p, shift);
}

/** Order vertices by distance from the root - used for the growth animation. */
export function orderByGrowth(skel) {
  const { nodes } = skel;
  const order = [];
  const distArr = new Float64Array(nodes.length);
  const seen = new Uint8Array(nodes.length);
  const queue = [0];
  seen[0] = 1;
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    order.push(i);
    for (const j of nodes[i].neighbors) {
      if (seen[j]) continue;
      seen[j] = 1;
      distArr[j] = distArr[i] + V.dist(nodes[i].p, nodes[j].p);
      queue.push(j);
    }
  }
  order.sort((a, b) => distArr[a] - distArr[b]);
  return { order, dist: distArr, maxDist: Math.max(...distArr, 1e-6) };
}

export { collisionReport };

export function skeletonStats(skel) {
  let junctions = 0;
  let tips = 0;
  for (const n of skel.nodes) {
    if (n.neighbors.length >= 3) junctions++;
    else if (n.neighbors.length === 1) tips++;
  }
  return { vertices: skel.nodes.length, bones: skel.bones.length, junctions, tips };
}
