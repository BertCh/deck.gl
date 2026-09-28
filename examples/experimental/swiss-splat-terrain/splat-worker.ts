// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * The worker that turns bytes into renderer columns, for both of the example's load paths.
 *
 * Nothing here is clever; the point is only that none of it is on the main thread. A splat scene
 * is tens of millions of numbers, and every way of getting one into a GPU buffer walks all of
 * them at least once. Doing that between deck.gl's frames means dropping them:
 *
 * - **`archive-chunk`** expands one baked chunk. A linear pass with no ranking, no sort and no
 *   branching, a few milliseconds for 65k rows, and the reason the baked path can afford to be
 *   synchronous inside the worker at all.
 * - **`ply`** is the fallback for a scene nobody has baked yet: the full streaming GraphDECO
 *   decode, then the prune, budget and Morton reorder that `bake-splat-scene` would otherwise
 *   have done offline. Seconds of work either way -- but seconds of *worker*, which leaves the
 *   terrain interactive underneath it instead of freezing the tab.
 *
 * Columns are transferred rather than copied, so a decoded chunk crosses the boundary as a
 * pointer hand-off and the worker's own reference goes dead. That is why every response builds
 * its transfer list from exactly the buffers it is giving up.
 */

import type {SplatSource} from '@luma.gl/splats';

import {decodeGaussianPlyStream, type SphericalHarmonicsDegree} from './gaussian-ply';
import {prepareSplatSource} from './splat-preprocess';
import {
  decodeCoreChunk,
  mergeBandChunks,
  readBandChunk,
  type SplatArchiveDegree,
  type SplatBandChunk
} from './splat-archive';

/** Columns as they cross the worker boundary: plain buffers, no class identity to preserve. */
export type SplatColumnsMessage = {
  splatCount: number;
  positions: Float32Array;
  scales: Float32Array;
  rotations: Float32Array;
  colors: Float32Array;
  opacities: Float32Array;
  sphericalHarmonics?: Float32Array;
  sphericalHarmonicsDegree?: SplatArchiveDegree;
};

export type SplatWorkerRequest =
  | {
      type: 'archive-chunk';
      requestId: number;
      /** Absolute URL of the node's core chunk. */
      coreUrl: string;
      /** Absolute URLs of the bands to merge, band 1 first. */
      bandUrls: string[];
      degree: SplatArchiveDegree;
    }
  | {
      type: 'ply';
      requestId: number;
      urls: string[];
      sphericalHarmonicsDegree: SphericalHarmonicsDegree;
      /** Rows kept after ranking; `null` keeps the whole reconstruction. */
      maxSplats: number | null;
    }
  | {type: 'cancel'; requestId: number};

export type SplatWorkerResponse =
  | {type: 'columns'; requestId: number; columns: SplatColumnsMessage}
  | {
      type: 'progress';
      requestId: number;
      loadedBytes: number;
      totalBytes?: number;
      splatCount: number;
    }
  | {type: 'error'; requestId: number; message: string; aborted: boolean};

/** In-flight work, so a cancel can abort the fetch rather than merely ignore its result. */
const activeRequests = new Map<number, AbortController>();

const workerScope = self as unknown as {
  postMessage(message: SplatWorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<SplatWorkerRequest>) => void) | null;
};

/** Every buffer a columns message owns, which is exactly what it hands over. */
function getTransferables(columns: SplatColumnsMessage): Transferable[] {
  const transferables: Transferable[] = [
    columns.positions.buffer,
    columns.scales.buffer,
    columns.rotations.buffer,
    columns.colors.buffer,
    columns.opacities.buffer
  ];
  if (columns.sphericalHarmonics) {
    transferables.push(columns.sphericalHarmonics.buffer);
  }
  return transferables as Transferable[];
}

async function fetchArrayBuffer(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, {signal});
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.arrayBuffer();
}

/**
 * Fetches and expands one level-of-detail node.
 *
 * The core chunk and its bands are requested together rather than in sequence: they are separate
 * files only so that a degree change does not re-download the geometry, and a node at degree 2
 * still needs all three at once.
 */
async function loadArchiveChunk(
  request: Extract<SplatWorkerRequest, {type: 'archive-chunk'}>,
  signal: AbortSignal
): Promise<SplatColumnsMessage> {
  const [coreBuffer, ...bandBuffers] = await Promise.all([
    fetchArrayBuffer(request.coreUrl, signal),
    ...request.bandUrls.map(url => fetchArrayBuffer(url, signal))
  ]);

  const columns = decodeCoreChunk(coreBuffer);

  let sphericalHarmonics: Float32Array | undefined;
  if (bandBuffers.length > 0) {
    const bands: SplatBandChunk[] = bandBuffers.map(buffer => readBandChunk(buffer));
    for (const band of bands) {
      if (band.rowCount !== columns.rowCount) {
        throw new Error('Spherical-harmonic band chunk row count does not match its core chunk');
      }
    }
    sphericalHarmonics = mergeBandChunks(bands, columns.rowCount);
  }

  return {
    splatCount: columns.rowCount,
    positions: columns.positions,
    scales: columns.scales,
    rotations: columns.rotations,
    colors: columns.colors,
    opacities: columns.opacities,
    ...(sphericalHarmonics ? {sphericalHarmonics, sphericalHarmonicsDegree: request.degree} : {})
  };
}

