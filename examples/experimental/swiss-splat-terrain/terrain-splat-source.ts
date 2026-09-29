// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * A live terrain quadtree, as `SplatLayer`'s streaming source.
 *
 * ## What this is, and what it is not
 *
 * It is not a level-of-detail implementation. `SplatHierarchyManager` inside `SplatLayer` already
 * does the traversal, the frustum culling, the screen-space-error test, the priority ordering, the
 * bounded load scheduling, the coarse-ancestor fallback and the residency window. All this supplies is the three things the traversal cannot know for
 * a tile service:
 *
 * 1. **Where the nodes are.** A `z/x/y` quadtree over a raster endpoint, in scene metres.
 * 2. **How to load one.** A worker pool that fetches two rasters and cuts a tile of surfels.
 * 3. **Where the tree stops.** Nobody knows until a request 404s, so it is discovered.
 *
 * ## Why the tree grows
 *
 * A tile service has no bottom: Mapterhorn serves
 * zoom 12 worldwide and zoom 17 over Switzerland, and the only way to find the edge of a regional
 * archive is to ask past it. So nodes are created one level ahead of the frontier - when a node's
 * page lands, its four children are appended - and `SplatHierarchySource.subscribe` tells the layer
 * to re-index. Every page already resident survives that, because the residency window belongs to the
 * layer rather than to the traversal.
 *
 * One level ahead is exactly enough: the traversal only refines into children that exist, and it only
 * refines a node it already has resident, so a child created the moment its parent lands is a child
 * created before anything could have wanted it.
 *
 * ## How the edge of coverage is found
 *
 * A 404 is not an error, it is the shape of the data. A node that 404s is **removed from its
 * parent's children**, so the traversal stops refining there and draws the parent as a leaf - and
 * because sixty-four sibling tiles share one elevation raster, one 404 answers for all of them and
 * their children are never created in the first place. A transport failure is a different thing and
 * is retried, which is why the two are distinguished all the way back from the worker.
 *
 * ## What it does not do
 *
 * The tree only shrinks where coverage ends; a node whose page loaded successfully is never pruned,
 * even after its page is evicted. So the node count is a high-water mark of everywhere the camera
 * has looked, bounded by `COVERAGE_RADIUS_METERS` and `MAXIMUM_ZOOM`, and a few thousand nodes of a
 * couple of hundred bytes each is the cost of coming back to somewhere already visited without
 * rediscovering it. Choosing another place builds a new source and drops this one entirely.
 */

import {makeGPUSplatData, type GPUSplatData, type SplatHierarchyNode} from '@luma.gl/splats';
import type {Device} from '@luma.gl/core';
import type {SplatHierarchySource} from '@deck.gl/splat-layers';

import {
  assertZeroCopy,
  describeTerrainSchema,
  makeTerrainRecordBatch,
  readSplatSource
} from './terrain-geoarrow';
import {
  type TerrainTileColumns,
  type TerrainTileRequest,
  type TerrainTileResponse
} from './terrain-tile-protocol';
import type {TerrainHaze} from './terrain-surfels';
import {
  fillTileTemplate,
  getChildTiles,
  getElevationBlock,
  getImageryBlock,
  getSplatSpacing,
  getTileGroundSize,
  latitudeToTileY,
  TERRAIN_TILING,
  longitudeToTileX,
  projectFlat,
  tileKey,
  tileXToLongitude,
  tileYToLatitude,
  unitsPerMeter,
  type TileAddress
} from './terrain-grid';

/** Splats a live tile carries. */
export const LIVE_SPLATS_PER_TILE = TERRAIN_TILING.gridSize * TERRAIN_TILING.gridSize;

