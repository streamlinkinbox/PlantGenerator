// SEQUENTIAL FRAGMENTATION of a periodic strip into polygonal cells.
//
// This is the pattern-formation half of the bark system. It is NOT a noise
// field and not a Voronoi diagram: it is the crack-growth model of
// desiccation/growth fracture (Bohn, Pauchard & Couder 2005; Goehring & Morris
// 2014), where a NEW crack nucleates inside an existing fragment and STOPS on
// the boundary it meets. That single rule is what produces the statistics real
// bark and mud have:
//
//   * every junction is a T (the arriving crack terminates on a straight,
//     older crack) -> X junctions are impossible by construction,
//   * fragment areas follow a broad, hierarchical distribution because big
//     fragments keep getting picked first,
//   * cells are convex-ish 4-7 sided polygons, not 6-sided Voronoi cells.
//
// Everything is done on POLYGONS (exact vertices), never on a pixel grid, so
// the output can be turned straight into clean quad geometry.
//
// Domain: x in [0, W) with x periodic, y in [y0, y1]. The first primary fissure
// sits on the seam, so no cell ever straddles x = 0 and the wrap is exact.

// ------------------------------------------------------------------ polygons
export function polyArea(p) {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const q = p[(i + 1) % n];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return a * 0.5;
}

export function polyCentroid(p) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const q = p[(i + 1) % n];
    const f = p[i][0] * q[1] - q[0] * p[i][1];
    a += f;
    cx += (p[i][0] + q[0]) * f;
    cy += (p[i][1] + q[1]) * f;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-12) {
    let sx = 0;
    let sy = 0;
    for (const q of p) { sx += q[0]; sy += q[1]; }
    return [sx / p.length, sy / p.length];
  }
  return [cx / (6 * a), cy / (6 * a)];
}

export function polyBBox(p) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const q of p) {
    if (q[0] < x0) x0 = q[0];
    if (q[0] > x1) x1 = q[0];
    if (q[1] < y0) y0 = q[1];
    if (q[1] > y1) y1 = q[1];
  }
  return [x0, y0, x1, y1];
}

export function pointInPoly(p, pt) {
  let inside = false;
  for (let i = 0, n = p.length, j = n - 1; i < n; j = i++) {
    const a = p[i];
    const b = p[j];
    if ((a[1] > pt[1]) !== (b[1] > pt[1])) {
      const t = (pt[1] - a[1]) / (b[1] - a[1]);
      if (pt[0] < a[0] + t * (b[0] - a[0])) inside = !inside;
    }
  }
  return inside;
}

const cross2 = (ax, ay, bx, by) => ax * by - ay * bx;

function segCross(a, b, c, d) {
  // proper intersection only (shared endpoints do not count)
  const d1 = cross2(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]);
  const d2 = cross2(b[0] - a[0], b[1] - a[1], d[0] - a[0], d[1] - a[1]);
  const d3 = cross2(d[0] - c[0], d[1] - c[1], a[0] - c[0], a[1] - c[1]);
  const d4 = cross2(d[0] - c[0], d[1] - c[1], b[0] - c[0], b[1] - c[1]);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/** No two non-adjacent edges may cross. */
export function isSimple(p) {
  const n = p.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (i === j) continue;
      if ((i + 1) % n === j || (j + 1) % n === i) continue;
      if (segCross(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) return false;
    }
  }
  return true;
}

/** Drop points that are closer than eps or exactly collinear with both sides. */
function cleanPoly(p, eps) {
  const out = [];
  for (const q of p) {
    if (!out.length || Math.hypot(q[0] - out[out.length - 1][0], q[1] - out[out.length - 1][1]) > eps)
      out.push(q);
  }
  while (out.length > 3 &&
    Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < eps)
    out.pop();
  return out;
}

// -------------------------------------------------------------- crack cutting
/**
 * Cast the line through `p0` with direction `dir` at the polygon boundary and
 * return the first hit on each side.
 */
