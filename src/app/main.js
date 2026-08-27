// surface any runtime error in the HUD instead of failing to a black screen
addEventListener('error', (e) => {
  const hud = document.getElementById('hud');
  if (hud) hud.textContent = `error: ${e.message}`;
});

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { generateSkeleton, DEFAULTS, orderByGrowth, skeletonStats } from '../core/skeleton.js';
import { skinSkeleton, SKIN_DEFAULTS } from '../core/skin.js';
import { growBark, BARK_DEFAULTS } from '../core/bark.js';

// ---------------------------------------------------------------- parameters
const shapeSpec = [
  ['seed', 1, 9999, 1],
  ['levels', 0, 6, 1],
  ['trunkHeight', 1, 12, 0.1],
  ['segmentsPerBranch', 2, 12, 1],
  ['childrenPerBranch', 0, 6, 1],
  ['splitCount', 0, 4, 1],
  ['branchAngle', 5, 90, 1],
  ['angleVariance', 0, 40, 1],
  ['branchStart', 0, 0.9, 0.01],
  ['lengthFalloff', 0.3, 1.0, 0.01],
  ['curl', 0, 0.8, 0.01],
  ['gravitropism', -0.4, 0.6, 0.01],
  ['phyllotaxis', 60, 180, 0.5],
  ['collisionClearance', 1.0, 2.0, 0.02],
];
// da Vinci / pipe-model thickness controls
const woodSpec = [
  ['trunkRadius', 0.05, 1.2, 0.01],
  ['pipeExponent', 1.4, 3.0, 0.05],
  ['taperRate', 0, 0.6, 0.01],
  ['collarFlare', 0, 1.0, 0.02],
  ['collarLength', 0.5, 6, 0.1],
  ['rootFlare', 0, 1.2, 0.02],
  ['rootFlareLength', 1, 12, 0.5],
  ['radiusJitter', 0, 0.3, 0.01],
  ['radiusFalloff', 0.3, 0.95, 0.01],
];
const skinSpec = [
  ['subdivisions', 0, 3, 1],
  ['radiusCompensation', 0.6, 2.0, 0.02],
  ['hubScale', 0.6, 2.0, 0.02],
  ['socketReach', 1.0, 3.0, 0.05],
  ['loopSpacing', 0.6, 6, 0.1],
  ['maxTurn', 3, 45, 1],
  ['tipTaper', 0.05, 1.0, 0.01],
  ['hubFit', 0, 1, 0.05],
];

const barkSpec = [
  ['ridgeWidth', 0.02, 0.3, 0.005],
  ['furrowDepth', 0.3, 2.5, 0.05],
  ['furrowWidth', 0.1, 0.5, 0.01],
  ['growth', 1.05, 2.5, 0.05],
  ['reticulation', 0, 0.6, 0.01],
  ['fibreStrength', 0, 8, 0.1],
  ['grain', 0, 0.8, 0.02],
  ['warp', 0, 1.2, 0.05],
  ['minRadiusRatio', 0.1, 0.9, 0.02],
  ['barkMaxLevels', 2, 6, 1],
];

const params = { ...DEFAULTS, ...SKIN_DEFAULTS, ...BARK_DEFAULTS, subdivisions: 1 };
const sliders = {};

function buildControls(host, spec) {
  for (const [key, min, max, step] of spec) {
    const wrap = document.createElement('div');
    wrap.className = 'ctrl';
    wrap.innerHTML = `<div class="lbl"><span>${key.replace(/([A-Z])/g, ' $1').toLowerCase()}</span><b>${params[key]}</b></div>`;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step; input.value = params[key];
    const out = wrap.querySelector('b');
    if (spec === barkSpec) {
      input.addEventListener('input', () => { barkStale = true; });
      wrap.appendChild(input);
      host.appendChild(wrap);
      sliders[key] = { input, out };
      continue;
    }
    const isSkinOnly = spec === skinSpec;
    input.addEventListener('input', () => {
      params[key] = parseFloat(input.value);
      out.textContent = params[key];
      onParamChanged(isSkinOnly);
    });
    input.addEventListener('change', () => onParamSettled());
    wrap.appendChild(input);
    host.appendChild(wrap);
    sliders[key] = { input, out };
  }
}
buildControls(document.getElementById('treeControls'), shapeSpec);
buildControls(document.getElementById('woodControls'), woodSpec);
buildControls(document.getElementById('skinControls'), skinSpec);
buildControls(document.getElementById('barkControls'), barkSpec);

