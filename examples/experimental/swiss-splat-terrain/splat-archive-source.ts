// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * The main-thread half of the streaming path: a manifest, a pool of workers, and the page loader
 * `SplatHierarchyManager` calls when its traversal wants a node it does not have.
 *
 * This module is deliberately the only place that knows a splat scene arrives over a network.
 * `SplatLayer` is handed a tree of nodes and a function that turns one into a `GPUSplatData`, and
 * has no opinion about where the bytes came from; luma.gl's hierarchy manager decides *which*
 * nodes and *when*. What is left here is the part neither of them should own: URLs, workers,
 * cancellation, and the one upload that has to happen on the thread that holds the device.
 *
 * ## The split at the worker boundary
 *
 * A page load is two very different pieces of work. Fetching and expanding a chunk is pure data
 * shuffling over tens of thousands of rows, and belongs on a worker. Creating the GPU buffers is
 * a handful of `device.createBuffer` calls that must happen on the thread that owns the device.
 * So `loadPage` awaits the worker, then calls `makeGPUSplatData` -- which copies each column
 * straight into a buffer with no row walk at all. The expensive half is off the main thread; the
 * half that cannot move is the cheap one.
 *
 * ## Why the pool is small
 *
 * Four workers, capped by `hardwareConcurrency`. The hierarchy manager already bounds how many
 * loads run at once (`maxConcurrentLoads`), and more workers past that only means more decoded
 * chunks arriving in the same frame, each one a GPU upload the main thread has to absorb.
 */

import type {Device} from '@luma.gl/core';
import {
  makeGPUSplatData,
  type GPUSplatData,
  type SplatHierarchyNode,
  type SplatHierarchyPageLoader,
  type SplatSource
} from '@luma.gl/splats';

import type {SphericalHarmonicsDegree} from './gaussian-ply';
import {
  buildSplatArchiveHierarchy,
  getBandChunkPath,
  getCoreChunkPath,
  getNodeTransferByteLength,
  SPLAT_ARCHIVE_FORMAT,
  SPLAT_ARCHIVE_VERSION,
  toSplatSource,
  type SplatArchiveDegree,
  type SplatArchiveManifest,
  type SplatArchiveNode
} from './splat-archive';
import type {SplatColumnsMessage, SplatWorkerRequest, SplatWorkerResponse} from './splat-worker';

/** Upper bound on decode workers, before `hardwareConcurrency` lowers it. */
const MAXIMUM_WORKERS = 4;

/** The two requests that do work, as opposed to `cancel`. */
type SplatWorkerJob = Exclude<SplatWorkerRequest, {type: 'cancel'}>;

/**
 * One job without the id the pool assigns.
 *
 * Written distributively (`Job extends any ? ... : never`) because a plain `Omit` over a union
 * collapses it to the keys its members share, which here is just `type`.
 */
type SplatWorkerJobPayload = SplatWorkerJob extends infer Job
  ? Job extends SplatWorkerJob
    ? Omit<Job, 'requestId'>
    : never
  : never;

type PendingRequest = {
  resolve: (columns: SplatColumnsMessage) => void;
  reject: (error: Error) => void;
  onProgress?: (loadedBytes: number, totalBytes: number | undefined, splatCount: number) => void;
  workerIndex: number;
};

/**
 * A round-robin pool of decode workers with one request table across all of them.
 *
 * Requests are numbered globally rather than per worker so a cancellation only needs the id: the
 * table remembers which worker is holding it. Cancelling matters more than it looks -- the
 * hierarchy aborts a page the moment the camera turns away from it, and an un-aborted fetch of a
 * chunk nobody wants competes for the connection with the chunks somebody does.
 */
class SplatWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private nextWorkerIndex = 0;

  constructor(workerCount: number) {
    for (let index = 0; index < workerCount; index++) {
      const worker = new Worker(new URL('./splat-worker.ts', import.meta.url), {
        type: 'module',
        name: `splat-decoder-${index}`
      });
      worker.onmessage = (event: MessageEvent<SplatWorkerResponse>) =>
        this.handleMessage(event.data);
      this.workers.push(worker);
    }
  }

  private handleMessage(response: SplatWorkerResponse): void {
    const request = this.pending.get(response.requestId);
    if (!request) {
      return;
    }
    if (response.type === 'progress') {
      request.onProgress?.(response.loadedBytes, response.totalBytes, response.splatCount);
      return;
    }
    this.pending.delete(response.requestId);
    if (response.type === 'columns') {
      request.resolve(response.columns);
    } else {
      const error = new Error(response.message);
      error.name = response.aborted ? 'AbortError' : 'Error';
      request.reject(error);
    }
  }

  /** Runs one request on the next worker, rejecting if `signal` aborts before it answers. */
  run(
    request: SplatWorkerJobPayload,
    options: {
      signal?: AbortSignal;
      onProgress?: PendingRequest['onProgress'];
    } = {}
  ): Promise<SplatColumnsMessage> {
    const requestId = this.nextRequestId++;
    const workerIndex = this.nextWorkerIndex;
    this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;

    return new Promise<SplatColumnsMessage>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve,
        reject,
        workerIndex,
        ...(options.onProgress ? {onProgress: options.onProgress} : {})
      });

      options.signal?.addEventListener(
        'abort',
        () => {
          if (!this.pending.delete(requestId)) {
            return;
          }
          this.workers[workerIndex].postMessage({type: 'cancel', requestId});
          const error = new Error('Splat decode aborted');
          error.name = 'AbortError';
          reject(error);
        },
        {once: true}
      );

      this.workers[workerIndex].postMessage({...request, requestId} as SplatWorkerRequest);
    });
  }

  destroy(): void {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers.length = 0;
    this.pending.clear();
  }
}

