// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Layer} from '@deck.gl/core';
import type {
  DefaultProps,
  GetPickingInfoParams,
  LayerComputeParameters,
  LayerProps,
  PickingInfo,
  UpdateParameters,
  Viewport
} from '@deck.gl/core';
import type {Buffer, CompareFunction, Device} from '@luma.gl/core';
import {Model} from '@luma.gl/engine';
import {Matrix4} from '@math.gl/core';
import {
  makeGPUSplatData,
  GPUSplatGraphMixedRenderer,
  GPUSplatGraphRenderer,
  GPU_SPLAT_PROJECTED_RECORD_BYTE_LENGTH,
  SplatHierarchyManager,
  SplatRenderer,
  SplatResidencyManager,
  type GPUSplatAlphaMode,
  type GPUSplatData,
  type SplatAntialiasingMode,
  type SplatClipRegion,
  type SplatDepthKeyMode,
  type SplatFragmentKernel,
  type SplatHierarchyFrontierEntry,
  type SplatHierarchyNode,
  type SplatHierarchyPageLoader,
  type SplatHierarchyStats,
  type SplatRendererStats,
  type SplatResidencyBudget,
  type SplatResidencyStats,
  type SplatSource
} from '@luma.gl/splats';
import {
  getSplatDeviceBudget,
  SPLAT_DEVICE_BUDGETS,
  type SplatDeviceClass
} from './splat-device-budgets';
import {SplatFadeController, type SplatFadeEntry} from './splat-fade-controller';
import {
  SPLAT_COMPATIBLE_PICKING_SHADER,
  SPLAT_COMPATIBLE_PICKING_SHADER_LAYOUT,
  SPLAT_PICKING_SHADER,
  SPLAT_PICKING_SHADER_LAYOUT
} from './splat-picking-shader';

/**
 * Renders a Gaussian splat scene as a first-class deck.gl layer.
 *
 * Both backends record into the render pass deck.gl already opened for the layer stack, so with
 * `depthCompare` enabled and depth writes disabled, opaque geometry drawn by earlier layers - a
 * `TerrainLayer` mesh, for example - occludes splats behind it, while the splats stay correctly
 * ordered among themselves through a global depth sort.
 *
 * **WebGPU.** Projection, culling, the global radix depth sort, spherical-harmonic radiance and the
 * indirect draw all run as GPU compute over borrowed source buffers. That work is recorded in the
 * layer's {@link SplatLayer.compute} stage, on deck.gl's own encoder, immediately before the render
 * pass that consumes it - so there is no extra submission, no hand-written synchronization, and in
 * a multi-view frame each camera gets its own depth order.
 *
 * **WebGL2.** The fallback. WebGL2 has no storage buffers, so the sorted order has to be
 * materialized by physically permuting every source attribute, and luma.gl's GLSL splat shader has
 * no spherical-harmonic evaluation, so any degree above 0 is evaluated per splat on the CPU
 * whenever the camera moves. Both costs are linear in the splat count and both land on the main
 * thread. This path is usable; it is not fast, and the residency budget exists for it.
 *
 * ## Two ways to give it a scene
 *
 * **`splatSource`** is a scene that is already decoded and fully resident. Everything is uploaded
 * once, the renderer's capacity is reserved for exactly that many rows, and nothing changes after
 * the first frame.
 *
 * **`splatHierarchy`** is a level-of-detail tree that streams. `SplatHierarchyManager` walks it
 * against the camera each frame and hands back the set of batches that should be drawn;
 * `SplatResidencyManager` bounds what stays on the GPU and evicts by priority. Two things make
 * that affordable:
 *
 * 1. **Capacity is reserved up front.** The graph renderer compiles a command graph sized to
 *    `expectedSplatCount` and `expectedBatchCount` and reuses it for any batch list that fits - so
 *    a frontier that gains, loses and reorders pages every frame costs one buffer of pointers
 *    rather than a graph rebuild. Reserve for the residency ceiling and the churn is free.
 * 2. **The traversal runs in the layer's own space.** Screen-space error is measured from the
 *    camera position and the node bounds, in the scene's arbitrary units; the layer already builds
 *    the matrix that maps those onto the map, and its inverse, so it feeds the traversal a
 *    scene-local camera and the error comes out in real screen pixels.
 *
 * The residency manager is owned by the layer rather than by the hierarchy, which is what lets
 * `maximumScreenSpaceError` change without dropping a single resident page: the hierarchy takes its
 * threshold at construction, so changing it rebuilds the traversal - and a traversal rebuilt over a
 * residency window it does not own finds every page still there.
 */

/** Convention describing which local axis points up in the source scene. */
export type SplatUpAxis = 'y-down' | 'z-up';

/** Which luma.gl splat renderer a layer ended up on. */
export type SplatBackendKind = 'gpu-graph' | 'cpu-sort';

/**
 * A streaming level-of-detail tree, as the layer needs to see one.
 *
 * Structural on purpose: the layer takes nodes and a way to load one, and has no opinion about
 * where they come from - an archive over HTTP, a tree already in memory, or 3D Tiles.
 */
export type SplatHierarchySource = {
  roots: readonly SplatHierarchyNode[];
  /** Builds the loader for a device. Called once per backend, not once per page. */
  createPageLoader: (device: Device) => SplatHierarchyPageLoader;
  /** Totals used to reserve renderer capacity before anything has loaded. */
  summary: {splatCount: number; nodeCount: number};
  /**
   * Notifies the layer that `roots` now describes a different tree, for a source that discovers
   * its nodes as it goes.
   *
   * An archive knows its whole tree from the manifest and needs none of this. A live tiled source
   * does not: a quadtree over a raster service has no bottom until a request 404s, so nodes appear
   * as the camera asks for them. Returning a new `splatHierarchy` prop for each of those would
   * release the scene and start over, which is the opposite of streaming - so a source that grows
   * mutates `roots` and calls the listener, and the layer re-indexes the traversal in place. Every
   * page already loaded survives it, because the residency window belongs to the layer rather than
   * to the traversal.
   *
   * @returns an unsubscribe function, called when the layer releases the scene.
   */
  subscribe?: (onRootsChange: () => void) => () => void;
};

/** What the layer can report back about a streaming scene, for a status readout. */
export type SplatStreamingStats = {
  hierarchy: SplatHierarchyStats;
  residency: SplatResidencyStats;
  /** Rows currently drawn, which is what the depth sort actually covers. */
  drawnSplatCount: number;
  /**
   * The traversal's own frontier entries, borrowed rather than copied.
   *
   * Everything the surrounding UI needs to describe what is on screen - which nodes, at which
   * depth, at what projected error, and which of them are standing in for finer pages that have
   * not arrived - without the layer having to guess which of those a caller wanted. Valid until the
   * next frontier change; anything kept past that should be copied out.
   */
  frontier: readonly SplatHierarchyFrontierEntry[];
  /** Pages drawn only to cover ground whose replacements are still ramping up. See fade props. */
  lingeringBatchCount: number;
};

/** Identity of one picked Gaussian, resolved back to its original source batch. */
export type SplatPickingInfo = PickingInfo & {
  /** Stable source batch index the picked Gaussian belongs to. */
  splatBatchIndex: number | null;
  /** Zero-based row within that source batch. */
  splatBatchRowIndex: number | null;
  /** Semantic class identifier, when the source batch carries one. */
  splatSemanticId: number | null;
};

