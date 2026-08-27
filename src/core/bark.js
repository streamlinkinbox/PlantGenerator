// BARK AS GEOMETRY (no textures, no UVs, no tiling).
//
// Why bark cracks, from the literature:
//   The vascular cambium keeps adding wood, so the stem's girth increases. The
//   outer bark (periderm / rhytidome) is dead, rigid and cannot grow with it,
//   so the girth increase puts the outer layer under TANGENTIAL (circumferential)
//   tension until it ruptures. Because the tension is tangential, the fractures
//   open perpendicular to it - which is why bark fissures are predominantly
//   VERTICAL, with ridges between them (Braun 1955; Frontiers "Cork-Containing
//   Barks" review 2016; Meliaceae bark study, Trees 2025). When elastic
//   parenchyma layers redistribute some of that stress vertically/diagonally,
//   the ridges also crack transversally and the pattern becomes RETICULATE or
//   tessellate - that is the `reticulation` parameter here.
//
// How it is simulated:
//   Federl & Prusinkiewicz model exactly this as a BI-LAYERED material: a rigid
//   outer layer bonded to a growing substrate, discretised as a mass-spring
//   lattice (WCGS 1996, 2002) or FEM (ICCS 2004); Dale, Runions, Hobill &
//   Prusinkiewicz use the same mass-spring formulation for bark patterning in
//   grasstrees (Annals of Botany 114:629, 2014). This file does the same thing
//   on the tree's own quad lattice:
//
//     1. the substrate (wood) is inflated radially step by step;
//     2. lattice springs (the bark layer) resist, each node is tied to its
//        substrate point by an attachment spring (the bond to the wood);
//     3. springs whose strain passes a randomised toughness threshold BREAK;
//     4. the surviving lattice relaxes, which unloads the neighbourhood of a
//        fresh crack - this is what sets the ridge spacing (shear-lag): the
//        stress-transfer length is h*sqrt(k_spring/k_attach);
//     5. continued growth opens the cracks into furrows.
//
//   The resulting crack network is then carved into the mesh as displacement
//   along the vertex normals, so the topology stays exactly what it was:
//   all quads, one shell, watertight.

import * as V from './vec3.js';
import { refineRegion, regionMaxEdge, regionMedianEdge, smoothRegion, expandSelection } from './refine.js';
import { makeRng } from './rng.js';

export const BARK_DEFAULTS = {
  barkResolution: 0,     // target quad size; 0 = ridgeWidth/8 (auto)
  barkMaxLevels: 5,      // cap on local refinement (each level also slices a
                         // band of the surrounding mesh - see README)
  faceBudget: 1500000,   // hard cap on total faces after refinement
  autoRidge: 1,          // widen the ridges if the mesh cannot resolve them
  smoothPasses: 6,       // Laplacian passes that round the trunk before carving
  ridgeWidth: 0.09,      // mean ridge width (world units)
  growth: 1.6,           // MAX girth increase; growth stops once the pattern
                         // has reached the requested fissure density
  reticulation: 0.06,    // share of longitudinal stress (0 = plain vertical fissures)
  fibreStrength: 4.5,    // extra toughness along the grain (vertical fibres)
  toughnessVar: 0.22,    // spread of the per-spring rupture threshold
  tipConcentration: 1.6, // stress concentration at a collinear crack tip
  strainLimit: 0.055,    // mean rupture strain of the outer bark
  steps: 45,             // growth increments (small ones: cracks then appear
                         // gradually and space themselves out evenly)
  bondScale: 1.0,        // stress-transfer length, in ridge widths
  latticeScale: 0.55,    // lattice cell size, in ridge widths
  relaxIters: 18,        // relaxation sweeps between rupture passes
  ruptureCycles: 6,      // rupture/relax cycles per growth increment
  breakRate: 0.004,      // share of springs allowed to fail per rupture pass
  furrowDepth: 1.5,      // furrow depth as a fraction of the furrow half-width
  furrowWidth: 0.27,     // furrow HALF-width as a fraction of the ridge width
  ridgeRound: 0.25,      // how rounded the ridge tops are
  grain: 0.22,           // fine fibrous noise, fraction of furrow depth
  warp: 0.35,            // organic wander of the fissures, in ridge widths
  plateShift: 0.15,      // how much of the simulated plate separation to keep
  minRadiusRatio: 0.42,  // bark stops where the stem is this fraction of the trunk
  barkSeed: 11,          // NOT `seed`: that one belongs to the tree
};

/* ------------------------------------------------------------------ trunk */

/** Walk from the root up the thickest child while the stem stays thick. */
export function trunkPath(skel, minRadiusRatio = 0.42) {
  const { nodes } = skel;
  const rTrunk = nodes[0].r;
  const path = [0];
  const inPath = new Set([0]);
  let prev = -1;
  let cur = 0;
  let guard = 0;
  while (guard++ < 1e5) {
    const kids = nodes[cur].neighbors.filter((j) => j !== prev);
    if (!kids.length) break;
    let best = kids[0];
    for (const k of kids) if (nodes[k].r > nodes[best].r) best = k;
    if (nodes[best].r < rTrunk * minRadiusRatio) break;
    prev = cur;
    cur = best;
    path.push(cur);
    inPath.add(cur);
  }
  return { path, inPath };
}

