# Swiss splat terrain

Mapterhorn elevation, swisstopo SWISSIMAGE orthophotography, and Gaussian splats — composited in a
single deck.gl render pass over the Swiss Alps, two different ways.

No access token is required for any data source in this example.

## The two halves

**Live.** The example opens on the Matterhorn, built while you watch. A worker fetches two ordinary
`{z}/{x}/{y}` rasters, cuts each into 16,384 oriented Gaussians, wraps them in a GeoArrow
`RecordBatch` and hands that batch's own buffers to the GPU with no copy in between. A screen-space
error quadtree streams it from zoom 9 to zoom 20, and every resident tile — at every zoom level in
the frontier at once — enters one global back-to-front order, every frame. Nothing was baked,
trained or hosted for it.

**Baked.** The same surfel maths, run ahead of time into a published splat archive of the
Lauterbrunnen valley. `Lauterbrunnen terrain` and `Lauterbrunnen, live` are deliberately the same
ground: switching between them changes where the splats came from and nothing else.

Both reach the screen through one `SplatLayer` and one renderer. Both are drawn over — or, for the
live scenes, instead of — a `TerrainLayer` mesh in the same pass.

> A mesh draws a height field better than this does, and should. Nobody should ship terrain as a
> million Gaussians because it is cheaper; the result worth having is that the same five columns
> feed both, and that an ordinary tiled surface reads as a stream of Gaussian primitives.

## Run

```bash
npm install
npm start
```

That is enough for the live scenes, which download nothing but map tiles.

```bash
npm run bake-terrain
```

turns Mapterhorn elevation and swisstopo orthophotography into a splat archive of the Lauterbrunnen
valley — about 1.4M splats, 30 MB, thirty seconds the first time and a second after that.

`npm start` on its own works either way, and says what is missing. **Nothing large downloads unless
you ask it to**: the scene picker reports which scenes are baked and how big each one is, and
selecting an unbaked reconstruction asks before pulling several hundred megabytes of PLY.

### The live scenes

Five places, chosen against the data rather than for the view. The first three are Swiss because
Switzerland is where the elevation is best — over the Alps Mapterhorn serves swissALTI3D at about
0.4 m a pixel rather than the 30 m global grid, and swisstopo publishes a national orthophoto over
exactly the same ground, both token-free.

| Scene | Elevation | Imagery |
| --- | --- | --- |
| Matterhorn | swissALTI3D via Mapterhorn | SWISSIMAGE |
| Lauterbrunnen | swissALTI3D via Mapterhorn | SWISSIMAGE |
| Aletsch | swissALTI3D via Mapterhorn | SWISSIMAGE |
| Grand Canyon | Copernicus 30 m via Mapterhorn | none by default |
| Mount Fuji | Copernicus 30 m via Mapterhorn | none by default |

The last two are there to be pressed if someone asks whether this is a Swiss trick: the Grand Canyon
is relief cut *down* into the surface rather than up out of it, and Fuji is a clean cone. There is no
token-free worldwide orthophoto service this repository is in a position to point at, so both come up
as bare relief — which is the honest picture of what a worldwide DEM contains. Supply your own with
`?imagery=<{z}/{x}/{y} template>` or `VITE_IMAGERY_URL`.

The camera orbits whichever place is selected and resumes a few seconds after you stop dragging.

### Fidelity, and the three things that carry it

