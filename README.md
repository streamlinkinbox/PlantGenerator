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
length/radius falloff and a hard vertex budget. Three clean-up passes run before anything is
skinned, and they are what make the skinning safe:

* `limitJunctionDegree` — a hub box only has 6 faces, so no vertex may carry more than 6 bones.
  Overcrowded junctions are split into two junctions joined by a short bone.
* `separateJunctions` — **intersection handling at the source**: sibling bones leaving a junction
  are rotated apart (whole sub-tree rotates with them) until their angular separation is larger
  than what their radii need. Two branches can no longer leave in almost the same direction and
  interpenetrate.
* `enforceBoneLength` — every bone is made long enough that the two hub boxes at its ends cannot
  overlap; short bones are the number one cause of self-intersecting skins.

### 2. Skinning — B-Mesh / "skin modifier" style

For every junction vertex (degree ≥ 3):

1. build a **box** centred on the vertex, `a0` aligned with the thickest limb;
2. each outgoing bone claims **one distinct box face** — solved as an optimal assignment
   (brute-force over the 6 faces) maximizing `dot(boneDir, faceNormal)`;
3. that face is **extruded** into a socket ring: the face is removed, 4 side quads bridge the
   original box corners to a 4-vertex loop placed on the bone axis. The box stays a closed solid,
   the socket is welded into it — the branch is *part of* the trunk, not glued on top of it;
4. faces nobody claimed stay as plain box faces, so the hub is always closed.

Limbs (chains of degree-2 vertices) are swept as quad tubes with a **parallel-transport frame**
(no twist accumulation) and a loop budget (`loopSpacing` / `maxTurn`) so loops only appear where
curvature actually needs them. At the far end the tube's loop is **rotationally matched** against
the target socket loop (4 candidate offsets, minimum total distance) before bridging, so the quad
loops line up with no seam and no crossed quads. Tips get a taper + one quad cap.

Everything is emitted into a single `QuadMesh`, welded once, and that is the deliverable mesh.

### 3. Subdivision

Catmull-Clark (`quad in → quad out`, boundary/crease-aware) on the control cage. Loop radii are
pre-compensated (`radiusCompensation`) for subdivision shrinkage.

## Topology guarantees (checked, not claimed)

`QuadMesh.validate()` runs on every rebuild and is shown live in the viewer panel:

```
$ npm run validate -- --seed 7 --subdiv 2
skeleton : { vertices: 3422, bones: 3421, junctions: 508, tips: 529 }
cage     : { vertices: 21308, faces: 21306, quadsOnly: true,
             boundaryEdges: 0, nonManifoldEdges: 0, flippedEdges: 0,
             shells: 1, looseVertices: 0, euler: 2, genus: 0,
             watertight: true, singleMesh: true }
valence  : { '3': 2116, '4': 17096, '5': 2084, '6': 12 }
```

* **quads only** — zero triangles, zero n-gons, at every subdivision level
* **watertight** — 0 boundary edges (every edge shared by exactly 2 faces)
* **manifold + consistently wound** — 0 non-manifold edges, 0 duplicated directed edges
* **one mesh** — 1 connected shell, χ = 2, genus 0 (a topological sphere)
* **no loose vertices**
* ~80 % of vertices are regular (valence 4); the poles are the unavoidable 3/5-valence
  vertices around each junction hub

`npm run sweep` (40 seeds) and `--stress` (30 randomized parameter sets, including extreme
branch counts, angles and radii) both pass all of the above.

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
src/app/              Three.js viewer (stages, params, live audit, OBJ export)
scripts/              headless validate / sweep / stress / render
```