/**
 * Coarsest and finest zoom the quadtree may emit.
 *
 * `MINIMUM_ZOOM` is chosen so the roots cover the whole hazed disk in a couple of dozen tiles: it is
 * the fallback of last resort, because a tile is drawn as its nearest loaded ancestor until it lands
 * and above the roots there is no ancestor at all.
 *
 * `MAXIMUM_ZOOM` is a cap, not a target - the budget and `maximumScreenSpaceError` decide where
 * refinement actually stops. It is set for the wheel: at zoom 20 the elevation source is Mapterhorn's
 * zoom 17, which over Switzerland is swissALTI3D at about 0.4 m a pixel, so a camera pulled in close
 * gets measured heights that far apart rather than an interpolation of the 30 m global grid. Where a
 * regional archive stops, the source 404s and the traversal reads the parent as a leaf - so the whole
 * zoom policy here is two constants and whatever the host happens to have.
 */
export const MINIMUM_ZOOM = 9;
export const MAXIMUM_ZOOM = 20;

/** Tiles further than this from the scene origin are never created. See {@link TerrainHaze}. */
const COVERAGE_RADIUS_METERS = 99_000;

/** How long a tile that failed in transport is left alone before the tree offers it again. */
const RETRY_DELAY_MS = 8000;

/**
 * Elevation band assumed for a node with no loaded ancestor at all, in metres.
 *
 * **Only** the fallback. Screen-space error is measured from the camera to the node's bounding
 * sphere, so the sphere's vertical extent is part of that distance - and one band shared by the whole
 * scene is badly wrong the moment the terrain has any relief. With a single band every node's sphere
 * reaches 5000 m, so a valley floor four kilometres below the camera is measured as if it came up to
 * meet it: near, therefore refined, therefore holding budget that the mountain the camera is actually
 * looking at then does not get. The mountain reads coarse and the empty ground beside it reads sharp,
 * which is precisely backwards.
 *
 * So every node carries its own measured band once its page lands, children inherit their nearest
 * loaded ancestor's until then, and this pair is only what a root starts with.
 */
const DEFAULT_ELEVATION_BAND: readonly [number, number] = [-200, 5000];

/** Somewhere to look at, and the endpoints it is built from. */
export type TerrainPlace = {
  id: string;
  label: string;
  description: string;
  /**
   * The point the camera orbits, on the ground.
   *
   * Scene metres are measured from here, so it is also the origin the haze is measured from and the
   * point `float32` positions have their full precision nearest. Put it on the subject.
   */
  longitude: number;
  latitude: number;
  /**
   * Height the camera looks *at*, in metres above sea level. Not the summit.
   *
   * A `MapView` aims at the ground plane, and these scenes put four kilometres of rock above it - so
   * left at zero the camera stares at sea level with a mountain standing between it and the target,
   * and the subject sits somewhere off the top of the frame. deck.gl's `position` offsets the view
   * centre in metres, so this lifts the point being orbited to somewhere on the mountain.
   */
  lookAtAltitude: number;
  /**
   * How far the camera sits from the look-at point, in metres.
   *
   * Declared as a distance rather than a zoom because a zoom is a property of the *viewport* - the
   * same number frames a different amount of mountain on a laptop and a projector - whereas "eight
   * kilometres out" is a property of the subject. `getPlaceCamera` converts the pair.
   */
  rangeMeters: number;
  /**
   * How far above horizontal the camera looks down, in degrees.
   *
   * Small numbers for a peak, because a summit only reads as a summit against sky: at 30 degrees the
   * camera is above the mountain and the pyramid flattens into a plateau. Larger numbers for a
   * valley, which has to be looked into.
   */
  elevationDeg: number;
  /** Where the orbit opens, in degrees. The orbit moves it from there. */
  bearing: number;
  /** A `{z}/{x}/{y}` imagery template, or `null` for relief-only grey terrain. */
  imageryUrl: string | null;
  /** What the imagery is, for the attribution line. */
  imageryCredit: string | null;
};