/**
 * Decodes an unbaked scene, then does the bake's work inline.
 *
 * Multi-file scenes decode in sequence and are concatenated, because each file is a complete
 * reconstruction of its own and the prune-rank-reorder pass only means anything across all of
 * them at once -- ranking within one half of a scene would keep that half's mediocre splats over
 * the other half's good ones.
 */
async function loadPlyScene(
  request: Extract<SplatWorkerRequest, {type: 'ply'}>,
  signal: AbortSignal,
  onProgress: (loadedBytes: number, totalBytes: number | undefined, splatCount: number) => void
): Promise<SplatColumnsMessage> {
  let committedBytes = 0;
  let committedSplats = 0;
  const sources = [];

  for (const url of request.urls) {
    const response = await fetch(url, {signal});
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    const {source} = await decodeGaussianPlyStream(response.body, {
      sphericalHarmonicsDegree: request.sphericalHarmonicsDegree,
      signal,
      totalBytes: Number(response.headers.get('content-length')) || undefined,
      onProgress: (loadedBytes, totalBytes, splatCount) =>
        onProgress(
          committedBytes + loadedBytes,
          // Only meaningful for a single-file scene; multi-file totals stay indeterminate.
          request.urls.length === 1 ? totalBytes : undefined,
          committedSplats + splatCount
        )
    });
    sources.push(source);
    committedBytes += source.positions.byteLength;
    committedSplats += Math.floor(source.positions.length / 3);
  }

  const merged = sources.length === 1 ? sources[0] : concatenateSources(sources);
  const prepared = prepareSplatSource(merged, {
    ...(request.maxSplats === null ? {} : {maxSplats: request.maxSplats})
  });

  return {
    splatCount: prepared.opacities.length,
    positions: prepared.positions,
    scales: prepared.scales,
    rotations: prepared.rotations,
    colors: prepared.colors as Float32Array,
    opacities: prepared.opacities,
    ...(prepared.sphericalHarmonics
      ? {
          sphericalHarmonics: prepared.sphericalHarmonics,
          sphericalHarmonicsDegree: prepared.sphericalHarmonicsDegree as SplatArchiveDegree
        }
      : {})
  };
}

/** Joins several decoded PLY files into one set of columns. */
function concatenateSources(sources: SplatSource[]): SplatSource {
  const splatCount = sources.reduce((total, source) => total + source.opacities.length, 0);
  const basisValuesPerRow = sources[0].sphericalHarmonics
    ? Math.floor(sources[0].sphericalHarmonics.length / sources[0].opacities.length)
    : 0;

  const positions = new Float32Array(splatCount * 3);
  const scales = new Float32Array(splatCount * 3);
  const rotations = new Float32Array(splatCount * 4);
  const colors = new Float32Array(splatCount * 4);
  const opacities = new Float32Array(splatCount);
  const sphericalHarmonics =
    basisValuesPerRow > 0 ? new Float32Array(splatCount * basisValuesPerRow) : undefined;

  let rowOffset = 0;
  for (const source of sources) {
    const rows = source.opacities.length;
    positions.set(source.positions, rowOffset * 3);
    scales.set(source.scales, rowOffset * 3);
    rotations.set(source.rotations, rowOffset * 4);
    colors.set(source.colors as Float32Array, rowOffset * 4);
    opacities.set(source.opacities, rowOffset);
    sphericalHarmonics?.set(source.sphericalHarmonics!, rowOffset * basisValuesPerRow);
    rowOffset += rows;
  }

  return {
    positions,
    scales,
    rotations,
    colors,
    opacities,
    ...(sphericalHarmonics
      ? {
          sphericalHarmonics,
          sphericalHarmonicsDegree: sources[0].sphericalHarmonicsDegree
        }
      : {})
  };
}

workerScope.onmessage = async (event: MessageEvent<SplatWorkerRequest>) => {
  const request = event.data;

  if (request.type === 'cancel') {
    activeRequests.get(request.requestId)?.abort();
    activeRequests.delete(request.requestId);
    return;
  }

  const controller = new AbortController();
  activeRequests.set(request.requestId, controller);

  try {
    const columns =
      request.type === 'archive-chunk'
        ? await loadArchiveChunk(request, controller.signal)
        : await loadPlyScene(request, controller.signal, (loadedBytes, totalBytes, splatCount) =>
            workerScope.postMessage({
              type: 'progress',
              requestId: request.requestId,
              loadedBytes,
              ...(totalBytes === undefined ? {} : {totalBytes}),
              splatCount
            })
          );
    controller.signal.throwIfAborted();
    workerScope.postMessage(
      {type: 'columns', requestId: request.requestId, columns},
      getTransferables(columns)
    );
  } catch (error) {
    workerScope.postMessage({
      type: 'error',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error),
      aborted: controller.signal.aborted
    });
  } finally {
    activeRequests.delete(request.requestId);
  }
};
