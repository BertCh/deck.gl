// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {SplatUpAxis} from './splat-layer';
import type {TerrainPlace} from './terrain-splat-source';
import type {TerrainHaze} from './terrain-surfels';

/**
 * Token-free tile sources.
 *
 * Mapterhorn publishes 512px Terrarium-encoded WebP elevation tiles; swisstopo publishes
 * SWISSIMAGE, the Swiss national orthophoto mosaic, as a Web Mercator WMTS pyramid. Both serve
 * zoom 17 over the Lauterbrunnen valley, so the terrain and its texture stay sharp at the
 * altitudes this example flies at.
 */
export const TERRAIN_IMAGE = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
export const SURFACE_IMAGE =
  'https://wmts10.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg';

/**
 * Lauterbrunnen valley floor, looking south toward the Jungfrau massif.
 *
 * The altitude is the swisstopo height-service value at this exact coordinate, so the splat
 * scene's ground plane lands on the terrain surface rather than floating above or sinking into it.
 */
export const SITE = {
  longitude: 7.9091,
  latitude: 46.5936,
  /** swisstopo height service, EPSG:2056 (2636053, 1160367) -> 785.4 m. */
  groundAltitude: 785.4
};

/** Terrarium packs elevation as `(r * 256 + g + b / 256) - 32768` metres. */
export const ELEVATION_DECODER = {
  rScaler: 256,
  gScaler: 1,
  bScaler: 1 / 256,
  offset: -32768
};

const HUGGING_FACE_BASE =
  'https://huggingface.co/datasets/Voxel51/gaussian_splatting/resolve/main/FO_dataset';
const VISGL_BASE =
  'https://raw.githubusercontent.com/visgl/deck.gl-data/master/formats/ply/gaussian-splat';

/** The two vis.gl-hosted halves are each a complete PLY, so they load as two intact batches. */
const TRAIN_VISGL_URLS = [
  `${VISGL_BASE}/train-iteration-7000-part-00.ply`,
  `${VISGL_BASE}/train-iteration-7000-part-01.ply`
];

/**
 * Where a scene's splats came from, which decides most of what the panel can say about it.
 *
 * A `capture` was trained from photographs somewhere else and is dropped onto the valley as a
 * stand-in, so it has arbitrary units, needs a footprint and a heading, and carries view-dependent
 * radiance worth a spherical-harmonic control.
 *
 * A `terrain` scene *is* the valley: baked from the same elevation service the mesh is drawn
 * from, already georeferenced, already in metres, and with nothing view-dependent about it. Both
 * reach the renderer through the same archive format and the same layer; the difference is only
 * in what the surrounding controls can meaningfully offer.
 */
export type SplatSceneKind = 'capture' | 'terrain' | 'live-terrain';

/**
 * The colour distance dissolves into, and how far away that is.
 *
 * Baked into the splat colours by the worker out of each splat's distance from the scene origin, and
 * matched to the canvas background. It exists for one situation: a splat frontier that ends in mid
 * air, with the background showing through behind it.
 *
 * **Not used by either path now, and kept only to make that situation recoverable.** Both the
 * archive and the live scenes draw over a `TerrainLayer` that continues to the horizon, so there is
 * no frontier edge left to hide - and haze measured from the scene *origin* rather than the camera
 * is only ever defensible while the camera orbits that origin, which stops being true the moment
 * anyone drags. Passing it to `TerrainSplatSource` puts it back, at the cost of colours the archive
 * does not share.
 */
export const TERRAIN_HAZE: TerrainHaze = {
  color: [12 / 255, 16 / 255, 24 / 255],
  rangeMeters: 45_000
};

/** What the canvas clears to. See {@link TERRAIN_HAZE}. */
export const BACKGROUND_COLOR: [number, number, number, number] = [12 / 255, 16 / 255, 24 / 255, 1];

/**
 * Worldwide imagery, if the visitor has some.
 *
 * Every default source in this example is token-free, and there is no token-free worldwide
 * orthophoto service this repository is in a position to point at - so the two non-Swiss places
 * below come up as bare relief unless a template is supplied. `?imagery=<template>` or
 * `VITE_IMAGERY_URL` takes a `{z}/{x}/{y}` URL; anything serving 256 px RGB tiles in Web Mercator
 * will do, including a Mapbox or Maxar endpoint with a key already in it.
 *
 * Relief-only is not a degraded mode so much as a different argument: it is the 30 m global grid with
 * nothing borrowed from a photograph, which is the honest picture of what a worldwide DEM contains.
 */
const IMAGERY_OVERRIDE =
  new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search).get('imagery') ??
  (import.meta as unknown as {env?: Record<string, string | undefined>}).env?.VITE_IMAGERY_URL ??
  null;

const SWISSTOPO_CREDIT = 'swisstopo SWISSIMAGE';

