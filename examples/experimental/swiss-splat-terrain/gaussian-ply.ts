// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {SplatSource} from '@luma.gl/splats';

/**
 * Streaming reader for GraphDECO-convention 3D Gaussian Splatting `.ply` files.
 *
 * `@loaders.gl/ply` is a general mesh loader and does not decode Gaussian splat semantics,
 * so this module reads the vertex records directly and applies the reconstruction the
 * reference implementation uses: `exp` scales, `sigmoid` opacity, and a DC spherical-harmonic
 * term folded into a base color.
 *
 * Rows are decoded as bytes arrive so a multi-hundred-megabyte scene never needs a second
 * full-file copy in memory alongside the decoded columns.
 */

/** DC spherical-harmonic basis value, `0.5 / sqrt(pi)`. */
const SH_C0 = 0.28209479177387814;

const PLY_TYPE_BYTES: Record<string, number> = {
  char: 1,
  uchar: 1,
  int8: 1,
  uint8: 1,
  short: 2,
  ushort: 2,
  int16: 2,
  uint16: 2,
  int: 4,
  uint: 4,
  int32: 4,
  uint32: 4,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8
};

/** Highest spherical-harmonic band luma.gl accepts for prepared source coefficients. */
export type SphericalHarmonicsDegree = 0 | 1 | 2 | 3;

export type GaussianPlyOptions = {
  /**
   * Highest non-DC band retained. Each extra band costs GPU memory for every splat, so the
   * default keeps only the first band. Bands present in the file but above this degree are skipped.
   */
  sphericalHarmonicsDegree?: SphericalHarmonicsDegree;
  /** Reports decode progress as a 0..1 fraction, or `undefined` when the length is unknown. */
  onProgress?: (loadedBytes: number, totalBytes: number | undefined, splatCount: number) => void;
  /** Aborts the in-flight request and decode. */
  signal?: AbortSignal;
};

/** Axis-aligned bounds of the decoded splat centers, in the file's own units. */
export type GaussianPlyBounds = {
  min: [number, number, number];
  max: [number, number, number];
};

export type GaussianPlyResult = {
  source: SplatSource;
  bounds: GaussianPlyBounds;
  /** Non-DC bands actually retained, which may be lower than requested. */
  sphericalHarmonicsDegree: SphericalHarmonicsDegree;
};

type PlyLayout = {
  vertexCount: number;
  rowStride: number;
  /** Byte offset of each named scalar property within one vertex record. */
  offsets: Record<string, number>;
  restNames: string[];
  dataStart: number;
};

/** Number of non-DC basis functions for a spherical-harmonic degree. */
function getBasisCount(degree: SphericalHarmonicsDegree): number {
  return (degree + 1) ** 2 - 1;
}

function parseHeader(bytes: Uint8Array): PlyLayout | null {
  const text = new TextDecoder('latin1').decode(bytes);
  const terminator = text.indexOf('end_header');
  if (terminator < 0) {
    return null;
  }
  const newline = text.indexOf('\n', terminator);
  if (newline < 0) {
    return null;
  }

  const header = text.slice(0, terminator);
  if (!/format\s+binary_little_endian/.test(header)) {
    throw new Error('Only binary_little_endian Gaussian splat PLY files are supported');
  }

  let vertexCount = 0;
  let rowStride = 0;
  let inVertexElement = false;
  const offsets: Record<string, number> = {};
  const restNames: string[] = [];

  for (const rawLine of header.split('\n')) {
    const parts = rawLine.trim().split(/\s+/);
    if (parts[0] === 'element') {
      // Properties are only collected for the vertex element; trailing elements are ignored.
      inVertexElement = parts[1] === 'vertex';
      if (inVertexElement) {
        vertexCount = Number(parts[2]);
      }
    } else if (parts[0] === 'property' && inVertexElement) {
      if (parts[1] === 'list') {
        throw new Error('List properties are not supported in Gaussian splat PLY vertex records');
      }
      const size = PLY_TYPE_BYTES[parts[1]];
      if (!size) {
        throw new Error(`Unsupported PLY property type "${parts[1]}"`);
      }
      const name = parts[2];
      offsets[name] = rowStride;
      rowStride += size;
      if (name.startsWith('f_rest_')) {
        restNames.push(name);
      }
    }
  }

  if (!vertexCount || !rowStride) {
    throw new Error('Gaussian splat PLY header declares no vertex records');
  }
  for (const required of ['x', 'y', 'z', 'opacity', 'scale_0', 'rot_0', 'f_dc_0']) {
    if (offsets[required] === undefined) {
      throw new Error(`Gaussian splat PLY is missing the "${required}" property`);
    }
  }

  // `f_rest_10` must sort after `f_rest_9`, which a lexicographic sort would get wrong.
  restNames.sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));

  return {vertexCount, rowStride, offsets, restNames, dataStart: newline + 1};
}