function boundaryHits(poly, p0, dir) {
  const n = poly.length;
  let pos = null;
  let neg = null;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const den = cross2(dir[0], dir[1], ex, ey);
    if (Math.abs(den) < 1e-12) continue;
    // p0 + t*dir = a + s*e
    const rx = a[0] - p0[0];
    const ry = a[1] - p0[1];
    const s = cross2(dir[0], dir[1], rx, ry) / -den;
    if (s < 1e-6 || s > 1 - 1e-6) continue;
    const t = cross2(ex, ey, rx, ry) / -den;
    // A crack that would terminate a hair away from an existing junction is
    // snapped onto it. Real cracks do that (they run into the stress shadow of
    // the older crack), and it stops the mesher inheriting a 1%-long edge.
    const snap = s < 0.16 ? 0 : s > 0.84 ? 1 : s;
    const hit = {
      t,
      edge: i,
      p: [a[0] + ex * snap, a[1] + ey * snap],
    };
    if (t > 1e-9) { if (!pos || t < pos.t) pos = hit; }
    else if (t < -1e-9) { if (!neg || t > neg.t) neg = hit; }
  }
  return [neg, pos];
}

/**
 * Cut `poly` with the polyline A -> mid... -> B, where A lies on edge iA and B
 * on edge iB. Returns the two resulting rings.
 */
function cutPolygon(poly, A, iA, B, iB, mid) {
  const n = poly.length;
  const walk = (from, to) => {
    const out = [];
    let i = (from + 1) % n;
    for (let guard = 0; guard <= n; guard++) {
      out.push(poly[i]);
      if (i === to) break;
      i = (i + 1) % n;
    }
    return out;
  };
  const one = [A, ...mid, B, ...walk(iB, iA)];
  const two = [B, ...mid.slice().reverse(), A, ...walk(iA, iB)];
  return [one, two];
}

// -------------------------------------------------------------------- fissures
/**
 * A primary fissure: a meandering, mostly-vertical crack running the full
 * height of the strip. Real bark keeps a few of these open for the whole life
 * of the stem (they are the ones that take up circumferential growth), so they
 * are laid down first and never crossed.
 */
function fissurePath(x0, y0, y1, rows, amp, rng) {
  const pts = [];
  let drift = 0;
  let vel = 0;
  for (let i = 0; i <= rows; i++) {
    const t = i / rows;
    vel = vel * 0.72 + (rng() * 2 - 1) * amp * 0.5;
    drift += vel;
    drift = Math.max(-amp, Math.min(amp, drift));
    pts.push([x0 + drift, y0 + (y1 - y0) * t]);
  }
  return pts;
}

// ------------------------------------------------------------------- min-heap
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].key >= a[i].key) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].key > a[m].key) m = l;
        if (r < a.length && a[r].key > a[m].key) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

// ---------------------------------------------------------------------- main
/**
 * @param {object} o
 * @param {number} o.W          strip width (periodic)
 * @param {number} o.y0,y1      strip extent
 * @param {(y:number)=>number} o.cellHeight  target plate height at height y
 * @param {number} o.elongation target height / width of a plate
 * @param {number} o.meander    0..1 crack waviness
 * @param {number} o.sizeVar    0..1 spread of plate sizes
 * @param {()=>number} o.rng
 * @param {number} o.maxCells
 * @returns {{cells: Array<Array<[number,number]>>, stats: object}}
 */
