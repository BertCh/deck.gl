// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * One frame's camera, in any consistent units: scene units for the layer.
 *
 * {@link SplatMotionDetail.update} copies what it keeps, so the arrays may be reused between calls.
 */
export type SplatMotionSample = {
  /** Camera position. */
  cameraPosition: readonly [number, number, number];
  /** What the camera is looking at, typically the orbit or map target. */
  focusPosition: readonly [number, number, number];
  /** Vertical field of view in radians. */
  verticalFieldOfView: number;
  /** Wall-clock time of the frame in milliseconds. */
  time: number;
};

/**
 * Screen speed, in viewport heights per second, that coarsens detail by one full step (`2x`).
 *
 * Half the view sweeping past in a second is fast enough that a surface is smeared across several
 * pixels a frame, and slow enough that a deliberate pan still reads as sharp.
 */
const SPEED_PER_DOUBLING = 0.5;

/**
 * Seconds the coarsening holds after the camera last sped up, before it starts to recover.
 *
 * A hand-driven gesture pauses and reverses; its speed passes through zero many times a second.
 * Recovering through each of those would re-plan the cut up and back down again, starting loads for
 * detail the next frame cancels. A quarter second bridges them and is still under the time a
 * viewer takes to settle their eye on a stopped view.
 */
const HOLD_SECONDS = 0.25;

/** Seconds for the coarsening to fall `e`-fold once the hold has passed. */
const SETTLE_SECONDS = 0.2;

/**
 * Steps per doubling of the published scale.
 *
 * Every change to the scale can change the selected cut, and a changed cut starts and cancels
 * loads. Publishing a continuous value would re-plan on every frame of a steady pan; quantizing to
 * half-octaves means a steady pan settles on one level and only acceleration changes it.
 */
const STEPS_PER_DOUBLING = 2;

/**
 * Turns camera motion into a level-of-detail coarsening factor.
 *
 * Detail requested while the camera moves arrives after the view it was requested for, and motion
 * hides it anyway. So the error target relaxes in proportion to how fast the view sweeps across the
 * screen - turning, travelling or zooming alike - and recovers smoothly once the camera settles.
 *
 * Speed is measured as the angle the view direction turns plus the parallax the camera's travel
 * causes at the focus, divided by the field of view: that is how far the scene at the focus moves
 * across the screen, in viewport heights, independent of the scene's units.
 *
 * Internal to `SplatLayer`, which feeds it; not exported from the package.
 */
export class SplatMotionDetail {
  private previous?: SplatMotionSample;
  /** Smoothed, unquantized scale. */
  private scale = 1;
  /** Time, in milliseconds, the scale last rose to meet the camera's speed. */
  private peakTime = Number.NEGATIVE_INFINITY;

  /** Whether the camera has recently moved and the scale has yet to return to `1`. */
  get isSettling(): boolean {
    return this.scale > 1 + 1e-3;
  }

  /**
   * Advances to a new frame and returns the coarsening to apply, from `1` up to `maximumScale`.
   *
   * @param sample This frame's camera.
   * @param maximumScale The largest scale returned; `1` disables motion coarsening.
   */
  update(sample: SplatMotionSample, maximumScale: number): number {
    const previous = this.previous;
    // Copied, not kept: a caller that reuses one array per frame - the layer's camera cache is
    // written in place - would otherwise have every frame compared against itself.
    this.previous = {
      cameraPosition: [
        sample.cameraPosition[0],
        sample.cameraPosition[1],
        sample.cameraPosition[2]
      ],
      focusPosition: [sample.focusPosition[0], sample.focusPosition[1], sample.focusPosition[2]],
      verticalFieldOfView: sample.verticalFieldOfView,
      time: sample.time
    };
    const ceiling = Math.max(maximumScale, 1);
    const elapsedSeconds = previous ? (sample.time - previous.time) / 1000 : 0;
    if (!previous || !(elapsedSeconds > 0) || ceiling === 1) {
      this.scale = Math.min(this.scale, ceiling);
      return quantizeScale(this.scale);
    }

    const screenSpeed = getScreenSpeed(previous, sample) / elapsedSeconds;
    const target = Math.min(1 + screenSpeed / SPEED_PER_DOUBLING, ceiling);
    // Coarsen at once, recover gradually: the cost of a late coarsening is a stalled frame, while
    // the cost of a late recovery is a few frames of softness nobody can see through the motion.
    if (target >= this.scale) {
      this.scale = target;
      this.peakTime = sample.time;
    } else if ((sample.time - this.peakTime) / 1000 > HOLD_SECONDS) {
      const decayed = 1 + (this.scale - 1) * Math.exp(-elapsedSeconds / SETTLE_SECONDS);
      this.scale = Math.max(target, decayed);
    }
    this.scale = Math.min(this.scale, ceiling);
    return quantizeScale(this.scale);
  }

  /** Forgets the previous frame, so a scene change or a jump is not read as motion. */
  reset(): void {
    this.previous = undefined;
    this.scale = 1;
    this.peakTime = Number.NEGATIVE_INFINITY;
  }
}

/** Viewport heights the scene at the focus moved between two frames. */
function getScreenSpeed(previous: SplatMotionSample, current: SplatMotionSample): number {
  const previousDirection = subtract(previous.focusPosition, previous.cameraPosition);
  const currentDirection = subtract(current.focusPosition, current.cameraPosition);
  const previousDistance = length(previousDirection);
  const currentDistance = length(currentDirection);
  if (!(previousDistance > 0) || !(currentDistance > 0)) {
    return 0;
  }

  const cosine =
    (previousDirection[0] * currentDirection[0] +
      previousDirection[1] * currentDirection[1] +
      previousDirection[2] * currentDirection[2]) /
    (previousDistance * currentDistance);
  const turn = Math.acos(Math.min(Math.max(cosine, -1), 1));
  const travel =
    length(subtract(current.cameraPosition, previous.cameraPosition)) /
    Math.min(previousDistance, currentDistance);
  return (turn + travel) / Math.max(current.verticalFieldOfView, 1e-3);
}

/** Rounds down to the nearest step, so slight motion leaves detail untouched. */
function quantizeScale(scale: number): number {
  const steps = Math.floor(Math.log2(Math.max(scale, 1)) * STEPS_PER_DOUBLING + 1e-9);
  return 2 ** (steps / STEPS_PER_DOUBLING);
}

function subtract(
  left: readonly [number, number, number],
  right: readonly [number, number, number]
): [number, number, number] {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function length(vector: readonly [number, number, number]): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}
