// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import MapController from './map-controller';
import {MapState, MapStateProps} from './map-controller';
import type {ControllerProps, InteractionState} from './controller';
import type Viewport from '../viewports/viewport';
import type {Timeline} from '@luma.gl/engine';

/** How often the terrain under the viewport center is sampled, in milliseconds. */
const PICK_INTERVAL = 500;

/** Time constant of the filter that carries the baseline to a new sample, in milliseconds. */
const ALTITUDE_TIME_CONSTANT = 350;

/**
 * Ceiling on how fast a baseline change is allowed to slide the scene across the screen, in
 * pixels per second.
 *
 * Moving the baseline translates the camera vertically, and at a shallow pitch one meter of
 * baseline is worth nearly half a pixel, so an unbounded step reads as a jump rather than as
 * camera motion. Capping the *visual* speed rather than the altitude rate keeps the bound
 * meaningful at every zoom level.
 */
const MAX_BASELINE_PIXELS_PER_SECOND = 300;

/**
 * How far a sample may be from the accepted target before it has to be confirmed, in meters.
 *
 * A step this large is as likely to be a terrain tile refining under the sample point, or the
 * center ray crossing a cliff edge onto something far behind it, as it is a real move.
 */
const CONFIRM_STEP_METERS = 20;

/** The baseline counts as settled once it is within this many pixels of its target. */
const SETTLED_PIXELS = 0.05;

/** Longest frame interval the filter integrates over, in milliseconds. */
const MAX_FRAME_INTERVAL = 100;

/**
 * Controller that extends MapController with terrain-aware behavior.
 * The camera smoothly follows terrain elevation during pan/zoom.
 *
 * The elevation under the viewport center is sampled from the depth of a `pickable: '3d'` layer
 * and written into the view state as `position[2]`, so zoom, pitch and rotation are all measured
 * against the surface instead of the sea-level plane.
 */
export default class TerrainController extends MapController {
  /** Camera altitude baseline currently written into the view state, in meters. */
  private _terrainAltitude?: number = undefined;
  /** Terrain elevation most recently accepted from picking, in meters. */
  private _terrainAltitudeTarget?: number = undefined;
  /** A large sample held back until a second sample confirms it, in meters. */
  private _terrainAltitudeCandidate?: number = undefined;
  /** deck's animation-loop timeline, used as the clock for sampling and filtering. */
  private _timeline: Timeline;
  /** Timeline time of the last pick. */
  private _lastPickTime: number = -Infinity;
  /** Timeline time of the last frame, or `undefined` before the first one. */
  private _lastFrameTime?: number = undefined;

  constructor(opts: ConstructorParameters<typeof MapController>[0]) {
    super(opts);
    this._timeline = opts.timeline;
  }

  setProps(
    props: ControllerProps &
      MapStateProps & {
        rotationPivot?: 'center' | '2d' | '3d';
        getAltitude?: (pos: [number, number]) => number | undefined;
      }
  ) {
    super.setProps({rotationPivot: '3d', ...props});
    this._adoptAppAltitude(props.position?.[2]);
  }

  /**
   * Samples the terrain and advances the baseline toward it.
   *
   * deck calls this once per rendered frame, which is what keeps the baseline honest: it tracks
   * the terrain whether or not the user is interacting, so a gesture never has to absorb an
   * accumulated correction, and the filter runs on elapsed time rather than on how many events
   * a gesture happened to produce.
   *
   * @remarks
   * While the baseline moves, this calls `onViewStateChange` from the frame loop, outside any
   * user gesture, with an empty `interactionState` and `transitionDuration: 0`. Nothing is
   * published while a transition is running (it owns `position`), while the user is dragging
   * (the drag's own event carries the baseline), or once the baseline has settled.
   */
  updateTransition(): void {
    super.updateTransition();

    const time = this._timeline.getTime();
    const interval =
      this._lastFrameTime === undefined
        ? 0
        : Math.min(Math.max(time - this._lastFrameTime, 0), MAX_FRAME_INTERVAL);
    this._lastFrameTime = time;

    if (time - this._lastPickTime >= PICK_INTERVAL && !this.isDragging()) {
      this._lastPickTime = time;
      this._sampleTerrainAltitude();
    }
    this._advanceTerrainAltitude(interval);
  }

