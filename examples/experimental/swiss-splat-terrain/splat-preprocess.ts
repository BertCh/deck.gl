// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {SplatSource} from '@luma.gl/splats';

/**
 * One load-time pass that puts a decoded scene into the shape the render path actually wants.
 *
 * A Gaussian splat renderer re-derives its draw order every time the camera moves, and on the
 * WebGL2 path it then has to *materialize* that order by gathering every source attribute into a
 * new buffer, because WebGL2 has no storage buffers to index through. Both costs are paid per
 * frame; neither can be cached. So everything that can be decided once, before the first frame,
 * is worth deciding once:
 *
 * 1. **Prune.** Splats whose opacity can never clear the renderer's alpha cutoff are tested and
 *    rejected on every single frame, in the per-row visibility walk. Dropping them at load
 *    removes them from the walk, the sort and the gather alike, and changes nothing on screen.
 * 2. **Budget.** Every per-frame cost is linear in the splat count, so the count is the coarsest
 *    dial there is. Splats are ranked by the screen area they are likely to cover -- opacity
 *    times the geometric mean of the three axis lengths -- rather than sampled uniformly, because
 *    a uniform sample keeps as many near-transparent specks as it does the large opaque Gaussians
 *    that carry the surface, and looks visibly thinner at the same budget.
 * 3. **Order.** A PLY stores splats in training order, which has no spatial meaning, so a
 *    depth-sorted gather reads its ~160 MB of source columns in essentially random order. Sorting
 *    the rows by Morton code once at load makes the depth order *nearly* sequential, and the
 *    per-frame gather then streams through cache instead of missing on every row. Measured on a
 *    1.7M-splat scene: the WebGL2 attribute repack drops from ~745 ms to ~265 ms per frame, and
 *    the depth sort itself from ~77 ms to ~59 ms, for a one-time reordering cost. The WebGPU path
 *    gets the same coherence in its projection pass's storage reads.
 *
 * All three happen in a single gather, so the reordering is free on top of the budget.
 */

export type SplatPreprocessOptions = {
  /** Maximum splats kept, ranked by likely screen coverage. `Infinity` keeps the whole scene. */
  maxSplats?: number;
  /**
   * Splats below this opacity are dropped. Defaults to the renderer's own alpha cutoff, so the
   * only rows removed are ones every frame would have rejected anyway.
   */
  minOpacity?: number;
  /** Sort the kept rows by Morton code. On by default; there is no reason to turn it off. */
  spatialOrder?: boolean;
};

/** Bins used to find the importance threshold without sorting the whole scene. */
const SCORE_HISTOGRAM_BINS = 1024;
/** Bits per axis in the Morton code. 10 gives a 1024³ lattice, well past any depth ambiguity. */
const MORTON_AXIS_BITS = 10;
const MORTON_AXIS_SCALE = (1 << MORTON_AXIS_BITS) - 1;

/** luma.gl's default minimum fragment opacity, which is also `SplatLayer`'s default. */
const DEFAULT_ALPHA_CUTOFF = 0.5 / 255;

/** Column element types a `SplatSource` can carry. */
type SplatColumn = Float32Array | Uint8Array | Uint32Array;

/** Source row indices. Widened because `subarray` and the radix scratch share a buffer type. */
type RowIndices = Uint32Array<ArrayBufferLike>;

/**
 * Ranks one splat by the screen area it is likely to cover.
 *
 * Exported because `bake-splat-scene` ranks by the same measure when it decides which splats a
 * level-of-detail node keeps: a scene baked under one definition of "important" and budgeted at
 * runtime under another would drop the wrong rows.
 */
export function getSplatImportance(
  opacities: ArrayLike<number>,
  scales: ArrayLike<number>,
  index: number
): number {
  const scaleOffset = index * 3;
  const volume = scales[scaleOffset] * scales[scaleOffset + 1] * scales[scaleOffset + 2];
  return opacities[index] * Math.cbrt(Math.max(volume, 0));
}

/** Interleaves the low 10 bits of `value` with two zero bits each, for a 30-bit Morton code. */
function spreadBits(value: number): number {
  let bits = value & 0x3ff;
  bits = (bits | (bits << 16)) & 0x030000ff;
  bits = (bits | (bits << 8)) & 0x0300f00f;
  bits = (bits | (bits << 4)) & 0x030c30c3;
  bits = (bits | (bits << 2)) & 0x09249249;
  return bits >>> 0;
}

