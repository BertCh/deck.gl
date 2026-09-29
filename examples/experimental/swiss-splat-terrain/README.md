# Swiss splat terrain

Mapterhorn elevation and swisstopo SWISSIMAGE orthophotography, turned into Gaussian splats in the
browser and streamed over the Swiss Alps.

No access token is required for any data source in this example.

## What it is

The example opens on the Matterhorn, built while you watch. A worker fetches two ordinary
`{z}/{x}/{y}` rasters, cuts each into 16,384 oriented Gaussians, wraps them in a GeoArrow
`RecordBatch` and hands that batch's own buffers to the GPU with no copy in between. A screen-space
error quadtree streams it from zoom 9 to zoom 17, and every resident tile — at every zoom level in
the frontier at once — enters one global back-to-front order, every frame. Nothing was baked,
trained or hosted for it.

The splats reach the screen through one `SplatLayer`, and nothing else is drawn.

> A mesh draws a height field better than this does, and should. Nobody should ship terrain as a
> million Gaussians because it is cheaper; the result worth having is that an ordinary tiled surface
> reads as a stream of Gaussian primitives, through the same renderer a trained scene would use.

## Run

```bash
npm install
LUMA_SOURCE=/path/to/luma.gl npm start
```

`LUMA_SOURCE` is required. `@deck.gl/splat-layers` is not released yet and it calls `@luma.gl/splats`
APIs that no published luma.gl has, so the example builds deck.gl from this repo's `modules/*/src`
and luma.gl from a checkout of the `deck-splat-layers` branch — upstream luma.gl `master` lacks ten
of the exports the layer imports. See [`SPLAT-LAYERS-BRANCH.md`](../../../SPLAT-LAYERS-BRANCH.md) for
where that branch lives.

Nothing downloads but map tiles.

### The places

Three places, all Swiss, because Switzerland is where the elevation is best — over the Alps
Mapterhorn serves swissALTI3D at about 0.4 m a pixel rather than the 30 m global grid, and swisstopo
publishes a national orthophoto over exactly the same ground, both token-free.

| Place | Elevation | Imagery |
| --- | --- | --- |
| Matterhorn | swissALTI3D via Mapterhorn | SWISSIMAGE |
| Lauterbrunnen | swissALTI3D via Mapterhorn | SWISSIMAGE |
| Aletsch | swissALTI3D via Mapterhorn | SWISSIMAGE |

Tick **Orbit** to have the camera circle whichever place is selected; it pauses while you drag and
resumes a few seconds after you stop. It is off by default.

### Fidelity, and the three things that carry it

