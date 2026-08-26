# PlantForge

A no-build, research-informed English oak generator for a real-time vegetation workflow. Open `index.html` in a modern browser, or serve the folder locally:

```bash
python3 -m http.server 4173
```

## Current pass: one oak, real connected branch skin

- The UI is intentionally focused on one species: English oak (*Quercus robur*).
- The seeded centerline grows a persistent leader, puts substantial limbs through the lower two-thirds of the trunk, uses wider lower branch angles, and tapers every order.
- Child radii use a pipe-model-inspired area rule (`r_child ≈ r_parent / sqrt(outgoing pipes)`) rather than arbitrary independent thicknesses.
- Branch centerlines are converted into one signed-distance **surface-net pipe skin**. The resulting branch buffer is a single connected mesh; Y/N junctions are welded by the shared field instead of being separate capped cylinders.
- Leaves are created only at generated terminal branch attachments. A deterministic subset is removed from the static canopy and passed to the falling pool, so falling leaves begin at real branch-tip positions and leave visible gaps behind.

## GPU and interaction

- WebGL2 renders the connected branch mesh and instanced atlas leaf quads.
- Falling leaf positions, gravity loops, sway, and wind drift are evaluated in the GPU vertex shader. JavaScript only uploads stable attachment transforms when a seed is regenerated.
- Blender navigation is used in the viewport: **MMB drag** orbit, **Shift + MMB** pan, **Ctrl + MMB** dolly, wheel zoom, `Numpad 1/3/7` inspection views, `Home` or `.` frame, `Space` pause. Press `W` to inspect the welded topology overlay.
- Built-in 2×2 leaf atlases: Botanical, Autumn, and Ink study. Custom PNG/JPEG/WebP atlases can be imported and the current atlas can be downloaded.
- Generation, seed, branch, leaf, topology, and GPU-particle readouts are shown in the inspector.

The project intentionally has no bundler or runtime dependency so it can be dropped into a larger HTML reuse workflow. If WebGL2 is unavailable, the preview falls back to a basic 2D rendering pass.

## Research notes

The growth rules are based on the following observed principles: oak crowns are broad and irregular; strong structural limbs commonly occupy the lower two-thirds; wide attachment angles and a smaller branch diameter improve structural attachment; and branch systems are usefully modeled as connected pipes with taper and near-conserved cross-sectional area at forks. Sources consulted while shaping this pass:

- [Structural Development of Trees](https://auf.isa-arbor.com/content/6/4/105)
- [The effect of tree architecture on conduit diameter and frequency](https://academic.oup.com/treephys/article/30/11/1433/1678696)
- [Conjoining Trees: branch junction anatomy and pipe model theory](https://pubmed.ncbi.nlm.nih.gov/36987073/)
- [TBO-Tree-Gen: space colonization and quad-dominant tree meshes](https://github.com/TheBeautifulOrc/TBO-Tree-Gen)
- [Blender Pipe Joints](https://blender.stackexchange.com/questions/191890/t-junction-pipe)