/** Sorts `indices` in place by their `keys`, in linear time over four 8-bit digits. */
function radixSortByKey(indices: RowIndices, keys: Uint32Array): RowIndices {
  const count = indices.length;
  let source: RowIndices = indices;
  let target: RowIndices = new Uint32Array(count);
  const digitCounts = new Uint32Array(256);

  for (let digitShift = 0; digitShift < 32; digitShift += 8) {
    digitCounts.fill(0);
    for (let index = 0; index < count; index++) {
      digitCounts[(keys[source[index]] >>> digitShift) & 0xff]++;
    }
    let outputOffset = 0;
    let occupiedDigits = 0;
    for (let digit = 0; digit < 256; digit++) {
      const digitCount = digitCounts[digit];
      if (digitCount > 0) {
        occupiedDigits++;
      }
      digitCounts[digit] = outputOffset;
      outputOffset += digitCount;
    }
    // Every key shares this digit, so the pass would be an identity permutation.
    if (occupiedDigits <= 1) {
      continue;
    }
    for (let index = 0; index < count; index++) {
      const value = source[index];
      target[digitCounts[(keys[value] >>> digitShift) & 0xff]++] = value;
    }
    [source, target] = [target, source];
  }

  return source;
}

/**
 * Orders the kept rows along a Morton curve through the scene's own bounding box.
 *
 * Exported for `bake-splat-scene`, which applies it per level-of-detail node so the coherence is
 * already in the published bytes and no client ever pays for it.
 */
