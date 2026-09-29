// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {MapView, type MapViewState} from '@deck.gl/core';
import {DeckGL} from '@deck.gl/react';
import {luma} from '@luma.gl/core';
import type {Device} from '@luma.gl/core';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';

import {SplatLayer, type SplatStreamingStats} from '@deck.gl/splat-layers';
import {getPlaceViewState, PLACES, TERRAIN_IMAGE} from './scenes';
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
const urlParams = new URLSearchParams(window.location.search);
const requestedDevice = urlParams.get('device');
/** See `splat-device.ts`: luma.gl's adapter, asking for a storage binding the splats can fill. */
const SPLAT_ADAPTER = createSplatWebGPUAdapter();
const supportsWebGPU = luma.getBestAvailableAdapterType([SPLAT_ADAPTER]) === 'webgpu';
const deviceType: 'webgpu' | 'webgl' =
  requestedDevice === 'webgl' ? 'webgl' : supportsWebGPU ? 'webgpu' : 'webgl';

/**
 * How much of the GPU the streamed scene is allowed to hold, in splats.
 *
 * A ceiling, not a target: the level-of-detail traversal normally stops at
 * `maximumScreenSpaceError` long before this binds. At a close camera it binds *first*, and that is
 * what mixed resolution across one view actually is -- the budget fills, and refinement stops
 * wherever each branch happened to have reached.
 *
 * It is also the layer's renderer reservation, so it decides how large the graph's sort and
 * projected-record buffers are. Lower on WebGL2, where every frontier change is a CPU resort.
 *
 * **What the ceiling is depends on the device, so it is read from the device.** The graph keeps its
 * projected records in one storage binding, and 32 bytes a splat against WebGPU's default 128 MiB
 * is about 3.2M after the reservation factor. `splat-device.ts` asks for 512 MiB instead, which is
 * 12.9M -- so the ladder below is offered as far up as the device granted and no further. With
 * that request the dropdown stops at 12.8M; the rungs above it appear only on a device granted a
 * larger binding (about 1 GiB per 25.6M).
 */
const RESIDENCY_LADDER = [1_600_000, 3_200_000, 6_400_000, 12_800_000, 25_600_000] as const;

/**
 * What the ladder is capped at by default, when the device allows more.
 *
 * 1.6M, because frame rate is what gives out first: the next rung doubles what is drawn, and sort
 * plus overdraw scale with it. The higher rungs stay in the list for a device that can carry them.
 */
const PREFERRED_RESIDENCY = 1_600_000;

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
 * Drawing-buffer resolution, in device pixels per CSS pixel: the display's own, capped at 1.5.
 *
 * Blending is paid per pixel, and a 2x display has four times the pixels of the CSS size. Splats are
 * soft-edged, so the last step from 1.5x to 2x buys little visible sharpness for the ~44% more
 * pixels it blends. Capped rather than fixed, so a 1x display is never supersampled.
 */
const RENDER_PIXEL_RATIO = Math.min(window.devicePixelRatio || 1, 1.5);

/**
 * Geometric error, in drawing-buffer pixels, a level-of-detail node may project to before it is
 * refined.
 */
const DETAIL_OPTIONS = [1, 2, 4, 8] as const;
const DEFAULT_DETAIL = deviceType === 'webgpu' ? 2 : 8;

/**
 * Minimum fragment opacity kept after a Gaussian's falloff, and why it is so far above the
 * layer's own default.
 *
 * The default of `0.5 / 255` keeps every fragment that could still change an 8-bit channel, which
 * is the right answer for a trained reconstruction: there the far tail of a Gaussian is doing
 * real work, because the scene was optimized in the knowledge that it would be blended. Terrain
 * splats are not trained, they are a regular grid of discs sized to overlap their neighbours by a
 * known amount -- so the tail is not carrying detail, it is a fringe on every disc, stacked tens
 * deep along the view ray. Cutting it at 2% is what separates a surface from a fog of it, and it is
 * also most of the overdraw.
 */
const SPLAT_ALPHA_CUTOFF = 0.02;