/** Arc-length + parallel-transported frames along the trunk polyline. */
function trunkFrames(skel, path) {
  const pts = path.map((i) => skel.nodes[i].p);
  const rad = path.map((i) => skel.nodes[i].r);
  const n = pts.length;
  const tan = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    tan.push(V.norm(V.sub(b, a)));
  }
  const arc = [0];
  for (let i = 1; i < n; i++) arc.push(arc[i - 1] + V.dist(pts[i], pts[i - 1]));
  return { pts, rad, tan, arc, total: arc[n - 1] || 1 };
}

/** Closest point on the trunk polyline: axis point, radial dir, local radius. */
function projectToAxis(fr, p) {
  let best = { d2: Infinity, seg: 0, t: 0 };
  for (let i = 0; i < fr.pts.length - 1; i++) {
    const a = fr.pts[i];
    const b = fr.pts[i + 1];
    const ab = V.sub(b, a);
    const len2 = V.dot(ab, ab) || 1e-9;
    let t = V.dot(V.sub(p, a), ab) / len2;
    t = Math.max(0, Math.min(1, t));
    const q = V.add(a, V.mul(ab, t));
    const d2 = V.dot(V.sub(p, q), V.sub(p, q));
    if (d2 < best.d2) best = { d2, seg: i, t, q };
  }
  const i = best.seg;
  const axis = best.q;
  const dir = V.norm(V.lerp(fr.tan[i], fr.tan[i + 1], best.t));
  const rLocal = fr.rad[i] + (fr.rad[i + 1] - fr.rad[i]) * best.t;
  const s = fr.arc[i] + (fr.arc[i + 1] - fr.arc[i]) * best.t;
  let radial = V.sub(p, axis);
  radial = V.sub(radial, V.mul(dir, V.dot(radial, dir)));
  const rr = V.len(radial);
  return { axis, dir, radial: rr > 1e-9 ? V.mul(radial, 1 / rr) : V.perp(dir), rr, rLocal, s };
}

