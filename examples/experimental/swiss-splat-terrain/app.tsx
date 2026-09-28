// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {
  AmbientLight,
  DirectionalLight,
  LightingEffect,
  MapView,
  TerrainController,
  type MapViewState
} from '@deck.gl/core';
import {TerrainLayer} from '@deck.gl/geo-layers';
import {DeckGL} from '@deck.gl/react';
import {luma} from '@luma.gl/core';
import type {SplatSource} from '@luma.gl/splats';
import type {Device} from '@luma.gl/core';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';

import type {SphericalHarmonicsDegree} from './gaussian-ply';
import {
  loadPlySceneOnWorker,
  loadSplatArchiveManifest,
  SplatArchiveSource
} from './splat-archive-source';
import {
  getNodeTransferByteLength,
  type SplatArchiveDegree,
  type SplatArchiveManifest
} from './splat-archive';
import {SplatLayer, type SplatBackendKind, type SplatStreamingStats} from '@deck.gl/splat-layers';
import {
  ELEVATION_DECODER,
  getPlaceCamera,
  INITIAL_VIEW_STATE,
  LOCAL_ARCHIVE_BASE,
  SITE,
  SPLAT_SCENES,
  SURFACE_IMAGE,
  TERRAIN_IMAGE,
  type SplatScene
} from './scenes';
import {
  LIVE_SPLATS_PER_TILE,
  TerrainSplatSource,
  type TerrainSourceStats
} from './terrain-splat-source';
import {TERRAIN_SURFEL_DEFAULTS} from './terrain-surfels';
import {createSplatWebGPUAdapter, getMaxResidentSplats} from './splat-device';
import './styles.css';

/**
 * Device selection, resolved once before `Deck` is constructed.
 *
 * deck.gl defaults `deviceProps.type` to `'webgl'`, so WebGPU has to be asked for explicitly.
 * It is worth asking for: on WebGPU the splat layer binds luma.gl's `GPUSplatGraphRenderer`,
 * which projects, culls, depth-sorts and draws entirely in GPU compute, while WebGL2 falls back
 * to a CPU sort plus a full attribute repack every time the camera moves. `?device=webgl` forces
 * the fallback so the two can be compared side by side.
 */
/**
 * Whether this build is running the promoted `@deck.gl/splat-layers`, from `vite.config.mjs`.
 *
 * A handful of fidelity controls live only there, because they call `@luma.gl/splats` options that no
 * published release carries. Reading a build-time flag means they are offered exactly when they work
 * rather than passed as props nothing consumes.
 */
declare const __PROMOTED_SPLAT_LAYER__: boolean;
const PROMOTED_LAYER =
  typeof __PROMOTED_SPLAT_LAYER__ === 'boolean' ? __PROMOTED_SPLAT_LAYER__ : false;

const urlParams = new URLSearchParams(window.location.search);
const requestedDevice = urlParams.get('device');
/** See `splat-device.ts`: luma.gl's adapter, asking for a storage binding the splats can fill. */
const SPLAT_ADAPTER = createSplatWebGPUAdapter();
const supportsWebGPU = luma.getBestAvailableAdapterType([SPLAT_ADAPTER]) === 'webgpu';
const deviceType: 'webgpu' | 'webgl' =
  requestedDevice === 'webgl' ? 'webgl' : supportsWebGPU ? 'webgpu' : 'webgl';

/**
 * How much of the GPU a streamed scene is allowed to hold, in splats.
 *
 * A ceiling, not a target: the level-of-detail traversal normally stops at
 * `maximumScreenSpaceError` long before this binds. On a live terrain scene at a close camera it
 * binds *first*, and that is what mixed resolution across one view actually is -- the budget fills,
 * every further page is refused, and refinement stops wherever each branch happened to have reached.
 * A page is charged against the budget before its fetch starts, so one that cannot fit is never
 * downloaded; but it is re-offered, refused and re-offered on every frame.
 *
 * It is also the layer's renderer reservation, so it decides how large the graph's sort and
 * projected-record buffers are. Lower on WebGL2, where every frontier change is a CPU resort.
 *
 * **What the ceiling is depends on the device, so it is read from the device.** The graph keeps its
 * projected records in one storage binding, and 48 bytes a splat against WebGPU's default 128 MiB
 * is about 2.1M after the reservation factor. `splat-device.ts` asks for 512 MiB instead, which is
 * 8.6M -- so the ladder below is offered as far up as the device granted and no further. Measured on
 * the Matterhorn at 2 px: 1.6M settles at zoom 15 while refusing ~28,000 pages a frame, 3.2M reaches
 * zoom 17, and 6.4M reaches zoom 17 with the refusals down to ~5,000, which is a frontier that has
 * very nearly converged.
 */
const RESIDENCY_LADDER = [400_000, 800_000, 1_600_000, 3_200_000, 6_400_000] as const;

/**
 * What the ladder is capped at by default, when the device allows more.
 *
 * Not the top rung: the reservation is allocated up front, so 6.4M costs about 400 MB of projected
 * records before a single page has landed. 3.2M is where the picture stops being the limiting factor
 * on this camera -- zoom 17, the finest the elevation source has -- for half that. The top rung stays
 * in the list for anyone who wants the frontier to stop refusing pages altogether.
 */
const PREFERRED_RESIDENCY = 3_200_000;

/** Budget before the device has answered: WebGPU's guaranteed floor, and safe everywhere. */
const CONSERVATIVE_MAX_RESIDENT = getMaxResidentSplats(null);

/** Largest rung the ladder can ever offer, which is what the node reservation is sized from. */
const MAX_LADDER_RESIDENCY = RESIDENCY_LADDER[RESIDENCY_LADDER.length - 1];

