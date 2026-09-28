# SplatLayer

The `SplatLayer` renders a 3D Gaussian splat scene — a radiance-field capture — anchored to a
geographic position, composited into deck.gl's own render pass alongside the rest of your layers.

Two things follow from being a real deck.gl layer rather than an overlaid canvas. Opaque geometry
drawn by earlier layers occludes splats behind it, because they share a depth buffer. And the splats
participate in picking, which no other web splat renderer offers.

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

```bash
npm install @deck.gl/core @deck.gl/splat-layers @luma.gl/splats
```

```js
import {SplatLayer} from '@deck.gl/splat-layers';
new SplatLayer({});
```

## Backends

The layer binds whichever luma.gl splat renderer the device can run.

**WebGPU** projects, culls, sorts, evaluates spherical harmonics and issues an indirect draw
entirely as GPU compute over the source buffers, with no CPU row walk at all. That work is recorded
in the layer's `compute` stage — deck.gl's own encoder, immediately before the render pass that
consumes it — so there is no extra submission, no hand-written synchronization, and in a multi-view
frame each camera gets its own depth order.

**WebGL2** is the fallback. It has no storage buffers, so the sorted order has to be materialized by
physically permuting every source attribute on the CPU, and spherical harmonics above degree 0 are
evaluated per splat in JavaScript whenever the camera moves. Both costs are linear in the splat
count and both land on the main thread. This path works; it is not fast, and it is why the residency
budget exists.

`getSplatBackend()` reports which one the layer bound to.

## Giving it a scene

### Resident

`splatSource` takes decoded columns — positions, scales, rotations, colors, opacities and optional
spherical harmonics, as `@loaders.gl/splats` produces them from SPZ, a Gaussian PLY or a SOG bundle.
Everything is uploaded once and nothing changes after the first frame. Several sources are uploaded
as several batches and kept intact; the sort spans all of them.

### Streaming

`splatHierarchy` takes a level-of-detail tree, which the layer traverses against the camera each
frame. It requests the nodes whose geometric error projects to more than `maximumScreenSpaceError`
pixels, and a residency window bounds what stays on the GPU.

Two properties make that affordable. The renderer's command graph is compiled once against the
residency *ceiling* and reused for any frontier that fits, so pages arriving, being evicted and
reordering cost a pointer swap rather than a graph rebuild. And the traversal runs in the scene's
own units against a scene-local camera, so its screen-space error comes out in real pixels.

A streaming scene must supply `scenePercentiles`, unless it is `georeferenced`: the layer normalizes
arbitrary source units onto a metre footprint from robust percentiles of the splat centers, and no
single page has seen enough of them to measure that itself.

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
the layer's residency manager and destroyed when evicted.

#### `maximumScreenSpaceError` (number, optional) {#maximumscreenspaceerror}

- Default: `2`

Geometric error, in pixels, a streaming node may project to before it is refined. The sharpness
dial: a node's error is the mean spacing of its own splats, so at `2` refinement continues until the
splats you are looking at sit about two pixels apart. Where the residency budget binds first, this
does nothing.

#### `residencyBudget` (SplatResidencyBudget, optional) {#residencybudget}

Ceiling on what a streaming scene keeps on the GPU. Defaults to a preset chosen from the device;
anything set here overrides the matching field of that preset. See
[device budgets](./splat-device-budgets.md).

#### `deviceClass` (string, optional) {#deviceclass}

Forces a device-class preset instead of detecting one. One of `'desktop'`, `'integrated'`,
`'mobile-high'`, `'mobile'`, `'headset'`.

#### `maxConcurrentLoads` (number, optional) {#maxconcurrentloads}

- Default: `6`

Page fetches allowed to run at once while streaming.

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

### Placement

#### `coordinateOrigin` ([number, number, number], required) {#coordinateorigin}

`[longitude, latitude, altitudeMeters]` the scene is pinned to.

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

#### `pickingAlphaThreshold` (number, optional) {#pickingalphathreshold}

- Default: `0.5`

Minimum coverage a Gaussian must reach at a pixel to be pickable there. Picking a volumetric
primitive by first hit is genuinely ambiguous: the 3σ border of a large, nearly transparent Gaussian
can sit in front of a small opaque one while contributing almost nothing to the pixel.

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
