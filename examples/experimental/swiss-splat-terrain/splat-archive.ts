// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {SplatHierarchyNode, SplatSource} from '@luma.gl/splats';

/**
 * The on-disk format a baked splat scene is published in, and the only place its layout is
 * written down.
 *
 * A GraphDECO `.ply` is a training artifact. Every row carries 62 float32 properties -- 248
 * bytes -- of which a renderer uses at most 96, the rows arrive in training order, which has no
 * spatial meaning, and nothing in the file says which splats matter. A browser handed one has to
 * walk all 1.7M rows through a `DataView`, rank them, reorder them and gather five columns
 * before it can draw a single frame, and it has to do all of it again next time the page opens.
 *
 * None of that work depends on the camera, so none of it belongs at load time. `bake-splat-scene`
 * does it once and writes the result out as this format: an additive level-of-detail octree of
 * quantized, Morton-ordered chunks plus a manifest describing the tree. The browser fetches the
 * chunks the camera can actually see, and turning one into renderer columns is a single linear
 * pass with no branches, no ranking and no sort.
 *
 * ## Encoder and decoder live in this file on purpose
 *
 * A quantized format is two functions that have to agree exactly, and they are written next to
 * each other here so a change to one is visibly a change to the other. `bake-splat-scene.ts`
 * imports the encoders under Node; `splat-worker.ts` imports the decoders in the browser. There
 * is no third description of the layout to drift from.
 *
 * ## What each column costs, and why
 *
 * | Column | Stored as | Bytes | Why this and not float32 |
 * | --- | --- | --- | --- |
 * | `positions` | `uint16x3`, per-chunk box | 6 | A chunk spans metres, not the scene. 16 bits over a 10 m cell is 0.15 mm. |
 * | `scales` | `uint16x3`, per-chunk log range | 6 | Scales span orders of magnitude, so the quantization is in log space, which is also how the PLY stores them. |
 * | `rotations` | `uint32` smallest-three | 4 | A unit quaternion has three degrees of freedom; storing four numbers stores a constraint. 10 bits each is ~0.1 degrees. |
 * | `colors` | `float16x3` (x4 with alpha) | 6 | The DC term is unclamped linear radiance and can exceed 1, so `unorm8` would clip it. `float16` keeps the range at half the bytes. |
 * | `opacities` | `uint8` | 1 | Already in `[0, 1]`, and the renderer's own alpha cutoff is `0.5/255`. |
 * | SH band *n* | `int8`, per-band scale | 3 per basis | Higher-order radiance is a correction on a base color, not the base color. |
 *
 * 23 bytes a row against the PLY's 248. A 1.69M-splat scene is about 39 MB of core chunks and
 * 15 MB more for band 1, against roughly 400 MB of source.
 *
 * ## Bands are separate files
 *
 * Spherical-harmonic degree decides how many coefficients are *stored*, not just how many are
 * evaluated, so in the unbaked path changing it re-downloads the entire scene. Here each band is
 * its own file and the bands are cumulative: degree 2 is `core` + `sh1` + `sh2`, and the bytes
 * shared with degree 1 are the same bytes, already in the HTTP cache. luma.gl reads non-DC
 * coefficients as basis-major RGB triplets in ascending basis order, which is exactly what
 * concatenating the band files in order produces -- no transpose at load.
 */

/** Manifest `format` discriminator. */
export const SPLAT_ARCHIVE_FORMAT = 'deck.gl-splat-archive';

/** Bumped whenever a chunk or manifest layout changes; the client refuses anything else. */
export const SPLAT_ARCHIVE_VERSION = 1;

/** `SPLT`, little-endian. */
export const CORE_CHUNK_MAGIC = 0x544c5053;
/** `SPLH`, little-endian. */
export const BAND_CHUNK_MAGIC = 0x484c5053;

/** Set when a chunk stores a fourth color component instead of an implied opaque alpha. */
export const CORE_CHUNK_FLAG_COLOR_ALPHA = 1;

/** Fixed-size core chunk header. Padded past its last field so every section starts aligned. */
export const CORE_HEADER_BYTE_LENGTH = 96;
export const BAND_HEADER_BYTE_LENGTH = 32;