/**
 * Nodes the renderer's command graph is compiled for.
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

function formatCompactCount(count: number): string {
  return count.toLocaleString('en-US', {notation: 'compact', maximumSignificantDigits: 3});
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

export default function App() {
  // `?scene=<id>` picks a place on load; the default is the first.
  const [placeId, setPlaceId] = useState(
    () => PLACES.find(entry => entry.id === urlParams.get('scene'))?.id ?? PLACES[0].id
  );
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
  const [source, setSource] = useState<TerrainSplatSource | null>(null);
  const [streaming, setStreaming] = useState<SplatStreamingStats | null>(null);
  const [sourceStats, setSourceStats] = useState<TerrainSourceStats | null>(null);
  const [fades, setFades] = useState(true);
  const [analytic, setAnalytic] = useState(true);
  const [orbiting, setOrbiting] = useState(false);

  const place = useMemo(() => PLACES.find(entry => entry.id === placeId) ?? PLACES[0], [placeId]);
  const [viewState, setViewState] = useState<MapViewState>(() =>
    getPlaceViewState(place, window.innerHeight)
  );

  /**
   * Builds the live source for the selected place.
   *
   * There is no manifest to probe and no file to download, so it is built the moment it is selected.
   * It owns a worker pool and a growing node tree, which is why it has a destructor.
   */
  useEffect(() => {
    setStreaming(null);
    setSourceStats(null);
    const nextSource = new TerrainSplatSource({
      place,
      elevationUrl: TERRAIN_IMAGE,
      sigma: TERRAIN_SURFEL_DEFAULTS.sigma,
      thickness: TERRAIN_SURFEL_DEFAULTS.thickness,
      relief: TERRAIN_SURFEL_DEFAULTS.relief,
      // No haze: the coarse levels of the tree reach the horizon, so there is no frontier edge to
      // hide. See TERRAIN_HAZE.
      haze: null,
      maxResidentNodes: LIVE_MAX_RESIDENT_NODES
    });
    setSource(nextSource);
    return () => {
      // Before the layer is told, deliberately: the layer releases the pages, and this only stops
      // the workers from building more of them for a place nobody is looking at.
      nextSource.destroy();
    };
  }, [place]);

  /**
   * The camera, reset whenever the place changes and animated when nothing is touching it.
   *
   * Held in React rather than left to `initialViewState`, because the orbit has to write to it - and
   * because each place frames its own subject, so selecting one has to move the camera there.
   */
  const interactionAt = useRef(0);
  useEffect(() => {
    setViewState(getPlaceViewState(place, window.innerHeight));
    interactionAt.current = 0;
  }, [place]);

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
  /** Throttled with a trailing update, so the last change before the frontier settles is shown. */
  const lastStatsAt = useRef(0);
  const trailingStats = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onStreamingStats = useCallback((stats: SplatStreamingStats) => {
    const now = performance.now();
    if (trailingStats.current !== null) {
      clearTimeout(trailingStats.current);
      trailingStats.current = null;
    }
    const wait = 250 - (now - lastStatsAt.current);
    if (wait > 0) {
      trailingStats.current = setTimeout(() => {
        trailingStats.current = null;
        lastStatsAt.current = performance.now();
        setStreaming(stats);
      }, wait);
      return;
    }
    lastStatsAt.current = now;
    setStreaming(stats);
  }, []);
  useEffect(
    () => () => {
      if (trailingStats.current !== null) {
        clearTimeout(trailingStats.current);
      }
    },
    []
  );

  // The source's own counters are not event-driven - tiles are built on workers - so they are polled
  // at the same rate the traversal counters are throttled to.
  useEffect(() => {
    if (!source) {
      return undefined;
    }
    setSourceStats(source.getStats());
    const timer = setInterval(() => setSourceStats(source.getStats()), 250);
    return () => clearInterval(timer);
  }, [source]);

  const residencyBudget = useMemo(() => ({maxResidentSplats: residencyLimit}), [residencyLimit]);

  const layers = [
    source
      ? new SplatLayer({
          id: 'swiss-splats',
          splatHierarchy: source,
          maximumScreenSpaceError: detailPixels,
          residencyBudget,
          // The splats are metres about the place, with scene z the elevation itself, so they are
          // placed one to one with the anchor at exactly 0 m.
          coordinateOrigin: [place.longitude, place.latitude, 0],
          georeferenced: true,
          upAxis: 'z-up',
          // An orthophoto looks the same from every direction, so the tiles carry a DC term only.
          sphericalHarmonicsDegree: 0,
          alphaCutoff: SPLAT_ALPHA_CUTOFF,
          // Integrating each Gaussian over the pixel footprint rather than sampling its centre, which
          // is what keeps a hillside of sub-pixel splats from crawling as the camera turns. It costs
          // roughly a tenth of the frame and is the largest fidelity difference at distance.
          fragmentKernel: analytic ? 'analytic' : 'gaussian',
          ...(fades ? FADES_ON : FADES_OFF),
          parameters: {cullMode: 'none'},
          onStreamingStats
        })
      : null
  ];

  return (
    <>
      <DeckGL
        views={new MapView()}
        useDevicePixels={RENDER_PIXEL_RATIO}
        // Controlled rather than initial, because the orbit writes to it and each place frames its
        // own subject, so choosing one has to move the camera there.
        viewState={viewState}
        onViewStateChange={({viewState: next}) => {
          // Any interaction parks the orbit; it resumes once the pointer has been still a while.
          interactionAt.current = performance.now();
          setViewState(next as MapViewState);
        }}
        // WebGPU when the browser has it. The splat layer binds a fully GPU-side renderer there
        // and a CPU-sorting fallback on WebGL2; `?device=webgl` forces the fallback.
        deviceProps={{type: deviceType, adapters: [SPLAT_ADAPTER]}}
        onDeviceInitialized={onDeviceInitialized}
        // The plain map controller, not `TerrainController`. A place is framed by hand -
        // `lookAtAltitude`, `elevationDeg` and `rangeMeters` are chosen per subject - and letting
        // the controller pull the centre down onto the terrain overrides exactly those numbers.
        controller={{inertia: true}}
        layers={layers}
      />

      <aside className="panel">
        <p className="eyebrow">
          Mapterhorn · {place.imageryCredit ?? 'relief only'} · GeoArrow → luma.gl splats
        </p>
        <h1>{place.label}</h1>
        <p className="description">{place.description}</p>

        <label className="field">
          <span>Place</span>
          <select value={placeId} onChange={event => setPlaceId(event.target.value)}>
            {PLACES.map(entry => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Detail</span>
          {/* A node's geometric error is the spacing of its own splats, so this reads directly: at
              2, refinement continues until the splats being looked at sit about two pixels apart. */}
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
          {/* A ceiling rather than a target, and the layer's renderer reservation. Changing it
              admits or evicts pages; nothing is re-downloaded and no graph is rebuilt. */}
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

        <div className="toggles">
          <label title="Ramp a page up as it arrives, and hold the page it replaces until the ramp finishes.">
            <input
              type="checkbox"
              checked={fades}
              onChange={event => setFades(event.target.checked)}
            />
            <span>Fades</span>
          </label>
          <label title="Integrate each Gaussian over the pixel footprint instead of sampling its centre.">
            <input
              type="checkbox"
              checked={analytic}
              onChange={event => setAnalytic(event.target.checked)}
            />
            <span>Analytic kernel</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={orbiting}
              onChange={event => setOrbiting(event.target.checked)}
            />
            <span>Orbit</span>
          </label>
        </div>

        {/* Turn the fades off and drag: every level change in the frontier becomes a visible snap.
            That snap is what `fadeInDuration` exists to remove, and it is much easier to believe
            after seeing it. */}
        {!fades && (
          <p className="note">
            Fades off — level changes in the streaming frontier will pop as the camera moves.
          </p>
        )}

        <div className="status">
          {streaming ? (
            <>
              {formatCompactCount(streaming.drawnSplatCount)} splats · zoom{' '}
              {formatZoomRange(streaming)} · {formatSpacing(getFinestSpacing(streaming))} finest ·{' '}
              {formatBytes(streaming.residency.residentGpuByteLength)} GPU
              {sourceStats && sourceStats.pendingTiles > 0
                ? ` · ${sourceStats.pendingTiles} building`
                : ''}
              {sourceStats && sourceStats.retryingTiles > 0
                ? ` · ${sourceStats.retryingTiles} retrying`
                : ''}
            </>
          ) : (
            <>Fetching tiles…</>
          )}
        </div>

        <p className="attribution">
          Elevation <a href="https://mapterhorn.com/attribution/">Mapterhorn</a> · Imagery{' '}
          <a href="https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices">
            {place.imageryCredit ?? 'swisstopo SWISSIMAGE'}
          </a>
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