function getResidencyOptions(maxResidentSplats: number): number[] {
  const options = RESIDENCY_LADDER.filter(value => value <= maxResidentSplats);
  return options.length > 0 ? options : [RESIDENCY_LADDER[0]];
}

/** The rung this device should start on: as high as the ladder and the preference both allow. */
function getPreferredResidency(maxResidentSplats: number, type: 'webgpu' | 'webgl'): number {
  if (type !== 'webgpu') {
    return 400_000;
  }
  const options = getResidencyOptions(Math.min(maxResidentSplats, PREFERRED_RESIDENCY));
  return options[options.length - 1];
}

const DEFAULT_RESIDENCY = getPreferredResidency(CONSERVATIVE_MAX_RESIDENT, deviceType);

/**
 * Splat budget for the unbaked fallback path, where the whole scene is one resident batch.
 *
 * Fixed rather than a control: on that path the budget is applied during the load, so changing it
 * means downloading the PLY again. On a baked scene the equivalent dial is residency, which
 * changes nothing that is already on the GPU.
 */
const PLY_FALLBACK_BUDGET = deviceType === 'webgpu' ? 1_600_000 : 400_000;

/** Geometric error, in pixels, a level-of-detail node may project to before it is refined. */
const DETAIL_OPTIONS = [1, 2, 4, 8] as const;
const DEFAULT_DETAIL = deviceType === 'webgpu' ? 2 : 8;

/** Bytes one row of a GraphDECO PLY occupies: 62 float32 properties. */
const PLY_BYTES_PER_SPLAT = 248;

/**
 * Minimum fragment opacity kept after a Gaussian's falloff, and why it is so far above the
 * layer's own default.
 *
 * The default of `0.5 / 255` keeps every fragment that could still change an 8-bit channel, which
 * is the right answer for a trained reconstruction: there the far tail of a Gaussian is doing
 * real work, because the scene was optimized in the knowledge that it would be blended. Terrain
 * splats are not trained, they are a regular grid of discs sized to overlap their neighbours by a
 * known amount -- so the tail is not carrying detail, it is a fringe on every one of 1.4 million
 * discs, stacked tens deep along the view ray. Cutting it at 2% is what separates a surface from
 * a fog of it, and it is also most of the overdraw.
 */
const SPLAT_ALPHA_CUTOFF = 0.02;

/**
 * Nodes the live renderer's command graph is compiled for.
 *
 * Reserved capacity, and it has to cover the largest residency option divided by the splats in a
 * node, plus whatever the fade ramps are still drawing on top of the frontier. A frontier that fits
 * inside the reservation costs a pointer swap; one that does not rebuilds every buffer the graph
 * owns, which is a visible hitch - so this is set from the *ceiling* rather than from the default.
 */
const LIVE_MAX_RESIDENT_NODES = Math.ceil((MAX_LADDER_RESIDENCY / LIVE_SPLATS_PER_TILE) * 1.3);

/** Degrees a second the camera drifts round when nobody is touching it. */
const ORBIT_DEGREES_PER_SECOND = 1.6;
/** Milliseconds of stillness before the drift resumes after an interaction. */
const ORBIT_RESUME_MS = 3500;

/** Anti-popping ramp lengths, as the layer's fade props. See `SplatLayer.fadeInDuration`. */
const FADES_ON = {fadeInDuration: 300, fadeOutDuration: 150, fadeHoldDuration: 2000};
const FADES_OFF = {fadeInDuration: 0, fadeOutDuration: 0, fadeHoldDuration: 0};

/**
 * The same sun the terrain baker shades its splats with, pointed at the mesh underneath them.
 *
 * `bake-terrain-splats.ts` bakes a north-west light into each splat's DC colour, which the splat
 * renderer has no lighting stage to apply for it. The `TerrainLayer` mesh does have one, and it
 * is visible: through the gaps on cliffs past the slope-stretch ceiling, and everywhere beyond
 * the archive's own 3.4 km footprint. Lit differently it reads as a flat cut-out against shaded
 * splats, so the two are matched here rather than left to disagree.
 *
 * `direction` is the direction the light *travels*, in deck.gl's common space -- where x is east,
 * y increases **southward** and z is up. The baker's sun vector points the other way, in an
 * east/north/up frame, so this is that vector negated with its northing sign flipped:
 * `[-0.48, 0.42, 0.77]` east/north/up becomes `[0.48, 0.42, -0.77]` here.
 */
const TERRAIN_LIGHTING = new LightingEffect({
  // Split 0.68 / 0.32 to match the baker's `1 - relief` and `relief` exactly, so a slope carries
  // the same brightness whichever surface is drawing it. See DEFAULT_RELIEF in the baker.
  ambientLight: new AmbientLight({color: [255, 255, 255], intensity: 1}),
  sun: new DirectionalLight({
    color: [255, 255, 255],
    intensity: 1,
    direction: [0.48, 0.42, -0.77]
  })
});

/** Matches the baker's `shade = (1 - relief) + relief * lambert`, with no specular term. */
const TERRAIN_MATERIAL = {
  ambient: 0.68,
  diffuse: 0.32,
  shininess: 1,
  specularColor: [0, 0, 0] as [number, number, number]
};

type LoadState =
  | {phase: 'probing'}
  /** An archive is streaming. */
  | {phase: 'streaming'}
  /** A live raster endpoint is being cut into tiles in the browser. */
  | {phase: 'live'}
  /** No archive, and the scene has no source file to fall back to. */
  | {phase: 'unbaked'}
  /** No archive, but a PLY exists; waiting for the visitor to accept the download. */
  | {phase: 'confirm'; byteLength: number}
  | {phase: 'ply'; loadedBytes: number; totalBytes?: number; splatCount: number}
  | {phase: 'ply-ready'; splatCount: number; loadedBytes: number; elapsedMs: number}
  | {phase: 'error'; message: string};

