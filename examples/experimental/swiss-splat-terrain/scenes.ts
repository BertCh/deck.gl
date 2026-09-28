// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// The camera below has to agree with deck's own Web Mercator circumference, not the ellipsoid's;
// see `terrain-grid.ts`.
import {DECK_EARTH_CIRCUMFERENCE} from './terrain-grid';
import type {TerrainPlace} from './terrain-splat-source';
import type {TerrainHaze} from './terrain-surfels';

/**
 * Token-free tile sources.
 *
 * Mapterhorn publishes 512px Terrarium-encoded WebP elevation tiles; swisstopo publishes
 * SWISSIMAGE, the Swiss national orthophoto mosaic, as a Web Mercator WMTS pyramid. Over the Alps
 * Mapterhorn serves swissALTI3D rather than the 30 m global grid, and both go to zoom 17, so the
 * splats cut from them are measurements rather than an interpolation.
 */
export const TERRAIN_IMAGE = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
export const SURFACE_IMAGE =
  'https://wmts10.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg';

/** Terrarium packs elevation as `(r * 256 + g + b / 256) - 32768` metres. */
export const ELEVATION_DECODER = {
  rScaler: 256,
  gScaler: 1,
  bScaler: 1 / 256,
  offset: -32768
};

/**
 * The colour distance dissolves into, and how far away that is.
 *
 * Baked into the splat colours by the worker out of each splat's distance from the scene origin, and
 * matched to the canvas background. It exists for one situation: a splat frontier that ends in mid
 * air, with the background showing through behind it.
 *
 * **Not used now, and kept only to make that situation recoverable.** The splats draw over a
 * `TerrainLayer` that continues to the horizon, so there is no frontier edge left to hide - and haze
 * measured from the scene *origin* rather than the camera is only ever defensible while the camera
 * orbits that origin, which stops being true the moment anyone drags. Passing it to
 * `TerrainSplatSource` puts it back.
 */
export const TERRAIN_HAZE: TerrainHaze = {
  color: [12 / 255, 16 / 255, 24 / 255],
  rangeMeters: 45_000
};

const SWISSTOPO_CREDIT = 'swisstopo SWISSIMAGE';

/**
 * Where the live source is pointed.
 *
 * All three are Swiss because Switzerland is where the elevation is best, and swisstopo publishes a
 * national orthophoto over exactly the same ground, both token-free.
 */
export const PLACES: TerrainPlace[] = [
  {
    id: 'matterhorn',
    label: 'Matterhorn',
    description:
      'Mapterhorn elevation and swisstopo orthophotography, fetched ' +
      'as ordinary {z}/{x}/{y} tiles and decoded on a worker, where ' +
      'each tile becomes an Arrow RecordBatch of splats.',
    longitude: 7.6586,
    latitude: 45.9763,
    lookAtAltitude: 3000,
    rangeMeters: 6500,
    elevationDeg: 18,
    bearing: 25,
    imageryUrl: SURFACE_IMAGE,
    imageryCredit: SWISSTOPO_CREDIT
  },
  {
    id: 'lauterbrunnen',
    label: 'Lauterbrunnen',
    description:
      'A glacial trough with near-vertical walls, looking south up the valley toward the ' +
      'Jungfrau massif.',
    longitude: 7.9091,
    latitude: 46.5936,
    lookAtAltitude: 1400,
    rangeMeters: 6000,
    elevationDeg: 14,
    bearing: 165,
    imageryUrl: SURFACE_IMAGE,
    imageryCredit: SWISSTOPO_CREDIT
  },
  {
    id: 'aletsch',
    label: 'Aletsch',
    description:
      'The longest glacier in the Alps. Ice is the case an orthophoto has least to say about — ' +
      'almost no texture of its own — so what shape there is comes from the relief light the ' +
      'worker bakes into each splat’s DC term.',
    longitude: 8.0283,
    latitude: 46.505,
    lookAtAltitude: 2600,
    rangeMeters: 13000,
    elevationDeg: 11,
    bearing: 210,
    imageryUrl: SURFACE_IMAGE,
    imageryCredit: SWISSTOPO_CREDIT
  }
];

/** Screen heights between a `MapView` camera and the point it looks at, from deck's default altitude. */
const DECK_FOCAL_DISTANCE_SCREENS = 1.5;

/**
 * The zoom and pitch that put the camera where a place asks for it.
 *
 * A place declares a distance and an elevation angle, which is what framing a mountain is actually
 * about; `zoom` is neither. Zoom is a property of the viewport - the same value frames a different
 * amount of mountain on a laptop and a projector - so deriving it here is what keeps a place looking
 * the same in both, and what stops the numbers from having to be re-guessed against a window size.
 *
 * deck.gl places a `MapView` camera `1.5 * height` pixels from its target, so the distance in metres
 * is that times the ground resolution at the current zoom; this inverts it.
 */
export function getPlaceCamera(
  place: TerrainPlace,
  viewportHeight: number
): {zoom: number; pitch: number} {
  const metersPerPixel =
    place.rangeMeters / (DECK_FOCAL_DISTANCE_SCREENS * Math.max(1, viewportHeight));
  const groundResolution =
    (DECK_EARTH_CIRCUMFERENCE * Math.cos((place.latitude * Math.PI) / 180)) / 512;
  return {
    zoom: Math.log2(groundResolution / metersPerPixel),
    // deck.gl measures pitch from straight down, and clamps below 90 because the far plane diverges
    // as the camera approaches the horizon.
    pitch: Math.min(85, 90 - place.elevationDeg)
  };
}

/** The camera framing a place, in the window it is being shown in. */
export function getPlaceViewState(place: TerrainPlace, viewportHeight: number) {
  return {
    longitude: place.longitude,
    latitude: place.latitude,
    // Derived from the place's distance and elevation angle against the window, rather than stored
    // as a zoom that would frame differently on every screen.
    ...getPlaceCamera(place, viewportHeight),
    bearing: place.bearing,
    // Lifts the point the camera aims at off the sea-level plane and onto the mountain.
    // See `TerrainPlace.lookAtAltitude`.
    position: [0, 0, place.lookAtAltitude] as [number, number, number],
    maxPitch: 89,
    minZoom: 8,
    maxZoom: 19
  };
}