/**
 * Where the live source is pointed, and why these five.
 *
 * The first three are Swiss because Switzerland is where the elevation is best: over the Alps
 * Mapterhorn serves swissALTI3D rather than the 30 m global grid, and swisstopo publishes a national
 * orthophoto over exactly the same ground, both token-free. So the splats there are measurements
 * rather than an interpolation.
 *
 * **Lauterbrunnen is deliberately the same ground as the baked archive.** Switching between
 * `Lauterbrunnen terrain` and `Lauterbrunnen, live` is the comparison this example exists for: the
 * same surfel maths, the same layer, the same renderer, one published as an archive and one cut in
 * the browser while the camera moves.
 *
 * The last two are there to be pressed if the room asks whether this is a Swiss trick. The Grand
 * Canyon is the case where relief is cut *down* into the surface rather than up out of it, and Fuji
 * is a clean cone - the two ways a height field could have looked wrong. Both run on the worldwide
 * Copernicus grid, and both come up as bare relief unless {@link IMAGERY_OVERRIDE} is set.
 */
export const LIVE_PLACES: TerrainPlace[] = [
  {
    id: 'matterhorn',
    label: 'Matterhorn, live',
    description:
      'Nothing here was prepared. Mapterhorn elevation and swisstopo orthophotography, fetched ' +
      'as ordinary {z}/{x}/{y} tiles, decoded on a worker and cut into 16,384 oriented Gaussians ' +
      'a tile — one Arrow RecordBatch each, straight into GPU columns.',
    longitude: 7.6586,
    latitude: 45.9763,
    lookAtAltitude: 3000,
    rangeMeters: 8000,
    elevationDeg: 8,
    bearing: 25,
    imageryUrl: SURFACE_IMAGE,
    imageryCredit: SWISSTOPO_CREDIT
  },
  {
    id: 'lauterbrunnen-live',
    label: 'Lauterbrunnen, live',
    description:
      'The same valley as the baked archive, cut in the browser instead of published. Switch ' +
      'between the two: identical surfel maths, identical layer, one streamed from a manifest and ' +
      'one from a raster endpoint.',
    longitude: SITE.longitude,
    latitude: SITE.latitude,
    lookAtAltitude: 1400,
    rangeMeters: 6000,
    elevationDeg: 14,
    bearing: 165,
    imageryUrl: SURFACE_IMAGE,
    imageryCredit: SWISSTOPO_CREDIT
  },
  {
    id: 'aletsch',
    label: 'Aletsch, live',
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
  },
  {
    id: 'grand-canyon',
    label: 'Grand Canyon, live',
    description:
      'Relief cut down into the surface rather than up out of it, on the worldwide 30 m ' +
      'Copernicus grid. Bare relief unless an imagery template is supplied.',
    longitude: -112.1129,
    latitude: 36.0616,
    lookAtAltitude: 1400,
    rangeMeters: 15000,
    elevationDeg: 9,
    bearing: 250,
    imageryUrl: IMAGERY_OVERRIDE,
    imageryCredit: IMAGERY_OVERRIDE ? 'supplied imagery' : null
  },
  {
    id: 'fuji',
    label: 'Mount Fuji, live',
    description:
      'A clean cone on the worldwide 30 m grid, and the other way a height field could have ' +
      'looked wrong. Bare relief unless an imagery template is supplied.',
    longitude: 138.7274,
    latitude: 35.3606,
    lookAtAltitude: 2000,
    rangeMeters: 22000,
    elevationDeg: 7,
    bearing: 100,
    imageryUrl: IMAGERY_OVERRIDE,
    imageryCredit: IMAGERY_OVERRIDE ? 'supplied imagery' : null
  }
];

/**
 * deck.gl's own Web Mercator circumference, which is **not** `2 * PI * 6378137`.
 *
 * `@math.gl/web-mercator` divides by a flat `40.03e6`, and the camera below has to agree with the
 * viewport it is configuring rather than with the ellipsoid. See the matching note in
 * `scripts/terrain-grid.ts`, where ground *sizes* deliberately use the real circumference instead.
 */
const DECK_EARTH_CIRCUMFERENCE = 40.03e6;

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

export type SplatScene = {
  id: string;
  label: string;
  kind: SplatSceneKind;
  /** One line for the panel, so the description matches whatever is actually on screen. */
  description: string;
  /**
   * Each URL is a standalone PLY and becomes one preserved renderer batch.
   *
   * Absent for a terrain scene: there is no file to fall back to, because the splats do not exist
   * until they are baked out of a raster.
   */
  urls?: string[];
  /** Used only to show progress before the headers are read. */
  splatCount: number;
  upAxis: SplatUpAxis;
  /** Footprint the scene is normalized to once anchored on the valley floor. */
  sizeMeters: number;
  heading: number;
  /** The command that publishes this scene's archive, shown when none is found. */
  bakeCommand: string;
  /** Tried in order if `urls` fails, e.g. when Hugging Face is unreachable. */
  fallbackUrls?: string[];
  /** Where the live source is pointed. Present only on a `live-terrain` scene. */
  place?: TerrainPlace;
  /**
   * Base URL of a baked archive for this scene, if one is hosted somewhere other than beside
   * the app.
   *
   * Left unset, the app looks for `splat-archives/<id>/` under its own origin, which is where
   * `npm run bake` writes. Setting it points at a CDN copy instead; the format is identical.
   */
  archiveUrl?: string;
};