export type SplatLayerProps = {
  /**
   * Decoded, caller-owned splat columns. Several sources are uploaded as several batches and kept
   * intact - both renderers sort across all of them, so they are not repacked or merged.
   */
  splatSource?: SplatSource | SplatSource[] | null;
  /**
   * A level-of-detail tree to stream instead, traversed against the camera every frame.
   *
   * Takes precedence over `splatSource`. The pages it loads are owned by the layer's residency
   * manager and destroyed when they are evicted.
   */
  splatHierarchy?: SplatHierarchySource | null;
  /**
   * Geometric error, in pixels, a streaming node may project to before it is refined.
   *
   * The sharpness dial. A node's error is the mean spacing of its own splats across the region it
   * covers, so this reads directly: at 2, refinement continues until the splats the camera is
   * looking at sit about two pixels apart. Lower values fetch more and sort more; the residency
   * budget is what stops it, and where the budget binds first this does nothing.
   */
  maximumScreenSpaceError?: number;
  /**
   * Ceiling on what a streaming scene keeps on the GPU. Pages beyond it are never requested.
   *
   * Defaults to a preset chosen from the device, because a splat scene has no natural size and
   * what a viewer can hold is a property of the machine rather than of the capture. Anything set
   * here overrides the matching field of that preset.
   */
  residencyBudget?: SplatResidencyBudget | null;
  /** Forces a device-class preset instead of detecting one. */
  deviceClass?: SplatDeviceClass | null;
  /** Page fetches allowed to run at once while streaming. */
  maxConcurrentLoads?: number;
  /**
   * Robust per-axis extent of the scene in source units, if the caller already knows it.
   *
   * A streaming scene has to supply this: the layer normalizes source units onto a metre footprint
   * from percentiles of the splat centers, and no single page of a streamed scene has seen enough
   * of them. Ignored when `splatSource` is used, where the columns are all present.
   */
  scenePercentiles?: {x: [number, number]; y: [number, number]; z: [number, number]} | null;
  /**
   * Whether the scene's units are already metres about `coordinateOrigin`.
   *
   * A reconstruction arrives in arbitrary units with no geographic meaning, so the layer has to
   * invent a scale: it measures a robust extent and stretches that onto `sizeMeters`. A scene baked
   * out of a geographic raster has no such ambiguity - every splat already knows where it belongs -
   * so this places it one to one and `sizeMeters` stops applying.
   */
  georeferenced?: boolean;
  /** `[longitude, latitude, altitudeMeters]` the scene is pinned to. */
  coordinateOrigin: [number, number, number];
  /** Target horizontal footprint of the scene in meters; source units are arbitrary. */
  sizeMeters?: number;
  /** Rotation about the vertical axis, in degrees clockwise from north. */
  heading?: number;
  /** Axis convention of the source scene. GraphDECO scenes are `y-down`. */
  upAxis?: SplatUpAxis;
  /** Highest spherical-harmonic band evaluated at render time. */
  sphericalHarmonicsDegree?: 0 | 1 | 2 | 3;
  /** Multiplier on each Gaussian's support radius. */
  radiusScale?: number;
  /** Multiplier on decoded opacity. */
  alphaScale?: number;
  /** Linear radiance multiplier applied before display tone mapping. */
  exposure?: number;
  /** Minimum fragment opacity retained after Gaussian attenuation. */
  alphaCutoff?: number;
  /**
   * Screen-space antialiasing. **WebGPU only.** Defaults to `'mip-splatting'`.
   *
   * The dilation filter that keeps sub-pixel Gaussians visible also brightens them; compensating
   * opacity for the determinant change restores the normalization it removes. The gap is widest
   * exactly when a geospatial camera zooms out.
   */
  antialiasing?: SplatAntialiasingMode;
  /**
   * One-sigma width of the screen-space dilation, in **device** pixels. Defaults to `0.3`.
   *
   * This is the filter `antialiasing` compensates the opacity for, and 0.3 is the value
   * Mip-Splatting prescribes -- for a scene that was *trained* with its matching 3D smoothing
   * filter, which already bounds how much detail the Gaussians carry above the pixel Nyquist.
   *
   * A scene that was not trained has no such bound. Splats laid out on a regular lattice -- a
   * height field cut into surfels is the usual way to get one -- alias coherently rather than as
   * noise, and the beat between the lattice and the pixel grid reads as moire that crawls under
   * the camera. It is worst at grazing incidence, where the projected spacing along the view
   * direction collapses while the spacing across it does not. 0.3 attenuates the Nyquist
   * frequency by only a third, so it is nowhere near enough there; around 1 device pixel
   * band-limits it properly, at the cost of a real but mild softening.
   */
  kernel2DSize?: number;
  /**
   * Per-fragment Gaussian evaluation. **WebGPU only.** Defaults to `'gaussian'`.
   *
   * `'analytic'` integrates the Gaussian over the pixel footprint instead of sampling its center,
   * which removes the residual aliasing of sub-pixel splats for roughly a tenth of the frame.
   */
  fragmentKernel?: SplatFragmentKernel;
  /**
   * Distribution used to quantize depth into the global sort key. **WebGPU only.**
   *
   * Normalized device depth is hyperbolic: at geospatial near/far ratios almost the whole key
   * range is spent within metres of the camera, and distant Gaussians collapse into ties that
   * resolve arbitrarily and pop under rotation. The default half-precision distribution keeps
   * usable resolution across the whole range at the same key width.
   */
  depthKeyMode?: SplatDepthKeyMode;
  /**
   * How Gaussian coverage reaches the framebuffer. **WebGPU only.** Defaults to `'blend'`.
   *
   * `'stochastic'` dithers coverage and blends opaquely with depth writes, consuming no depth
   * ordering at all - which makes splats behave like opaque geometry inside deck.gl's existing
   * render pass, at the cost of noise that needs temporal accumulation to resolve.
   */
  alphaMode?: GPUSplatAlphaMode;
  /**
   * Non-destructive soft clipping of Gaussians to a half-space, slab or convex prism.
   *
   * Evaluated per frame in the existing projection pass, so a clip region can animate freely and
   * nothing is removed from the source data. Also settable per layer through `SplatClipExtension`.
   */
  clipRegion?: SplatClipRegion | null;
  /**
   * Minimum coverage a Gaussian must reach at a pixel to be pickable there. Defaults to `0.5`.
   *
   * Picking a volumetric primitive by first hit is genuinely ambiguous: the 3-sigma border of a
   * large, nearly transparent Gaussian can sit in front of a small opaque one while contributing
   * almost nothing to the pixel.
   */
  pickingAlphaThreshold?: number;
  /**
   * Minimum projected one-sigma radius, in pixels, a splat must cover to be drawn.
   *
   * **WebGPU only.** On the graph renderer this is evaluated in the projection compute pass, so a
   * culled splat costs nothing further: it drops out of the sort, the indirect draw count and the
   * rasterizer alike. On the WebGL2 fallback the equivalent test has to run per row in JavaScript,
   * which costs more than the overdraw it saves, so the layer never forwards it there.
   */
  screenSizeCutoffPixels?: number;
  /**
   * Milliseconds a streamed page takes to ramp up when it enters the frontier. `0` disables all
   * three fade controls.
   *
   * The traversal already keeps a coarse parent on screen until its children are resident, so a
   * refinement never opens a hole - but it crosses that boundary in one frame, and under a moving
   * camera that snap happens somewhere on screen several times a second. Ramping the arrival, and
   * holding the page it replaces until the ramp finishes, is what turns that into a quadtree
   * visibly refining rather than a scene visibly glitching.
   *
   * **Streaming only.** The pages are produced by the hierarchy's page loader and owned by the
   * layer's residency manager, so the layer is free to write their opacity column; a caller-owned
   * `splatSource` is not, and is never touched.
   */
  fadeInDuration?: number;
  /**
   * Milliseconds a released page takes to ramp down.
   *
   * Shorter than {@link SplatLayerProps.fadeInDuration} on purpose. A released page is only ever
   * covered by pages that are already fully up, so two surfaces are interleaved in the depth sort
   * for exactly this long, and the only requirement is that it not read as a cut.
   */
  fadeOutDuration?: number;
  /**
   * Longest a departed page is held at full opacity waiting for its replacements, in milliseconds.
   *
   * A backstop rather than a timing: the hold normally ends when the pages that replaced it reach
   * full opacity, which after a large camera move can take a second or two. Past this it is
   * blurring finished ground for something that is not coming.
   */
  fadeHoldDuration?: number;
  /** Depth comparison against opaque meshes already recorded into the same pass. */
  depthCompare?: 'less' | 'less-equal' | 'always';
  /** Whether splats write depth. Left off so they do not occlude each other. */
  depthWriteEnabled?: boolean;
  /** Reports which renderer the layer bound to, once the device and scene are both known. */
  onBackendChange?: (backend: SplatBackendKind | null) => void;
  /**
   * Reports traversal and residency counters when a streaming frontier changes.
   *
   * Fired on change rather than per frame, because a settled camera changes neither.
   */
  onStreamingStats?: (stats: SplatStreamingStats) => void;
} & LayerProps;

