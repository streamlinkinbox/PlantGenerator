import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { generateSkeleton, DEFAULTS, orderByGrowth, skeletonStats } from '../core/skeleton.js';
import { skinSkeleton, SKIN_DEFAULTS } from '../core/skin.js';

// ---------------------------------------------------------------- parameters
const treeSpec = [
  ['seed', 1, 9999, 1],
  ['levels', 0, 6, 1],
  ['trunkHeight', 1, 12, 0.1],
  ['trunkRadius', 0.05, 1.2, 0.01],
  ['segmentsPerBranch', 2, 12, 1],
  ['childrenPerBranch', 0, 6, 1],
  ['splitCount', 0, 4, 1],
  ['branchAngle', 5, 90, 1],
  ['angleVariance', 0, 40, 1],
  ['branchStart', 0, 0.9, 0.01],
  ['lengthFalloff', 0.3, 1.0, 0.01],
  ['radiusFalloff', 0.3, 0.95, 0.01],
  ['taper', 0.2, 1.0, 0.01],
  ['curl', 0, 0.8, 0.01],
  ['gravitropism', -0.4, 0.6, 0.01],
  ['minRadius', 0.005, 0.15, 0.005],
];
const skinSpec = [
  ['subdivisions', 0, 3, 1],
  ['radiusCompensation', 0.6, 2.0, 0.02],
  ['hubScale', 0.6, 2.0, 0.02],
  ['socketReach', 1.0, 3.0, 0.05],
  ['loopSpacing', 0.6, 6, 0.1],
  ['maxTurn', 3, 45, 1],
  ['tipTaper', 0.05, 1.0, 0.01],
];

const params = { ...DEFAULTS, ...SKIN_DEFAULTS, subdivisions: 1 };

function buildControls(host, spec) {
  for (const [key, min, max, step] of spec) {
    const wrap = document.createElement('div');
    wrap.className = 'ctrl';
    wrap.innerHTML = `<div class="lbl"><span>${key.replace(/([A-Z])/g, ' $1').toLowerCase()}</span><b>${params[key]}</b></div>`;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step; input.value = params[key];
    const out = wrap.querySelector('b');
    input.addEventListener('input', () => {
      params[key] = parseFloat(input.value);
      out.textContent = params[key];
      schedule();
    });
    wrap.appendChild(input);
    host.appendChild(wrap);
    spec.el = input;
  }
}
buildControls(document.getElementById('treeControls'), treeSpec);
buildControls(document.getElementById('skinControls'), skinSpec);

// ---------------------------------------------------------------- three setup
const view = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1015);
scene.fog = new THREE.Fog(0x0d1015, 30, 90);

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

const root = new THREE.Group();
scene.add(root);

// ---------------------------------------------------------------- materials
const matPoints = new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, vertexColors: true });
const matBones = new THREE.LineBasicMaterial({ color: 0x3ad6a0, transparent: true, opacity: 0.85 });
const matHub = new THREE.LineBasicMaterial({ color: 0xffb454, transparent: true, opacity: 0.9 });
const matWire = new THREE.LineBasicMaterial({ color: 0x35ffc0, transparent: true, opacity: 0.55 });
const matSurf = new THREE.MeshStandardMaterial({ color: 0xb08a5e, roughness: 0.78, metalness: 0.02, flatShading: false });
const matCage = new THREE.MeshStandardMaterial({ color: 0x6f7f96, roughness: 0.9, metalness: 0.0, flatShading: true });

// ---------------------------------------------------------------- state
let skel = null;
let cage = null;
let fine = null;
let objPoints, objBones, objHubs, objCage, objCageWire, objSkin, objSkinWire;
let growth = null;
let growT = 1;
let stage = 0;