/** Byte offsets within the core chunk header. */
const CORE_OFFSET_MAGIC = 0;
const CORE_OFFSET_VERSION = 4;
const CORE_OFFSET_ROW_COUNT = 8;
const CORE_OFFSET_FLAGS = 12;
const CORE_OFFSET_POSITION_MIN = 16;
const CORE_OFFSET_POSITION_EXTENT = 28;
const CORE_OFFSET_LOG_SCALE_MIN = 40;
const CORE_OFFSET_LOG_SCALE_EXTENT = 52;
/** Five `uint32` section offsets: positions, scales, rotations, colors, opacities. */
const CORE_OFFSET_SECTIONS = 64;

/** Byte offsets within a spherical-harmonic band chunk header. */
const BAND_OFFSET_MAGIC = 0;
const BAND_OFFSET_VERSION = 4;
const BAND_OFFSET_ROW_COUNT = 8;
const BAND_OFFSET_BASIS_COUNT = 12;
const BAND_OFFSET_SCALE = 16;

/** Quantization ranges. Positions and scales use the full `uint16` span. */
const UINT16_MAX = 65535;
/** 10 bits per retained quaternion component. */
const QUATERNION_COMPONENT_MAX = 1023;
/** The three non-largest components of a unit quaternion cannot exceed this. */
const QUATERNION_COMPONENT_LIMIT = Math.SQRT1_2;
/** Highest magnitude an `int8` spherical-harmonic coefficient can represent. */
const SH_COEFFICIENT_MAX = 127;
/** Smallest scale the log quantization will represent, guarding `log(0)`. */
const MINIMUM_SCALE = 1e-9;

/** Highest spherical-harmonic band an archive can carry. */
export type SplatArchiveDegree = 0 | 1 | 2 | 3;

/** Non-DC basis functions contributed by band `band` alone, not cumulatively. */
export function getBandBasisCount(band: number): number {
  return 2 * band + 1;
}

/** Non-DC basis functions in every band up to and including `degree`. */
export function getCumulativeBasisCount(degree: SplatArchiveDegree): number {
  return (degree + 1) ** 2 - 1;
}

/** One node of the additive level-of-detail octree, as the manifest describes it. */
export type SplatArchiveNode = {
  /** Octree path, `'r'` for the root and the child index appended at each level. */
  id: string;
  parentId?: string;
  childIds: string[];
  /** Rows stored in *this* node's chunk, not in its subtree. */
  splatCount: number;
  /** Rows in this node and every descendant, which is what refining it can ever reveal. */
  subtreeSplatCount: number;
  /**
   * Bounding sphere of the node's whole subtree, in source units.
   *
   * It has to enclose the descendants, not just this node's own rows: the traversal stops at a
   * node it culls and never looks at its children, so a sphere fitted to the node's own rows
   * would cull detail that is actually on screen.
   */
  center: [number, number, number];
  radius: number;
  /**
   * Mean spacing between this node's own splats across its octree cell, in source units.
   *
   * This is the error of *stopping here*: the node covers its cell with `splatCount` Gaussians,
   * so they sit about this far apart, and once that spacing projects to more than the layer's
   * `maximumScreenSpaceError` the gaps are visible and the children are worth fetching.
   */
  geometricError: number;
  /** Global row index of this node's first row, assigned in manifest order. */
  rowIndexBase: number;
  coreByteLength: number;
  /** Byte length of each band file; index 0 is band 1. */
  bandByteLengths: number[];
};

/**
 * How a node's children relate to the node itself.
 *
 * `'add'` is a *subset* hierarchy: each node holds splats no ancestor holds, so children extend
 * their parent and a node's own rows are a real, if sparse, view of its region. That is what a
 * reconstruction bakes into, because a trained scene has one set of Gaussians and the only
 * honest way to make it progressive is to split it up.
 *
 * `'replace'` is a *resampled* pyramid: each level re-derives the same ground at a finer
 * sampling, so a node and its children describe the same surface twice and only one of them may
 * be drawn. That is what terrain bakes into, because terrain is not a fixed set of primitives --
 * it is a raster, and a raster has a resolution per zoom level.
 */
export type SplatArchiveRefinement = 'add' | 'replace';

