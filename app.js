/* PlantForge — a tiny procedural plant studio.
 * Branches are generated once from a seed. Leaf transforms are instanced;
 * falling leaves get their position, sway and loop timing in the GPU vertex shader.
 */
(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const els = {
    canvas: $('#glCanvas'), viewport: $('#viewport'), atlasPreview: $('#atlasPreview'),
    species: [...document.querySelectorAll('.species-card')],
    height: $('#height'), branching: $('#branching'), density: $('#leafDensity'), seed: $('#seed'), wind: $('#wind'),
    heightValue: $('#heightValue'), branchingValue: $('#branchingValue'), densityValue: $('#leafDensityValue'), seedValue: $('#seedValue'), windValue: $('#windValue'),
    atlas: $('#atlasSelect'), atlasName: $('#atlasName'), upload: $('#uploadAtlas'), download: $('#downloadAtlas'),
    falling: $('#fallingLeaves'), generate: $('#generateBtn'), randomize: $('#randomizeBtn'), reset: $('#resetBtn'), pause: $('#pauseBtn'), pauseLabel: $('#pauseLabel'), frame: $('#frameBtn'), topology: $('#topologyBtn'), export: $('#exportBtn'),
    stageSpecies: $('#stageSpecies'), branchCount: $('#branchCount'), leafCount: $('#leafCount'), particleCount: $('#particleCount'), frameTime: $('#frameTime'), code: $('#codeLabel'), generationTime: $('#generationTime'), paletteName: $('#paletteName'), toast: $('#renderToast'), live: $('#liveRegion'),
    help: $('#helpBtn'), helpModal: $('#helpModal'), closeHelp: $('#closeHelp'), doneHelp: $('#doneHelp'), learn: $('#learnLink'), direction: $('#windDirectionValue'), strength: $('#windStrengthValue')
  };

  const defaults = { species: 'oak', height: 7.4, branching: 64, density: 78, seed: 482106, wind: 38, atlas: 'botanical', falling: true };
  const speciesInfo = {
    oak: { label: 'English oak', stage: 'ENGLISH OAK', code: 'OAK', palette: 'MOSS / BARK', maxDepth: 4, baseChildren: 2, spread: .52, taper: .72, colors: ['#354d35', '#527b54', '#80a765', '#a9c47b'] }
  };

  const state = {
    species: defaults.species, atlas: defaults.atlas, generated: null, paused: false, time: 0, lastFrame: performance.now(),
    camera: { yaw: .47, pitch: .06, distance: 11.3, panX: 0, panY: 0 }, showTopology: false, dragging: false, navMode: null, pointerX: 0, pointerY: 0, customAtlas: null, gl: null, renderer: null
  };

  // A deterministic, very small PRNG keeps the same seed visually identical.
  function rngFactory(seed) {
    let value = (Number(seed) >>> 0) || 1;
    return () => {
      value += 0x6D2B79F5;
      let t = value;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const mix = (a, b, t) => a + (b - a) * t;
  const vecLength = (a) => Math.hypot(a[0], a[1], a[2]);
  const norm = (a) => { const l = vecLength(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const scale = (a, n) => [a[0] * n, a[1] * n, a[2] * n];
  const lerpVec = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

  function hexRgb(hex) {
    const value = hex.replace('#', '');
    return [parseInt(value.slice(0, 2), 16) / 255, parseInt(value.slice(2, 4), 16) / 255, parseInt(value.slice(4, 6), 16) / 255];
  }

  // Build the branch network as one clean, quad-ring mesh. The skeleton is
  // endpoint-to-endpoint: a branching event is one shared graph node, not a
  // child cylinder inserted into the middle of its parent.
  function quadPipeMesh(nodes, edges, bark, barkLight) {
    const sides = 8, vertices = [], indices = [], lineIndices = [], vertexMap = new Map();
    const pushVertex = (point, color) => {
      const key = point.map(value => value.toFixed(5)).join(',');
      if (vertexMap.has(key)) return vertexMap.get(key);
      const index = vertices.length / 9; vertices.push(point[0], point[1], point[2], color[0], color[1], color[2], 0, 0, 0); vertexMap.set(key, index); return index;
    };
    const barkColor = (point) => { const shade = clamp(.88 + Math.sin(point[0] * 3.7 + point[2] * 4.1) * .05 + Math.sin(point[1] * 6.1) * .025, .74, 1.03); return [clamp(bark[0] * shade + barkLight[0] * .06, 0, 1), clamp(bark[1] * shade + barkLight[1] * .06, 0, 1), clamp(bark[2] * shade + barkLight[2] * .06, 0, 1)]; };
    const frameFor = (axis) => { const direction = norm(axis); const reference = Math.abs(direction[1]) > .88 ? [1, 0, 0] : [0, 1, 0]; const u = norm([direction[1] * reference[2] - direction[2] * reference[1], direction[2] * reference[0] - direction[0] * reference[2], direction[0] * reference[1] - direction[1] * reference[0]]); const v = [direction[1] * u[2] - direction[2] * u[1], direction[2] * u[0] - direction[0] * u[2], direction[0] * u[1] - direction[1] * u[0]]; return { u, v }; };
    // Round the junction control shell. The quad patch and its port holes stay
    // explicit, but the control shell is mapped to a smooth sphere so the
    // rendered collar does not inherit an angular silhouette.
    const roundedHubPoint = (node, face, half, s, t) => {
      const local = add(scale(face.normal, half), add(scale(face.s, s), scale(face.t, t))), x = local[0] / half, y = local[1] / half, z = local[2] / half;
      const sx = x * Math.sqrt(Math.max(0, 1 - y * y / 2 - z * z / 2 + y * y * z * z / 3)), sy = y * Math.sqrt(Math.max(0, 1 - z * z / 2 - x * x / 2 + z * z * x * x / 3)), sz = z * Math.sqrt(Math.max(0, 1 - x * x / 2 - y * y / 2 + x * x * y * y / 3));
      return add(node.position, [sx * half, sy * half, sz * half]);
    };
    const addQuad = (a, b, c, d) => { indices.push(a, b, c, a, c, d); lineIndices.push(a, b, b, c, c, d, d, a); };
    const ports = nodes.map(() => []);
    edges.forEach((edge, edgeIndex) => {
      const from = nodes[edge.a], to = nodes[edge.b];
      ports[edge.a].push({ edgeIndex, side: 'a', direction: norm([to.position[0] - from.position[0], to.position[1] - from.position[1], to.position[2] - from.position[2]]) });
      ports[edge.b].push({ edgeIndex, side: 'b', direction: norm([from.position[0] - to.position[0], from.position[1] - to.position[1], from.position[2] - to.position[2]]) });
    });
    const portRings = new Map();
    nodes.forEach(node => {
      const nodeFrame = frameFor(node.axis || [0, 1, 0]), axis = nodeFrame.u, side = nodeFrame.v;
      const faces = [
        { normal: node.axis || [0, 1, 0], s: axis, t: side }, { normal: scale(node.axis || [0, 1, 0], -1), s: axis, t: scale(side, -1) },
        { normal: axis, s: side, t: node.axis || [0, 1, 0] }, { normal: scale(axis, -1), s: side, t: scale(node.axis || [0, 1, 0], -1) },
        { normal: side, s: node.axis || [0, 1, 0], t: axis }, { normal: scale(side, -1), s: node.axis || [0, 1, 0], t: scale(axis, -1) }
      ];
      const assignments = new Map(), unused = new Set(faces.map((_, index) => index));
      ports[node.id].forEach(port => { let bestFace = -1, bestDot = -Infinity; unused.forEach(faceIndex => { const face = faces[faceIndex], dot = port.direction[0] * face.normal[0] + port.direction[1] * face.normal[1] + port.direction[2] * face.normal[2]; if (dot > bestDot) { bestDot = dot; bestFace = faceIndex; } }); if (bestFace < 0) bestFace = 0; unused.delete(bestFace); assignments.set(`${port.edgeIndex}:${port.side}`, bestFace); });
      const half = Math.max(.018, node.radius * 1.33), holeHalf = Math.max(.014, node.radius * .7), grid = [-half, -holeHalf, 0, holeHalf, half];
      faces.forEach((face, faceIndex) => {
        const faceGrid = [];
        for (let y = 0; y < grid.length; y++) { faceGrid[y] = []; for (let x = 0; x < grid.length; x++) { const point = roundedHubPoint(node, face, half, grid[x], grid[y]); faceGrid[y][x] = pushVertex(point, barkColor(point)); } }
        for (let y = 0; y < grid.length - 1; y++) for (let x = 0; x < grid.length - 1; x++) { if (x >= 1 && x <= 2 && y >= 1 && y <= 2) continue; addQuad(faceGrid[y][x], faceGrid[y][x + 1], faceGrid[y + 1][x + 1], faceGrid[y + 1][x]); }
        const holeBoundary = [faceGrid[1][1], faceGrid[1][2], faceGrid[1][3], faceGrid[2][3], faceGrid[3][3], faceGrid[3][2], faceGrid[3][1], faceGrid[2][1]];
        const facePort = ports[node.id].find(port => assignments.get(`${port.edgeIndex}:${port.side}`) === faceIndex);
        if (facePort) {
          const circle = [];
          // The eight-point port loop maps to the eight-point square hole.
          const angles = [-3 * Math.PI / 4, -Math.PI / 2, -Math.PI / 4, 0, Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4, Math.PI];
          angles.forEach(angle => { const point = roundedHubPoint(node, face, half, Math.cos(angle) * holeHalf, Math.sin(angle) * holeHalf); circle.push(pushVertex(point, barkColor(point))); });
          for (let i = 0; i < sides; i++) { const next = (i + 1) % sides; addQuad(holeBoundary[i], holeBoundary[next], circle[next], circle[i]); }
          portRings.set(`${facePort.edgeIndex}:${facePort.side}`, circle);
        } else {
          // No pipe on this side: close the central 2x2 patch so the hub is
          // watertight rather than leaving an accidental opening.
          for (let y = 1; y <= 2; y++) for (let x = 1; x <= 2; x++) addQuad(faceGrid[y][x], faceGrid[y][x + 1], faceGrid[y + 1][x + 1], faceGrid[y + 1][x]);
        }
      });
    });
    edges.forEach((edge, edgeIndex) => {
      const from = nodes[edge.a], to = nodes[edge.b], direction = norm([to.position[0] - from.position[0], to.position[1] - from.position[1], to.position[2] - from.position[2]]), length = vecLength([to.position[0] - from.position[0], to.position[1] - from.position[1], to.position[2] - from.position[2]]), steps = Math.max(3, Math.ceil(length / .34)), rings = [portRings.get(`${edgeIndex}:a`)], frame = frameFor(direction);
      for (let step = 1; step < steps; step++) { const t = step / steps, center = lerpVec(from.position, to.position, t), radius = mix(edge.r1, edge.r2, t); rings.push(addRing(center, radius, frame, pushVertex)); }
      rings.push(portRings.get(`${edgeIndex}:b`));
      for (let ring = 0; ring < rings.length - 1; ring++) for (let sideIndex = 0; sideIndex < sides; sideIndex++) { const next = (sideIndex + 1) % sides; addQuad(rings[ring][sideIndex], rings[ring][next], rings[ring + 1][next], rings[ring + 1][sideIndex]); }
    });

    const normals = new Float32Array((vertices.length / 9) * 3);
    for (let i = 0; i < indices.length; i += 3) {
      const ia = indices[i] * 9, ib = indices[i + 1] * 9, ic = indices[i + 2] * 9, ab = [vertices[ib] - vertices[ia], vertices[ib + 1] - vertices[ia + 1], vertices[ib + 2] - vertices[ia + 2]], ac = [vertices[ic] - vertices[ia], vertices[ic + 1] - vertices[ia + 1], vertices[ic + 2] - vertices[ia + 2]], cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      for (const vertex of [indices[i], indices[i + 1], indices[i + 2]]) { normals[vertex * 3] += cross[0]; normals[vertex * 3 + 1] += cross[1]; normals[vertex * 3 + 2] += cross[2]; }
    }
    for (let i = 0; i < vertices.length / 9; i++) { const normal = norm([normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]]); vertices[i * 9 + 6] = normal[0]; vertices[i * 9 + 7] = normal[1]; vertices[i * 9 + 8] = normal[2]; }
    return { vertices, indices, lineIndices };
  }

  // Add a tube ring with the same vertex packing used by the junction ports.
  function addRing(center, radius, frame, pushVertex) { const ring = []; for (let side = 0; side < 8; side++) { const angle = side / 8 * Math.PI * 2, radial = [frame.u[0] * Math.cos(angle) * radius + frame.v[0] * Math.sin(angle) * radius, frame.u[1] * Math.cos(angle) * radius + frame.v[1] * Math.sin(angle) * radius, frame.u[2] * Math.cos(angle) * radius + frame.v[2] * Math.sin(angle) * radius]; ring.push(pushVertex([center[0] + radial[0], center[1] + radial[1], center[2] + radial[2]], [0.25, 0.16, 0.1])); } return ring; }

  function generatePlant() {
    const started = performance.now();
    const species = speciesInfo[state.species];
    const height = Number(els.height.value), branching = Number(els.branching.value), density = Number(els.density.value);
    const random = rngFactory(Number(els.seed.value));
    const nodes = [], edges = [], leaves = [], tips = [];
    const bark = hexRgb('#4b3527');
    const barkLight = hexRgb('#75513a');
    const leafColors = species.colors.map(hexRgb);
    const depthMax = species.maxDepth;
    const addNode = (position, axis, radius) => { const id = nodes.length; nodes.push({ id, position: [...position], axis: norm(axis), radius: Math.max(.009, radius), degree: 0 }); return id; };
    const connectNodes = (from, to, radiusA, radiusB, depth) => { edges.push({ a: from, b: to, r1: radiusA, r2: radiusB, depth }); nodes[from].degree++; nodes[to].degree++; };

    // English oak rule set: a persistent central leader, wide lower limbs,
    // shorter upper forks, taper at every order, and near-conserved pipe area.
    // A fork has one leader + side limbs; child radii follow r_child ~=
    // r_parent / sqrt(number of outgoing pipes), rather than arbitrary cones.
    const addBranch = (startNodeId, direction, length, radius, depth, forkBias = 0) => {
      const start = nodes[startNodeId].position;
      const bend = [(random() - .5) * species.spread * .24, (random() - .35) * .12, (random() - .5) * species.spread * .24];
      const nextDirection = norm(add(direction, bend));
      const end = add(start, scale(nextDirection, length));
      const endRadius = Math.max(.009, radius * species.taper);
      const endNodeId = addNode(end, nextDirection, endRadius);
      connectNodes(startNodeId, endNodeId, radius, endRadius, depth);

      if (depth <= 0 || edges.length > 540) { tips.push({ point: end, direction: nextDirection, depth }); return; }
      const heightRatio = clamp(end[1] / Math.max(height, .01), 0, 1);
      let sideChildren = species.baseChildren + (branching > 72 && depth > 1 ? 1 : 0) - (branching < 38 && depth > 1 ? 1 : 0);
      sideChildren = clamp(sideChildren, 1, 3);
      if (random() > .18 + branching / 190 && depth > 1) sideChildren = Math.max(1, sideChildren - 1);
      const outgoingPipes = sideChildren + 1; // leader + side branches; Pipe Model-inspired.
      const childRadius = endRadius * .91 / Math.sqrt(outgoingPipes);

      // Keep the monopodial leader alive through the crown. Every new leader
      // endpoint is a real graph node, so lower limbs and the leader share the
      // same vertex ring in the quad skin below.
      const leaderDirection = norm(add(nextDirection, [(random() - .5) * .16, .09 + random() * .08, (random() - .5) * .16]));
      addBranch(endNodeId, leaderDirection, length * (.65 + random() * .08), childRadius * 1.05, depth - 1, forkBias + .45);

      // Structural limbs are deliberately lower and wider on the oak trunk;
      // upper orders become more upright and compact.
      for (let i = 0; i < sideChildren; i++) {
        const theta = (i / sideChildren) * Math.PI * 2 + random() * 1.15 + forkBias;
        const lateral = species.spread * (0.48 + random() * .42) * (1.16 - heightRatio * .3);
        const childDirection = norm([Math.cos(theta) * lateral, .36 + random() * .6 + heightRatio * .28, Math.sin(theta) * lateral]);
        addBranch(endNodeId, childDirection, length * (.54 + random() * .1), childRadius * (.9 + random() * .13), depth - 1, theta * .17);
      }
    };

    // Start with one continuous trunk/leader. All later limbs originate at
    // shared graph nodes rather than floating inside an existing segment.
    const rootNodeId = addNode([0, 0, 0], [0, 1, 0], .31);
    addBranch(rootNodeId, [0, 1, 0], height * .31, .31, depthMax, random() * 2);

    // Add a crown of atlas-sampled leaf instances at every branch end. This is
    // intentionally CPU-side only at generation time; motion is GPU-side.
    const densityFactor = density / 100;
    const perTip = 21;
    for (const tip of tips) {
      const count = Math.max(2, Math.round(perTip * densityFactor * (.8 + random() * .45)));
      for (let i = 0; i < count; i++) {
        const around = random() * Math.PI * 2;
        const radial = .26 * Math.sqrt(random());
        const vertical = (random() - .3) * .38;
        const point = add(tip.point, [Math.cos(around) * radial, vertical, Math.sin(around) * radial]);
        const size = .14 * (.72 + random() * .52);
        leaves.push({ position: point, size, angle: random() * Math.PI * 2, cell: Math.floor(random() * 4), seed: random(), tint: leafColors[Math.floor(random() * leafColors.length)] });
      }
    }

    // Falling instances are sampled from the real generated leaf attachments.
    // No free-floating emission volume is used: at t=0 every particle is at a
    // leaf's actual branch tip, then the GPU shader detaches it and lets it fall.
    // The sampled leaves are removed from the static canopy so a falling leaf
    // leaves a visible gap instead of looking like a second particle spawned in.
    const orderedLeaves = leaves.map((leaf, index) => ({ leaf, index }));
    for (let i = orderedLeaves.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [orderedLeaves[i], orderedLeaves[j]] = [orderedLeaves[j], orderedLeaves[i]]; }
    const fallingTotal = Math.min(180, Math.max(12, Math.round(orderedLeaves.length * .24)), Math.max(0, orderedLeaves.length - 12));
    const selectedFalling = orderedLeaves.slice(0, fallingTotal);
    const falling = selectedFalling.map(({ leaf }) => ({ position: [...leaf.position], size: .065 + random() * .065, angle: random() * Math.PI * 2, cell: Math.floor(random() * 4), seed: random(), tint: leafColors[Math.floor(random() * leafColors.length)] }));
    const fallingIndexes = new Set(selectedFalling.map(({ index }) => index));
    const groundedLeaves = leaves.filter((leaf, index) => !fallingIndexes.has(index));

    state.generated = { nodes, segments: edges, leaves: groundedLeaves, allLeaves: leaves, falling, height, bark, barkLight, duration: 0 };
    if (state.renderer) state.renderer.upload(state.generated);
    state.generated.duration = performance.now() - started;
    updateStats();
    showToast('Specimen regenerated');
    els.live.textContent = `${species.label} specimen generated from seed ${els.seed.value}`;
  }

  function updateStats() {
    if (!state.generated) return;
    const species = speciesInfo[state.species];
    els.stageSpecies.textContent = species.stage;
    els.code.textContent = `PF-${species.code}-${String(els.seed.value).padStart(6, '0')}`;
    els.branchCount.textContent = state.generated.segments.length.toLocaleString();
    els.leafCount.textContent = (els.falling.checked ? state.generated.leaves : state.generated.allLeaves).length.toLocaleString();
    els.particleCount.textContent = els.falling.checked ? state.generated.falling.length.toLocaleString() : 'OFF';
    els.generationTime.textContent = `${Math.max(.008, state.generated.duration / 1000).toFixed(3)} s`;
    els.paletteName.textContent = species.palette;
  }

  function showToast(text) {
    els.toast.textContent = text;
    els.toast.classList.remove('show');
    requestAnimationFrame(() => els.toast.classList.add('show'));
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => els.toast.classList.remove('show'), 1400);
  }

  // --- Atlas creation ----------------------------------------------------
  function drawLeaf(ctx, x, y, size, color, accent, rotation, shape) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rotation);
    ctx.fillStyle = color; ctx.strokeStyle = accent; ctx.lineWidth = Math.max(1, size * .035);
    ctx.beginPath();
    if (shape === 0) { ctx.moveTo(0, -size * .55); ctx.bezierCurveTo(size * .62, -size * .35, size * .62, size * .34, 0, size * .55); ctx.bezierCurveTo(-size * .6, size * .3, -size * .58, -size * .3, 0, -size * .55); }
    else if (shape === 1) { ctx.moveTo(0, -size * .6); ctx.bezierCurveTo(size * .85, -.2 * size, size * .35, size * .5, 0, size * .55); ctx.bezierCurveTo(-size * .34, size * .47, -size * .82, -.2 * size, 0, -size * .6); }
    else if (shape === 2) { ctx.moveTo(0, -size * .65); ctx.bezierCurveTo(size * .45, -.12 * size, size * .7, size * .38, 0, size * .58); ctx.bezierCurveTo(-size * .7, size * .38, -size * .45, -.12 * size, 0, -size * .65); }
    else { ctx.moveTo(0, -size * .57); ctx.bezierCurveTo(size * .28, -.4 * size, size * .63, -.05 * size, size * .47, size * .28); ctx.bezierCurveTo(size * .2, size * .55, -.15 * size, size * .46, 0, size * .6); ctx.bezierCurveTo(.15 * size, size * .46, -.2 * size, size * .55, -size * .47, size * .28); ctx.bezierCurveTo(-size * .63, -.05 * size, -size * .28, -.4 * size, 0, -size * .57); }
    ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -size * .47); ctx.lineTo(0, size * .5); ctx.strokeStyle = accent; ctx.lineWidth = Math.max(1, size * .025); ctx.stroke();
    ctx.restore();
  }
  function drawAtlas(type = state.atlas, source = null) {
    const canvas = els.atlasPreview, ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (source) { ctx.drawImage(source, 0, 0, canvas.width, canvas.height); return; }
    const palettes = {
      botanical: [['#426a4a', '#bfd98a'], ['#719660', '#d3de9b'], ['#557e58', '#b1d47b'], ['#8fae68', '#dfe8ad']],
      autumn: [['#a54c2d', '#e9a664'], ['#c17737', '#f0c56b'], ['#8c3d32', '#d5814d'], ['#bd7133', '#f1b65e']],
      ink: [['#233a32', '#c4dbba'], ['#426455', '#b5ceb1'], ['#526f65', '#d1e0cc'], ['#1b302b', '#a8c6aa']]
    };
    const palette = palettes[type] || palettes.botanical;
    // Keep the atlas background transparent. A solid preview backing is
    // provided by CSS; alpha in the actual texture is what makes leaf quads
    // read as leaf silhouettes instead of opaque square tiles.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(28,53,35,.13)'; ctx.lineWidth = 1;
    for (let x = 0; x <= canvas.width; x += 80) { ctx.beginPath(); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, canvas.height); ctx.stroke(); }
    for (let y = 0; y <= canvas.height; y += 80) { ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(canvas.width, y + .5); ctx.stroke(); }
    for (let i = 0; i < 4; i++) {
      const x = (i % 2) * 80 + 40, y = Math.floor(i / 2) * 80 + 40;
      drawLeaf(ctx, x, y, 48, palette[i][0], palette[i][1], [-.34, .22, .28, -.18][i], i);
    }
  }

  // --- WebGL renderer ---------------------------------------------------
  const branchVertex = `#version 300 es
    layout(location=0) in vec3 a_position;
    layout(location=1) in vec3 a_color;
    layout(location=2) in vec3 a_normal;
    uniform mat4 u_projection;
    uniform mat4 u_view;
    out vec3 v_color;
    out vec3 v_normal;
    void main() { v_color = a_color; v_normal = a_normal; gl_Position = u_projection * u_view * vec4(a_position, 1.0); }`;
  const branchFragment = `#version 300 es
    precision highp float;
    in vec3 v_color;
    in vec3 v_normal;
    uniform float u_wire;
    out vec4 outColor;
    void main() { vec3 color; if (u_wire > .5) color = vec3(.66, .9, .42); else { float light = .62 + .38 * abs(dot(normalize(v_normal), normalize(vec3(-.42, .82, .36)))); color = v_color * light; } outColor = vec4(color, mix(1.0, .78, u_wire)); }`;
  const leafVertex = `#version 300 es
    layout(location=0) in vec2 a_corner;
    layout(location=1) in vec3 a_offset;
    layout(location=2) in float a_size;
    layout(location=3) in float a_angle;
    layout(location=4) in float a_cell;
    layout(location=5) in float a_seed;
    layout(location=6) in vec3 a_tint;
    uniform mat4 u_projection;
    uniform mat4 u_view;
    uniform vec3 u_camRight;
    uniform vec3 u_camUp;
    uniform float u_time;
    uniform float u_wind;
    uniform float u_height;
    uniform float u_falling;
    out vec2 v_uv;
    out float v_cell;
    out vec3 v_tint;
    void main() {
      float phase = a_seed * 6.28318;
      vec3 world = a_offset;
      float sway = sin(u_time * (1.05 + a_seed * .8) + phase + a_offset.y * .55) * (.018 + a_size * .12) * u_wind;
      world.x += sway;
      world.z += cos(u_time * .86 + phase) * (.012 + a_size * .07) * u_wind;
      if (u_falling > .5) {
        float cycle = max(4.0, u_height * .82);
        // a_offset is the actual leaf's branch attachment point. The loop
        // begins there, so every detached leaf visibly starts on a branch.
        float fall = mod(u_time * (.23 + a_seed * .27), cycle);
        world.y = a_offset.y - fall;
        world.x += sin(u_time * (.75 + a_seed) + phase) * (.12 + u_wind * .18);
        world.z += cos(u_time * (.58 + a_seed) + phase) * (.08 + u_wind * .13);
        world.x += u_wind * fall * .12;
      }
      float leafAngle = a_angle + (u_falling > .5 ? u_time * (.5 + a_seed * .8) : sin(u_time + a_seed) * .025);
      float ca = cos(leafAngle), sa = sin(leafAngle);
      vec2 rotated = vec2(a_corner.x * ca - a_corner.y * sa, a_corner.x * sa + a_corner.y * ca);
      vec3 pos = world + u_camRight * (rotated.x * a_size) + u_camUp * (rotated.y * a_size * .94);
      gl_Position = u_projection * u_view * vec4(pos, 1.0);
      v_uv = a_corner + vec2(.5, 0.0);
      v_uv.y = a_corner.y;
      v_cell = a_cell;
      v_tint = a_tint;
    }`;
  const leafFragment = `#version 300 es
    precision highp float;
    uniform sampler2D u_atlas;
    in vec2 v_uv;
    in float v_cell;
    in vec3 v_tint;
    out vec4 outColor;
    void main() {
      float cellX = mod(v_cell, 2.0);
      float cellY = floor(v_cell / 2.0);
      vec2 atlasUv = (v_uv + vec2(cellX, cellY)) * .5;
      vec4 tex = texture(u_atlas, atlasUv);
      if (tex.a < .18) discard;
      outColor = vec4(tex.rgb * v_tint, tex.a * .94);
    }`;

  function compile(gl, type, source) {
    const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(shader)); gl.deleteShader(shader); return null; }
    return shader;
  }
  function makeProgram(gl, vertex, fragment) {
    const vs = compile(gl, gl.VERTEX_SHADER, vertex), fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
    if (!vs || !fs) return null;
    const program = gl.createProgram(); gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { console.warn(gl.getProgramInfoLog(program)); return null; }
    return program;
  }
  function perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, (2 * far * near) * nf, 0]);
  }
  function lookAt(eye, target) {
    const z = norm([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
    const x = norm([z[2], 0, -z[0]]);
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    return { matrix: new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]), -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]), -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]), 1]), forward: [-z[0], -z[1], -z[2]], right: x, up: y };
  }

  function createRenderer() {
    const gl = els.canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: false });
    if (!gl) return drawFallback();
    const branchProgram = makeProgram(gl, branchVertex, branchFragment), leafProgram = makeProgram(gl, leafVertex, leafFragment);
    if (!branchProgram || !leafProgram) return drawFallback();
    const renderer = { gl, branchProgram, leafProgram, branchVao: gl.createVertexArray(), leafVao: gl.createVertexArray(), fallingVao: gl.createVertexArray(), branchBuffer: gl.createBuffer(), branchIndex: gl.createBuffer(), branchLineIndex: gl.createBuffer(), leafBuffer: gl.createBuffer(), leafSourceBuffer: gl.createBuffer(), fallingSourceBuffer: gl.createBuffer(), texture: gl.createTexture(), branchIndexCount: 0, branchLineIndexCount: 0, leafCount: 0, fallingCount: 0 };

    // Static quad. All per-leaf attributes live in a second instanced buffer.
    const quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-.5, 0, .5, 0, -.5, 1, .5, 1]), gl.STATIC_DRAW);
    const configureLeafVao = (vao, instanceBuffer) => {
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      for (let loc = 1; loc <= 6; loc++) gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 12 * 4, 0); gl.vertexAttribDivisor(1, 1);
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 12 * 4, 3 * 4); gl.vertexAttribDivisor(2, 1);
      gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 12 * 4, 4 * 4); gl.vertexAttribDivisor(3, 1);
      gl.vertexAttribPointer(4, 1, gl.FLOAT, false, 12 * 4, 5 * 4); gl.vertexAttribDivisor(4, 1);
      gl.vertexAttribPointer(5, 1, gl.FLOAT, false, 12 * 4, 6 * 4); gl.vertexAttribDivisor(5, 1);
      gl.vertexAttribPointer(6, 3, gl.FLOAT, false, 12 * 4, 7 * 4); gl.vertexAttribDivisor(6, 1);
    };
    configureLeafVao(renderer.leafVao, renderer.leafSourceBuffer);
    configureLeafVao(renderer.fallingVao, renderer.fallingSourceBuffer);
    gl.bindVertexArray(null);

    const packLeaves = (collection) => { const packed = []; collection.forEach(leaf => packed.push(leaf.position[0], leaf.position[1], leaf.position[2], leaf.size, leaf.angle, leaf.cell, leaf.seed, leaf.tint[0], leaf.tint[1], leaf.tint[2], 0, 0)); return new Float32Array(packed); };
    renderer.uploadLeaves = (data) => {
      const staticLeaves = els.falling.checked ? data.leaves : data.allLeaves;
      gl.bindBuffer(gl.ARRAY_BUFFER, renderer.leafSourceBuffer); gl.bufferData(gl.ARRAY_BUFFER, packLeaves(staticLeaves), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, renderer.fallingSourceBuffer); gl.bufferData(gl.ARRAY_BUFFER, packLeaves(data.falling), gl.STATIC_DRAW);
      renderer.leafCount = staticLeaves.length; renderer.fallingCount = data.falling.length;
    };
    renderer.upload = (data) => {
      // One endpoint graph becomes one indexed quad-ring skin: no object-per-
      // branch seams, no cylinders embedded inside the parent, shared junction rings.
      const mesh = quadPipeMesh(data.nodes, data.segments, data.bark, data.barkLight);
      const branchData = mesh.vertices, indexData = mesh.indices;
      gl.bindVertexArray(renderer.branchVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, renderer.branchBuffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(branchData), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 36, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 36, 12);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 36, 24);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, renderer.branchIndex); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(indexData), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, renderer.branchLineIndex); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(mesh.lineIndices), gl.STATIC_DRAW);
      renderer.branchIndexCount = indexData.length; renderer.branchLineIndexCount = mesh.lineIndices.length;
      gl.bindVertexArray(null);
      renderer.uploadLeaves(data);
    };

    renderer.updateTexture = (source) => {
      gl.bindTexture(gl.TEXTURE_2D, renderer.texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    };
    renderer.resize = () => { const dpr = Math.min(window.devicePixelRatio || 1, 2), rect = els.canvas.getBoundingClientRect(); const width = Math.max(1, Math.round(rect.width * dpr)), height = Math.max(1, Math.round(rect.height * dpr)); if (els.canvas.width !== width || els.canvas.height !== height) { els.canvas.width = width; els.canvas.height = height; } };
    renderer.render = (time) => {
      renderer.resize();
      const width = els.canvas.width, height = els.canvas.height; gl.viewport(0, 0, width, height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!state.generated) return;
      const target = [state.camera.panX, state.generated.height * .43 + state.camera.panY, 0], pitch = state.camera.pitch, dist = state.camera.distance;
      const eye = [target[0] + Math.sin(state.camera.yaw) * dist * Math.cos(pitch), target[1] + Math.sin(pitch) * dist, target[2] + Math.cos(state.camera.yaw) * dist * Math.cos(pitch)];
      const camera = lookAt(eye, target), projection = perspective(Math.PI / 4.3, width / height, .05, 80);
      const wind = Number(els.wind.value) / 100;
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.disable(gl.CULL_FACE); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(branchProgram); gl.uniformMatrix4fv(gl.getUniformLocation(branchProgram, 'u_projection'), false, projection); gl.uniformMatrix4fv(gl.getUniformLocation(branchProgram, 'u_view'), false, camera.matrix); gl.uniform1f(gl.getUniformLocation(branchProgram, 'u_wire'), 0); gl.bindVertexArray(renderer.branchVao); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, renderer.branchIndex); gl.drawElements(gl.TRIANGLES, renderer.branchIndexCount, gl.UNSIGNED_INT, 0);
      if (state.showTopology) { gl.uniform1f(gl.getUniformLocation(branchProgram, 'u_wire'), 1); gl.depthMask(false); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, renderer.branchLineIndex); gl.drawElements(gl.LINES, renderer.branchLineIndexCount, gl.UNSIGNED_INT, 0); gl.depthMask(true); }
      gl.useProgram(leafProgram); gl.uniformMatrix4fv(gl.getUniformLocation(leafProgram, 'u_projection'), false, projection); gl.uniformMatrix4fv(gl.getUniformLocation(leafProgram, 'u_view'), false, camera.matrix); gl.uniform3fv(gl.getUniformLocation(leafProgram, 'u_camRight'), camera.right); gl.uniform3fv(gl.getUniformLocation(leafProgram, 'u_camUp'), camera.up); gl.uniform1f(gl.getUniformLocation(leafProgram, 'u_time'), time); gl.uniform1f(gl.getUniformLocation(leafProgram, 'u_wind'), wind); gl.uniform1f(gl.getUniformLocation(leafProgram, 'u_height'), state.generated.height); gl.uniform1f(gl.getUniformLocation(leafProgram, 'u_falling'), 0); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, renderer.texture); gl.uniform1i(gl.getUniformLocation(leafProgram, 'u_atlas'), 0); gl.depthMask(false); gl.bindVertexArray(renderer.leafVao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, renderer.leafCount);
      if (els.falling.checked && renderer.fallingCount) { gl.uniform1f(gl.getUniformLocation(leafProgram, 'u_falling'), 1); gl.bindVertexArray(renderer.fallingVao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, renderer.fallingCount); }
      gl.depthMask(true); gl.bindVertexArray(null);
    };
    state.gl = gl; return renderer;
  }

  function drawFallback() {
    els.canvas.classList.add('fallback-canvas');
    const ctx = els.canvas.getContext('2d');
    const render = () => {
      const rect = els.canvas.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2); els.canvas.width = rect.width * dpr; els.canvas.height = rect.height * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height);
      if (!state.generated) return;
      const scaleY = rect.height / (state.generated.height * 1.35), cx = rect.width / 2;
      ctx.lineCap = 'round'; state.generated.segments.forEach(s => { const a = state.generated.nodes[s.a].position, b = state.generated.nodes[s.b].position; ctx.beginPath(); ctx.moveTo(cx + a[0] * 50, rect.height - 58 - a[1] * scaleY); ctx.lineTo(cx + b[0] * 50, rect.height - 58 - b[1] * scaleY); ctx.strokeStyle = '#79543a'; ctx.lineWidth = Math.max(1, s.r1 * 22); ctx.stroke(); });
      const fallbackLeaves = els.falling.checked ? state.generated.leaves : state.generated.allLeaves;
      fallbackLeaves.forEach(l => { ctx.save(); ctx.translate(cx + l.position[0] * 50, rect.height - 58 - l.position[1] * scaleY); ctx.rotate(l.angle); ctx.fillStyle = '#71975b'; ctx.beginPath(); ctx.ellipse(0, 0, l.size * 24, l.size * 38, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore(); });
    }; state.renderer = { upload: () => {}, updateTexture: () => {}, render: render }; return state.renderer;
  }

  // --- UI wiring --------------------------------------------------------
  function setRangeProgress(input) { const min = Number(input.min), max = Number(input.max), value = Number(input.value); input.style.setProperty('--progress', `${((value - min) / (max - min)) * 100}%`); }
  function updateControls() {
    els.heightValue.textContent = `${Number(els.height.value).toFixed(1)} m`;
    els.branchingValue.textContent = `${els.branching.value}%`;
    els.densityValue.textContent = `${els.density.value}%`;
    els.seedValue.textContent = Number(els.seed.value).toLocaleString();
    els.windValue.textContent = `${els.wind.value}%`; els.strength.textContent = `${els.wind.value}%`;
    [els.height, els.branching, els.density, els.seed, els.wind].forEach(setRangeProgress);
    updateStats();
  }
  let generationTimer;
  function scheduleGeneration() { clearTimeout(generationTimer); generationTimer = setTimeout(generatePlant, 130); }
  [els.height, els.branching, els.density, els.seed].forEach(input => input.addEventListener('input', () => { updateControls(); scheduleGeneration(); }));
  els.wind.addEventListener('input', updateControls);
  els.falling.addEventListener('change', () => { updateStats(); if (state.renderer && state.generated && state.renderer.uploadLeaves) state.renderer.uploadLeaves(state.generated); });
  els.species.forEach(card => card.addEventListener('click', () => { els.species.forEach(other => other.classList.remove('active')); card.classList.add('active'); state.species = card.dataset.species; generatePlant(); }));
  els.atlas.addEventListener('change', () => { state.atlas = els.atlas.value; state.customAtlas = null; els.atlasName.textContent = `${els.atlas.options[els.atlas.selectedIndex].text.split(' / ')[0].toUpperCase()} ATLAS`; drawAtlas(state.atlas); if (state.renderer) state.renderer.updateTexture(els.atlasPreview); showToast('Leaf atlas assigned'); });
  els.upload.addEventListener('change', () => { const file = els.upload.files && els.upload.files[0]; if (!file) return; const image = new Image(); image.onload = () => { state.customAtlas = image; els.atlasName.textContent = 'IMPORTED ATLAS'; drawAtlas('', image); if (state.renderer) state.renderer.updateTexture(els.atlasPreview); showToast('Custom atlas imported'); }; image.src = URL.createObjectURL(file); });
  els.download.addEventListener('click', () => { const link = document.createElement('a'); link.download = `plantforge-${state.atlas}-atlas.png`; link.href = els.atlasPreview.toDataURL('image/png'); link.click(); showToast('Atlas downloaded'); });
  els.generate.addEventListener('click', generatePlant);
  els.randomize.addEventListener('click', () => { els.seed.value = Math.floor(Math.random() * 999998) + 1; updateControls(); generatePlant(); });
  els.reset.addEventListener('click', () => { state.species = defaults.species; els.species.forEach(card => card.classList.toggle('active', card.dataset.species === defaults.species)); Object.entries(defaults).forEach(([key, value]) => { const input = els[key]; if (input && input.type === 'checkbox') input.checked = value; else if (input) input.value = value; }); state.atlas = defaults.atlas; state.customAtlas = null; els.atlasName.textContent = 'BOTANICAL ATLAS'; drawAtlas(state.atlas); updateControls(); generatePlant(); showToast('Controls reset'); });
  els.pause.addEventListener('click', () => { state.paused = !state.paused; els.pauseLabel.textContent = state.paused ? 'Resume' : 'Pause'; els.pause.querySelector('.pause-icon').textContent = state.paused ? '▶' : 'Ⅱ'; });
  els.frame.addEventListener('click', () => { state.camera.yaw = .47; state.camera.pitch = .06; state.camera.distance = Math.max(10.5, Number(els.height.value) * 1.33); state.camera.panX = 0; state.camera.panY = 0; showToast('Camera framed'); });
  els.topology.addEventListener('click', () => { state.showTopology = !state.showTopology; els.topology.classList.toggle('active', state.showTopology); showToast(state.showTopology ? 'Welded topology overlay' : 'Topology overlay hidden'); els.live.textContent = state.showTopology ? 'Topology overlay: shared pipe-skin edges' : 'Topology overlay hidden'; });
  els.export.addEventListener('click', () => { const link = document.createElement('a'); link.download = `plantforge-${state.species}-${els.seed.value}.png`; link.href = els.canvas.toDataURL('image/png'); link.click(); showToast('Preview exported'); });
  // Blender navigation: MMB orbit, Shift+MMB pan, Ctrl+MMB dolly. LMB is
  // intentionally left free for future branch/tip selection tools.
  els.viewport.addEventListener('contextmenu', event => event.preventDefault());
  els.viewport.addEventListener('pointerdown', event => {
    if (event.button !== 1) return;
    event.preventDefault(); state.dragging = true; state.pointerX = event.clientX; state.pointerY = event.clientY;
    state.navMode = event.ctrlKey ? 'zoom' : event.shiftKey ? 'pan' : 'orbit'; els.viewport.setPointerCapture(event.pointerId);
  });
  els.viewport.addEventListener('pointermove', event => {
    if (!state.dragging) return;
    const dx = event.clientX - state.pointerX, dy = event.clientY - state.pointerY;
    if (state.navMode === 'pan') { const panScale = state.camera.distance * .0028; state.camera.panX -= dx * panScale; state.camera.panY += dy * panScale; }
    else if (state.navMode === 'zoom') state.camera.distance = clamp(state.camera.distance + dy * .035, 4.5, 24);
    else { state.camera.yaw += dx * .008; state.camera.pitch = clamp(state.camera.pitch + dy * .006, -.85, 1.45); }
    state.pointerX = event.clientX; state.pointerY = event.clientY;
  });
  els.viewport.addEventListener('pointerup', event => { state.dragging = false; state.navMode = null; if (els.viewport.hasPointerCapture(event.pointerId)) els.viewport.releasePointerCapture(event.pointerId); });
  els.viewport.addEventListener('pointercancel', () => { state.dragging = false; state.navMode = null; });
  els.viewport.addEventListener('wheel', event => { event.preventDefault(); state.camera.distance = clamp(state.camera.distance + event.deltaY * .012, 4.5, 24); }, { passive: false });
  function setHelp(open) { els.helpModal.classList.toggle('hidden', !open); }
  els.help.addEventListener('click', () => setHelp(true)); els.closeHelp.addEventListener('click', () => setHelp(false)); els.doneHelp.addEventListener('click', () => setHelp(false)); els.helpModal.addEventListener('click', e => { if (e.target === els.helpModal) setHelp(false); }); els.learn.addEventListener('click', e => { e.preventDefault(); setHelp(true); });
  document.addEventListener('keydown', event => {
    if (event.target.matches('input, select, textarea')) return;
    if (event.key.toLowerCase() === 'g') generatePlant();
    if (event.key.toLowerCase() === 'r') els.randomize.click();
    if (event.key.toLowerCase() === 'w') els.topology.click();
    if (event.code === 'Space') { event.preventDefault(); els.pause.click(); }
    if (event.key === 'Home' || event.key === '.') els.frame.click();
    // Blender-style orthographic-ish inspection views around the specimen.
    if (event.code === 'Numpad1') { state.camera.yaw = 0; state.camera.pitch = 0; }
    if (event.code === 'Numpad3') { state.camera.yaw = Math.PI / 2; state.camera.pitch = 0; }
    if (event.code === 'Numpad7') { state.camera.yaw = 0; state.camera.pitch = 1.35; }
    if (event.key === 'Escape') setHelp(false);
  });

  // Keep the animation loop on one clock. With falling leaves enabled, only
  // uniforms change every frame; no particle positions are allocated in JS.
  function frame(now) {
    const dt = Math.min(.1, (now - state.lastFrame) / 1000); state.lastFrame = now; if (!state.paused) state.time += dt;
    if (state.renderer && state.renderer.render) state.renderer.render(state.time);
    const ms = Math.max(1, dt * 1000); els.frameTime.textContent = `${ms.toFixed(1)} ms`;
    requestAnimationFrame(frame);
  }

  drawAtlas(defaults.atlas);
  state.renderer = createRenderer();
  if (state.renderer && state.renderer.updateTexture) state.renderer.updateTexture(els.atlasPreview);
  updateControls(); generatePlant(); requestAnimationFrame(frame);
})();