export type TerrainSplatSourceProps = {
  place: TerrainPlace;
  elevationUrl: string;
  /** In-plane one-sigma extent as a fraction of the sample spacing. */
  sigma: number;
  thickness: number;
  relief: number;
  haze: TerrainHaze | null;
  /**
   * Nodes the renderer's command graph is compiled for.
   *
   * Reserved capacity, not a limit on the tree: it decides how many batch binding slots the graph
   * holds, and a frontier that fits inside it costs a pointer swap rather than a graph rebuild. It
   * has to cover the frontier *plus* whatever the layer's fade ramps are still drawing, so it is set
   * well above what a splat budget can actually make resident.
   */
  maxResidentNodes?: number;
  /** Workers decoding rasters. Defaults to a share of the machine's cores. */
  workerCount?: number;
};

/** What the panel reports about a live scene. */
export type TerrainSourceStats = {
  /** Tiles built and handed to the GPU since this source was created. */
  builtTiles: number;
  /** Tiles the workers are fetching and cutting right now. */
  pendingTiles: number;
  /** Nodes in the tree, which is what the traversal walks. */
  nodeCount: number;
  /** Elevation rasters the host had no archive for. The edge of coverage, discovered. */
  missingRasters: number;
  /** Tiles that failed in transport and are waiting to be offered again. */
  retryingTiles: number;
  /** Schema of the first `RecordBatch` built, read off it rather than retyped. */
  schema: Array<{name: string; type: string}>;
};

/**
 * A node plus everything this source needs to remember about it.
 *
 * `children` is narrowed off the base type and re-declared mutable: the traversal only ever reads it,
 * and this source has to splice a 404 out of it.
 */
type TerrainNode = Omit<SplatHierarchyNode, 'children'> & {
  tile: TileAddress;
  children?: TerrainNode[];
  /** Measured once the page lands; inherited from the nearest loaded ancestor until then. */
  elevationBand: readonly [number, number];
  /** Whether this node's page has landed, so its children are real rather than guessed. */
  measured: boolean;
  parent: TerrainNode | null;
};

export class TerrainSplatSource implements SplatHierarchySource {
  readonly place: TerrainPlace;
  roots: TerrainNode[] = [];
  readonly summary: {splatCount: number; nodeCount: number};

  private readonly props: TerrainSplatSourceProps;
  private readonly maxResidentNodes: number;
  private readonly nodesByKey = new Map<string, TerrainNode>();
  private readonly listeners = new Set<() => void>();
  private readonly workers: Worker[] = [];
  /** Requests each worker is carrying, for least-loaded routing. */
  private readonly workerLoad = new Map<Worker, number>();
  /**
   * The worker each elevation raster was last sent to.
   *
   * A worker caches the rasters it decoded, so a tile routed to the one that already holds its
   * elevation source is a surfel loop rather than a fetch and two decodes. With sixty-four tiles to a
   * raster this is the difference between one decode per split and four.
   */
  private readonly rasterWorker = new Map<string, Worker>();
  /** Requests in flight, keyed by tile, so a response can be matched to its waiter. */
  private readonly inFlight = new Map<
    string,
    {resolve: (columns: TerrainTileColumns) => void; reject: (error: unknown) => void}
  >();
  /** Elevation rasters the host has no archive for. One 404 answers for every tile cut from it. */
  private readonly missingRasters = new Set<string>();
  /** Tiles pruned after a transport failure, with the timer that will offer them again. */
  private readonly retrying = new Map<string, ReturnType<typeof setTimeout>>();

  /** The origin in common space, and its scale factor: the frame every position is relative to. */
  private readonly originX: number;
  private readonly originY: number;
  private readonly originUnitsPerMeter: number;

  private epoch = 0;
  private builtTiles = 0;
  private nextBatchIndex = 0;
  private schema: Array<{name: string; type: string}> = [];
  private checkedZeroCopy = false;
  private notifyScheduled = false;
  private destroyed = false;