const defaultProps: DefaultProps<SplatLayerProps> = {
  splatSource: {type: 'object', value: null, async: false},
  splatHierarchy: {type: 'object', value: null, async: false},
  maximumScreenSpaceError: {type: 'number', value: 2, min: 0},
  residencyBudget: {type: 'object', value: null, compare: true},
  deviceClass: null,
  maxConcurrentLoads: {type: 'number', value: 6, min: 1},
  scenePercentiles: {type: 'object', value: null, compare: true},
  georeferenced: false,
  coordinateOrigin: {type: 'array', value: [0, 0, 0], compare: true},
  sizeMeters: {type: 'number', value: 120, min: 0},
  heading: {type: 'number', value: 0},
  upAxis: 'y-down',
  sphericalHarmonicsDegree: {type: 'number', value: 1, min: 0, max: 3},
  radiusScale: {type: 'number', value: 1, min: 0},
  alphaScale: {type: 'number', value: 1, min: 0},
  exposure: {type: 'number', value: 1, min: 0},
  alphaCutoff: {type: 'number', value: 0.5 / 255, min: 0},
  antialiasing: 'mip-splatting',
  kernel2DSize: {type: 'number', value: 0.3, min: 0},
  fragmentKernel: 'gaussian',
  depthKeyMode: 'float16',
  alphaMode: 'blend',
  clipRegion: {type: 'object', value: null, compare: true},
  pickingAlphaThreshold: {type: 'number', value: 0.5, min: 0, max: 1},
  screenSizeCutoffPixels: {type: 'number', value: 0, min: 0},
  // On by default, because a popping frontier is a defect rather than a preference, and the pages
  // it writes to are the layer's own. See `fadeInDuration`.
  fadeInDuration: {type: 'number', value: 300, min: 0},
  fadeOutDuration: {type: 'number', value: 150, min: 0},
  fadeHoldDuration: {type: 'number', value: 2000, min: 0},
  depthCompare: 'less-equal',
  depthWriteEnabled: false,
  onBackendChange: {type: 'function', value: () => {}, compare: false},
  onStreamingStats: {type: 'function', value: () => {}, compare: false}
};

/** Scene-local normalization mapping arbitrary source units onto the anchored ground plane. */
type SplatPlacement = {
  metersPerUnit: number;
  offset: [number, number, number];
  /** Horizontal extent in source units, used to scale the camera-movement threshold below. */
  extentUnits: number;
};

/** The renderer pair, plus which one it is, so `draw` does not have to re-test the device. */
type SplatBackend =
  | {
      kind: 'gpu-graph';
      renderer: GPUSplatGraphRenderer;
      compositor: GPUSplatGraphMixedRenderer;
      depthCompare: CompareFunction;
      depthWriteEnabled: boolean;
      alphaMode: GPUSplatAlphaMode;
      pickingModel?: Model;
      pickingSources?: {
        uniformBuffer: Buffer;
        projectedRecordBuffer?: Buffer;
        sortedIndexBuffer?: Buffer;
        sortedRecordBuffer?: Buffer;
      };
    }
  | {kind: 'cpu-sort'; renderer: SplatRenderer};

/**
 * The camera values last handed to the renderer, and the transform they were derived from.
 *
 * Both renderers already compare incoming camera values element-wise, so a redraw with an unmoved
 * camera costs nothing inside luma either way. What this cache saves is the work on *this* side of
 * the call: the model matrix and its inverse are rebuilt only when the anchor, the placement or the
 * viewport's distance scales actually change, rather than on every frame.
 */
type SplatCameraCache = {
  modelMatrix: Matrix4;
  inverseModelMatrix: Matrix4;
  modelViewProjectionMatrix: Matrix4;
  origin: [number, number, number];
  unitsPerMeter: number;
  heading: number;
  upAxis: SplatUpAxis;
  placement?: SplatPlacement;
  submittedMatrix?: number[];
  submittedCameraPosition?: [number, number, number];
  submittedViewportSize?: [number, number];
  cameraPosition: [number, number, number];
};

/** Samples at most this many splats when estimating robust scene bounds. */
const PLACEMENT_SAMPLE_LIMIT = 50_000;

/**
 * Fraction of the scene's own extent the camera must move before WebGL2 harmonics are re-evaluated.
 *
 * luma.gl's GLSL splat shader has no spherical-harmonic evaluation - only the WGSL one does - so on
 * WebGL2 any degree above 0 is evaluated per splat on the CPU, and a changed camera position also
 * forces the sorted attribute buffers to be rewritten. View-dependent radiance varies smoothly with
 * the view direction, so paying that for a sub-metre pan buys nothing visible. Unused on WebGPU.
 */
const CPU_SPHERICAL_HARMONICS_MOVE_FRACTION = 0.02;

/** The 2nd and 98th percentile of each axis of the splat centers, in source units. */
type ScenePercentiles = {x: [number, number]; y: [number, number]; z: [number, number]};

export default class SplatLayer extends Layer<SplatLayerProps> {
  static layerName = 'SplatLayer';
  static defaultProps = defaultProps;

  declare state: {
    /** Batches this layer uploaded itself, on the fully-resident path only. */
    splatData: GPUSplatData[];
    backend?: SplatBackend;
    placement?: SplatPlacement;
    camera: SplatCameraCache;
    /** The streaming traversal, rebuilt whenever its error threshold changes. */
    hierarchy?: SplatHierarchyManager;
    /**
     * The residency window, owned by the layer rather than by the traversal.
     *
     * This is what makes rebuilding the traversal cheap: a new traversal handed a window it does
     * not own finds every page from the old one already resident.
     */
    residency?: SplatResidencyManager;
    hierarchySource?: SplatHierarchySource;
    /** Rows in the batches currently handed to the renderer. */
    drawnSplatCount: number;
    /** Clip region resolved by `SplatClipExtension`, which wins over the `clipRegion` prop. */
    clipRegion?: SplatClipRegion;
    /** Opacity ramps over the streaming frontier; absent when the fade props are all zero. */
    fade?: SplatFadeController<GPUSplatData>;
    /**
     * Root-to-node identity chains, built once per node and kept.
     *
     * The fade controller needs to know whether a page that just arrived is on the same branch as
     * one that just left, and `parentId` only answers that one link at a time. Walking it per
     * frontier change would be O(depth) per page per change; this is O(depth) per page ever.
     */
    ancestorIds: Map<string, readonly string[]>;
    /** Pages the layer pinned itself so a ramp could finish; unpinned when it does. */
    pinnedLingering: Set<GPUSplatData>;
    /** The traversal's current frontier, as a set, for the pin bookkeeping below. */
    frontierBatches: Set<GPUSplatData>;
    /** Drops the growing-source listener. See `SplatHierarchySource.subscribe`. */
    unsubscribeRoots?: () => void;
    /** Timestamp the ramps were last advanced to. */
    lastFadeTime: number;
  };

  /** Only the WebGPU backend has compute work; the WebGL2 fallback does everything in `draw`. */
  get needsComputePass(): boolean {
    return this.state?.backend?.kind === 'gpu-graph';
  }

  initializeState(): void {
    this.setState({
      splatData: [],
      drawnSplatCount: 0,
      ancestorIds: new Map(),
      pinnedLingering: new Set(),
      frontierBatches: new Set(),
      lastFadeTime: 0,
      camera: {
        modelMatrix: new Matrix4(),
        inverseModelMatrix: new Matrix4(),
        modelViewProjectionMatrix: new Matrix4(),
        origin: [NaN, NaN, NaN],
        unitsPerMeter: NaN,
        heading: NaN,
        upAxis: 'y-down',
        cameraPosition: [NaN, NaN, NaN]
      }
    });
  }