/** Faces of the skin whose nearest skeleton vertex belongs to the trunk. */
export function selectTrunkFaces(mesh, skel, inPath, fr, opts) {
  const nodes = skel.nodes;
  // spatial hash over skeleton vertices for the nearest-node query
  let cell = 0;
  for (const n of nodes) cell += n.r;
  cell = Math.max((cell / nodes.length) * 6, 1e-3);
  const grid = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  const cellOf = (p) => [Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell)];
  nodes.forEach((n, i) => {
    const [x, y, z] = cellOf(n.p);
    const k = key(x, y, z);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  const nearest = (p) => {
    const [cx, cy, cz] = cellOf(p);
    let best = -1;
    let bd = Infinity;
    for (let r = 1; r <= 4 && best < 0; r++) {
      for (let x = cx - r; x <= cx + r; x++)
        for (let y = cy - r; y <= cy + r; y++)
          for (let z = cz - r; z <= cz + r; z++) {
            const b = grid.get(key(x, y, z));
            if (!b) continue;
            for (const i of b) {
              const d = V.dist(nodes[i].p, p);
              if (d < bd) { bd = d; best = i; }
            }
          }
    }
    return best;
  };

  const sel = new Set();
  mesh.faces.forEach((f, fi) => {
    const c = mesh.faceCenter(fi);
    const ni = nearest(c);
    if (ni < 0 || !inPath.has(ni)) return;
    // must also sit on the trunk's own surface, not on a branch passing nearby
    const pr = projectToAxis(fr, c);
    if (pr.rr > pr.rLocal * 2.0) return;
    if (pr.s > fr.total * (opts.coverage ?? 1)) return;
    sel.add(fi);
  });
  return sel;
}

/** Largest edge running AROUND the stem inside the region. */
function hoopExtent(mesh, faceSel, fr) {
  let mx = 0;
  for (const fi of faceSel) {
    const f = mesh.faces[fi];
    for (let i = 0; i < 4; i++) {
      const a = mesh.positions[f[i]];
      const b = mesh.positions[f[(i + 1) % 4]];
      const e = V.sub(b, a);
      const len = V.len(e);
      if (len < 1e-9) continue;
      const d = projectToAxis(fr, a).dir;
      const along = Math.abs(V.dot(e, d) / len);
      if (along < 0.5) mx = Math.max(mx, len); // this edge runs around the stem
    }
  }
  return mx;
}

/* ------------------------------------------------------- fracture lattice */

/**
 * Bi-layered growth fracture, simulated on the UNROLLED trunk surface.
 *
 * This is the Federl & Prusinkiewicz / Dale et al. formulation: a regular
 * mass-spring lattice representing the rigid outer bark, bonded to a substrate
 * (the wood) that grows underneath it. Doing it on its own lattice rather than
 * on the render mesh keeps the pattern independent of mesh resolution and makes
 * the whole thing about two orders of magnitude cheaper.
 *
 * Lattice coordinates: x = arc length around the stem (periodic), y = height
 * along the stem. Growth stretches the substrate in x by `growth` (the girth
 * increase) and in y by a much smaller factor (`reticulation`), which is what
 * decides whether the pattern is plain vertical fissures or reticulate.
 */
function fractureLattice2D(fr, O) {
  const rnd = makeRng(O.barkSeed ?? 11);
  // One lattice cell per ridge: the fissure network lives on cell edges, and
  // the mesh-side distance field is computed against those edges as real line
  // segments, so the pattern is not tied to the lattice resolution.
  const spacing = Math.max(O.ridgeWidth * (O.latticeScale ?? 0.85), 1e-3);

  // rows along the stem, columns around it
  const rows = Math.max(4, Math.round(fr.total / spacing));
  const rMean = fr.rad.reduce((a, b) => a + b, 0) / fr.rad.length;
  const cols = Math.max(8, Math.round((2 * Math.PI * rMean) / spacing));
  const n = rows * cols;
  const id = (r, c) => r * cols + ((c % cols) + cols) % cols;

  // rest state (unrolled): x = theta * r(row), y = arc length up the stem
  const rowR = new Float64Array(rows);
  const rowY = new Float64Array(rows);
  for (let r = 0; r < rows; r++) {
    const t = (r / (rows - 1)) * (fr.pts.length - 1);
    const i = Math.min(fr.pts.length - 2, Math.floor(t));
    const f = t - i;
    rowR[r] = fr.rad[i] + (fr.rad[i + 1] - fr.rad[i]) * f;
    rowY[r] = fr.arc[i] + (fr.arc[i + 1] - fr.arc[i]) * f;
  }

  // Unroll onto a strip of CONSTANT width. The stem tapers, but the hoop strain
  // caused by radial growth is the same relative factor at every height, so the
  // mechanics are correct on a constant-width strip - and a per-row width would
  // make the periodic wrap-around inconsistent between rows, which shreds the
  // narrow rows and leaves the wide ones untouched.
  const stripW = 2 * Math.PI * rMean;
  const x0 = new Float64Array(n);
  const y0 = new Float64Array(n);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const k = id(r, c);
      x0[k] = ((c + 0.5) / cols) * stripW;
      y0[k] = rowY[r];
    }

  // springs: hoop (with wrap), axial, and the two diagonals for shear stiffness
  const sa = [];
  const sb = [];
  const rest = [];
  const isAxial = [];
  const width = () => stripW;
  const dxWrap = (a, b, w) => {
    let d = b - a;
    while (d > w * 0.5) d -= w;
    while (d < -w * 0.5) d += w;
    return d;
  };
  // structured indices so a crack can be extended COLLINEARLY (see rupture)
  const hoopIdx = new Int32Array(rows * cols).fill(-1);
  const axialIdx = new Int32Array(rows * cols).fill(-1);
  const springRow = [];
  const springCol = [];
  const springKind = []; // 0 = hoop, 1 = axial, 2 = diagonal
  const addSpring = (ra, ca, rb, cb) => {
    const A = id(ra, ca);
    const B = id(rb, cb);
    const w = width();
    const dx = dxWrap(x0[A], x0[B], w);
    const dy = y0[B] - y0[A];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return;
    sa.push(A); sb.push(B); rest.push(len);
    const af = Math.abs(dy) / len;
    isAxial.push(af);
    const e = sa.length - 1;
    const cc = ((ca % cols) + cols) % cols;
    springRow.push(ra);
    springCol.push(cc);
    if (af < 0.25) { springKind.push(0); hoopIdx[ra * cols + cc] = e; }
    else if (af > 0.75) { springKind.push(1); axialIdx[ra * cols + cc] = e; }
    else springKind.push(2);
  };
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      addSpring(r, c, r, c + 1);
      if (r + 1 < rows) {
        addSpring(r, c, r + 1, c);
        addSpring(r, c, r + 1, c + 1);
        addSpring(r, c, r + 1, c - 1);
      }
    }
  const m = sa.length;
  const restArr = Float64Array.from(rest);
  const axialFrac = Float64Array.from(isAxial);
  const broken = new Uint8Array(m);
  const thresh = new Float64Array(m);
  for (let e = 0; e < m; e++) {
    // Randomised toughness: cracks nucleate at the weak spots. Bark is also
    // strongly anisotropic - cork and phloem fibres run along the stem, so
    // tearing ALONG the grain (which hoop tension does) is much easier than
    // across it. That is why fissures come out vertical.
    thresh[e] =
      O.strainLimit *
      (1 + O.toughnessVar * rnd.sym(1)) *
      (1 + O.fibreStrength * axialFrac[e] * axialFrac[e]);
  }

  // ---- bond stiffness from shear lag.
  // A fissure unloads the sheet either side of itself over the stress-transfer
  // length L = cell * sqrt(k_spring / k_bond); beyond that the sheet is still
  // fully stretched and cracks again. So the ridge width IS that transfer
  // length, and it pins the bond stiffness:
  //        k_bond = (cell / ridgeWidth)^2
  // Too soft and one fissure unloads the whole trunk (a few cracks, big bare
  // patches); too stiff and the sheet shatters into gravel.
  const h = spacing;
  const L = Math.max(O.ridgeWidth * (O.bondScale ?? 1), h * 1.05);
  const ka = Math.max(1e-4, Math.min(0.6, (h / L) * (h / L)));

  const px = Float64Array.from(x0);
  const py = Float64Array.from(y0);
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  const fx = new Float64Array(n);
  const fy = new Float64Array(n);
  const ax = new Float64Array(n);
  const ay = new Float64Array(n);
  const dt = 0.16;
  const damp = 0.86;

  const relax = (iters, w) => {
    for (let it = 0; it < iters; it++) {
      fx.fill(0);
      fy.fill(0);
      for (let e = 0; e < m; e++) {
        if (broken[e]) continue;
        const i = sa[e];
        const j = sb[e];
        const dx = dxWrap(px[i], px[j], w);
        const dy = py[j] - py[i];
        const len = Math.hypot(dx, dy) || 1e-9;
        const f = (len - restArr[e]) / len;
        fx[i] += dx * f; fy[i] += dy * f;
        fx[j] -= dx * f; fy[j] -= dy * f;
      }
      for (let i = 0; i < n; i++) {
        fx[i] += dxWrap(px[i], ax[i], w) * ka;
        fy[i] += (ay[i] - py[i]) * ka;
        vx[i] = vx[i] * damp + fx[i] * dt;
        vy[i] = vy[i] * damp + fy[i] * dt;
        px[i] += vx[i] * dt;
        py[i] += vy[i] * dt;
      }
    }
  };

  // A vertical fissure is a broken HOOP spring; one fissure every `ridgeWidth`
  // means this fraction of the hoop springs has to have parted. Growth stops
  // the moment that density is reached - bark pattern really does depend on how
  // much girth the stem has added since the periderm formed.
  const targetFrac = Math.min(0.92, spacing / O.ridgeWidth);
  let hoopTotal = 0;
  for (let e = 0; e < m; e++) if (axialFrac[e] < 0.25) hoopTotal++;
  const hoopTarget = Math.round(hoopTotal * targetFrac);
  const excess = new Float64Array(m);
  const atCrack = new Uint8Array(n);
  let hoopBrokenCount = 0;
  const rupture = (w) => {
    let maxEx = 0;
    for (let e = 0; e < m; e++) {
      excess[e] = -1;
      if (broken[e]) continue;
      const i = sa[e];
      const j = sb[e];
      const len = Math.hypot(dxWrap(px[i], px[j], w), py[j] - py[i]);
      let ex = (len - restArr[e]) / restArr[e] - thresh[e];
      // Crack-TIP concentration, applied COLLINEARLY. A real crack tip carries
      // a stress singularity that a coarse spring lattice cannot resolve, so
      // the continuation of an existing fissure gets an explicit advantage when
      // choosing what fails next. Restricting it to the collinear neighbour is
      // what turns scattered dashes into continuous fissures - a bonus for any
      // spring merely touching a crack just widens the crack sideways instead.
      const kind = springKind[e];
      const r = springRow[e];
      const c = springCol[e];
      let tip = 0;
      if (kind === 0) {
        const up = r > 0 ? hoopIdx[(r - 1) * cols + c] : -1;
        const dn = r < rows - 1 ? hoopIdx[(r + 1) * cols + c] : -1;
        if ((up >= 0 && broken[up]) || (dn >= 0 && broken[dn])) tip = 1;
      } else if (kind === 1) {
        const lf = axialIdx[r * cols + ((c - 1 + cols) % cols)];
        const rt = axialIdx[r * cols + ((c + 1) % cols)];
        if ((lf >= 0 && broken[lf]) || (rt >= 0 && broken[rt])) tip = 1;
      }
      if (tip) ex += O.tipConcentration * O.strainLimit;
      excess[e] = ex;
      if (ex > maxEx) maxEx = ex;
    }
    if (maxEx <= 0) return 0;
    // Only a small budget of the worst-loaded springs gives way each pass; the
    // sheet then relaxes, which concentrates stress at the crack TIPS. Breaking
    // everything over threshold at once nucleates pits all over instead of
    // propagating lines. The cut is picked with a histogram so this stays O(m).
    const budget = Math.max(8, Math.round(m * O.breakRate));
    const BINS = 64;
    const hist = new Int32Array(BINS + 1);
    for (let e = 0; e < m; e++) {
      if (excess[e] <= 0) continue;
      hist[Math.min(BINS, Math.floor((excess[e] / maxEx) * BINS))]++;
    }
    let acc = 0;
    let bin = BINS;
    for (; bin >= 0; bin--) {
      acc += hist[bin];
      if (acc >= budget) break;
    }
    const cut = Math.max(1e-12, (Math.max(bin, 0) / BINS) * maxEx);
    let count = 0;
    for (let e = 0; e < m; e++) {
      if (!broken[e] && excess[e] >= cut && excess[e] > 0) {
        broken[e] = 1;
        if (axialFrac[e] < 0.25) hoopBrokenCount++;
        atCrack[sa[e]] = 1;
        atCrack[sb[e]] = 1;
        count++;
        // stop the instant the pattern has the requested fissure density
        if (hoopBrokenCount >= hoopTarget) return count;
      }
    }
    return count;
  };

  // How many fissures should end up around the stem: one every `ridgeWidth`.
  // Fragmentation saturates as the stem keeps growing, so instead of guessing a
  // growth factor we keep growing until the pattern has the requested density
  // (bark pattern really does depend on how much girth the tree has added since
  // the periderm formed) and stop there.
  let wCur = 2 * Math.PI * rMean;
  let gr = 1;
  let density = 0;
  let steps = 0;
  for (let step = 1; step <= O.steps; step++) {
    steps = step;
    gr = 1 + (O.growth - 1) * (step / O.steps);
    const gl = 1 + (gr - 1) * O.reticulation;
    for (let i = 0; i < n; i++) {
      ax[i] = x0[i] * gr;
      ay[i] = y0[i] * gl;
    }
    wCur = 2 * Math.PI * rMean * gr;
    let stop = false;
    for (let cyc = 0; cyc < O.ruptureCycles; cyc++) {
      relax(O.relaxIters, wCur);
      const broke = rupture(wCur);
      if (hoopBrokenCount >= hoopTarget) { stop = true; break; }
      if (!broke) break;
    }
    density = hoopBrokenCount / Math.max(hoopTotal, 1);
    if (stop) break;
  }
  relax(O.relaxIters * 4, wCur); // settle: plates drift apart, furrows open

  // Bridge single-row gaps in a fissure: the crack physically runs through, the
  // discrete lattice just did not register that one spring. Without this the
  // furrows come out as dashed strokes instead of continuous grooves.
  {
    const hoopAt = new Int32Array(rows * cols).fill(-1);
    for (let e = 0; e < m; e++) {
      if (axialFrac[e] > 0.25) continue;
      const i = sa[e];
      hoopAt[i] = e;
    }
    for (let r = 1; r < rows - 1; r++)
      for (let c = 0; c < cols; c++) {
        const here = hoopAt[r * cols + c];
        if (here < 0 || broken[here]) continue;
        const up = hoopAt[(r - 1) * cols + c];
        const dn = hoopAt[(r + 1) * cols + c];
        if (up >= 0 && dn >= 0 && broken[up] && broken[dn]) broken[here] = 1;
      }
  }

  // Drop isolated single-cell breaks: a fissure is a line, and a lone broken
  // spring just leaves a nick in the surface.
  {
    const hoopAt = new Int32Array(rows * cols).fill(-1);
    for (let e = 0; e < m; e++) if (springKind[e] === 0) hoopAt[springRow[e] * cols + springCol[e]] = e;
    const drop = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const e = hoopAt[r * cols + c];
        if (e < 0 || !broken[e]) continue;
        const up = r > 0 ? hoopAt[(r - 1) * cols + c] : -1;
        const dn = r < rows - 1 ? hoopAt[(r + 1) * cols + c] : -1;
        const linked = (up >= 0 && broken[up]) || (dn >= 0 && broken[dn]);
        if (!linked) drop.push(e);
      }
    for (const e of drop) broken[e] = 0;
  }

  // ---- extract the fissure network as line segments in the unrolled plane
  const segs = [];
  let hoopBroken = 0;
  let axialBroken = 0;
  const wRest = 2 * Math.PI * rMean;
  for (let e = 0; e < m; e++) {
    if (!broken[e]) continue;
    if (axialFrac[e] > 0.7) axialBroken++; else hoopBroken++;
    const i = sa[e];
    const j = sb[e];
    // A broken spring means the material parted ACROSS it, so the fissure runs
    // perpendicular to the spring, through its midpoint.
    const dx = dxWrap(x0[i], x0[j], wRest);
    const dy = y0[j] - y0[i];
    const mx = x0[i] + dx * 0.5;
    const my = y0[i] + dy * 0.5;
    const len = Math.hypot(dx, dy) || 1e-9;
    const nx = -dy / len;
    const ny = dx / len;
    const half = len * 0.62; // slight overlap so consecutive breaks join up
    const gap = Math.max(
      0,
      Math.hypot(dxWrap(px[i], px[j], wCur), py[j] - py[i]) - restArr[e]
    );
    segs.push({
      x1: mx - nx * half, y1: my - ny * half,
      x2: mx + nx * half, y2: my + ny * half,
      open: gap,
    });
  }

  return {
    rows, cols, spacing, rowR, rowY, segs, width: wRest, total: fr.total, rMean,
    stats: {
      latticeNodes: n, springs: m, brokenSprings: hoopBroken + axialBroken,
      brokenHoop: hoopBroken, brokenAxial: axialBroken, bondK: ka, latticeSpacing: spacing,
      hoopCrackFrac: density, targetFrac, growthUsed: gr, growthSteps: steps,
    },
  };
}