  constructor(props: TerrainSplatSourceProps) {
    this.props = props;
    this.place = props.place;
    this.maxResidentNodes = props.maxResidentNodes ?? 640;
    [this.originX, this.originY] = projectFlat(props.place.longitude, props.place.latitude);
    this.originUnitsPerMeter = unitsPerMeter(props.place.latitude);
    // Reported to the layer so it reserves renderer capacity before a single page exists. The splat
    // count is deliberately far above what any device budget allows, because the budget is what
    // should decide residency; this only has to be large enough not to be the thing that binds.
    this.summary = {
      splatCount: this.maxResidentNodes * LIVE_SPLATS_PER_TILE,
      nodeCount: this.maxResidentNodes
    };

    const cores = typeof navigator === 'undefined' ? 4 : navigator.hardwareConcurrency || 4;
    const workerCount = props.workerCount ?? Math.max(2, Math.min(4, cores - 2));
    for (let index = 0; index < workerCount; index++) {
      const worker = new Worker(new URL('./terrain-tile.worker.ts', import.meta.url), {
        type: 'module'
      });
      worker.onmessage = (event: MessageEvent<TerrainTileResponse>) =>
        this._onWorkerMessage(worker, event.data);
      // A worker that fails to start (or throws outside a request) never answers, so everything in
      // flight would wait forever. Fail it all; the traversal re-requests what it still wants.
      worker.onerror = (event: ErrorEvent) => {
        event.preventDefault();
        this._failInFlight(new Error(`terrain worker failed: ${event.message}`));
      };
      this.workers.push(worker);
      this.workerLoad.set(worker, 0);
    }

    this._createRoots();
  }

  /** @see SplatHierarchySource.subscribe */
  subscribe(onRootsChange: () => void): () => void {
    this.listeners.add(onRootsChange);
    return () => this.listeners.delete(onRootsChange);
  }

  /** @see SplatHierarchySource.createPageLoader */
  createPageLoader(device: Device) {
    return async (node: SplatHierarchyNode, context: {signal: AbortSignal}) => {
      const terrainNode = this.nodesByKey.get(node.id);
      if (!terrainNode) {
        throw new Error(`terrain node ${node.id} is no longer in the tree`);
      }
      const columns = await this._requestTile(terrainNode, context.signal);

      // One tile, one RecordBatch, and from there straight into GPU columns. This is the handoff the
      // module is about, and the only place anything touches the data.
      const batch = makeTerrainRecordBatch(columns, this.place);
      if (!this.checkedZeroCopy) {
        this.checkedZeroCopy = true;
        assertZeroCopy(batch, columns);
      }
      if (this.schema.length === 0) {
        this.schema = describeTerrainSchema(batch);
      }

      const data = makeGPUSplatData(device, readSplatSource(batch, this.nextBatchIndex++));
      this.builtTiles++;
      this._onTileMeasured(terrainNode, columns);
      return data;
    };
  }

  getStats(): TerrainSourceStats {
    return {
      builtTiles: this.builtTiles,
      pendingTiles: this.inFlight.size,
      nodeCount: this.nodesByKey.size,
      missingRasters: this.missingRasters.size,
      retryingTiles: this.retrying.size,
      schema: this.schema
    };
  }

  /** Ground metres between neighbouring splats in a node, which is its geometric error. */
  getNodeSpacing(nodeId: string): number | undefined {
    return this.nodesByKey.get(nodeId)?.geometricError;
  }

  /** Zoom of a node, parsed back out of its `z/x/y` identity. */
  static getNodeZoom(nodeId: string): number {
    return Number(nodeId.slice(0, nodeId.indexOf('/')));
  }

  destroy(): void {
    this.destroyed = true;
    this.epoch++;
    for (const timer of this.retrying.values()) {
      clearTimeout(timer);
    }
    this.retrying.clear();
    for (const pending of this.inFlight.values()) {
      // An abort rather than a failure: the layer filters these, and a place switch retires a
      // handful of in-flight pages that nobody was ever going to look at.
      pending.reject(new DOMException('terrain source destroyed', 'AbortError'));
    }
    this.inFlight.clear();
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers.length = 0;
    this.listeners.clear();
  }