  updateState(params: UpdateParameters<this>): void {
    const {props, oldProps, changeFlags} = params;

    const hierarchyChanged = props.splatHierarchy !== oldProps.splatHierarchy;
    const sourceChanged = changeFlags.dataChanged || props.splatSource !== oldProps.splatSource;

    if (hierarchyChanged || (sourceChanged && !props.splatHierarchy)) {
      this._releaseScene();
      if (props.splatHierarchy) {
        this._createStreamingScene(props.splatHierarchy);
      } else {
        this._createResidentScene(normalizeSources(props.splatSource));
      }
      // A new scene invalidates every cached camera value, so the next frame resubmits all of them.
      this._invalidateCameraCache();
    } else if (
      props.splatHierarchy &&
      (props.maximumScreenSpaceError !== oldProps.maximumScreenSpaceError ||
        props.maxConcurrentLoads !== oldProps.maxConcurrentLoads)
    ) {
      // Rebuilt over the layer's own residency window, so every loaded page survives it.
      this._createTraversal();
    }

    if (
      props.fadeInDuration !== oldProps.fadeInDuration ||
      props.fadeOutDuration !== oldProps.fadeOutDuration ||
      props.fadeHoldDuration !== oldProps.fadeHoldDuration
    ) {
      const {fade} = this.state;
      const wantsFades = Boolean(props.fadeInDuration || props.fadeOutDuration);
      if (fade && !wantsFades) {
        // Turned off mid-scene: every ramp is restored to the opacities its page arrived with, and
        // the next frontier change hands the renderer the frontier itself.
        fade.reset();
        this.setState({fade: undefined});
        this._submitDrawList(Array.from(this.state.frontierBatches));
      } else if (fade) {
        fade.setProps({
          fadeInDuration: props.fadeInDuration!,
          fadeOutDuration: props.fadeOutDuration!,
          holdDuration: props.fadeHoldDuration!
        });
      } else if (wantsFades && props.splatHierarchy) {
        this.setState({fade: this._createFadeController()});
      }
    }

    if (
      props.splatHierarchy &&
      this.state.residency &&
      (!areBudgetsEqual(props.residencyBudget, oldProps.residencyBudget) ||
        props.deviceClass !== oldProps.deviceClass)
    ) {
      this.state.residency.setBudget(this._resolveResidencyBudget());
      this.setNeedsRedraw();
    }

    if (
      hierarchyChanged ||
      sourceChanged ||
      !arePercentilesEqual(props.scenePercentiles, oldProps.scenePercentiles) ||
      props.georeferenced !== oldProps.georeferenced ||
      props.sizeMeters !== oldProps.sizeMeters ||
      props.upAxis !== oldProps.upAxis
    ) {
      this.setState({placement: this._computePlacement()});
    }

    const {backend} = this.state;
    if (!backend) {
      return;
    }

    if (backend.kind === 'gpu-graph') {
      // Blend state, and therefore the alpha mode, is baked into the compositor's pipeline.
      if (
        props.depthCompare !== backend.depthCompare ||
        props.depthWriteEnabled !== backend.depthWriteEnabled ||
        props.alphaMode !== backend.alphaMode
      ) {
        backend.compositor.destroy();
        backend.compositor = new GPUSplatGraphMixedRenderer(backend.renderer, {
          depthCompare: props.depthCompare,
          // Stochastic coverage blends opaquely and owns the depth buffer, so a caller's depth
          // preference does not apply to it.
          depthWriteEnabled:
            props.alphaMode === 'stochastic' ? true : Boolean(props.depthWriteEnabled)
        });
        backend.depthCompare = props.depthCompare as CompareFunction;
        backend.depthWriteEnabled = Boolean(props.depthWriteEnabled);
        backend.alphaMode = props.alphaMode as GPUSplatAlphaMode;
      }

      backend.renderer.setProps({
        sphericalHarmonicsDegree: props.sphericalHarmonicsDegree,
        radiusScale: props.radiusScale,
        alphaScale: props.alphaScale,
        exposure: props.exposure,
        alphaCutoff: props.alphaCutoff,
        screenSizeCutoffPixels: props.screenSizeCutoffPixels,
        kernel2DSize: props.kernel2DSize,
        antialiasing: props.antialiasing,
        fragmentKernel: props.fragmentKernel,
        depthKeyMode: props.depthKeyMode,
        alphaMode: props.alphaMode,
        pickingAlphaThreshold: props.pickingAlphaThreshold
      });
      return;
    }

    backend.renderer.setProps({
      sphericalHarmonicsDegree: props.sphericalHarmonicsDegree,
      radiusScale: props.radiusScale,
      alphaScale: props.alphaScale,
      exposure: props.exposure,
      alphaCutoff: props.alphaCutoff,
      kernel2DSize: props.kernel2DSize,
      sortMode: 'global',
      depthCompare: props.depthCompare,
      depthWriteEnabled: props.depthWriteEnabled
    });
  }

  /**
   * Records projection, culling, spherical harmonics and the global depth sort.
   *
   * Everything camera-dependent happens here rather than in `draw`, because the render pass is
   * already open by then and a compute pass cannot join it. The encoder deck.gl supplies is the one
   * the following draw is recorded into, so nothing needs submitting or fencing.
   */
  compute(params: LayerComputeParameters): void {
    const {backend, placement} = this.state;
    if (backend?.kind !== 'gpu-graph' || !placement) {
      return;
    }

    // Extensions run after the layer's own `updateState`, so the clip region is settled here
    // rather than there. The renderer compares it by identity, so an unmoved region costs nothing.
    backend.renderer.setProps({
      clipRegion: this.state.clipRegion ?? this.props.clipRegion ?? undefined
    });
    this._updateCamera(backend, placement, params.viewport);
    // Runs before the graph is encoded, so a frontier change decided by this camera is the one
    // that gets drawn rather than trailing a frame behind it.
    this._updateHierarchyView(params.viewport);
    // And after it, so a ramp started by that frontier change is already a step in before the
    // graph reads the opacity columns.
    this._advanceFades();
    backend.compositor.predraw(params.commandEncoder);
  }

  draw(opts: {renderPass: any; shaderModuleProps?: any}): void {
    const {backend, placement} = this.state;
    if (!backend || !placement) {
      return;
    }

    if (backend.kind === 'cpu-sort') {
      this._updateCamera(backend, placement, this.context.viewport);
      this._updateHierarchyView(this.context.viewport);
      this._advanceFades();
      backend.renderer.draw(opts.renderPass);
      return;
    }

    // `isAttribute` marks deck.gl's depth (pickZ) pass, which reads a float target this layer has
    // no single meaningful depth to write into.
    const picking = opts.shaderModuleProps?.picking;
    if (picking?.isActive && !picking?.isAttribute) {
      this._drawPicking(opts.renderPass);
      return;
    }

    backend.compositor.draw(opts.renderPass);
  }

  /**
   * Resolves a picked color back to the original source row that produced it.
   *
   * The picking shader encodes the *projected row index* - the global row across every batch the
   * renderer currently holds - rather than the instance index, because the instance index is a
   * position in a sort order that changes every time the camera moves.
   */
  getPickingInfo({info}: GetPickingInfoParams): SplatPickingInfo {
    const pickInfo = info as SplatPickingInfo;
    pickInfo.splatBatchIndex = null;
    pickInfo.splatBatchRowIndex = null;
    pickInfo.splatSemanticId = null;

    const {backend} = this.state;
    if (backend?.kind !== 'gpu-graph' || info.index < 0) {
      return pickInfo;
    }

    let batchOffset = 0;
    for (const batch of backend.renderer.batches) {
      const batchRowIndex = info.index - batchOffset;
      if (batchRowIndex < batch.length) {
        if (batch.destroyed) {
          return pickInfo;
        }
        pickInfo.splatBatchIndex = batch.sourceBatchIndex;
        pickInfo.splatBatchRowIndex = batchRowIndex;
        pickInfo.splatSemanticId = batch.source.semanticIds?.[batchRowIndex] ?? null;
        pickInfo.object = {
          batchIndex: batch.sourceBatchIndex,
          rowIndex: batch.rowIndexBase + batchRowIndex,
          batchRowIndex,
          semanticId: pickInfo.splatSemanticId
        };
        return pickInfo;
      }
      batchOffset += batch.length;
    }
    return pickInfo;
  }

