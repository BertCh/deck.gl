// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * One block of an elevation raster plus the same block of an imagery raster in; one tile's worth of
 * oriented Gaussians out.
 *
 * This is the whole of the "preprocessing pipeline", and it is deliberately the *only* copy of it:
 * `scripts/bake-terrain-splats.ts` runs it in Node to publish an archive, and
 * `terrain-tile.worker.ts` runs it in the browser while the camera is moving. A bake and a live
 * stream that disagreed about what a splat is would make the two halves of this example
 * incomparable, which is the one thing it exists to let you do.
 *
 * ## What it is doing, per splat
 *
 * ```text
 *   position = elevation pixel centre, in scene metres, at its own height
 *   normal   = central difference of the elevation across the sample spacing
 *   rotation = the basis (downhill, across-slope, normal), as a quaternion
 *   scale    = the sample spacing corrected for slope, in plane; a fraction of it across
 *   colour   = the imagery, with a fixed relief light mixed in
 * ```
 *
 * That is: terrain becomes **oriented surfels**, which is the same primitive a trained 3D Gaussian
 * converges to. Nothing about the renderer changes between a reconstruction and this; the only
 * thing that changed is where the five columns came from.
 *
 * ## The frame
 *
 * Scene units are metres in a local east / north / up frame pinned at `origin`, which is what
 * `SplatLayer` with `georeferenced: true` and `upAxis: 'z-up'` places one to one. Positions are
 * Web Mercator offsets from the origin divided by the scale factor *there*, so the conversion the
 * layer's model matrix performs is exactly the one undone here. Mercator is conformal, so one
 * scale factor is right in both axes and the residual is an isotropic size drift of
 * `cos(originLat) / cos(lat)` with no shear - about 0.6% forty kilometres north of the origin at
 * Alpine latitudes. Scaling degrees of longitude by a fixed `cos(lat0)` instead, which is the
 * obvious thing, gets north exactly right and shears east, and shear reads as a leaning mountain
 * where a size error does not.
 *
 * Tiles are cut from the same plane, so a tile seam is exact: two neighbours compute the same
 * pixel centre to the same metre, and nothing has to be stitched.
 */

import {
  BAKE_TILING,
  decodeTerrarium,
  getElevationBlock,
  getImageryBlock,
  getSplatSpacing,
  projectFlat,
  tileXToLongitude,
  tileYToLatitude,
  unitsPerMeter,
  type TerrainTiling,
  type TileAddress
} from './scripts/terrain-grid.ts';

/** A decoded raster, in whatever interleaving the decoder produced. */
export type TerrainRaster = {
  width: number;
  height: number;
  /** Bytes per pixel: 3 for RGB, 4 for RGBA. */
  channels: number;
  data: Uint8Array | Uint8ClampedArray;
};

/**
 * Distance haze, baked into the colours rather than evaluated per frame.
 *
 * Measured from the scene **origin**, not from the camera, which is only legitimate because the
 * scene is looked at from an orbit about that origin - and is what makes haze cost nothing at all.
 * The payoff is not prettiness: without it the residency frontier ends in a cliff edge with the
 * background behind it, and with it the far field simply stops being there. `color` must match
 * whatever the canvas clears to; changing one without the other puts the horizon back.
 */
export type TerrainHaze = {
  /** Display-space RGB in `[0, 1]`, matching the canvas background. */
  color: readonly [number, number, number];
  /** Distance at which the haze reaches `1 - 1/e` of full strength, in metres. */
  rangeMeters: number;
};