/**
 * Present when an archive's units are already metres in a local east/north/up frame.
 *
 * A reconstruction arrives in arbitrary units with no geographic meaning, so the layer normalizes
 * it: percentiles give an extent, a `sizeMeters` prop gives it a footprint, and the result is
 * placed at an anchor. Terrain has none of that ambiguity -- it was built *from* a geographic
 * raster and every splat already knows where it belongs -- so an archive carrying this is placed
 * one-to-one and the footprint control does not apply to it.
 *
 * The horizontal units are Web Mercator offsets divided by the scale factor at `latitude`, not
 * true ground metres, because that is the frame deck.gl's common space actually is. Over a few
 * kilometres the two differ by about a tenth of a percent; expressing positions this way is what
 * makes them land on the same ground the terrain mesh is drawn on rather than near it.
 */
export type SplatArchiveGeoreference = {
  longitude: number;
  latitude: number;
  /** Elevation in metres that scene z = 0 corresponds to. */
  altitude: number;
};

/** Robust per-axis extent of the scene, sampled at bake time so the client never needs the rows. */
export type SplatArchivePercentiles = {
  /** 2nd and 98th percentile of the x axis, in source units. */
  x: [number, number];
  y: [number, number];
  z: [number, number];
};

export type SplatArchiveManifest = {
  format: typeof SPLAT_ARCHIVE_FORMAT;
  version: number;
  /** How children relate to their parent. Defaults to `'add'` for archives baked before this. */
  refinement?: SplatArchiveRefinement;
  scene: {
    id: string;
    /** Rows in the source PLY files. */
    sourceSplatCount: number;
    /** Rows actually published, after pruning. */
    splatCount: number;
    /** Rows dropped for never clearing the renderer's alpha cutoff. */
    prunedSplatCount: number;
    maxSphericalHarmonicsDegree: SplatArchiveDegree;
    bounds: {min: [number, number, number]; max: [number, number, number]};
    /**
     * Percentiles rather than bounds, because reconstructions contain stray "floater" splats and
     * fitting the scene's metre footprint to the absolute min/max lets one of them shrink
     * everything else to a speck. Baked here because no single chunk sees the whole scene.
     */
    percentiles: SplatArchivePercentiles;
    /** Set when the archive is already georeferenced and must not be normalized. */
    georeference?: SplatArchiveGeoreference;
    /** Source files this archive was baked from, for provenance. */
    sourceUrls: string[];
  };
  encoding: {
    positions: 'uint16x3-box';
    scales: 'uint16x3-log';
    rotations: 'uint32-smallest-three';
    colors: 'float16';
    opacities: 'uint8';
    sphericalHarmonics: 'int8-scaled';
  };
  /** Depth-first, so a client can stream the tree in an order that is useful as it arrives. */
  nodes: SplatArchiveNode[];
};

/** Published path of one node's core chunk, relative to the manifest. */
export function getCoreChunkPath(nodeId: string): string {
  return `nodes/${nodeId}.core.bin`;
}

/** Published path of one node's coefficients for a single band, where `band` is 1-based. */
export function getBandChunkPath(nodeId: string, band: number): string {
  return `nodes/${nodeId}.sh${band}.bin`;
}

/** GPU bytes one prepared row occupies, before spherical harmonics. */
const GPU_BYTES_PER_ROW = 12 + 12 + 16 + 16 + 4 + 4;

/**
 * Upper bound on the GPU allocation a node needs once prepared.
 *
 * Handed to the residency manager *before* the fetch starts, so its budget is enforced against
 * what a page will cost rather than against what has already landed.
 */
export function getNodeGpuByteLength(
  node: SplatArchiveNode,
  degree: SplatArchiveDegree
): number {
  return node.splatCount * (GPU_BYTES_PER_ROW + getCumulativeBasisCount(degree) * 3 * 4);
}

/** Bytes fetched for one node at a given degree, which is what the network actually pays. */
export function getNodeTransferByteLength(
  node: SplatArchiveNode,
  degree: SplatArchiveDegree
): number {
  let total = node.coreByteLength;
  for (let band = 1; band <= degree; band++) {
    total += node.bandByteLengths[band - 1] ?? 0;
  }
  return total;
}

/** Rounds `byteLength` up to the next four-byte boundary. */
function alignTo4(byteLength: number): number {
  return (byteLength + 3) & ~3;
}

