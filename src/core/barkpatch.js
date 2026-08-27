// BARK PATCH - a flat test slab of plated/scaly bark.
//
// Geometry only: the relief comes from a hierarchical crack network
// (src/core/crackpattern.js), not from noise and not from a texture.
//
// What the reference photographs of platy bark (Platanus, Pinus, Ekebergia)
// actually show, and what this builds:
//
//   * SCALES bounded by a crack network whose junctions are mostly T-shaped,
//     with curved edges and a narrow size distribution - the signature of
//     sequential fracture rather than a Voronoi tessellation;
//   * each scale sits at its own height and angle and is slightly convex,
//     thinning towards its edges where it drops into the fissure;
//   * some scales have SHED. Platy bark is exfoliating bark: scales detach
//     along the periderm and leave "scars of fallen scales" exposing a fresher,
//     paler layer underneath (Priorities for Bark Anatomical Research, 2023;
//     Meliaceae bark study, Trees 2025). Those are the light patches in the
//     photographs, and they are modelled as a second, lower surface rather
//     than as a colour;
//   * a finer, second-generation crack network crazes the surface of the
//     scales themselves.
//
// The slab is a closed all-quad solid so it can be exported and inspected like
// any other mesh.

import { QuadMesh } from './quadmesh.js';
import { crackPattern, CRACK_DEFAULTS } from './crackpattern.js';
import { makeRng } from './rng.js';

export const PATCH_DEFAULTS = {
  patchSize: 1.0,        // world size of the square patch
  patchRes: 240,         // quads across the patch
  scaleSize: 0.09,       // characteristic scale size, fraction of the patch
  sizeSpread: 0.45,
  anisotropy: 1.0,       // >1 elongates the scales
  wander: 0.6,           // how much the fissures meander
  fissureWidth: 0.15,    // fissure width, as a fraction of a scale
  fissureDepth: 0.95,    // fissure depth, as a fraction of scale thickness
  scaleThickness: 0.014, // how far a scale stands off the under-layer
  dome: 0.45,            // convexity of a scale
  lift: 0.45,            // scale-to-scale height variation
  tilt: 0.3,             // scale-to-scale tilt
  shed: 0.13,            // fraction of scales that have fallen off
  shedDepth: 0.6,        // how deep a shed scar sits, in scale thicknesses
  craze: 0.55,           // strength of the second-generation crazing
  crazeScale: 0.33,      // craze cell size, relative to a scale
  grain: 0.12,           // fine surface roughness
  slabDepth: 0.06,       // thickness of the slab under the bark
  seed: 3,
};

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

function hash2(x, y, s) {
  const h = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
function vnoise(x, y, s) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = smooth(xf);
  const v = smooth(yf);
  return (
    hash2(xi, yi, s) * (1 - u) * (1 - v) +
    hash2(xi + 1, yi, s) * u * (1 - v) +
    hash2(xi, yi + 1, s) * (1 - u) * v +
    hash2(xi + 1, yi + 1, s) * u * v
  ) * 2 - 1;
}

/**
 * @returns {{mesh: QuadMesh, colors: Float32Array, stats: object}}
 */
