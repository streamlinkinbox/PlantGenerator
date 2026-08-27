# PlantGenerator

Procedural tree generator that builds a **skeleton out of vertices** and then **skins it into one
single watertight all-quad mesh** — no voxels, no booleans, no floating disconnected branch
cylinders. Branches are topologically welded into their parent limb.

```bash
npm install
npm run dev        # interactive viewer (Three.js)
npm run validate   # headless topology audit + OBJ export
npm run sweep      # audit 40 seeds
node scripts/validate.mjs --stress   # 30 randomized parameter sets
```

## The pipeline (the 5 stages in the viewer)

| stage | what you see | code |
|---|---|---|
| 1 · Vertices | the skeleton as a pure point cloud, grown outwards from the root | `src/core/skeleton.js` |
| 2 · Bones | those vertices linked into limbs (graph, not geometry yet) | `src/core/skeleton.js` |
| 3 · Hub boxes | a **box fitted at every junction vertex**, its axes aligned to the outgoing bones | `src/core/skin.js` |
| 4 · Quad cage | boxes extruded into sockets + limbs swept and stitched → **1 shell, quads only** | `src/core/skin.js` |
| 5 · Skin | Catmull-Clark subdivision of that same cage (still all quads) | `src/core/quadmesh.js` |

### 1. Skeleton (vertices only)

Breadth-first recursive branching with phyllotaxis roll, gravitropism, per-segment curl,
length falloff and a hard vertex budget. **Stages 1–2 are live**: dragging a shape slider
rebuilds only the point cloud (~80 ms on the default tree, overlap solver skipped) and the box /
quad / subdivision chain below it is not run at all. It is upgraded to a full solve when you stop
dragging, and the skin is built lazily the first time you look at stage 3/4/5 (or export).

#### Thickness: da Vinci's rule, not an arbitrary falloff

Branch radii come from the **pipe model / Leonardo da Vinci's rule** rather than a per-level
multiplier — that constant multiplier is exactly why every twig used to look the same size:

```
r_parent^α = Σ r_child^α          α = "Leonardo exponent", 1.8–2.3 measured in real species
```

α = 2 is exact cross-section (area) preservation, which is what da Vinci observed; measurements
across species put it between 1.8 and 2.3 and it is species-dependent, so it is a slider
(`pipeExponent`). Real stems also taper *between* forks (WBE / Mäkelä pipe-theory taper), so each
bone adds a length-proportional term (`taperRate`). Radii are solved in units of "one twig tip"
from the leaves down, then scaled so the base matches the requested `trunkRadius` — so a twig is
thin because of how little tree hangs off it, and a bough is fat because of how much does.

On top of that, three morphological features from the arboriculture literature:

* **branch collar** — the swelling where branch and trunk growth rings overlap. Applied with an
  exponential falloff over a couple of radii and weighted by how *lateral* the branch is, so a
  thin side branch gets a pronounced collar and a dominant leader almost none;
* **root flare** — the trunk thickening toward the ground;
* **correlated thickness noise** — so no two twigs are identical cylinders.

The result: a 1 : 30-ish trunk-to-twig radius ratio that follows the branching structure, with a
visible U-shaped attachment and collar at every fork. Several clean-up passes run before anything is skinned, and they are what make the skinning safe:

* `limitJunctionDegree` — a hub box only has 6 faces (and needs good ones), so no vertex carries
  more than 4 bones. Overcrowded junctions are split into two junctions joined by a short bone.
* `separateJunctions` — **intersection handling at the source**: sibling bones leaving a junction
  are rotated apart (whole sub-tree rotates with them) until their angular separation is larger
  than what their radii need. Two branches can no longer leave in almost the same direction and
  interpenetrate.
* `enforceBoneLength` — every bone is made long enough that the two hub boxes at its ends cannot
  overlap, including room for the socket that sits beyond the box corners; short bones are the
  number one cause of self-intersecting skins.
* `resolveCollisions` — capsule/capsule tests on a uniform grid, using a **tree metric** so that
  bones which are close *along the skeleton* (consecutive segments, siblings at a junction) are
  allowed to touch while genuinely crossing branches are not. Offenders are rotated apart about
  the junction they grew from; whatever still intersects afterwards is **self-pruned**. Result:
  `0` intersecting branch pairs, verified in the audit.
* `smoothChains` — Laplacian smoothing of degree-2 vertices; kinky skeletons fold quads.

### 2. Skinning — B-Mesh / "skin modifier" style, with the split handled explicitly

Hubs are built lazily in breadth-first order **while** the limbs are swept, so every hub inherits
the frame of the tube arriving at it. For every junction vertex (degree ≥ 3):

1. build a **box** centred on the vertex, `a0` pointing back down the incoming bone (so
   `FACES[0]` always belongs to the parent);