export type TerrainSurfelOptions = {
  /** Where the scene's metres are measured from. */
  origin: {longitude: number; latitude: number};
  /** In-plane one-sigma extent as a fraction of the sample spacing. */
  sigma: number;
  /** Out-of-plane extent as a fraction of the in-plane one. */
  thickness: number;
  /** How much of the shading is the relief light rather than the imagery's own. */
  relief: number;
  /** Metres each splat is pushed along its normal, to clear a mesh drawn underneath it. */
  lift: number;
  /** Direction the relief light comes from, as a unit vector in east / north / up. */
  sun: readonly [number, number, number];
  /** Colour used where imagery failed to load, as display-space RGB in `[0, 255]`. */
  missingImageryRgb: readonly [number, number, number];
  haze?: TerrainHaze | null;
  /** How the node is cut out of the two rasters. Defaults to the baker's. */
  tiling?: TerrainTiling;
  /**
   * How the colour column is stored. Defaults to `'float32'`, which is what the archive publishes.
   *
   * **Prefer `'uint8'` for anything drawn live.** These colours are display-referred - the same
   * space a PLY's DC term is in, and the space the renderer blends in - so eight bits a channel is
   * all they carry. Storing them as `float32x4` is not merely four times the bytes: luma.gl reads a
   * float colour column as *linear radiance* and, on a device without an extended-range swap chain,
   * silently turns on Reinhard tone mapping for the whole scene. That maps 1.0 to 0.5, so a terrain
   * scene comes out at half brightness with its midtones crushed, for no reason other than the
   * column's type.
   */
  colorFormat?: 'float32' | 'uint8';
};

export type TerrainSurfelColumns = {
  /** Scene-metre XYZ, interleaved. */
  positions: Float32Array;
  /** One-sigma XYZ, interleaved: in-plane, in-plane, thickness. */
  scales: Float32Array;
  /** `[w, x, y, z]`, interleaved - luma.gl's order. */
  rotations: Float32Array;
  /**
   * Display-space RGBA, interleaved, relief-shaded and hazed.
   *
   * `Float32Array` in `[0, 1]`, or `Uint8Array` in `[0, 255]`. See `colorFormat`.
   */
  colors: Float32Array | Uint8Array;
  opacities: Float32Array;
  /** Ground metres between neighbouring splats in this tile. */
  spacing: number;
  /** `[minEast, minNorth, minUp, maxEast, maxNorth, maxUp]`, for culling and level of detail. */
  bounds: [number, number, number, number, number, number];
  /** Splats whose slope correction hit {@link MAXIMUM_SLOPE_STRETCH}. Never silent. */
  clampedSlopeCount: number;
};

/**
 * Cap on how much a steep face grows its splats.
 *
 * 3 is a 71 degree face. Past that the discs would be metres long and the cliff would read as a
 * smear, so beyond it the surface is allowed to go slightly open - which on a vertical wall the
 * camera is looking along the face of is invisible, and is the right way to lose the argument.
 */
export const MAXIMUM_SLOPE_STRETCH = 3;

/**
 * The numbers that decide what a terrain splat *is*, shared by the bake and the live stream.
 *
 * Both paths call {@link buildTerrainSurfels}, and both take their options from here. A bake and a
 * live stream that disagreed about any of these would make `Lauterbrunnen terrain` and
 * `Lauterbrunnen, live` two different pictures, which is the one comparison this example exists to
 * let you make.
 */