/** Fetches and decodes one Gaussian splat PLY into caller-owned luma.gl source columns. */
export async function loadGaussianPly(
  url: string,
  options: GaussianPlyOptions = {}
): Promise<GaussianPlyResult> {
  const response = await fetch(url, {signal: options.signal});
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error('Gaussian splat PLY response has no readable body');
  }

  return decodeGaussianPlyStream(response.body, {
    ...options,
    totalBytes: Number(response.headers.get('content-length')) || undefined
  });
}

/**
 * Decodes one Gaussian splat PLY from an already-open byte stream.
 *
 * Split out from the fetch so the same decoder serves three callers that get their bytes from
 * different places: the browser's `fetch` body, a worker's, and `bake-splat-scene`'s file
 * handle under Node, where `fetch` cannot open a local path at all.
 */
export async function decodeGaussianPlyStream(
  stream: ReadableStream<Uint8Array>,
  options: GaussianPlyOptions & {
    /** Total byte length when the caller knows it, reported through `onProgress`. */
    totalBytes?: number;
  } = {}
): Promise<GaussianPlyResult> {
  const {sphericalHarmonicsDegree = 1, onProgress, signal, totalBytes: contentLength} = options;

  const reader = stream.getReader();

  let layout: PlyLayout | null = null;
  // `subarray` yields an `ArrayBufferLike`-backed view, so the buffer type is widened here.
  let carry: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let loadedBytes = 0;
  let decodedSplats = 0;

  // Populated once the header is parsed.
  let positions!: Float32Array;
  let scales!: Float32Array;
  let rotations!: Float32Array;
  let colors!: Float32Array;
  let opacities!: Float32Array;
  let sphericalHarmonics: Float32Array | undefined;
  let retainedDegree: SphericalHarmonicsDegree = 0;
  let basisCount = 0;
  let restPerChannel = 0;
  let restBaseOffset = 0;
  let restElementSize = 4;

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  const decodeRows = (buffer: Uint8Array): number => {
    const {rowStride, offsets} = layout!;
    const rows = Math.min(
      Math.floor(buffer.byteLength / rowStride),
      layout!.vertexCount - decodedSplats
    );
    if (rows <= 0) {
      return 0;
    }
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    for (let row = 0; row < rows; row++) {
      const base = row * rowStride;
      const splatIndex = decodedSplats + row;
      const vec3Offset = splatIndex * 3;
      const vec4Offset = splatIndex * 4;

      const x = view.getFloat32(base + offsets.x, true);
      const y = view.getFloat32(base + offsets.y, true);
      const z = view.getFloat32(base + offsets.z, true);
      positions[vec3Offset] = x;
      positions[vec3Offset + 1] = y;
      positions[vec3Offset + 2] = z;
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;

      // Scales are stored as logarithms and opacity as a logit.
      scales[vec3Offset] = Math.exp(view.getFloat32(base + offsets.scale_0, true));
      scales[vec3Offset + 1] = Math.exp(view.getFloat32(base + offsets.scale_1, true));
      scales[vec3Offset + 2] = Math.exp(view.getFloat32(base + offsets.scale_2, true));
      opacities[splatIndex] = 1 / (1 + Math.exp(-view.getFloat32(base + offsets.opacity, true)));

      // Stored as (w, x, y, z), which is the order luma.gl expects.
      const rw = view.getFloat32(base + offsets.rot_0, true);
      const rx = view.getFloat32(base + offsets.rot_1, true);
      const ry = view.getFloat32(base + offsets.rot_2, true);
      const rz = view.getFloat32(base + offsets.rot_3, true);
      const inverseLength = 1 / (Math.hypot(rw, rx, ry, rz) || 1);
      rotations[vec4Offset] = rw * inverseLength;
      rotations[vec4Offset + 1] = rx * inverseLength;
      rotations[vec4Offset + 2] = ry * inverseLength;
      rotations[vec4Offset + 3] = rz * inverseLength;

      // Reconstruct the DC term into an unclamped linear base color.
      colors[vec4Offset] = 0.5 + SH_C0 * view.getFloat32(base + offsets.f_dc_0, true);
      colors[vec4Offset + 1] = 0.5 + SH_C0 * view.getFloat32(base + offsets.f_dc_1, true);
      colors[vec4Offset + 2] = 0.5 + SH_C0 * view.getFloat32(base + offsets.f_dc_2, true);
      colors[vec4Offset + 3] = 1;

      if (sphericalHarmonics) {
        // The file stores every basis for red, then green, then blue. luma.gl reads
        // basis-major RGB triplets, so the two layouts are transposed here.
        const target = splatIndex * basisCount * 3;
        for (let basis = 0; basis < basisCount; basis++) {
          for (let channel = 0; channel < 3; channel++) {
            const sourceOffset =
              base + restBaseOffset + (channel * restPerChannel + basis) * restElementSize;
            sphericalHarmonics[target + basis * 3 + channel] = view.getFloat32(sourceOffset, true);
          }
        }
      }
    }

    decodedSplats += rows;
    return rows * rowStride;
  };

  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) {
        break;
      }
      signal?.throwIfAborted();
      loadedBytes += value.byteLength;

      let buffer: Uint8Array<ArrayBufferLike>;
      if (carry.byteLength === 0) {
        buffer = value;
      } else {
        buffer = new Uint8Array(carry.byteLength + value.byteLength);
        buffer.set(carry, 0);
        buffer.set(value, carry.byteLength);
      }

      if (!layout) {
        layout = parseHeader(buffer);
        if (!layout) {
          // Header is still incomplete; keep accumulating.
          carry = buffer;
          continue;
        }

        const count = layout.vertexCount;
        positions = new Float32Array(count * 3);
        scales = new Float32Array(count * 3);
        rotations = new Float32Array(count * 4);
        colors = new Float32Array(count * 4);
        opacities = new Float32Array(count);

        restPerChannel = Math.floor(layout.restNames.length / 3);
        const availableDegree = ([0, 1, 2, 3] as SphericalHarmonicsDegree[]).filter(
          degree => getBasisCount(degree) <= restPerChannel
        );
        retainedDegree = Math.min(
          sphericalHarmonicsDegree,
          availableDegree[availableDegree.length - 1] ?? 0
        ) as SphericalHarmonicsDegree;
        basisCount = getBasisCount(retainedDegree);
        if (basisCount > 0) {
          restBaseOffset = layout.offsets[layout.restNames[0]];
          restElementSize =
            layout.restNames.length > 1
              ? layout.offsets[layout.restNames[1]] - layout.offsets[layout.restNames[0]]
              : 4;
          sphericalHarmonics = new Float32Array(count * basisCount * 3);
        }

        buffer = buffer.subarray(layout.dataStart);
      }

      const consumed = decodeRows(buffer);
      carry = consumed >= buffer.byteLength ? new Uint8Array(0) : buffer.subarray(consumed);
      onProgress?.(loadedBytes, contentLength, decodedSplats);

      if (decodedSplats >= layout.vertexCount) {
        break;
      }
    }
  } finally {
    // Releases the connection when the caller aborts or the loop exits early.
    await reader.cancel().catch(() => {});
  }

  if (!layout) {
    throw new Error('Gaussian splat PLY ended before its header was complete');
  }
  if (decodedSplats === 0) {
    throw new Error('Gaussian splat PLY contained no decodable vertex records');
  }

  // A truncated transfer still yields a usable scene; trim the columns to what decoded.
  if (decodedSplats < layout.vertexCount) {
    positions = positions.subarray(0, decodedSplats * 3);
    scales = scales.subarray(0, decodedSplats * 3);
    rotations = rotations.subarray(0, decodedSplats * 4);
    colors = colors.subarray(0, decodedSplats * 4);
    opacities = opacities.subarray(0, decodedSplats);
    if (sphericalHarmonics) {
      sphericalHarmonics = sphericalHarmonics.subarray(0, decodedSplats * basisCount * 3);
    }
  }

  const source: SplatSource = {
    positions,
    scales,
    rotations,
    colors,
    opacities,
    ...(sphericalHarmonics ? {sphericalHarmonics, sphericalHarmonicsDegree: retainedDegree} : {})
  };

  return {source, bounds: {min, max}, sphericalHarmonicsDegree: retainedDegree};
}
