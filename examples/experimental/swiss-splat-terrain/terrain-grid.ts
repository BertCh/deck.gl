// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * The tile arithmetic the terrain source runs on, and nothing else. Imports nothing.
 *
 * Kept separate because it is the part that is easy to get subtly wrong and easy to check in
 * isolation: which raster tile backs which splat node, where inside it, and what a pixel's position
 * actually is once it reaches deck.gl's common space.
 */

/** Semi-major axis of the WGS 84 ellipsoid, which Web Mercator treats as a sphere. */
const EARTH_RADIUS = 6378137;
/** Full width of the Web Mercator plane in metres, from the ellipsoid Web Mercator is defined on. */
const EARTH_CIRCUMFERENCE = 2 * Math.PI * EARTH_RADIUS;
/** deck.gl's common space is Web Mercator at zoom 0 with a 512-unit world. */
const COMMON_WORLD_SIZE = 512;

/**
 * The circumference `@math.gl/web-mercator` uses, which is **not** the one above.
 *
 * `getDistanceScales` divides by a flat `40.03e6` rather than `2 * PI * 6378137` = `40075017`, a
 * difference of 0.11%. That looks like a rounding choice and is harmless on its own — but the
 * layer converts scene units back to common space with deck's number, so building positions with
 * the *true* circumference and expanding them with deck's leaves a 0.11% scale error. A few
 * kilometres from the origin that is metres of drift, which on a hillside is a visible slip
 * between the splats and the mesh underneath them.
 *
 * So the two are kept apart deliberately: ground *sizes* use the real circumference, because a
 * splat's extent is a real distance, and the conversion to common space uses deck's, because
 * that conversion has to be exactly undone by code this file does not control.
 */
export const DECK_EARTH_CIRCUMFERENCE = 40.03e6;

/** Native pixel size of each raster source. */
export const ELEVATION_TILE_SIZE = 512;
export const IMAGERY_TILE_SIZE = 256;

/**
 * How a splat node is cut out of the two rasters.
 *
 * The invariant every preset has to satisfy: `sourceTileSize / 2 ** sourceLevels === gridSize`, for
 * both rasters. That is what gives a node **exactly one elevation pixel and one imagery pixel per
 * splat** - no resampling, no interpolation, no invented detail - and it is also what makes siblings
 * share a fetch, since `2 ** sourceLevels` squared nodes are cut from one raster.
 */
export type TerrainTiling = {
  /** Splats along one edge of a node. */
  gridSize: number;
  /** Zoom levels between a splat node and the elevation tile it is cut from. */
  elevationSourceLevels: number;
  /** Zoom levels between a splat node and the imagery tile it is cut from. */
  imagerySourceLevels: number;
};

/**
 * How the source cuts its nodes: 128 x 128, or 16,384 splats a node.
 *
 * A 64² node adapts to the error field four times more finely, which is the better shape for a
 * scene refining against a moving camera - but only if the traversal can afford to walk the tree it
 * produces. Against a published `@luma.gl/splats` it cannot: every page the residency budget refuses
 * re-runs the whole traversal, so a frontier the budget cannot finish refining costs `4 x frontier`
 * tree walks per drawn frame. Both halves of that scale with the node count, so quartering it is a
 * sixteenfold cut. At 64² this scene ran at 0.8 fps; at 128² it holds 100+ fps on the same camera
 * with the same finest splat spacing. The luma.gl branch this example can build against no longer
 * re-walks per refusal, so retrying 64² there is worth doing - with a frame timer, not an argument.
 *
 * The invariant holds: 512 / 2² and 256 / 2¹ are both 128.
 */
export const TERRAIN_TILING: TerrainTiling = {
  gridSize: 128,
  elevationSourceLevels: 2,
  imagerySourceLevels: 1
};

/** Splats along one edge of a node. */
export const NODE_GRID_SIZE = TERRAIN_TILING.gridSize;

/** Checks a tiling against the one-pixel-per-splat invariant. */
export function assertTilingIsExact(tiling: TerrainTiling): void {
  const elevationPixels = ELEVATION_TILE_SIZE / 2 ** tiling.elevationSourceLevels;
  const imageryPixels = IMAGERY_TILE_SIZE / 2 ** tiling.imagerySourceLevels;
  if (elevationPixels !== tiling.gridSize || imageryPixels !== tiling.gridSize) {
    throw new Error(
      `tiling ${tiling.gridSize}² needs ${tiling.gridSize} source pixels a side, ` +
        `got ${elevationPixels} elevation and ${imageryPixels} imagery`
    );
  }
}

/** A slippy-map tile address. */
export type TileAddress = {z: number; x: number; y: number};

/** Where inside a source tile a node's samples come from. */
export type SourceBlock = {
  tile: TileAddress;
  /** Pixel offset of the block's top-left corner within the source tile. */
  offsetX: number;
  offsetY: number;
};

