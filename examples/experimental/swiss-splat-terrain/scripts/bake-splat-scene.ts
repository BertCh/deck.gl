// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * Bakes a Gaussian splat PLY into the streaming archive `splat-archive.ts` describes.
 *
 * ```bash
 * npm run bake -- --scene truck
 * npm run bake -- --input ~/captures/room.ply --id room --degree 2
 * ```
 *
 * ## What this moves off the critical path
 *
 * Everything a splat renderer does per frame depends on the camera and cannot be cached.
 * Everything *else* -- the decode, the pruning, the ranking, the spatial ordering, the choice of
 * which splats matter -- depends only on the scene, and paying for it in a browser means paying
 * for it once per visitor instead of once per scene. This script pays it once:
 *
 * 1. **Decode.** The GraphDECO vertex layout, `exp` scales, `sigmoid` opacity, the DC harmonic
 *    folded into a base color, the per-channel-to-per-basis transpose. 248 bytes a row read,
 *    23 written.
 * 2. **Prune.** Rows whose opacity cannot clear the renderer's alpha cutoff are tested and
 *    rejected on every frame that ever draws them. They are dropped here instead, which changes
 *    nothing on screen.
 * 3. **Rank.** Splats are ordered by the screen area they are likely to cover, so that a partial
 *    download is the *important* part of the scene rather than an arbitrary slice of it.
 * 4. **Subdivide.** An additive level-of-detail octree, so a client fetches detail where the
 *    camera is looking and nothing where it is not.
 * 5. **Order.** Morton order within each node, so the depth-sorted gather the WebGL2 path runs
 *    every frame streams through cache instead of missing on nearly every row.
 * 6. **Quantize.** 23 bytes a row instead of 248.
 *
 * ## The tree, and why the parent keeps its splats
 *
 * Each node holds the most important splats in its region that no shallower node already holds,
 * and its children divide what is left among eight octants. Every splat appears exactly once in
 * the whole tree, so a node's children *add* detail rather than replacing it -- which is what
 * `refinement: 'add'` means to luma.gl's `SplatHierarchyManager`, and why the root alone is a
 * complete, coarse view of the entire scene rather than an empty shell.
 *
 * That property is what makes the tree honest. No Gaussian here is synthetic: nothing is merged,
 * averaged or refitted, so a fully refined subtree is bit-for-bit the reconstruction that was
 * trained, and a partly refined one is a strict subset of it. Hierarchies that fit new parent
 * Gaussians to stand in for their children can be sharper at a given budget; they also cannot
 * say that.
 */