/** Core chunk section byte offsets, derived identically by the encoder and the decoder. */
function getCoreSectionOffsets(
  rowCount: number,
  colorComponents: number
): {offsets: number[]; byteLength: number} {
  const positions = CORE_HEADER_BYTE_LENGTH;
  const scales = positions + alignTo4(rowCount * 3 * 2);
  const rotations = scales + alignTo4(rowCount * 3 * 2);
  const colors = rotations + alignTo4(rowCount * 4);
  const opacities = colors + alignTo4(rowCount * colorComponents * 2);
  const byteLength = opacities + alignTo4(rowCount);
  return {offsets: [positions, scales, rotations, colors, opacities], byteLength};
}

/* ------------------------------------------------------------------ float16 */

const float32Scratch = new Float32Array(1);
const uint32Scratch = new Uint32Array(float32Scratch.buffer);

/**
 * Rounds one float32 to the nearest float16 bit pattern.
 *
 * Only the baker calls this, once per value, so it is written for clarity rather than speed.
 * Values beyond float16's range saturate to infinity, which a radiance term never reaches.
 */
export function packFloat16(value: number): number {
  float32Scratch[0] = value;
  const bits = uint32Scratch[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  let mantissa = bits & 0x7fffff;

  if (exponent === 0xff) {
    return sign | 0x7c00 | (mantissa ? 0x0200 : 0);
  }

  const halfExponent = exponent - 127 + 15;
  if (halfExponent >= 0x1f) {
    return sign | 0x7c00;
  }
  if (halfExponent <= 0) {
    if (halfExponent < -10) {
      return sign;
    }
    // Subnormal: restore the implicit leading one and shift it down into the reduced exponent.
    mantissa |= 0x800000;
    const shift = 14 - halfExponent;
    const half = (mantissa >>> shift) + ((mantissa >>> (shift - 1)) & 1);
    return sign | half;
  }
  // The round-to-nearest carry is allowed to propagate into the exponent field, which is what
  // a mantissa overflow means.
  return sign | (((halfExponent << 10) | (mantissa >>> 13)) + ((mantissa >>> 12) & 1));
}

/**
 * Every float16 bit pattern as a float32, built once on first use.
 *
 * The decoder resolves millions of coefficients per scene, and a table lookup is several times
 * faster than reassembling the exponent and mantissa per value. 128 KB, shared process-wide.
 */
let float16Table: Float32Array | undefined;

function getFloat16Table(): Float32Array {
  if (float16Table) {
    return float16Table;
  }
  const table = new Float32Array(65536);
  for (let bits = 0; bits < 65536; bits++) {
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = (bits >>> 10) & 0x1f;
    const mantissa = bits & 0x3ff;
    if (exponent === 0) {
      table[bits] = sign * mantissa * 2 ** -24;
    } else if (exponent === 0x1f) {
      table[bits] = mantissa ? NaN : sign * Infinity;
    } else {
      table[bits] = sign * (mantissa + 1024) * 2 ** (exponent - 25);
    }
  }
  float16Table = table;
  return table;
}

/** One float16 bit pattern as a float32. */
export function unpackFloat16(bits: number): number {
  return getFloat16Table()[bits & 0xffff];
}

/* -------------------------------------------------------------- quaternions */

/**
 * Packs a normalized `(w, x, y, z)` quaternion into 32 bits by dropping its largest component.
 *
 * A unit quaternion has three degrees of freedom, so the fourth number is redundant: the largest
 * component can always be recovered from the other three, and because it is the largest it is
 * also the one whose reconstruction is least sensitive to their error. `q` and `-q` are the same
 * rotation, so the sign is normalized away and the recovered component is always positive.
 */
export function packQuaternion(w: number, x: number, y: number, z: number): number {
  const components = [w, x, y, z];
  let largest = 0;
  for (let index = 1; index < 4; index++) {
    if (Math.abs(components[index]) > Math.abs(components[largest])) {
      largest = index;
    }
  }
  const sign = components[largest] < 0 ? -1 : 1;

  let packed = largest << 30;
  let shift = 20;
  for (let index = 0; index < 4; index++) {
    if (index === largest) {
      continue;
    }
    const normalized = (components[index] * sign) / QUATERNION_COMPONENT_LIMIT;
    const clamped = Math.min(1, Math.max(-1, normalized));
    packed |= Math.round((clamped * 0.5 + 0.5) * QUATERNION_COMPONENT_MAX) << shift;
    shift -= 10;
  }
  return packed >>> 0;
}

/** Writes one packed quaternion back out as `(w, x, y, z)` floats. */
export function unpackQuaternion(packed: number, out: Float32Array, offset: number): void {
  const largest = packed >>> 30;
  let sumOfSquares = 0;
  let shift = 20;
  for (let index = 0; index < 4; index++) {
    if (index === largest) {
      continue;
    }
    const quantized = (packed >>> shift) & QUATERNION_COMPONENT_MAX;
    const value =
      ((quantized / QUATERNION_COMPONENT_MAX) * 2 - 1) * QUATERNION_COMPONENT_LIMIT;
    out[offset + index] = value;
    sumOfSquares += value * value;
    shift -= 10;
  }
  out[offset + largest] = Math.sqrt(Math.max(0, 1 - sumOfSquares));
}

/* ------------------------------------------------------------- core chunks */

/** Columns for the rows of a single node, in the order they will be stored. */
export type SplatChunkColumns = {
  rowCount: number;
  positions: Float32Array;
  scales: Float32Array;
  rotations: Float32Array;
  colors: Float32Array;
  opacities: Float32Array;
};

/** Encodes one node's rows as a self-describing core chunk. */
export function encodeCoreChunk(columns: SplatChunkColumns): ArrayBuffer {
  const {rowCount, positions, scales, rotations, colors, opacities} = columns;

  let hasAlpha = false;
  for (let row = 0; row < rowCount && !hasAlpha; row++) {
    hasAlpha = colors[row * 4 + 3] !== 1;
  }
  const colorComponents = hasAlpha ? 4 : 3;

  const positionMin = [Infinity, Infinity, Infinity];
  const positionMax = [-Infinity, -Infinity, -Infinity];
  const logScaleMin = [Infinity, Infinity, Infinity];
  const logScaleMax = [-Infinity, -Infinity, -Infinity];
  for (let row = 0; row < rowCount; row++) {
    for (let axis = 0; axis < 3; axis++) {
      const position = positions[row * 3 + axis];
      if (position < positionMin[axis]) positionMin[axis] = position;
      if (position > positionMax[axis]) positionMax[axis] = position;
      const logScale = Math.log(Math.max(scales[row * 3 + axis], MINIMUM_SCALE));
      if (logScale < logScaleMin[axis]) logScaleMin[axis] = logScale;
      if (logScale > logScaleMax[axis]) logScaleMax[axis] = logScale;
    }
  }
  // A node whose rows share an exact coordinate leaves a zero-width axis; give it a nominal
  // span so the quantization scale stays finite and every value lands in bin zero.
  const positionExtent = positionMin.map((min, axis) =>
    Math.max(positionMax[axis] - min, Number.EPSILON)
  );
  const logScaleExtent = logScaleMin.map((min, axis) =>
    Math.max(logScaleMax[axis] - min, Number.EPSILON)
  );

  const {offsets, byteLength} = getCoreSectionOffsets(rowCount, colorComponents);
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);

  view.setUint32(CORE_OFFSET_MAGIC, CORE_CHUNK_MAGIC, true);
  view.setUint32(CORE_OFFSET_VERSION, SPLAT_ARCHIVE_VERSION, true);
  view.setUint32(CORE_OFFSET_ROW_COUNT, rowCount, true);
  view.setUint32(CORE_OFFSET_FLAGS, hasAlpha ? CORE_CHUNK_FLAG_COLOR_ALPHA : 0, true);
  for (let axis = 0; axis < 3; axis++) {
    view.setFloat32(CORE_OFFSET_POSITION_MIN + axis * 4, positionMin[axis], true);
    view.setFloat32(CORE_OFFSET_POSITION_EXTENT + axis * 4, positionExtent[axis], true);
    view.setFloat32(CORE_OFFSET_LOG_SCALE_MIN + axis * 4, logScaleMin[axis], true);
    view.setFloat32(CORE_OFFSET_LOG_SCALE_EXTENT + axis * 4, logScaleExtent[axis], true);
  }
  for (let section = 0; section < offsets.length; section++) {
    view.setUint32(CORE_OFFSET_SECTIONS + section * 4, offsets[section], true);
  }

  const quantizedPositions = new Uint16Array(buffer, offsets[0], rowCount * 3);
  const quantizedScales = new Uint16Array(buffer, offsets[1], rowCount * 3);
  const packedRotations = new Uint32Array(buffer, offsets[2], rowCount);
  const packedColors = new Uint16Array(buffer, offsets[3], rowCount * colorComponents);
  const quantizedOpacities = new Uint8Array(buffer, offsets[4], rowCount);

  for (let row = 0; row < rowCount; row++) {
    for (let axis = 0; axis < 3; axis++) {
      const index = row * 3 + axis;
      const position = (positions[index] - positionMin[axis]) / positionExtent[axis];
      quantizedPositions[index] = Math.round(
        Math.min(1, Math.max(0, position)) * UINT16_MAX
      );
      const logScale = Math.log(Math.max(scales[index], MINIMUM_SCALE));
      const normalizedScale = (logScale - logScaleMin[axis]) / logScaleExtent[axis];
      quantizedScales[index] = Math.round(Math.min(1, Math.max(0, normalizedScale)) * UINT16_MAX);
    }

    packedRotations[row] = packQuaternion(
      rotations[row * 4],
      rotations[row * 4 + 1],
      rotations[row * 4 + 2],
      rotations[row * 4 + 3]
    );

    for (let component = 0; component < colorComponents; component++) {
      packedColors[row * colorComponents + component] = packFloat16(
        colors[row * 4 + component]
      );
    }

    quantizedOpacities[row] = Math.round(Math.min(1, Math.max(0, opacities[row])) * 255);
  }

  return buffer;
}

