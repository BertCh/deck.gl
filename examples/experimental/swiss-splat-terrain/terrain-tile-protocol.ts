// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * The message protocol between the live terrain source and its decoder workers.
 *
 * Imports nothing but the types it forwards, so that a module the worker pulls in stays a decoder
 * and a loop rather than a renderer. Anything added here that reaches for deck.gl or luma.gl is a
 * bundle Vite has to serve into every worker.
 */

import type {TerrainHaze} from './terrain-surfels';
import type {TileAddress} from './scripts/terrain-grid';

/** The two rasters a splat tile is cut from, keyed so siblings can share a decode. */
export type TerrainTileSources = {
  /** `z/x/y` of the elevation tile - the key the worker caches its decode under. */
  elevationKey: string;
  elevationUrl: string;
  /** `z/x/y` of the imagery tile, which is a different tile at a different zoom. */
  imageryKey: string;
  /** Absent when no imagery is configured; the terrain comes out grey. */
  imageryUrl: string | null;
};

/** What the source asks a worker for: one tile, and the look to bake into it. */
export type TerrainTileRequest = {
  /** `z/x/y` of the splat tile, which is also its hierarchy node id. */
  key: string;
  /**
   * Which origin these metres are measured from.
   *
   * Bumped whenever the scene moves somewhere else. A worker halfway through a tile when the camera
   * leaves Zermatt still finishes it, and its positions are metres about a point in Switzerland; the
   * epoch is how the source knows to drop it on the floor rather than draw Arizona 700 km up.
   */
  epoch: number;
  tile: TileAddress;
  sources: TerrainTileSources;
  origin: {longitude: number; latitude: number};
  sigma: number;
  thickness: number;
  relief: number;
  lift: number;
  haze: TerrainHaze | null;
};

/** The five columns of one tile, packed exactly as a `RecordBatch` holds them. */
export type TerrainTileColumns = {
  key: string;
  /** Splats in this tile - always `NODE_GRID_SIZE²`. */
  count: number;
  positions: Float32Array;
  scales: Float32Array;
  rotations: Float32Array;
  /** Display-referred RGBA in `[0, 255]`. See `TerrainSurfelOptions.colorFormat`. */
  colors: Uint8Array;
  opacities: Float32Array;
  /** Ground metres between neighbouring splats, which is the node's geometric error. */
  spacing: number;
  /** `[minEast, minNorth, minUp, maxEast, maxNorth, maxUp]` in scene metres. */
  bounds: [number, number, number, number, number, number];
  clampedSlopeCount: number;
};

export type TerrainTileResponse =
  | {key: string; epoch: number; ok: true; columns: TerrainTileColumns}
  /**
   * `missing` means the elevation host has no archive here.
   *
   * A statement about coverage rather than a failure, and the difference matters: the traversal must
   * treat a missing tile as a leaf and stop refining, where a transport failure should be retried.
   */
  | {key: string; epoch: number; ok: false; missing: boolean; error: string};

/** Every buffer of a built tile, for a zero-copy `postMessage`. */
export function getTerrainTileTransferables(columns: TerrainTileColumns): ArrayBuffer[] {
  return [
    columns.positions.buffer as ArrayBuffer,
    columns.scales.buffer as ArrayBuffer,
    columns.rotations.buffer as ArrayBuffer,
    columns.colors.buffer as ArrayBuffer,
    columns.opacities.buffer as ArrayBuffer
  ];
}