export const TERRAIN_SURFEL_DEFAULTS = {
  /**
   * In-plane extent of a splat as a fraction of the distance to its neighbour.
   *
   * A Gaussian's alpha falls as `exp(-d^2 / 2 sigma^2)`, so at `sigma = spacing / 2` a splat is at
   * 61% opacity where its neighbour's centre sits. That overlap is what makes a grid of discs read
   * as a continuous surface instead of a bed of nails; much below it the grid shows through, and
   * much above it the terrain turns to soup.
   *
   * 0.55 rather than a clean half. At exactly 0.5 the sample lattice is still faintly legible on
   * open ground under grazing light, and closing it costs nothing that matters: a splat's extent is
   * three floats in a column, not another splat.
   */
  sigma: 0.55,

  /**
   * Thickness along the surface normal, as a fraction of the in-plane extent.
   *
   * A terrain sample is a patch of surface and has no thickness at all, but a 3D Gaussian with a
   * zero extent is degenerate: seen edge-on it projects to a sliver. On a rough height field at a
   * grazing angle that is not a rounding error, it is the whole picture. Every microfacet tilted
   * away from the camera collapses while the ones tilted towards it stay full, and a hillside
   * eight kilometres out combs into light and dark streaks that crawl as the camera turns.
   *
   * **0.45, measured.** Sweeping the Matterhorn scene at 82 degrees of pitch: 0.12 combs badly,
   * 0.25 is much better but still visible, 0.35 leaves faint traces, and by 0.45 the streaking is
   * gone. 0.7 looks the same as 0.45, so there is nothing above the knee worth paying for - and
   * the cost of going higher is real, because the extent is perpendicular to the surface and
   * eventually reads as a slab rather than ground.
   *
   * Confirming what it is *not*: the same sweep with `relief` at 0 is unchanged, so this is
   * coverage and not shading; and a 4x supersampled render still shows it, so it is geometry and
   * not screen-space aliasing. It is the three-dimensional counterpart of Mip-Splatting's 3D
   * smoothing filter - a floor on how small a Gaussian's smallest axis may be - expressed as a
   * fraction because the level-of-detail spacing spans six octaves.
   *
   * Measured against the *stretched* in-plane extent below, not the nominal one, so a splat keeps
   * the same proportions however steep the ground under it is. Scaling one axis of a covariance
   * while holding another fixed is how an ellipsoid turns into a needle, and a needle is what a
   * cliff full of them looks like.
   */
  thickness: 0.45,

  /**
   * How far each splat is lifted along the surface normal, in metres.
   *
   * The splats and the `TerrainLayer` mesh are derived from the same elevation data, but not at the
   * same resolution: the mesh is simplified to `meshMaxError` and built from a deeper zoom, so the
   * two surfaces disagree by a few metres on steep ground. Drawn coincident, roughly half of each
   * splat would land behind the mesh and be depth-tested away, which reads as tearing.
   *
   * Lifting along the normal rather than straight up keeps the offset perpendicular on a cliff,
   * where a vertical lift would slide the surface sideways instead. At the distances this is viewed
   * from it is invisible; what it buys is that the mesh still occludes splats behind a ridge while
   * never fighting the ones in front of it.
   */
  lift: 3,

  /**
   * How much of a splat's brightness is the relief term rather than the orthophoto's own.
   *
   * Small on purpose. The imagery is the data and the shading is an annotation on it: at 0.32 a
   * slope facing the sun is about 30% brighter than one facing away, which is enough for a ridge to
   * read as a ridge and not enough to turn the photograph into a hillshade. Raise it and the
   * terrain starts to look like a relief map with a picture on it; drop it to 0 and you get what
   * this example baked before - geometry you cannot see.
   */
  relief: 0.32,

  /**
   * Direction the relief shading comes from: north-west, about 50 degrees up, in the east/north/up
   * frame the splats are built in.
   *
   * The cartographic convention, and deliberately *not* an attempt to recover the sun SWISSIMAGE
   * was flown under. That mosaic is stitched from passes taken months apart and has no single sun,
   * which is the whole problem this term exists to solve.
   */
  sun: ((): readonly [number, number, number] => {
    const vector: [number, number, number] = [-0.48, 0.42, 0.77];
    const length = Math.hypot(...vector);
    return [vector[0] / length, vector[1] / length, vector[2] / length];
  })(),

  /**
   * Colour used where imagery is missing.
   *
   * A light grey rather than the mesh's unlit `[56, 60, 66]`, because these splats are shaded and
   * that one is not: multiplied by the relief term, anything darker collapses into the background
   * and the bare patch reads as a hole rather than as ground without a photograph on it.
   */
  missingImageryRgb: [150, 152, 156] as readonly [number, number, number]
} as const;