export function fragmentStrip(o) {
  const {
    W, y0, y1, elongation = 2.2, meander = 0.35, sizeVar = 0.45,
    rng, maxCells = 4000,
  } = o;
  const cellHeight = o.cellHeight || (() => 0.15);
  // elongation may vary with y: on a tapering stem the strip is compressed
  // around the thin end, so the cells there have to be wider in parameter
  // space to come out the same shape on the wood
  const elongAt = typeof elongation === 'function' ? elongation : () => elongation;
  const H = y1 - y0;
  if (H <= 1e-6 || W <= 1e-6) return { cells: [], stats: { splits: 0, tJunctions: 0, xJunctions: 0 } };

  // ---- stage A: primary fissures -> vertical strips
  const midH = cellHeight((y0 + y1) * 0.5);
  const plateW = Math.max(midH / Math.max(elongAt((y0 + y1) * 0.5), 0.2), 1e-4);
  // primary fissures are a few plates apart; the cells between them are then
  // broken down by the sequential rule below
  let nCol = Math.max(2, Math.round(W / (plateW * 2.6)));
  const colW = W / nCol;
  const rows = Math.max(3, Math.round(H / Math.max(midH, 1e-4)));
  const amp = colW * 0.22 * (0.4 + meander);
  const paths = [];
  for (let k = 0; k < nCol; k++) paths.push(fissurePath(k * colW, y0, y1, rows, amp, rng));

  const cells = [];
  const heap = new Heap();
  let cellCount = 0;
  const pushCell = (poly) => {
    const p = cleanPoly(poly, Math.max(W, H) * 1e-6);
    if (p.length < 3) return;
    const a = Math.abs(polyArea(p));
    if (a < 1e-9) return;
    heap.push({ key: a, poly: p, area: a });
    cellCount++;
  };

  for (let k = 0; k < nCol; k++) {
    const left = paths[k];
    const right = k + 1 < nCol ? paths[k + 1] : paths[0].map((p) => [p[0] + W, p[1]]);
    // CCW: up the right edge, back down the left edge
    pushCell([...right.map((p) => [p[0], p[1]]), ...left.slice().reverse().map((p) => [p[0], p[1]])]);
  }

  // ---- stage B: sequential fragmentation
  let splits = 0;
  let rejected = 0;
  const done = [];
  while (heap.size && cellCount < maxCells) {
    const cell = heap.pop();
    cellCount--;
    const poly = cell.poly;
    const c = polyCentroid(poly);
    const target = cellHeight(c[1]);
    const E = Math.max(elongAt(c[1]), 0.2);
    const tw = target / E;
    const targetArea = target * tw * (1 + (rng() * 2 - 1) * sizeVar);
    if (cell.area <= targetArea) { done.push(poly); continue; }

    const [bx0, by0, bx1, by1] = polyBBox(poly);
    const w = bx1 - bx0;
    const h = by1 - by0;
    // split across the long axis, biased so plates settle at the target aspect
    const horizontal = h / Math.max(w, 1e-9) >= E * (0.75 + rng() * 0.5);
    const baseDir = horizontal ? [1, 0] : [0, 1];
    const tilt = (rng() * 2 - 1) * (horizontal ? 0.30 : 0.16) * (0.5 + meander);
    const dir = [
      baseDir[0] * Math.cos(tilt) - baseDir[1] * Math.sin(tilt),
      baseDir[0] * Math.sin(tilt) + baseDir[1] * Math.cos(tilt),
    ];
    let split = null;
    for (let attempt = 0; attempt < 4 && !split; attempt++) {
      const wob = meander * Math.pow(0.6, attempt);
      const jit = 0.16 * Math.pow(0.6, attempt);
      const p0 = [c[0] + (rng() * 2 - 1) * w * jit, c[1] + (rng() * 2 - 1) * h * jit];
      const [neg, pos] = boundaryHits(poly, p0, dir);
      if (!neg || !pos || neg.edge === pos.edge) break;
      const A = neg.p;
      const B = pos.p;
      const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
      if (L < 1e-6) break;
      const nx = -(B[1] - A[1]) / L;
      const ny = (B[0] - A[0]) / L;
      const segs = 2 + Math.floor(rng() * 3);
      const mid = [];
      let ok = true;
      for (let i = 1; i < segs; i++) {
        const t = i / segs;
        const base = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t];
        let off = (rng() * 2 - 1) * wob * L * 0.22;
        let pt = [base[0] + nx * off, base[1] + ny * off];
        let tries = 0;
        while (!pointInPoly(poly, pt) && tries++ < 5) {
          off *= 0.45;
          pt = [base[0] + nx * off, base[1] + ny * off];
        }
        if (!pointInPoly(poly, pt)) { ok = false; break; }
        mid.push(pt);
      }
      if (!ok) continue;
      const [one, two] = cutPolygon(poly, A, neg.edge, B, pos.edge, mid);
      const c1 = cleanPoly(one, Math.max(W, H) * 1e-6);
      const c2 = cleanPoly(two, Math.max(W, H) * 1e-6);
      if (c1.length < 3 || c2.length < 3) continue;
      const a1 = Math.abs(polyArea(c1));
      const a2 = Math.abs(polyArea(c2));
      if (a1 < cell.area * 0.18 || a2 < cell.area * 0.18) continue; // no slivers
      if (Math.abs(a1 + a2 - cell.area) > cell.area * 0.02) continue;
      if (!isSimple(c1) || !isSimple(c2)) continue;
      split = [c1, c2];
    }

    if (!split) { rejected++; done.push(poly); continue; }
    splits++;
    pushCell(split[0]);
    pushCell(split[1]);
  }
  while (heap.size) done.push(heap.pop().poly);

  // every split terminates on an existing crack: 2 new T junctions each, and
  // an X junction cannot be produced by this rule.
  return {
    cells: done,
    stats: {
      cells: done.length,
      primaryFissures: nCol,
      splits,
      rejectedSplits: rejected,
      tJunctions: splits * 2,
      xJunctions: 0,
    },
  };
}
