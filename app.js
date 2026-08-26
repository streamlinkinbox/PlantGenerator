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
    falling: $('#fallingLeaves'), generate: $('#generateBtn'), randomize: $('#randomizeBtn'), reset: $('#resetBtn'), pause: $('#pauseBtn'), pauseLabel: $('#pauseLabel'), frame: $('#frameBtn'), export: $('#exportBtn'),
    stageSpecies: $('#stageSpecies'), branchCount: $('#branchCount'), leafCount: $('#leafCount'), particleCount: $('#particleCount'), frameTime: $('#frameTime'), code: $('#codeLabel'), generationTime: $('#generationTime'), paletteName: $('#paletteName'), toast: $('#renderToast'), live: $('#liveRegion'),
    help: $('#helpBtn'), helpModal: $('#helpModal'), closeHelp: $('#closeHelp'), doneHelp: $('#doneHelp'), learn: $('#learnLink'), direction: $('#windDirectionValue'), strength: $('#windStrengthValue')
  };

  const defaults = { species: 'oak', height: 7.4, branching: 64, density: 78, seed: 482106, wind: 38, atlas: 'botanical', falling: true };
  const speciesInfo = {
    oak: { label: 'Oak', stage: 'OAK CANOPY', code: 'OAK', palette: 'MOSS / BARK', maxDepth: 4, baseChildren: 2, spread: .52, taper: .72, leafBase: 22, colors: ['#354d35', '#527b54', '#80a765', '#a9c47b'] },
    pine: { label: 'Pine', stage: 'PINE LAYER', code: 'PINE', palette: 'PINE / NEEDLE', maxDepth: 5, baseChildren: 2, spread: .31, taper: .78, leafBase: 15, colors: ['#1f493c', '#2c6850', '#477e57', '#6f9a61'] },
    willow: { label: 'Willow', stage: 'WILLOW CASCADE', code: 'WILLOW', palette: 'MOSS / GOLD', maxDepth: 4, baseChildren: 3, spread: .72, taper: .68, leafBase: 19, colors: ['#4b6f4d', '#6e9560', '#a6b96b', '#c8ba70'] },
    fern: { label: 'Fern', stage: 'FERN ROSETTE', code: 'FERN', palette: 'FROND / SOIL', maxDepth: 3, baseChildren: 4, spread: .85, taper: .56, leafBase: 13, colors: ['#2c5a3e', '#428057', '#73a466', '#a4c479'] }
  };

  const state = {
    species: defaults.species, atlas: defaults.atlas, generated: null, paused: false, time: 0, lastFrame: performance.now(),
    camera: { yaw: .47, pitch: .06, distance: 11.3 }, dragging: false, pointerX: 0, pointerY: 0, customAtlas: null, gl: null, renderer: null
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

  // Builds a low-poly bark tube between two 3D points.
  function cylinderMesh(a, b, radiusA, radiusB, colorA, colorB, sides = 7) {
    const vertices = [], indices = [];
    const axis = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    let ref = Math.abs(axis[1]) > .85 ? [1, 0, 0] : [0, 1, 0];
    let u = norm([axis[1] * ref[2] - axis[2] * ref[1], axis[2] * ref[0] - axis[0] * ref[2], axis[0] * ref[1] - axis[1] * ref[0]]);
    let v = [axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0]];
    for (let ring = 0; ring < 2; ring++) {
      const center = ring ? b : a, radius = ring ? radiusB : radiusA, color = ring ? colorB : colorA;
      for (let side = 0; side < sides; side++) {
        const theta = (side / sides) * Math.PI * 2;
        const radial = add(scale(u, Math.cos(theta) * radius), scale(v, Math.sin(theta) * radius));
        vertices.push(center[0] + radial[0], center[1] + radial[1], center[2] + radial[2], color[0], color[1], color[2]);
      }
    }
    for (let side = 0; side < sides; side++) {
      const next = (side + 1) % sides, a0 = side, a1 = next, b0 = sides + side, b1 = sides + next;
      indices.push(a0, b0, a1, a1, b0, b1);
    }
    return { vertices, indices };
  }

  function generatePlant() {
    const started = performance.now();
    const species = speciesInfo[state.species];
    const height = Number(els.height.value), branching = Number(els.branching.value), density = Number(els.density.value);
    const random = rngFactory(Number(els.seed.value));
    const segments = [], leaves = [], tips = [];
    const bark = hexRgb(state.species === 'pine' ? '#392d23' : state.species === 'fern' ? '#493a2b' : '#4b3527');
    const barkLight = hexRgb(state.species === 'willow' ? '#876342' : '#75513a');
    const leafColors = species.colors.map(hexRgb);
    const depthMax = species.maxDepth;

    const addBranch = (start, direction, length, radius, depth, forkBias = 0) => {
      const bend = [
        (random() - .5) * species.spread * .24,
        (random() - .35) * .12,
        (random() - .5) * species.spread * .24
      ];
      const nextDirection = norm(add(direction, bend));
      const end = add(start, scale(nextDirection, length));
      const c1 = bark.map((v, i) => v * (1 + (random() - .5) * .08) + (i === 0 ? .015 : 0));
      const c2 = barkLight.map((v, i) => v * (1 + (random() - .5) * .08));
      segments.push({ a: start, b: end, r1: radius, r2: Math.max(.008, radius * species.taper), c1, c2, depth });

      if (depth <= 0 || segments.length > 540) {
        tips.push({ point: end, direction: nextDirection, depth });
        return;
      }
      const heightRatio = end[1] / Math.max(height, .01);
      let children = species.baseChildren + (branching > 72 && depth > 1 ? 1 : 0) - (branching < 38 && depth > 1 ? 1 : 0);
      if (species === speciesInfo.fern) children = depth === depthMax ? 3 : 2;
      children = clamp(children, 1, 4);
      if (random() > .22 + branching / 160 && depth > 1) children = Math.max(1, children - 1);
      for (let i = 0; i < children; i++) {
        const t = species === speciesInfo.willow ? mix(.58, .92, random()) : mix(.72, .98, random());
        const branchStart = lerpVec(start, end, t);
        const theta = (i / children) * Math.PI * 2 + random() * 1.2 + forkBias;
        const lateral = species.spread * (0.42 + random() * .45) * (1.05 - heightRatio * .22);
        let childDirection = norm([Math.cos(theta) * lateral, .76 + random() * .45, Math.sin(theta) * lateral]);
        if (state.species === 'pine') childDirection = norm([Math.cos(theta) * lateral, 1.1 + random() * .34, Math.sin(theta) * lateral]);
        if (state.species === 'willow') childDirection = norm([Math.cos(theta) * lateral * .9, .48 + random() * .3, Math.sin(theta) * lateral * .9]);
        if (state.species === 'fern') childDirection = norm([Math.cos(theta) * (1.2 + random() * .45), .55 + random() * .55, Math.sin(theta) * (1.2 + random() * .45)]);
        addBranch(branchStart, childDirection, length * (state.species === 'fern' ? .66 : .61 + random() * .08), radius * (.57 + random() * .1), depth - 1, theta * .17);
      }
      if (depth === depthMax) tips.push({ point: end, direction: nextDirection, depth });
    };

    const trunkDir = state.species === 'fern' ? [0, 1, 0] : [0, 1, 0];
    if (state.species === 'fern') {
      // Ferns start as a radial set of fronds rather than a single woody trunk.
      const fronds = 7 + Math.round(branching / 25);
      for (let i = 0; i < fronds; i++) {
        const theta = i / fronds * Math.PI * 2 + random() * .4;
        addBranch([0, .03, 0], norm([Math.cos(theta) * 1.5, .5 + random() * .3, Math.sin(theta) * 1.5]), height * .2, .075, depthMax, theta);
      }
    } else {
      addBranch([0, 0, 0], trunkDir, height * .30, .25, depthMax, random() * 2);
      addBranch([0, height * .20, 0], norm([.05 + random() * .08, 1, .04 + random() * .08]), height * .16, .21, depthMax - 1, random() * 2);
    }

    // Add a crown of atlas-sampled leaf instances at every branch end. This is
    // intentionally CPU-side only at generation time; motion is GPU-side.
    const densityFactor = density / 100;
    const perTip = state.species === 'pine' ? 15 : state.species === 'fern' ? 11 : state.species === 'willow' ? 18 : 21;
    for (const tip of tips) {
      const count = Math.max(2, Math.round(perTip * densityFactor * (.8 + random() * .45)));
      for (let i = 0; i < count; i++) {
        const around = random() * Math.PI * 2;
        const radial = (state.species === 'pine' ? .16 : .26) * Math.sqrt(random());
        const vertical = (random() - .3) * (state.species === 'willow' ? .62 : .38);
        const point = add(tip.point, [Math.cos(around) * radial, vertical, Math.sin(around) * radial]);
        const size = (state.species === 'fern' ? .11 : .14) * (.72 + random() * .52) * (state.species === 'pine' ? .78 : 1);
        leaves.push({ position: point, size, angle: random() * Math.PI * 2, cell: Math.floor(random() * 4), seed: random(), tint: leafColors[Math.floor(random() * leafColors.length)] });
      }
    }

    // A separate, stable pool is passed to the falling-leaf shader. Its values
    // never change after generation, so replaying a seed replays the same wind.
    const fallingCount = state.species === 'fern' ? 90 : 180;
    const falling = [];
    for (let i = 0; i < fallingCount; i++) {
      const source = leaves[Math.floor(random() * Math.max(1, leaves.length))] || { position: [0, height, 0] };
      falling.push({ position: [source.position[0] + (random() - .5) * 1.2, Math.max(.4, source.position[1] - random() * height * .1), source.position[2] + (random() - .5) * 1.2], size: .065 + random() * .065, angle: random() * Math.PI * 2, cell: Math.floor(random() * 4), seed: random(), tint: leafColors[Math.floor(random() * leafColors.length)] });
    }

    state.generated = { segments, leaves, falling, height, duration: performance.now() - started };
    updateStats();
    if (state.renderer) state.renderer.upload(state.generated);
    showToast('Specimen regenerated');
    els.live.textContent = `${species.label} specimen generated from seed ${els.seed.value}`;
  }

  function updateStats() {
    if (!state.generated) return;
    const species = speciesInfo[state.species];
    els.stageSpecies.textContent = species.stage;
    els.code.textContent = `PF-${species.code}-${String(els.seed.value).padStart(6, '0')}`;
    els.branchCount.textContent = state.generated.segments.length.toLocaleString();
    els.leafCount.textContent = state.generated.leaves.length.toLocaleString();
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
    ctx.fillStyle = type === 'ink' ? '#e5ebe0' : '#ebead7'; ctx.fillRect(0, 0, canvas.width, canvas.height);
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
    uniform mat4 u_projection;
    uniform mat4 u_view;
    out vec3 v_color;
    void main() { v_color = a_color; gl_Position = u_projection * u_view * vec4(a_position, 1.0); }`;
  const branchFragment = `#version 300 es
    precision highp float;
    in vec3 v_color;
    out vec4 outColor;
    void main() { outColor = vec4(v_color, 1.0); }`;
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
        float fall = mod(u_time * (.23 + a_seed * .27) + a_seed * cycle, cycle);
        world.y = a_offset.y + .6 - fall;
        world.x += sin(u_time * (.75 + a_seed) + phase) * (.12 + u_wind * .18);
        world.z += cos(u_time * (.58 + a_seed) + phase) * (.08 + u_wind * .13);
        world.x += u_wind * fall * .12;
      }
      float ca = cos(a_angle), sa = sin(a_angle);
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
    const renderer = { gl, branchProgram, leafProgram, branchVao: gl.createVertexArray(), leafVao: gl.createVertexArray(), fallingVao: gl.createVertexArray(), branchBuffer: gl.createBuffer(), branchIndex: gl.createBuffer(), leafBuffer: gl.createBuffer(), leafSourceBuffer: gl.createBuffer(), fallingSourceBuffer: gl.createBuffer(), texture: gl.createTexture(), branchIndexCount: 0, leafCount: 0, fallingCount: 0 };

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

    renderer.upload = (data) => {
      const branchData = [], indexData = [];
      data.segments.forEach(segment => {
        const mesh = cylinderMesh(segment.a, segment.b, segment.r1, segment.r2, segment.c1, segment.c2);
        const offset = branchData.length / 6;
        branchData.push(...mesh.vertices); indexData.push(...mesh.indices.map(index => index + offset));
      });
      gl.bindVertexArray(renderer.branchVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, renderer.branchBuffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(branchData), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, renderer.branchIndex); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(indexData), gl.STATIC_DRAW);
      renderer.branchIndexCount = indexData.length;
      gl.bindVertexArray(null);
      const packLeaves = (collection) => { const packed = []; collection.forEach(leaf => packed.push(leaf.position[0], leaf.position[1], leaf.position[2], leaf.size, leaf.angle, leaf.cell, leaf.seed, leaf.tint[0], leaf.tint[1], leaf.tint[2], 0, 0)); return new Float32Array(packed); };
      gl.bindBuffer(gl.ARRAY_BUFFER, renderer.leafSourceBuffer); gl.bufferData(gl.ARRAY_BUFFER, packLeaves(data.leaves), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, renderer.fallingSourceBuffer); gl.bufferData(gl.ARRAY_BUFFER, packLeaves(data.falling), gl.STATIC_DRAW);
      renderer.leafCount = data.leaves.length; renderer.fallingCount = data.falling.length;
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
      const target = [0, state.generated.height * .43, 0], pitch = state.camera.pitch, dist = state.camera.distance;
      const eye = [Math.sin(state.camera.yaw) * dist * Math.cos(pitch), target[1] + Math.sin(pitch) * dist, Math.cos(state.camera.yaw) * dist * Math.cos(pitch)];
      const camera = lookAt(eye, target), projection = perspective(Math.PI / 4.3, width / height, .05, 80);
      const wind = Number(els.wind.value) / 100;
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.disable(gl.CULL_FACE); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(branchProgram); gl.uniformMatrix4fv(gl.getUniformLocation(branchProgram, 'u_projection'), false, projection); gl.uniformMatrix4fv(gl.getUniformLocation(branchProgram, 'u_view'), false, camera.matrix); gl.bindVertexArray(renderer.branchVao); gl.drawElements(gl.TRIANGLES, renderer.branchIndexCount, gl.UNSIGNED_INT, 0);
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
      ctx.lineCap = 'round'; state.generated.segments.forEach(s => { ctx.beginPath(); ctx.moveTo(cx + s.a[0] * 50, rect.height - 58 - s.a[1] * scaleY); ctx.lineTo(cx + s.b[0] * 50, rect.height - 58 - s.b[1] * scaleY); ctx.strokeStyle = '#79543a'; ctx.lineWidth = Math.max(1, s.r1 * 22); ctx.stroke(); });
      state.generated.leaves.forEach(l => { ctx.save(); ctx.translate(cx + l.position[0] * 50, rect.height - 58 - l.position[1] * scaleY); ctx.rotate(l.angle); ctx.fillStyle = '#71975b'; ctx.beginPath(); ctx.ellipse(0, 0, l.size * 24, l.size * 38, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore(); });
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
  els.falling.addEventListener('change', updateStats);
  els.species.forEach(card => card.addEventListener('click', () => { els.species.forEach(other => other.classList.remove('active')); card.classList.add('active'); state.species = card.dataset.species; generatePlant(); }));
  els.atlas.addEventListener('change', () => { state.atlas = els.atlas.value; state.customAtlas = null; els.atlasName.textContent = `${els.atlas.options[els.atlas.selectedIndex].text.split(' / ')[0].toUpperCase()} ATLAS`; drawAtlas(state.atlas); if (state.renderer) state.renderer.updateTexture(els.atlasPreview); showToast('Leaf atlas assigned'); });
  els.upload.addEventListener('change', () => { const file = els.upload.files && els.upload.files[0]; if (!file) return; const image = new Image(); image.onload = () => { state.customAtlas = image; els.atlasName.textContent = 'IMPORTED ATLAS'; drawAtlas('', image); if (state.renderer) state.renderer.updateTexture(els.atlasPreview); showToast('Custom atlas imported'); }; image.src = URL.createObjectURL(file); });
  els.download.addEventListener('click', () => { const link = document.createElement('a'); link.download = `plantforge-${state.atlas}-atlas.png`; link.href = els.atlasPreview.toDataURL('image/png'); link.click(); showToast('Atlas downloaded'); });
  els.generate.addEventListener('click', generatePlant);
  els.randomize.addEventListener('click', () => { els.seed.value = Math.floor(Math.random() * 999998) + 1; updateControls(); generatePlant(); });
  els.reset.addEventListener('click', () => { state.species = defaults.species; els.species.forEach(card => card.classList.toggle('active', card.dataset.species === defaults.species)); Object.entries(defaults).forEach(([key, value]) => { const input = els[key]; if (input && input.type === 'checkbox') input.checked = value; else if (input) input.value = value; }); state.atlas = defaults.atlas; state.customAtlas = null; els.atlasName.textContent = 'BOTANICAL ATLAS'; drawAtlas(state.atlas); updateControls(); generatePlant(); showToast('Controls reset'); });
  els.pause.addEventListener('click', () => { state.paused = !state.paused; els.pauseLabel.textContent = state.paused ? 'Resume' : 'Pause'; els.pause.querySelector('.pause-icon').textContent = state.paused ? '▶' : 'Ⅱ'; });
  els.frame.addEventListener('click', () => { state.camera.yaw = .47; state.camera.pitch = .06; state.camera.distance = Math.max(10.5, Number(els.height.value) * 1.33); showToast('Camera framed'); });
  els.export.addEventListener('click', () => { const link = document.createElement('a'); link.download = `plantforge-${state.species}-${els.seed.value}.png`; link.href = els.canvas.toDataURL('image/png'); link.click(); showToast('Preview exported'); });
  els.viewport.addEventListener('pointerdown', event => { state.dragging = true; state.pointerX = event.clientX; state.pointerY = event.clientY; els.viewport.setPointerCapture(event.pointerId); });
  els.viewport.addEventListener('pointermove', event => { if (!state.dragging) return; state.camera.yaw += (event.clientX - state.pointerX) * .008; state.camera.pitch = clamp(state.camera.pitch + (event.clientY - state.pointerY) * .006, -.72, .7); state.pointerX = event.clientX; state.pointerY = event.clientY; });
  els.viewport.addEventListener('pointerup', () => { state.dragging = false; });
  els.viewport.addEventListener('pointercancel', () => { state.dragging = false; });
  els.viewport.addEventListener('wheel', event => { event.preventDefault(); state.camera.distance = clamp(state.camera.distance + event.deltaY * .012, 4.5, 24); }, { passive: false });
  function setHelp(open) { els.helpModal.classList.toggle('hidden', !open); }
  els.help.addEventListener('click', () => setHelp(true)); els.closeHelp.addEventListener('click', () => setHelp(false)); els.doneHelp.addEventListener('click', () => setHelp(false)); els.helpModal.addEventListener('click', e => { if (e.target === els.helpModal) setHelp(false); }); els.learn.addEventListener('click', e => { e.preventDefault(); setHelp(true); });
  document.addEventListener('keydown', event => { if (event.target.matches('input, select, textarea')) return; if (event.key.toLowerCase() === 'g') generatePlant(); if (event.key.toLowerCase() === 'r') els.randomize.click(); if (event.code === 'Space') { event.preventDefault(); els.pause.click(); } if (event.key === 'Escape') setHelp(false); });

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
