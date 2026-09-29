# SplatLayer

The `SplatLayer` renders a 3D Gaussian splat scene — a radiance-field capture — anchored to a
geographic position, composited into deck.gl's own render pass alongside the rest of your layers.

Two things follow from being a real deck.gl layer rather than an overlaid canvas. Opaque geometry
drawn by earlier layers occludes splats behind it, because they share a depth buffer. And on WebGPU
the splats participate in deck.gl's own picking, hover and tooltips.

```bash
npm install @deck.gl/core @deck.gl/splat-layers @luma.gl/splats
```

> `@deck.gl/splat-layers` calls `@luma.gl/splats` APIs that are not in a published luma.gl release
> yet. Until they are, it has to be built against the luma.gl `deck-splat-layers` branch.

```js
import {Deck} from '@deck.gl/core';
import {SplatLayer} from '@deck.gl/splat-layers';

const layer = new SplatLayer({
  id: 'capture',
  splatSource,
  coordinateOrigin: [-122.4, 37.74, 0],
  sizeMeters: 120,
  upAxis: 'y-down',
  pickable: true
});

new Deck({layers: [layer]});
```

## Backends

The layer binds whichever luma.gl splat renderer the device can run.

**WebGPU** projects, culls, sorts, evaluates spherical harmonics and issues an indirect draw
entirely as GPU compute over the source buffers, with no CPU row walk at all. That work is recorded
in the layer's `compute` stage — deck.gl's own encoder, immediately before the render pass that
consumes it — so there is no extra submission and no hand-written synchronization.

**WebGL2** is the fallback. It has no storage buffers, so the sorted order has to be materialized by
physically permuting every source attribute on the CPU, and spherical harmonics above degree 0 are
evaluated per splat in JavaScript whenever the camera moves. Both costs are linear in the splat
count and both land on the main thread. This path works; it is not fast, and it is why the residency
budget exists. **The WebGL2 path is not pickable**: it has no picking output, so the layer skips
deck.gl's picking passes there.

`getSplatBackend()` reports which one the layer bound to.

### One view at a time

The layer owns one renderer, one traversal and one set of camera uniforms, so it renders into a
single viewport per frame: the first one it is drawn in. In a multi-view `Deck` it is skipped in
every other viewport, rather than re-sorting and re-traversing for each camera in turn. Use
`layerFilter` to choose which view shows it; to show a scene in several views, give each view its
own layer and route each with `layerFilter`.

### Positioning