  /**
   * The roots: every tile at {@link MINIMUM_ZOOM} whose centre is inside the coverage radius.
   *
   * Over the haze disk that is a couple of dozen tiles and a handful of raster fetches. They are the
   * bottom of the fallback chain, so ground turning into view whose ancestor had been evicted still
   * has something to draw while its own tile is built.
   */
  private _createRoots(): void {
    const {longitude, latitude} = this.place;
    const degreesPerMeter = 1 / 111_320;
    const latitudeSpan = COVERAGE_RADIUS_METERS * degreesPerMeter;
    const longitudeSpan = latitudeSpan / Math.cos((latitude * Math.PI) / 180);

    const minTileX = Math.floor(longitudeToTileX(longitude - longitudeSpan, MINIMUM_ZOOM));
    const maxTileX = Math.floor(longitudeToTileX(longitude + longitudeSpan, MINIMUM_ZOOM));
    // Tile y runs southward, so the northern edge is the smaller index.
    const minTileY = Math.floor(latitudeToTileY(latitude + latitudeSpan, MINIMUM_ZOOM));
    const maxTileY = Math.floor(latitudeToTileY(latitude - latitudeSpan, MINIMUM_ZOOM));

    const span = 2 ** MINIMUM_ZOOM;
    for (let y = Math.max(0, minTileY); y <= Math.min(span - 1, maxTileY); y++) {
      for (let x = minTileX; x <= maxTileX; x++) {
        const tile = {z: MINIMUM_ZOOM, x: ((x % span) + span) % span, y};
        if (this._isWithinCoverage(tile)) {
          this.roots.push(this._createNode(tile, null));
        }
      }
    }
  }

  /** Whether a tile's centre is close enough to the origin to be worth building at all. */
  private _isWithinCoverage(tile: TileAddress): boolean {
    const [east, north] = this._getTileCenterOffset(tile);
    const halfDiagonal = getTileGroundSize(tile.z, this.place.latitude) * Math.SQRT1_2;
    return Math.hypot(east, north) - halfDiagonal <= COVERAGE_RADIUS_METERS;
  }

  /**
   * A tile centre's offset from the scene origin, in scene metres.
   *
   * Computed through `projectFlat` and `unitsPerMeter` rather than re-derived, because these are the
   * numbers a node's *bounding sphere* is built from and the surfel builder uses the same two
   * functions per splat. Any second derivation of the same arithmetic would eventually disagree by
   * a fraction of a percent, and a bounding sphere that does not contain its own splats culls them.
   */
  private _getTileCenterOffset(tile: TileAddress): [number, number] {
    const [centerX, centerY] = projectFlat(
      tileXToLongitude(tile.x + 0.5, tile.z),
      tileYToLatitude(tile.y + 0.5, tile.z)
    );
    return [
      (centerX - this.originX) / this.originUnitsPerMeter,
      // Common-space y increases southward; scene north is +y.
      -(centerY - this.originY) / this.originUnitsPerMeter
    ];
  }

  private _createNode(tile: TileAddress, parent: TerrainNode | null): TerrainNode {
    const key = tileKey(tile);
    const elevationBand = parent?.elevationBand ?? DEFAULT_ELEVATION_BAND;
    const node: TerrainNode = {
      id: key,
      ...(parent ? {parentId: parent.id} : {}),
      tile,
      parent,
      elevationBand,
      measured: false,
      bounds: this._getNodeBounds(tile, elevationBand),
      // The mean ground spacing of this node's own splats, which is exactly what the traversal's
      // screen-space error wants: refine while neighbouring splats project further apart than the
      // error threshold in pixels.
      geometricError: getSplatSpacing(
        tile.z,
        tileYToLatitude(tile.y + 0.5, tile.z),
        TERRAIN_TILING.gridSize
      ),
      estimatedSplatCount: LIVE_SPLATS_PER_TILE,
      // Finer children replace this node rather than adding to it: two levels of the same surface
      // drawn together would be two interleaved sheets in one depth sort.
      refinement: 'replace',
      // The residency manager destroys these pages on eviction; nothing outside the layer holds one.
      ownsData: true
    };
    this.nodesByKey.set(key, node);
    return node;
  }