/** Longitude of a tile-space x coordinate, which may be fractional. */
export function tileXToLongitude(tileX: number, zoom: number): number {
  return (tileX / 2 ** zoom) * 360 - 180;
}

/** Latitude of a tile-space y coordinate, which may be fractional. */
export function tileYToLatitude(tileY: number, zoom: number): number {
  const n = Math.PI * (1 - (2 * tileY) / 2 ** zoom);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

export function longitudeToTileX(longitude: number, zoom: number): number {
  return ((longitude + 180) / 360) * 2 ** zoom;
}

export function latitudeToTileY(latitude: number, zoom: number): number {
  const radians = (latitude * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * 2 ** zoom;
}

/**
 * Projects longitude and latitude into deck.gl's common space.
 *
 * The same Web Mercator the `Viewport` uses, reimplemented here rather than imported, so the
 * tile workers carry no deck.gl runtime dependency. Only *differences* of these values are ever
 * used, so the shared constant factor cancels either way.
 */
export function projectFlat(longitude: number, latitude: number): [number, number] {
  const lambda = (longitude * Math.PI) / 180;
  const phi = (latitude * Math.PI) / 180;
  const x = (COMMON_WORLD_SIZE * (lambda + Math.PI)) / (2 * Math.PI);
  const y =
    (COMMON_WORLD_SIZE * (Math.PI - Math.log(Math.tan(Math.PI / 4 + phi / 2)))) / (2 * Math.PI);
  return [x, y];
}

/**
 * Common-space units per metre at a latitude.
 *
 * Web Mercator stretches with latitude, so this is the factor that turns a real metre into the
 * space the renderer works in. The layer applies the same conversion at draw time using the
 * viewport's own scales; building positions already divided by this value at the scene's origin
 * is what makes the two agree.
 */
export function unitsPerMeter(latitude: number): number {
  return COMMON_WORLD_SIZE / (DECK_EARTH_CIRCUMFERENCE * Math.cos((latitude * Math.PI) / 180));
}

/** Ground width of one tile at a zoom and latitude, in metres. */
export function getTileGroundSize(zoom: number, latitude: number): number {
  return (EARTH_CIRCUMFERENCE * Math.cos((latitude * Math.PI) / 180)) / 2 ** zoom;
}

/** Ground distance between adjacent splats of a node at this zoom, in metres. */
export function getSplatSpacing(
  zoom: number,
  latitude: number,
  gridSize: number = NODE_GRID_SIZE
): number {
  return getTileGroundSize(zoom, latitude) / gridSize;
}

/**
 * The block of a source raster that backs one splat node.
 *
 * A node at zoom `z` covers exactly the extent of tile `(z, x, y)`. Its elevation comes from the
 * tile `sourceLevels` zooms above, whose extent is `2 ** sourceLevels` times wider, so the node
 * occupies one cell of a `2 ** sourceLevels` grid inside it — the cell picked out by the low bits
 * of `x` and `y`. Siblings therefore share one fetch, which is the whole reason for cutting this
 * way rather than fetching a raster per node.
 */
export function getSourceBlock(
  node: TileAddress,
  sourceLevels: number,
  sourceTileSize: number
): SourceBlock {
  const factor = 2 ** sourceLevels;
  const blockSize = sourceTileSize / factor;
  return {
    tile: {z: node.z - sourceLevels, x: node.x >> sourceLevels, y: node.y >> sourceLevels},
    offsetX: (node.x & (factor - 1)) * blockSize,
    offsetY: (node.y & (factor - 1)) * blockSize
  };
}

export function getElevationBlock(
  node: TileAddress,
  tiling: TerrainTiling = TERRAIN_TILING
): SourceBlock {
  return getSourceBlock(node, tiling.elevationSourceLevels, ELEVATION_TILE_SIZE);
}

export function getImageryBlock(
  node: TileAddress,
  tiling: TerrainTiling = TERRAIN_TILING
): SourceBlock {
  return getSourceBlock(node, tiling.imagerySourceLevels, IMAGERY_TILE_SIZE);
}

/** `z/x/y`, the key a tile is stored and fetched under. */
export function tileKey(tile: TileAddress): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

/** Fills a `{z}/{x}/{y}` URL template. */
export function fillTileTemplate(template: string, tile: TileAddress): string {
  return template
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y));
}

/** The four children of a tile, in the quadtree order the node ids encode. */
export function getChildTiles(tile: TileAddress): TileAddress[] {
  const x = tile.x * 2;
  const y = tile.y * 2;
  return [
    {z: tile.z + 1, x, y},
    {z: tile.z + 1, x: x + 1, y},
    {z: tile.z + 1, x, y: y + 1},
    {z: tile.z + 1, x: x + 1, y: y + 1}
  ];
}

/** Terrarium packs elevation as `(r * 256 + g + b / 256) - 32768` metres. */
export function decodeTerrarium(red: number, green: number, blue: number): number {
  return red * 256 + green + blue / 256 - 32768;
}
