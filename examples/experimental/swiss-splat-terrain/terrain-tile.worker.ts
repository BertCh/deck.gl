// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * Fetches, decodes and cuts one terrain tile into Gaussian columns, off the main thread.
 *
 * ## Why a worker
 *
 * Two `createImageBitmap` decodes are tens of milliseconds whenever a split reaches a raster nobody
 * has fetched, and tiles land in bursts of four as a quadtree node splits. On the main thread that
 * is a visible hitch every time the camera moves; here it is several of these running in parallel
 * and a transfer of five buffers.
 *
 * ## Why the source decode is cached
 *
 * A splat tile is not built from the raster at its own `z/x/y`. Under `TERRAIN_TILING` it is cut out of
 * the elevation tile three zooms up and the imagery tile two zooms up, so one elevation fetch serves
 * sixty-four tiles and one imagery fetch serves sixteen - and nothing fetched is thrown away, because
 * the block arithmetic puts exactly one elevation pixel and one imagery pixel under every splat.
 * Building a tile from a cached source is the surfel loop and nothing else.
 *
 * ## Why the buffers are packed rather than row objects
 *
 * They are transferred straight into an Arrow `RecordBatch` on the other side and from there into
 * GPU columns with no copy in between, so the layout this writes is the layout the GPU reads. See
 * `terrain-geoarrow.ts`.
 */

import {buildTerrainSurfels, type TerrainRaster} from './terrain-surfels';
import {
  getTerrainTileTransferables,
  type TerrainTileColumns,
  type TerrainTileRequest,
  type TerrainTileResponse,
  type TerrainTileSources
} from './terrain-tile-protocol';
import {assertTilingIsExact, TERRAIN_TILING} from './terrain-grid';

assertTilingIsExact(TERRAIN_TILING);

/** Colour used where imagery failed to load. Grey, so relief still reads. */
const MISSING_IMAGERY_RGB: readonly [number, number, number] = [150, 152, 156];

/**
 * Direction the relief shading comes from: north-west, about 50 degrees up.
 *
 * The cartographic convention, and deliberately *not* an attempt to match the sun the imagery was
 * captured under - an orthophoto mosaic is stitched from passes months apart and has no single sun.
 * It is a small term whose job is to let a ridge read as a ridge on a projector, where the imagery's
 * own contrast is the first thing to go.
 *
 * Must stay in step with the `LightingEffect` in `app.tsx`, or the splats and the mesh under them
 * shade differently.
 */
const SUN: readonly [number, number, number] = (() => {
  const vector: [number, number, number] = [-0.48, 0.42, 0.77];
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return [vector[0] / length, vector[1] / length, vector[2] / length];
})();

/**
 * Decoded rasters held per worker, least recently used first.
 *
 * Holds the *promise*, so the siblings of a split that arrive before the first fetch has landed wait
 * on one request rather than starting four. This holds elevation and imagery together - see
 * `loadSources` for why their keys are namespaced - so twenty-four entries is roughly a dozen of
 * each, a few megabytes, and more than one camera move asks of one worker, because the source routes
 * a raster's tiles to the worker that already holds it.
 */
const SOURCE_CACHE_SIZE = 24;

const rasters = new Map<string, Promise<TerrainRaster>>();
/** One canvas per raster size, kept: a 512² canvas per tile is a megabyte of churn a second. */
const canvases = new Map<string, OffscreenCanvas>();

/** `self`, narrowed to the two calls a worker actually makes. */
const workerScope = globalThis as unknown as {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<TerrainTileRequest>) => void
  ): void;
  postMessage(message: TerrainTileResponse, transfer?: Transferable[]): void;
};

workerScope.addEventListener('message', event => {
  void handleRequest(event.data);
});

