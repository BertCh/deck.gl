// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * Bakes public elevation and orthophotography into a Gaussian splat archive.
 *
 * ```bash
 * npm run bake-terrain
 * npm run bake-terrain -- --zoom 13 --depth 5 --id lauterbrunnen-fine
 * ```
 *
 * ## The claim
 *
 * A Gaussian splat scene does not have to come from a camera rig and an optimiser. What a splat
 * renderer needs is a position, an orientation, three extents, a colour and an opacity — and a
 * digital elevation model plus an orthophoto already carry every one of those, per pixel, for the
 * whole planet. Nothing here is trained, reconstructed or inferred: each splat is one elevation
 * sample and one imagery sample, turned into an oriented disc that lies in the surface.
 *
 * The same archive format, worker, level-of-detail traversal and layer that carry a GraphDECO
 * reconstruction carry this without knowing the difference. That is the point of the exercise:
 * the renderer's input is a schema, not a file format.
 *
 * ## Why this tree is `replace` and the reconstruction's is `add`
 *
 * A trained reconstruction has *one* set of Gaussians, so the only honest way to make it
 * progressive is to split that set up and have children extend their parent — `refinement: 'add'`.
 * Terrain is not a fixed set of primitives. It is a raster, and a raster has a different
 * resolution at every zoom, so each level here *resamples the same ground* more finely and a node
 * and its children describe the same surface twice. Only one of them may be drawn, which is
 * `refinement: 'replace'`, and it is why this baker is a separate script rather than a flag on
 * the other one.
 *
 * ## Where each splat comes from
 *
 * A node covers exactly one slippy tile and holds a 128 x 128 grid. Its elevation comes from the
 * tile two zooms above (512 px, divided 4 x 4) and its colour from the tile one zoom above
 * (256 px, divided 2 x 2), so every splat is **one elevation pixel and one imagery pixel** — no
 * resampling, and siblings share a fetch. See `terrain-grid.ts`.
 *
 * Each splat's orientation is taken from the elevation gradient, so the disc lies in the surface
 * rather than facing the sky, and its in-plane extents are stretched along the slope by
 * `1 / cos(slope)` — a cell that is one sample wide in plan is longer than that on a hillside,
 * and discs sized for the plan view tear open on steep ground. The Jungfrau's north face is the
 * test case: it is close to vertical, and an uncorrected bake shows the sky through it.
 */