  /** A node's bounding sphere, from its footprint and whatever elevation band is known. */
  private _getNodeBounds(
    tile: TileAddress,
    band: readonly [number, number]
  ): {center: [number, number, number]; radius: number} {
    const [east, north] = this._getTileCenterOffset(tile);
    const half = getTileGroundSize(tile.z, tileYToLatitude(tile.y + 0.5, tile.z)) / 2;
    const halfHeight = Math.max((band[1] - band[0]) / 2, 1);
    return {
      center: [east, north, (band[0] + band[1]) / 2],
      radius: Math.hypot(half, half, halfHeight)
    };
  }

  /**
   * A page landed: tighten this node's bounds to what was measured, and offer its children.
   *
   * Tightening matters as much as the children do. A node's guessed band is its ancestor's, which
   * over a valley is hundreds of metres too tall, and the sphere's radius is part of the distance the
   * error test divides by - so an untightened node reads as nearer than it is and refines ahead of
   * ground that deserves it more.
   */
  private _onTileMeasured(node: TerrainNode, columns: TerrainTileColumns): void {
    const band: readonly [number, number] = [columns.bounds[2], columns.bounds[5]];
    node.elevationBand = band;
    node.measured = true;
    node.bounds = this._getNodeBounds(node.tile, band);
    // The worker measured the spacing against the tile's own latitude, so prefer it to the estimate.
    node.geometricError = columns.spacing;

    let changed = true;
    if (!node.children && node.tile.z < MAXIMUM_ZOOM) {
      node.children = getChildTiles(node.tile)
        .filter(child => this._isWithinCoverage(child) && !this._isKnownMissing(child))
        .map(child => this._createNode(child, node));
    } else if (node.children) {
      // Children created before their parent was measured inherited the wrong band; correct them now
      // rather than waiting for each of them to land.
      for (const child of node.children) {
        if (!child.measured) {
          child.elevationBand = band;
          child.bounds = this._getNodeBounds(child.tile, band);
        }
      }
    } else {
      changed = false;
    }

    if (changed) {
      this._scheduleNotify();
    }
  }

  /** Whether a tile's elevation raster is already known to be outside the host's coverage. */
  private _isKnownMissing(tile: TileAddress): boolean {
    return this.missingRasters.has(tileKey(getElevationBlock(tile, TERRAIN_TILING).tile));
  }

