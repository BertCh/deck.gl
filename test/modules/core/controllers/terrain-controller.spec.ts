// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {MapView, TerrainController, WebMercatorViewport} from '@deck.gl/core';
import {Timeline} from '@luma.gl/engine';

const WIDTH = 800;
const HEIGHT = 600;
const FRAME_INTERVAL = 16;

const INITIAL_VIEW_STATE = {
  longitude: 7.9091,
  latitude: 46.5936,
  zoom: 14.5,
  pitch: 70,
  bearing: 165
};

/** A fixed point on the valley floor, used to measure how far the scene travels on screen. */
const PROBE_POINT: [number, number, number] = [7.9091, 46.5963, 785.4];

/** 300 px/s over a 16 ms frame, with room for rounding. */
const MAX_SHIFT_PER_FRAME = 6;

function screenDistance(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * A `TerrainController` wired to a `MapView`, with the terrain elevation and the frame clock
 * under the test's control.
 */
function createTerrainController() {
  const view = new MapView({controller: {type: TerrainController}});
  const timeline = new Timeline();
  let viewStates: Record<string, any>[] = [];

  let currentProps: Record<string, any> = {
    id: 'terrain-view',
    x: 0,
    y: 0,
    width: WIDTH,
    height: HEIGHT,
    ...view.controller,
    ...INITIAL_VIEW_STATE
  };
  /** Elevation the next pick reports, or `undefined` for a pick that hits nothing. */
  let terrainElevation: number | undefined;

  const makeViewport = (viewState: Record<string, any>) =>
    view.makeViewport({width: WIDTH, height: HEIGHT, viewState});

  const controller = new (currentProps.type as typeof TerrainController)({
    timeline,
    // @ts-expect-error the test drives the controller directly, without an event manager
    eventManager: null,
    makeViewport,
    onViewStateChange: ({viewState}) => {
      viewStates.push(viewState);
      currentProps = {...currentProps, ...viewState};
      controller.setProps(currentProps);
    },
    onStateChange: () => {},
    pickPosition: () =>
      terrainElevation === undefined
        ? null
        : {
            coordinate: [
              INITIAL_VIEW_STATE.longitude,
              INITIAL_VIEW_STATE.latitude,
              terrainElevation
            ]
          }
  });
  // `MapController` normalizes the view state once on the first `setProps`, which is not a terrain
  // update, so the recorded view states start after it.
  controller.setProps(currentProps);
  viewStates = [];

  const projectProbe = () => makeViewport(currentProps).project(PROBE_POINT) as number[];
  const getBaseline = () => currentProps.position?.[2] ?? 0;

  const runFrames = (count: number) => {
    for (let i = 0; i < count; i++) {
      timeline.setTime(timeline.getTime() + FRAME_INTERVAL);
      controller.updateTransition();
    }
  };

  return {
    controller,
    projectProbe,
    getBaseline,
    runFrames,
    getViewStates: () => viewStates,
    getViewState: () => currentProps,
    setTerrainElevation: (elevation: number | undefined) => {
      terrainElevation = elevation;
    },
    /**
     * Runs frames until the baseline settles on `altitude`, reporting the largest distance the
     * camera travelled in any one frame -- both as the baseline step the controller bounds, in
     * pixels, and as the distance the probe point moved on screen.
     */
    runUntilSettled: (altitude: number, maxSeconds: number = 20) => {
      const frames = (maxSeconds * 1000) / FRAME_INTERVAL;
      let previousProbe = projectProbe();
      let previousBaseline = getBaseline();
      let maxBaselineStep = 0;
      let maxProbeShift = 0;
      for (let i = 0; i < frames; i++) {
        runFrames(1);
        const viewport = makeViewport(currentProps) as WebMercatorViewport;
        const pixelsPerMeter = viewport.distanceScales.unitsPerMeter[2] * viewport.scale;
        maxBaselineStep = Math.max(
          maxBaselineStep,
          Math.abs(getBaseline() - previousBaseline) * pixelsPerMeter
        );
        previousBaseline = getBaseline();
        const probe = projectProbe();
        maxProbeShift = Math.max(maxProbeShift, screenDistance(probe, previousProbe));
        previousProbe = probe;
        if (getBaseline() === altitude) {
          return {maxBaselineStep, maxProbeShift, settled: true};
        }
      }
      return {maxBaselineStep, maxProbeShift, settled: false};
    }
  };
}

test('TerrainController#adopts the first terrain fix without moving the camera', () => {
  const app = createTerrainController();
  const before = app.projectProbe();

  app.setTerrainElevation(785.4);
  app.runFrames(2);

  expect(app.getBaseline()).toBeCloseTo(785.4, 6);
  // The baseline is paid for with zoom and center, so nothing on screen moves.
  expect(screenDistance(app.projectProbe(), before)).toBeLessThan(1);
  expect(app.getViewState().zoom).toBeGreaterThan(INITIAL_VIEW_STATE.zoom);
});

test('TerrainController#a gesture never absorbs a backlog of terrain updates', () => {
  const app = createTerrainController();
  app.setTerrainElevation(785.4);
  app.runFrames(2);

  // The terrain under the viewport center drops away, as it does when a tile refines or the
  // center ray crosses a cliff edge, and the app then sits idle while the frame loop follows it.
  app.setTerrainElevation(385.4);
  expect(app.runUntilSettled(385.4).settled).toBe(true);

  // Zooming now must not move the camera baseline at all: the frame loop already tracked it, so
  // there is nothing left for the gesture to catch up on.
  const baselineBeforeZoom = app.getBaseline();
  const state = app.controller.controllerState;
  // @ts-expect-error protected in the base class, exercised here the way an event would
  app.controller.updateViewport(state.zoom({pos: [WIDTH / 2, HEIGHT / 2], scale: 2}));

  expect(app.getBaseline()).toBeCloseTo(baselineBeforeZoom, 6);
});

test('TerrainController#a step change in terrain elevation glides instead of jumping', () => {
  const app = createTerrainController();
  app.setTerrainElevation(785.4);
  app.runFrames(2);

  // A 600 m step is worth hundreds of pixels at this pitch.
  app.setTerrainElevation(1385.4);
  const {maxBaselineStep, maxProbeShift, settled} = app.runUntilSettled(1385.4);

  expect(settled).toBe(true);
  expect(maxBaselineStep).toBeLessThan(MAX_SHIFT_PER_FRAME);
  expect(maxProbeShift).toBeLessThan(MAX_SHIFT_PER_FRAME);
});

test('TerrainController#a single outlier sample does not move the baseline', () => {
  const app = createTerrainController();
  app.setTerrainElevation(785.4);
  app.runFrames(2);
  const settled = app.getBaseline();

  // One pick lands on something far behind the terrain, then the terrain reports itself again.
  app.setTerrainElevation(3785.4);
  app.runFrames(32); // one pick interval
  app.setTerrainElevation(785.4);
  app.runFrames(120);

  expect(app.getBaseline()).toBeCloseTo(settled, 3);
});

test('TerrainController#holds the baseline when the pick hits nothing', () => {
  const app = createTerrainController();
  app.setTerrainElevation(785.4);
  app.runFrames(2);
  const settled = app.getBaseline();

  app.setTerrainElevation(undefined);
  app.runFrames(120);

  expect(app.getBaseline()).toBeCloseTo(settled, 6);
});

test('TerrainController#climbs to terrain the camera starts below', () => {
  const app = createTerrainController();

  // At zoom 14.5 and 70 degrees of pitch the camera sits well under 2500 m, so there is no zoom
  // that reproduces this view from that baseline. The controller climbs to it instead, at the
  // same bounded speed.
  app.setTerrainElevation(2500);
  const {maxBaselineStep, settled} = app.runUntilSettled(2500, 60);

  expect(settled).toBe(true);
  expect(maxBaselineStep).toBeLessThan(MAX_SHIFT_PER_FRAME);
  expect(app.getViewState().zoom).toBe(INITIAL_VIEW_STATE.zoom);
});

test('TerrainController#leaves the view state alone until the terrain is found', () => {
  const app = createTerrainController();
  app.runFrames(60);

  expect(app.getViewStates()).toHaveLength(0);
  expect(app.getViewState().zoom).toBe(INITIAL_VIEW_STATE.zoom);
});

test('TerrainController#the baseline does not step while a transition runs', () => {
  const app = createTerrainController();
  app.setTerrainElevation(785.4);
  app.runFrames(2);
  const settled = app.getBaseline();

  // The app starts a zoom transition, and the terrain under the center changes while it runs.
  app.setTerrainElevation(1385.4);
  app.controller.setProps({
    ...app.getViewState(),
    zoom: app.getViewState().zoom + 0.5,
    transitionDuration: 2000
  });

  // Long enough for two picks to confirm the new elevation, well short of the transition's end.
  for (let i = 0; i < 90; i++) {
    app.runFrames(1);
    expect(app.controller.transitionManager.getViewportInTransition()).toBeTruthy();
    expect(app.getBaseline(), 'the transition owns position').toBeCloseTo(settled, 6);
  }

  // Once the transition is over the filter picks the new target up.
  app.runFrames(40);
  expect(app.controller.transitionManager.getViewportInTransition()).toBeFalsy();
  expect(app.runUntilSettled(1385.4).settled).toBe(true);
});

test('TerrainController#the frame loop does not publish the baseline while dragging', () => {
  const app = createTerrainController();
  app.setTerrainElevation(785.4);
  app.runFrames(2);
  const settled = app.getBaseline();

  // Let two picks confirm a new elevation, then start dragging before the glide has finished.
  app.setTerrainElevation(1385.4);
  app.runFrames(70);
  expect(app.getBaseline()).toBeGreaterThan(settled);
  expect(app.getBaseline()).toBeLessThan(1385.4);

  const state = app.controller.controllerState;
  // @ts-expect-error protected in the base class, exercised here the way a pan event would
  app.controller.updateViewport(state, null, {isDragging: true});
  const baselineAtDragStart = app.getBaseline();
  const publishedAtDragStart = app.getViewStates().length;

  app.runFrames(30);
  expect(app.getViewStates(), 'nothing published from the frame loop').toHaveLength(
    publishedAtDragStart
  );
  expect(app.getBaseline()).toBe(baselineAtDragStart);

  // The drag's next event carries the baseline the filter advanced to in the meantime.
  // @ts-expect-error protected in the base class, exercised here the way a pan event would
  app.controller.updateViewport(
    app.controller.controllerState.zoom({pos: [WIDTH / 2, HEIGHT / 2], scale: 1.01}),
    null,
    {isDragging: true}
  );
  expect(app.getBaseline()).toBeGreaterThan(baselineAtDragStart);
});

test('TerrainController#a baseline the app sets after settling is adopted, not snapped back', () => {
  const app = createTerrainController();
  app.setTerrainElevation(785.4);
  app.runFrames(2);

  // The app writes its own altitude into the view state.
  app.controller.setProps({...app.getViewState(), position: [0, 0, 1000]});

  // The next gesture starts from it rather than jumping back to the controller's baseline.
  const state = app.controller.controllerState;
  // @ts-expect-error protected in the base class, exercised here the way an event would
  app.controller.updateViewport(state.zoom({pos: [WIDTH / 2, HEIGHT / 2], scale: 1.01}));
  expect(app.getBaseline()).toBeCloseTo(1000, 6);

  // The frame loop then glides back to the terrain at its bounded speed.
  const {maxBaselineStep, settled} = app.runUntilSettled(785.4);
  expect(settled).toBe(true);
  expect(maxBaselineStep).toBeLessThan(MAX_SHIFT_PER_FRAME);
});

test('TerrainController#a baseline change translates the camera', () => {
  const viewport = new WebMercatorViewport({
    width: WIDTH,
    height: HEIGHT,
    ...INITIAL_VIEW_STATE,
    position: [0, 0, 785.4]
  });
  const atSeaLevel = new WebMercatorViewport({
    width: WIDTH,
    height: HEIGHT,
    ...INITIAL_VIEW_STATE,
    position: [0, 0, 0]
  });

  // The premise the controller's rate limit rests on: moving the baseline moves the camera, and
  // one meter of it is worth a substantial fraction of a pixel.
  expect(viewport.distanceScales.unitsPerMeter[2] * viewport.scale).toBeGreaterThan(0.1);
  expect(
    screenDistance(
      viewport.project(PROBE_POINT) as number[],
      atSeaLevel.project(PROBE_POINT) as number[]
    )
  ).toBeGreaterThan(100);
});
