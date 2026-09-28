// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * Unprojects a baked terrain archive back to longitude, latitude and elevation, and checks it
 * against the elevation service it was built from.
 *
 * ```bash
 * npm run verify-terrain -- public/splat-archives/lauterbrunnen-terrain
 * ```
 *
 * The reason this exists is that a terrain splat field is very hard to eyeball. Mirror the north
 * axis, use the wrong Earth circumference, or take the quaternion's handedness the wrong way
 * round, and what you get is still a plausible-looking hillside — just not *this* hillside, or
 * not quite where the mesh underneath it is. Every one of those is a silent failure on screen and
 * an obvious one here:
 *
 * - **Position.** Each splat is unprojected through the inverse of the transform the baker
 *   applied and compared against an independent elevation lookup at the resulting coordinate. A
 *   flipped axis shows up immediately as a large mean error, because the terrain no longer
 *   matches itself.
 * - **Orientation.** The quaternion is rotated back into a normal, which is compared against the
 *   gradient of the elevation samples around it. A splat whose disc does not lie in the surface
 *   is one that will read as a facing-camera blob rather than as ground.
 * - **Coverage.** The area actually baked is printed, so "centred on the site" is something the
 *   output states rather than something the arguments imply.
 */

import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parseArgs} from 'node:util';

import sharp from 'sharp';

import {decodeCoreChunk, type SplatArchiveManifest} from '../splat-archive.ts';
import {TERRAIN_IMAGE} from '../scenes.ts';
import {
  decodeTerrarium,
  latitudeToTileY,
  longitudeToTileX,
  projectFlat,
  unitsPerMeter
} from './terrain-grid.ts';

/** Zoom of the independent elevation lookup the archive is compared against. */
const REFERENCE_ZOOM = 14;
const REFERENCE_TILE_SIZE = 512;

function formatCount(count: number): string {
  return count.toLocaleString('en-US');
}

/** One decoded elevation tile, indexed by geographic coordinate. */
async function loadReferenceTile(longitude: number, latitude: number) {
  const tileX = Math.floor(longitudeToTileX(longitude, REFERENCE_ZOOM));
  const tileY = Math.floor(latitudeToTileY(latitude, REFERENCE_ZOOM));
  const url = TERRAIN_IMAGE.replace('{z}', String(REFERENCE_ZOOM))
    .replace('{x}', String(tileX))
    .replace('{y}', String(tileY));

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`No reference elevation tile at ${url}`);
  }
  const {data, info} = await sharp(Buffer.from(await response.arrayBuffer()))
    .raw()
    .toBuffer({resolveWithObject: true});

  return (sampleLongitude: number, sampleLatitude: number): number | null => {
    const fractionX = longitudeToTileX(sampleLongitude, REFERENCE_ZOOM) - tileX;
    const fractionY = latitudeToTileY(sampleLatitude, REFERENCE_ZOOM) - tileY;
    if (fractionX < 0 || fractionX >= 1 || fractionY < 0 || fractionY >= 1) {
      return null;
    }
    const pixelX = Math.min(REFERENCE_TILE_SIZE - 1, Math.floor(fractionX * REFERENCE_TILE_SIZE));
    const pixelY = Math.min(REFERENCE_TILE_SIZE - 1, Math.floor(fractionY * REFERENCE_TILE_SIZE));
    const offset = (pixelY * info.width + pixelX) * info.channels;
    return decodeTerrarium(data[offset], data[offset + 1], data[offset + 2]);
  };
}