/**
 * Builds one tile's columns.
 *
 * Neither raster is resampled: `tiling` guarantees exactly one elevation pixel and one imagery pixel
 * per splat. See `TerrainTiling`.
 *
 * `elevation` decides whether there is a tile at all. `imagery` is allowed to be `null` on its own,
 * and the terrain comes out grey where it is - a demo that loses its imagery host should show grey
 * mountains, not a hole where the terrain was.
 */
export function buildTerrainSurfels(
  tile: TileAddress,
  elevation: TerrainRaster,
  imagery: TerrainRaster | null,
  options: TerrainSurfelOptions
): TerrainSurfelColumns {
  const tiling = options.tiling ?? BAKE_TILING;
  const {gridSize} = tiling;
  const elevationBlock = getElevationBlock(tile, tiling);
  const imageryBlock = getImageryBlock(tile, tiling);

  const splatCount = gridSize * gridSize;
  const positions = new Float32Array(splatCount * 3);
  const scales = new Float32Array(splatCount * 3);
  const rotations = new Float32Array(splatCount * 4);
  const isUint8Color = options.colorFormat === 'uint8';
  const colors = isUint8Color ? new Uint8Array(splatCount * 4) : new Float32Array(splatCount * 4);
  const colorScale = isUint8Color ? 255 : 1;
  const opacities = new Float32Array(splatCount).fill(1);

  const centerLatitude = tileYToLatitude(tile.y + 0.5, tile.z);
  const spacing = getSplatSpacing(tile.z, centerLatitude, gridSize);

  const originUnitsPerMeter = unitsPerMeter(options.origin.latitude);
  const [originX, originY] = projectFlat(options.origin.longitude, options.origin.latitude);

  const {sun, haze, missingImageryRgb} = options;
  const ambient = 1 - options.relief;
  const hazeRangeSquared = haze ? haze.rangeMeters * haze.rangeMeters : 0;

  let clampedSlopeCount = 0;
  let minEast = Infinity;
  let minNorth = Infinity;
  let minUp = Infinity;
  let maxEast = -Infinity;
  let maxNorth = -Infinity;
  let maxUp = -Infinity;

  /** Elevation at a pixel of the source tile, clamped at its edges. */
  const sampleElevation = (pixelX: number, pixelY: number): number => {
    const x = Math.min(elevation.width - 1, Math.max(0, pixelX));
    const y = Math.min(elevation.height - 1, Math.max(0, pixelY));
    const offset = (y * elevation.width + x) * elevation.channels;
    return decodeTerrarium(
      elevation.data[offset],
      elevation.data[offset + 1],
      elevation.data[offset + 2]
    );
  };

  for (let row = 0; row < gridSize; row++) {
    for (let column = 0; column < gridSize; column++) {
      const index = row * gridSize + column;

      const sourceX = elevationBlock.offsetX + column;
      const sourceY = elevationBlock.offsetY + row;
      const height = sampleElevation(sourceX, sourceY);

      // Central differences ACROSS THE SAMPLE SPACING, not across anything finer: the normal has to
      // describe the surface this splat covers, and a normal fitted an order of magnitude finer than
      // the disc it orients makes a hillside sparkle. The neighbours are read out of the whole
      // source raster, so a tile edge is not an edge here; only the source's own border clamps,
      // which leaves a one-splat ring with a one-sided normal - invisible under discs that overlap
      // their neighbours by design. Elevation increases downward in tile space, so the north
      // derivative is negated to put it back in an east / north / up frame.
      const eastSlope =
        (sampleElevation(sourceX + 1, sourceY) - sampleElevation(sourceX - 1, sourceY)) /
        (2 * spacing);
      const northSlope =
        -(sampleElevation(sourceX, sourceY + 1) - sampleElevation(sourceX, sourceY - 1)) /
        (2 * spacing);

      const normalLength = Math.hypot(eastSlope, northSlope, 1);
      const normal: [number, number, number] = [
        -eastSlope / normalLength,
        -northSlope / normalLength,
        1 / normalLength
      ];
      // `normal[2]` is cos(slope): 1 on the flat, approaching 0 on a cliff.
      const cosineSlope = Math.max(normal[2], 1e-3);

      const gradientLength = Math.hypot(eastSlope, northSlope);
      // On genuinely flat ground the gradient has no direction; east will do, and the two in-plane
      // extents are equal there anyway.
      const uphill: [number, number] =
        gradientLength > 1e-9 ? [eastSlope / gradientLength, northSlope / gradientLength] : [1, 0];

      // The splat's own axes. Walking one metre of plan distance up the gradient climbs
      // `gradientLength` metres, so the tangent is `(uphill, gradientLength)` normalized - and its
      // length is exactly `normalLength`, which makes `cosineSlope` the normalizing factor. Across
      // the gradient nothing climbs at all, so that axis is horizontal by construction. The three
      // are orthonormal and right-handed as written: `alongSlope x acrossSlope == normal`.
      const alongSlope: [number, number, number] = [
        uphill[0] * cosineSlope,
        uphill[1] * cosineSlope,
        gradientLength * cosineSlope
      ];
      const acrossSlope: [number, number, number] = [-uphill[1], uphill[0], 0];

      setQuaternionFromBasis(rotations, index * 4, alongSlope, acrossSlope, normal);

      const longitude = tileXToLongitude(tile.x + (column + 0.5) / gridSize, tile.z);
      const latitude = tileYToLatitude(tile.y + (row + 0.5) / gridSize, tile.z);
      const [commonX, commonY] = projectFlat(longitude, latitude);

      // The splat sits at its sample pixel's CENTRE. Every tile cut from the same plane samples the
      // same lattice, so the seam between two tiles is one ordinary sample interval - never a
      // doubled row, never a gap.
      const east = (commonX - originX) / originUnitsPerMeter + normal[0] * options.lift;
      // Common-space y increases southward; scene north is +y, so the sign flips here.
      const north = -(commonY - originY) / originUnitsPerMeter + normal[1] * options.lift;
      // The anchor sits at 0 m, so scene z is the elevation itself. Nothing has to know the ground
      // height at the origin, and the layer places the anchor at exactly `z = 0`.
      const up = height + normal[2] * options.lift;

      positions[index * 3] = east;
      positions[index * 3 + 1] = north;
      positions[index * 3 + 2] = up;

      if (east < minEast) minEast = east;
      if (east > maxEast) maxEast = east;
      if (north < minNorth) minNorth = north;
      if (north > maxNorth) maxNorth = north;
      if (up < minUp) minUp = up;
      if (up > maxUp) maxUp = up;

      // A cell one sample wide in plan is `1 / cos(slope)` longer measured along the hillside, up to
      // the point where that stops being a measurement - see MAXIMUM_SLOPE_STRETCH. Sizing the disc
      // from the horizontal spacing instead is why naive heightfield splatting tears open on
      // cliffs: the steeper the face, the further apart the samples really are.
      //
      // Applied to BOTH in-plane axes rather than the downhill one alone. Across the gradient
      // nothing climbs, so the across-slope neighbours really are `spacing` apart and growing that
      // axis is, strictly, wrong. It is also what makes a hillside look like one: an ellipse
      // stretched on a single axis points its long side down the fall line everywhere at once, and
      // a field of them combs the slope into streaks that track the camera. Growing both keeps a
      // disc a disc; the price is some extra overlap along the contour, which is the direction a
      // height field has the least to say about in the first place.
      const slopeStretch = Math.min(1 / cosineSlope, MAXIMUM_SLOPE_STRETCH);
      if (slopeStretch >= MAXIMUM_SLOPE_STRETCH) {
        clampedSlopeCount++;
      }
      const stretched = spacing * options.sigma * slopeStretch;
      scales[index * 3] = stretched;
      scales[index * 3 + 1] = stretched;
      // Across the normal. A surfel has no third extent and a 3D Gaussian needs one, so this is an
      // assumption, declared here: thin enough to be a surface, thick enough not to vanish edge-on.
      scales[index * 3 + 2] = stretched * options.thickness;

      let red = missingImageryRgb[0];
      let green = missingImageryRgb[1];
      let blue = missingImageryRgb[2];
      if (imagery) {
        const imageryX = Math.min(imagery.width - 1, imageryBlock.offsetX + column);
        const imageryY = Math.min(imagery.height - 1, imageryBlock.offsetY + row);
        const offset = (imageryY * imagery.width + imageryX) * imagery.channels;
        red = imagery.data[offset];
        green = imagery.data[offset + 1];
        blue = imagery.data[offset + 2];
      }

      // Relief, mixed into the photograph rather than replacing it.
      //
      // This is the one thing the orthophoto cannot supply and the elevation can. The normal is
      // already sitting here from the rotation above, so the shading is a dot product and a lerp -
      // and it is baked rather than evaluated per frame because the DC term of a Gaussian is
      // exactly the right place to put a light that never moves.
      const lambert = Math.max(normal[0] * sun[0] + normal[1] * sun[1] + normal[2] * sun[2], 0);
      const shade = ambient + options.relief * lambert;

      // Stored the way the PLY decoder stores its DC term: the colour as displayed, not linearized,
      // because that is the space 3D Gaussian Splatting is trained and rendered in.
      let r = (red / 255) * shade;
      let g = (green / 255) * shade;
      let b = (blue / 255) * shade;

      if (haze) {
        const fog = 1 - Math.exp(-(east * east + north * north) / hazeRangeSquared);
        r += (haze.color[0] - r) * fog;
        g += (haze.color[1] - g) * fog;
        b += (haze.color[2] - b) * fog;
      }

      // A `Uint8Array` write truncates, so the rounding is explicit rather than a bias of half a
      // level toward black across the whole scene.
      colors[index * 4] = isUint8Color ? Math.round(r * 255) : r;
      colors[index * 4 + 1] = isUint8Color ? Math.round(g * 255) : g;
      colors[index * 4 + 2] = isUint8Color ? Math.round(b * 255) : b;
      colors[index * 4 + 3] = colorScale;
    }
  }

  return {
    positions,
    scales,
    rotations,
    colors,
    opacities,
    spacing,
    bounds: [minEast, minNorth, minUp, maxEast, maxNorth, maxUp],
    clampedSlopeCount
  };
}