  /**
   * Sends a tile to a worker and waits for its columns.
   *
   * Concurrency is the traversal's business, not this method's: `SplatLayer` passes
   * `maxConcurrentLoads` to the hierarchy, which is what decides how many of these are ever open. So
   * this only has to route well and clean up after itself.
   */
  private _requestTile(node: TerrainNode, signal: AbortSignal): Promise<TerrainTileColumns> {
    if (this.destroyed) {
      return Promise.reject(new DOMException('terrain source destroyed', 'AbortError'));
    }
    const elevationBlock = getElevationBlock(node.tile, TERRAIN_TILING);
    const imageryBlock = getImageryBlock(node.tile, TERRAIN_TILING);
    const elevationKey = tileKey(elevationBlock.tile);
    if (this.missingRasters.has(elevationKey)) {
      return Promise.reject(new MissingTerrainError(node.id));
    }

    const worker = this._pickWorker(elevationKey);
    const request: TerrainTileRequest = {
      key: node.id,
      epoch: this.epoch,
      tile: node.tile,
      sources: {
        elevationKey,
        elevationUrl: fillTileTemplate(this.props.elevationUrl, elevationBlock.tile),
        imageryKey: tileKey(imageryBlock.tile),
        imageryUrl: this.place.imageryUrl
          ? fillTileTemplate(this.place.imageryUrl, imageryBlock.tile)
          : null
      },
      origin: {longitude: this.place.longitude, latitude: this.place.latitude},
      sigma: this.props.sigma,
      thickness: this.props.thickness,
      relief: this.props.relief,
      haze: this.props.haze
    };

    if (signal.aborted) {
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    }

    return new Promise<TerrainTileColumns>((resolve, reject) => {
      const existing = this.inFlight.get(node.id);
      if (existing) {
        // The traversal does not ask twice for a page it is already loading, so this only happens if
        // a page was aborted and re-requested inside one frame. The newer waiter wins.
        existing.reject(new DOMException('superseded', 'AbortError'));
      }
      this.inFlight.set(node.id, {resolve, reject});
      this.workerLoad.set(worker, (this.workerLoad.get(worker) ?? 0) + 1);
      worker.postMessage(request);

      signal.addEventListener(
        'abort',
        () => {
          // Left in flight deliberately: the worker is probably already decoding, and its raster
          // decode is what the next tile of the same block wants. Only the waiter goes.
          if (this.inFlight.get(node.id)?.reject === reject) {
            this.inFlight.delete(node.id);
          }
          reject(new DOMException('aborted', 'AbortError'));
        },
        {once: true}
      );
    });
  }

  /** The worker already holding this raster, unless it is badly backed up; else the least loaded. */
  private _pickWorker(elevationKey: string): Worker {
    const affine = this.rasterWorker.get(elevationKey);
    const load = (worker: Worker) => this.workerLoad.get(worker) ?? 0;
    // Siblings are cheap once the raster lands, so affinity is allowed to run a worker over its share
    // before the same raster is fetched and decoded a second time somewhere else.
    if (affine && this.workers.includes(affine) && load(affine) < 16) {
      return affine;
    }
    let best = this.workers[0];
    for (const worker of this.workers) {
      if (load(worker) < load(best)) {
        best = worker;
      }
    }
    this.rasterWorker.delete(elevationKey);
    this.rasterWorker.set(elevationKey, best);
    if (this.rasterWorker.size > 512) {
      this.rasterWorker.delete(this.rasterWorker.keys().next().value!);
    }
    return best;
  }

  /** Rejects every in-flight request; see the workers' `onerror`. */
  private _failInFlight(error: Error): void {
    for (const pending of this.inFlight.values()) {
      pending.reject(error);
    }
    this.inFlight.clear();
    for (const worker of this.workers) {
      this.workerLoad.set(worker, 0);
    }
  }

  private _onWorkerMessage(worker: Worker, response: TerrainTileResponse): void {
    this.workerLoad.set(worker, Math.max(0, (this.workerLoad.get(worker) ?? 1) - 1));
    const pending = this.inFlight.get(response.key);

    // A result for a place we have already left: its positions are metres about an origin that no
    // longer exists. Transferred buffers are simply dropped.
    if (response.epoch !== this.epoch) {
      if (pending) {
        this.inFlight.delete(response.key);
        pending.reject(new DOMException('stale epoch', 'AbortError'));
      }
      return;
    }

    if (response.ok) {
      this.inFlight.delete(response.key);
      // A result nobody is waiting for is a page that was aborted while the worker was building it.
      // Its transferred buffers are unreferenced once this returns, which is the whole of the cleanup.
      pending?.resolve(response.columns);
      return;
    }

    this.inFlight.delete(response.key);
    if (response.missing) {
      this._onCoverageEnded(response.key);
      pending?.reject(new MissingTerrainError(response.key));
      return;
    }
    this._onTransportFailure(response.key);
    pending?.reject(new Error(response.error));
  }

