# TerrainController

Inherits from [MapController](./map-controller.md).

The `TerrainController` extends `MapController` with terrain-aware navigation. As the user pans and zooms, the controller automatically adjusts the camera's elevation to follow the terrain, providing a natural navigation experience over 3D tilesets and elevated terrain.

## Requirements

`TerrainController` works by picking the terrain elevation at the center of the viewport. For this to work, at least one layer in the scene must use the `pickable: '3d'` option. For example:

```js
import {Tile3DLayer} from '@deck.gl/geo-layers';

new Tile3DLayer({
  // ...
  pickable: '3d'
});
```

Without a `pickable: '3d'` layer, the controller has no elevation data and will behave like a standard `MapController`.

## Behavior

The elevation under the viewport center is sampled a couple of times a second and written into the view state as `position[2]`, the camera's altitude baseline. Zoom, pitch and rotation are all measured against that baseline, so zooming approaches the surface rather than the sea-level plane and the camera rides over relief instead of through it.

Two things keep the baseline from showing up as camera motion of its own:

- The first fix is adopted without moving the camera. The baseline is traded against `zoom` and the view center, which reproduces the view the app asked for from the new reference altitude — so `zoom` after the first sample is normally higher than the `zoom` in `initialViewState`. When the camera starts out below the terrain, no zoom can reproduce the view, and the controller climbs to the surface instead.
- Later changes move the camera, because following the terrain is the point, but the baseline is filtered on elapsed time and capped at a fixed on-screen speed. A tile refining under the sample point, or the center of the view crossing a cliff edge onto something far behind it, reads as camera motion rather than as a jump. A single outlying sample has to be confirmed by a second one before it is followed at all, and a sample that hits nothing — sky above the horizon, or a tile that has not arrived — leaves the baseline where it is.

The baseline tracks the terrain on every rendered frame rather than only while the user is interacting, so a gesture never has to absorb an accumulated correction.

## Usage

Use with the default view:

```js
import {Deck, TerrainController} from '@deck.gl/core';

new Deck({
  controller: {type: TerrainController},
  initialViewState: viewState
});
```

is equivalent to:

```js
import {Deck, MapView, TerrainController} from '@deck.gl/core';

new Deck({
  views: new MapView({
    controller: {type: TerrainController}
  }),
  initialViewState: viewState
});
```

## Options

Supports all [MapController options](./map-controller.md#options) with the following defaults:

- `rotationPivot` - default `'3d'` (rotate around the picked object under the pointer)

## Source

[modules/core/src/controllers/terrain-controller.ts](https://github.com/visgl/deck.gl/blob/master/modules/core/src/controllers/terrain-controller.ts)