// ---------------------------------------------------------------- three setup
const view = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1015);
scene.fog = new THREE.Fog(0x0d1015, 34, 95);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 500);
camera.position.set(7, 5, 9);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 3, 0);

scene.add(new THREE.HemisphereLight(0xbcd8ff, 0x202020, 1.1));
const key = new THREE.DirectionalLight(0xfff0dd, 2.1);
key.position.set(6, 10, 6);
scene.add(key);
const rim = new THREE.DirectionalLight(0x66ffcc, 0.6);
rim.position.set(-7, 4, -5);
scene.add(rim);

const grid = new THREE.GridHelper(40, 40, 0x2a3442, 0x1a212b);
grid.material.transparent = true;
grid.material.opacity = 0.6;
scene.add(grid);

const skelGroup = new THREE.Group();
const skinGroup = new THREE.Group();
scene.add(skelGroup, skinGroup);

// ---------------------------------------------------------------- materials
const matPoints = new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, vertexColors: true });
const matBones = new THREE.LineBasicMaterial({ color: 0x3ad6a0, transparent: true, opacity: 0.85 });
const matHub = new THREE.LineBasicMaterial({ color: 0xffb454, transparent: true, opacity: 0.9 });
const matWire = new THREE.LineBasicMaterial({ color: 0x35ffc0, transparent: true, opacity: 0.55 });
const matSurf = new THREE.MeshStandardMaterial({ color: 0xb08a5e, roughness: 0.78, metalness: 0.02 });
const matCage = new THREE.MeshStandardMaterial({ color: 0x6f7f96, roughness: 0.9, flatShading: true });

// ---------------------------------------------------------------- state
let skel = null;
let cage = null;
let fine = null;
let skinned = null;
let objPoints, objBones, objHubs, objCage, objCageWire, objSkin, objSkinWire;
let growth = null;
let growT = 1;
let stage = 0;
let skinStale = true;
let barkStale = true;
let bark = null;
let objBark = null;
let barkStats = null;
let lastTimes = { skelMs: 0, skinMs: 0, subMs: 0 };
let previewOnly = false;

const skeletonOnly = () => stage < 2;
const BARK_STAGE = 5;

const stageButtons = [...document.querySelectorAll('#stages button')];
stageButtons.forEach((b) =>
  b.addEventListener('click', () => {
    const next = +b.dataset.stage;
    const wasSkeleton = skeletonOnly();
    stage = next;
    stageButtons.forEach((x) => x.classList.toggle('on', x === b));
    if (wasSkeleton && !skeletonOnly()) {
      if (previewOnly) buildSkeleton(false); // upgrade the quick preview first
      buildSkin();
    }
    if (stage === BARK_STAGE && (barkStale || !bark)) buildBark();
    if (stage <= 1) growT = Math.min(growT, 1);
    applyStage();
  })
);
document.getElementById('wire').addEventListener('change', applyStage);
document.getElementById('showSkel').addEventListener('change', applyStage);
document.getElementById('flat').addEventListener('change', (e) => {
  matSurf.flatShading = e.target.checked;
  matSurf.needsUpdate = true;
});
document.getElementById('grow').addEventListener('click', () => { growT = 0; });
document.getElementById('growBark').addEventListener('click', () => {
  stage = BARK_STAGE;
  stageButtons.forEach((x) => x.classList.toggle('on', +x.dataset.stage === BARK_STAGE));
  buildBark();
});
document.getElementById('reseed').addEventListener('click', () => {
  params.seed = 1 + Math.floor(Math.random() * 9999);
  sliders.seed.input.value = params.seed;
  sliders.seed.out.textContent = params.seed;
  growT = 0;
  rebuild(false);
});
document.getElementById('exportCage').addEventListener('click', () => {
  ensureSkin();
  download('cage.obj', cage.toOBJ('tree_cage'));
});
document.getElementById('exportSub').addEventListener('click', () => {
  if (stage === BARK_STAGE && bark && !barkStale) {
    download('bark.obj', bark.toOBJ('tree_bark'));
    return;
  }
  ensureSkin();
  download('skin.obj', fine.toOBJ('tree_skin'));
});

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------- geometry
function disposeGroup(g) {
  g.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  g.clear();
}