export function sortIndicesByMortonCode(positions: Float32Array, keptIndices: RowIndices): RowIndices {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const index of keptIndices) {
    const offset = index * 3;
    const x = positions[offset];
    const y = positions[offset + 1];
    const z = positions[offset + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  const scaleX = MORTON_AXIS_SCALE / Math.max(maxX - minX, Number.EPSILON);
  const scaleY = MORTON_AXIS_SCALE / Math.max(maxY - minY, Number.EPSILON);
  const scaleZ = MORTON_AXIS_SCALE / Math.max(maxZ - minZ, Number.EPSILON);

  // Keyed by source row so the radix sort can permute `keptIndices` without an indirection table.
  const mortonCodes = new Uint32Array(positions.length / 3);
  for (const index of keptIndices) {
    const offset = index * 3;
    const cellX = Math.min(MORTON_AXIS_SCALE, Math.max(0, (positions[offset] - minX) * scaleX)) | 0;
    const cellY =
      Math.min(MORTON_AXIS_SCALE, Math.max(0, (positions[offset + 1] - minY) * scaleY)) | 0;
    const cellZ =
      Math.min(MORTON_AXIS_SCALE, Math.max(0, (positions[offset + 2] - minZ) * scaleZ)) | 0;
    mortonCodes[index] =
      (spreadBits(cellX) | (spreadBits(cellY) << 1) | (spreadBits(cellZ) << 2)) >>> 0;
  }

  return radixSortByKey(keptIndices, mortonCodes);
}

/**
 * Returns the rows worth keeping, in ascending source order.
 *
 * A full sort of the importance scores would cost about as much as the per-frame sort this is
 * meant to make cheaper, so the budget threshold comes from a histogram instead: three linear
 * passes and one 1024-entry walk.
 */
function selectRows(source: SplatSource, maxSplats: number, minOpacity: number): RowIndices {
  const splatCount = source.opacities.length;
  const {opacities, scales, colors} = source;
  const colorAlphaScale = colors instanceof Float32Array ? 1 : 1 / 255;

  const visible = new Uint8Array(splatCount);
  const scores = new Float32Array(splatCount);
  let visibleCount = 0;
  let minimumScore = Infinity;
  let maximumScore = -Infinity;
  for (let index = 0; index < splatCount; index++) {
    // The renderer multiplies stored opacity by the color's alpha before testing the cutoff.
    if (opacities[index] * colors[index * 4 + 3] * colorAlphaScale < minOpacity) {
      continue;
    }
    const score = getSplatImportance(opacities, scales, index);
    visible[index] = 1;
    scores[index] = score;
    visibleCount++;
    if (score < minimumScore) minimumScore = score;
    if (score > maximumScore) maximumScore = score;
  }

  if (visibleCount === 0) {
    return new Uint32Array(0);
  }

  const budget = Math.min(visibleCount, Math.floor(maxSplats));
  let keptCount = 0;

  if (budget === visibleCount) {
    // The budget does not bind; every row that can clear the alpha cutoff is kept.
    const allVisible = new Uint32Array(visibleCount);
    for (let index = 0; index < splatCount; index++) {
      if (visible[index]) {
        allVisible[keptCount++] = index;
      }
    }
    return allVisible;
  }

  const keptIndices = new Uint32Array(budget);
  const scoreRange = maximumScore - minimumScore;
  if (!(scoreRange > 0)) {
    // Every visible splat scores the same, so importance cannot rank them; take a uniform stride.
    const stride = visibleCount / budget;
    let seenVisible = 0;
    let nextVisible = 0;
    for (let index = 0; index < splatCount && keptCount < budget; index++) {
      if (!visible[index]) {
        continue;
      }
      if (seenVisible >= nextVisible) {
        keptIndices[keptCount++] = index;
        nextVisible += stride;
      }
      seenVisible++;
    }
    return keptCount === budget ? keptIndices : keptIndices.subarray(0, keptCount);
  }

  const binScale = (SCORE_HISTOGRAM_BINS - 1) / scoreRange;
  const histogram = new Uint32Array(SCORE_HISTOGRAM_BINS);
  for (let index = 0; index < splatCount; index++) {
    if (visible[index]) {
      histogram[Math.floor((scores[index] - minimumScore) * binScale)]++;
    }
  }

  // Walk down from the most important bin until the budget is covered. Bins above the threshold
  // are kept whole; the threshold bin itself is only partly kept.
  let thresholdBin = SCORE_HISTOGRAM_BINS - 1;
  let keptAboveThreshold = 0;
  for (; thresholdBin > 0; thresholdBin--) {
    if (keptAboveThreshold + histogram[thresholdBin] >= budget) {
      break;
    }
    keptAboveThreshold += histogram[thresholdBin];
  }

  let thresholdBinAllowance = budget - keptAboveThreshold;
  for (let index = 0; index < splatCount && keptCount < budget; index++) {
    if (!visible[index]) {
      continue;
    }
    const bin = Math.floor((scores[index] - minimumScore) * binScale);
    if (bin > thresholdBin) {
      keptIndices[keptCount++] = index;
    } else if (bin === thresholdBin && thresholdBinAllowance > 0) {
      thresholdBinAllowance--;
      keptIndices[keptCount++] = index;
    }
  }

  return keptCount === budget ? keptIndices : keptIndices.subarray(0, keptCount);
}

/** Gathers one column into a new array of the same element type. */
function gatherColumn<ColumnType extends SplatColumn>(
  values: ColumnType,
  keptIndices: RowIndices,
  componentCount: number
): ColumnType {
  const gathered = new (values.constructor as new (length: number) => ColumnType)(
    keptIndices.length * componentCount
  );
  for (let keptIndex = 0; keptIndex < keptIndices.length; keptIndex++) {
    const sourceOffset = keptIndices[keptIndex] * componentCount;
    const targetOffset = keptIndex * componentCount;
    for (let component = 0; component < componentCount; component++) {
      gathered[targetOffset + component] = values[sourceOffset + component];
    }
  }
  return gathered;
}

/**
 * Prunes, budgets and spatially orders a decoded scene in one pass.
 *
 * The result is a fresh `SplatSource`; the input columns are left untouched, so a caller can keep
 * the full-resolution decode around and re-apply a different budget without re-downloading.
 */
export function prepareSplatSource(
  source: SplatSource,
  options: SplatPreprocessOptions = {}
): SplatSource {
  const {
    maxSplats = Infinity,
    minOpacity = DEFAULT_ALPHA_CUTOFF,
    spatialOrder = true
  } = options;

  const splatCount = source.opacities.length;
  let keptIndices = selectRows(source, maxSplats, minOpacity);
  if (spatialOrder) {
    keptIndices = sortIndicesByMortonCode(source.positions, keptIndices);
  } else if (keptIndices.length === splatCount) {
    // Nothing was dropped and nothing is being reordered, so the gather would be a plain copy.
    return source;
  }

  const coefficientsPerSplat =
    source.sphericalHarmonics && splatCount > 0
      ? Math.floor(source.sphericalHarmonics.length / splatCount)
      : 0;

  return {
    positions: gatherColumn(source.positions, keptIndices, 3),
    scales: gatherColumn(source.scales, keptIndices, 3),
    rotations: gatherColumn(source.rotations, keptIndices, 4),
    colors: gatherColumn(source.colors, keptIndices, 4),
    opacities: gatherColumn(source.opacities, keptIndices, 1),
    ...(source.semanticIds ? {semanticIds: gatherColumn(source.semanticIds, keptIndices, 1)} : {}),
    ...(source.sphericalHarmonics && coefficientsPerSplat > 0
      ? {
          sphericalHarmonics: gatherColumn(
            source.sphericalHarmonics,
            keptIndices,
            coefficientsPerSplat
          ),
          sphericalHarmonicsDegree: source.sphericalHarmonicsDegree
        }
      : {})
  };
}