/**
 * Expands one core chunk back into renderer columns.
 *
 * One linear pass, no branches inside the row loop and no allocation beyond the five outputs.
 * This is the whole of what replaces the PLY decode, the importance ranking, the Morton sort and
 * the five-column gather the unbaked path runs before its first frame.
 */
export function decodeCoreChunk(buffer: ArrayBuffer): SplatChunkColumns {
  const view = new DataView(buffer);
  if (view.getUint32(CORE_OFFSET_MAGIC, true) !== CORE_CHUNK_MAGIC) {
    throw new Error('Not a splat archive core chunk');
  }
  const version = view.getUint32(CORE_OFFSET_VERSION, true);
  if (version !== SPLAT_ARCHIVE_VERSION) {
    throw new Error(`Unsupported splat archive chunk version ${version}`);
  }

  const rowCount = view.getUint32(CORE_OFFSET_ROW_COUNT, true);
  const flags = view.getUint32(CORE_OFFSET_FLAGS, true);
  const colorComponents = flags & CORE_CHUNK_FLAG_COLOR_ALPHA ? 4 : 3;

  const positionMin = [0, 0, 0];
  const positionScale = [0, 0, 0];
  const logScaleMin = [0, 0, 0];
  const logScaleScale = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    positionMin[axis] = view.getFloat32(CORE_OFFSET_POSITION_MIN + axis * 4, true);
    positionScale[axis] = view.getFloat32(CORE_OFFSET_POSITION_EXTENT + axis * 4, true) / UINT16_MAX;
    logScaleMin[axis] = view.getFloat32(CORE_OFFSET_LOG_SCALE_MIN + axis * 4, true);
    logScaleScale[axis] =
      view.getFloat32(CORE_OFFSET_LOG_SCALE_EXTENT + axis * 4, true) / UINT16_MAX;
  }

  const offsets = [0, 0, 0, 0, 0];
  for (let section = 0; section < offsets.length; section++) {
    offsets[section] = view.getUint32(CORE_OFFSET_SECTIONS + section * 4, true);
  }

  const quantizedPositions = new Uint16Array(buffer, offsets[0], rowCount * 3);
  const quantizedScales = new Uint16Array(buffer, offsets[1], rowCount * 3);
  const packedRotations = new Uint32Array(buffer, offsets[2], rowCount);
  const packedColors = new Uint16Array(buffer, offsets[3], rowCount * colorComponents);
  const quantizedOpacities = new Uint8Array(buffer, offsets[4], rowCount);

  const positions = new Float32Array(rowCount * 3);
  const scales = new Float32Array(rowCount * 3);
  const rotations = new Float32Array(rowCount * 4);
  const colors = new Float32Array(rowCount * 4);
  const opacities = new Float32Array(rowCount);
  const float16Values = getFloat16Table();

  for (let row = 0; row < rowCount; row++) {
    for (let axis = 0; axis < 3; axis++) {
      const index = row * 3 + axis;
      positions[index] = positionMin[axis] + quantizedPositions[index] * positionScale[axis];
      scales[index] = Math.exp(logScaleMin[axis] + quantizedScales[index] * logScaleScale[axis]);
    }

    unpackQuaternion(packedRotations[row], rotations, row * 4);

    const colorBase = row * colorComponents;
    colors[row * 4] = float16Values[packedColors[colorBase]];
    colors[row * 4 + 1] = float16Values[packedColors[colorBase + 1]];
    colors[row * 4 + 2] = float16Values[packedColors[colorBase + 2]];
    colors[row * 4 + 3] =
      colorComponents === 4 ? float16Values[packedColors[colorBase + 3]] : 1;

    opacities[row] = quantizedOpacities[row] / 255;
  }

  return {rowCount, positions, scales, rotations, colors, opacities};
}