  finalizeState(): void {
    // Released without setState: the layer's internal state is torn down after this returns.
    this._destroyResources();
  }

  /** Which renderer this layer bound to, or `undefined` before a scene is uploaded. */
  getSplatBackend(): SplatBackendKind | undefined {
    return this.state.backend?.kind;
  }

  /**
   * Renderer diagnostics for the surrounding UI; `undefined` before a scene is uploaded.
   *
   * @remarks On the WebGL2 path `stats` refreshes the camera-dependent ordering before answering,
   * which is the same full CPU sort a frame pays. Poll it sparingly.
   */
  getSplatStats(): SplatRendererStats | undefined {
    return this.state.backend?.renderer.stats;
  }

  /** Traversal and residency counters for a streaming scene; `undefined` on the resident path. */
  getStreamingStats(): SplatStreamingStats | undefined {
    const {hierarchy, residency, drawnSplatCount} = this.state;
    if (!hierarchy || !residency) {
      return undefined;
    }
    return {
      hierarchy: hierarchy.stats,
      residency: residency.getStats(),
      drawnSplatCount,
      frontier: hierarchy.frontier,
      lingeringBatchCount: this.state.fade?.lingeringCount ?? 0
    };
  }

  /** Draws the visible rows with deck.gl's picking colors into deck.gl's picking framebuffer. */
  private _drawPicking(renderPass: any): void {
    const {backend} = this.state;
    if (backend?.kind !== 'gpu-graph' || !this.props.pickable) {
      return;
    }
    const model = this._getPickingModel(backend);
    if (!model || model.pipeline.isErrored || !backend.pickingSources) {
      return;
    }

    const sources = backend.pickingSources;
    const isCompatible = backend.renderer.renderPath === 'compatible';
    renderPass.setPipeline(model.pipeline);
    if (isCompatible) {
      model.setAttributes({
        sortedRecords: sources.sortedRecordBuffer!,
        sortedIds: sources.sortedIndexBuffer!
      });
      renderPass.setVertexArray(model.vertexArray);
      renderPass.setBindings({graphUniforms: sources.uniformBuffer});
    } else {
      renderPass.setVertexArray(model.vertexArray);
      renderPass.setBindings({
        graphUniforms: sources.uniformBuffer,
        projectedRecords: sources.projectedRecordBuffer!,
        sortedIds: sources.sortedIndexBuffer!
      });
    }
    backend.renderer.drawCommands.draw(renderPass, 0);
  }

  /** Builds or reuses the picking model, rebuilding it when the graph reallocates its buffers. */
  private _getPickingModel(backend: Extract<SplatBackend, {kind: 'gpu-graph'}>): Model | undefined {
    const {renderer} = backend;
    const uniformBuffer = renderer.uniformBuffer;
    const sortedIndexBuffer = renderer.sortedIndexBuffer;
    if (!uniformBuffer || !sortedIndexBuffer) {
      return undefined;
    }
    const isCompatible = renderer.renderPath === 'compatible';
    const projectedRecordBuffer = renderer.projectedRecordBuffer;
    const sortedRecordBuffer = renderer.sortedRecordBuffer;
    if (isCompatible ? !sortedRecordBuffer : !projectedRecordBuffer) {
      return undefined;
    }

    const previous = backend.pickingSources;
    if (
      backend.pickingModel &&
      previous &&
      previous.uniformBuffer === uniformBuffer &&
      previous.sortedIndexBuffer === sortedIndexBuffer &&
      previous.projectedRecordBuffer === projectedRecordBuffer &&
      previous.sortedRecordBuffer === sortedRecordBuffer
    ) {
      return backend.pickingModel;
    }

    backend.pickingModel?.destroy();
    backend.pickingSources = {
      uniformBuffer,
      projectedRecordBuffer,
      sortedIndexBuffer,
      sortedRecordBuffer
    };
    backend.pickingModel = new Model(this.context.device, {
      id: `${this.id}-splat-picking`,
      source: isCompatible ? SPLAT_COMPATIBLE_PICKING_SHADER : SPLAT_PICKING_SHADER,
      shaderLayout: isCompatible
        ? SPLAT_COMPATIBLE_PICKING_SHADER_LAYOUT
        : SPLAT_PICKING_SHADER_LAYOUT,
      ...(isCompatible
        ? {
            bufferLayout: [
              {
                name: 'sortedRecords',
                stepMode: 'instance' as const,
                byteStride: GPU_SPLAT_PROJECTED_RECORD_BYTE_LENGTH,
                attributes: [
                  {attribute: 'instanceClipCenter', format: 'float32x4' as const, byteOffset: 0},
                  {attribute: 'instancePackedRecord', format: 'uint32x4' as const, byteOffset: 16}
                ]
              },
              {
                name: 'sortedIds',
                stepMode: 'instance' as const,
                attributes: [
                  {attribute: 'instanceSortedId', format: 'uint32' as const, byteOffset: 0}
                ]
              }
            ],
            attributes: {sortedRecords: sortedRecordBuffer!, sortedIds: sortedIndexBuffer},
            bindings: {graphUniforms: uniformBuffer}
          }
        : {
            bindings: {
              graphUniforms: uniformBuffer,
              projectedRecords: projectedRecordBuffer!,
              sortedIds: sortedIndexBuffer
            }
          }),
      // deck.gl's picking framebuffer.
      colorAttachmentFormats: ['rgba8unorm'],
      depthStencilAttachmentFormat: 'depth16unorm',
      isInstanced: true,
      instanceCount: renderer.capacity.splatCount,
      vertexCount: 4,
      topology: 'triangle-strip',
      // Picking writes depth so the nearest Gaussian with real coverage wins, which the display
      // pass deliberately does not do.
      parameters: {depthWriteEnabled: true, depthCompare: 'less-equal', blend: false}
    });
    return backend.pickingModel;
  }

  /** Uploads a fully decoded scene once and reserves exactly the capacity it needs. */
  private _createResidentScene(sources: SplatSource[]): void {
    if (sources.length === 0) {
      this.props.onBackendChange?.(null);
      return;
    }

    const {device} = this.context;
    let rowIndexBase = 0;
    const splatData = sources.map((source, sourceBatchIndex) => {
      const batch = makeGPUSplatData(device, {...source, sourceBatchIndex, rowIndexBase});
      rowIndexBase += Math.floor(source.positions.length / 3);
      return batch;
    });

    this.setState({
      splatData,
      backend: this._createBackend(device, splatData, rowIndexBase, splatData.length),
      drawnSplatCount: rowIndexBase
    });
    this.props.onBackendChange?.(this.state.backend?.kind ?? null);
  }

  /**
   * Prepares a streaming scene: an empty renderer sized for the residency ceiling, then a traversal
   * to fill it.
   *
   * The renderer is created before a single page exists, which is the whole trick. Its command
   * graph is compiled once against `expectedSplatCount` and `expectedBatchCount`, and any later
   * batch list that fits inside those reuses it - so pages arriving, being evicted and changing
   * order cost a pointer swap rather than a rebuild of every buffer the graph owns. Reserving for
   * the *ceiling* rather than for the archive is what keeps that affordable.
   */
  private _createStreamingScene(source: SplatHierarchySource): void {
    const {device} = this.context;
    const budget = this._resolveResidencyBudget();

    const residency = new SplatResidencyManager(budget);
    const reservedSplats = resolveReservation(source.summary.splatCount, budget.maxResidentSplats);
    const reservedBatches = resolveReservation(source.summary.nodeCount, budget.maxResidentChunks);

    this.setState({
      hierarchySource: source,
      residency,
      splatData: [],
      drawnSplatCount: 0,
      ancestorIds: new Map(),
      pinnedLingering: new Set(),
      frontierBatches: new Set(),
      lastFadeTime: 0,
      fade: this._createFadeController(),
      backend: this._createBackend(device, [], reservedSplats, reservedBatches)
    });
    this.props.onBackendChange?.(this.state.backend?.kind ?? null);
    this._createTraversal();

    // A growing source pushes rather than being polled: it mutates `roots` and says so, and the
    // traversal re-indexes over the residency window the layer still owns. Nothing is reloaded.
    this.state.unsubscribeRoots = source.subscribe?.(() => {
      const {hierarchy, hierarchySource} = this.state;
      if (!hierarchy || hierarchySource !== source || hierarchy.destroyed) {
        return;
      }
      hierarchy.setRoots(source.roots);
      this.setNeedsRedraw();
    });
  }