let sharedPool: SplatWorkerPool | undefined;

/**
 * The example's one decode pool, created on first use.
 *
 * Shared across scene switches on purpose: spinning up workers costs more than any single chunk
 * decode, and a scene change already has enough latency in it.
 */
function getWorkerPool(): SplatWorkerPool {
  if (!sharedPool) {
    const workerCount = Math.max(
      1,
      Math.min(MAXIMUM_WORKERS, navigator.hardwareConcurrency || MAXIMUM_WORKERS)
    );
    sharedPool = new SplatWorkerPool(workerCount);
  }
  return sharedPool;
}

/**
 * Fetches and validates one archive manifest.
 *
 * Absence is the interesting case, because a missing archive is the normal state of a fresh
 * checkout and the caller falls back to the PLY on it. It is also the case that is easiest to
 * misreport: a single-page dev server -- Vite's included -- answers an unknown path with the
 * app's own `index.html` and a **200**, so `response.ok` proves nothing. Left unchecked that
 * surfaces as `Unexpected token '<'` from the JSON parser, which says nothing useful about what
 * is actually wrong or what to do about it.
 */
export async function loadSplatArchiveManifest(
  baseUrl: string,
  signal?: AbortSignal
): Promise<SplatArchiveManifest> {
  const manifestUrl = new URL('manifest.json', withTrailingSlash(baseUrl)).href;
  const response = await fetch(manifestUrl, {signal});
  if (!response.ok) {
    throw new Error(`No splat archive at ${manifestUrl}: HTTP ${response.status}`);
  }
  if (response.headers.get('content-type')?.includes('text/html')) {
    throw new Error(
      `No splat archive at ${manifestUrl}: the server answered with the app's HTML, which is ` +
        `what a single-page dev server does for a path that does not exist`
    );
  }

  const manifest = (await response.json().catch(() => {
    throw new Error(`No splat archive at ${manifestUrl}: the response is not JSON`);
  })) as SplatArchiveManifest;
  if (manifest.format !== SPLAT_ARCHIVE_FORMAT) {
    throw new Error(`${manifestUrl} is not a ${SPLAT_ARCHIVE_FORMAT} manifest`);
  }
  if (manifest.version !== SPLAT_ARCHIVE_VERSION) {
    throw new Error(
      `Splat archive version ${manifest.version} was baked by a different build; re-run npm run bake`
    );
  }
  if (!manifest.nodes?.length) {
    throw new Error(`${manifestUrl} declares no level-of-detail nodes`);
  }
  return manifest;
}

function withTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

/** Totals a client can report before anything has been fetched. */
export type SplatArchiveSummary = {
  splatCount: number;
  nodeCount: number;
  /** Bytes the whole archive would cost at this degree, if every node were resident. */
  totalByteLength: number;
  maxSphericalHarmonicsDegree: SplatArchiveDegree;
};

/**
 * One baked archive, resolved against a base URL and a spherical-harmonic degree.
 *
 * The degree is fixed for the life of the source because it decides the shape of every GPU column
 * the pages allocate, and luma.gl's prepared batches are not resizable. Lowering the *rendered*
 * degree needs no new source at all -- the renderer clamps per batch -- so only raising it past
 * what is resident calls for a new `SplatArchiveSource`, which then re-reads its core chunks
 * from the HTTP cache and fetches just the extra bands.
 */
export class SplatArchiveSource {
  readonly manifest: SplatArchiveManifest;
  readonly degree: SplatArchiveDegree;
  readonly roots: SplatHierarchyNode[];
  readonly summary: SplatArchiveSummary;

  private readonly baseUrl: string;
  private readonly nodesById = new Map<string, SplatArchiveNode>();
  private readonly indexById = new Map<string, number>();

  constructor(manifest: SplatArchiveManifest, baseUrl: string, degree: SplatArchiveDegree) {
    this.manifest = manifest;
    this.baseUrl = withTrailingSlash(baseUrl);
    this.degree = Math.min(
      degree,
      manifest.scene.maxSphericalHarmonicsDegree
    ) as SplatArchiveDegree;

    manifest.nodes.forEach((node, index) => {
      this.nodesById.set(node.id, node);
      this.indexById.set(node.id, index);
    });

    this.roots = buildSplatArchiveHierarchy(manifest, this.degree, this.baseUrl);
    this.summary = {
      splatCount: manifest.scene.splatCount,
      nodeCount: manifest.nodes.length,
      totalByteLength: manifest.nodes.reduce(
        (total, node) => total + getNodeTransferByteLength(node, this.degree),
        0
      ),
      maxSphericalHarmonicsDegree: manifest.scene.maxSphericalHarmonicsDegree
    };
  }