import {mkdir, rm, writeFile} from 'node:fs/promises';
import {createReadStream, createWriteStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

import {decodeGaussianPlyStream, type SphericalHarmonicsDegree} from '../gaussian-ply.ts';
import {getSplatImportance, sortIndicesByMortonCode} from '../splat-preprocess.ts';
import {
  encodeBandChunk,
  encodeCoreChunk,
  getBandBasisCount,
  getBandChunkPath,
  getCoreChunkPath,
  getCumulativeBasisCount,
  SPLAT_ARCHIVE_FORMAT,
  SPLAT_ARCHIVE_VERSION,
  type SplatArchiveDegree,
  type SplatArchiveManifest,
  type SplatArchiveNode
} from '../splat-archive.ts';
import {SPLAT_SCENES} from '../scenes.ts';

const exampleDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** luma.gl's default minimum fragment opacity, which is also `SplatLayer`'s default. */
const DEFAULT_ALPHA_CUTOFF = 0.5 / 255;

/**
 * Rows a node keeps for itself before handing the rest to its children.
 *
 * The trade is between culling and dispatch: smaller nodes cull and stream at a finer grain, but
 * every resident node is one more source batch, one more compute dispatch in the projection pass
 * and one more slot in the renderer's reserved binding table. 65536 puts a 1.7M-splat scene at
 * about seventy nodes over three levels, which culls usefully and dispatches cheaply.
 */
const DEFAULT_NODE_CAPACITY = 65536;

/** Refuses to subdivide past this, whatever the distribution does. */
const MAXIMUM_TREE_DEPTH = 10;

/**
 * How far past the robust extent a splat may sit before it is treated as an outlier.
 *
 * Outliers are the single most destructive thing a reconstruction can hand a level-of-detail
 * tree, and not for the reason you would guess. The traversal measures a node's distance as
 * `distance(camera, center) - radius`, so a node whose bounding sphere is inflated by one stray
 * splat two hundred units away reads as *touching the camera* from anywhere in the scene, its
 * screen-space error comes out effectively infinite, and it refines unconditionally. One floater
 * per branch is enough to turn the whole tree into "always load everything".
 *
 * The fix is not to drop them -- they are real rows of the reconstruction and throwing them away
 * would be a silent edit. They are given to the ROOT instead. The root is resident from the first
 * frame, is never culled in practice, and under `refinement: 'add'` is always in the frontier, so
 * a splat parked there is always drawn. What it is not is part of any *child's* bounds, which is
 * what keeps every sphere below the root tight enough to measure against.
 */
const OUTLIER_BOX_SCALE = 4;

/** Splats sampled when estimating the robust scene extent written into the manifest. */
const PERCENTILE_SAMPLE_LIMIT = 200_000;

type DecodedScene = {
  positions: Float32Array;
  scales: Float32Array;
  rotations: Float32Array;
  colors: Float32Array;
  opacities: Float32Array;
  sphericalHarmonics?: Float32Array;
  degree: SplatArchiveDegree;
  splatCount: number;
  sourceUrls: string[];
};

/** A node of the tree while it is being built, before it is flattened into the manifest. */
type BuildNode = {
  id: string;
  parentId?: string;
  /** Source row indices this node stores, already in Morton order. */
  rows: Uint32Array;
  children: BuildNode[];
  geometricError: number;
  center: [number, number, number];
  radius: number;
};

function formatBytes(byteLength: number): string {
  if (byteLength >= 1024 ** 3) {
    return `${(byteLength / 1024 ** 3).toFixed(2)} GB`;
  }
  return `${(byteLength / 1024 ** 2).toFixed(1)} MB`;
}

function formatCount(count: number): string {
  return count.toLocaleString('en-US');
}

/* ------------------------------------------------------------------ sources */

/**
 * Opens a PLY as a byte stream, downloading it to the cache directory first when it is remote.
 *
 * Baking is iterative -- degrees and node capacities get retried -- and re-downloading several
 * hundred megabytes per attempt is the slowest part of the loop by a wide margin. The cached copy
 * is keyed by URL and reused until it is deleted.
 */
async function openPlyStream(
  location: string,
  cacheDirectory: string | undefined
): Promise<{stream: ReadableStream<Uint8Array>; totalBytes?: number; cachedPath?: string}> {
  if (!/^https?:\/\//.test(location)) {
    const path = resolve(location);
    const {size} = await stat(path);
    return {stream: Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>, totalBytes: size};
  }

  if (!cacheDirectory) {
    const response = await fetch(location);
    if (!response.ok || !response.body) {
      throw new Error(`Failed to fetch ${location}: HTTP ${response.status}`);
    }
    return {
      stream: response.body,
      totalBytes: Number(response.headers.get('content-length')) || undefined
    };
  }

  const cachedPath = join(cacheDirectory, encodeURIComponent(location));
  try {
    const {size} = await stat(cachedPath);
    process.stdout.write(`  cached  ${formatBytes(size)}  ${cachedPath}\n`);
    return {
      stream: Readable.toWeb(createReadStream(cachedPath)) as ReadableStream<Uint8Array>,
      totalBytes: size,
      cachedPath
    };
  } catch {
    // Not cached yet.
  }

  process.stdout.write(`  fetching ${location}\n`);
  const response = await fetch(location);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch ${location}: HTTP ${response.status}`);
  }
  await mkdir(cacheDirectory, {recursive: true});
  const partialPath = `${cachedPath}.partial`;
  // Written through a temporary name so an interrupted download is never mistaken for a
  // complete cache entry on the next run.
  await pipeline(Readable.fromWeb(response.body as any), createWriteStream(partialPath));
  const {rename} = await import('node:fs/promises');
  await rename(partialPath, cachedPath);
  const {size} = await stat(cachedPath);
  return {
    stream: Readable.toWeb(createReadStream(cachedPath)) as ReadableStream<Uint8Array>,
    totalBytes: size,
    cachedPath
  };
}

/** Decodes every PLY of a scene and concatenates them into one set of columns. */
async function decodeScene(
  sourceUrls: string[],
  degree: SplatArchiveDegree,
  cacheDirectory: string | undefined
): Promise<DecodedScene> {
  const parts: {
    positions: Float32Array;
    scales: Float32Array;
    rotations: Float32Array;
    colors: Float32Array;
    opacities: Float32Array;
    sphericalHarmonics?: Float32Array;
    degree: SphericalHarmonicsDegree;
  }[] = [];

  for (const url of sourceUrls) {
    const {stream, totalBytes} = await openPlyStream(url, cacheDirectory);
    let lastReport = 0;
    const {source, sphericalHarmonicsDegree} = await decodeGaussianPlyStream(stream, {
      sphericalHarmonicsDegree: degree,
      totalBytes,
      onProgress: (loadedBytes, total, splatCount) => {
        const now = Date.now();
        if (now - lastReport < 500) {
          return;
        }
        lastReport = now;
        const share = total ? ` (${((loadedBytes / total) * 100).toFixed(0)}%)` : '';
        process.stdout.write(
          `\r  decoding ${formatBytes(loadedBytes)}${share}  ${formatCount(splatCount)} splats   `
        );
      }
    });
    process.stdout.write('\r');
    parts.push({
      positions: source.positions,
      scales: source.scales,
      rotations: source.rotations,
      colors: source.colors as Float32Array,
      opacities: source.opacities,
      sphericalHarmonics: source.sphericalHarmonics,
      degree: sphericalHarmonicsDegree
    });
    process.stdout.write(
      `  decoded ${formatCount(source.opacities.length)} splats from ${url.split('/').pop()}\n`
    );
  }

  // A scene's files can in principle report different available degrees; the archive carries the
  // lowest, because a partly populated coefficient column has no meaning.
  const resolvedDegree = parts.reduce<number>(
    (lowest, part) => Math.min(lowest, part.degree),
    degree
  ) as SplatArchiveDegree;
  const basisCount = getCumulativeBasisCount(resolvedDegree);
  const splatCount = parts.reduce((total, part) => total + part.opacities.length, 0);

  if (parts.length === 1 && parts[0].degree === resolvedDegree) {
    const part = parts[0];
    return {...part, degree: resolvedDegree, splatCount, sourceUrls};
  }

  const positions = new Float32Array(splatCount * 3);
  const scales = new Float32Array(splatCount * 3);
  const rotations = new Float32Array(splatCount * 4);
  const colors = new Float32Array(splatCount * 4);
  const opacities = new Float32Array(splatCount);
  const sphericalHarmonics =
    basisCount > 0 ? new Float32Array(splatCount * basisCount * 3) : undefined;

  let rowOffset = 0;
  for (const part of parts) {
    const rows = part.opacities.length;
    positions.set(part.positions.subarray(0, rows * 3), rowOffset * 3);
    scales.set(part.scales.subarray(0, rows * 3), rowOffset * 3);
    rotations.set(part.rotations.subarray(0, rows * 4), rowOffset * 4);
    colors.set(part.colors.subarray(0, rows * 4), rowOffset * 4);
    opacities.set(part.opacities.subarray(0, rows), rowOffset);
    if (sphericalHarmonics && part.sphericalHarmonics) {
      const valuesPerRow = getCumulativeBasisCount(part.degree as SplatArchiveDegree) * 3;
      const keptPerRow = basisCount * 3;
      for (let row = 0; row < rows; row++) {
        sphericalHarmonics.set(
          part.sphericalHarmonics.subarray(row * valuesPerRow, row * valuesPerRow + keptPerRow),
          (rowOffset + row) * keptPerRow
        );
      }
    }
    rowOffset += rows;
  }

  return {
    positions,
    scales,
    rotations,
    colors,
    opacities,
    sphericalHarmonics,
    degree: resolvedDegree,
    splatCount,
    sourceUrls
  };
}

/* --------------------------------------------------------------- tree build */

/**
 * Rows worth publishing, ordered by importance, most important first.
 *
 * The order is established once here and then survives every subsequent step: taking a node's
 * share is a prefix, and partitioning the remainder into octants preserves the relative order
 * inside each. So one sort covers the whole tree rather than one per node.
 */
function selectAndRankRows(
  scene: DecodedScene,
  minimumOpacity: number
): {rows: Uint32Array; prunedCount: number} {
  const {opacities, scales, colors, splatCount} = scene;
  const kept = new Uint32Array(splatCount);
  const scores = new Float32Array(splatCount);
  let keptCount = 0;

  for (let index = 0; index < splatCount; index++) {
    // The renderer multiplies stored opacity by the color's alpha before testing the cutoff.
    if (opacities[index] * colors[index * 4 + 3] < minimumOpacity) {
      continue;
    }
    kept[keptCount++] = index;
    scores[index] = getSplatImportance(opacities, scales, index);
  }

  const rows = kept.subarray(0, keptCount);
  rows.sort((first, second) => scores[second] - scores[first]);
  return {rows: rows.slice(), prunedCount: splatCount - keptCount};
}

/** Splits rows into the eight octants of a cell, preserving their relative order. */
function partitionIntoOctants(
  positions: Float32Array,
  rows: Uint32Array,
  center: [number, number, number]
): Uint32Array[] {
  const counts = new Uint32Array(8);
  const octants = new Uint8Array(rows.length);
  for (let index = 0; index < rows.length; index++) {
    const offset = rows[index] * 3;
    const octant =
      (positions[offset] >= center[0] ? 1 : 0) |
      (positions[offset + 1] >= center[1] ? 2 : 0) |
      (positions[offset + 2] >= center[2] ? 4 : 0);
    octants[index] = octant;
    counts[octant]++;
  }

  const partitions = Array.from(counts, count => new Uint32Array(count));
  const written = new Uint32Array(8);
  for (let index = 0; index < rows.length; index++) {
    const octant = octants[index];
    partitions[octant][written[octant]++] = rows[index];
  }
  return partitions;
}

/**
 * Splits rows into those inside a box and those outside it.
 *
 * The outside set becomes the root's extra payload; see `OUTLIER_BOX_SCALE` for why that is a
 * structural decision about the tree rather than a data-cleaning one.
 */
function partitionByBox(
  positions: Float32Array,
  rows: Uint32Array,
  min: [number, number, number],
  max: [number, number, number]
): {inside: Uint32Array; outside: Uint32Array} {
  const inside = new Uint32Array(rows.length);
  const outside = new Uint32Array(rows.length);
  let insideCount = 0;
  let outsideCount = 0;

  for (const row of rows) {
    const offset = row * 3;
    const isInside =
      positions[offset] >= min[0] &&
      positions[offset] <= max[0] &&
      positions[offset + 1] >= min[1] &&
      positions[offset + 1] <= max[1] &&
      positions[offset + 2] >= min[2] &&
      positions[offset + 2] <= max[2];
    if (isInside) {
      inside[insideCount++] = row;
    } else {
      outside[outsideCount++] = row;
    }
  }

  return {inside: inside.slice(0, insideCount), outside: outside.slice(0, outsideCount)};
}

/** The percentile extent widened by `OUTLIER_BOX_SCALE`, clamped to the data's real bounds. */
function computeRobustBox(
  percentiles: ReturnType<typeof computePercentiles>,
  bounds: {min: [number, number, number]; max: [number, number, number]}
): {min: [number, number, number]; max: [number, number, number]} {
  const axes = [percentiles.x, percentiles.y, percentiles.z];
  const min = [0, 0, 0] as [number, number, number];
  const max = [0, 0, 0] as [number, number, number];

  for (let axis = 0; axis < 3; axis++) {
    const [low, high] = axes[axis];
    const center = (low + high) / 2;
    const halfWidth = Math.max((high - low) / 2, Number.EPSILON) * OUTLIER_BOX_SCALE;
    min[axis] = Math.max(center - halfWidth, bounds.min[axis]);
    max[axis] = Math.min(center + halfWidth, bounds.max[axis]);
  }
  return {min, max};
}

/** Tight axis-aligned bounds of a row set. */
function computeBounds(
  positions: Float32Array,
  rows: Uint32Array
): {min: [number, number, number]; max: [number, number, number]} {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const row of rows) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[row * 3 + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  return {min, max};
}

/**
 * Builds the additive level-of-detail octree.
 *
 * Three different extents are in play here and mixing them up is the whole difficulty:
 *
 * - `cellMin`/`cellMax` is the region this node subdivides. It decides only *where the splits
 *   go*, never what anything measures, because an octree cell is a geometric construct and can
 *   be mostly empty.
 * - The **geometric error** is measured from the bounding box of the node's *own rows*. That is
 *   what makes it mean "how far apart are the splats this node contributes": a node holding
 *   16k splats spread over the whole scene is a coarse representation of it, and a node holding
 *   16k splats in one corner is a fine one, even though their cells differ by a fixed factor.
 *   Measured against the cell instead, a clustered scene reads as far coarser than it is and
 *   refines when it has nothing left to reveal.
 * - The published **bounding sphere** is fitted to the node's whole *subtree*. It has to enclose
 *   the descendants, because the traversal stops at a node it culls and never looks inside it,
 *   so a sphere fitted to this node's own rows would cull detail that is on screen.
 */
function buildTree(
  scene: DecodedScene,
  rows: Uint32Array,
  cellMin: [number, number, number],
  cellMax: [number, number, number],
  depth: number,
  id: string,
  parentId: string | undefined,
  nodeCapacity: number
): BuildNode {
  const {positions} = scene;

  const isLeaf = rows.length <= nodeCapacity || depth >= MAXIMUM_TREE_DEPTH;
  const ownRows = isLeaf ? rows : rows.subarray(0, nodeCapacity);
  const remainingRows = isLeaf ? new Uint32Array(0) : rows.subarray(nodeCapacity);

  const children: BuildNode[] = [];
  if (remainingRows.length > 0) {
    const center: [number, number, number] = [
      (cellMin[0] + cellMax[0]) / 2,
      (cellMin[1] + cellMax[1]) / 2,
      (cellMin[2] + cellMax[2]) / 2
    ];
    const partitions = partitionIntoOctants(positions, remainingRows, center);
    for (let octant = 0; octant < 8; octant++) {
      if (partitions[octant].length === 0) {
        continue;
      }
      const childMin: [number, number, number] = [
        octant & 1 ? center[0] : cellMin[0],
        octant & 2 ? center[1] : cellMin[1],
        octant & 4 ? center[2] : cellMin[2]
      ];
      const childMax: [number, number, number] = [
        octant & 1 ? cellMax[0] : center[0],
        octant & 2 ? cellMax[1] : center[1],
        octant & 4 ? cellMax[2] : center[2]
      ];
      children.push(
        buildTree(
          scene,
          partitions[octant],
          childMin,
          childMax,
          depth + 1,
          `${id}${octant}`,
          id,
          nodeCapacity
        )
      );
    }
  }

  const subtreeBounds = computeBounds(positions, rows);
  const center: [number, number, number] = [
    (subtreeBounds.min[0] + subtreeBounds.max[0]) / 2,
    (subtreeBounds.min[1] + subtreeBounds.max[1]) / 2,
    (subtreeBounds.min[2] + subtreeBounds.max[2]) / 2
  ];
  const radius =
    Math.hypot(
      subtreeBounds.max[0] - subtreeBounds.min[0],
      subtreeBounds.max[1] - subtreeBounds.min[1],
      subtreeBounds.max[2] - subtreeBounds.min[2]
    ) / 2;

  const ownBounds = computeBounds(positions, ownRows);
  const ownDiagonal = Math.hypot(
    ownBounds.max[0] - ownBounds.min[0],
    ownBounds.max[1] - ownBounds.min[1],
    ownBounds.max[2] - ownBounds.min[2]
  );

  return {
    id,
    parentId,
    // Morton order inside the node, so the per-frame depth-sorted gather reads its columns
    // nearly sequentially instead of missing cache on every row.
    rows: sortIndicesByMortonCode(positions, ownRows.slice()) as Uint32Array,
    children,
    // Spacing of this node's own splats across the volume they actually occupy: the error of
    // stopping here. A diagonal over a cube root is a conservative proxy for that spacing, which
    // is the right direction for a refinement test to err in.
    geometricError: ownDiagonal / Math.max(Math.cbrt(ownRows.length), 1),
    center,
    radius: Math.max(radius, 1e-6)
  };
}

/** Depth-first flattening, which is also the order the client is happiest streaming in. */
function flattenTree(root: BuildNode): BuildNode[] {
  const flattened: BuildNode[] = [];
  const visit = (node: BuildNode): void => {
    flattened.push(node);
    for (const child of node.children) {
      visit(child);
    }
  };
  visit(root);
  return flattened;
}

/* ----------------------------------------------------------------- writing */

/** Copies one node's rows out of the scene columns, in the node's own stored order. */
function gatherNodeColumns(scene: DecodedScene, rows: Uint32Array) {
  const rowCount = rows.length;
  const positions = new Float32Array(rowCount * 3);
  const scales = new Float32Array(rowCount * 3);
  const rotations = new Float32Array(rowCount * 4);
  const colors = new Float32Array(rowCount * 4);
  const opacities = new Float32Array(rowCount);

  for (let index = 0; index < rowCount; index++) {
    const row = rows[index];
    for (let axis = 0; axis < 3; axis++) {
      positions[index * 3 + axis] = scene.positions[row * 3 + axis];
      scales[index * 3 + axis] = scene.scales[row * 3 + axis];
    }
    for (let component = 0; component < 4; component++) {
      rotations[index * 4 + component] = scene.rotations[row * 4 + component];
      colors[index * 4 + component] = scene.colors[row * 4 + component];
    }
    opacities[index] = scene.opacities[row];
  }

  return {rowCount, positions, scales, rotations, colors, opacities};
}

/**
 * Copies one band's coefficients for one node's rows.
 *
 * The scene column is basis-major with every band concatenated, so band `band` starts at the
 * cumulative basis count of `band - 1` and runs for that band's own basis count -- which is
 * exactly the slice a client re-concatenates when it asks for that degree.
 */
function gatherNodeBand(
  scene: DecodedScene,
  rows: Uint32Array,
  band: number
): Float32Array {
  const sceneBasisCount = getCumulativeBasisCount(scene.degree);
  const bandBasisCount = getBandBasisCount(band);
  const bandBasisOffset = getCumulativeBasisCount((band - 1) as SplatArchiveDegree);
  const valuesPerRow = bandBasisCount * 3;
  const gathered = new Float32Array(rows.length * valuesPerRow);

  for (let index = 0; index < rows.length; index++) {
    const source = rows[index] * sceneBasisCount * 3 + bandBasisOffset * 3;
    gathered.set(
      scene.sphericalHarmonics!.subarray(source, source + valuesPerRow),
      index * valuesPerRow
    );
  }
  return gathered;
}

function percentile(sorted: Float64Array, fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round(fraction * (sorted.length - 1)))
  );
  return sorted[index];
}

/**
 * The 2nd and 98th percentile of each axis, sampled across the published rows.
 *
 * The layer normalizes a scene to a metre footprint, and doing that from absolute bounds lets one
 * stray floater shrink everything else to a speck. It cannot compute these at runtime either:
 * no single chunk holds the whole scene, and the whole point is that it never downloads one.
 */
function computePercentiles(scene: DecodedScene, rows: Uint32Array) {
  const stride = Math.max(1, Math.floor(rows.length / PERCENTILE_SAMPLE_LIMIT));
  const sampleCount = Math.ceil(rows.length / stride);
  const axes = [new Float64Array(sampleCount), new Float64Array(sampleCount), new Float64Array(sampleCount)];

  let sampleIndex = 0;
  for (let index = 0; index < rows.length; index += stride) {
    const offset = rows[index] * 3;
    axes[0][sampleIndex] = scene.positions[offset];
    axes[1][sampleIndex] = scene.positions[offset + 1];
    axes[2][sampleIndex] = scene.positions[offset + 2];
    sampleIndex++;
  }
  for (const axis of axes) {
    axis.sort();
  }

  return {
    x: [percentile(axes[0], 0.02), percentile(axes[0], 0.98)] as [number, number],
    y: [percentile(axes[1], 0.02), percentile(axes[1], 0.98)] as [number, number],
    z: [percentile(axes[2], 0.02), percentile(axes[2], 0.98)] as [number, number]
  };
}

/* -------------------------------------------------------------------- main */

async function main(): Promise<void> {
  const {values} = parseArgs({
    options: {
      scene: {type: 'string'},
      input: {type: 'string', multiple: true},
      id: {type: 'string'},
      out: {type: 'string'},
      degree: {type: 'string', default: '3'},
      'node-capacity': {type: 'string'},
      'min-opacity': {type: 'string'},
      'no-cache': {type: 'boolean', default: false},
      verify: {type: 'boolean', default: false},
      help: {type: 'boolean', default: false}
    }
  });

  if (values.help || (!values.scene && !values.input)) {
    process.stdout.write(
      [
        'Bake a Gaussian splat PLY into a streaming deck.gl splat archive.',
        '',
        '  --scene <id>          A scene from scenes.ts: ' +
          SPLAT_SCENES.map(scene => scene.id).join(', '),
        '  --input <path|url>    A PLY to bake instead; repeatable for multi-file scenes',
        '  --id <name>           Archive directory name when using --input',
        '  --out <dir>           Output root (default: public/splat-archives)',
        '  --degree <0..3>       Highest spherical-harmonic band to publish (default: 3)',
        '  --node-capacity <n>   Rows each level-of-detail node keeps (default: 65536)',
        '  --min-opacity <f>     Prune threshold (default: the renderer alpha cutoff, 0.5/255)',
        '  --no-cache            Do not keep downloaded PLY files in .splat-cache/',
        '  --verify              Decode the archive back and report quantization error',
        ''
      ].join('\n')
    );
    return;
  }

  const scene = values.scene
    ? SPLAT_SCENES.find(candidate => candidate.id === values.scene)
    : undefined;
  if (values.scene && !scene) {
    throw new Error(`Unknown scene "${values.scene}"`);
  }

  const sourceUrls = values.input ?? scene?.urls;
  if (!sourceUrls?.length) {
    throw new Error(
      `Scene "${values.scene}" has no source PLY. A terrain scene is built from rasters instead; ` +
        'use `npm run bake-terrain`.'
    );
  }
  const archiveId = values.id ?? scene?.id ?? 'scene';
  const degree = Number(values.degree) as SplatArchiveDegree;
  if (![0, 1, 2, 3].includes(degree)) {
    throw new Error('--degree must be 0, 1, 2 or 3');
  }
  const nodeCapacity = Number(values['node-capacity'] ?? DEFAULT_NODE_CAPACITY);
  const minimumOpacity = Number(values['min-opacity'] ?? DEFAULT_ALPHA_CUTOFF);
  const outputRoot = resolve(values.out ?? join(exampleDirectory, 'public', 'splat-archives'));
  const archiveDirectory = join(outputRoot, archiveId);
  const cacheDirectory = values['no-cache'] ? undefined : join(exampleDirectory, '.splat-cache');

  process.stdout.write(`\nBaking "${archiveId}" at spherical-harmonic degree ${degree}\n`);

  const startedAt = Date.now();
  const decoded = await decodeScene(sourceUrls, degree, cacheDirectory);

  const {rows, prunedCount} = selectAndRankRows(decoded, minimumOpacity);
  process.stdout.write(
    `  pruned  ${formatCount(prunedCount)} splats below opacity ${minimumOpacity.toFixed(5)}\n`
  );

  const sceneBounds = computeBounds(decoded.positions, rows);
  const percentiles = computePercentiles(decoded, rows);

  // Outliers are kept, but kept out of the tree's shape: see OUTLIER_BOX_SCALE.
  const robustBox = computeRobustBox(percentiles, sceneBounds);
  const {inside, outside} = partitionByBox(
    decoded.positions,
    rows,
    robustBox.min,
    robustBox.max
  );
  if (outside.length > 0) {
    process.stdout.write(
      `  outliers ${formatCount(outside.length)} splats beyond ${OUTLIER_BOX_SCALE}x the robust ` +
        `extent, attached to the root\n`
    );
  }

  // The root cell is the inliers' own tight bounds, not the widened classification box: an
  // oversized cell would push every split off-centre and leave most octants empty.
  const inlierBounds = computeBounds(decoded.positions, inside);
  const root = buildTree(
    decoded,
    inside,
    inlierBounds.min,
    inlierBounds.max,
    0,
    'r',
    undefined,
    nodeCapacity
  );

  if (outside.length > 0) {
    // Appended after the tree is built so they never reach a child's cell, then re-ordered and
    // re-bounded with the rest of the root's rows.
    const rootRows = new Uint32Array(root.rows.length + outside.length);
    rootRows.set(root.rows, 0);
    rootRows.set(outside, root.rows.length);
    root.rows = sortIndicesByMortonCode(decoded.positions, rootRows) as Uint32Array;

    // The root's sphere has to cover them too: an outlier culled with the root would vanish, and
    // the root's own error is already large enough that it refines from anywhere regardless.
    const rootBounds = computeBounds(decoded.positions, rows);
    root.center = [
      (rootBounds.min[0] + rootBounds.max[0]) / 2,
      (rootBounds.min[1] + rootBounds.max[1]) / 2,
      (rootBounds.min[2] + rootBounds.max[2]) / 2
    ];
    root.radius =
      Math.hypot(
        rootBounds.max[0] - rootBounds.min[0],
        rootBounds.max[1] - rootBounds.min[1],
        rootBounds.max[2] - rootBounds.min[2]
      ) / 2;
  }

  const buildNodes = flattenTree(root);
  const depth = buildNodes.reduce((deepest, node) => Math.max(deepest, node.id.length - 1), 0);
  process.stdout.write(
    `  tree    ${buildNodes.length} nodes, ${depth + 1} levels, ${formatCount(nodeCapacity)} rows per node\n`
  );

  await rm(archiveDirectory, {recursive: true, force: true});
  await mkdir(join(archiveDirectory, 'nodes'), {recursive: true});

  const manifestNodes: SplatArchiveNode[] = [];
  const bandTotals = new Array(degree).fill(0);
  let coreTotal = 0;
  let rowIndexBase = 0;

  for (const node of buildNodes) {
    const columns = gatherNodeColumns(decoded, node.rows);
    const core = encodeCoreChunk(columns);
    await writeFile(join(archiveDirectory, getCoreChunkPath(node.id)), new Uint8Array(core));
    coreTotal += core.byteLength;

    const bandByteLengths: number[] = [];
    for (let band = 1; band <= degree; band++) {
      const coefficients = gatherNodeBand(decoded, node.rows, band);
      const encoded = encodeBandChunk(coefficients, node.rows.length, getBandBasisCount(band));
      await writeFile(
        join(archiveDirectory, getBandChunkPath(node.id, band)),
        new Uint8Array(encoded)
      );
      bandByteLengths.push(encoded.byteLength);
      bandTotals[band - 1] += encoded.byteLength;
    }

    const subtreeSplatCount = flattenTree(node).reduce(
      (total, descendant) => total + descendant.rows.length,
      0
    );

    manifestNodes.push({
      id: node.id,
      ...(node.parentId ? {parentId: node.parentId} : {}),
      childIds: node.children.map(child => child.id),
      splatCount: node.rows.length,
      subtreeSplatCount,
      center: node.center,
      radius: node.radius,
      geometricError: node.geometricError,
      rowIndexBase,
      coreByteLength: core.byteLength,
      bandByteLengths
    });
    rowIndexBase += node.rows.length;
  }

  const manifest: SplatArchiveManifest = {
    format: SPLAT_ARCHIVE_FORMAT,
    version: SPLAT_ARCHIVE_VERSION,
    scene: {
      id: archiveId,
      sourceSplatCount: decoded.splatCount,
      splatCount: rows.length,
      prunedSplatCount: prunedCount,
      maxSphericalHarmonicsDegree: degree,
      bounds: sceneBounds,
      percentiles,
      sourceUrls
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

  const sourceByteLength = decoded.splatCount * 248;
  process.stdout.write(
    [
      '',
      `  core    ${formatBytes(coreTotal)}  (${(coreTotal / rows.length).toFixed(1)} bytes/splat)`,
      ...bandTotals.map(
        (total, index) =>
          `  band ${index + 1}  ${formatBytes(total)}  (${(total / rows.length).toFixed(1)} bytes/splat)`
      ),
      `  ---`,
      `  degree 0 download  ${formatBytes(coreTotal)}`,
      ...bandTotals.map((_, index) => {
        const cumulative = coreTotal + bandTotals.slice(0, index + 1).reduce((a, b) => a + b, 0);
        return `  degree ${index + 1} download  ${formatBytes(cumulative)}`;
      }),
      '',
      `  source PLY was about ${formatBytes(sourceByteLength)}; degree 1 is ${(
        sourceByteLength /
        (coreTotal + (bandTotals[0] ?? 0))
      ).toFixed(1)}x smaller`,
      `  written to ${archiveDirectory}`,
      `  took ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
      ''
    ].join('\n')
  );

  if (values.verify) {
    const {verifyArchive} = await import('./verify-splat-archive.ts');
    await verifyArchive(archiveDirectory, decoded, buildNodes, degree);
  }
}

main().catch(error => {
  process.stderr.write(`\n${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