  protected updateViewport(
    newControllerState: MapState,
    extraProps: Record<string, any> | null = null,
    interactionState: InteractionState = {}
  ): void {
    // Not initialized yet — pass through to MapController
    if (this._terrainAltitude === undefined) {
      super.updateViewport(newControllerState, extraProps, interactionState);
      return;
    }

    const {position = [0, 0, 0]} = newControllerState.getViewportProps();
    super.updateViewport(
      newControllerState,
      {...extraProps, position: [position[0], position[1], this._terrainAltitude]},
      interactionState
    );
  }

  /**
   * Takes over a baseline the app wrote into the view state itself.
   *
   * Once settled, the controller republishes nothing, so without this the next gesture would
   * snap the camera from the app's `position[2]` back to the controller's own baseline. Adopting
   * it instead lets the filter carry the camera back to the terrain at its bounded speed. Only
   * done while settled and idle: mid-glide, a controlled app echoes values the controller has
   * already moved past, and a transition owns `position` while it runs.
   */
  private _adoptAppAltitude(altitude: number | undefined): void {
    const current = this._terrainAltitude;
    if (
      altitude === undefined ||
      current === undefined ||
      altitude === current ||
      current !== this._terrainAltitudeTarget ||
      this.isDragging() ||
      this.transitionManager.getViewportInTransition()
    ) {
      return;
    }
    const pixelsPerMeter = getPixelsPerMeter(
      this.makeViewport(this._getControllerState().getViewportProps())
    );
    if (Math.abs(altitude - current) > SETTLED_PIXELS / pixelsPerMeter) {
      this._terrainAltitude = altitude;
    }
  }

  /** Reads the terrain elevation under the viewport center into the target. */
  private _sampleTerrainAltitude(): void {
    if (!this.pickPosition) {
      return;
    }
    const {x, y, width, height} = this.props;
    const coordinate = this.pickPosition(x + width / 2, y + height / 2)?.coordinate;
    if (!coordinate || coordinate.length < 3) {
      // Nothing under the center: sky above the horizon, or a tile that has not arrived. Hold
      // the target rather than inventing one.
      this._terrainAltitudeCandidate = undefined;
      return;
    }

    const altitude = coordinate[2];
    if (
      this._terrainAltitudeTarget === undefined ||
      Math.abs(altitude - this._terrainAltitudeTarget) <= CONFIRM_STEP_METERS
    ) {
      this._terrainAltitudeTarget = altitude;
      this._terrainAltitudeCandidate = undefined;
    } else if (
      this._terrainAltitudeCandidate !== undefined &&
      Math.abs(altitude - this._terrainAltitudeCandidate) <= CONFIRM_STEP_METERS
    ) {
      // Two samples agree on somewhere new, so it is the terrain that moved, not the pick.
      this._terrainAltitudeTarget = altitude;
      this._terrainAltitudeCandidate = undefined;
    } else {
      this._terrainAltitudeCandidate = altitude;
    }
  }