import {mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

import sharp from 'sharp';

import {
  encodeCoreChunk,
  getCoreChunkPath,
  SPLAT_ARCHIVE_FORMAT,
  SPLAT_ARCHIVE_VERSION,
  type SplatArchiveManifest,
  type SplatArchiveNode
} from '../splat-archive.ts';
import {sortIndicesByMortonCode} from '../splat-preprocess.ts';
import {ELEVATION_DECODER, SITE, SURFACE_IMAGE, TERRAIN_IMAGE} from '../scenes.ts';
import {
  getChildTiles,
  getElevationBlock,
  getImageryBlock,
  getSplatSpacing,
  latitudeToTileY,
  longitudeToTileX,
  NODE_GRID_SIZE,
  type TileAddress
} from './terrain-grid.ts';
import {
  buildTerrainSurfels,
  MAXIMUM_SLOPE_STRETCH,
  TERRAIN_SURFEL_DEFAULTS,
  type TerrainSurfelColumns
} from '../terrain-surfels.ts';

const exampleDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Root zoom, and how many levels of refinement sit below it.
 *
 * Zoom 13 is one tile of about 3.4 km at this latitude, and four levels take the finest splats to
 * a spacing of roughly 3.3 m — one swissALTI3D-derived elevation sample every three metres over
 * the whole Lauterbrunnen valley. Each extra level quadruples both the node count and the bytes,
 * so this is the dial to turn when trading coverage against sharpness.
 */
const DEFAULT_ROOT_ZOOM = 14;
const DEFAULT_DEPTH = 3;

/**
 * Root tiles along each edge of the baked area.
 *
 * A single root would be the obvious choice and it is the wrong one: a slippy tile is fixed to a
 * grid, so the point you asked to cover lands wherever it happens to land inside it. At the
 * example's own site that is near a corner, which puts three quarters of the coverage behind the
 * camera. A 2 x 2 block chosen around the centre keeps the area where it was asked for, and the
 * manifest already supports several roots -- anything with no parent is one.
 */
const DEFAULT_ROOT_TILES = 2;

/** Splats whose slope correction hit the ceiling, reported so the clamp is never silent. */
let clampedSlopeCount = 0;

type RasterTile = {width: number; height: number; channels: number; data: Buffer};

type BuiltNode = {
  id: string;
  parentId?: string;
  tile: TileAddress;
  childIds: string[];
  splatCount: number;
  center: [number, number, number];
  radius: number;
  geometricError: number;
};

function formatBytes(byteLength: number): string {
  return byteLength >= 1024 ** 3
    ? `${(byteLength / 1024 ** 3).toFixed(2)} GB`
    : `${(byteLength / 1024 ** 2).toFixed(1)} MB`;
}

function formatCount(count: number): string {
  return count.toLocaleString('en-US');
}

/* ----------------------------------------------------------------- rasters */

/**
 * Fetches and decodes one raster tile, memoized on disk and in memory.
 *
 * Both caches earn their place. A node's four children share its elevation tile's neighbours, so
 * the in-memory map turns roughly sixteen decodes into one; and a bake is iterative — zooms and
 * depths get retried — so the on-disk copy means the second run touches the network not at all.
 * A 404 is cached as a miss for the same reason: over a border or above a service's maximum zoom,
 * every sibling would otherwise re-ask.
 */
class RasterCache {
  private readonly memory = new Map<string, RasterTile | null>();
  private fetchCount = 0;
  private missCount = 0;
  private readonly directory: string | undefined;

  // Written out rather than as a constructor parameter property: those are not erasable
  // TypeScript, and this script runs under `node --experimental-strip-types`.
  constructor(directory: string | undefined) {
    this.directory = directory;
  }

  get stats(): {fetched: number; missing: number} {
    return {fetched: this.fetchCount, missing: this.missCount};
  }

  async get(urlTemplate: string, tile: TileAddress): Promise<RasterTile | null> {
    const url = urlTemplate
      .replace('{z}', String(tile.z))
      .replace('{x}', String(tile.x))
      .replace('{y}', String(tile.y));

    const cached = this.memory.get(url);
    if (cached !== undefined) {
      return cached;
    }

    const decoded = await this.load(url);
    this.memory.set(url, decoded);
    return decoded;
  }

  private async load(url: string): Promise<RasterTile | null> {
    const cachePath = this.directory
      ? join(this.directory, encodeURIComponent(url))
      : undefined;

    let body: Buffer | undefined;
    if (cachePath) {
      try {
        await stat(cachePath);
        body = await readFile(cachePath);
        // A zero-byte cache entry records a tile the service does not have.
        if (body.byteLength === 0) {
          this.missCount++;
          return null;
        }
      } catch {
        // Not cached yet.
      }
    }

    if (!body) {
      const response = await fetch(url);
      this.fetchCount++;
      if (!response.ok) {
        this.missCount++;
        if (cachePath) {
          await mkdir(this.directory!, {recursive: true});
          await writeFile(cachePath, new Uint8Array(0));
        }
        return null;
      }
      body = Buffer.from(await response.arrayBuffer());
      if (cachePath) {
        await mkdir(this.directory!, {recursive: true});
        await writeFile(cachePath, body);
      }
    }

    const {data, info} = await sharp(body).raw().toBuffer({resolveWithObject: true});
    return {width: info.width, height: info.height, channels: info.channels, data};
  }
}

/* ------------------------------------------------------------ node baking */

/**
 * One node's splat columns, or `null` when its elevation tile does not exist.
 *
 * The maths is not here. `buildTerrainSurfels` is the only implementation of it, and
 * `terrain-tile.worker.ts` calls the same function in the browser to build the live scenes - so
 * `Lauterbrunnen terrain` and `Lauterbrunnen, live` cannot drift apart by editing one of them.
 * All this does is fetch the two rasters the node is cut from.
 */
async function buildNodeColumns(
  tile: TileAddress,
  rasters: RasterCache,
  options: {
    sigma: number;
    thickness: number;
    lift: number;
    relief: number;
    origin: {longitude: number; latitude: number};
  }
): Promise<TerrainSurfelColumns | null> {
  const elevationBlock = getElevationBlock(tile);
  const elevation = await rasters.get(TERRAIN_IMAGE, elevationBlock.tile);
  if (!elevation) {
    return null;
  }
  const imagery = await rasters.get(SURFACE_IMAGE, getImageryBlock(tile).tile);

  return buildTerrainSurfels(tile, elevation, imagery, {
    origin: options.origin,
    sigma: options.sigma,
    thickness: options.thickness,
    relief: options.relief,
    lift: options.lift,
    sun: TERRAIN_SURFEL_DEFAULTS.sun,
    missingImageryRgb: TERRAIN_SURFEL_DEFAULTS.missingImageryRgb,
    // The archive stores `float16`, because a *trained* DC term genuinely can exceed 1 and the
    // format has to carry both kinds of scene. The live worker emits `unorm8` instead; see the
    // note on `colorFormat`.
    colorFormat: 'float32'
  });
}

/* -------------------------------------------------------------------- main */

async function main(): Promise<void> {
  const {values} = parseArgs({
    options: {
      id: {type: 'string', default: 'lauterbrunnen-terrain'},
      center: {type: 'string'},
      zoom: {type: 'string'},
      depth: {type: 'string'},
      roots: {type: 'string'},
      sigma: {type: 'string'},
      thickness: {type: 'string'},
      lift: {type: 'string'},
      relief: {type: 'string'},
      out: {type: 'string'},
      'no-cache': {type: 'boolean', default: false},
      help: {type: 'boolean', default: false}
    }
  });

  if (values.help) {
    process.stdout.write(
      [
        'Bake public elevation and orthophotography into a Gaussian splat archive.',
        '',
        '  --id <name>       Archive directory name (default: lauterbrunnen-terrain)',
        '  --center <lon,lat> Centre of the baked area (default: the example site)',
        `  --zoom <z>        Root zoom (default: ${DEFAULT_ROOT_ZOOM})`,
        `  --roots <n>       Root tiles per edge, centred on --center (default: ${DEFAULT_ROOT_TILES})`,
        `  --depth <n>       Levels of refinement below the roots (default: ${DEFAULT_DEPTH})`,
        `  --sigma <f>       Splat extent as a fraction of sample spacing (default: ${TERRAIN_SURFEL_DEFAULTS.sigma})`,
        `  --thickness <f>   Extent across the normal, as a fraction of the in-plane one (default: ${TERRAIN_SURFEL_DEFAULTS.thickness})`,
        `  --lift <m>        Metres lifted along the surface normal (default: ${TERRAIN_SURFEL_DEFAULTS.lift})`,
        `  --relief <f>      Share of the shading that is relief, 0..1 (default: ${TERRAIN_SURFEL_DEFAULTS.relief})`,
        '  --out <dir>       Output root (default: public/splat-archives)',
        '  --no-cache        Do not keep fetched raster tiles in .splat-cache/',
        ''
      ].join('\n')
    );
    return;
  }

  const [centerLongitude, centerLatitude] = values.center
    ? values.center.split(',').map(Number)
    : [SITE.longitude, SITE.latitude];
  const rootZoom = Number(values.zoom ?? DEFAULT_ROOT_ZOOM);
  const rootTilesPerEdge = Number(values.roots ?? DEFAULT_ROOT_TILES);
  const depth = Number(values.depth ?? DEFAULT_DEPTH);
  const sigma = Number(values.sigma ?? TERRAIN_SURFEL_DEFAULTS.sigma);
  const thickness = Number(values.thickness ?? TERRAIN_SURFEL_DEFAULTS.thickness);
  const lift = Number(values.lift ?? TERRAIN_SURFEL_DEFAULTS.lift);
  const relief = Number(values.relief ?? TERRAIN_SURFEL_DEFAULTS.relief);
  const archiveId = values.id!;
  const outputRoot = resolve(values.out ?? join(exampleDirectory, 'public', 'splat-archives'));
  const archiveDirectory = join(outputRoot, archiveId);
  const rasters = new RasterCache(
    values['no-cache'] ? undefined : join(exampleDirectory, '.splat-cache', 'tiles')
  );

  // Rounded rather than floored, so the block straddles the requested centre instead of starting
  // at the tile that contains it.
  const centerTileX = longitudeToTileX(centerLongitude, rootZoom);
  const centerTileY = latitudeToTileY(centerLatitude, rootZoom);
  const firstRootX = Math.round(centerTileX - rootTilesPerEdge / 2);
  const firstRootY = Math.round(centerTileY - rootTilesPerEdge / 2);

  const rootTiles: TileAddress[] = [];
  for (let row = 0; row < rootTilesPerEdge; row++) {
    for (let column = 0; column < rootTilesPerEdge; column++) {
      rootTiles.push({z: rootZoom, x: firstRootX + column, y: firstRootY + row});
    }
  }

  const coverage =
    getSplatSpacing(rootZoom, centerLatitude) * NODE_GRID_SIZE * rootTilesPerEdge;
  const finestSpacing = getSplatSpacing(rootZoom + depth - 1, centerLatitude);
  process.stdout.write(
    `\nBaking "${archiveId}" from Mapterhorn elevation and SWISSIMAGE orthophotography\n` +
      `  area    ${rootTilesPerEdge}x${rootTilesPerEdge} tiles at zoom ${rootZoom}, ` +
      `${(coverage / 1000).toFixed(2)} km across, centred on ${centerLongitude}, ${centerLatitude}\n` +
      `  levels  ${rootZoom}..${rootZoom + depth - 1}, ` +
      `${formatCount(NODE_GRID_SIZE ** 2)} splats per node\n` +
      `  spacing ${getSplatSpacing(rootZoom, centerLatitude).toFixed(1)} m at the root, ` +
      `${finestSpacing.toFixed(2)} m at the leaves\n\n`
  );

  await rm(archiveDirectory, {recursive: true, force: true});
  await mkdir(join(archiveDirectory, 'nodes'), {recursive: true});

  const startedAt = Date.now();
  const builtNodes: BuiltNode[] = [];
  const manifestNodes: SplatArchiveNode[] = [];
  let totalByteLength = 0;
  let rowIndexBase = 0;
  const sceneMin: [number, number, number] = [Infinity, Infinity, Infinity];
  const sceneMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  /** Bakes one node and, if it has any levels left, its four children. */
  const bakeNode = async (
    tile: TileAddress,
    id: string,
    parentId: string | undefined,
    level: number
  ): Promise<BuiltNode | null> => {
    const columns = await buildNodeColumns(tile, rasters, {
      sigma,
      thickness,
      lift,
      relief,
      origin: {longitude: centerLongitude, latitude: centerLatitude}
    });
    if (!columns) {
      return null;
    }
    clampedSlopeCount += columns.clampedSlopeCount;

    const splatCount = columns.opacities.length;
    // Morton order within the node, exactly as the reconstruction baker does, so the per-frame
    // depth-sorted gather reads these columns nearly sequentially.
    const order = sortIndicesByMortonCode(
      columns.positions,
      Uint32Array.from({length: splatCount}, (_, index) => index)
    ) as Uint32Array;

    const positions = new Float32Array(splatCount * 3);
    const scales = new Float32Array(splatCount * 3);
    const rotations = new Float32Array(splatCount * 4);
    const colors = new Float32Array(splatCount * 4);
    const opacities = new Float32Array(splatCount);
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

    for (let target = 0; target < splatCount; target++) {
      const source = order[target];
      for (let axis = 0; axis < 3; axis++) {
        const value = columns.positions[source * 3 + axis];
        positions[target * 3 + axis] = value;
        scales[target * 3 + axis] = columns.scales[source * 3 + axis];
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
      for (let component = 0; component < 4; component++) {
        rotations[target * 4 + component] = columns.rotations[source * 4 + component];
        colors[target * 4 + component] = columns.colors[source * 4 + component];
      }
      opacities[target] = columns.opacities[source];
    }

    for (let axis = 0; axis < 3; axis++) {
      sceneMin[axis] = Math.min(sceneMin[axis], min[axis]);
      sceneMax[axis] = Math.max(sceneMax[axis], max[axis]);
    }

    const encoded = encodeCoreChunk({
      rowCount: splatCount,
      positions,
      scales,
      rotations,
      colors,
      opacities
    });
    await writeFile(join(archiveDirectory, getCoreChunkPath(id)), new Uint8Array(encoded));
    totalByteLength += encoded.byteLength;

    const childIds: string[] = [];
    const node: BuiltNode = {
      id,
      ...(parentId ? {parentId} : {}),
      tile,
      childIds,
      splatCount,
      center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
      // The children resample the same ground, so a sphere around this node's own samples already
      // encloses the subtree — unlike the reconstruction baker, where children are elsewhere.
      radius: Math.max(
        Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2,
        1e-6
      ),
      // The sample spacing at this level, which is literally how coarse this node is.
      geometricError: columns.spacing
    };
    builtNodes.push(node);

    manifestNodes.push({
      id,
      ...(parentId ? {parentId} : {}),
      childIds,
      splatCount,
      subtreeSplatCount: splatCount,
      center: node.center,
      radius: node.radius,
      geometricError: node.geometricError,
      rowIndexBase,
      coreByteLength: encoded.byteLength,
      bandByteLengths: []
    });
    rowIndexBase += splatCount;

    if (level + 1 < depth) {
      const children = getChildTiles(tile);
      for (let quadrant = 0; quadrant < children.length; quadrant++) {
        const child = await bakeNode(children[quadrant], `${id}${quadrant}`, id, level + 1);
        if (child) {
          childIds.push(child.id);
        }
      }
    }

    const progress =
      `  baked   ${manifestNodes.length} nodes, ${formatCount(rowIndexBase)} splats, ` +
      `${formatBytes(totalByteLength)}`;
    if (process.stdout.isTTY) {
      process.stdout.write(`\r${progress}   `);
    } else if (manifestNodes.length % 25 === 0) {
      process.stdout.write(`${progress}\n`);
    }
    return node;
  };

  let bakedRootCount = 0;
  for (let index = 0; index < rootTiles.length; index++) {
    const root = await bakeNode(rootTiles[index], `r${index}`, undefined, 0);
    if (root) {
      bakedRootCount++;
    }
  }
  process.stdout.write('\n');
  if (bakedRootCount === 0) {
    throw new Error(
      `No elevation tile covers ${centerLongitude}, ${centerLatitude} at zoom ${rootZoom - 2}`
    );
  }

  // Nodes are pushed in depth-first pre-order, so every child precedes its parent when that list
  // is walked backwards -- which is all a bottom-up roll-up needs.
  const nodesById = new Map(manifestNodes.map(node => [node.id, node]));
  for (let index = manifestNodes.length - 1; index >= 0; index--) {
    const node = manifestNodes[index];
    node.subtreeSplatCount =
      node.splatCount +
      node.childIds.reduce((total, childId) => total + nodesById.get(childId)!.subtreeSplatCount, 0);
  }

  const manifest: SplatArchiveManifest = {
    format: SPLAT_ARCHIVE_FORMAT,
    version: SPLAT_ARCHIVE_VERSION,
    // Each level resamples the same ground, so a node and its children may not both be drawn.
    refinement: 'replace',
    scene: {
      id: archiveId,
      sourceSplatCount: rowIndexBase,
      splatCount: rowIndexBase,
      prunedSplatCount: 0,
      maxSphericalHarmonicsDegree: 0,
      bounds: {min: sceneMin, max: sceneMax},
      // Already georeferenced, so these are the true extent rather than a robust estimate of it:
      // terrain has no floaters to guard against.
      percentiles: {
        x: [sceneMin[0], sceneMax[0]],
        y: [sceneMin[1], sceneMax[1]],
        z: [sceneMin[2], sceneMax[2]]
      },
      // Anchored at 0 m, because scene z is the elevation itself.
      georeference: {longitude: centerLongitude, latitude: centerLatitude, altitude: 0},
      sourceUrls: [TERRAIN_IMAGE, SURFACE_IMAGE]
    },
    encoding: {
      positions: 'uint16x3-box',
      scales: 'uint16x3-log',
      rotations: 'uint32-smallest-three',
      colors: 'float16',
      opacities: 'uint8',
      sphericalHarmonics: 'int8-scaled'
    },
    nodes: manifestNodes
  };
  await writeFile(
    join(archiveDirectory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  const {fetched, missing} = rasters.stats;
  process.stdout.write(
    [
      '',
      `  nodes    ${manifestNodes.length} over ${depth} levels, from ${bakedRootCount} roots`,
      `  splats   ${formatCount(rowIndexBase)}`,
      `  archive  ${formatBytes(totalByteLength)}  (${(totalByteLength / rowIndexBase).toFixed(1)} bytes/splat)`,
      `  roots    ${formatBytes(
        manifestNodes
          .filter(node => !node.parentId)
          .reduce((total, node) => total + node.coreByteLength, 0)
      )} — what the first complete frame costs`,
      `  rasters  ${fetched} fetched${missing > 0 ? `, ${missing} not available` : ''}`,
      `  slopes   ${formatCount(clampedSlopeCount)} splats (${(
        (clampedSlopeCount / rowIndexBase) *
        100
      ).toFixed(1)}%) steeper than the ${MAXIMUM_SLOPE_STRETCH}x stretch ceiling; the mesh shows through there`,
      `  elevation decoder: r*${ELEVATION_DECODER.rScaler} + g + b/${1 / ELEVATION_DECODER.bScaler} ${ELEVATION_DECODER.offset}`,
      `  written to ${archiveDirectory}`,
      `  took ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
      ''
    ].join('\n')
  );
}

main().catch(error => {
  process.stderr.write(`\n${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