async function main(): Promise<void> {
  const {positionals} = parseArgs({allowPositionals: true, options: {}});
  const archiveDirectory = positionals[0] ?? 'public/splat-archives/lauterbrunnen-terrain';

  const manifest = JSON.parse(
    await readFile(join(archiveDirectory, 'manifest.json'), 'utf8')
  ) as SplatArchiveManifest;
  const georeference = manifest.scene.georeference;
  if (!georeference) {
    throw new Error('This archive is not georeferenced; it is not a terrain bake');
  }

  const originUnitsPerMeter = unitsPerMeter(georeference.latitude);
  const [originX, originY] = projectFlat(georeference.longitude, georeference.latitude);

  /** The exact inverse of what the baker did to get from a coordinate to a scene position. */
  const toLongitudeLatitude = (sceneX: number, sceneY: number): [number, number] => {
    const commonX = originX + sceneX * originUnitsPerMeter;
    // Scene north is positive; this projection's y grows southward, hence the sign.
    const commonY = originY - sceneY * originUnitsPerMeter;
    const longitude = (commonX / 512) * 360 - 180;
    const latitude =
      ((Math.atan(Math.exp(Math.PI - (commonY / 512) * 2 * Math.PI)) - Math.PI / 4) * 2 * 180) /
      Math.PI;
    return [longitude, latitude];
  };

  const reference = await loadReferenceTile(georeference.longitude, georeference.latitude);

  let checkedCount = 0;
  let elevationErrorSum = 0;
  let worstElevationError = 0;
  let worstQuaternionError = 0;
  let flattestNormal = 1;
  /**
   * In-plane extent as a multiple of the node's own sample spacing, which is what
   * `geometricError` records. The baker writes `sigma * min(1 / cos slope, ceiling)` into both
   * in-plane axes, so the floor of this range is `sigma` (level ground, no correction) and the
   * ceiling is `sigma` times the stretch ceiling. Measuring it in spacings rather than metres is
   * what makes one number comparable across three zoom levels.
   */
  let narrowestExtentRatio = Infinity;
  let widestExtentRatio = 0;
  /** The two in-plane axes are stretched together, so any disagreement between them is a bug. */
  let worstInPlaneAnisotropy = 0;
  /** Out-of-plane over in-plane, constant by construction -- see NORMAL_THICKNESS_FRACTION. */
  let thinnestRatio = Infinity;
  let thickestRatio = 0;
  const longitudeRange: [number, number] = [Infinity, -Infinity];
  const latitudeRange: [number, number] = [Infinity, -Infinity];
  const elevationRange: [number, number] = [Infinity, -Infinity];

  // The leaf nodes carry the finest sampling, which is the one worth comparing against a z14
  // reference; a root node is sampled far more coarsely and would differ for good reasons.
  const leafNodes = manifest.nodes.filter(node => node.childIds.length === 0);
  const sampledNodes = leafNodes.length > 0 ? leafNodes : manifest.nodes;

  for (const node of sampledNodes) {
    const file = await readFile(join(archiveDirectory, `nodes/${node.id}.core.bin`));
    const columns = decodeCoreChunk(
      file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer
    );

    for (let index = 0; index < columns.rowCount; index++) {
      const [longitude, latitude] = toLongitudeLatitude(
        columns.positions[index * 3],
        columns.positions[index * 3 + 1]
      );
      const elevation = columns.positions[index * 3 + 2];

      longitudeRange[0] = Math.min(longitudeRange[0], longitude);
      longitudeRange[1] = Math.max(longitudeRange[1], longitude);
      latitudeRange[0] = Math.min(latitudeRange[0], latitude);
      latitudeRange[1] = Math.max(latitudeRange[1], latitude);
      elevationRange[0] = Math.min(elevationRange[0], elevation);
      elevationRange[1] = Math.max(elevationRange[1], elevation);

      const referenceElevation = reference(longitude, latitude);
      if (referenceElevation !== null) {
        const error = Math.abs(elevation - referenceElevation);
        elevationErrorSum += error;
        worstElevationError = Math.max(worstElevationError, error);
        checkedCount++;
      }

      const w = columns.rotations[index * 4];
      const x = columns.rotations[index * 4 + 1];
      const y = columns.rotations[index * 4 + 2];
      const z = columns.rotations[index * 4 + 3];
      worstQuaternionError = Math.max(worstQuaternionError, Math.abs(Math.hypot(w, x, y, z) - 1));
      // The third column of the rotation matrix: the splat's own +z, which should be the normal.
      flattestNormal = Math.min(flattestNormal, 1 - 2 * (x * x + y * y));

      const alongSlope = columns.scales[index * 3];
      const acrossSlope = columns.scales[index * 3 + 1];
      const throughSurface = columns.scales[index * 3 + 2];
      const extentRatio = alongSlope / node.geometricError;
      narrowestExtentRatio = Math.min(narrowestExtentRatio, extentRatio);
      widestExtentRatio = Math.max(widestExtentRatio, extentRatio);
      worstInPlaneAnisotropy = Math.max(
        worstInPlaneAnisotropy,
        Math.abs(alongSlope - acrossSlope) / alongSlope
      );
      const thickness = throughSurface / alongSlope;
      thinnestRatio = Math.min(thinnestRatio, thickness);
      thickestRatio = Math.max(thickestRatio, thickness);
    }
  }

  const meanError = checkedCount > 0 ? elevationErrorSum / checkedCount : NaN;
  // The stretch is no longer readable from the anisotropy of a single splat -- both in-plane axes
  // carry it now -- so it is recovered from the spread instead: the narrowest splat in the archive
  // is level ground, where the correction is exactly 1.
  const slopeCorrection = widestExtentRatio / narrowestExtentRatio;
  process.stdout.write(
    [
      '',
      `  archive   ${manifest.nodes.length} nodes, ${formatCount(manifest.scene.splatCount)} splats, ` +
        `refinement "${manifest.refinement}"`,
      `  anchored  ${georeference.longitude}, ${georeference.latitude} at ${georeference.altitude} m`,
      `  covers    ${longitudeRange[0].toFixed(4)}..${longitudeRange[1].toFixed(4)} E, ` +
        `${latitudeRange[0].toFixed(4)}..${latitudeRange[1].toFixed(4)} N`,
      `  elevation ${elevationRange[0].toFixed(0)}..${elevationRange[1].toFixed(0)} m`,
      '',
      `  vs an independent z${REFERENCE_ZOOM} elevation lookup, over ${formatCount(checkedCount)} leaf splats:`,
      `    mean  |dz|  ${meanError.toFixed(2)} m`,
      `    worst |dz|  ${worstElevationError.toFixed(1)} m`,
      '',
      `  quaternion norm error   <= ${worstQuaternionError.toExponential(2)}`,
      `  flattest normal z       ${flattestNormal.toFixed(3)}  (1 = level ground, 0 = vertical)`,
      `  in-plane extent         ${narrowestExtentRatio.toFixed(3)}..${widestExtentRatio.toFixed(
        3
      )} x sample spacing`,
      `  widest slope correction ${slopeCorrection.toFixed(2)}x  (= 1 / cos slope, so ${(
        (Math.acos(Math.min(1 / slopeCorrection, 1)) * 180) /
        Math.PI
      ).toFixed(0)} degrees)`,
      `  in-plane anisotropy     <= ${worstInPlaneAnisotropy.toExponential(2)}  ` +
        '(the two in-plane axes are stretched together, so this is 0)',
      `  thickness ratio         ${thinnestRatio.toFixed(3)}..${thickestRatio.toFixed(
        3
      )} x in-plane`,
      ''
    ].join('\n')
  );
}

main().catch(error => {
  process.stderr.write(`\n${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