/** Where the bake scripts write, relative to the served app. */
export const LOCAL_ARCHIVE_BASE = 'splat-archives/';

/** Archive id the terrain baker writes by default. */
export const TERRAIN_ARCHIVE_ID = 'lauterbrunnen-terrain';

/**
 * Reference GraphDECO reconstructions from the Voxel51 dataset.
 *
 * None of these are Swiss captures -- there is no public, CORS-accessible Gaussian splat of the
 * Bernese Oberland -- so the example treats them as a stand-in capture dropped onto real Swiss
 * terrain. The point being demonstrated is the compositing, not the provenance of the scene.
 */
export const SPLAT_SCENES: SplatScene[] = [
  ...LIVE_PLACES.map((place): SplatScene => ({
    id: place.id,
    label: place.label,
    kind: 'live-terrain',
    description: place.description,
    place,
    bakeCommand: '',
    // Unknown until the camera has asked for some: a live scene has no total.
    splatCount: 0,
    upAxis: 'z-up',
    sizeMeters: 0,
    heading: 0
  })),
  {
    id: TERRAIN_ARCHIVE_ID,
    label: 'Lauterbrunnen terrain',
    kind: 'terrain',
    description:
      'The valley itself as Gaussian splats: one splat per Mapterhorn elevation sample, ' +
      'coloured by SWISSIMAGE, oriented to the surface and drawn over the mesh it was baked ' +
      'from. Nothing here was trained or reconstructed.',
    bakeCommand: 'npm run bake-terrain',
    // Reported before the manifest lands; the manifest is authoritative once it does.
    splatCount: 1_376_256,
    // Baked in a local east/north/up frame, so scene z is already up.
    upAxis: 'z-up',
    // Unused: a georeferenced archive is placed one to one and ignores the footprint control.
    sizeMeters: 0,
    heading: 0
  },
  {
    id: 'truck',
    label: 'Truck',
    kind: 'capture',
    description:
      'A photogrammetric capture of a truck, dropped onto the valley floor as a stand-in. ' +
      'The terrain mesh occludes the splats behind it.',
    bakeCommand: 'npm run bake -- --scene truck',
    urls: [`${HUGGING_FACE_BASE}/truck/point_cloud/iteration_7000/point_cloud.ply`],
    fallbackUrls: TRAIN_VISGL_URLS,
    splatCount: 1_692_538,
    upAxis: 'y-down',
    sizeMeters: 70,
    heading: 25
  },
  {
    id: 'train',
    label: 'Train',
    kind: 'capture',
    description:
      'A photogrammetric capture of a locomotive, hosted by vis.gl and published as two ' +
      'complete PLY files, so it loads as two intact batches.',
    bakeCommand: 'npm run bake -- --scene train',
    urls: TRAIN_VISGL_URLS,
    splatCount: 741_883,
    upAxis: 'y-down',
    sizeMeters: 55,
    heading: 0
  },
  {
    id: 'drjohnson',
    label: 'Dr Johnson',
    kind: 'capture',
    description: 'An indoor photogrammetric capture, anchored on the valley floor.',
    bakeCommand: 'npm run bake -- --scene drjohnson',
    urls: [`${HUGGING_FACE_BASE}/drjohnson/point_cloud/iteration_7000/point_cloud.ply`],
    fallbackUrls: TRAIN_VISGL_URLS,
    splatCount: 1_913_633,
    upAxis: 'y-down',
    sizeMeters: 40,
    heading: 0
  },
  {
    id: 'playroom',
    label: 'Playroom',
    kind: 'capture',
    description: 'An indoor photogrammetric capture, anchored on the valley floor.',
    bakeCommand: 'npm run bake -- --scene playroom',
    urls: [`${HUGGING_FACE_BASE}/playroom/point_cloud/iteration_7000/point_cloud.ply`],
    fallbackUrls: TRAIN_VISGL_URLS,
    splatCount: 1_495_461,
    upAxis: 'y-down',
    sizeMeters: 40,
    heading: 0
  }
];

export const INITIAL_VIEW_STATE = {
  longitude: SITE.longitude,
  latitude: SITE.latitude,
  zoom: 14.5,
  pitch: 70,
  bearing: 165,
  /**
   * Metre offset of the point the camera aims at, which for a map view is on the ground plane.
   *
   * Seeded to the valley floor rather than left at sea level. `TerrainController` converges to this
   * on its own by picking the mesh under the viewport centre, but the camera is controlled here - the
   * orbit writes to it - so the opening frame has to start where the controller would have put it,
   * or the first frames aim 785 m below the ground and the scene hangs off the top of the screen.
   */
  position: [0, 0, SITE.groundAltitude] as [number, number, number],
  maxPitch: 89,
  minZoom: 8,
  maxZoom: 19
};
