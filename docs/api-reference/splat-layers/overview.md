# @deck.gl/splat-layers

Renders 3D Gaussian splat scenes — radiance-field captures — as deck.gl layers, on a basemap,
composited with the rest of your layer stack.

```bash
npm install @deck.gl/core @deck.gl/splat-layers @luma.gl/splats
```

```js
import {SplatLayer} from '@deck.gl/splat-layers';
```

> This module is not bundled into the `deck.gl` umbrella package. Splat rendering is WebGPU-first
> and carries `@luma.gl/splats` as a dependency, so it is installed deliberately rather than by
> default.
>
> It also calls `@luma.gl/splats` APIs that are not in a published luma.gl release yet. Until they
> are, build it against the luma.gl `deck-splat-layers` branch.

## Layers

- [SplatLayer](./splat-layer.md) — renders a resident or streaming Gaussian splat scene.

## Extensions

- [SplatClipExtension](./splat-clip-extension.md) — clips splats to a half-space, slab or prism
  with a boundary that follows each Gaussian's own extent.

## Utilities

- [Device budgets](./splat-device-budgets.md) — residency presets for the machine in front of you.

## What makes this different from a point cloud

A Gaussian splat is a volume, not a point, and almost everything below follows from that:

- **It has to be sorted.** Splats alpha-blend, so they are drawn back to front. On WebGPU that sort
  is a GPU radix sort recorded in the layer's [compute stage](../core/layer.md#compute); on WebGL2
  it is a CPU sort, which is why the residency budget exists.
- **It is antialiased differently.** A sub-pixel Gaussian has to be dilated to stay visible, and
  dilation brightens what it widens. The layer compensates opacity for that by default, which is
  what keeps a scene from getting brighter as you zoom out.
- **Picking it is ambiguous.** The faint outer edge of a large, nearly transparent splat routinely
  sits in front of a small opaque one. `pickingAlphaThreshold` decides how much coverage a splat
  needs before it can claim a pixel. Picking is WebGPU only.
- **Clipping it by center looks wrong.** A splat straddling a clip plane would either vanish whole
  or survive whole. `SplatClipExtension` measures the distance in units of each splat's own extent
  instead.