export const _fractureLattice2D = fractureLattice2D;
export const _trunkFrames = (skel, path) => trunkFrames(skel, path);

/**
 * Spatial index over the fissure segments in the unrolled (u, v) plane, with
 * wrap-around in u. Sampling gives the true distance to the nearest fissure, so
 * furrow width and profile are independent of the simulation lattice.
 */
function buildSegmentIndex(field, cellSize) {
  const w = field.width;
  const h = field.total;
  const nx = Math.max(1, Math.ceil(w / cellSize));
  const ny = Math.max(1, Math.ceil(h / cellSize));
  const cells = Array.from({ length: nx * ny }, () => []);
  const put = (ix, iy, k) => {
    const cx = ((ix % nx) + nx) % nx;
    if (iy < 0 || iy >= ny) return;
    cells[iy * nx + cx].push(k);
  };
  field.segs.forEach((sg, k) => {
    const x0 = Math.min(sg.x1, sg.x2);
    const x1 = Math.max(sg.x1, sg.x2);
    const y0 = Math.min(sg.y1, sg.y2);
    const y1 = Math.max(sg.y1, sg.y2);
    for (let ix = Math.floor(x0 / cellSize); ix <= Math.floor(x1 / cellSize); ix++)
      for (let iy = Math.floor(y0 / cellSize); iy <= Math.floor(y1 / cellSize); iy++) put(ix, iy, k);
  });
  return { cells, nx, ny, cellSize, w, h };
}