export function buildBarkPatch(opts = {}) {
  const O = { ...PATCH_DEFAULTS, ...opts };
  const t0 = Date.now();
  const S = O.patchSize;
  const n = Math.max(16, Math.round(O.patchRes));
  const rnd = makeRng(O.seed * 31 + 7);

  // ---- the fracture network that defines the scales
  const field = crackPattern({
    ...CRACK_DEFAULTS,
    seed: O.seed,
    res: Math.min(512, Math.max(160, Math.round(n * 1.1))),
    cellSize: O.scaleSize,
    sizeSpread: O.sizeSpread,
    anisotropy: O.anisotropy,
    wander: O.wander,
  });
  // ---- a second generation, one order finer, crazing the scale surfaces
  const craze = O.craze > 0
    ? crackPattern({
        ...CRACK_DEFAULTS,
        seed: O.seed * 977 + 13,
        res: Math.min(512, Math.max(160, Math.round(n * 1.1))),
        cellSize: Math.max(0.02, O.scaleSize * O.crazeScale),
        sizeSpread: 0.6,
        wander: 0.4,
      })
    : null;

  const R = field.res;
  const pxToWorld = S / R;
  const scaleWorld = O.scaleSize * S;
  const fissureW = Math.max(O.fissureWidth * scaleWorld, pxToWorld * 1.2);
  const thick = O.scaleThickness * S;

  const sample = (fx, fy) => {
    const px = Math.max(0, Math.min(R - 1, Math.round(fx * (R - 1))));
    const py = Math.max(0, Math.min(R - 1, Math.round(fy * (R - 1))));
    return py * R + px;
  };

  // ---- height + colour of the bark surface at a normalised (u,v)
  const surface = (u, v) => {
    const p = sample(u, v);
    const id = field.cell[p];
    const c = field.byId.get(id);
    const d = field.dist[p] * pxToWorld; // distance to the nearest fissure

    // fissure floor
    const floor = -O.fissureDepth * thick;
    if (!c) return { h: floor, col: [0.16, 0.13, 0.11] };

    const shed = c.shed < O.shed;
    const x = (u - c.cx / R) * S;
    const y = (v - c.cy / R) * S;

    let top;
    let col;
    if (shed) {
      // scar of a fallen scale: a lower, flatter, paler surface
      const scar = -O.shedDepth * thick;
      const rough = vnoise(u * 90, v * 90, O.seed + c.index) * 0.35 +
        vnoise(u * 220, v * 220, O.seed + 5) * 0.15;
      top = scar + rough * thick * 0.5 * O.grain * 4;
      const warm = 0.55 + 0.35 * c.tone;
      col = [0.34 + 0.20 * warm, 0.25 + 0.13 * warm, 0.18 + 0.07 * warm];
    } else {
      // an intact scale: convex, its own height and tilt
      const domeT = smooth(Math.min(1, d / (scaleWorld * 0.5)));
      top =
        thick +
        O.dome * thick * domeT +
        O.lift * thick * c.lift * domeT +
        O.tilt * thick * (c.tiltX * (x / scaleWorld) + c.tiltY * (y / scaleWorld)) * domeT;

      // second-generation crazing, only on the scale faces
      if (craze) {
        const cd = craze.dist[p] * pxToWorld;
        const cw = Math.max(scaleWorld * O.crazeScale * 0.18, pxToWorld * 1.2);
        if (cd < cw) top -= O.craze * thick * 0.45 * (1 - cd / cw) * domeT;
      }
      const g = vnoise(u * 130, v * 130, O.seed + c.index * 3) * 0.6 +
        vnoise(u * 320, v * 320, O.seed + 11) * 0.4;
      top += g * thick * O.grain * domeT;

      const grey = 0.46 + 0.22 * c.tone + 0.06 * g;
      col = [grey * 0.98, grey * 0.95, grey * 0.9];
    }

    // drop into the fissure
    const t = smooth(Math.min(1, d / fissureW));
    const h = floor + (top - floor) * t;
    const dark = 0.25 + 0.75 * t;
    return { h, col: [col[0] * dark, col[1] * dark, col[2] * dark] };
  };

  // ---- build a closed all-quad slab -------------------------------------
  const mesh = new QuadMesh();
  const colors = [];
  const topIdx = new Int32Array((n + 1) * (n + 1));
  const botIdx = new Int32Array((n + 1) * (n + 1));
  const bottomY = -O.slabDepth * S;

  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const v = j / n;
      const s = surface(u, v);
      const x = (u - 0.5) * S;
      const z = (v - 0.5) * S;
      topIdx[j * (n + 1) + i] = mesh.addVertex([x, s.h, z]);
      colors.push(s.col[0], s.col[1], s.col[2]);
      botIdx[j * (n + 1) + i] = mesh.addVertex([x, bottomY, z]);
      colors.push(0.12, 0.10, 0.09);
    }
  }
  const T = (i, j) => topIdx[j * (n + 1) + i];
  const B = (i, j) => botIdx[j * (n + 1) + i];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      mesh.addQuad(T(i, j), T(i, j + 1), T(i + 1, j + 1), T(i + 1, j), 'bark');
      mesh.addQuad(B(i, j), B(i + 1, j), B(i + 1, j + 1), B(i, j + 1), 'slab');
    }
  for (let i = 0; i < n; i++) {
    mesh.addQuad(T(i, 0), T(i + 1, 0), B(i + 1, 0), B(i, 0), 'slab');
    mesh.addQuad(T(i + 1, n), T(i, n), B(i, n), B(i + 1, n), 'slab');
    mesh.addQuad(T(0, i + 1), T(0, i), B(0, i), B(0, i + 1), 'slab');
    mesh.addQuad(T(n, i), T(n, i + 1), B(n, i + 1), B(n, i), 'slab');
  }

  const shedCount = field.cells.filter((c) => c.shed < O.shed).length;
  return {
    mesh,
    colors: Float32Array.from(colors),
    stats: {
      scales: field.cells.length,
      shedScales: shedCount,
      junctions: field.junctions,
      rasterRes: R,
      quads: mesh.faces.length,
      scaleSizeWorld: scaleWorld,
      ms: Date.now() - t0,
    },
  };
}