async function handleRequest(request: TerrainTileRequest): Promise<void> {
  try {
    const {elevation, imagery} = await loadSources(request.sources);
    const columns = buildTerrainSurfels(request.tile, elevation, imagery, {
      origin: request.origin,
      sigma: request.sigma,
      thickness: request.thickness,
      relief: request.relief,
      lift: request.lift,
      sun: SUN,
      missingImageryRgb: MISSING_IMAGERY_RGB,
      haze: request.haze,
      tiling: TERRAIN_TILING,
      // Display-referred colour in eight bits a channel. See `colorFormat`: a float colour column
      // would put the whole scene through Reinhard tone mapping at half brightness.
      colorFormat: 'uint8'
    });
    const built: TerrainTileColumns = {
      key: request.key,
      count: TERRAIN_TILING.gridSize * TERRAIN_TILING.gridSize,
      positions: columns.positions,
      scales: columns.scales,
      rotations: columns.rotations,
      // `colorFormat: 'uint8'` above, so this is the array it asked for.
      colors: columns.colors as Uint8Array,
      opacities: columns.opacities,
      spacing: columns.spacing,
      bounds: columns.bounds,
      clampedSlopeCount: columns.clampedSlopeCount
    };
    workerScope.postMessage(
      {key: request.key, epoch: request.epoch, ok: true, columns: built},
      getTerrainTileTransferables(built)
    );
  } catch (error) {
    workerScope.postMessage({
      key: request.key,
      epoch: request.epoch,
      ok: false,
      missing: isMissing(error),
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, url: string) {
    super(`${status} for ${url}`);
    this.status = status;
  }
}

/** The elevation host's way of saying it has no archive here. */
function isMissing(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 404 || error.status === 204);
}

/**
 * Both rasters for one tile, from the cache or fetched into it.
 *
 * The elevation decides whether there is a tile at all; the imagery is allowed to fail on its own.
 *
 * **The cache key is namespaced by which raster it is, and it has to be.** The two sources sit at
 * different zooms - elevation three levels above a node, imagery two - so over the same ground a
 * node at zoom 19 takes its imagery from exactly the tile a node at zoom 20 takes its elevation
 * from: same `z/x/y`, same cache entry, different raster entirely. Sharing one key space paints
 * terrarium-encoded elevation onto the terrain as colour, and decodes an orthophoto as heights.
 */
async function loadSources(
  sources: TerrainTileSources
): Promise<{elevation: TerrainRaster; imagery: TerrainRaster | null}> {
  const [elevation, imagery] = await Promise.all([
    getRaster(`elevation:${sources.elevationKey}`, sources.elevationUrl),
    sources.imageryUrl
      ? getRaster(`imagery:${sources.imageryKey}`, sources.imageryUrl).catch(() => null)
      : Promise.resolve(null)
  ]);
  return {elevation, imagery};
}

/**
 * A decoded raster, from the cache or fetched into it.
 *
 * A 404 **stays** cached: it is a statement about coverage, and every sibling asking next would get
 * the same answer. A transport failure is dropped as soon as it lands, so a retry actually refetches
 * - otherwise one blip at a tile host would poison every tile later cut from that raster rather than
 * just the few already waiting on it.
 */
function getRaster(key: string, url: string): Promise<TerrainRaster> {
  const cached = rasters.get(key);
  if (cached) {
    // Re-inserted so the map's insertion order is a least-recently-used order.
    rasters.delete(key);
    rasters.set(key, cached);
    return cached;
  }

  const loading = decodeRaster(url);
  rasters.set(key, loading);
  loading.catch((error: unknown) => {
    if (!isMissing(error) && rasters.get(key) === loading) {
      rasters.delete(key);
    }
  });
  while (rasters.size > SOURCE_CACHE_SIZE) {
    rasters.delete(rasters.keys().next().value!);
  }
  return loading;
}

/** Fetch and decode one raster tile to RGBA bytes. */
async function decodeRaster(url: string): Promise<TerrainRaster> {
  const response = await fetch(url);
  // `204 No Content` is `ok`, but it is how the elevation host says it has no archive here: there
  // is no body to decode.
  if (!response.ok || response.status === 204) {
    throw new HttpError(response.status, url);
  }
  const bitmap = await createImageBitmap(await response.blob());
  const {width, height} = bitmap;
  // One canvas per size, kept. Safe with several decodes in flight because nothing below awaits.
  const canvasKey = `${width}x${height}`;
  let canvas = canvases.get(canvasKey);
  if (!canvas) {
    canvas = new OffscreenCanvas(width, height);
    canvases.set(canvasKey, canvas);
  }
  const context = canvas.getContext('2d', {
    willReadFrequently: true
  }) as OffscreenCanvasRenderingContext2D;
  context.clearRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0);
  const imageData = context.getImageData(0, 0, width, height);
  bitmap.close();
  return {width, height, channels: 4, data: imageData.data};
}