  /**
   * The host has no archive here: take the node out of the tree, and its whole raster with it.
   *
   * Removing rather than marking is what keeps the traversal from asking again. `requestedLoads` is
   * rebuilt from the tree every frame for every node that is visible and not resident, so a node left
   * in place with nothing behind it is one rejected load per frame forever - which also consumes the
   * concurrency that real tiles need.
   */
  private _onCoverageEnded(key: string): void {
    const node = this.nodesByKey.get(key);
    if (!node) {
      return;
    }
    this.missingRasters.add(tileKey(getElevationBlock(node.tile, TERRAIN_TILING).tile));
    // Every sibling cut from the same raster goes too, without any of them having to ask.
    for (const candidate of [...this.nodesByKey.values()]) {
      if (candidate.tile.z === node.tile.z && this._isKnownMissing(candidate.tile)) {
        this._removeNode(candidate);
      }
    }
    this._scheduleNotify();
  }

  /**
   * A fetch failed for a reason that is not about coverage: take the node out and offer it later.
   *
   * Same reasoning as a 404 - a node left in the tree is re-requested every frame - but this one is
   * temporary, so it comes back. A node that has children is left alone instead: its subtree may be
   * resident, and it is only ever wanted as a fallback.
   */
  private _onTransportFailure(key: string): void {
    const node = this.nodesByKey.get(key);
    if (!node || node.children?.length || this.retrying.has(key)) {
      return;
    }
    const parent = node.parent;
    this._removeNode(node);
    this._scheduleNotify();
    this.retrying.set(
      key,
      setTimeout(() => {
        this.retrying.delete(key);
        if (this.destroyed || this.nodesByKey.has(key)) {
          return;
        }
        if (!parent) {
          // A root has nothing above it to hang back under: it goes straight back into the roots.
          this.roots = [...this.roots, this._createNode(node.tile, null)];
        } else if (this.nodesByKey.has(parent.id)) {
          parent.children = [...(parent.children ?? []), this._createNode(node.tile, parent)];
        } else {
          return;
        }
        this._scheduleNotify();
      }, RETRY_DELAY_MS)
    );
  }

  /** Detaches a node and its whole subtree from the tree and the index. */
  private _removeNode(node: TerrainNode): void {
    const parent = node.parent;
    if (parent?.children) {
      parent.children = parent.children.filter(child => child !== node);
    } else if (!parent) {
      this.roots = this.roots.filter(root => root !== node);
    }
    const stack: TerrainNode[] = [node];
    while (stack.length > 0) {
      const current = stack.pop()!;
      this.nodesByKey.delete(current.id);
      if (current.children) {
        stack.push(...current.children);
      }
    }
  }

  /**
   * Coalesces tree changes into one notification per frame.
   *
   * `setRoots` re-indexes the whole tree and re-runs the traversal, and a burst of four siblings
   * landing together would otherwise pay for that four times in one frame for the same result.
   */
  private _scheduleNotify(): void {
    if (this.notifyScheduled || this.destroyed) {
      return;
    }
    this.notifyScheduled = true;
    const flush = () => {
      this.notifyScheduled = false;
      if (this.destroyed) {
        return;
      }
      // A fresh array identity, because the layer compares `roots` by reference nowhere but the tree
      // is walked from it - and because a caller reading `roots` should not see it mutate underneath.
      this.roots = [...this.roots];
      for (const listener of this.listeners) {
        listener();
      }
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(flush);
    } else {
      setTimeout(flush, 0);
    }
  }
}

/** Thrown when a tile is outside the elevation host's coverage, which is not a failure. */
export class MissingTerrainError extends Error {
  constructor(key: string) {
    super(`no elevation archive for ${key}`);
    this.name = 'MissingTerrainError';
  }
}