  /** The ramp controller for the current fade props, or `undefined` when they are all off. */
  private _createFadeController(): SplatFadeController<GPUSplatData> | undefined {
    const {fadeInDuration, fadeOutDuration, fadeHoldDuration} = this.props;
    if (!fadeInDuration && !fadeOutDuration) {
      return undefined;
    }
    return new SplatFadeController<GPUSplatData>({
      fadeInDuration: fadeInDuration!,
      fadeOutDuration: fadeOutDuration!,
      holdDuration: fadeHoldDuration!
    });
  }

  /**
   * Advances the ramps and, when any of them moved, re-hands the draw list to the renderer.
   *
   * Runs once per frame from whichever stage owns the backend. A settled scene with no ramp in
   * flight does nothing and asks for no further frames, so an idle camera still costs nothing.
   */
  private _advanceFades(): void {
    const {fade, backend} = this.state;
    if (!fade?.animating || !backend) {
      return;
    }
    // Wall clock, deliberately, rather than `context.timeline`. The timeline is the *data* clock -
    // it is what a caller scrubs to animate through time - and a page ramping up is a property of
    // the renderer catching up with the camera, not of the moment being displayed.
    const now = performance.now();
    const elapsed = this.state.lastFadeTime > 0 ? Math.max(0, now - this.state.lastFadeTime) : 16;
    this.state.lastFadeTime = now;

    const before = fade.drawList;
    const animating = fade.advance(now, elapsed);
    if (fade.drawList !== before) {
      this._submitDrawList(fade.drawList as readonly GPUSplatData[]);
    }
    this._syncLingeringPins();
    if (animating) {
      this.setNeedsRedraw();
    }
  }

  /**
   * Hands a batch list to the renderer and records what it covers.
   *
   * `setProps({data})` compares element-wise, so a list that came back identical costs nothing -
   * which is what makes calling this per frame while a ramp runs acceptable.
   */
  private _submitDrawList(batches: readonly GPUSplatData[]): void {
    const {backend} = this.state;
    if (!backend) {
      return;
    }
    (backend.renderer as SplatRenderer).setProps({data: batches as GPUSplatData[]});
    // Assigned rather than `setState`, which would raise `stateChanged` and schedule a layer
    // update. A counter nothing reacts to is not a reason to re-run `updateState` every frame.
    this.state.drawnSplatCount = batches.reduce((total, batch) => total + batch.length, 0);
    this.setNeedsRedraw();
  }

  /**
   * Keeps a page the ramps are still drawing from being evicted underneath them.
   *
   * `SplatHierarchyManager` only releases pins it took itself, so the two pin systems must not
   * overlap: the moment the layer pins a page, the traversal stops claiming it and stops releasing
   * it, and the pin is the layer's for as long as the page matters. So a pin taken for a ramp is
   * held until the page is *both* done ramping and out of the frontier - at which point nothing
   * needs it protected, and a later refresh that brings it back finds it unpinned and claims it
   * normally.
   *
   * Taken the frame the page leaves the frontier, which is inside the traversal's own `update` and
   * therefore before any page it just queued can load and evict anything.
   */
  private _syncLingeringPins(): void {
    const {fade, residency, pinnedLingering, frontierBatches} = this.state;
    if (!fade || !residency) {
      return;
    }
    for (const batch of fade.drawList) {
      if (!fade.isLingering(batch) || pinnedLingering.has(batch)) {
        continue;
      }
      const chunk = residency.getChunk(batch);
      // Already pinned means the traversal owns that pin and will release it in its own time;
      // taking it over would leave a pin behind when the ramp ends.
      if (chunk && !chunk.pinned && residency.pin(chunk)) {
        pinnedLingering.add(batch);
      }
    }
    for (const batch of pinnedLingering) {
      if (fade.isLingering(batch) || frontierBatches.has(batch)) {
        continue;
      }
      pinnedLingering.delete(batch);
      if (!batch.destroyed) {
        residency.pin(batch, false);
      }
    }
  }

  /** The residency ceiling, from the device preset with any caller overrides applied. */
  private _resolveResidencyBudget(): SplatResidencyBudget {
    const {deviceClass, residencyBudget} = this.props;
    const preset = deviceClass
      ? SPLAT_DEVICE_BUDGETS[deviceClass]
      : getSplatDeviceBudget(this.context.device);
    return {...preset, ...(residencyBudget ?? undefined)};
  }

  /**
   * Builds the traversal over the layer's existing residency window.
   *
   * Nothing is requested here: `SplatHierarchyManager` only decides anything when it is given a
   * view, which happens in `compute`. So a rebuild indexes the node tree and nothing else, and the
   * pages the previous traversal loaded are still in the window it is handed.
   */
  private _createTraversal(): void {
    const {hierarchySource, residency} = this.state;
    if (!hierarchySource || !residency) {
      return;
    }

    this.state.hierarchy?.destroy();
    const hierarchy = new SplatHierarchyManager({
      roots: hierarchySource.roots,
      residencyManager: residency,
      loadPage: hierarchySource.createPageLoader(this.context.device),
      maximumScreenSpaceError: this.props.maximumScreenSpaceError,
      maxConcurrentLoads: this.props.maxConcurrentLoads,
      onFrontierChange: (batches, frontier) => this._onFrontierChange(batches, frontier),
      onLoadError: error => {
        // A cancelled page is not a failed one. The traversal aborts its own requests when the
        // camera turns away, and a source that is torn down rejects whatever it still had in
        // flight; neither says anything about the scene.
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        // A page that fails is a page that is not drawn; the coarser ancestor stays up and the
        // scene stays complete, so this is a diagnostic rather than a failure of the layer.
        // eslint-disable-next-line no-console
        console.warn(`[${this.id}] splat page load failed`, error);
      }
    });
    this.setState({hierarchy});
    this.setNeedsRedraw();
  }

  /**
   * Hands a changed frontier to the renderer.
   *
   * Fires from two places: synchronously inside `compute`, when the camera moved enough to change
   * which nodes are selected, and asynchronously when a page finishes loading. `setProps({data})`
   * compares the list element-wise, so a frontier that came back identical costs nothing.
   *
   * With ramps configured, what reaches the renderer is not the frontier but the frontier plus the
   * pages still fading out of it - which is the whole of the anti-popping behaviour, and the reason
   * the pin bookkeeping runs here rather than wherever a page happens to be evicted.
   */
  private _onFrontierChange(
    batches: readonly GPUSplatData[],
    frontier: readonly SplatHierarchyFrontierEntry[]
  ): void {
    const {backend, hierarchy, residency, fade} = this.state;
    if (!backend) {
      return;
    }

    this.state.frontierBatches = new Set(batches);

    if (fade) {
      const now = performance.now();
      if (this.state.lastFadeTime === 0) {
        this.state.lastFadeTime = now;
      }
      fade.sync(this._toFadeEntries(frontier), now);
      this._syncLingeringPins();
      this._submitDrawList(fade.drawList as readonly GPUSplatData[]);
    } else {
      this._submitDrawList(batches);
    }

    if (hierarchy && residency) {
      this.props.onStreamingStats?.({
        hierarchy: hierarchy.stats,
        residency: residency.getStats(),
        drawnSplatCount: this.state.drawnSplatCount,
        frontier,
        lingeringBatchCount: fade?.lingeringCount ?? 0
      });
    }
  }