The scene is positioned by [`coordinateOrigin`](#coordinateorigin), `heading`, `upAxis` and the
normalization described under the placement properties below. `coordinateSystem` is ignored.

## Giving it a scene

### Resident

`splatSource` takes decoded columns — positions, scales, rotations, colors, opacities and optional
spherical harmonics — in luma.gl's `SplatSource` layout. No published loaders.gl release decodes
Gaussian PLY or SOG into these columns yet, so decode them yourself for now. Everything is uploaded
once and nothing changes after the first frame. Several sources are uploaded as several batches and
kept intact; the sort spans all of them.

### Streaming

`splatHierarchy` takes a level-of-detail tree, which the layer traverses against the camera each
frame. `createPageLoader(device)` is called once per scene, and the prop is compared by identity: a
new object is a new scene, so keep one per scene. It requests the nodes whose geometric error projects to more than `maximumScreenSpaceError`
pixels, and a residency window bounds what stays on the GPU.

Two properties make that affordable. The renderer's command graph is compiled once against the
residency *ceiling* and reused for any frontier that fits, so pages arriving, being evicted and
reordering cost a pointer swap rather than a graph rebuild. And the traversal runs in the scene's
own units against a scene-local camera, so its screen-space error comes out in real pixels.

A streaming scene must supply `scenePercentiles`, unless it is `georeferenced`: the layer normalizes
arbitrary source units onto a metre footprint from robust percentiles of the splat centers, and no
single page has seen enough of them to measure that itself. With neither, nothing is drawn and the
layer logs a warning.

### Streaming a tree that grows

An archive knows its whole tree from its manifest. A tile service does not: a quadtree over a raster
endpoint has no bottom until a request 404s, so nodes have to be discovered as the camera asks for
them. Returning a new `splatHierarchy` prop for each discovery would release the scene and start
over, which is the opposite of streaming.

So a source that grows mutates its own `roots` and implements `subscribe`:

```ts
const source = {
  roots,
  summary,
  createPageLoader,
  subscribe(onRootsChange) {
    listeners.add(onRootsChange);
    return () => listeners.delete(onRootsChange);
  }
};
```

The layer re-indexes the traversal in place. Every page already loaded survives it, because the
residency window belongs to the layer rather than to the traversal. Coalesce the notification to
once a frame: re-indexing walks the whole tree, and a burst of siblings landing together would
otherwise pay for it once each for the same result.

## Properties

Inherits from all [Base Layer](../core/layer.md) properties.

### Data

#### `splatSource` (SplatSource | SplatSource[], optional) {#splatsource}

Decoded, caller-owned splat columns. Uploaded once and kept intact.

#### `splatHierarchy` (SplatHierarchySource, optional) {#splathierarchy}

A streaming level-of-detail tree. Takes precedence over `splatSource`. Pages it loads are owned by
the layer's residency manager and destroyed when evicted. Compared by identity.

#### `maximumScreenSpaceError` (number, optional) {#maximumscreenspaceerror}

- Default: `2`

Geometric error, in CSS pixels, a streaming node may project to before it is refined. The sharpness
dial: a node's error is the mean spacing of its own splats, so at `2` refinement continues until the
splats you are looking at sit about two pixels apart. Where the residency budget binds first, this
does nothing.

CSS pixels rather than device pixels, like other pixel sizes in deck.gl, so one value looks the same
on any display; a 2x display is not refined twice as deep.

#### `residencyBudget` (SplatResidencyBudget, optional) {#residencybudget}

Ceiling on what a streaming scene keeps on the GPU. Defaults to a preset chosen from the device;
anything set here overrides the matching field of that preset. A `maxResidentSplats` set without a
`maxGpuBytes` brings the byte ceiling that splat count implies rather than keeping the preset's, so
raising the splat count raises the whole budget. See [device budgets](./splat-device-budgets.md).

The traversal plans its selection against about two thirds of whichever ceiling binds first: a
quarter of what remains is reserved for the coarse parents kept resident under their children, and
an eighth for pages lingering while their replacements fade in. A byte ceiling is converted to
splats at what this scene's resident pages actually cost, measured once pages arrive, so a degree-3
scene is not planned as if it cost as little as a degree-1 one.

#### `deviceClass` (string, optional) {#deviceclass}

Forces a device-class preset instead of detecting one. One of `'desktop'`, `'integrated'`,
`'mobile-high'`, `'mobile'`, `'headset'`.

#### `maxConcurrentLoads` (number, optional) {#maxconcurrentloads}

- Default: `6`

Page fetches allowed to run at once while streaming.

### Where detail goes

These three are **streaming only**. `foveation` and `distanceFalloff` divide a node's projected
error before it is compared with `maximumScreenSpaceError`. The residency budget is planned against
that same weighted error, so they decide which part of the view the budget is spent on, not only
the order pages load in. `motionErrorScale` changes only what is requested, never what is drawn.

#### `foveation` (object | null, optional) {#foveation}

- Default: `{radius: 0.3, strength: 1}`

Detail concentrated around a gaze position. `center` is viewport-normalized and defaults to
`[0.5, 0.5]`. Within `radius` of it nothing changes. Beyond that, error is divided by
`1 + strength * (distance - radius)`. Distance is measured to the nearest edge of a node's
footprint, so a large node close to the camera is never treated as peripheral. `null` weights the
whole view alike.

#### `distanceFalloff` (number, optional) {#distancefalloff}

- Default: `0.5`

How much faster than perspective error falls off beyond the camera's target. A node `k` times
farther than the target has its error divided by `k ^ distanceFalloff`, which keeps an oblique view
from spending its budget on the horizon. `0` leaves distance to perspective alone.

#### `motionErrorScale` (number, optional) {#motionerrorscale}

- Default: `4`

How much coarser than `maximumScreenSpaceError` a page may be before it is requested while the
camera moves. `1` disables it. Only loading is affected. Detail that is already resident keeps being
drawn at full resolution. Ground whose finer pages have not loaded shows its coarser resident
ancestor until the camera settles. Pages already in flight are not cancelled.

The layer measures how fast the scene at the camera's target sweeps across the screen and scales
the threshold in proportion. It stays at 1× for a still or slowly orbiting camera. The level holds
for a quarter second through the pauses of a gesture, then recovers over a few hundred
milliseconds.

### Anti-popping

These three are **streaming only**. The pages they touch are produced by the hierarchy's own page
loader and owned by the layer's residency manager, so the layer is free to write their opacity
column; a caller-owned `splatSource` is never touched.

#### `fadeInDuration` (number, optional) {#fadeinduration}

- Default: `300`

Milliseconds a page takes to ramp up when it enters the frontier. `0` disables all three.

The traversal already keeps a coarse parent on screen until its children are resident, so a
refinement never opens a hole — but it crosses that boundary in a single frame, and under a moving
camera that snap happens somewhere on screen several times a second. It reads as a bug rather than as
a quadtree refining.

#### `fadeOutDuration` (number, optional) {#fadeoutduration}

- Default: `150`

Milliseconds a released page takes to ramp down. Deliberately shorter than the fade in: a released
page is only ever covered by pages that are already fully up, so this is exactly how long two
surfaces are interleaved in the depth sort, and it only has to be long enough not to read as a cut.

A page is **held at the opacity it had** until the pages that replaced it reach full opacity, and
only then fades. It is not a cross-dissolve: two layers at half opacity composite to 75% coverage, so
the background would show through a quarter of every patch changing level, and a camera move changes
level over much of the screen at once.

#### `fadeHoldDuration` (number, optional) {#fadeholdduration}

- Default: `2000`

Longest a departed page is held waiting for its replacements, in milliseconds. A backstop rather than
a timing: the hold normally ends when the replacements are up, which after a large camera move can
take a second or two. Past this it is blurring finished ground for something that is not coming.

Held pages are kept resident, so they are also bounded by size: once they exceed an eighth of the
residency budget, the longest-held give up their hold early and fade out, so that a large camera
move cannot leave the whole previous frontier occupying the room the new one needs.

### Placement

#### `coordinateOrigin` ([number, number, number], optional) {#coordinateorigin}

- Default: `[0, 0, 0]`

`[longitude, latitude, altitudeMeters]` the scene is pinned to. `coordinateSystem` is ignored.

#### `sizeMeters` (number, optional) {#sizemeters}

- Default: `120`

Target horizontal footprint. A reconstruction arrives in arbitrary units with no geographic meaning,
so the layer measures a robust extent and stretches it onto this. Ignored when `georeferenced` is
set.

#### `georeferenced` (boolean, optional) {#georeferenced}

- Default: `false`

Whether the scene's units are already metres about `coordinateOrigin`. A scene baked out of a
geographic raster is placed one to one and `sizeMeters` stops applying.

#### `scenePercentiles` (object, optional) {#scenepercentiles}

`{x, y, z}` robust per-axis extents in source units. Required for a streaming scene; measured from
the columns for a resident one.

#### `heading` (number, optional) {#heading}

- Default: `0`

Rotation about the vertical axis, in degrees clockwise from north.

#### `upAxis` (string, optional) {#upaxis}

- Default: `'y-down'`

Axis convention of the source scene. GraphDECO training checkpoints are `y-down`.

### Appearance

#### `sphericalHarmonicsDegree` (number, optional) {#sphericalharmonicsdegree}

- Default: `1`

Highest spherical-harmonic band evaluated at render time. Each band is view-dependent color the
renderer has to evaluate per splat per frame; degree 3 is 45 coefficients per splat.

#### `antialiasing` (string, optional) {#antialiasing}

- Default: `'mip-splatting'`
- **WebGPU only**

Screen-space antialiasing. The dilation filter that keeps sub-pixel Gaussians visible also brightens
them; `'mip-splatting'` compensates opacity for the determinant change, which restores the
normalization dilation removes. The difference is widest exactly when a geospatial camera zooms out.
`'none'` reproduces base 3DGS.

#### `kernel2DSize` (number, optional) {#kernel2dsize}

- Default: `0.3`

One-sigma width of the screen-space dilation `antialiasing` compensates for, in **device** pixels.

`0.3` is the value Mip-Splatting prescribes, and it is the right one for a scene *trained* with
its matching 3D smoothing filter: training already bounds how much detail the Gaussians carry
above the pixel Nyquist, so the screen-space filter only has to catch what is left.

A scene that was not trained has no such bound. Splats laid out on a regular lattice — a height
field cut into surfels is the usual way to get one — alias coherently rather than as noise, and the
beat between the lattice and the pixel grid reads as moiré that crawls under the camera. It is
worst at grazing incidence, where the projected spacing along the view direction collapses while
the spacing across it does not. A Gaussian of `0.3` device pixels attenuates the Nyquist frequency
by about a third, which is nowhere near enough there; around `1.0` band-limits it, for a real but
mild softening. Above about `1.5` the softening dominates.

#### `fragmentKernel` (string, optional) {#fragmentkernel}

- Default: `'gaussian'`
- **WebGPU only**

`'analytic'` integrates the Gaussian over the pixel footprint rather than sampling its center, which
removes the residual aliasing of sub-pixel splats for roughly a tenth of the frame.

#### `depthKeyMode` (string, optional) {#depthkeymode}

- Default: `'float16'`
- **WebGPU only**

Distribution used to quantize depth into the global sort key. Normalized device depth (`'ndc'`) is
hyperbolic: at geospatial near/far ratios almost the whole key range is spent within metres of the
camera, and distant Gaussians collapse into ties that resolve arbitrarily and pop under rotation.
`'float16'` keeps usable resolution across the whole range at the same key width. `'linear'` and
`'float32'` are also available.

#### `alphaMode` (string, optional) {#alphamode}

- Default: `'blend'`
- **WebGPU only**

`'stochastic'` dithers coverage and blends opaquely with depth writes, consuming no depth ordering
at all — which makes splats behave like opaque geometry inside deck.gl's render pass, at the cost of
noise that needs temporal accumulation to resolve.

#### `radiusScale`, `alphaScale`, `exposure`, `alphaCutoff` (number, optional)

- Defaults: `1`, `1`, `1`, `0.5 / 255`

Multipliers on each Gaussian's support radius, its decoded opacity, its linear radiance before
display tone mapping, and the minimum fragment opacity retained after attenuation.

#### `screenSizeCutoffPixels` (number, optional) {#screensizecutoffpixels}

- Default: `0`
- **WebGPU only**

Minimum projected one-sigma radius, in pixels, a splat must cover to be drawn. Evaluated in the
projection compute pass, so a culled splat drops out of the sort, the draw count and the rasterizer
alike. Ignored on WebGL2, where the equivalent test would cost more than the overdraw it saves.

#### `depthCompare` / `depthWriteEnabled`

- Defaults: `'less-equal'` / `false`

How splats test and write depth against geometry already drawn into the same pass. Depth writes stay
off so splats do not occlude each other.

### Picking

Picking is **WebGPU only**. The layer takes part in deck.gl's color picking; deck.gl's depth
picking (`pickZ`, as used by `pickObject` with `unproject3D`) is not supported and skips the layer.

#### `pickingAlphaThreshold` (number, optional) {#pickingalphathreshold}

- Default: `0`

Minimum coverage a Gaussian must reach at a pixel to be pickable there. At the default picking
follows `alphaCutoff`: whatever is drawn at a pixel can be picked there.

Picking a volumetric primitive by first hit is genuinely ambiguous: the 3σ border of a large, nearly
transparent Gaussian can sit in front of a small opaque one while contributing almost nothing to
the pixel. Raising this makes such borders transparent to picking, at the cost of making Gaussians
whose opacity never reaches it unpickable anywhere.

With `pickable: true`, the picking info carries `splatBatchIndex`, `splatBatchRowIndex` and
`splatSemanticId` alongside the usual fields.

> Picking resolves up to 16,777,215 rows, the limit of deck.gl's 24-bit picking color. A frontier
> larger than that reports no pick for rows past the limit rather than aliasing onto another row.

### Clipping

#### `clipRegion` (SplatClipRegion, optional) {#clipregion}

Non-destructive soft clipping to a half-space, slab or convex prism, evaluated per frame in the
projection pass. See [SplatClipExtension](./splat-clip-extension.md), which is the more convenient
way to set it.

### Callbacks

#### `onBackendChange` (Function, optional) {#onbackendchange}

Called with `'gpu-graph'`, `'cpu-sort'` or `null` once the device and scene are both known.

#### `onStreamingStats` (Function, optional) {#onstreamingstats}

Called with `{hierarchy, residency, drawnSplatCount, frontier, lingeringBatchCount}` whenever a
streaming frontier changes. Fired on change rather than per frame, because a settled camera changes
neither.

`frontier` is the traversal's own entry list, borrowed rather than copied — node, chunk, depth,
projected error, and whether the page is standing in for finer ones that have not arrived. It is
valid until the next frontier change; copy anything you keep. `lingeringBatchCount` is how many pages
are being drawn only to cover ground whose replacements are still ramping up.

## Methods

#### `getSplatBackend()`

Which renderer the layer bound to, or `undefined` before a scene is uploaded.

#### `getSplatStats()`

Renderer diagnostics — splat count, GPU bytes, draw calls. On the WebGL2 path this refreshes the
camera-dependent ordering before answering, which is the same full CPU sort a frame pays; poll it
sparingly.

#### `getStreamingStats()`

Traversal and residency counters for a streaming scene; `undefined` on the resident path.

## Source

[modules/splat-layers](https://github.com/visgl/deck.gl/tree/master/modules/splat-layers/src/splat-layer.ts)