/* ------------------------------------------------------------- band chunks */

/**
 * Encodes the coefficients of one spherical-harmonic band.
 *
 * `coefficients` is row-major with `basisCount * 3` values per row, in luma.gl's basis-major RGB
 * order. One scale covers the whole chunk: coefficients within a band are the same kind of
 * quantity at the same magnitude, so a per-row or per-channel scale would cost more bytes than
 * the precision it buys.
 */
export function encodeBandChunk(
  coefficients: Float32Array,
  rowCount: number,
  basisCount: number
): ArrayBuffer {
  const valuesPerRow = basisCount * 3;
  let maximumMagnitude = 0;
  for (let index = 0; index < rowCount * valuesPerRow; index++) {
    const magnitude = Math.abs(coefficients[index]);
    if (magnitude > maximumMagnitude) {
      maximumMagnitude = magnitude;
    }
  }
  const scale = maximumMagnitude > 0 ? maximumMagnitude / SH_COEFFICIENT_MAX : 1;

  const byteLength = BAND_HEADER_BYTE_LENGTH + alignTo4(rowCount * valuesPerRow);
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  view.setUint32(BAND_OFFSET_MAGIC, BAND_CHUNK_MAGIC, true);
  view.setUint32(BAND_OFFSET_VERSION, SPLAT_ARCHIVE_VERSION, true);
  view.setUint32(BAND_OFFSET_ROW_COUNT, rowCount, true);
  view.setUint32(BAND_OFFSET_BASIS_COUNT, basisCount, true);
  view.setFloat32(BAND_OFFSET_SCALE, scale, true);

  const quantized = new Int8Array(buffer, BAND_HEADER_BYTE_LENGTH, rowCount * valuesPerRow);
  for (let index = 0; index < quantized.length; index++) {
    const value = Math.round(coefficients[index] / scale);
    quantized[index] = Math.min(SH_COEFFICIENT_MAX, Math.max(-SH_COEFFICIENT_MAX, value));
  }
  return buffer;
}

