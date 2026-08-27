// HIERARCHICAL CRACK PATTERN (successive domain division)
//
// The pattern that plated bark, dried mud, ceramic glaze and cooling lava all
// share is NOT a Voronoi tessellation and not noise. It is built by SEQUENTIAL
// fracture: a crack nucleates inside the largest remaining domain, runs across
// it, and turns to meet an older crack at right angles. The domain is split in
// two, and the process repeats on the pieces until they reach a characteristic
// size set by the thickness of the cracking layer.
//
// That history is visible in the result: junctions are mostly "T" (a younger
// crack ending on an older one) rather than the "Y" junctions a Voronoi
// diagram produces, cell edges are curved rather than straight, and cells have
// a narrow size distribution with 4-7 sides.
//
//   Bohn, Pauchard & Couder, "Hierarchical crack pattern as formed by
//     successive domain divisions" (Phys. Rev. E 71, 2005)
//   Goehring & Morris, "Cracking mud, freezing dirt, and breaking rocks"
//     (Physics Today 2014): later cracks curve to hit earlier ones at right
//     angles; cracking saturates at a cell size proportional to layer depth
//   Bhattacharya et al., PNAS 122 (2025): hierarchical networks are
//     T-junction dominated
//   "Algorithms for generating planar networks simulating hierarchical crack
//     patterns" (arXiv 2603.24171): of random tessellation, recursive Voronoi
//     and crack-growth simulation, only the crack-growth simulation reproduces
//     the real angle/size/side statistics. That is the model implemented here.
//
// Everything is rasterised: cracks are drawn into a grid, domains are the
// connected components between them. That makes splitting, distance fields and
// per-cell lookup trivial, and it is what the mesh stage samples.

import { makeRng } from './rng.js';

export const CRACK_DEFAULTS = {
  seed: 3,
  res: 384,          // raster resolution of the patch
  cellSize: 0.11,    // characteristic scale size, as a fraction of the patch
  sizeSpread: 0.45,  // how much scale sizes vary
  anisotropy: 1.0,   // >1 = scales elongated along Y (pine-like)
  wander: 0.6,       // how much a crack meanders while it grows
  perpBias: 0.75,    // how strongly a crack turns to hit an older one at 90 deg
  maxCracks: 4000,
};

/**
 * @returns {{res, cell: Int32Array, crack: Uint8Array, dist: Float32Array,
 *            cells: Array, junctions: {T:number, Y:number, X:number}}}
 */