  /** Moves the applied baseline toward the target and publishes the result. */
  private _advanceTerrainAltitude(interval: number): void {
    const target = this._terrainAltitudeTarget;
    if (target === undefined) {
      return;
    }

    if (this._terrainAltitude === undefined) {
      // First fix on the terrain. Adopting it must not move the camera, so the shift is paid for
      // with the zoom and center that reproduce the view the app asked for.
      const initialState = this._getControllerState();
      const rebaseProps = this._rebaseViewport(target, initialState);
      if (rebaseProps) {
        this._terrainAltitude = target;
        super.updateViewport(this._getControllerState(rebaseProps));
        return;
      }
      // The camera sits below the terrain the app pointed it at, so no zoom reproduces this view
      // from the new baseline. Start from the baseline already in the view state and let the
      // filter below carry the camera up at a speed that reads as motion.
      this._terrainAltitude = initialState.getViewportProps().position?.[2] ?? 0;
    }

    const delta = target - this._terrainAltitude;
    if (delta === 0 || interval <= 0) {
      return;
    }
    // A transition owns `position` while it runs; stepping the baseline underneath it would
    // fight the interpolator.
    if (this.transitionManager.getViewportInTransition()) {
      return;
    }

    const controllerState = this._getControllerState();
    const viewportProps = controllerState.getViewportProps();
    const pixelsPerMeter = getPixelsPerMeter(this.makeViewport(viewportProps));

    const settled = SETTLED_PIXELS / pixelsPerMeter;
    if (Math.abs(delta) <= settled) {
      this._terrainAltitude = target;
    } else {
      const eased = delta * (1 - Math.exp(-interval / ALTITUDE_TIME_CONSTANT));
      const ceiling = ((MAX_BASELINE_PIXELS_PER_SECOND / pixelsPerMeter) * interval) / 1000;
      this._terrainAltitude += Math.sign(delta) * Math.min(Math.abs(eased), ceiling);
    }

    // A drag publishes the baseline itself on its own event, with the interaction state that
    // belongs to it.
    if (this.isDragging()) {
      return;
    }
    const {position = [0, 0, 0]} = viewportProps;
    super.updateViewport(controllerState, {
      position: [position[0], position[1], this._terrainAltitude],
      transitionDuration: 0
    });
  }

  /** Builds a controller state from the current props, optionally overridden. */
  private _getControllerState(extraProps?: Record<string, any>): MapState {
    return new this.ControllerState({
      makeViewport: this.makeViewport,
      ...this.props,
      ...this.state,
      ...extraProps
    } as any);
  }

  /**
   * Computes viewport adjustments that keep the view visually the same
   * when shifting the camera baseline to `altitude`.
   */
  private _rebaseViewport(
    altitude: number,
    newControllerState: MapState
  ): Record<string, any> | null {
    const viewportProps = newControllerState.getViewportProps();
    const oldViewport = this.makeViewport(viewportProps);
    const unitsPerMeterZ = oldViewport.distanceScales.unitsPerMeter[2];

    const currentCenterZ = (viewportProps.position?.[2] ?? 0) * unitsPerMeterZ;
    const cameraHeightAboveCenter = oldViewport.cameraPosition[2] - currentCenterZ;
    const newCameraHeightAboveCenter = oldViewport.cameraPosition[2] - altitude * unitsPerMeterZ;
    if (cameraHeightAboveCenter <= 0 || newCameraHeightAboveCenter <= 0) {
      return null;
    }

    // Camera distance is proportional to 2^-zoom, so trading the baseline against the zoom leaves
    // the camera where it is.
    const newZoom =
      viewportProps.zoom + Math.log2(cameraHeightAboveCenter / newCameraHeightAboveCenter);

    const newViewport = this.makeViewport({
      ...viewportProps,
      zoom: newZoom,
      position: [0, 0, altitude]
    });
    const {width, height} = viewportProps;
    const screenCenter: [number, number] = [width / 2, height / 2];
    const worldPoint = oldViewport.unproject(screenCenter, {targetZ: altitude});
    if (
      worldPoint &&
      'panByPosition3D' in newViewport &&
      typeof newViewport.panByPosition3D === 'function'
    ) {
      const adjusted = newViewport.panByPosition3D(worldPoint, screenCenter);
      return {position: [0, 0, altitude], zoom: newZoom, ...adjusted};
    }
    return null;
  }
}

/**
 * Pixels the scene travels for one meter of baseline change.
 *
 * The baseline translates the camera vertically, so this is the vertical common-space scale:
 * common units per meter times pixels per common unit.
 */
function getPixelsPerMeter(viewport: Viewport): number {
  const pixelsPerMeter = viewport.distanceScales.unitsPerMeter[2] * viewport.scale;
  return pixelsPerMeter > 0 ? pixelsPerMeter : 1;
}
