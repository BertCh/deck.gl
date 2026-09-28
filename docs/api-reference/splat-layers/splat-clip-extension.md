# SplatClipExtension

Clips Gaussian splats to a half-space, slab, corridor or convex prism, without editing the data.

Masking to a parcel, a right of way or a slice plane is routine GIS work, and on a splat scene it is
routinely unavailable — Esri documents Slice as unsupported for splat layers, and CesiumJS has no
clipping-plane path for them at all.

The reason it is not simply a clip test is that a Gaussian is a volume, not a point. Testing only its
center cuts the scene along a visibly ragged boundary: a large splat straddling the plane either
vanishes whole or survives whole. This extension measures the signed distance in units of each
splat's *own* extent along the plane normal and attenuates opacity by the resulting partial
coverage, which gives a boundary that follows the geometry for one extra term per plane.

Nothing is removed from the source data and no buffer is rewritten. The region is evaluated in the
projection compute pass the renderer already runs, so it can animate freely.

```bash
npm install @deck.gl/core @deck.gl/splat-layers
```

```js
import {SplatLayer, SplatClipExtension} from '@deck.gl/splat-layers';

new SplatLayer({
  splatSource,
  coordinateOrigin: [-122.4, 37.74, 0],
  extensions: [new SplatClipExtension()],
  // Keep everything above z = 10 in the scene's own units.
  clipPlanes: [{normal: [0, 0, 1], distance: -10}]
});
```

> **WebGPU only.** The WebGL2 fallback has no projection compute pass to evaluate the region in, and
> doing it per row in JavaScript would cost more than the layer's whole frame budget.

## Properties

#### `clipPlanes` (SplatClipPlane[], optional) {#clipplanes}

- Default: `null`

Planes bounding the kept region, in the splat scene's own coordinates. A plane is
`{normal, distance}` and keeps the side its normal points toward, so `{normal: [0, 0, 1], distance:
-10}` keeps everything above `z = 10`. At most eight.

#### `clipCombine` (string, optional) {#clipcombine}

- Default: `'intersection'`

How the planes combine. `'intersection'` is a convex prism — a slab, a corridor, a box.
`'union'` keeps anything inside any one of them.

#### `clipSoftness` (number, optional) {#clipsoftness}

- Default: `1`

Width of the soft boundary as a multiple of each Gaussian's own extent along the normal. `1` fades a
splat over roughly its own standard deviation, which is the width at which the cut reads as a cut
through a volume rather than through a point set. Values below about `0.05` approach a hard,
center-based cut.

#### `clipInverted` (boolean, optional) {#clipinverted}

- Default: `false`

Keep the complement of the region instead of the region.

## Examples

A vertical slab, for a corridor study:

```js
clipPlanes: [
  {normal: [1, 0, 0], distance: 20},
  {normal: [-1, 0, 0], distance: 20}
]
```

Everything *outside* a bounding box, for excavating a site:

```js
clipPlanes: [
  {normal: [1, 0, 0], distance: 10},
  {normal: [-1, 0, 0], distance: 10},
  {normal: [0, 1, 0], distance: 10},
  {normal: [0, -1, 0], distance: 10}
],
clipInverted: true
```

A hard cut, when the ragged boundary is what you want:

```js
clipSoftness: 0.01
```

## Source

[modules/splat-layers](https://github.com/visgl/deck.gl/tree/master/modules/splat-layers/src/splat-clip-extension.ts)