  /** The page loader `SplatHierarchyManager` calls; one worker decode plus one GPU upload. */
  createPageLoader(device: Device): SplatHierarchyPageLoader {
    /**
     * Whether this archive's colours are display-referred rather than linear radiance.
     *
     * The archive stores colour as `float16` because a *trained* DC term is unclamped linear
     * radiance and can exceed 1, which `unorm8` would clip. A terrain bake is the other case: its
     * colour is an orthophoto with a fixed light mixed in, already in `[0, 1]` and already in the
     * space the renderer blends in.
     *
     * The distinction matters because luma.gl infers intent from the column's *type*. A float colour
     * column on a device without an extended-range swap chain silently turns on Reinhard tone
     * mapping for the whole scene, which maps 1.0 to 0.5 - so a terrain archive left as float draws
     * at half the brightness of the identical scene streamed live, and the comparison this example is
     * built around becomes a comparison of two exposures.
     *
     * `georeference` is the discriminator: only the terrain baker publishes one.
     */
    const isDisplayReferred = Boolean(this.manifest.scene.georeference);

    return async (node, context) => {
      const archiveNode = this.nodesById.get(node.id);
      if (!archiveNode) {
        throw new Error(`Unknown splat archive node ${node.id}`);
      }

      const bandUrls: string[] = [];
      for (let band = 1; band <= this.degree; band++) {
        bandUrls.push(new URL(getBandChunkPath(node.id, band), this.baseUrl).href);
      }

      const columns = await getWorkerPool().run(
        {
          type: 'archive-chunk',
          coreUrl: new URL(getCoreChunkPath(node.id), this.baseUrl).href,
          bandUrls,
          degree: this.degree
        },
        {signal: context.signal}
      );

      // The traversal can turn away from a node while its chunk is in flight. Checking here
      // rather than only in the worker means the abort also skips the GPU upload.
      context.signal.throwIfAborted();

      const source = toSplatSource(
        {
          rowCount: columns.splatCount,
          positions: columns.positions,
          scales: columns.scales,
          rotations: columns.rotations,
          colors: columns.colors,
          opacities: columns.opacities
        },
        columns.sphericalHarmonics,
        this.degree,
        {
          // Stable across loads and evictions, because both come from the manifest rather than
          // from the order pages happen to arrive in.
          sourceBatchIndex: this.indexById.get(node.id)!,
          rowIndexBase: archiveNode.rowIndexBase
        }
      );

      if (isDisplayReferred) {
        source.colors = toDisplayColors(source.colors as Float32Array);
      }

      return makeGPUSplatData(device, source) as GPUSplatData;
    };
  }
}

/**
 * Requantizes a display-referred `[0, 1]` float colour column to `unorm8`.
 *
 * Eight bits a channel is all a display-referred colour carries, so nothing is lost - and the type
 * is what tells luma.gl not to tone-map it. See `isDisplayReferred`.
 */
function toDisplayColors(colors: Float32Array): Uint8Array {
  const out = new Uint8Array(colors.length);
  for (let index = 0; index < colors.length; index++) {
    out[index] = Math.round(Math.min(Math.max(colors[index], 0), 1) * 255);
  }
  return out;
}

/**
 * Decodes an unbaked scene straight from its PLY files, on a worker.
 *
 * The fallback for a scene with no archive beside it. Everything the baker would have done
 * happens here instead, at load time, once per visitor -- which is the cost the archive exists to
 * remove, and the reason the panel says which path it took.
 */
export async function loadPlySceneOnWorker(
  urls: string[],
  sphericalHarmonicsDegree: SphericalHarmonicsDegree,
  maxSplats: number | null,
  options: {
    signal?: AbortSignal;
    onProgress?: (loadedBytes: number, totalBytes: number | undefined, splatCount: number) => void;
  } = {}
): Promise<SplatSource> {
  const columns = await getWorkerPool().run(
    {type: 'ply', urls, sphericalHarmonicsDegree, maxSplats},
    options
  );
  return {
    positions: columns.positions,
    scales: columns.scales,
    rotations: columns.rotations,
    colors: columns.colors,
    opacities: columns.opacities,
    ...(columns.sphericalHarmonics
      ? {
          sphericalHarmonics: columns.sphericalHarmonics,
          sphericalHarmonicsDegree: columns.sphericalHarmonicsDegree
        }
      : {})
  };
}

/** Terminates the shared decode pool. Only the example's teardown path needs this. */
export function destroySplatWorkerPool(): void {
  sharedPool?.destroy();
  sharedPool = undefined;
}