**Thickness.** A terrain splat is a disc lying in the hillside, and the one number that decides
whether a hillside *reads* as one is how thick that disc is across its normal. Too thin and every
microfacet turned away from the camera projects to a sliver, so a distant slope combs into streaks
that crawl as the camera turns; too thick and the ground turns into a slab. It is a fraction of the
in-plane extent, it is **0.45**, and it was arrived at by sweeping the Matterhorn scene rather than
by reasoning about what a surfel ought to be — which gave 0.12 and was wrong by a factor of four.
`TERRAIN_SURFEL_DEFAULTS.thickness`, and the measurement is under
[Four things that are not obvious](#four-things-that-are-not-obvious).

**Fades.** Turn the `Fades` checkbox off and drag. Every level change in the streaming frontier
becomes a visible snap, because the traversal swaps a coarse parent for four finer children in one
frame. With it on, an arriving page ramps up and the page it replaces is *held* at the opacity it had
until the ramp finishes — never cross-dissolved, which would drop coverage to 75% across every patch
changing level at once. This lives in `SplatLayer` as `fadeInDuration` / `fadeOutDuration` /
`fadeHoldDuration`.

**Colour format.** luma.gl infers a colour column's *meaning* from its type: a `float32x4` column
is linear radiance, and on a device without an extended-range swap chain it silently turns on
Reinhard tone mapping for the whole scene — which maps 1.0 to 0.5. Terrain colour is an orthophoto
with a fixed light mixed in: display-referred, already in `[0, 1]`, and eight bits a channel is all
it carries. So the worker emits `unorm8`. Left as float, the scene draws at half brightness with its
midtones crushed.

### The fidelity controls that need luma.gl from source

`@deck.gl/splat-layers` records its GPU work through deck.gl's compute stage instead of a private
command encoder, takes part in deck.gl picking, accepts a clip region, weights its level of detail
by gaze, focus distance and camera motion, and carries three fidelity controls — `antialiasing`,
`fragmentKernel` and `depthKeyMode`.

The last three are worth knowing about, because live terrain is the case that shows them worst. It
is a regular lattice of overlapping discs seen in perspective, so it aliases against the pixel grid,
and released `@luma.gl/splats` quantizes hyperbolic device depth into a 16-bit sort key — at
geospatial near/far ratios that leaves distant Gaussians resolving ties arbitrarily.
`depthKeyMode: 'float16'`, `antialiasing: 'mip-splatting'` and `fragmentKernel: 'analytic'` address
those, and the `Analytic kernel` checkbox toggles the fragment kernel.

They were also being asked to cover for something that was not theirs. The streaking that used to
cross every distant hillside here survived a 4x supersampled render, which is not what aliasing
does: the surfels were simply too thin to stay closed edge-on, and the fix was in the geometry.
The layer also forwards `kernel2DSize`, the screen-space dilation those two settings work on
top of — luma.gl defaults it to Mip-Splatting's 0.3, which is calibrated for a scene *trained* with
the matching 3D filter and is about a third of what an untrained lattice would need.

`LUMA_SOURCE` aliases every `@luma.gl` entry point to the checkout's sources — derived from each
module's own `exports` map, so subpaths like `@luma.gl/gpgpu/gpu-core` land in the right place — and
keeps `@math.gl` and `@probe.gl` pinned to this folder's `node_modules`, so deck.gl and the splat
renderer share one `Device` implementation.

## What it demonstrates

**Every level of the tree lands in one depth order.** Both of luma.gl's pass-sharing splat
renderers record into an *existing* render pass. `SplatLayer` is an ordinary `Layer` subclass, so
deck.gl hands it the same `renderPass` it already opened for the layer stack, and every resident
tile, at every zoom in the frontier, goes through one global depth sort. A ridge hides what is
behind it because its splats are nearer, not because anything else wrote depth.

**A Gaussian splat does not have to come from a camera rig.** What a splat renderer needs is a
position, an orientation, three extents, a colour and an opacity, and a digital elevation model
plus an orthophoto already carry all six, per pixel, for most of the planet. The worker turns the
ground itself into splats — nothing trained, nothing reconstructed, one splat per elevation sample.

**A tile service is a level-of-detail tree.** The traversal, culling, scheduling and residency are
luma.gl's `SplatHierarchyManager` and `SplatResidencyManager`, unchanged. `terrain-splat-source.ts`
supplies only what they cannot know about a tile service: where the nodes are, how to load one, and
where the tree stops — which nobody knows until a request 404s, so the tree grows one level ahead
of the frontier.

## Which renderer, and why it matters

deck.gl defaults `deviceProps.type` to `'webgl'`, so WebGPU has to be asked for by name. This
example asks for it, and the layer binds whichever renderer the device it actually got supports:

| Device | Renderer | Per frame while the camera moves |
| --- | --- | --- |
| WebGPU | `GPUSplatGraphRenderer` + `GPUSplatGraphMixedRenderer` | Projection, culling, the global radix depth sort and an indirect draw, all as GPU compute over borrowed source buffers. No CPU row walk. |
| WebGL2 | `SplatRenderer` | The depth order is built on the CPU over one JS object per splat, then *materialized* by physically permuting every source attribute — WebGL2 has no storage buffers to index through. |

That is the difference between sorting a million splats on the main thread and sorting them in a
compute shader — three orders of magnitude, not a percentage. Append `?device=webgl` to the URL to
pin the fallback and see it. The WebGL2 defaults — a 400k-splat residency ceiling and an 8 px error
threshold — are set where they are for exactly this reason.

## Terrain as splats

Each splat is **one elevation pixel and one imagery pixel** — a node covers exactly one slippy tile
as a 128 x 128 grid, takes its elevation from the tile two zooms above it (512 px, divided 4 x 4)
and its colour from the tile one zoom above (256 px, divided 2 x 2), so nothing is resampled and
siblings share a fetch. `buildTerrainSurfels` in `terrain-surfels.ts` is the whole of the maths, and
`TERRAIN_SURFEL_DEFAULTS` is the one place the numbers live.

The tree refines by `replace`. Terrain is not a fixed set of primitives: it is a raster, and a
raster has a different resolution at every zoom — so each level *resamples the same ground* more
finely, a node and its children describe the same surface twice, and only one of them may be drawn.

### Four things that are not obvious

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
enough to vertical that an unclamped build measured a **58x** stretch — a three-metre sample
smeared into a ninety-metre streak. Those streaks are not detail; they are an artefact of asking a
height field to describe a surface it cannot represent, since a raster has one elevation per cell
and a vertical face is exactly where adjacent samples stop saying anything about what lies between
them. Clamped at 3x, the correction still covers everything up to about 71 degrees, and about 2% of
splats hit the ceiling. On a face that steep the camera is nearly always looking *along* it rather
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
with no relief shading is unchanged, so this is coverage and not shading, and a 4x supersampled
render still shows it, so it is geometry and not screen-space aliasing.

It is the three-dimensional half of Mip-Splatting's argument — a floor on how small a Gaussian's
smallest axis may be — expressed as a fraction because the level-of-detail spacing here spans many
octaves. The screen-space half is the layer's `kernel2DSize`, which luma.gl defaults to
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
anywhere else.

### The 0.11% that would have shown

Positions are built as Web Mercator offsets divided by the scale factor at the place's origin, not
as ground metres, because that is the frame deck.gl's common space actually is. Which raises a trap
worth writing down: `@math.gl/web-mercator` divides by a flat `40.03e6` rather than
`2 * PI * 6378137` = `40075017`. Build with the true circumference and expand with deck's and the
scale is off by 0.11% — metres of drift a few kilometres out, so every splat lands a little off the
ground it was cut from. So `terrain-grid.ts` keeps two constants apart
deliberately: ground *sizes* use the real one, and the conversion into common space uses deck's,
because that conversion has to be exactly undone by code it does not control.

## Streaming into a reserved graph

The glue between deck.gl and luma.gl's traversal is two things `SplatLayer` does.

**It reserves capacity before there is anything to draw.** `GPUSplatGraphRenderer` compiles a
command graph sized to `expectedSplatCount` and `expectedBatchCount`, and reuses it for any batch
list that fits inside those. So the renderer is created empty, sized to the residency ceiling, and
a frontier that gains pages, loses them and reorders them every frame costs one array of pointers
rather than a rebuild of every buffer the graph owns. Overflow is still correct — it just rebuilds
— so the reservation is a performance decision, not a correctness one.

**It runs the traversal in the layer's own space.** Screen-space error is a ratio of a node's
geometric error to its distance from the camera, times a focal length in pixels. The layer feeds
the traversal the scene-local camera and the nodes' scene-local bounds, and the error comes out in
real pixels. The surrounding application only has the map-space camera and could not do this.

One smaller decision that matters: **the layer owns the residency window, not the traversal.**
`SplatHierarchyManager` fixes its error threshold at construction, so the Detail control has to
build a new one — and a new traversal handed a residency window it does not own finds every page
from the old one still resident, instead of re-fetching the frontier on every change.

### The budget is what mixed resolution is

Fly the Matterhorn scene down to the valley floor and it used to settle like this: one part of the
hillside sharp, the next two levels coarser, a hard seam between them, and nothing changing however
long you waited. Nothing was still loading, nothing 404s, and the coarse nodes' screen-space error
was around 20 px against a 2 px threshold, so the traversal wanted to refine them.

What stops it is the residency budget. With `refinement: 'replace'` a parent stays resident as the
fallback its children are drawn instead of, so a deep frontier carries every level above it. Once
the budget is full, the next page is refused before its fetch starts, and wherever each branch had
reached when the budget filled is where it stays. That is the seam.

So the lever is the budget. `GPUSplatGraphRenderer` keeps one 32-byte projected record per resident
splat in a single storage binding, and a WebGPU device is given 128 MiB for one binding unless it
asks for more — about 3.2M splats once the graph's reservation factor is taken off. luma.gl only
sends `requiredLimits` when `featureLevel: 'max'` is requested, and *that* also force-enables every
feature the adapter has, which is what breaks the depth sort's compute pipelines. `splat-device.ts`
separates the two, wrapping the adapter so the device descriptor carries a 512 MiB
`maxStorageBufferBindingSize` and nothing else changes.

Measured on the same camera, at 2 px:

| Budget | Frontier zooms | Drawn | Refusals a frame |
| --- | --- | --- | --- |
| 1.6M (default) | 9–15 | 688k | ~28,000 |
| 3.2M | 10–17 | 1.6M | ~22,000 |
| 6.4M | 10–17 | 3.1M | ~5,000 |

1.6M is the default because frame rate gives out before the picture does: doubling what is drawn
doubles the sort and the overdraw. 3.2M and 6.4M stay on the menu for a device that can carry them.
Where the raised limit is refused the ladder simply stops lower, because the rungs are computed
from what the device granted rather than from what was asked for.

## Data sources

| Layer | Source | Notes |
| --- | --- | --- |
| Elevation | [Mapterhorn](https://mapterhorn.com) `https://tiles.mapterhorn.com/{z}/{x}/{y}.webp` | 512px WebP, Terrarium encoding |
| Imagery | [swisstopo SWISSIMAGE](https://www.swisstopo.admin.ch/en/orthoimage-swissimage-10) WMTS, EPSG:3857 | 256px JPEG, the Swiss national orthophoto mosaic |

Both tile sources serve zoom 17 over the Alps, so the splats stay sharp at the altitudes the cameras
fly at.

Attribution is required by the underlying data: see
[Mapterhorn's attribution page](https://mapterhorn.com/attribution/) and
[swisstopo's terms for free geodata](https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices).

## Navigation

The camera uses the plain `MapController`, not `TerrainController`. Each place is framed by hand —
`lookAtAltitude`, `elevationDeg` and `rangeMeters` are chosen per subject — and letting the
controller pull the centre down onto the terrain overrides exactly those numbers.

## URL parameters

- `?device=webgl` pins the WebGL2 fallback. Without it the example takes WebGPU when the browser
  has an adapter.
- `?scene=<id>` picks the place on load: `matterhorn` (the default), `lauterbrunnen` or `aletsch`.

## Controls

- **Place** — Matterhorn, Lauterbrunnen or Aletsch.
- **Detail** — the geometric error, in pixels, a level-of-detail node may project to before it is
  refined. A node's error is the spacing of its own splats, so this reads directly: at 2,
  refinement continues until the splats being looked at sit about two pixels apart. Defaults to
  2 px on WebGPU and 8 px on WebGL2, where every frontier change is a CPU resort.
- **GPU residency** — a ceiling on what stays on the GPU, and the layer's renderer reservation.
  Changing it admits or evicts pages and re-downloads nothing. It is usually what binds, and it is
  the difference between a view at one resolution and a view at three — see
  [The budget is what mixed resolution is](#the-budget-is-what-mixed-resolution-is).
- **Fades**, **Analytic kernel**, **Orbit** — see above.

The status line reports how many splats are drawn, the range of zoom levels in the frontier, the
finest splat spacing, the resident GPU memory, and how many tiles the workers are building.

## Limitations

- The splat placement math assumes `MapView`. `GlobeView` uses a different projection and the
  anchor transform would need to be rebuilt for it.
- Correctly ordered Gaussian splat rendering re-sorts on every camera change. On WebGPU that is a
  compute pass; on WebGL2 it is a main-thread sort plus an attribute repack, and it is why the
  residency ceiling and the error threshold both default higher there.
- A height field cannot describe a vertical face or an overhang, so the steepest couple of percent
  of the terrain is covered by splats whose slope correction hit its ceiling and which therefore
  leave gaps. The background shows through them. Making the splats cover it would mean inventing a
  surface the elevation data does not contain.
- Splat positions are exact at the place's origin and drift by up to about 0.1% of the distance
  from it, because the layer scales by `viewport.distanceScales`, which deck.gl computes at the
  *viewport centre* rather than at the anchor — a few metres at the far edge of a view.
- deck.gl's own WebGPU support is still in progress (see the
  [WebGPU developer guide](https://deck.gl/docs/developer-guide/webgpu)). Picking is supported;
  effects, extensions and base map interleaving are not.