function meshGeometry(qm) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(qm.positions.length * 3);
  qm.positions.forEach((p, i) => { pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2]; });
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(qm.triangles(), 1));
  g.computeVertexNormals();
  return g;
}

function wireGeometry(qm) {
  const edges = qm.edges();
  const pos = new Float32Array(edges.length * 6);
  edges.forEach(([a, b], i) => {
    const A = qm.positions[a];
    const B = qm.positions[b];
    pos.set([A[0], A[1], A[2], B[0], B[1], B[2]], i * 6);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return g;
}

function hubGeometry(hubs) {
  const E = [[0,1],[1,3],[3,2],[2,0],[4,5],[5,7],[7,6],[6,4],[0,4],[1,5],[2,6],[3,7]];
  const pos = [];
  for (const h of hubs) {
    const [a0, a1, a2] = h.axes;
    const c = [];
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) {
      const s = [i * 2 - 1, j * 2 - 1, k * 2 - 1];
      c.push([
        h.center[0] + h.R * (a0[0] * s[0] + a1[0] * s[1] + a2[0] * s[2]),
        h.center[1] + h.R * (a0[1] * s[0] + a1[1] * s[1] + a2[1] * s[2]),
        h.center[2] + h.R * (a0[2] * s[0] + a1[2] * s[1] + a2[2] * s[2]),
      ]);
    }
    for (const [x, y] of E) pos.push(...c[x], ...c[y]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

/** Point cloud + bones, coloured and ordered for the growth animation. */
function skeletonObjects(sk) {
  const { order, dist, maxDist } = orderByGrowth(sk);
  const rank = new Int32Array(sk.nodes.length);
  order.forEach((n, i) => (rank[n] = i));

  const pos = new Float32Array(order.length * 3);
  const col = new Float32Array(order.length * 3);
  const c = new THREE.Color();
  order.forEach((n, i) => {
    const p = sk.nodes[n].p;
    pos.set(p, i * 3);
    const t = dist[n] / maxDist;
    c.setHSL(0.42 - 0.36 * t, 0.85, 0.45 + 0.2 * t);
    col.set([c.r, c.g, c.b], i * 3);
  });
  const gp = new THREE.BufferGeometry();
  gp.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  gp.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const points = new THREE.Points(gp, matPoints);
  points.frustumCulled = false;

  const bones = sk.bones.slice().sort(
    (a, b) => Math.max(rank[a[0]], rank[a[1]]) - Math.max(rank[b[0]], rank[b[1]])
  );
  const bp = new Float32Array(bones.length * 6);
  bones.forEach(([a, b], i) => {
    bp.set(sk.nodes[a].p, i * 6);
    bp.set(sk.nodes[b].p, i * 6 + 3);
  });
  const gb = new THREE.BufferGeometry();
  gb.setAttribute('position', new THREE.BufferAttribute(bp, 3));
  const lines = new THREE.LineSegments(gb, matBones);
  lines.frustumCulled = false;

  return { points, lines, count: order.length, boneCount: bones.length };
}

// ---------------------------------------------------------------- pipeline
const intParams = () => ({
  ...params,
  levels: Math.round(params.levels),
  segmentsPerBranch: Math.round(params.segmentsPerBranch),
  childrenPerBranch: Math.round(params.childrenPerBranch),
  splitCount: Math.round(params.splitCount),
  seed: Math.round(params.seed),
});

/** Stage 1-2: vertices + bones only. `quick` skips the overlap solver. */
function buildSkeleton(quick) {
  const t0 = performance.now();
  skel = generateSkeleton({ ...intParams(), skipCollisions: quick ? 1 : 0 });
  previewOnly = !!quick;
  lastTimes.skelMs = performance.now() - t0;

  disposeGroup(skelGroup);
  growth = skeletonObjects(skel);
  objPoints = growth.points;
  objBones = growth.lines;
  skelGroup.add(objPoints, objBones);
  skinStale = true;
  report();
  applyStage();
}

/** Stage 3-5: hubs, quad cage and subdivided skin. */
function buildSkin() {
  const t0 = performance.now();
  skinned = skinSkeleton(skel, params);
  cage = skinned.mesh;
  const t1 = performance.now();
  const levels = Math.round(params.subdivisions);
  fine = levels > 0 ? cage.subdivide(levels) : cage;
  const t2 = performance.now();
  lastTimes.skinMs = t1 - t0;
  lastTimes.subMs = t2 - t1;

  disposeGroup(skinGroup);
  objHubs = new THREE.LineSegments(hubGeometry(skinned.hubs), matHub);
  objCage = new THREE.Mesh(meshGeometry(cage), matCage);
  objCageWire = new THREE.LineSegments(wireGeometry(cage), matWire);
  objSkin = new THREE.Mesh(meshGeometry(fine), matSurf);
  objSkinWire = new THREE.LineSegments(wireGeometry(fine), matWire);
  skinGroup.add(objHubs, objCage, objCageWire, objSkin, objSkinWire);
  skinStale = false;
  report();
  applyStage();
}

/** Stage 6: refine the trunk locally and carve the fracture pattern into it. */
function buildBark() {
  ensureSkin();
  const hud = document.getElementById('hud');
  hud.textContent = 'growing bark — fracture simulation running…';
  // let the HUD paint before the (synchronous) heavy work
  requestAnimationFrame(() => {
    const t0 = performance.now();
    const src = Math.round(params.subdivisions) > 0 ? fine : cage;
    const res = growBark(src, skel, { ...params, barkMaxLevels: Math.round(params.barkMaxLevels) });
    bark = res.mesh;
    barkStats = { ...res.stats, totalMs: performance.now() - t0 };
    if (objBark) { objBark.geometry.dispose(); skinGroup.remove(objBark); }
    objBark = new THREE.Mesh(meshGeometry(bark), matSurf);
    skinGroup.add(objBark);
    barkStale = false;
    report();
    applyStage();
  });
}

function ensureSkin() {
  if (previewOnly) buildSkeleton(false);
  if (skinStale) buildSkin();
}

function rebuild(quick) {
  buildSkeleton(quick);
  if (!skeletonOnly()) buildSkin();
}

// While a slider is being dragged we only refresh what the current stage
// actually shows - in vertex/bone mode that is a ~80ms skeleton rebuild, and
// the box/skin chain below it is not run at all.
let rafPending = false;
let idleTimer = null;
function onParamChanged(skinOnlyParam) {
  clearTimeout(idleTimer);
  if (skinOnlyParam) {
    idleTimer = setTimeout(() => { if (!skeletonOnly()) buildSkin(); }, 60);
    return;
  }
  if (skeletonOnly()) {
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(() => { rafPending = false; buildSkeleton(true); });
    }
    idleTimer = setTimeout(() => buildSkeleton(false), 260);
  } else {
    idleTimer = setTimeout(() => rebuild(false), 110);
  }
}
function onParamSettled() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => rebuild(false), 40);
}

function report() {
  const s = skeletonStats(skel);
  const el = document.getElementById('stats');
  const flag = (b) => `<span class="${b ? 'ok' : 'bad'}">${b ? 'PASS' : 'FAIL'}</span>`;
  const col = skel.collisions || {};
  const rr = skel.nodes.map((n) => n.r);
  const rMin = Math.min(...rr);
  const rMax = Math.max(...rr);

  let head = `
skeleton   <b>${s.vertices}</b> verts · <b>${s.junctions}</b> forks · <b>${s.tips}</b> tips
radius     <b>${rMax.toFixed(3)}</b> trunk → <b>${rMin.toFixed(4)}</b> twig (1:${(rMax / rMin).toFixed(0)})
overlaps   ${col.skipped ? '<span class="dim">preview — solver skipped</span>' : `${flag(skel.overlap.pairs === 0)} (${col.initial || 0} fixed, ${col.pruned || 0} pruned)`}
skel build <b>${lastTimes.skelMs.toFixed(0)}</b> ms`;

  if (skeletonOnly() || skinStale || !cage) {
    el.innerHTML = `${head}
<span class="dim">${skeletonOnly()
      ? 'skin chain not running in this stage — switch to 3/4/5 to build boxes + quads'
      : 'building skin…'}</span>`;
    return;
  }

  const v = cage.validate();
  const q = cage.geometryQuality();
  const vf = fine.validate();
  const hist = cage.valenceHistogram();
  const poles = Object.entries(hist).filter(([k]) => +k !== 4).reduce((a, [, n]) => a + n, 0);
  el.innerHTML = `${head}
cage       <b>${v.vertices}</b> v / <b>${v.faces}</b> quads
skin       <b>${vf.vertices}</b> v / <b>${vf.faces}</b> quads
quads only ${flag(v.quadsOnly)}
watertight ${flag(v.boundaryEdges === 0)} (${v.boundaryEdges} open edges)
manifold   ${flag(v.nonManifoldEdges === 0 && v.flippedEdges === 0)}
single obj ${flag(v.shells === 1)} (${v.shells} shell)
euler χ    <b>${v.euler}</b> · genus <b>${v.genus}</b>
no twist   ${flag(skinned.backwardSockets === 0)}
no pinch   ${flag(q.pinched === 0)} · max aspect <b>${q.maxAspect.toFixed(1)}</b>:1
poles      <b>${poles}</b> / ${v.vertices} non-4-valence
build      ${lastTimes.skinMs.toFixed(0)}ms skin · ${lastTimes.subMs.toFixed(0)}ms subdiv${
    stage === BARK_STAGE && bark && barkStats
      ? `

BARK (trunk only)
mesh       <b>${bark.validate().faces}</b> quads · ${barkStats.refineLevels} refine levels
fissures   <b>${barkStats.brokenHoop}</b> vertical · ${barkStats.brokenAxial} cross
lattice    ${barkStats.latticeNodes} nodes · growth ×${barkStats.growthUsed.toFixed(2)}
carved     <b>${barkStats.carvedVerts}</b> verts · max ${(barkStats.maxCarve * 1000).toFixed(1)}mm
watertight ${flag(bark.validate().watertight)} · shells ${bark.validate().shells}
time       ${barkStats.totalMs.toFixed(0)} ms`
      : ''
  }`;
}

function applyStage() {
  const wire = document.getElementById('wire').checked;
  const keepSkel = document.getElementById('showSkel').checked;
  if (!objPoints) return;

  const skinReady = !skinStale && objCage;
  if (objBark) objBark.visible = stage === BARK_STAGE && !barkStale;
  objPoints.visible = stage <= 1 || keepSkel;
  if (skinReady) {
    objHubs.visible = stage === 2;
    objCage.visible = stage === 2 || stage === 3;
    objCageWire.visible = (stage === 2 || stage === 3) && wire;
    objSkin.visible = stage === 4;
    objSkinWire.visible = stage === 4 && wire;
    if (stage === BARK_STAGE) {
      objCage.visible = false;
      objCageWire.visible = false;
      objSkin.visible = !objBark;
      objSkinWire.visible = false;
    }
  }
  objBones.visible = stage <= 1 || keepSkel;
  matBones.opacity = stage === 0 ? 0.35 : 0.9;

  document.getElementById('hud').textContent =
    ['vertices — live: sliders rebuild only the point cloud',
     'bones — the vertices connected into limbs',
     'hub boxes — a box fitted at every fork',
     'quad cage — boxes extruded + tubes stitched (1 shell)',
     'skin — Catmull-Clark of that same all-quad cage',
     'bark — trunk refined locally, growth-fracture pattern carved in'][stage] +
    '\ndrag to orbit · scroll to zoom';
}

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
function tick() {
  requestAnimationFrame(tick);
  const dt = clock.getDelta();
  if (growth && growT < 1) {
    growT = Math.min(1, growT + dt / 2.2);
    const e = 1 - Math.pow(1 - growT, 3);
    objPoints.geometry.setDrawRange(0, Math.ceil(growth.count * e));
    objBones.geometry.setDrawRange(0, Math.ceil(growth.boneCount * e) * 2);
  } else if (growth) {
    objPoints.geometry.setDrawRange(0, growth.count);
    objBones.geometry.setDrawRange(0, growth.boneCount * 2);
  }
  controls.update();
  renderer.render(scene, camera);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

growT = 0;
// only the skeleton is built up front: the box/skin chain is lazy, it runs the
// first time you actually look at stage 3/4/5 (or export)
buildSkeleton(false);
tick();
