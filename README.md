# PlantForge

A no-build procedural plant and tree generator. Open `index.html` in a modern browser, or serve the folder locally:

```bash
python3 -m http.server 4173
```

## What is included

- Seeded Oak, Pine, Willow, and Fern generators with height, branching, density, and seed controls.
- Low-poly branch geometry generated once per specimen and rendered through WebGL2.
- Instanced leaf quads sampled from a four-tile texture atlas.
- Botanical, Autumn, and Ink atlas presets, plus PNG/JPEG/WebP atlas import and atlas download.
- GPU falling-leaf particles: leaf phase, gravity loop, sway, and wind drift are evaluated in the vertex shader. The generated particle pool is stable for a given seed.
- Orbit, zoom, pause, frame, PNG export, keyboard shortcuts, and a WebGL2/GPU status treatment.

The project intentionally has no bundler or runtime dependency so it can be dropped into a larger HTML reuse workflow. If WebGL2 is unavailable, the preview falls back to a simple 2D rendering pass.