  /**
   * Frontier entries with the root-to-node identity chain the ramps need, memoized per node.
   *
   * The chain is what lets a departing page recognize the pages that replaced it: refinement is
   * `'replace'`, so a page only ever gives way to its own descendants or to one of its ancestors,
   * and both directions are one `includes` against these. A node's chain never changes - a growing
   * source only ever appends children - so it is built once and kept even across traversal
   * rebuilds.
   */
  private _toFadeEntries(
    frontier: readonly SplatHierarchyFrontierEntry[]
  ): SplatFadeEntry<GPUSplatData>[] {
    const {ancestorIds, hierarchy} = this.state;
    return frontier.map(entry => {
      let chain = ancestorIds.get(entry.node.id);
      if (!chain) {
        const built: string[] = [];
        let parentId = entry.node.parentId;
        // Bounded by the tree's own depth; `seen` is only there so a source that reports a cyclic
        // `parentId` degrades to a wrong fade rather than to a hung frame.
        const seen = new Set<string>([entry.node.id]);
        while (parentId && !seen.has(parentId)) {
          seen.add(parentId);
          built.push(parentId);
          parentId = hierarchy?.getNode(parentId)?.parentId;
        }
        chain = built;
        ancestorIds.set(entry.node.id, chain);
      }
      return {id: entry.node.id, ancestorIds: chain, batch: entry.chunk.data};
    });
  }

  /**
   * Runs the traversal against the camera the layer has just submitted.
   *
   * The view is expressed in *scene units*, not deck.gl's common space: node bounds are in the
   * scene's own coordinates, and `_updateCamera` has already produced the camera position in those
   * same coordinates through the inverse model matrix. Screen-space error is a ratio of the two
   * times a focal length in pixels, so it comes out in real pixels as long as both sides agree.
   */
  private _updateHierarchyView(viewport: Viewport): void {
    const {hierarchy, camera} = this.state;
    if (!hierarchy) {
      return;
    }

    const {device} = this.context;
    const ratio = device.canvasContext?.cssToDeviceRatio?.() ?? 1;
    // `fovyRadians` is the base viewport's; `fovy` is WebMercatorViewport's, in degrees.
    const viewportWithFieldOfView = viewport as unknown as {fovyRadians?: number; fovy?: number};
    const verticalFieldOfView =
      viewportWithFieldOfView.fovyRadians ??
      (viewportWithFieldOfView.fovy === undefined
        ? undefined
        : (viewportWithFieldOfView.fovy * Math.PI) / 180);

    hierarchy.update({
      cameraPosition: camera.cameraPosition,
      viewportSize: [Math.max(1, viewport.width * ratio), Math.max(1, viewport.height * ratio)],
      modelViewProjectionMatrix: Array.from(camera.modelViewProjectionMatrix),
      ...(verticalFieldOfView === undefined ? {} : {verticalFieldOfView})
    });
  }

  /**
   * Binds the fastest renderer the device can run, sized for what it will be asked to hold.
   *
   * `presentation: false` is what keeps the WebGPU path honest inside deck.gl. The compiled graph
   * would otherwise record a presentation pass of its own and rasterize every visible Gaussian into
   * a canvas deck.gl then clears over - pure wasted fill, once per frame.
   */
  private _createBackend(
    device: Device,
    splatData: GPUSplatData[],
    reservedSplatCount: number,
    reservedBatchCount: number
  ): SplatBackend {
    const {alphaMode, depthCompare, depthWriteEnabled} = this.props;

    if (device.type === 'webgpu') {
      const renderer = new GPUSplatGraphRenderer(device, {
        data: splatData,
        expectedSplatCount: Math.max(1, reservedSplatCount),
        expectedBatchCount: Math.max(1, reservedBatchCount),
        presentation: false,
        alphaMode,
        antialiasing: this.props.antialiasing,
        fragmentKernel: this.props.fragmentKernel,
        depthKeyMode: this.props.depthKeyMode,
        pickingAlphaThreshold: this.props.pickingAlphaThreshold,
        ...(this.props.clipRegion ? {clipRegion: this.props.clipRegion} : {})
      });
      return {
        kind: 'gpu-graph',
        renderer,
        compositor: new GPUSplatGraphMixedRenderer(renderer, {
          depthCompare,
          depthWriteEnabled: alphaMode === 'stochastic' ? true : Boolean(depthWriteEnabled)
        }),
        depthCompare: depthCompare as CompareFunction,
        depthWriteEnabled: Boolean(depthWriteEnabled),
        alphaMode: alphaMode as GPUSplatAlphaMode
      };
    }

    return {kind: 'cpu-sort', renderer: new SplatRenderer(device, {data: splatData})};
  }

  /**
   * The scene's normalization, from whichever source can supply it.
   *
   * `scenePercentiles` wins when it is given, because a streamed scene has no other way to know:
   * the layer never holds more than the frontier, and the frontier is not the scene.
   */
  private _computePlacement(): SplatPlacement | undefined {
    const {georeferenced, scenePercentiles, splatHierarchy, splatSource, sizeMeters, upAxis} =
      this.props;

    if (georeferenced) {
      // One to one: the source's units are already the anchor's metres and its origin is already
      // where the anchor is. `extentUnits` only scales the WebGL2 camera-move threshold below.
      const horizontalExtent = scenePercentiles
        ? Math.max(
            scenePercentiles.x[1] - scenePercentiles.x[0],
            scenePercentiles.y[1] - scenePercentiles.y[0]
          )
        : 1;
      return {metersPerUnit: 1, offset: [0, 0, 0], extentUnits: Math.max(horizontalExtent, 1e-6)};
    }

    if (scenePercentiles) {
      return computePlacementFromPercentiles(scenePercentiles, sizeMeters!, upAxis!);
    }
    if (splatHierarchy) {
      // Without percentiles a streamed scene cannot be normalized, and guessing from whatever
      // happens to be resident would move the whole scene every time a page loads.
      return undefined;
    }

    const sources = normalizeSources(splatSource);
    return sources.length > 0
      ? computePlacementFromPercentiles(computeScenePercentiles(sources), sizeMeters!, upAxis!)
      : undefined;
  }

  /**
   * Rebuilds the source-units-to-clip-space transform only when something it depends on moved.
   *
   * `viewport.viewProjectionMatrix` consumes absolute common-space positions and already folds in a
   * translation by the viewport center, so composing it with the model matrix in float64 keeps the
   * large common-space magnitudes from ever reaching float32. The model matrix itself depends only
   * on the anchor, the placement and the viewport's distance scales - none of which change when the
   * camera merely rotates - so it and its inverse are cached across frames.
   */
  private _updateModelMatrix(viewport: Viewport, placement: SplatPlacement): void {
    const {coordinateOrigin, heading, upAxis} = this.props;
    const origin = viewport.projectPosition(coordinateOrigin as number[]);
    // Web Mercator common space is isotropic, so one scalar covers all three axes.
    const unitsPerMeter = viewport.distanceScales.unitsPerMeter[2];
    const cache = this.state.camera;

    if (
      cache.placement === placement &&
      cache.unitsPerMeter === unitsPerMeter &&
      cache.heading === heading &&
      cache.upAxis === upAxis &&
      cache.origin[0] === origin[0] &&
      cache.origin[1] === origin[1] &&
      cache.origin[2] === origin[2]
    ) {
      return;
    }

    cache.placement = placement;
    cache.unitsPerMeter = unitsPerMeter;
    cache.heading = heading!;
    cache.upAxis = upAxis!;
    cache.origin = [origin[0], origin[1], origin[2]];

    const matrix = cache.modelMatrix
      .identity()
      .translate(origin)
      .scale(unitsPerMeter)
      .rotateZ((-(heading ?? 0) * Math.PI) / 180)
      .scale(placement.metersPerUnit);

    if (upAxis === 'y-down') {
      // Maps local (x right, y down, z forward) onto east / north / up.
      matrix.rotateX(-Math.PI / 2);
    }

    matrix.translate([-placement.offset[0], -placement.offset[1], -placement.offset[2]]);
    cache.inverseModelMatrix.copy(matrix).invert();
  }