const stageButtons = [...document.querySelectorAll('#stages button')];
stageButtons.forEach((b) =>
  b.addEventListener('click', () => {
    stage = +b.dataset.stage;
    stageButtons.forEach((x) => x.classList.toggle('on', x === b));
    if (stage <= 1) growT = 0;
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
document.getElementById('reseed').addEventListener('click', () => {
  params.seed = 1 + Math.floor(Math.random() * 9999);
  const el = document.querySelector('#treeControls input');
  el.value = params.seed;
  el.previousElementSibling.querySelector('b').textContent = params.seed;
  growT = 0;
  rebuild();
});
document.getElementById('exportCage').addEventListener('click', () => download('cage.obj', cage.toOBJ('tree_cage')));
document.getElementById('exportSub').addEventListener('click', () => download('skin.obj', fine.toOBJ('tree_skin')));

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------- geometry
function disposeGroup(g) {
  g.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
  });
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

function skeletonObjects(sk) {
  const { order, dist, maxDist } = orderByGrowth(sk);
  const rank = new Int32Array(sk.nodes.length);
  order.forEach((n, i) => (rank[n] = i));

  const pos = new Float32Array(order.length * 3);
  const col = new Float32Array(order.length * 3);
  order.forEach((n, i) => {
    const p = sk.nodes[n].p;
    pos.set(p, i * 3);
    const t = dist[n] / maxDist;
    const c = new THREE.Color().setHSL(0.42 - 0.36 * t, 0.85, 0.45 + 0.2 * t);
    col.set([c.r, c.g, c.b], i * 3);
  });
  const gp = new THREE.BufferGeometry();
  gp.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  gp.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const points = new THREE.Points(gp, matPoints);
  points.frustumCulled = false;

  const bones = sk.bones.slice().sort((a, b) => Math.max(rank[a[0]], rank[a[1]]) - Math.max(rank[b[0]], rank[b[1]]));
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
let timer = null;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(rebuild, 90);
}

function rebuild() {
  const t0 = performance.now();
  disposeGroup(root);

  skel = generateSkeleton({
    ...params,
    levels: Math.round(params.levels),
    segmentsPerBranch: Math.round(params.segmentsPerBranch),
    childrenPerBranch: Math.round(params.childrenPerBranch),
    splitCount: Math.round(params.splitCount),
    seed: Math.round(params.seed),
  });
  const t1 = performance.now();

  const skinned = skinSkeleton(skel, params);
  cage = skinned.mesh;
  const t2 = performance.now();

  const levels = Math.round(params.subdivisions);
  fine = levels > 0 ? cage.subdivide(levels) : cage;
  const t3 = performance.now();

  growth = skeletonObjects(skel);
  objPoints = growth.points;
  objBones = growth.lines;
  objHubs = new THREE.LineSegments(hubGeometry(skinned.hubs), matHub);
  objCage = new THREE.Mesh(meshGeometry(cage), matCage);
  objCageWire = new THREE.LineSegments(wireGeometry(cage), matWire);
  objSkin = new THREE.Mesh(meshGeometry(fine), matSurf);
  objSkinWire = new THREE.LineSegments(wireGeometry(fine), matWire);
  root.add(objPoints, objBones, objHubs, objCage, objCageWire, objSkin, objSkinWire);

  report(skinned, fine, { skelMs: t1 - t0, skinMs: t2 - t1, subMs: t3 - t2 });
  applyStage();
}

function report(skinned, out, times) {
  const v = cage.validate();
  const vf = out.validate();
  const s = skeletonStats(skel);
  const hist = cage.valenceHistogram();
  const poles = Object.entries(hist).filter(([k]) => +k !== 4).reduce((a, [, n]) => a + n, 0);
  const flag = (b) => `<span class="${b ? 'ok' : 'bad'}">${b ? 'PASS' : 'FAIL'}</span>`;
  document.getElementById('stats').innerHTML = `
skeleton   <b>${s.vertices}</b> verts · <b>${s.junctions}</b> junctions · <b>${s.tips}</b> tips
cage       <b>${v.vertices}</b> v / <b>${v.faces}</b> quads
skin       <b>${vf.vertices}</b> v / <b>${vf.faces}</b> quads
quads only ${flag(v.quadsOnly)}
watertight ${flag(v.boundaryEdges === 0)} (${v.boundaryEdges} open edges)
manifold   ${flag(v.nonManifoldEdges === 0 && v.flippedEdges === 0)}
single obj ${flag(v.shells === 1)} (${v.shells} shell)
euler χ    <b>${v.euler}</b> · genus <b>${v.genus}</b>
poles      <b>${poles}</b> / ${v.vertices} verts non-4-valence
build      ${times.skelMs.toFixed(0)}ms skel · ${times.skinMs.toFixed(0)}ms skin · ${times.subMs.toFixed(0)}ms subdiv`;
  document.getElementById('hud').textContent =
    `stage ${stage + 1}/5 · drag to orbit · scroll to zoom`;
}

function applyStage() {
  const wire = document.getElementById('wire').checked;
  const keepSkel = document.getElementById('showSkel').checked;
  if (!objPoints) return;

  objPoints.visible = stage === 0 || keepSkel;
  objBones.visible = stage >= 1 || keepSkel;
  objHubs.visible = stage === 2;
  objCage.visible = stage === 2 || stage === 3;
  objCageWire.visible = (stage === 2 || stage === 3) && wire;
  objSkin.visible = stage === 4;
  objSkinWire.visible = stage === 4 && wire;
  if (stage === 2) matCage.opacity = 1;

  matBones.opacity = stage >= 2 ? 0.35 : 0.9;
  if (stage <= 1) growT = Math.min(growT, 1);
  document.getElementById('hud').textContent =
    ['vertices only — the skeleton point cloud',
     'bones — vertices linked into limbs',
     'hub boxes — a box is fitted at every junction',
     'quad cage — boxes extruded + tubes stitched (1 shell)',
     'skin — Catmull-Clark of the same all-quad cage'][stage] +
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
rebuild();
tick();