**Thickness.** A terrain splat is a disc lying in the hillside, and the one number that decides
whether a hillside *reads* as one is how thick that disc is across its normal. Too thin and every
microfacet turned away from the camera projects to a sliver, so a distant slope combs into streaks
that crawl as the camera turns; too thick and the ground turns into a slab. It is a fraction of the
in-plane extent, it is **0.45**, and it was arrived at by sweeping the Matterhorn scene rather than
by reasoning about what a surfel ought to be — which gave 0.12 and was wrong by a factor of four.
`TERRAIN_SURFEL_DEFAULTS.thickness`, and the measurement is under
[Five things that are not obvious](#five-things-that-are-not-obvious).

**Fades.** Turn the `Fades` checkbox off and drag. Every level change in the streaming frontier
becomes a visible snap, because the traversal swaps a coarse parent for four finer children in one
frame. With it on, an arriving page ramps up and the page it replaces is *held* at the opacity it had
until the ramp finishes — never cross-dissolved, which would drop coverage to 75% across every patch
changing level at once. This lives in `SplatLayer` as `fadeInDuration` / `fadeOutDuration` /
`fadeHoldDuration`, and the controller behind it is shared with this folder's copy of the layer
rather than duplicated into it.

**Haze.** The worker bakes a distance fade into each splat's DC term, measured from the scene origin
rather than from the camera — which is what makes it cost nothing per frame, and is legitimate only
because these scenes are orbited. Without it the residency frontier ends in a cliff edge with the
page background behind it. It is matched to the CSS background; change one without the other and the
horizon comes back.

**And one thing that is easy to get wrong.** luma.gl infers a colour column's *meaning* from its
type: a `float32x4` column is linear radiance, and on a device without an extended-range swap chain
it silently turns on Reinhard tone mapping for the whole scene — which maps 1.0 to 0.5. Terrain
colour is an orthophoto with a fixed light mixed in: display-referred, already in `[0, 1]`, and
eight bits a channel is all it carries. So the live worker emits `unorm8`, and the archive — which
stores `float16` because a *trained* DC term genuinely can exceed 1 — is requantized to `unorm8` on
decode when its manifest says it is georeferenced. Left as float, a terrain scene draws at half
brightness with its midtones crushed, and the comparison between the two halves becomes a comparison
of two exposures.

The reconstructions bake the same way:

```bash
npm run bake -- --scene train     # 742k splats, vis.gl hosted, 175 MB of PLY in
npm run bake -- --scene truck     # 1.7M splats, 400 MB of PLY in
```

To run against this repo's deck.gl sources instead of the published packages:

```bash
npm run start-local
```

`start-local` aliases `@deck.gl/*` to `modules/*/src` while keeping every `@luma.gl` import pinned
to this folder's `node_modules`, so deck.gl and the splat renderer continue to share one `Device`
implementation.

### Running against the promoted layer

The layer in this folder has been promoted into `@deck.gl/splat-layers`, and that is the version
that is maintained. The promoted layer records its GPU work through deck.gl's compute stage instead
of a private command encoder, takes part in deck.gl picking, accepts a clip region, and carries three
fidelity controls the copy here cannot — `antialiasing`, `fragmentKernel` and `depthKeyMode`. All of
them need deck.gl **and** luma.gl built from source.

The last three are worth knowing about, because a live terrain scene is the case that shows them
worst. It is a regular lattice of overlapping discs seen in perspective, so it aliases against the
pixel grid, and released `@luma.gl/splats` quantizes hyperbolic device depth into a 16-bit sort key —
at geospatial near/far ratios that leaves distant Gaussians resolving ties arbitrarily.
`depthKeyMode: 'float16'`, `antialiasing: 'mip-splatting'` and `fragmentKernel: 'analytic'` address
those, and the app offers the `Analytic kernel` checkbox exactly when it is running the promoted
layer.

They were also being asked to cover for something that was not theirs. The streaking that used to
cross every distant hillside here survived a 4x supersampled render, which is not what aliasing
does: the surfels were simply too thin to stay closed edge-on, and the fix was in the geometry.
Both layers now also forward `kernel2DSize`, the screen-space dilation those two settings work on
top of — luma.gl defaults it to Mip-Splatting's 0.3, which is calibrated for a scene *trained* with
the matching 3D filter and is about a third of what an untrained lattice would need.

Point `LUMA_SOURCE` at a luma.gl checkout to run that version:

```bash
LUMA_SOURCE=/path/to/luma.gl npm run start-local
```

`LUMA_SOURCE` implies `DECK_SOURCE`, aliases every `@luma.gl` entry point to the checkout's
sources — derived from each module's own `exports` map, so subpaths like `@luma.gl/gpgpu/gpu-core`
land in the right place — and swaps `@deck.gl/splat-layers` in for the local copy. Without it, the
example keeps using the copy in this folder, since the promoted module calls `@luma.gl/splats` APIs
that are not released yet.

### Everything the scripts do

| | |
| --- | --- |
| `npm run bake-terrain` | Elevation + imagery rasters → a georeferenced splat archive |
| `npm run bake -- --scene <id>` | A GraphDECO `.ply` → a splat archive |
| `npm run verify-terrain -- <dir>` | Unprojects a terrain archive and checks it against the elevation service |
| `npm run bake -- --scene <id> --verify` | Decodes a reconstruction archive back and reports quantization error |
| `npm run simulate-lod -- <dir>` | Runs the real level-of-detail traversal over an archive, with no browser |

Add `--help` to either baker for the full set of options.

## What it demonstrates

Three things, and they build on each other.

**The terrain occludes the splats correctly, in one pass.** Both of luma.gl's pass-sharing splat
renderers record into an *existing* render pass. `SplatLayer` is an ordinary `Layer` subclass, so
deck.gl hands it the same `renderPass` it already opened for the layer stack. The `TerrainLayer`
draws first and writes depth; the splat layer then draws with `depthCompare: 'less-equal'` and
`depthWriteEnabled: false`. A splat behind a ridge is hidden by that ridge, while the splats stay
correctly ordered among themselves through a global depth sort.

**A splat scene should arrive already in the shape the renderer wants.** A trained `.ply` is a
training artifact, and treating it as a delivery format means every visitor redoes work that
depends on nothing but the scene. `npm run bake` does that work once and publishes a
level-of-detail tree; the layer streams it through luma.gl's `SplatHierarchyManager` and
`SplatResidencyManager` into a render graph whose capacity was reserved before the first page
existed. Both paths are kept, and the panel reports which one is live, because the difference
between them is the point.

**A Gaussian splat does not have to come from a camera rig.** What a splat renderer needs is a
position, an orientation, three extents, a colour and an opacity, and a digital elevation model
plus an orthophoto already carry all six, per pixel, for most of the planet.
`npm run bake-terrain` turns the valley itself into splats — nothing trained, nothing
reconstructed, one splat per elevation sample — and it reaches the renderer through the same
archive format, the same worker, the same traversal and the same layer as the reconstructions do.

## Which renderer, and why it matters

deck.gl defaults `deviceProps.type` to `'webgl'`, so WebGPU has to be asked for by name. This
example asks for it, and the layer binds whichever renderer the device it actually got supports:

| Device | Renderer | Per frame while the camera moves |
| --- | --- | --- |
| WebGPU | `GPUSplatGraphRenderer` + `GPUSplatGraphMixedRenderer` | Projection, culling, the global radix depth sort, spherical-harmonic radiance and an indirect draw, all as GPU compute over borrowed source buffers. No CPU row walk. |
| WebGL2 | `SplatRenderer` | The depth order is built on the CPU over one JS object per splat, then *materialized* by physically permuting every source attribute — WebGL2 has no storage buffers to index through. luma's GLSL splat shader has no spherical-harmonic evaluation either, so any degree above 0 is evaluated per splat on the CPU. |

Measured on this example's own layer, 1.7M splats at SH degree 1, headless Chrome on an M-series
Mac — the median CPU time between deck.gl's `onBeforeRender` and `onAfterRender`:

| Case | Median frame |
| --- | --- |
| WebGL2 `SplatRenderer`, camera moving, source in decode order | **1030 ms** |
| WebGL2 `SplatRenderer`, camera moving, source Morton-ordered | **495 ms** |
| WebGPU `GPUSplatGraphRenderer`, camera moving | **1.0 ms** |
| Either renderer, camera still | ~0.5 ms |

That is not a tuning difference, it is the difference between sorting 1.7M splats on the main
thread and sorting them in a compute shader — three orders of magnitude, not a percentage. Append
`?device=webgl` to the URL to pin the fallback and see it. The WebGL2 defaults — a 400k-splat
residency ceiling and an 8 px error threshold — are set where they are for exactly this reason.

Inside that WebGL2 second, the attribute repack dominates — roughly 750 ms of it at 1.7M splats,
against about 80 ms for the depth sort itself — with the CPU spherical-harmonic pass on top when
the degree is above 0. The layer holds the camera position back until it has drifted 2% of the
scene extent so that pass does not re-run for a sub-metre pan, but the two real levers on that
path are the splat count and the source row order. Neither is decided in the browser any more;
see below.

## Doing the work once, before the browser

Everything a splat renderer does per frame is re-derived from scratch, because it all depends on
the camera. Everything *else* a splat scene needs — the decode, the pruning, the ranking, the
spatial ordering — depends only on the scene, and doing it in a browser means doing it once per
visitor rather than once per scene.

`npm run bake` does it once. `scripts/bake-splat-scene.ts` reads a GraphDECO `.ply` and writes the
format `splat-archive.ts` defines: a level-of-detail tree of quantized, Morton-ordered chunks and
a manifest describing it. The browser then fetches chunks and expands them, which is one linear
pass with no ranking, no sort and no branching.

**Prune.** Splats whose opacity cannot clear the renderer's alpha cutoff are tested and rejected
in the per-row visibility walk on every frame that draws them. They are dropped at bake time
instead, which changes nothing on screen.

**Rank.** Splats are ordered by the screen area they are likely to cover — opacity times the
geometric mean of the three axis lengths — rather than sampled uniformly, because a uniform sample
keeps as many near-transparent specks as it does the large opaque Gaussians that carry the
surface, and looks visibly thinner at the same count. The ranking is what makes a *partial*
download the important part of a scene rather than an arbitrary slice of it.

**Order.** A PLY stores splats in training order, which has no spatial meaning, so a depth-sorted
gather reads its source columns in essentially random order and misses cache on nearly every row.
Rows are Morton-ordered within each chunk, so the coherence is in the published bytes:

| 1.7M splats, WebGL2 | Decode order | Morton-ordered |
| --- | --- | --- |
| Attribute repack | ~745 ms | ~265 ms |
| Depth sort | ~77 ms | ~59 ms |
| **Whole frame, camera moving** | **1030 ms** | **495 ms** |

Same pixels, half the frame — and now the browser pays nothing to get it.

**Quantize.** 23 bytes a row instead of the PLY's 248:

| Column | Stored as | Bytes | Why not float32 |
| --- | --- | --- | --- |
| `positions` | `uint16x3`, per-chunk box | 6 | A chunk spans metres, not the scene |
| `scales` | `uint16x3`, per-chunk log range | 6 | Scales span orders of magnitude, and the PLY stores them logarithmically too |
| `rotations` | `uint32` smallest-three | 4 | A unit quaternion has three degrees of freedom; the fourth stores a constraint |
| `colors` | `float16x3` | 6 | The DC term is unclamped linear radiance and can exceed 1, so `unorm8` would clip it |
| `opacities` | `uint8` | 1 | Already in `[0, 1]`, and the fragment cutoff discards the tail anyway |
| SH band *n* | `int8`, per-band scale | 3 per basis | Higher-order radiance is a correction on a base color, not the base color |

That cutoff is `alphaCutoff`, and the app raises it to **0.02** from the layer's own `0.5/255`.
The layer default is the right one for a trained reconstruction, where the far tail of a Gaussian
is doing real work because the scene was optimized knowing it would be blended. Terrain splats are
not trained — they are a regular grid of discs sized to overlap their neighbours by a known amount
— so the tail is not detail, it is a fringe on every one of 1.4 million discs, stacked tens deep
along the view ray. Cutting it at 2% is the difference between a surface and a fog of one, and it
is most of the overdraw.

Measured on the Train scene — 741,883 splats, `npm run bake -- --scene train`:

| | Source PLY | Baked |
| --- | --- | --- |
| Degree 0 | — | **16.3 MB** |
| Degree 1 | 175.5 MB | **22.6 MB** (7.7× smaller) |
| Degree 2 | 175.5 MB | **33.3 MB** |
| Degree 3 | 175.5 MB | **48.1 MB** |
| Bytes before the first frame | 175.5 MB | **2.1 MB** (28 KB manifest + the root node) |

The last row is the one that is felt. The unbaked path cannot draw anything until the last byte of
the file has arrived and been decoded; the baked path draws a complete, coarse scene as soon as
one node has landed, and refines from there.

### Bands are separate files

Spherical-harmonic degree decides how many coefficients are *stored*, not just how many are
evaluated — which is why it re-downloads the whole scene on the unbaked path. Here each band is
its own file and the bands are cumulative, so degree 2 is `core` + `sh1` + `sh2` and the bytes
shared with degree 1 come back from the HTTP cache. Lowering the degree fetches nothing at all:
luma.gl clamps the evaluated degree per batch, so the layer just renders fewer bands of what is
already resident.

### What the quantization costs, measured

Lossy is a claim, so `npm run bake -- --verify` decodes the archive back with the same functions
the browser uses and compares it row for row against the columns it was baked from. On the Train
scene at degree 3:

| Column | Worst | RMS |
| --- | --- | --- |
| positions (source units, scene spans ~235) | 1.79e-3 | 2.47e-4 |
| scales (relative) | 9.44e-5 | 3.92e-5 |
| rotations (degrees) | 0.230 | 0.082 |
| colors (linear radiance) | 9.76e-4 | 1.33e-4 |
| opacities (0..1) | 1.96e-3 | 1.14e-3 |
| harmonics (coefficient) | 1.56e-3 | 5.12e-4 |

It also checks that every source row appears in exactly one chunk, which is the property the tree
below depends on.

## The level-of-detail tree

Each node holds the most important splats in its region that no shallower node already holds, and
its children divide what is left among eight octants. **Every splat appears exactly once in the
whole tree**, so children *add* detail rather than replacing it — `refinement: 'add'` to luma.gl's
`SplatHierarchyManager` — and the root alone is a complete coarse view of the entire scene rather
than a placeholder for one.

That is also what makes it honest. Nothing here is synthetic: no Gaussian is merged, averaged or
refitted, so a fully refined subtree is the reconstruction that was trained, and a partly refined
one is a strict subset of it. Hierarchies that fit new parent Gaussians to stand in for their
children can be sharper at a given budget; they also cannot say that.

Three numbers per node drive the traversal, and getting them right was the whole difficulty:

- **The geometric error is measured from the node's own rows**, not from its octree cell. It means
  "how far apart are the splats this node contributes". Measured against the cell, a clustered
  scene reads as far coarser than it is and keeps refining when it has nothing left to reveal,
  because an octree cell is a geometric construct and can be mostly empty.
- **The bounding sphere is fitted to the node's whole subtree**, because the traversal stops at a
  node it culls and never looks inside it. A sphere fitted to the node's own rows would cull
  detail that is on screen.
- **Outlier splats are attached to the root.** This one is not obvious and it is the difference
  between a working tree and no level of detail at all. The traversal measures distance as
  `distance(camera, center) - radius`, so a node whose sphere is inflated by one stray splat two
  hundred units away reads as *touching the camera* from anywhere in the scene, its error comes
  out effectively infinite, and it refines unconditionally. One floater per branch is enough to
  turn the whole tree into "always load everything". They are not dropped — that would be a silent
  edit to the reconstruction — they are given to the root, which is resident from the first frame
  and always drawn, and so kept out of every child's bounds.

### Checking it without a browser

`SplatHierarchyManager` and `SplatResidencyManager` need nothing from a device except a page with
a row count and a byte length, so the real traversal can be driven over a stub:

```bash
npm run simulate-lod -- public/splat-archives/train --error 4
```

```
    distance  frontier       drawn    resident   GPU MB  culled  rejected
       5602u         1      65,548      65,548        6       0         0
       2801u         1      65,548      65,548        6       0         0
       1400u         1      65,548      65,548        6       0         0
        700u         9     160,706     160,706       15       0         0
        350u        16     240,866     240,866       23       0         0
        175u        24     316,110     316,110       30       0         0
         88u        32     401,984     401,984       38       0         0
         44u        36     547,573     550,889       53       4         0
```

This matters because the failure mode is quiet: a tree that refines everything at every distance
still renders correctly, it just downloads the whole scene to draw a thumbnail, and looks fine
while doing it. The first version of this baker did exactly that, and this table is what caught
it.

## Terrain as splats

`npm run bake-terrain` builds an archive out of two public rasters and nothing else. Each splat is
**one elevation pixel and one imagery pixel** — a node covers exactly one slippy tile as a
128 x 128 grid, takes its elevation from the tile two zooms above it (512 px, divided 4 x 4) and
its colour from the tile one zoom above (256 px, divided 2 x 2), so nothing is resampled and
siblings share a fetch. Measured on the default bake:

| | |
| --- | --- |
| Coverage | 2 x 2 tiles at zoom 14, 3.36 km across, centred on the site |
| Levels | 14 to 16, 16,384 splats a node |
| Spacing | 13.1 m at the roots, 3.28 m at the leaves |
| Tree | 84 nodes, 1,376,256 splats, 30.2 MB |
| First complete frame | 1.4 MB, the four roots |
| Rasters fetched | 32 |

### One implementation, and why that is load-bearing

`Lauterbrunnen terrain` and `Lauterbrunnen, live` are only a comparison if the two paths agree
about what a splat *is*. They now agree by construction: `buildTerrainSurfels` in
`terrain-surfels.ts` is the whole of the maths, `scripts/bake-terrain-splats.ts` calls it in Node
and `terrain-tile.worker.ts` calls it in the browser, and `TERRAIN_SURFEL_DEFAULTS` is the one
place the numbers live.

The baker used to carry its own copy — 230 lines that happened to still agree with the worker's,
which is exactly the kind of agreement that stops being true without anyone noticing. Deleting it
changed nothing it should have: the archive baked through the shared function is byte-for-byte the
one the duplicate baked.

### This tree refines by `replace`, and the reconstructions' by `add`

A trained reconstruction has *one* set of Gaussians, so the only honest way to make it progressive
is to split that set up: each node holds splats its ancestors did not take, children extend their
parent, and every splat appears exactly once. Terrain is not a fixed set of primitives. It is a
raster, and a raster has a different resolution at every zoom — so each level here *resamples the
same ground* more finely, a node and its children describe the same surface twice, and only one of
them may be drawn.

That is `refinement: 'replace'`, it is a field in the manifest, and it is visible in the
simulator's output: `drawn` falls below `resident` as the camera closes in, because parents stay
loaded but stop being drawn once all four children are there.

```
    distance  frontier       drawn    resident   GPU MB  culled  rejected
     214787u         4      65,536      65,536        4       0         0
      13424u         4      65,536      65,536        4       0         0
       6712u         7     114,688     131,072        8       0         0
       3356u        31     507,904     655,360       40       0         0
       1678u        50     819,200   1,261,568       77      14         0
```

### Five things that are not obvious

**Splats are oriented to the surface, and stretched on the slope.** The orientation comes from
the elevation gradient, so a disc lies *in* the hillside rather than facing the sky. Its in-plane
extents are then stretched by `1 / cos(slope)`, because a cell one sample wide in plan is longer
than that measured along a hillside, and discs sized for the plan view tear open on steep ground.

Both in-plane axes carry that stretch, not just the downhill one — which is, strictly, too much.
Across the gradient nothing climbs, so the across-slope neighbours really are one plan spacing
apart. Growing only the downhill axis is the geometrically honest version and it looks worse: an
ellipse stretched on one axis points its long side down the fall line everywhere at once, and a
field of them combs a hillside into streaks that slide as the camera moves. Growing both keeps a
disc a disc, and pays for it with some extra overlap along the contour — the direction a height
field has the least to say about in the first place.

**That stretch needs a ceiling.** `1 / cos` goes to infinity, and Lauterbrunnen's walls are close
enough to vertical that an unclamped bake measured a **58x** stretch — a three-metre sample smeared
into a ninety-metre streak. Those streaks are not detail; they are an artefact of asking a height
field to describe a surface it cannot represent, since a raster has one elevation per cell and a
vertical face is exactly where adjacent samples stop saying anything about what lies between them.
Clamped at 3x, the correction still covers everything up to about 71 degrees, 1.9% of splats hit
the ceiling, and what shows through the gaps there is the terrain mesh — drawn from the same data
and still underneath. On a face that steep the camera is nearly always looking *along* it rather
than at it, so the opening is hard to see while the extra stretch would be visible from anywhere.

**A splat needs thickness, and more of it than seems right.** A terrain sample is a patch of
surface with no thickness at all, and a 3D Gaussian with a zero extent is degenerate, so the third
axis is an assumption — declared as a fraction of the in-plane one. It was 0.12, on the reasoning
that a surfel should be about as flat as the thing it stands for. That reasoning is wrong, and
visibly so. Seen edge-on a flat disc projects to a sliver; on a rough height field at 82 degrees of
pitch that is not a rounding error but the whole picture, because every microfacet tilted away from
the camera collapses while the ones tilted towards it stay full. Eight kilometres of Matterhorn
hillside combs into light and dark streaks that crawl as the camera turns.

Swept against that view: 0.12 combs badly, 0.25 is much better but still visible, 0.35 leaves faint
traces, and by **0.45** the streaking is gone. 0.7 looks the same as 0.45, so there is nothing above
the knee worth paying for — and paying is real, since the extent is perpendicular to the surface and
eventually reads as a slab rather than as ground. Two controls say what it is *not*: the same sweep
with `--relief 0` is unchanged, so this is coverage and not shading, and a 4x supersampled render
still shows it, so it is geometry and not screen-space aliasing.

It is the three-dimensional half of Mip-Splatting's argument — a floor on how small a Gaussian's
smallest axis may be — expressed as a fraction because the level-of-detail spacing here spans six
octaves. `--thickness <f>` rebakes the archive at any value, which is how the sweep above was run;
the live scenes take the same number from `TERRAIN_SURFEL_DEFAULTS`. The screen-space half is the layer's `kernel2DSize`, which luma.gl defaults to
Mip-Splatting's 0.3: the right number for a scene *trained* with the matching 3D filter, and about
a third of what an untrained lattice needs. Raising it to about 1 hides the same streaking, at the
cost of softening everything else, so this example fixes the geometry and leaves the filter alone.

**A north-west sun is baked into the colours.** SWISSIMAGE is flown near-nadir in flat light and
mosaicked from passes taken months apart, so it carries almost no shading of its own. Pasted onto
the geometry unaltered it reads as a photograph on a bedsheet: the relief is *there*, and you
cannot see it. So each splat's stored colour is multiplied by `0.68 + 0.32 * (normal . sun)`, with
the sun north-west at about 50 degrees — the cartographic convention, and deliberately not an
attempt to recover the real sun the mosaic has no single one of. Measured over 131,072 splats,
that takes the brightness ratio between sun-facing and away-facing ground from **1.35x** (what the
orthophoto happens to carry) to **1.54x**.

It is baked rather than evaluated per frame because the DC term of a Gaussian is exactly where a
light that never moves belongs, and because the splat renderer has no lighting stage to apply it
anywhere else. The `TerrainLayer` mesh underneath *does* have one, and it is visible through the
gaps on cliffs and beyond the archive's own footprint — so `app.tsx` gives deck.gl a
`LightingEffect` with the same sun and a material split the same `0.68 / 0.32` way, and the two
surfaces agree. Both are tunable: `--relief 0` bakes the old unshaded look back.

**The splats are lifted three metres along the normal.** The splats and the mesh come from the
same elevation service but not at the same resolution — the mesh is simplified to `meshMaxError`
and built from a deeper zoom — so the two surfaces disagree by a few metres on steep ground. Drawn
coincident, roughly half of each splat would land behind the mesh and be depth-tested away, which
reads as tearing. Lifting along the normal rather than straight up keeps the offset perpendicular
on a cliff, where a vertical lift would slide the surface sideways instead. The mesh still
occludes splats behind a ridge; it just never fights the ones in front of it.

### Checking it, since a hillside is hard to eyeball

Mirror the north axis, use the wrong Earth circumference, or take the quaternion's handedness the
wrong way round, and what you get is still a plausible-looking hillside — just not *this* one.
`npm run verify-terrain` unprojects the archive back to longitude, latitude and elevation and
compares it against an independent lookup:

```
  covers    7.8882..7.9321 E, 46.5740..46.6042 N
  elevation 742..1902 m

  vs an independent z14 elevation lookup, over 262,144 leaf splats:
    mean  |dz|  3.56 m          (of which 3 m is the deliberate lift)
    worst |dz|  215.5 m         (a cliff, where one sample sideways is hundreds of metres down)

  quaternion norm error   <= 4.20e-8
  flattest normal z       0.016  (1 = level ground, 0 = vertical)
  in-plane extent         0.550..1.650 x sample spacing
  widest slope correction 3.00x  (= 1 / cos slope, so 71 degrees)
  in-plane anisotropy     <= 0.00e+0  (the two in-plane axes are stretched together, so this is 0)
  thickness ratio         0.450..0.450 x in-plane
```

The last three are there because the stretch is no longer readable off a single splat. When only
the downhill axis grew, the ratio between a splat's two in-plane extents *was* the correction, and
a bug in it showed up as a wrong angle here. Now that both axes carry it that ratio is 1 by
construction, so the check moved: the extent is reported in units of the node's own sample
spacing, and the correction is recovered from the spread between the narrowest splat in the
archive (level ground, no correction) and the widest.

### The 0.11% that would have shown

Positions are published as Web Mercator offsets divided by the scale factor at the archive's
origin, not as ground metres, because that is the frame deck.gl's common space actually is. Which
raises a trap worth writing down: `@math.gl/web-mercator` divides by a flat `40.03e6` rather than
`2 * PI * 6378137` = `40075017`. Bake with the true circumference and expand with deck's and the
scale is off by 0.11% — nearly four metres at the edge of a 3.4 km archive, which on a hillside is
a visible slip between the splats and the mesh under them. So the baker keeps two constants apart
deliberately: ground *sizes* use the real one, and the conversion into common space uses deck's,
because that conversion has to be exactly undone by code the baker does not control.

## Streaming into a reserved graph

The glue between deck.gl and luma.gl's traversal is two things `SplatLayer` does.

**It reserves capacity before there is anything to draw.** `GPUSplatGraphRenderer` compiles a
command graph sized to `expectedSplatCount` and `expectedBatchCount`, and reuses it for any batch
list that fits inside those. So the renderer is created empty, sized to the residency ceiling, and
a frontier that gains pages, loses them and reorders them every frame costs one array of pointers
rather than a rebuild of every buffer the graph owns. Overflow is still correct — it just rebuilds
— so the reservation is a performance decision, not a correctness one.

**It runs the traversal in the layer's own space.** Screen-space error is a ratio of a node's
geometric error to its distance from the camera, times a focal length in pixels. The splats live
in arbitrary scene units that the model matrix maps onto the map, and the layer already builds
that matrix and its inverse for the spherical-harmonic evaluation — so it feeds the traversal the
scene-local camera and the archive's scene-local bounds, and the error comes out in real pixels.
The surrounding application only has the map-space camera and could not do this.

One smaller decision that matters: **the layer owns the residency window, not the traversal.**
`SplatHierarchyManager` fixes its error threshold at construction, so the Detail control has to
build a new one — and a new traversal handed a residency window it does not own finds every page
from the old one still resident, instead of re-fetching the frontier on every change.

Pages are charged against the residency budget *before* their fetch starts, using
`estimatedGpuBytes` and `estimatedSplatCount` from the manifest. A page that will not fit is
therefore never requested rather than downloaded and evicted, which is what keeps a bound budget
from turning into a fetch loop.

### The budget is what mixed resolution is

Fly the Matterhorn scene down to the valley floor and it used to settle like this: one part of the
hillside sharp, the next two levels coarser, a hard seam between them, and nothing changing however
long you waited. It is worth being precise about why, because none of the obvious explanations is
right. Nothing was still loading — the frontier is static after about five seconds. Nothing 404s;
Mapterhorn serves zoom 17 here and the tree already holds the zoom 16 and 17 nodes. The
screen-space error of those coarse nodes is around 20 px against a 2 px threshold, so the traversal
wants to refine them.

What stops it is the residency budget, and the giveaway is in the counters:

```
resident 1,589,248 / 1,600,000 splats     97 chunks, 62 pinned
drawn      688,128 splats                 38 chunks
rejected    27,973 admissions
```

The budget is 99.3% full, and **more than half of what is holding it is not being drawn**. With
`refinement: 'replace'` a parent stays resident as the fallback its children are drawn instead of,
so a deep frontier carries every level above it. Once the budget is full, the next page is refused
before its fetch starts — and re-offered and refused again on every frame, ~28,000 times. Wherever
each branch had reached when the budget filled is where it stays. That is the seam.

So the lever is the budget, and the budget was pinned to 1.6M by a claim that turned out to be two
claims stuck together. `GPUSplatGraphRenderer` keeps one 48-byte projected record per resident splat
in a single storage binding, and a WebGPU device is given 128 MiB for one binding unless it asks for
more — about 2.1M splats once the graph's reservation factor is taken off. luma.gl only sends
`requiredLimits` when `featureLevel: 'max'` is requested, and *that* also force-enables every feature
the adapter has, which is what breaks the depth sort's compute pipelines. The limit and the features
are one switch in luma.gl's API, not one thing in WebGPU: `splat-device.ts` separates them, wrapping
the adapter so the device descriptor carries a 512 MiB `maxStorageBufferBindingSize` and nothing else
changes. The adapter here reports 4 GiB, so there was never a hardware ceiling in the way.

Measured on the same camera, at 2 px:

| Budget | Frontier zooms | Drawn | Refusals a frame |
| --- | --- | --- | --- |
| 1.6M (old ceiling) | 9–15 | 688k | ~28,000 |
| 3.2M (default now) | 10–17 | 1.6M | ~22,000 |
| 6.4M | 10–17 | 3.1M | ~5,000 |

3.2M is the default because the reservation is allocated up front — 6.4M costs about 400 MB of
projected records before a page has landed — and because by 3.2M the picture has stopped being the
limiting factor: zoom 17 is the finest the elevation source has. 6.4M stays on the menu for anyone
who wants the frontier to stop refusing pages altogether. Where the raised limit is refused the
ladder simply stops lower, because the rungs are computed from what the device granted rather than
from what was asked for.

What this does *not* fix is the half of residency spent on undrawn ancestors. That is the hierarchy's
eviction policy, inside `@luma.gl/splats`, and a policy that dropped a parent once all four children
were resident and ramped would roughly double the effective budget again.

## The fallback path

With no archive present the example decodes the source PLY directly, and does the bake's work
inline: prune, rank, Morton-order, gather. That is the path the panel labels "Unbaked PLY", and it
is kept for two reasons — the example has to work on a fresh checkout, and the comparison is the
argument.

It runs on a worker. The decode and the reorder together are about 0.3 s for the Train scene on an
M-series Mac, which is not enormous, but it is 0.3 s during which the terrain has to stay
interactive, and the download in front of it is 175 MB. Baked chunks decode on the same workers:
3.2 ms for a 65k-row node at degree 0, 4.2 ms at degree 1, 6.7 ms at degree 3.

What is *not* worth pre-computing: luma.gl's splat schema takes `scales` and `rotations` as
separate columns, so a pre-multiplied 3D covariance has nowhere to go.

One render-path lever is a prop rather than a pre-process: `screenSizeCutoffPixels` drops splats
projecting to less than a given radius. On WebGPU that test runs in the projection compute pass
and removes the splat from the sort, the indirect draw count and the rasterizer at once. On
WebGL2 the same test has to run per row in JavaScript, which costs more than the overdraw it
saves, so `SplatLayer` forwards it only on the graph renderer.

`GPUPagedSplatRenderer` is the third renderer in the package and is deliberately unused here. It
owns its own render pass and clear color, so it cannot share deck.gl's pass or depth buffer — and
sharing the pass is the whole reason to draw splats as a deck.gl layer in the first place. The
graph renderer's reserved-capacity model does its job here instead.

## Georeferencing

Splat scenes are reconstructed in arbitrary local units with no geographic meaning, so the layer
places them explicitly:

- `viewport.projectPosition()` converts the anchor `[longitude, latitude, altitude]` into deck.gl
  common space.
- The model matrix is `translate(anchor) · scale(unitsPerMeter) · rotateZ(-heading) ·
  scale(metersPerUnit) · rotateX(-90°) · translate(-sceneOffset)`, composed in float64 and only
  then handed to the renderer, so common-space magnitudes never reach float32.
- `metersPerUnit` and `sceneOffset` come from **percentiles** of the splat centers rather than
  absolute bounds. Reconstructions routinely contain stray "floater" splats, and fitting to the
  true min/max would let one of them shrink the whole scene to a speck.
- A streamed scene cannot compute those percentiles at all — no page of it has seen enough
  centers, and the whole point is that it never downloads a copy that has. They are baked into the
  manifest and handed to the layer as `scenePercentiles`. Without them the scene would shift every
  time a page arrived.
- **None of that applies to a terrain archive.** It was built from a geographic raster, so every
  splat already knows where it belongs: the manifest carries a `georeference`, the layer places it
  one to one with `metersPerUnit = 1` and no offset, and the footprint control does not appear.
  The two kinds of scene reach the same model matrix by different routes — one normalized onto an
  anchor, one already in the anchor's own frame.
- The anchor altitude is the swisstopo height-service value at that exact coordinate
  (785.4 m at 46.5936 N, 7.9091 E), so the scene's ground plane meets the terrain surface.
- The camera position is transformed into scene-local space through the inverse model matrix,
  which is what the view-dependent spherical-harmonic radiance is evaluated against.

## Data sources

| Layer | Source | Notes |
| --- | --- | --- |
| Elevation | [Mapterhorn](https://mapterhorn.com) `https://tiles.mapterhorn.com/{z}/{x}/{y}.webp` | 512px WebP, Terrarium encoding |
| Imagery | [swisstopo SWISSIMAGE](https://www.swisstopo.admin.ch/en/orthoimage-swissimage-10) WMTS, EPSG:3857 | 256px JPEG, the Swiss national orthophoto mosaic |
| Splats | [Voxel51 Gaussian splatting dataset](https://huggingface.co/datasets/Voxel51/gaussian_splatting) | GraphDECO-convention PLY, Apache-2.0 |

Both tile sources serve zoom 17 over this valley, so terrain and texture stay sharp at the
altitudes the initial camera flies at. The scheme uses 256px tiles to match SWISSIMAGE's native
resolution rather than upsampling it across Mapterhorn's 512px elevation tiles.

Attribution is required by the underlying data: see
[Mapterhorn's attribution page](https://mapterhorn.com/attribution/) and
[swisstopo's terms for free geodata](https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices).

### About the splat scenes

None of the available scenes are Swiss — there is no public, CORS-accessible Gaussian splat
capture of the Bernese Oberland. They are treated as a stand-in capture dropped onto real Swiss
terrain; what is being demonstrated is the compositing, not the provenance of the scene.

The default Truck scene is 1.69M splats and its PLY is roughly 400 MB, so first load takes a
while. The panel reports decode progress as it streams. If Hugging Face is unreachable, the
example falls back to the vis.gl-hosted Train scene on `raw.githubusercontent.com`, which is
published as two complete PLY files and loads as two batches.

## Gaussian PLY decoding

This is the fallback path now — `npm run bake` runs the same decoder under Node, and a baked
scene never touches it — but it is still what defines what the format means.

`@loaders.gl/ply` is a general mesh loader and does not decode Gaussian splat semantics, so
`gaussian-ply.ts` reads the GraphDECO vertex layout directly and applies the reference
reconstruction: `exp` scales, `sigmoid` opacity, normalized `(w, x, y, z)` quaternions, and a DC
spherical-harmonic term folded into an unclamped float32 base color.

Higher-order coefficients need a transpose. The file stores every basis for red, then green, then
blue; luma.gl reads basis-major RGB triplets. Truncating to a lower degree therefore keeps the
first *n* bases **of each channel**, not the first *3n* values in the file.

Rows are decoded as bytes arrive, so a multi-hundred-megabyte scene never needs a second full-file
copy in memory beside the decoded columns. The decoder takes a `ReadableStream` rather than a URL,
which is what lets the same code serve three callers that get their bytes from different places:
the browser's `fetch` body, a worker's, and the baker's file handle under Node, where `fetch`
cannot open a local path at all.

## Navigation

The camera uses [`TerrainController`](https://deck.gl/docs/api-reference/core/terrain-controller),
not the default `MapController`. It picks the elevation at the centre of the viewport from the
terrain layer's `pickable: '3d'` depth pass and keeps the camera at that altitude, so panning up
the valley rides the surface instead of orbiting the sea-level plane and clipping through the
ridges either side. It also defaults to `rotationPivot: '3d'`, so a right-drag rotates about the
terrain point under the pointer rather than the map centre — at 70° pitch over 2 km of relief that
is the difference between turning around the peak you are looking at and swinging around a point
somewhere under the valley floor.

Because the splat layer is not pickable, the controller reads the terrain *beneath* the splats.
That is what you want here: the capture sits on the valley floor, and the camera follows the floor.

## URL parameters

- `?device=webgl` pins the WebGL2 fallback. Without it the example takes WebGPU when the browser
  has an adapter, which is what the panel's bottom line reports.
- `?scene=<id>` picks the scene on load: `lauterbrunnen-terrain` (the default), `train`, `truck`,
  `drjohnson` or `playroom`.
- `?archive=<url>` points at a baked archive hosted somewhere other than beside the app — a CDN
  copy, or another checkout's `public/splat-archives/<id>/`. Without it the example looks for
  `splat-archives/<scene>/` under its own origin and falls back to the PLY when nothing is there.

## Controls

The panel shows the controls that mean something for the scene on screen, and hides the ones that
do not. A terrain archive has no view-dependent shading and no footprint to choose; an unbaked
reconstruction has no level-of-detail tree to refine.

- **Splat scene** — every scene, with what it actually costs: `baked, 30 MB` where an archive is
  published and `not baked, 400 MB PLY` where one is not. The list is built from probing the
  archives at startup, so it reports what exists rather than what is configured.
- **Detail** *(baked scenes)* — the geometric error, in pixels, a level-of-detail node may project
  to before it is refined. A node's error is the spacing of its own splats, so this reads
  directly: at 2, refinement continues until the splats being looked at sit about two pixels
  apart. Defaults to 2 px on WebGPU and 8 px on WebGL2, where every frontier change is a CPU
  resort.
- **GPU residency** *(baked scenes)* — a ceiling on what stays on the GPU, and the layer's
  renderer reservation. Normally Detail binds first; when this one does, pages stop being
  requested rather than being fetched and evicted. Changing it admits or evicts pages and
  re-downloads nothing. On a live scene it is usually what binds, and it is the difference between
  a view at one resolution and a view at three — see
  [The budget is what mixed resolution is](#the-budget-is-what-mixed-resolution-is). The rungs
  offered are the ones this device can actually hold; the list is shorter where the storage binding
  could not be raised.
- **Spherical harmonics** *(scenes that carry them)* — degree 0 to whatever the archive stores.
  Lowering it is free, since the renderer clamps the evaluated degree per batch; raising it
  fetches only the extra band files, never the geometry again. A terrain archive stores a DC term
  only — an orthophoto looks the same from every direction — so the control is replaced by a note
  saying why.
- **Footprint** *(reconstructions)* — the horizontal size in metres an arbitrary-unit capture is
  normalized to. Absent for a georeferenced archive, which is already in metres.
- **Splats** — draws the splat layer or not.
- **Mesh texture** — drops the orthophoto off the terrain mesh, leaving bare relief underneath the
  splats. The clearest way to see what the splats are contributing, and what shows through where
  they do not cover. The mesh itself always stays: it writes the depth that occludes distant
  splats, and it is what the terrain-following camera picks against.
- **Wireframe** — the mesh's triangles, for inspecting the depth interaction.

The status box says which path is live — a baked archive or an unbaked PLY — and for a streamed
scene how many splats are drawn, how many nodes are in the frontier, how much GPU memory is
resident and how many pages are in flight.

## Limitations

- The splat placement math assumes `MapView`. `GlobeView` uses a different projection and the
  anchor transform would need to be rebuilt for it.
- The splat layer is not pickable. deck.gl's picking pass only draws pickable layers, so splats do
  not occlude terrain picking; the elevation tooltip and the controller's terrain-following both
  read through them to the mesh behind.
- Correctly ordered Gaussian splat rendering re-sorts on every camera change. On WebGPU that is a
  compute pass; on WebGL2 it is a main-thread sort plus an attribute repack, and it is why the
  residency ceiling and the error threshold both default higher there. Streaming is harder on that
  path for the same reason: every frontier change rebuilds the renderer's ordering buffers, so the
  error threshold is deliberately coarse enough that the frontier settles.
- On WebGPU, luma.gl 9.4's compiled splat graph always includes its own presentation pass, which
  `SplatLayer` has to encode and deck.gl then clears over, so the splats are rasterized twice per
  frame. It is GPU fill only, no CPU work, and it is invisible next to what the WebGL2 path pays,
  but it is the one cost this integration cannot currently avoid: the graph would need a way to
  encode projection and sorting without its presentation node.
- Raising the spherical-harmonic degree above what is resident rebuilds the streamed scene, since
  luma.gl's prepared batches cannot grow a column. The core chunks come back from the HTTP cache,
  so it costs the new bands and the GPU uploads, not the geometry — but it is a visible reload
  rather than a free change, which lowering the degree is.
- The quantization is lossy, by the amounts `--verify` prints above. For a reconstruction whose
  positions carry more than 16 bits of meaning per chunk, the format would need a wider position
  encoding.
- The baker holds the whole decoded scene in memory to build the tree. At degree 3 a 1.7M-splat
  reconstruction is roughly 400 MB of typed arrays; the chunk gather is per node, so that is the
  peak rather than a multiple of it.
- The terrain baker needs an image decoder, and Node has none: Mapterhorn serves WebP only and
  SWISSIMAGE JPEG only, with no PNG alternative for either. `sharp` is a devDependency for that
  one script and reaches neither the app nor its bundle.
- A height field cannot describe a vertical face or an overhang, so the steepest 1.9% of the
  terrain bake is covered by splats whose slope correction hit its ceiling and which therefore
  leave gaps. The mesh shows through them. Making the splats cover it would mean inventing a
  surface the elevation data does not contain.
- Terrain splat positions are exact at the archive's origin and drift by up to about 0.1% of the
  distance from it, because the layer scales by `viewport.distanceScales`, which deck.gl computes
  at the *viewport centre* rather than at the anchor. Over this archive's 3.4 km that is a few
  metres at the far corners as the camera pans — invisible against a lifted surface, and the
  reason the mesh is kept underneath rather than replaced.
- deck.gl's own WebGPU support is still in progress (see the
  [WebGPU developer guide](https://deck.gl/docs/developer-guide/webgpu)). `TerrainLayer`,
  `TileLayer` and picking are supported; effects, extensions and base map interleaving are not.