/** One band chunk's header and its quantized coefficients, left in place. */
export type SplatBandChunk = {
  rowCount: number;
  basisCount: number;
  scale: number;
  quantized: Int8Array;
};

/** Reads a band chunk's header and returns a view of its coefficients without copying them. */
export function readBandChunk(buffer: ArrayBuffer): SplatBandChunk {
  const view = new DataView(buffer);
  if (view.getUint32(BAND_OFFSET_MAGIC, true) !== BAND_CHUNK_MAGIC) {
    throw new Error('Not a splat archive spherical-harmonic band chunk');
  }
  const version = view.getUint32(BAND_OFFSET_VERSION, true);
  if (version !== SPLAT_ARCHIVE_VERSION) {
    throw new Error(`Unsupported splat archive chunk version ${version}`);
  }
  const rowCount = view.getUint32(BAND_OFFSET_ROW_COUNT, true);
  const basisCount = view.getUint32(BAND_OFFSET_BASIS_COUNT, true);
  return {
    rowCount,
    basisCount,
    scale: view.getFloat32(BAND_OFFSET_SCALE, true),
    quantized: new Int8Array(
      buffer,
      BAND_HEADER_BYTE_LENGTH,
      rowCount * basisCount * 3
    )
  };
}

/**
 * Interleaves consecutive band chunks into one coefficient column.
 *
 * luma.gl reads non-DC coefficients as `basisCount * 3` values per row, basis-major with an RGB
 * triplet per basis, ascending. The bands are stored in that same order, so a chunk's row is the
 * concatenation of its bands' rows and this is a copy with a stride, not a transpose.
 */