/** Which of the three load paths the current scene came in on. */
type ScenePayload =
  | {kind: 'archive'; source: SplatArchiveSource}
  | {kind: 'live'; source: TerrainSplatSource}
  | {kind: 'ply'; sources: SplatSource[]};

/** Probed once at startup: a manifest per scene, or `null` where nothing is published. */
type ArchiveAvailability = Map<string, SplatArchiveManifest | null>;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  }
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatCount(count: number): string {
  return count.toLocaleString('en-US');
}

function formatSpacing(meters: number | null): string {
  if (meters === null) {
    return '—';
  }
  return meters < 1
    ? `${(meters * 100).toFixed(0)} cm`
    : `${meters.toFixed(meters < 10 ? 1 : 0)} m`;
}

/**
 * The spread of zoom levels in the frontier, which is the argument in one number.
 *
 * Every one of these levels is in a single global depth order, every frame. That is the thing a
 * per-tile architecture cannot express, and the reason a quadtree of *transparent* primitives is
 * tractable at all - so it is worth putting on screen.
 */
function formatZoomRange(stats: SplatStreamingStats): string {
  let lowest = Infinity;
  let highest = -Infinity;
  for (const entry of stats.frontier) {
    const zoom = Number(entry.node.id.slice(0, entry.node.id.indexOf('/')));
    if (!Number.isFinite(zoom)) {
      return '—';
    }
    lowest = Math.min(lowest, zoom);
    highest = Math.max(highest, zoom);
  }
  if (highest < 0) {
    return '—';
  }
  return lowest === highest ? String(lowest) : `${lowest}–${highest}`;
}

/** Ground metres between neighbouring splats in the finest tile being drawn. */
function getFinestSpacing(stats: SplatStreamingStats): number | null {
  let finest = Infinity;
  for (const entry of stats.frontier) {
    finest = Math.min(finest, entry.node.geometricError);
  }
  return Number.isFinite(finest) ? finest : null;
}

/** Base URL of the archive for a scene: `?archive=` wins, then the scene, then the local bake. */
function getArchiveBaseUrl(scene: SplatScene): string {
  const override = urlParams.get('archive');
  if (override) {
    return override.endsWith('/') ? override : `${override}/`;
  }
  if (scene.archiveUrl) {
    return scene.archiveUrl;
  }
  return new URL(`${LOCAL_ARCHIVE_BASE}${scene.id}/`, window.location.href).href;
}

/** Bytes a fully resident archive would cost at a degree, for the picker's labels. */
function getArchiveByteLength(manifest: SplatArchiveManifest, degree: SplatArchiveDegree): number {
  const resolved = Math.min(
    degree,
    manifest.scene.maxSphericalHarmonicsDegree
  ) as SplatArchiveDegree;
  return manifest.nodes.reduce(
    (total, node) => total + getNodeTransferByteLength(node, resolved),
    0
  );
}