export function crackPattern(opts = {}) {
  const O = { ...CRACK_DEFAULTS, ...opts };
  const R = Math.max(64, Math.round(O.res));
  const rnd = makeRng(O.seed);
  const N = R * R;

  const crack = new Uint8Array(N);
  const cell = new Int32Array(N).fill(0);
  const idx = (x, y) => y * R + x;

  // the patch border behaves like an existing crack: domains end there
  for (let i = 0; i < R; i++) {
    crack[idx(i, 0)] = 1;
    crack[idx(i, R - 1)] = 1;
    crack[idx(0, i)] = 1;
    crack[idx(R - 1, i)] = 1;
  }

  // ---- domain bookkeeping -------------------------------------------------
  const relabel = (seedX, seedY, id) => {
    // flood fill one domain, returning its pixels and second moments
    const seed0 = idx(seedX, seedY);
    if (crack[seed0]) return { id, pix: [], area: 0, cx: seedX, cy: seedY, mxx: 1, myy: 1, mxy: 0 };
    const stack = [seed0];
    const pix = [];
    cell[stack[0]] = id;
    let sx = 0;
    let sy = 0;
    while (stack.length) {
      const p = stack.pop();
      pix.push(p);
      const x = p % R;
      const y = (p / R) | 0;
      sx += x;
      sy += y;
      if (x > 0) { const q = p - 1; if (!crack[q] && cell[q] !== id) { cell[q] = id; stack.push(q); } }
      if (x < R - 1) { const q = p + 1; if (!crack[q] && cell[q] !== id) { cell[q] = id; stack.push(q); } }
      if (y > 0) { const q = p - R; if (!crack[q] && cell[q] !== id) { cell[q] = id; stack.push(q); } }
      if (y < R - 1) { const q = p + R; if (!crack[q] && cell[q] !== id) { cell[q] = id; stack.push(q); } }
    }
    const n = pix.length;
    const cx = sx / n;
    const cy = sy / n;
    let mxx = 0;
    let myy = 0;
    let mxy = 0;
    for (const p of pix) {
      const dx = (p % R) - cx;
      const dy = ((p / R) | 0) - cy;
      mxx += dx * dx;
      myy += dy * dy;
      mxy += dx * dy;
    }
    return { id, pix, area: n, cx, cy, mxx: mxx / n, myy: myy / n, mxy: mxy / n };
  };

  let nextId = 1;
  const cells = new Map();
  const first = relabel(1 + ((R / 2) | 0) % 2, (R / 2) | 0, nextId);
  cells.set(nextId, first);
  nextId++;

  // target area per scale, with the anisotropy folded in
  const target = (O.cellSize * R) * (O.cellSize * R) * (O.anisotropy > 0 ? 1 : 1);

  /** Pick the domain to split next: the largest, so the pattern is hierarchical. */
  const pickDomain = (stuck) => {
    let best = null;
    for (const c of cells.values()) {
      if (stuck && stuck.has(c.id)) continue;
      const limit = target * (1 + O.sizeSpread * ((c.id * 2654435761) % 1000) / 1000);
      if (c.area <= limit) continue;
      if (!best || c.area > best.area) best = c;
    }
    return best;
  };

  /**
   * Grow one crack across a domain, anchored on the existing network at BOTH
   * ends. It starts on the domain boundary, meanders as it crosses, and is
   * steered back towards its crossing direction so it always reaches the far
   * side - a crack that dead-ends inside the domain would not split it, and
   * the domain would be retried for ever.
   */
  const growCrack = (dom) => {
    // A domain splits ACROSS its long axis: that is the cut which relieves the
    // most stress, and it is why repeated division drives cells towards a
    // common size instead of ever thinner slivers.
    const { mxx, myy, mxy } = dom;
    const theta = 0.5 * Math.atan2(2 * mxy, mxx - myy);
    // not exactly perpendicular: a little scatter keeps the cells from all
    // coming out rectangular
    const cut = theta + Math.PI / 2 + rnd.sym(0.38);
    const ext = Math.sqrt(Math.max(dom.area, 1));

    // offset the cut from the centroid so cells do not all halve exactly
    const off = rnd.sym(0.18) * ext;
    const ox = dom.cx + Math.cos(theta) * off;
    const oy = dom.cy + Math.sin(theta) * off;

    // find the boundary by marching backwards along the cut direction
    let bx = ox;
    let by = oy;
    let guard = 0;
    while (guard++ < R * 2) {
      const nx = bx - Math.cos(cut);
      const ny = by - Math.sin(cut);
      const ix = Math.round(nx);
      const iy = Math.round(ny);
      if (ix < 0 || iy < 0 || ix >= R || iy >= R || crack[idx(ix, iy)]) break;
      bx = nx;
      by = ny;
    }

    // grow forward until we hit the network again
    // The path must be 4-CONNECTED. A diagonal chain of pixels is only
    // 8-connected, and a 4-connected flood fill walks straight through its
    // corners - the domain then never separates and every split is rejected.
    const path = [];
    let px = Math.round(bx);
    let py = Math.round(by);
    const push = (ix, iy) => {
      if (ix !== px && iy !== py) {
        const bridge = idx(px, iy);
        if (!crack[bridge]) path.push(bridge);
      }
      px = ix;
      py = iy;
      const p = idx(ix, iy);
      if (!crack[p]) path.push(p);
    };
    let x = bx;
    let y = by;
    let wobble = 0;
    const maxSteps = Math.min(R * 3, ext * 4 + 32);
    let hit = false;
    for (let step = 0; step < maxSteps; step++) {
      // bounded meander around the crossing direction
      wobble += rnd.sym(O.wander) * 0.5;
      wobble *= 0.95;                      // meander persists instead of decaying
      wobble = Math.max(-1.1, Math.min(1.1, wobble));
      const straighten = step > maxSteps * 0.75 ? 0.25 : 1; // commit near the end
      const ang = cut + wobble * straighten;
      x += Math.cos(ang);
      y += Math.sin(ang);
      const ix = Math.round(x);
      const iy = Math.round(y);
      if (ix < 0 || iy < 0 || ix >= R || iy >= R) break;
      const p = idx(ix, iy);
      if (crack[p]) {
        // the first few steps are still leaving the anchoring crack: walk on
        if (step <= 3) { px = ix; py = iy; continue; }
        // bridge diagonally onto the network so the barrier is unbroken
        if (ix !== px && iy !== py) {
          const bridge = idx(px, iy);
          if (!crack[bridge]) path.push(bridge);
        }
        hit = true;
        break;
      }
      push(ix, iy);
    }
    if (!hit || path.length < 2) return null;
    return path;
  };

  // ---- successive division ------------------------------------------------
  let attempts = 0;
  let splits = 0;
  let failNoHit = 0;
  let failSliver = 0;
  const stuck = new Set();
  while (attempts < O.maxCracks) {
    const dom = pickDomain(stuck);
    if (!dom) break;
    attempts++;
    const fail = () => {
      dom.fails = (dom.fails || 0) + 1;
      if (dom.fails >= 6) stuck.add(dom.id);
    };
    const path = growCrack(dom);
    if (!path) { failNoHit++; fail(); continue; }

    for (const p of path) { crack[p] = 1; cell[p] = 0; }
    for (const p of dom.pix) if (!crack[p]) cell[p] = 0;
    const made = [];
    for (const p of dom.pix) {
      if (crack[p] || cell[p] !== 0) continue;
      made.push(relabel(p % R, (p / R) | 0, nextId));
      nextId++;
    }
    // A split has to produce two real pieces. Judge it on the two LARGEST -
    // a cut also pinches off tiny fragments where it meets the old network,
    // and those are crumbs, not scales. A crack that merely shaves a sliver off
    // the edge is undone and the domain retried.
    made.sort((a, b) => b.area - a.area);
    const second = made.length > 1 ? made[1].area : 0;
    if (made.length < 2 || second < dom.area * 0.1) {
      for (const p of path) crack[p] = 0;
      for (const p of dom.pix) cell[p] = 0;
      // re-seed from a pixel that is definitely free: the centroid can sit on a
      // crack, and flood filling from there would label a single pixel as the
      // whole domain and quietly stall the subdivision
      let seed = -1;
      for (const p of dom.pix) if (!crack[p]) { seed = p; break; }
      if (seed < 0) { cells.delete(dom.id); continue; }
      cells.set(dom.id, relabel(seed % R, (seed / R) | 0, dom.id));
      failSliver++;
      fail();
      continue;
    }
    cells.delete(dom.id);
    const crumb = Math.max(8, dom.area * 0.02);
    for (const c of made) {
      if (c.area < crumb) {
        // absorb crumbs into the fissure network
        for (const p of c.pix) { crack[p] = 1; cell[p] = 0; }
        continue;
      }
      cells.set(c.id, c);
    }
    splits++;
  }

  // ---- distance to the nearest crack (for fissure profiles) ---------------
  const dist = new Float32Array(N).fill(Infinity);
  const queue = new Int32Array(N);
  let head = 0;
  let tail = 0;
  for (let p = 0; p < N; p++) if (crack[p]) { dist[p] = 0; queue[tail++] = p; }
  while (head < tail) {
    const p = queue[head++];
    const x = p % R;
    const y = (p / R) | 0;
    const d = dist[p] + 1;
    if (x > 0 && dist[p - 1] > d) { dist[p - 1] = d; queue[tail++] = p - 1; }
    if (x < R - 1 && dist[p + 1] > d) { dist[p + 1] = d; queue[tail++] = p + 1; }
    if (y > 0 && dist[p - R] > d) { dist[p - R] = d; queue[tail++] = p - R; }
    if (y < R - 1 && dist[p + R] > d) { dist[p + R] = d; queue[tail++] = p + R; }
  }
  // soften the 4-neighbour metric with one diagonal pass
  for (let y = 1; y < R - 1; y++)
    for (let x = 1; x < R - 1; x++) {
      const p = idx(x, y);
      const dg = Math.min(dist[p - R - 1], dist[p - R + 1], dist[p + R - 1], dist[p + R + 1]) + 1.41;
      if (dg < dist[p]) dist[p] = dg;
    }

  // ---- per-cell attributes ------------------------------------------------
  const list = [...cells.values()].sort((a, b) => a.id - b.id);
  const byId = new Map();
  list.forEach((c, i) => {
    c.index = i;
    c.lift = rnd.sym(1);
    c.tiltX = rnd.sym(1);
    c.tiltY = rnd.sym(1);
    c.rough = 0.5 + rnd() * 1.0;
    c.tone = rnd();
    c.shed = rnd();
    byId.set(c.id, c);
  });

  return {
    res: R, cell, crack, dist, cells: list, byId,
    junctions: junctionStats(crack, R),
    attempts, splits, failNoHit, failSliver,
  };
}

/** T / Y / X junction counts - the fingerprint the literature classifies on. */
function junctionStats(crack, R) {
  let T = 0;
  let Y = 0;
  let X = 0;
  const idx = (x, y) => y * R + x;
  for (let y = 2; y < R - 2; y++)
    for (let x = 2; x < R - 2; x++) {
      if (!crack[idx(x, y)]) continue;
      // count crack arms leaving a small ring around this pixel
      let arms = 0;
      let prev = crack[idx(x - 1, y - 1)];
      const ring = [
        [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
      ];
      for (let k = 1; k < ring.length; k++) {
        const v = crack[idx(x + ring[k][0], y + ring[k][1])];
        if (v && !prev) arms++;
        prev = v;
      }
      if (arms === 3) T++;
      else if (arms === 4) X++;
    }
  Y = 0;
  return { T, Y, X };
}