export function mergeBandChunks(bands: SplatBandChunk[], rowCount: number): Float32Array {
  const totalBasisCount = bands.reduce((total, band) => total + band.basisCount, 0);
  const merged = new Float32Array(rowCount * totalBasisCount * 3);

  let basisOffset = 0;
  for (const band of bands) {
    const bandValuesPerRow = band.basisCount * 3;
    const {scale, quantized} = band;
    for (let row = 0; row < rowCount; row++) {
      const target = row * totalBasisCount * 3 + basisOffset * 3;
      const source = row * bandValuesPerRow;
      for (let value = 0; value < bandValuesPerRow; value++) {
        merged[target + value] = quantized[source + value] * scale;
      }
    }
    basisOffset += band.basisCount;
  }
  return merged;
}

/* ---------------------------------------------------------------- traversal */

/**
 * Turns a manifest into the node tree luma.gl's `SplatHierarchyManager` traverses.
 *
 * Kept here, beside the format, and free of any device, worker or network dependency -- so the
 * level-of-detail behaviour an archive produces can be simulated against the real traversal
 * without a browser. Three fields decide everything the traversal does:
 *
 * - **`refinement`** comes from the manifest, because the two bakers build different kinds of
 *   tree. A reconstruction is `'add'`: each node holds splats its ancestors did not take, so a
 *   half-refined subtree still shows its parent's coverage underneath and the root alone is a
 *   complete coarse scene. Terrain is `'replace'`: each level resamples the same ground finer, so
 *   a resident parent stands in until its children are all there and then stops being drawn.
 * - **`estimatedGpuBytes` / `estimatedSplatCount`** so the residency manager can charge a page
 *   against its budget *before* the fetch starts. A page that will not fit is then never
 *   requested, rather than downloaded and evicted.
 * - **`ownsData: true`** so an evicted page's GPU buffers are destroyed. It defaults to false,
 *   and left that way a streaming scene leaks every page it ever drops.
 */
export function buildSplatArchiveHierarchy(
  manifest: SplatArchiveManifest,
  degree: SplatArchiveDegree,
  baseUrl: string
): SplatHierarchyNode[] {
  const nodesById = new Map(manifest.nodes.map(node => [node.id, node]));
  const refinement = manifest.refinement ?? 'add';

  const toHierarchyNode = (node: SplatArchiveNode): SplatHierarchyNode => ({
    id: node.id,
    ...(node.parentId ? {parentId: node.parentId} : {}),
    bounds: {center: node.center, radius: node.radius},
    geometricError: node.geometricError,
    refinement,
    ownsData: true,
    estimatedGpuBytes: getNodeGpuByteLength(node, degree),
    estimatedSplatCount: node.splatCount,
    contentUri: new URL(getCoreChunkPath(node.id), baseUrl).href,
    ...(node.childIds.length > 0
      ? {children: node.childIds.map(childId => toHierarchyNode(nodesById.get(childId)!))}
      : {})
  });

  return manifest.nodes.filter(node => !node.parentId).map(toHierarchyNode);
}

/** Assembles decoded chunk columns into the framework-independent source luma.gl uploads. */
export function toSplatSource(
  columns: SplatChunkColumns,
  sphericalHarmonics: Float32Array | undefined,
  sphericalHarmonicsDegree: SplatArchiveDegree,
  identity: {sourceBatchIndex: number; rowIndexBase: number}
): SplatSource {
  return {
    positions: columns.positions,
    scales: columns.scales,
    rotations: columns.rotations,
    colors: columns.colors,
    opacities: columns.opacities,
    ...(sphericalHarmonics && sphericalHarmonicsDegree > 0
      ? {sphericalHarmonics, sphericalHarmonicsDegree}
      : {}),
    sourceBatchIndex: identity.sourceBatchIndex,
    rowIndexBase: identity.rowIndexBase
  };
}