function segDistance(idx, segs, u, v, radius) {
  const r = Math.max(1, Math.ceil(radius / idx.cellSize));
  const cx = Math.floor(u / idx.cellSize);
  const cy = Math.floor(v / idx.cellSize);
  let best = radius;
  let open = 0;
  for (let dy = -r; dy <= r; dy++) {
    const iy = cy + dy;
    if (iy < 0 || iy >= idx.ny) continue;
    for (let dx = -r; dx <= r; dx++) {
      const ix = (((cx + dx) % idx.nx) + idx.nx) % idx.nx;
      for (const k of idx.cells[iy * idx.nx + ix]) {
        const sg = segs[k];
        // shortest wrap-aware offset to the segment's frame
        let ax = sg.x1 - u;
        while (ax > idx.w * 0.5) ax -= idx.w;
        while (ax < -idx.w * 0.5) ax += idx.w;
        let bx = sg.x2 - u;
        while (bx > idx.w * 0.5) bx -= idx.w;
        while (bx < -idx.w * 0.5) bx += idx.w;
        const ay = sg.y1 - v;
        const by = sg.y2 - v;
        const ex = bx - ax;
        const ey = by - ay;
        const len2 = ex * ex + ey * ey || 1e-12;
        let t = -(ax * ex + ay * ey) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + ex * t;
        const qy = ay + ey * t;
        const d = Math.hypot(qx, qy);
        if (d < best) { best = d; open = sg.open; }
      }
    }
  }
  return { d: best, o: open };
}

