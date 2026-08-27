#!/usr/bin/env node
// Headless generate + topology audit + OBJ export.
//   node scripts/validate.mjs [--seed N] [--subdiv N] [--out file.obj] [--sweep]

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateSkeleton, skeletonStats } from '../src/core/skeleton.js';
import { skinSkeleton } from '../src/core/skin.js';

const args = process.argv.slice(2);
const arg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};

function run(seed, subdiv, params = {}) {
  const skel = generateSkeleton({ seed, ...params });
  const { mesh } = skinSkeleton(skel);
  const cage = mesh.validate();
  const sub = subdiv > 0 ? mesh.subdivide(subdiv) : mesh;
  const fine = sub.validate();
  return { skel, mesh, sub, cage, fine };
}

const seed = Number(arg('--seed', 7));
const subdiv = Number(arg('--subdiv', 2));

if (args.includes('--sweep')) {
  let bad = 0;
  console.log('seed  skelV  cageV  cageF  quads watertight single  poles');
  for (let s = 1; s <= 40; s++) {
    const { mesh, cage } = run(s, 0);
    const hist = mesh.valenceHistogram();
    const poles = Object.entries(hist).filter(([k]) => Number(k) !== 4)
      .reduce((a, [, v]) => a + v, 0);
    const ok = cage.watertight && cage.singleMesh && cage.quadsOnly && cage.looseVertices === 0;
    if (!ok) bad++;
    console.log(
      String(s).padStart(4),
      String(cage.vertices).padStart(6),
      String(cage.vertices).padStart(6),
      String(cage.faces).padStart(6),
      String(cage.quadsOnly).padStart(6),
      String(cage.watertight).padStart(10),
      String(cage.singleMesh).padStart(6),
      String(poles).padStart(6),
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
    const { cage: c } = run(Math.floor(rnd(1, 9999)), 0, p);
    const ok = c.watertight && c.singleMesh && c.quadsOnly && c.looseVertices === 0 && c.genus === 0;
    if (!ok) { bad++; console.log('FAIL', JSON.stringify(p), c); }
    else console.log(`ok  lv${p.levels} ch${p.childrenPerBranch} sp${p.splitCount} -> ${c.faces} quads, 1 shell, chi=${c.euler}`);
  }
  console.log(bad === 0 ? '\nSTRESS PASS (30/30)' : `\n${bad}/30 FAILED`);
  process.exit(bad ? 1 : 0);
}

const { skel, mesh, sub, cage, fine } = run(seed, subdiv);
console.log('skeleton :', skeletonStats(skel));
console.log('cage     :', cage);
console.log('valence  :', mesh.valenceHistogram());
console.log(`subdiv x${subdiv}:`, fine);

const out = arg('--out', '');
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, sub.toOBJ(`tree_seed${seed}`));
  console.log('wrote', out);
}