  /**
   * Submits the camera values that actually changed, and nothing else.
   *
   * On the WebGPU path every changed value costs one re-encode of an already compiled command
   * graph. On the WebGL2 path a changed matrix costs a full CPU re-sort and attribute repack, and a
   * changed camera position costs a CPU spherical-harmonic pass and another repack on top, so the
   * position is held back until the camera has drifted far enough to visibly differ.
   */
  private _updateCamera(
    backend: SplatBackend,
    placement: SplatPlacement,
    viewport: Viewport
  ): void {
    const {device} = this.context;
    const cache = this.state.camera;

    this._updateModelMatrix(viewport, placement);

    const matrix = cache.modelViewProjectionMatrix
      .copy(viewport.viewProjectionMatrix as number[])
      .multiplyRight(cache.modelMatrix);

    let matrixChanged = !cache.submittedMatrix;
    for (let index = 0; !matrixChanged && index < 16; index++) {
      matrixChanged = cache.submittedMatrix![index] !== matrix[index];
    }

    // Spherical-harmonic radiance is evaluated against a scene-local view direction.
    cache.inverseModelMatrix.transformAsPoint(viewport.cameraPosition, cache.cameraPosition);
    const submittedPosition = cache.submittedCameraPosition;
    const cameraMoveThreshold =
      backend.kind === 'cpu-sort'
        ? placement.extentUnits * CPU_SPHERICAL_HARMONICS_MOVE_FRACTION
        : 0;
    const cameraMoved =
      !submittedPosition ||
      Math.hypot(
        cache.cameraPosition[0] - submittedPosition[0],
        cache.cameraPosition[1] - submittedPosition[1],
        cache.cameraPosition[2] - submittedPosition[2]
      ) > cameraMoveThreshold;

    const ratio = device.canvasContext?.cssToDeviceRatio?.() ?? 1;
    const width = Math.max(1, viewport.width * ratio);
    const height = Math.max(1, viewport.height * ratio);
    const submittedSize = cache.submittedViewportSize;
    const sizeChanged = !submittedSize || submittedSize[0] !== width || submittedSize[1] !== height;

    if (!matrixChanged && !cameraMoved && !sizeChanged) {
      return;
    }

    // A fresh array per submitted value. The renderers copy what they accept, so reusing one would
    // make the record of what was submitted drift from what the renderer actually holds.
    if (matrixChanged) {
      cache.submittedMatrix = Array.from(matrix);
    }
    if (cameraMoved) {
      cache.submittedCameraPosition = [...cache.cameraPosition];
    }
    if (sizeChanged) {
      cache.submittedViewportSize = [width, height];
    }

    // Both renderers accept the same camera props; only the depth and data props differ.
    (backend.renderer as SplatRenderer).setProps({
      ...(matrixChanged ? {modelViewProjectionMatrix: cache.submittedMatrix} : {}),
      ...(cameraMoved ? {cameraPosition: cache.submittedCameraPosition} : {}),
      ...(sizeChanged ? {viewportSize: cache.submittedViewportSize} : {})
    });
  }

  private _invalidateCameraCache(): void {
    const cache = this.state.camera;
    cache.placement = undefined;
    cache.submittedMatrix = undefined;
    cache.submittedCameraPosition = undefined;
    cache.submittedViewportSize = undefined;
  }

  private _releaseScene(): void {
    this._destroyResources();
    this.setState({
      backend: undefined,
      splatData: [],
      hierarchy: undefined,
      residency: undefined,
      hierarchySource: undefined,
      fade: undefined,
      unsubscribeRoots: undefined,
      ancestorIds: new Map(),
      pinnedLingering: new Set(),
      frontierBatches: new Set(),
      lastFadeTime: 0,
      drawnSplatCount: 0
    });
  }

  /**
   * Tears the scene down in the one order that is safe.
   *
   * Everything here borrows something else. The renderers borrow batches, the traversal borrows the
   * residency window, and the residency window owns the streamed pages - so the renderers go first,
   * then the traversal, then the window, and only then the batches this layer uploaded itself.
   * Destroying the window before the renderer would free GPU buffers the compiled graph still
   * points at.
   */
  private _destroyResources(): void {
    const {backend, hierarchy, residency} = this.state;
    this.state.unsubscribeRoots?.();
    // Before the pages go: a ramp mid-flight has scaled opacities in a column the caller may still
    // own on the resident path, and restoring them is cheaper than reasoning about who does.
    this.state.fade?.reset();
    if (backend?.kind === 'gpu-graph') {
      backend.pickingModel?.destroy();
      backend.compositor.destroy();
    }
    backend?.renderer.destroy();

    hierarchy?.destroy();
    // Owns every streamed page, because each hierarchy node is created with `ownsData: true`.
    residency?.destroy();

    for (const batch of this.state.splatData ?? []) {
      batch.destroy();
    }
  }
}

function normalizeSources(
  splatSource: SplatSource | SplatSource[] | null | undefined
): SplatSource[] {
  if (!splatSource) {
    return [];
  }
  return Array.isArray(splatSource) ? splatSource : [splatSource];
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round(fraction * (sorted.length - 1)))
  );
  return sorted[index];
}

/**
 * Derives a scale and origin offset from robust percentiles rather than absolute bounds.
 *
 * Reconstructions routinely contain a handful of far-flung "floater" splats. Fitting to the
 * absolute min/max would let one stray splat shrink the whole scene to a speck, so the extent and
 * the ground plane are both taken from percentiles.
 */
function computePlacementFromPercentiles(
  percentiles: ScenePercentiles,
  sizeMeters: number,
  upAxis: SplatUpAxis
): SplatPlacement {
  // `y-down` scenes use x/z as the ground plane and -y as up; `z-up` scenes use x/y and +z.
  const horizontal =
    upAxis === 'y-down' ? [percentiles.x, percentiles.z] : [percentiles.x, percentiles.y];
  const vertical = upAxis === 'y-down' ? percentiles.y : percentiles.z;

  const extent = Math.max(...horizontal.map(([low, high]) => high - low), 1e-6);
  const centers = horizontal.map(([low, high]) => (low + high) / 2);
  // In a y-down scene the ground is the *largest* y; in a z-up scene it is the smallest z.
  const ground = upAxis === 'y-down' ? vertical[1] : vertical[0];

  return {
    metersPerUnit: sizeMeters / extent,
    offset:
      upAxis === 'y-down' ? [centers[0], ground, centers[1]] : [centers[0], centers[1], ground],
    extentUnits: extent
  };
}

/** Samples the percentiles out of resident columns, for a scene that has all of them. */
function computeScenePercentiles(sources: SplatSource[]): ScenePercentiles {
  const totalSplats = sources.reduce((sum, source) => sum + source.positions.length / 3, 0);
  const stride = Math.max(1, Math.floor(totalSplats / PLACEMENT_SAMPLE_LIMIT));

  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (const source of sources) {
    const splatCount = Math.floor(source.positions.length / 3);
    for (let index = 0; index < splatCount; index += stride) {
      xs.push(source.positions[index * 3]);
      ys.push(source.positions[index * 3 + 1]);
      zs.push(source.positions[index * 3 + 2]);
    }
  }
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  zs.sort((a, b) => a - b);

  return {
    x: [percentile(xs, 0.02), percentile(xs, 0.98)],
    y: [percentile(ys, 0.02), percentile(ys, 0.98)],
    z: [percentile(zs, 0.02), percentile(zs, 0.98)]
  };
}

/**
 * Compared by value, not by reference.
 *
 * Both of these arrive as object literals from a render, so a fresh identity every frame says
 * nothing about whether anything changed - and acting on a false change here would rebuild the
 * placement or trim the residency window sixty times a second.
 */
function arePercentilesEqual(
  first: ScenePercentiles | null | undefined,
  second: ScenePercentiles | null | undefined
): boolean {
  if (!first || !second) {
    return first === second;
  }
  return (['x', 'y', 'z'] as const).every(
    axis => first[axis][0] === second[axis][0] && first[axis][1] === second[axis][1]
  );
}

function areBudgetsEqual(
  first: SplatResidencyBudget | null | undefined,
  second: SplatResidencyBudget | null | undefined
): boolean {
  return (
    first?.maxGpuBytes === second?.maxGpuBytes &&
    first?.maxResidentSplats === second?.maxResidentSplats &&
    first?.maxResidentChunks === second?.maxResidentChunks
  );
}

/** Chooses a finite reservation from a budget that may be unbounded. */
function resolveReservation(total: number, budgeted: number | undefined): number {
  return Math.max(1, Math.min(total, budgeted ?? total));
}