/* ----------------------------------------------------------- displacement */

function vertexNormals(mesh) {
  const N = mesh.positions.map(() => [0, 0, 0]);
  for (const f of mesh.faces) {
    const p = f.map((i) => mesh.positions[i]);
    const n = V.cross(V.sub(p[2], p[0]), V.sub(p[3], p[1])); // quad diagonal normal
    for (const i of f) N[i] = V.add(N[i], n);
  }
  return N.map((n) => (V.len(n) > 1e-12 ? V.norm(n) : [0, 1, 0]));
}

function hash3(x, y, z) {
  let h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
function valueNoise(p, f) {
  const x = p[0] * f; const y = p[1] * f; const z = p[2] * f;
  const xi = Math.floor(x); const yi = Math.floor(y); const zi = Math.floor(z);
  const xf = x - xi; const yf = y - yi; const zf = z - zi;
  const s = (t) => t * t * (3 - 2 * t);
  const u = s(xf); const v = s(yf); const w = s(zf);
  let acc = 0;
  for (let i = 0; i < 2; i++)
    for (let j = 0; j < 2; j++)
      for (let k = 0; k < 2; k++) {
        const wgt = (i ? u : 1 - u) * (j ? v : 1 - v) * (k ? w : 1 - w);
        acc += wgt * hash3(xi + i, yi + j, zi + k);
      }
  return acc * 2 - 1;
}

/**
 * Grow bark on the trunk of an already skinned tree.
 * @returns {{mesh: QuadMesh, stats: object}}
 */
export function growBark(mesh, skel, opts = {}) {
  const O = { ...BARK_DEFAULTS, ...opts };
  // a V-groove needs ~4 quads across it, so the mesh has to resolve ridge/10
  if (!O.barkResolution) O.barkResolution = O.ridgeWidth / 10;
  const t0 = Date.now();

  const { path, inPath } = trunkPath(skel, O.minRadiusRatio);
  if (path.length < 2) return { mesh, stats: { skipped: 'no trunk' } };
  const fr = trunkFrames(skel, path);

  // ---- 1. select + refine the trunk region
  let sel = selectTrunkFaces(mesh, skel, inPath, fr, O);
  if (!sel.size) return { mesh, stats: { skipped: 'no trunk faces' } };

  // refine until the quads on the trunk are about `barkResolution` across.
  // Anisotropic splits keep the quads square instead of over-refining the
  // direction that is already fine, which is a ~10x saving in face count.
  // Refine ACROSS the stem only. An edge split propagates along its whole edge
  // ring: for axis-parallel edges that ring wraps around the trunk and stays
  // inside the region, so this is free of the sliver band that vertical
  // refinement drags through the rest of the tree. It is also the direction
  // that matters - the fissures run lengthwise, so it is the circumferential
  // resolution that decides how crisp they are.
  // An edge split propagates along its whole edge ring (a lone hanging node
  // cannot be resolved with quads), so every level drags a band of surrounding
  // faces in. Refining a set EXPANDED by one ring each level means those faces
  // are split in both directions and stay square instead of degenerating into
  // slivers; the bark itself is re-selected geometrically afterwards.
  let out = mesh;
  let work = expandSelection(mesh, sel, 1);
  let levels = 0;
  while (levels < O.barkMaxLevels) {
    if (regionMaxEdge(out, sel) <= O.barkResolution * 1.45) break;
    if (out.faces.length * 2.5 > O.faceBudget) break;
    const r = refineRegion(out, work, { aniso: 1.4 });
    out = r.mesh;
    work = expandSelection(out, r.selection, 1);
    levels++;
    sel = selectTrunkFaces(out, skel, inPath, fr, O);
  }
  let faces = sel;
  // The fissure spacing must be something the mesh can actually resolve. A
  // furrow half-width narrower than one quad simply aliases away - the carve
  // happens but nothing is visible - so the ridges are widened to match the
  // grid we could afford, rather than silently producing a smooth trunk.
  // use the MEDIAN quad size: the max is skewed by the few big collar faces
  // around the branch attachments and would trigger a pointless widening
  const achieved = regionMedianEdge(out, faces);
  const minRidge = (achieved * 1.4) / Math.max(O.furrowWidth, 0.05);
  const underResolved = O.ridgeWidth < minRidge;
  if (underResolved && O.autoRidge) O.ridgeWidth = minRidge;
  const ridgeUsed = O.ridgeWidth;
  // the cage cross-section is a square: round it off before carving bark into it
  smoothRegion(out, faces, O.smoothPasses ?? 6, 0.55);

  // region vertex set, and which ones sit on its boundary (for the fade)
  const verts = new Set();
  for (const fi of faces) for (const v of out.faces[fi]) verts.add(v);
  const inner = new Map();
  for (const fi of faces) for (const v of out.faces[fi]) inner.set(v, (inner.get(v) || 0) + 1);
  const boundary = new Set();
  out.faces.forEach((f, fi) => {
    if (faces.has(fi)) return;
    for (const v of f) if (verts.has(v)) boundary.add(v);
  });

  // ---- 2. fracture simulation on the unrolled trunk
  const field = fractureLattice2D(fr, O);
  const halfW = O.furrowWidth * O.ridgeWidth;
  const searchR = O.ridgeWidth * 1.6;
  const index = buildSegmentIndex(field, Math.max(searchR, field.spacing));

  // ---- 3. carve the fissure network into the mesh along the vertex normals
  const normals = vertexNormals(out);
  const openRef = Math.max(O.ridgeWidth * 0.05, 1e-6);
  let maxCarve = 0;
  let carved = 0;
  let dbgSum = 0;
  let dbgSq = 0;
  let dbgNear = 0;

  // stable angular reference, parallel-transported up the stem
  const refU = [];
  {
    let u = V.orthoNorm([1, 0, 0], fr.tan[0]);
    refU.push(u);
    for (let i = 1; i < fr.tan.length; i++) {
      u = V.orthoNorm(V.rotateFromTo(u, fr.tan[i - 1], fr.tan[i]), fr.tan[i]);
      refU.push(u);
    }
  }

  const warpAmp = O.warp * O.ridgeWidth;
  const warpFreq = 1 / Math.max(O.ridgeWidth * 6, 1e-4);

  for (const vid of verts) {
    const p = out.positions[vid];
    const pr = projectToAxis(fr, p);
    let seg = 0;
    for (let i = 0; i < fr.arc.length - 1; i++) if (fr.arc[i] <= pr.s) seg = i;
    const uAxis = V.orthoNorm(refU[seg], pr.dir);
    const wAxis = V.cross(pr.dir, uAxis);
    const theta = Math.atan2(V.dot(pr.radial, wAxis), V.dot(pr.radial, uAxis)) + Math.PI;

    // unrolled coordinates, warped so the fissures wander instead of following
    // the simulation lattice
    let u = (theta / (2 * Math.PI)) * field.width;
    let v = pr.s;
    if (warpAmp > 0) {
      u += valueNoise([p[0], p[1] * 0.35, p[2]], warpFreq) * warpAmp;
      v += valueNoise([p[0] + 31.7, p[1] * 0.35, p[2] - 12.3], warpFreq) * warpAmp * 0.6;
      u = ((u % field.width) + field.width) % field.width;
      v = Math.max(0, Math.min(field.total, v));
    }
    const { d: dist, o: open } = segDistance(index, field.segs, u, v, searchR);

    const rLocal = Math.max(pr.rLocal, 1e-5);
    const depth = Math.min(O.furrowDepth * halfW, rLocal * 0.16);
    const openNorm = Math.min(1.5, open / openRef);
    const wCarve = halfW * (0.8 + 0.4 * openNorm);

    let disp;
    if (dist < wCarve) {
      // V-shaped fissure with flat-topped ridges ("grooves with width less than
      // the flat-topped ridges separating them" - macroscopic bark terminology)
      const t = dist / wCarve;
      disp = -depth * Math.pow(1 - t, 1.5) * Math.min(1, 0.5 + openNorm);
      carved++;
    } else {
      const t = Math.min(1, (dist - wCarve) / Math.max(wCarve * 1.5, 1e-6));
      disp = depth * O.ridgeRound * 0.35 * Math.sin(Math.PI * t);
    }
    // fibrous grain, stretched along the stem
    const g =
      valueNoise([p[0], p[1] * 0.25, p[2]], 2.4 / Math.max(O.ridgeWidth, 1e-4)) * 0.7 +
      valueNoise([p[0], p[1] * 0.4, p[2]], 6.0 / Math.max(O.ridgeWidth, 1e-4)) * 0.3;
    disp += g * depth * O.grain;

    let fade = 1;
    if (boundary.has(vid)) fade = 0;
    else if ((inner.get(vid) || 0) < 4) fade = 0.4;
    const thin = Math.min(1, Math.max(0, (rLocal / (skel.nodes[0].r * O.minRadiusRatio) - 1) * 1.6));
    disp *= fade * thin;

    const nrm = normals[vid];
    out.positions[vid] = [p[0] + nrm[0] * disp, p[1] + nrm[1] * disp, p[2] + nrm[2] * disp];
    maxCarve = Math.max(maxCarve, Math.abs(disp));
    dbgSum += disp;
    dbgSq += disp * disp;
    if (dist < searchR * 0.999) dbgNear++;
  }

  // quality inside the bark patch itself, separately from the transition band
  // that conforming all-quad refinement leaves in the surrounding mesh
  let inAspect = 0;
  let inSlivers = 0;
  for (const fi of faces) {
    const f = out.faces[fi];
    const e = [
      V.dist(out.positions[f[0]], out.positions[f[1]]),
      V.dist(out.positions[f[1]], out.positions[f[2]]),
      V.dist(out.positions[f[2]], out.positions[f[3]]),
      V.dist(out.positions[f[3]], out.positions[f[0]]),
    ];
    const a = Math.max(...e) / Math.max(Math.min(...e), 1e-9);
    inAspect = Math.max(inAspect, a);
    if (a > 10) inSlivers++;
  }

  return {
    mesh: out,
    stats: {
      barkPatchMaxAspect: inAspect,
      barkPatchSlivers: inSlivers,
      trunkNodes: path.length,
      refineLevels: levels,
      regionFaces: faces.size,
      regionVerts: verts.size,
      ridgeWidth: ridgeUsed,
      ridgeRequested: (opts.ridgeWidth ?? BARK_DEFAULTS.ridgeWidth),
      hoopResolution: achieved,
      underResolved,
      carvedVerts: carved,
      maxCarve,
      meanCarve: dbgSum / Math.max(verts.size, 1),
      rmsCarve: Math.sqrt(dbgSq / Math.max(verts.size, 1)),
      vertsNearACrack: dbgNear,
      ...field.stats,
      ms: Date.now() - t0,
    },
  };
}
