#!/usr/bin/env node
// Headless generate + topology audit + OBJ export.
//   node scripts/validate.mjs [--seed N] [--subdiv N] [--out file.obj] [--sweep]

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateSkeleton, skeletonStats } from '../src/core/skeleton.js';
import { skinSkeleton } from '../src/core/skin.js';
import { growBark } from '../src/core/bark.js';

const args = process.argv.slice(2);
const arg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};

function run(seed, subdiv, params = {}) {
  const skel = generateSkeleton({ seed, ...params });
  const skin = skinSkeleton(skel);
  const mesh = skin.mesh;
  const cage = mesh.validate();
  const quality = mesh.geometryQuality();
  const sub = subdiv > 0 ? mesh.subdivide(subdiv) : mesh;
  const fine = sub.validate();
  return { skel, mesh, sub, cage, fine, quality, skin };
}

const passes = (c, q, skel, skin) =>
  c.watertight && c.singleMesh && c.quadsOnly && c.looseVertices === 0 && c.genus === 0 &&
  q.pinched === 0 && q.maxAspect < 25 &&
  skel.overlap.pairs === 0 && skin.backwardSockets === 0;

const seed = Number(arg('--seed', 7));
const subdiv = Number(arg('--subdiv', 2));

if (args.includes('--sweep')) {
  let bad = 0;
  console.log('seed   cageV  cageF shells open flip  aspect sliv pinch overlap twist');
  for (let s = 1; s <= 40; s++) {
    const { cage, quality, skel, skin } = run(s, 0);
    const ok = passes(cage, quality, skel, skin);
    if (!ok) bad++;
    console.log(
      String(s).padStart(4),
      String(cage.vertices).padStart(7),
      String(cage.faces).padStart(7),
      String(cage.shells).padStart(6),
      String(cage.boundaryEdges).padStart(5),
      String(cage.flippedEdges).padStart(4),
      quality.maxAspect.toFixed(1).padStart(7),
      String(quality.slivers).padStart(5),
      String(quality.pinched).padStart(5),
      String(skel.overlap.pairs).padStart(7),
      String(skin.backwardSockets).padStart(5),
      ok ? '' : '  <-- FAIL'
    );
  }
  console.log(bad === 0 ? '\nALL SEEDS PASS' : `\n${bad} FAILING SEEDS`);
  process.exit(bad === 0 ? 0 : 1);
}

if (args.includes('--stress')) {
  // randomized parameter fuzzing: topology must survive any settings
  const rnd = (a, b) => a + Math.random() * (b - a);
  let bad = 0;
  for (let i = 0; i < 30; i++) {
    const p = {
      levels: Math.floor(rnd(0, 6)),
      trunkHeight: rnd(1, 10),
      trunkRadius: rnd(0.06, 1.0),
      segmentsPerBranch: Math.floor(rnd(2, 10)),
      childrenPerBranch: Math.floor(rnd(0, 6)),
      splitCount: Math.floor(rnd(0, 4)),
      branchAngle: rnd(5, 88),
      angleVariance: rnd(0, 35),
      lengthFalloff: rnd(0.35, 0.98),
      radiusFalloff: rnd(0.35, 0.94),
      curl: rnd(0, 0.7),
      gravitropism: rnd(-0.35, 0.5),
      taper: rnd(0.25, 1),
      minRadius: rnd(0.008, 0.12),
      maxVertices: 6000,
    };
    const { cage: c, quality: q, skel: sk, skin: sn } = run(Math.floor(rnd(1, 9999)), 0, p);
    const ok = passes(c, q, sk, sn);
    if (!ok) {
      bad++;
      const why = [];
      if (!c.watertight) why.push('open/nonmanifold');
      if (!c.singleMesh) why.push(`shells=${c.shells}`);
      if (!c.quadsOnly) why.push('non-quad');
      if (c.genus !== 0) why.push(`genus=${c.genus}`);
      if (q.pinched) why.push(`pinched=${q.pinched}`);
      if (q.slivers) why.push(`slivers=${q.slivers} maxAspect=${q.maxAspect.toFixed(1)}`);
      if (q.maxAspect >= 12) why.push(`aspect=${q.maxAspect.toFixed(1)}`);
      if (sk.overlap.pairs) why.push(`overlaps=${sk.overlap.pairs} pen=${sk.overlap.worstPenetration.toFixed(2)}`);
      if (sn.backwardSockets) why.push(`twistedSockets=${sn.backwardSockets}`);
      console.log('FAIL', why.join(', '), '| faces', c.faces, '| lv', p.levels, 'trunkR', p.trunkRadius.toFixed(2), 'minR', p.minRadius.toFixed(3), 'ang', p.branchAngle.toFixed(0));
    }
    else console.log(`ok  lv${p.levels} ch${p.childrenPerBranch} sp${p.splitCount} -> ${c.faces} quads, 1 shell, chi=${c.euler}, aspect ${q.maxAspect.toFixed(1)}, 0 overlaps`);
  }
  console.log(bad === 0 ? '\nSTRESS PASS (30/30)' : `\n${bad}/30 FAILED`);
  process.exit(bad ? 1 : 0);
}

if (args.includes('--bark')) {
  // bark audit: topology must survive local refinement + displacement
  const skel = generateSkeleton({ seed });
  const { mesh } = skinSkeleton(skel);
  const base = subdiv > 0 ? mesh.subdivide(subdiv) : mesh;
  const t = Date.now();
  const r = growBark(base, skel, JSON.parse(arg('--barkopts', '{}')));
  const v = r.mesh.validate();
  const q = r.mesh.geometryQuality();
  console.log('bark     :', r.stats);
  console.log('topology :', v);
  console.log('quality  :', q);
  const ok = v.watertight && v.singleMesh && v.quadsOnly && v.genus === 0 && q.pinched === 0;
  console.log(ok ? 'BARK TOPOLOGY PASS' : 'BARK TOPOLOGY FAIL');
  const out = arg('--out', '');
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, r.mesh.toOBJ(`bark_seed${seed}`));
    console.log('wrote', out);
  }
  process.exit(ok ? 0 : 1);
}

const { skel, mesh, sub, cage, fine, quality } = run(seed, subdiv);
console.log('skeleton :', skeletonStats(skel));
console.log('cage     :', cage);
console.log('quality  :', quality);
console.log('overlaps :', skel.overlap, skel.collisions);
console.log('valence  :', mesh.valenceHistogram());
console.log(`subdiv x${subdiv}:`, fine);

const out = arg('--out', '');
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, sub.toOBJ(`tree_seed${seed}`));
  console.log('wrote', out);
}