/**
 * Writes the quaternion for the rotation whose axes are the three supplied unit vectors.
 *
 * Shepperd's method: pick the branch whose divisor is largest so the square root never lands on a
 * near-zero denominator. luma.gl reads `(w, x, y, z)`.
 */
export function setQuaternionFromBasis(
  out: Float32Array,
  offset: number,
  xAxis: readonly [number, number, number],
  yAxis: readonly [number, number, number],
  zAxis: readonly [number, number, number]
): void {
  const m00 = xAxis[0];
  const m10 = xAxis[1];
  const m20 = xAxis[2];
  const m01 = yAxis[0];
  const m11 = yAxis[1];
  const m21 = yAxis[2];
  const m02 = zAxis[0];
  const m12 = zAxis[1];
  const m22 = zAxis[2];

  const trace = m00 + m11 + m22;
  let w: number;
  let x: number;
  let y: number;
  let z: number;

  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s;
    x = (m12 - m21) / s;
    y = (m20 - m02) / s;
    z = (m01 - m10) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m12 - m21) / s;
    x = 0.25 * s;
    y = (m10 + m01) / s;
    z = (m20 + m02) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m20 - m02) / s;
    x = (m10 + m01) / s;
    y = 0.25 * s;
    z = (m21 + m12) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m01 - m10) / s;
    x = (m20 + m02) / s;
    y = (m21 + m12) / s;
    z = 0.25 * s;
  }

  const length = Math.hypot(w, x, y, z) || 1;
  out[offset] = w / length;
  out[offset + 1] = x / length;
  out[offset + 2] = y / length;
  out[offset + 3] = z / length;
}
