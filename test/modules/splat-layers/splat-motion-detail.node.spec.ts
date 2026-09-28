// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';

// Internal to the package, so imported from source rather than from its public entry point.
import {SplatMotionDetail} from '../../../modules/splat-layers/src/splat-motion-detail';
import type {SplatMotionSample} from '../../../modules/splat-layers/src/splat-motion-detail';

const FIELD_OF_VIEW = Math.PI / 3;
const FRAME_MILLISECONDS = 16;

/** A camera `distance` from the origin, orbited `bearing` radians about the vertical. */
function makeOrbitSample(bearing: number, time: number, distance = 100): SplatMotionSample {
  return {
    cameraPosition: [Math.sin(bearing) * distance, -Math.cos(bearing) * distance, distance / 2],
    focusPosition: [0, 0, 0],
    verticalFieldOfView: FIELD_OF_VIEW,
    time
  };
}

/** Orbits at `radiansPerSecond` for `frames` frames and returns the last scale. */
function orbit(
  motionDetail: SplatMotionDetail,
  radiansPerSecond: number,
  frames: number,
  maximumScale = 4,
  startFrame = 0
): number {
  let scale = 1;
  for (let frame = startFrame; frame < startFrame + frames; frame++) {
    const time = frame * FRAME_MILLISECONDS;
    scale = motionDetail.update(
      makeOrbitSample((radiansPerSecond * time) / 1000, time),
      maximumScale
    );
  }
  return scale;
}

test('SplatMotionDetail leaves a still or slowly orbiting camera at full detail', () => {
  expect(orbit(new SplatMotionDetail(), 0, 60), 'still').toBe(1);
  // The example's idle orbit, 1.6 degrees a second.
  expect(orbit(new SplatMotionDetail(), (1.6 * Math.PI) / 180, 60), 'idle orbit').toBe(1);
});

test('SplatMotionDetail coarsens with speed, in half-octave steps, up to the ceiling', () => {
  const moderate = orbit(new SplatMotionDetail(), 0.5, 30);
  const fast = orbit(new SplatMotionDetail(), 2, 30);
  const whip = orbit(new SplatMotionDetail(), 20, 30);

  expect(moderate > 1, 'a moderate turn coarsens').toBe(true);
  expect(fast > moderate, 'a faster turn coarsens further').toBe(true);
  expect(whip, 'never beyond the ceiling').toBe(4);
  for (const scale of [moderate, fast, whip]) {
    expect(Math.log2(scale) * 2, 'publishes half-octave steps only').toBeCloseTo(
      Math.round(Math.log2(scale) * 2)
    );
  }
  expect(orbit(new SplatMotionDetail(), 20, 30, 1), 'a ceiling of one disables it').toBe(1);
});

test('SplatMotionDetail measures distance-independent screen motion', () => {
  const near = new SplatMotionDetail();
  const far = new SplatMotionDetail();
  let nearScale = 1;
  let farScale = 1;
  for (let frame = 0; frame < 30; frame++) {
    const time = frame * FRAME_MILLISECONDS;
    const bearing = time / 1000;
    nearScale = near.update(makeOrbitSample(bearing, time, 10), 4);
    farScale = far.update(makeOrbitSample(bearing, time, 10_000), 4);
  }
  expect(nearScale, 'the same angular sweep coarsens alike at any scene scale').toBe(farScale);
});

test('SplatMotionDetail recovers once the camera stops, and reports it is settling', () => {
  const motionDetail = new SplatMotionDetail();
  expect(orbit(motionDetail, 3, 30), 'coarse while moving').toBeGreaterThan(1);

  const stoppedBearing = (3 * 29 * FRAME_MILLISECONDS) / 1000;
  let scale = Infinity;
  let frame = 30;
  for (; frame < 30 + 5; frame++) {
    scale = motionDetail.update(makeOrbitSample(stoppedBearing, frame * FRAME_MILLISECONDS), 4);
  }
  expect(scale > 1, 'does not snap back on the first still frame').toBe(true);
  expect(motionDetail.isSettling, 'asks for frames while recovering').toBe(true);

  for (; frame < 30 + 120; frame++) {
    scale = motionDetail.update(makeOrbitSample(stoppedBearing, frame * FRAME_MILLISECONDS), 4);
  }
  expect(scale, 'returns to full detail').toBe(1);
  expect(motionDetail.isSettling, 'and stops asking for frames').toBe(false);
});

test('SplatMotionDetail does not read a reset as motion', () => {
  const motionDetail = new SplatMotionDetail();
  motionDetail.update(makeOrbitSample(0, 0), 4);
  motionDetail.reset();
  expect(motionDetail.update(makeOrbitSample(Math.PI, FRAME_MILLISECONDS), 4)).toBe(1);
});

test('SplatMotionDetail holds through the pauses of one gesture', () => {
  const motionDetail = new SplatMotionDetail();
  const moving = orbit(motionDetail, 3, 30);
  const pausedBearing = (3 * 29 * FRAME_MILLISECONDS) / 1000;
  let scale = moving;
  // A tenth of a second with the pointer held still, as at the turn of a back-and-forth drag.
  for (let frame = 30; frame < 36; frame++) {
    scale = motionDetail.update(makeOrbitSample(pausedBearing, frame * FRAME_MILLISECONDS), 4);
  }
  expect(scale, 'keeps the level it reached').toBe(moving);
});

test('SplatMotionDetail#a caller that reuses one position array is still seen to move', () => {
  // The layer hands over its camera cache, which it overwrites in place every frame. Keeping a
  // reference to that array would compare each frame against itself and never see any motion.
  const motionDetail = new SplatMotionDetail();
  const cameraPosition: [number, number, number] = [0, -100, 50];
  const focusPosition: [number, number, number] = [0, 0, 0];
  let scale = 1;
  for (let frame = 0; frame < 30; frame++) {
    const bearing = frame * 0.05;
    cameraPosition[0] = Math.sin(bearing) * 100;
    cameraPosition[1] = -Math.cos(bearing) * 100;
    scale = motionDetail.update(
      {cameraPosition, focusPosition, verticalFieldOfView: FIELD_OF_VIEW, time: frame * 16},
      4
    );
  }
  expect(scale > 1, `an orbit through a shared array coarsens, got ${scale}`).toBe(true);
});