2. **spin the box** about that bone until the parent socket loop lands exactly on the arriving
   loop → residual twist 0. The box has 4-fold symmetry, so the leftover roll in (−45°, 45°] is
   free: a 19-step search spends it on making sure **every child sits on a face that points the
   way it grows**. Whatever roll is used is handed back to the sweeper and spread as a gentle
   spiral over the limb's loops instead of one sheared row of quads;
3. each remaining bone claims **one distinct box face** — optimal assignment over the 5 free
   faces maximizing alignment;
4. box corners are **fitted to the envelope of the outgoing branches** (each contribution clamped
   by that branch's own socket plane, and the corner-scale field smoothed over the cube graph) so
   the crotch gets a real saddle/fillet instead of a blobby cube;
5. the claimed face is **extruded** into a socket loop through a **graded collar**: the section
   shrinks geometrically over 1–6 rows, so a fat trunk dropping onto a thin twig never does it in
   one sheared row. The socket plane is always pushed clear of every corner of its own face, so a
   loop can never land on a corner and collapse to a point;
6. the ring frame is measured **around the face centre**, not the hub centre — measuring from the
   hub centre projects a tilted face's four corners into a half-plane, which turns the corner
   order into a bow tie and crosses the collar quads (this was the visible "branches squeezed to
   a point" bug);
7. faces nobody claimed stay as plain box faces, so the hub is always a closed solid.

Limbs (chains of degree-2 vertices) are **uniformly resampled** between the two socket planes
(even spacing → even quads, never closer than 0.8 local radii) and swept with a
**parallel-transport frame**. At the far end the loop is **rotationally matched** against the
socket loop before bridging. Tips taper over evenly spaced loops into one quad cap.

Everything is emitted into a single `QuadMesh`, welded once, and that is the deliverable mesh.

These passes alternate (length fix → separate → length fix → separate + prune) because pushing
one constraint can break the other.

### 3. Bark — geometry, not a texture (trunk only, for now)

Stage 6 grows bark as **real displaced quads**: no UVs, no tiling, nothing to bake against.

**Why bark cracks.** The vascular cambium keeps adding wood, so the stem's girth grows, but the
outer bark (periderm / rhytidome) is dead and rigid and cannot grow with it. The girth increase
puts the outer layer in **tangential (circumferential) tension** until it ruptures, and because
the tension is tangential the fractures open perpendicular to it — which is why bark fissures run
**vertically**, with ridges between them (Braun 1955; [Cork-Containing Barks review, *Frontiers in
Materials* 2016](https://www.frontiersin.org/journals/materials/articles/10.3389/fmats.2016.00063/full);
[Meliaceae bark study, *Trees* 2025](https://link.springer.com/article/10.1007/s00468-025-02661-7)).
When elastic parenchyma redistributes some of that stress lengthwise the ridges also crack
transversally and the pattern becomes **reticulate** — that is the `reticulation` slider.

**How it is simulated.** Federl & Prusinkiewicz model exactly this as a **bi-layered material**: a
rigid outer layer bonded to a growing substrate, discretised as a mass-spring lattice (*A Texture
Model for Cracked Surfaces, with an Application to Tree Bark*, WCGS 1996; *Modelling Fracture
Formation in Bi-layered Materials*, WCGS 2002) or FEM (*Finite Element Model of Fracture Formation
on Growing Surfaces*, ICCS 2004). Dale, Runions, Hobill & Prusinkiewicz use the same mass-spring
formulation for [bark patterning in grasstrees](https://algorithmicbotany.org/papers/modelling-biomechanics-of-bark.pdf)
(*Annals of Botany* 114:629, 2014). This implementation follows that model:

1. the trunk surface is **unrolled** into a periodic (arc-length, height) strip and discretised as
   a spring lattice — one cell per half ridge;
2. the substrate is **inflated** step by step; each node is bonded to its substrate point;
3. springs whose strain passes a randomised toughness threshold **rupture**. Toughness is
   **anisotropic** — cork and phloem fibres run lengthwise, so tearing along the grain (what hoop
   tension does) is far easier than across it, which is what orients the fissures;
4. only a small budget of the worst-loaded springs fails per pass, and the continuation of an
   existing fissure gets an explicit **crack-tip** advantage, so cracks *propagate* into long
   lines instead of nucleating as scattered pits;
5. the bond stiffness comes from **shear lag**: a fissure unloads the sheet either side of itself
   over `L = cell·√(k_spring/k_bond)`, so the requested ridge width pins `k_bond = (cell/ridge)²`.
   Growth stops the moment the pattern reaches the requested fissure density;
6. the resulting fissure network is turned into **line segments** and carved into the mesh as
   displacement along the vertex normals — V-shaped grooves with flat-topped ridges, per the
   [macroscopic bark terminology](https://www.researchgate.net/publication/52001585_Survey_of_English_Macroscopic_Bark_Terminology)
   ("grooves with width less than the flat-topped ridges separating them"), plus a crowned ridge
   and a fine fibrous grain.

The trunk is **locally refined** first (`src/core/refine.js`) with parity-correct all-quad
transition templates, so only the trunk carries the ~1 cm grid the relief needs.

**Honest limitation.** A quad mesh cannot have a lone hanging node (a pentagon has no
quadrangulation), so an edge split necessarily propagates along its whole edge ring. The bark
patch itself comes out clean — 58k faces, max aspect **13:1**, 2 slivers — but each refinement
level also slices a band through the rest of the tree, leaving stretched (not degenerate) quads
there: with the default 5 levels that band is large. The topology is unaffected (still all quads,
watertight, one shell, χ = 2, zero pinched faces) and the *shape* is unchanged, since those are
flat splits. Lowering `barkMaxLevels`, or subdividing the tree globally before growing bark,
trades bark resolution for a tidier surrounding grid. A graded transition patch is the proper fix
and is not implemented yet.

```bash
node scripts/validate.mjs --bark --seed 7 --out out/bark.obj
node scripts/render.mjs --seed 7 --bark --trunk --zoom 2.6 --out bark.png
```

### 4. Subdivision

Catmull-Clark (`quad in → quad out`, boundary/crease-aware) on the control cage. Loop radii are
pre-compensated (`radiusCompensation`) for subdivision shrinkage.

## Topology guarantees (checked, not claimed)

`QuadMesh.validate()` runs on every rebuild and is shown live in the viewer panel:

```
$ npm run validate -- --seed 7 --subdiv 2
skeleton : { vertices: 3382, bones: 3381, junctions: 503, tips: 521 }
cage     : { vertices: 35424, faces: 35422, quadsOnly: true,
             boundaryEdges: 0, nonManifoldEdges: 0, flippedEdges: 0,
             shells: 1, looseVertices: 0, euler: 2, genus: 0,
             watertight: true, singleMesh: true }
quality  : { maxAspect: 6.16, slivers: 0, pinched: 0, clean: true }
overlaps : { pairs: 0, worstPenetration: 0 }   (385 found and fixed while growing)
valence  : { '3': 2084, '4': 31280, '5': 2044, '6': 16 }
subdiv x2: 566754 v / 566752 quads, still 1 shell, χ=2, watertight
```

* **quads only** — zero triangles, zero n-gons, at every subdivision level
* **watertight** — 0 boundary edges (every edge shared by exactly 2 faces)
* **manifold + consistently wound** — 0 non-manifold edges, 0 duplicated directed edges
* **one mesh** — 1 connected shell, χ = 2, genus 0 (a topological sphere)
* **no loose vertices**
* ~88 % of vertices are regular (valence 4); the poles are the unavoidable 3/5-valence
  vertices around each junction hub

Geometry is audited separately from topology, because a mesh can be topologically perfect and
still be garbage:

* **no pinched quads** — no quad has a collapsed edge (this used to happen where a socket loop
  landed on a box corner: aspect ratios up to 1094:1). Now `maxAspect ≈ 6:1`
* **no mirrored sockets** — every socket loop is wound the same way as its bone, so no bridge
  ever gets a half-quad twist
* **no intersecting branches** — 0 capsule-overlapping bone pairs after resolution

`npm run sweep` (40 seeds) passes all of the above. `--stress` (30 randomized parameter sets)
passes topology, overlap and pinch checks; deliberately absurd combinations (a trunk thinner than
its own twigs, 80° branch angles on a 1-unit trunk) can still leave a handful of sliver quads
around 15:1 in the control cage.

## Headless tooling

```bash
node scripts/validate.mjs --seed 12 --subdiv 2 --out out/tree.obj   # export quads to OBJ
node scripts/render.mjs --seed 7 --subdiv 2 --out shot.png          # software-rendered PNG
node scripts/render.mjs --seed 7 --subdiv 0 --wire --skeleton --out cage.png
```

The OBJ writer emits real `f a b c d` quad faces, so the mesh imports into Blender/Maya as quads.

## Layout

```
src/core/vec3.js      tiny vector math (no deps, runs in node + browser)
src/core/rng.js       seedable mulberry32
src/core/skeleton.js  vertex/bone generation + junction conditioning
src/core/skin.js      hub boxes, socket extrusion, limb sweeping, stitching
src/core/quadmesh.js  quad container, welding, Catmull-Clark, topology audit, OBJ
src/core/refine.js    local all-quad refinement (parity-correct transition templates)
src/core/bark.js      trunk selection, bi-layer growth-fracture sim, bark displacement
src/app/              Three.js viewer (stages, params, live audit, OBJ export)
scripts/              headless validate / sweep / stress / render
```