export default function App() {
  // `?scene=<id>` picks a scene on load. The default is the first entry, which is the first live
  // place: it downloads nothing but map tiles, so it cannot start a several-hundred-megabyte
  // fetch merely by being selected, and it is the half of the example that needs no bake first.
  // `?scene=lauterbrunnen-terrain` opens the published archive of the same ground instead.
  const [sceneId, setSceneId] = useState(
    () => SPLAT_SCENES.find(entry => entry.id === urlParams.get('scene'))?.id ?? SPLAT_SCENES[0].id
  );
  const [shDegree, setShDegree] = useState<SplatArchiveDegree>(1);
  /**
   * The degree the current archive was *loaded* at, which only ever ratchets upward.
   *
   * luma.gl clamps the evaluated degree per batch to what that batch actually carries, so
   * lowering the rendered degree costs nothing and needs no new data. Raising it past what is
   * resident does need new data -- but only the extra band files: the core chunks are the same
   * bytes and come back from the HTTP cache. Reset on a scene change so switching scenes does
   * not inherit bands nobody is looking at.
   */
  const [archiveDegree, setArchiveDegree] = useState<SplatArchiveDegree>(1);
  const [sizeMeters, setSizeMeters] = useState<number>(() => SPLAT_SCENES[0].sizeMeters);
  const [detailPixels, setDetailPixels] = useState<number>(DEFAULT_DETAIL);
  const [residencyLimit, setResidencyLimit] = useState<number>(DEFAULT_RESIDENCY);
  /**
   * What this device's storage binding can actually hold, which is not known until it exists.
   *
   * Starts at WebGPU's guaranteed floor so the first frames cannot reserve a buffer the graph will
   * throw on, and is raised once `onDeviceInitialized` reports what was granted. Moving the budget
   * afterwards admits pages; it re-downloads nothing and rebuilds no graph.
   */
  const [maxResidentSplats, setMaxResidentSplats] = useState<number>(CONSERVATIVE_MAX_RESIDENT);
  const residencyOptions = useMemo(
    () => getResidencyOptions(maxResidentSplats),
    [maxResidentSplats]
  );
  const onDeviceInitialized = useCallback((device: Device) => {
    const granted = getMaxResidentSplats(device);
    setMaxResidentSplats(granted);
    // Only ever upward, and only to the rung this device is meant to start on -- a visitor who has
    // already chosen a budget by the time the device answers keeps it.
    setResidencyLimit(current =>
      Math.max(
        current,
        getPreferredResidency(granted, device.type === 'webgpu' ? 'webgpu' : 'webgl')
      )
    );
  }, []);
  const [showSplats, setShowSplats] = useState(true);
  const [showMeshTexture, setShowMeshTexture] = useState(true);
  const [wireframe, setWireframe] = useState(false);
  const [availability, setAvailability] = useState<ArchiveAvailability | null>(null);
  /** Scenes the visitor has explicitly agreed to download the unbaked PLY for. */
  const [confirmedDownloads, setConfirmedDownloads] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [payload, setPayload] = useState<ScenePayload | null>(null);
  const [backend, setBackend] = useState<SplatBackendKind | null>(null);
  const [load, setLoad] = useState<LoadState>({phase: 'probing'});
  const [streaming, setStreaming] = useState<SplatStreamingStats | null>(null);
  const [sourceStats, setSourceStats] = useState<TerrainSourceStats | null>(null);
  const [fades, setFades] = useState(true);
  const [analytic, setAnalytic] = useState(true);
  const [orbiting, setOrbiting] = useState(true);
  const [viewState, setViewState] = useState<MapViewState>(() => ({...INITIAL_VIEW_STATE}));

  const scene = useMemo(
    () => SPLAT_SCENES.find(entry => entry.id === sceneId) ?? SPLAT_SCENES[0],
    [sceneId]
  );

  useEffect(() => {
    setSizeMeters(scene.sizeMeters);
  }, [scene]);

  /**
   * Asks every scene, once, whether an archive is published for it.
   *
   * The picker is then built from the answers rather than from the scene list, so what it offers
   * is what actually exists and what each choice will cost. Each probe is one small JSON
   * document, and a miss is an expected answer rather than an error -- an unbaked scene is the
   * normal state of a fresh checkout.
   */
  useEffect(() => {
    const abortController = new AbortController();
    let cancelled = false;

    Promise.all(
      SPLAT_SCENES.map(async entry => {
        try {
          const manifest = await loadSplatArchiveManifest(
            getArchiveBaseUrl(entry),
            abortController.signal
          );
          return [entry.id, manifest] as const;
        } catch {
          return [entry.id, null] as const;
        }
      })
    ).then(entries => {
      if (!cancelled) {
        setAvailability(new Map(entries));
      }
    });

    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, []);

  /**
   * Resolves the selected scene into something the layer can draw.
   *
   * Three outcomes, and only one of them moves any real data unasked. An archive streams. A scene
   * with no archive and no source file says so and stops. A scene with no archive but a
   * multi-hundred-megabyte PLY behind it waits for an explicit yes -- which is the point of the
   * gate: the previous version started that download because the page had loaded, for a scene
   * nobody had chosen.
   */
  useEffect(() => {
    // A live scene waits for nothing: there is no manifest to probe and no file to download, so it
    // is built the moment it is selected. It also owns a worker pool and a growing node tree, which
    // is why it is the one payload with a destructor.
    if (scene.kind === 'live-terrain' && scene.place) {
      setStreaming(null);
      setSourceStats(null);
      const source = new TerrainSplatSource({
        place: scene.place,
        elevationUrl: TERRAIN_IMAGE,
        // The baker's numbers, not a second copy of them: both halves take the surfel's shape
        // from one place, so the only thing that differs between `Lauterbrunnen terrain` and
        // `Lauterbrunnen, live` is where the splats came from.
        sigma: TERRAIN_SURFEL_DEFAULTS.sigma,
        thickness: TERRAIN_SURFEL_DEFAULTS.thickness,
        relief: TERRAIN_SURFEL_DEFAULTS.relief,
        lift: TERRAIN_SURFEL_DEFAULTS.lift,
        // No haze: the mesh below continues past the splat frontier, so there is no edge to hide,
        // and leaving the colours alone is what makes a live scene and the archive the same picture.
        // See TERRAIN_HAZE.
        haze: null,
        maxResidentNodes: LIVE_MAX_RESIDENT_NODES
      });
      setPayload({kind: 'live', source});
      setLoad({phase: 'live'});
      return () => {
        // Before the layer is told, deliberately: the layer releases the pages, and this only stops
        // the workers from building more of them for a place nobody is looking at.
        source.destroy();
      };
    }

    if (!availability) {
      return undefined;
    }

    const abortController = new AbortController();
    const {signal} = abortController;
    let cancelled = false;

    setPayload(null);
    setStreaming(null);

    const manifest = availability.get(scene.id);
    if (manifest) {
      setPayload({
        kind: 'archive',
        source: new SplatArchiveSource(manifest, getArchiveBaseUrl(scene), archiveDegree)
      });
      setLoad({phase: 'streaming'});
      return undefined;
    }

    const plyUrls = scene.urls ?? scene.fallbackUrls;
    if (!plyUrls?.length) {
      setLoad({phase: 'unbaked'});
      return undefined;
    }
    if (!confirmedDownloads.has(scene.id)) {
      setLoad({phase: 'confirm', byteLength: scene.splatCount * PLY_BYTES_PER_SPLAT});
      return undefined;
    }

    const startedAt = performance.now();
    let lastProgressAt = 0;
    // What the worker has actually pulled down, which is the only honest figure to set against an
    // archive -- a decoded row count says nothing about the bytes it cost.
    let transferredBytes = 0;

    (async () => {
      setLoad({phase: 'ply', loadedBytes: 0, splatCount: 0});
      const urlCandidates = [
        ...(scene.urls ? [scene.urls] : []),
        ...(scene.fallbackUrls ? [scene.fallbackUrls] : [])
      ];
      let lastError: unknown;

      for (const urls of urlCandidates) {
        try {
          const source = await loadPlySceneOnWorker(
            urls,
            Math.min(archiveDegree, 3) as SphericalHarmonicsDegree,
            PLY_FALLBACK_BUDGET,
            {
              signal,
              onProgress: (loadedBytes, totalBytes, splatCount) => {
                transferredBytes = loadedBytes;
                const now = performance.now();
                if (now - lastProgressAt < 120 || cancelled) {
                  return;
                }
                lastProgressAt = now;
                setLoad({
                  phase: 'ply',
                  loadedBytes,
                  ...(totalBytes === undefined ? {} : {totalBytes}),
                  splatCount
                });
              }
            }
          );
          if (cancelled) {
            return;
          }
          setPayload({kind: 'ply', sources: [source]});
          setLoad({
            phase: 'ply-ready',
            splatCount: source.opacities.length,
            loadedBytes: transferredBytes,
            elapsedMs: performance.now() - startedAt
          });
          return;
        } catch (error) {
          if (cancelled || signal.aborted) {
            return;
          }
          lastError = error;
        }
      }

      setLoad({
        phase: 'error',
        message: lastError instanceof Error ? lastError.message : String(lastError)
      });
    })();

    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [scene, archiveDegree, availability, confirmedDownloads]);

  /**
   * The camera, reset whenever the scene changes and animated when nothing is touching it.
   *
   * Held in React rather than left to `initialViewState`, because the orbit has to write to it - and
   * because each live place frames its own subject, so selecting one has to move the camera there.
   */
  const interactionAt = useRef(0);
  useEffect(() => {
    const place = scene.place;
    setViewState({
      ...INITIAL_VIEW_STATE,
      ...(place
        ? {
            longitude: place.longitude,
            latitude: place.latitude,
            // Derived from the place's distance and elevation angle against the window it is being
            // shown in, rather than stored as a zoom that would frame differently on every screen.
            ...getPlaceCamera(place, window.innerHeight),
            bearing: place.bearing,
            // Lifts the point the camera aims at off the sea-level plane and onto the mountain.
            // See `TerrainPlace.lookAtAltitude`.
            position: [0, 0, place.lookAtAltitude]
          }
        : {})
    });
    interactionAt.current = 0;
  }, [scene]);

  useEffect(() => {
    if (!orbiting) {
      return undefined;
    }
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const elapsedSeconds = Math.min(0.1, (now - previous) / 1000);
      previous = now;
      // Resumes only after the pointer has been still a while, so a drag is never fought.
      if (now - interactionAt.current > ORBIT_RESUME_MS) {
        setViewState(current => ({
          ...current,
          bearing: ((current.bearing ?? 0) + ORBIT_DEGREES_PER_SECOND * elapsedSeconds) % 360
        }));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [orbiting]);

  /** Traversal counters arrive on every frontier change, which is far faster than React wants. */
  const lastStatsAt = useRef(0);
  const onStreamingStats = useCallback((stats: SplatStreamingStats) => {
    const now = performance.now();
    if (now - lastStatsAt.current < 250) {
      return;
    }
    lastStatsAt.current = now;
    setStreaming(stats);
  }, []);

  // The source's own counters are not event-driven - tiles are built on workers - so they are polled
  // at the same rate the traversal counters are throttled to.
  useEffect(() => {
    if (payload?.kind !== 'live') {
      return undefined;
    }
    const source = payload.source;
    setSourceStats(source.getStats());
    const timer = setInterval(() => setSourceStats(source.getStats()), 250);
    return () => clearInterval(timer);
  }, [payload]);

  const onSceneChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      setSceneId(event.target.value);
      setArchiveDegree(shDegree);
    },
    [shDegree]
  );

  const onDegreeChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
    const degree = Number(event.target.value) as SplatArchiveDegree;
    setShDegree(degree);
    setArchiveDegree(current => Math.max(current, degree) as SplatArchiveDegree);
  }, []);

  const onConfirmDownload = useCallback(() => {
    setConfirmedDownloads(current => new Set(current).add(scene.id));
  }, [scene.id]);

  const residencyBudget = useMemo(() => ({maxResidentSplats: residencyLimit}), [residencyLimit]);

  const archive = payload?.kind === 'archive' ? payload.source : undefined;
  const live = payload?.kind === 'live' ? payload.source : undefined;
  const place = scene.place;
  const georeference = archive?.manifest.scene.georeference;
  // A live scene stores no harmonics at all - an orthophoto looks the same from every direction - an
  // archive says what it carries, and a capture is assumed to carry all three bands until one does.
  const maxAvailableDegree = live ? 0 : (archive?.summary.maxSphericalHarmonicsDegree ?? 3);
  // A live place carries the imagery its own splats were coloured from, and the Copernicus places
  // carry none; the archive is Lauterbrunnen, which is SWISSIMAGE.
  const meshTexture = place ? place.imageryUrl : SURFACE_IMAGE;

  const layers = [
    /**
     * The mesh every terrain scene is drawn over, live or baked.
     *
     * It does four things, and a live scene wants all four exactly as much as the archive does: it
     * writes the depth that occludes splats behind a ridge, which is the whole point of sharing one
     * render pass; it continues past the splat frontier to the horizon, so a streamed scene ends in
     * terrain rather than in mid air; it is the opaque surface that stops the sky showing through
     * wherever the splats have not landed yet; and it is what `TerrainController` picks against.
     *
     * It was dropped from the live scenes because at `meshMaxError: 4` the triangles are a coarser
     * reading of the surface than one splat per elevation sample, so on a convex ridge the mesh cuts
     * outside the splats and hides them. That is a real problem with a known answer, and the baker
     * has used it all along: push each splat a few metres along its own normal. So the live source
     * now lifts by the baker's `TERRAIN_SURFEL_DEFAULTS.lift` instead, and the mesh comes back.
     *
     * The texture is the place's own orthophoto - the same imagery the splats are coloured from, so
     * the two agree rather than arguing. Where a place has none (the Copernicus scenes), both come
     * up as bare relief, and `TERRAIN_MATERIAL` is split to the baker's `1 - relief` / `relief`
     * exactly so an unlit mesh and a relief-shaded splat land on the same brightness.
     *
     * Every scene gets it, including the reconstructions dropped onto the valley floor: a capture
     * half-behind a ridge is the clearest demonstration in the example that the two primitives
     * share one depth buffer.
     */
    new TerrainLayer({
      id: 'swiss-terrain',
      elevationData: TERRAIN_IMAGE,
      elevationDecoder: ELEVATION_DECODER,
      // Dropping the texture leaves bare relief under the splats, which is how to see what the
      // splats themselves contribute. The mesh stays in the scene either way: it writes the depth
      // that occludes distant splats, and it is what the terrain-following camera picks against,
      // so removing it outright would take the controller down with it.
      ...(showMeshTexture && meshTexture ? {texture: meshTexture} : {}),
      // SWISSIMAGE serves 256px tiles, so matching the scheme keeps the orthophoto at native
      // resolution instead of upsampling it across Mapterhorn's 512px elevation tiles.
      tileSize: 256,
      minZoom: 0,
      maxZoom: 17,
      refinementStrategy: 'best-available',
      meshMaxError: 4,
      wireframe,
      color: showMeshTexture && meshTexture ? [255, 255, 255] : [56, 60, 66],
      material: TERRAIN_MATERIAL,
      // Scoped to this layer: a global cullMode would also cull the splat quads.
      parameters: {cullMode: 'back'},
      pickable: '3d'
    }),
    showSplats && payload
      ? new SplatLayer({
          id: 'swiss-splats',
          ...(payload.kind === 'ply'
            ? {splatSource: payload.sources}
            : {
                splatHierarchy: payload.source,
                maximumScreenSpaceError: detailPixels,
                residencyBudget,
                // No page of a streamed scene has seen enough centers to normalize it. An archive
                // carries the percentiles in its manifest for exactly this reason; a live scene does
                // not need them, because it is georeferenced and placed one to one.
                ...(payload.kind === 'archive'
                  ? {scenePercentiles: payload.source.manifest.scene.percentiles}
                  : {})
              }),
          // A georeferenced scene knows where it belongs and is placed one to one; a capture has
          // arbitrary units and is normalized onto the anchor. A live scene's splats are metres about
          // its place, with scene z the elevation itself, so its anchor sits at exactly 0 m.
          coordinateOrigin: live
            ? [place!.longitude, place!.latitude, 0]
            : georeference
              ? [georeference.longitude, georeference.latitude, georeference.altitude]
              : [SITE.longitude, SITE.latitude, SITE.groundAltitude],
          georeferenced: Boolean(live || georeference),
          sizeMeters,
          heading: scene.heading,
          upAxis: scene.upAxis,
          sphericalHarmonicsDegree: shDegree,
          alphaCutoff: SPLAT_ALPHA_CUTOFF,
          // Integrating each Gaussian over the pixel footprint rather than sampling its centre, which
          // is what keeps a hillside of sub-pixel splats from crawling as the camera turns. It costs
          // roughly a tenth of the frame and is the largest fidelity difference at distance - and it
          // exists only on the promoted layer, because it needs an unreleased luma.gl shader option.
          ...(PROMOTED_LAYER ? {fragmentKernel: analytic ? 'analytic' : 'gaussian'} : {}),
          ...(fades ? FADES_ON : FADES_OFF),
          // The mesh, where there is one, already wrote depth into this pass.
          depthCompare: 'less-equal',
          depthWriteEnabled: false,
          parameters: {cullMode: 'none'},
          onBackendChange: setBackend,
          onStreamingStats
        })
      : null
  ];

  const isStreaming = Boolean(archive || live);

  return (
    <>
      <DeckGL
        views={new MapView()}
        // Controlled rather than initial, because the orbit writes to it and each live place frames
        // its own subject, so choosing one has to move the camera there.
        viewState={viewState}
        onViewStateChange={({viewState: next}) => {
          // Any interaction parks the orbit; it resumes once the pointer has been still a while.
          interactionAt.current = performance.now();
          setViewState(next as MapViewState);
        }}
        // Only the terrain mesh reads this; the splat layer carries its light already baked in.
        effects={[TERRAIN_LIGHTING]}
        // WebGPU when the browser has it. The splat layer binds a fully GPU-side renderer there
        // and a CPU-sorting fallback on WebGL2; `?device=webgl` forces the fallback.
        deviceProps={{type: deviceType, adapters: [SPLAT_ADAPTER]}}
        onDeviceInitialized={onDeviceInitialized}
        // TerrainController reads the elevation under the viewport centre from the terrain
        // layer's `pickable: '3d'` depth pass, so the camera follows the valley floor instead
        // of orbiting the sea-level plane and clipping through the ridges. It also defaults to
        // `rotationPivot: '3d'`, rotating about the terrain point under the pointer.
        //
        // The archive wants that and a live place does not, even though both now draw the mesh it
        // picks against. A live place is framed by hand - `lookAtAltitude`, `elevationDeg` and
        // `rangeMeters` are chosen per subject, and the whole point of the numbers is which part of
        // the mountain fills the window. Letting the controller pull the centre down onto the
        // terrain overrides exactly those numbers: it flattens Lauterbrunnen's look *into* the
        // valley out across it, and swings the horizon into frame. So a live scene keeps the plain
        // map controller and the framing it was given.
        controller={live ? {inertia: true} : {type: TerrainController, inertia: true}}
        layers={layers}
        getTooltip={({coordinate, picked}) =>
          picked && coordinate && coordinate.length === 3
            ? `Elevation: ${coordinate[2].toFixed(0)} m`
            : null
        }
      />

      <aside className="panel">
        <p className="eyebrow">
          Mapterhorn · {live ? (place?.imageryCredit ?? 'relief only') : 'SWISSIMAGE'} ·{' '}
          {live ? 'GeoArrow → luma.gl splats' : 'luma.gl splats'}
        </p>
        <h1>{scene.label}</h1>
        <p className="description">{scene.description}</p>

        <label className="field">
          <span>Splat scene</span>
          <select value={sceneId} onChange={onSceneChange}>
            {SPLAT_SCENES.map(entry => {
              const manifest = availability?.get(entry.id);
              if (entry.kind === 'live-terrain') {
                return (
                  <option key={entry.id} value={entry.id}>
                    {entry.label} — built in the browser, nothing to download
                  </option>
                );
              }
              const detail = !availability
                ? 'checking…'
                : manifest
                  ? `baked, ${formatBytes(getArchiveByteLength(manifest, archiveDegree))}`
                  : entry.urls || entry.fallbackUrls
                    ? `not baked, ${formatBytes(entry.splatCount * PLY_BYTES_PER_SPLAT)} PLY`
                    : 'not baked';
              return (
                <option key={entry.id} value={entry.id}>
                  {entry.label} — {formatCount(manifest?.scene.splatCount ?? entry.splatCount)}{' '}
                  splats · {detail}
                </option>
              );
            })}
          </select>
        </label>

        {isStreaming && (
          <>
            <label className="field">
              <span>Detail</span>
              {/* A node's geometric error is the spacing of its own splats, so this reads
                  directly: at 2, refinement continues until the splats being looked at sit about
                  two pixels apart. */}
              <select
                value={detailPixels}
                onChange={event => setDetailPixels(Number(event.target.value))}
              >
                {DETAIL_OPTIONS.map(pixels => (
                  <option key={pixels} value={pixels}>
                    {pixels} px error{pixels === DEFAULT_DETAIL ? ' — default' : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>GPU residency</span>
              {/* A ceiling rather than a target, and the layer's renderer reservation. Changing
                  it admits or evicts pages; nothing is re-downloaded and no graph is rebuilt. */}
              <select
                value={residencyLimit}
                onChange={event => setResidencyLimit(Number(event.target.value))}
              >
                {residencyOptions.map(limit => (
                  <option key={limit} value={limit}>
                    {formatCount(limit / 1000)}k splats
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        {maxAvailableDegree > 0 ? (
          <label className="field">
            <span>Spherical harmonics</span>
            {/* Discrete, not a slider: the degree decides how many coefficients are *stored*, not
                just how many are evaluated. Lowering it is free -- the renderer clamps per batch
                -- and raising it fetches only the extra band files, never the geometry again. */}
            <select value={shDegree} onChange={onDegreeChange}>
              {([0, 1, 2, 3] as const)
                .filter(degree => degree <= maxAvailableDegree)
                .map(degree => (
                  <option key={degree} value={degree}>
                    {degree === 0
                      ? 'Degree 0 — DC only, lightest'
                      : `Degree ${degree} — +${(degree + 1) ** 2 * 3 - 3} coefficients/splat`}
                  </option>
                ))}
            </select>
          </label>
        ) : (
          <p className="note">
            No spherical-harmonic control: an orthophoto looks the same from every direction, so
            {live ? ' these tiles carry' : ' this archive stores'} a DC term only and there is no
            view-dependent band to evaluate.
          </p>
        )}

        {!georeference && !live && (
          <label className="field">
            <span>Footprint: {sizeMeters} m</span>
            {/* Only a capture needs this: it arrives in arbitrary units and has to be given a
                size. A georeferenced archive is already in metres and is placed one to one. */}
            <input
              type="range"
              min={10}
              max={400}
              step={5}
              value={sizeMeters}
              onChange={event => setSizeMeters(Number(event.target.value))}
            />
          </label>
        )}

        <div className="toggles">
          <label>
            <input
              type="checkbox"
              checked={showSplats}
              onChange={event => setShowSplats(event.target.checked)}
            />
            <span>Splats</span>
          </label>
          {meshTexture && (
            <label>
              <input
                type="checkbox"
                checked={showMeshTexture}
                onChange={event => setShowMeshTexture(event.target.checked)}
              />
              <span>Mesh texture</span>
            </label>
          )}
          <label>
            <input
              type="checkbox"
              checked={wireframe}
              onChange={event => setWireframe(event.target.checked)}
            />
            <span>Wireframe</span>
          </label>
          {isStreaming && (
            <label title="Ramp a page up as it arrives, and hold the page it replaces until the ramp finishes.">
              <input
                type="checkbox"
                checked={fades}
                onChange={event => setFades(event.target.checked)}
              />
              <span>Fades</span>
            </label>
          )}
          {PROMOTED_LAYER && (
            <label title="Integrate each Gaussian over the pixel footprint instead of sampling its centre.">
              <input
                type="checkbox"
                checked={analytic}
                onChange={event => setAnalytic(event.target.checked)}
              />
              <span>Analytic kernel</span>
            </label>
          )}
          {live && (
            <label>
              <input
                type="checkbox"
                checked={orbiting}
                onChange={event => setOrbiting(event.target.checked)}
              />
              <span>Orbit</span>
            </label>
          )}
        </div>

        {/* Turn the fades off and drag: every level change in the frontier becomes a visible snap.
            That snap is what `fadeInDuration` exists to remove, and it is much easier to believe
            after seeing it. */}
        {isStreaming && !fades && (
          <p className="note">
            Fades off — level changes in the streaming frontier will pop as the camera moves.
          </p>
        )}

        <div className="status" data-phase={load.phase}>
          {load.phase === 'probing' && <>Looking for baked archives…</>}

          {load.phase === 'streaming' && archive && (
            <>
              <strong>Baked archive</strong> · {formatCount(archive.summary.splatCount)} splats in{' '}
              {archive.summary.nodeCount} nodes · {formatBytes(archive.summary.totalByteLength)}{' '}
              fully resident
              {streaming && (
                <>
                  <br />
                  {formatCount(streaming.drawnSplatCount)} drawn ·{' '}
                  {streaming.hierarchy.frontierNodeCount} nodes ·{' '}
                  {formatBytes(streaming.residency.residentGpuByteLength)} GPU
                  {streaming.hierarchy.pendingLoadCount + streaming.hierarchy.queuedLoadCount > 0
                    ? ` · ${
                        streaming.hierarchy.pendingLoadCount + streaming.hierarchy.queuedLoadCount
                      } loading`
                    : ''}
                </>
              )}
            </>
          )}

          {load.phase === 'live' && live && (
            <>
              <strong>Live from a raster endpoint</strong> · nothing was baked, trained or hosted
              for this
              {streaming && (
                <>
                  <br />
                  {formatCount(streaming.drawnSplatCount)} drawn ·{' '}
                  {streaming.hierarchy.frontierNodeCount} tiles
                  {streaming.lingeringBatchCount > 0
                    ? ` (+${streaming.lingeringBatchCount} fading)`
                    : ''}{' '}
                  · zoom {formatZoomRange(streaming)} · finest{' '}
                  {formatSpacing(getFinestSpacing(streaming))} ·{' '}
                  {formatBytes(streaming.residency.residentGpuByteLength)} GPU
                </>
              )}
              {sourceStats && (
                <>
                  <br />
                  {formatCount(sourceStats.builtTiles)} tiles built · {sourceStats.nodeCount} nodes
                  in the tree
                  {sourceStats.pendingTiles > 0 ? ` · ${sourceStats.pendingTiles} building` : ''}
                  {sourceStats.missingRasters > 0
                    ? ` · ${sourceStats.missingRasters} rasters past the host's coverage`
                    : ''}
                  {sourceStats.retryingTiles > 0 ? ` · ${sourceStats.retryingTiles} retrying` : ''}
                </>
              )}
            </>
          )}

          {load.phase === 'unbaked' && (
            <>
              <strong>Not baked yet.</strong> These splats are built out of elevation and imagery
              rasters, so there is no file to fall back to — and nothing downloads until you bake
              it.
              <br />
              <code>{scene.bakeCommand}</code>
            </>
          )}

          {load.phase === 'confirm' && (
            <>
              <strong>Not baked.</strong> Drawing this now means downloading about{' '}
              {formatBytes(load.byteLength)} of PLY and decoding every row in the browser.
              <br />
              <code>{scene.bakeCommand}</code>
              <br />
              <button type="button" className="confirm" onClick={onConfirmDownload}>
                Download {formatBytes(load.byteLength)} anyway
              </button>
            </>
          )}

          {load.phase === 'ply' && (
            <>
              Decoding the PLY on a worker… {formatBytes(load.loadedBytes)}
              {load.totalBytes ? ` / ${formatBytes(load.totalBytes)}` : ''} ·{' '}
              {formatCount(load.splatCount)} splats
            </>
          )}

          {load.phase === 'ply-ready' && (
            <>
              <strong>Unbaked PLY</strong> · {formatCount(load.splatCount)} splats ·{' '}
              {formatBytes(load.loadedBytes)} downloaded and decoded in{' '}
              {(load.elapsedMs / 1000).toFixed(1)}s
              <br />
              <code>{scene.bakeCommand}</code> publishes it as a streaming archive instead.
            </>
          )}

          {load.phase === 'error' && <>Splat scene failed: {load.message}</>}
        </div>

        {/* The schema, read off the RecordBatch the last tile was actually built as rather than
            typed here. It is the whole of the interchange between "an elevation tile" and "four
            thousand Gaussians", and it fits in five lines. */}
        {sourceStats && sourceStats.schema.length > 0 && (
          <div className="schema">
            <h2>GeoArrow RecordBatch · one per tile</h2>
            <table>
              <tbody>
                {sourceStats.schema.map(field => (
                  <tr key={field.name}>
                    <td>{field.name}</td>
                    <td>{field.type}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="backend">
          <strong>{deviceType === 'webgpu' ? 'WebGPU' : 'WebGL2'}</strong>
          {backend === 'gpu-graph' &&
            ' · GPUSplatGraphRenderer: projection, culling, the global depth sort and the draw all run as GPU compute.'}
          {backend === 'cpu-sort' &&
            ' · SplatRenderer: the depth order is built on the CPU and every source attribute is repacked whenever the camera moves.'}
          {deviceType === 'webgpu'
            ? ' Add ?device=webgl to compare against the fallback.'
            : supportsWebGPU
              ? ' Remove ?device=webgl to use WebGPU.'
              : ' This browser has no WebGPU adapter.'}
        </p>

        <p className="attribution">
          Elevation <a href="https://mapterhorn.com/attribution/">Mapterhorn</a> ·{' '}
          {live && !place?.imageryUrl ? (
            <>no imagery — relief only, add ?imagery= to supply some</>
          ) : (
            <>
              Imagery{' '}
              <a href="https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices">
                {place?.imageryCredit ?? 'swisstopo SWISSIMAGE'}
              </a>
            </>
          )}
          {scene.kind === 'capture' && (
            <>
              {' '}
              · Splats{' '}
              <a href="https://huggingface.co/datasets/Voxel51/gaussian_splatting">Voxel51</a>
            </>
          )}
        </p>
      </aside>
    </>
  );
}

export function renderToDOM(container: HTMLElement) {
  createRoot(container).render(<App />);
}

const container = document.getElementById('app');
if (container) {
  renderToDOM(container);
}
