// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';

// Internal to the package, so imported from source rather than from its public entry point.
import {SplatFadeController} from '../../../modules/splat-layers/src/splat-fade-controller';
import type {
  SplatFadeBatch,
  SplatFadeEntry
} from '../../../modules/splat-layers/src/splat-fade-controller';

/**
 * A page that records what the ramp wrote into it.
 *
 * Structurally what `GPUSplatData` is to the controller: a row count, a destroyed flag, a CPU
 * opacity mirror, and `updateRows`. The mirror is overwritten exactly as the real one is, so a test
 * that snapshots wrongly shows up here rather than on a GPU.
 */
class FakeBatch implements SplatFadeBatch {
  readonly source: {opacities: Float32Array};
  destroyed = false;
  /** Every opacity value written, in order, so a quantized ramp can be counted. */
  readonly writes: number[][] = [];

  constructor(opacities: number[]) {
    this.source = {opacities: new Float32Array(opacities)};
  }

  get length(): number {
    return this.source.opacities.length;
  }

  updateRows(rowOffset: number, update: {opacities: Float32Array}): void {
    expect(rowOffset, 'a whole-page ramp writes from row zero').toBe(0);
    expect(update.opacities.length, 'a ramp writes every row').toBe(this.length);
    this.writes.push(Array.from(update.opacities));
    this.source.opacities.set(update.opacities, rowOffset);
  }

  /** The opacities the page currently holds. */
  get current(): number[] {
    return Array.from(this.source.opacities);
  }

  /** The lowest opacity level the ramp ever wrote, per row. */
  get lowest(): number[] {
    return this.writes.reduce(
      (lowest, write) => lowest.map((value, index) => Math.min(value, write[index])),
      this.current
    );
  }
}

function entry(id: string, ancestorIds: string[], batch: FakeBatch): SplatFadeEntry<FakeBatch> {
  return {id, ancestorIds, batch};
}

function makeController(
  overrides: {fadeIn?: number; fadeOut?: number; hold?: number; maxHeldSplats?: number} = {}
) {
  return new SplatFadeController<FakeBatch>({
    fadeInDuration: overrides.fadeIn ?? 300,
    fadeOutDuration: overrides.fadeOut ?? 150,
    holdDuration: overrides.hold ?? 2000,
    ...(overrides.maxHeldSplats === undefined ? {} : {maxHeldSplats: overrides.maxHeldSplats})
  });
}

/** Runs the ramps forward in fixed steps, as a frame loop would. */
function run(
  controller: SplatFadeController<FakeBatch>,
  fromMs: number,
  durationMs: number,
  stepMs = 16
): number {
  let now = fromMs;
  const until = fromMs + durationMs;
  while (now < until) {
    now += stepMs;
    controller.advance(now, stepMs);
  }
  return now;
}

test('SplatFadeController#a page arriving ramps up from zero rather than appearing', () => {
  const controller = makeController();
  const page = new FakeBatch([1, 1, 1, 1]);

  controller.sync([entry('a', [], page)], 0);

  // The write happens inside `sync`, not on the first tick: a page handed to the renderer before
  // its first ramp step would draw one frame at full opacity, which is the pop being removed.
  expect(page.current, 'a page arrives dark').toEqual([0, 0, 0, 0]);
  expect(controller.drawList, 'and is drawn from the moment it arrives').toEqual([page]);
  expect(controller.getAlpha(page)).toBe(0);

  run(controller, 0, 150);
  const midway = controller.getAlpha(page);
  expect(midway > 0 && midway < 1, `halfway through a 300ms ramp, got ${midway}`).toBe(true);

  run(controller, 150, 300);
  expect(controller.getAlpha(page), 'and reaches full opacity').toBe(1);
  expect(page.current, 'restoring exactly what it arrived with').toEqual([1, 1, 1, 1]);
  expect(controller.animating, 'after which nothing is moving').toBe(false);
});

test('SplatFadeController#a replaced parent is held at full opacity, never cross-dissolved', () => {
  const controller = makeController();
  const parent = new FakeBatch([1, 1]);
  const childA = new FakeBatch([1, 1]);
  const childB = new FakeBatch([1, 1]);

  // The parent arrives alone and finishes ramping up.
  controller.sync([entry('p', [], parent)], 0);
  let now = run(controller, 0, 400);
  expect(controller.getAlpha(parent)).toBe(1);

  // Then the traversal refines: the parent leaves, two children take its place.
  controller.sync([entry('p/0', ['p'], childA), entry('p/1', ['p'], childB)], now);

  expect(
    controller.drawList.includes(parent),
    'the parent is still handed to the renderer after it left the frontier'
  ).toBe(true);
  expect(controller.isLingering(parent), 'as a lingering page').toBe(true);

  // Midway through the children's ramp the parent must not have moved at all. This is the whole
  // point: two layers at half opacity composite to 75% coverage, and the clear colour showing
  // through a quarter of every patch that changes level reads as the scene flashing.
  now = run(controller, now, 150);
  expect(controller.getAlpha(parent), 'the parent is held, not faded').toBe(1);
  const childAlpha = controller.getAlpha(childA);
  expect(childAlpha > 0 && childAlpha < 1, `children ramp up, got ${childAlpha}`).toBe(true);

  now = run(controller, now, 200);
  expect(controller.getAlpha(childA), 'children reach full opacity').toBe(1);
  expect(controller.getAlpha(childB)).toBe(1);

  now = run(controller, now, 200);
  expect(parent.lowest, 'only then does the parent go').toEqual([0, 0]);
  expect(controller.drawList.includes(parent), 'and stops being drawn').toBe(false);
  expect(controller.drawList).toEqual([childA, childB]);
});

test('SplatFadeController#a page that nothing replaced fades immediately', () => {
  const controller = makeController();
  const onScreen = new FakeBatch([1]);
  const elsewhere = new FakeBatch([1]);

  controller.sync([entry('a', [], onScreen)], 0);
  let now = run(controller, 0, 400);

  // `b` is on a different branch, so `a` leaving the frontier is `a` being culled or panned off
  // rather than `a` being refined. There is nothing to hold for.
  controller.sync([entry('b', [], elsewhere)], now);
  expect(controller.isLingering(onScreen)).toBe(true);

  now = run(controller, now, 16);
  expect(controller.getAlpha(onScreen) < 1, 'a page nothing replaced starts fading at once').toBe(
    true
  );

  now = run(controller, now, 200);
  expect(onScreen.lowest, 'and reaches zero').toEqual([0]);
  expect(controller.drawList).toEqual([elsewhere]);
});

test('SplatFadeController#a hold gives up after the backstop rather than waiting forever', () => {
  const controller = makeController({hold: 500});
  const parent = new FakeBatch([1]);
  const child = new FakeBatch([1]);

  controller.sync([entry('p', [], parent)], 0);
  let now = run(controller, 0, 400);

  // The child enters and then stops arriving - evicted, or its ramp never completes. Without a
  // backstop the parent would blur finished ground indefinitely.
  controller.sync([entry('p/0', ['p'], child)], now);
  const heldAt = now;
  controller.setProps({fadeInDuration: 1e9, fadeOutDuration: 150, holdDuration: 500});

  now = run(controller, heldAt, 300);
  expect(controller.getAlpha(parent), 'still held before the backstop').toBe(1);
  expect(parent.current, 'and still at the opacity it had').toEqual([1]);

  now = run(controller, now, 500);
  expect(parent.lowest[0] < 1, `released after the backstop, got ${parent.lowest[0]}`).toBe(true);
});

test('SplatFadeController#a page asked for again turns round instead of restarting', () => {
  const controller = makeController();
  const page = new FakeBatch([1]);
  const other = new FakeBatch([1]);

  controller.sync([entry('a', [], page)], 0);
  let now = run(controller, 0, 400);

  // Camera jogs away, then straight back before the ramp finished. A page that restarted from zero
  // here would strobe.
  controller.sync([entry('b', [], other)], now);
  now = run(controller, now, 64);
  const partway = controller.getAlpha(page);
  expect(partway > 0 && partway < 1, `mid fade-out, got ${partway}`).toBe(true);

  controller.sync([entry('a', [], page), entry('b', [], other)], now);
  expect(controller.getAlpha(page), 'it resumes from where it had reached').toBe(partway);
  now = run(controller, now, 400);
  expect(controller.getAlpha(page)).toBe(1);
});

test('SplatFadeController#non-uniform opacities are scaled and restored exactly', () => {
  const controller = makeController();
  // A trained reconstruction, where the far tail of a Gaussian is doing real work and a flat
  // multiply would throw it away.
  const page = new FakeBatch([0.25, 0.5, 1, 0.125]);

  controller.sync([entry('a', [], page)], 0);
  expect(page.current).toEqual([0, 0, 0, 0]);

  run(controller, 0, 400);
  expect(page.current, 'the original distribution comes back intact').toEqual([
    0.25, 0.5, 1, 0.125
  ]);

  // Every intermediate write is the original scaled by one value, never renormalized.
  for (const write of page.writes) {
    const ratios = write.map((value, index) => value / [0.25, 0.5, 1, 0.125][index]);
    for (const ratio of ratios) {
      expect(Math.abs(ratio - ratios[0]) < 1e-6, `ramp scaled uniformly, got ${ratios}`).toBe(true);
    }
  }
});

test('SplatFadeController#a ramp is quantized rather than written every frame', () => {
  const controller = makeController({fadeIn: 300});
  const page = new FakeBatch([1]);

  controller.sync([entry('a', [], page)], 0);
  run(controller, 0, 300, 4); // 75 frames' worth of advance calls

  // Sixteen levels plus the zero written on arrival. A write per frame would be 75.
  expect(
    page.writes.length <= 18,
    `a 300ms ramp costs one write per level, got ${page.writes.length}`
  ).toBe(true);
  expect(controller.getAlpha(page)).toBe(1);
});

test('SplatFadeController#a page evicted mid-ramp is dropped rather than written to', () => {
  const controller = makeController();
  const page = new FakeBatch([1]);

  controller.sync([entry('a', [], page)], 0);
  page.destroyed = true;
  const writesBefore = page.writes.length;

  run(controller, 0, 100);
  expect(page.writes.length, 'nothing is written to a destroyed page').toBe(writesBefore);
  expect(controller.drawList.includes(page), 'and it is not handed to the renderer').toBe(false);
});

test('SplatFadeController#reset restores pages that were mid-ramp', () => {
  const controller = makeController();
  const page = new FakeBatch([1, 0.5]);

  controller.sync([entry('a', [], page)], 0);
  run(controller, 0, 100);
  expect(page.current[0] < 1, 'mid ramp').toBe(true);

  controller.reset();
  expect(page.current, 'a released scene leaves no page dimmed').toEqual([1, 0.5]);
  expect(controller.drawList).toEqual([]);
  expect(controller.animating).toBe(false);
});

test('SplatFadeController#a merge holds the finer pages for their coarse replacement', () => {
  const controller = makeController();
  const child = new FakeBatch([1]);
  const parent = new FakeBatch([1]);

  controller.sync([entry('p/0', ['p'], child)], 0);
  let now = run(controller, 0, 400);

  // Zooming out: the child gives way to its own ancestor. The hold has to work in this direction
  // too, or a wheel out opens a hole where the finer tiles were.
  controller.sync([entry('p', [], parent)], now);
  expect(controller.isLingering(child)).toBe(true);

  now = run(controller, now, 150);
  expect(controller.getAlpha(child), 'the child is held while the parent comes up').toBe(1);

  now = run(controller, now, 250);
  expect(controller.getAlpha(parent)).toBe(1);
  now = run(controller, now, 200);
  expect(child.lowest, 'and only then does the child go').toEqual([0]);
});

test('SplatFadeController#the draw list is the frontier followed by what is leaving it', () => {
  const controller = makeController();
  const parent = new FakeBatch([1]);
  const childA = new FakeBatch([1]);
  const childB = new FakeBatch([1]);

  controller.sync([entry('p', [], parent)], 0);
  const now = run(controller, 0, 400);
  controller.sync([entry('p/0', ['p'], childA), entry('p/1', ['p'], childB)], now);

  expect(
    controller.drawList,
    'frontier order first, so a settled list compares equal and costs nothing'
  ).toEqual([childA, childB, parent]);
  expect(controller.lingeringCount).toBe(1);
});

test('SplatFadeController#a page that faded out fully comes back at its real opacity', () => {
  const controller = makeController();
  // Non-uniform, so a snapshot taken from a zeroed mirror could not pass by accident.
  const page = new FakeBatch([0.5, 1]);
  const other = new FakeBatch([1, 1]);

  controller.sync([entry('a', [], page)], 0);
  let now = run(controller, 0, 400);

  // Culled: nothing replaces it, so it fades straight out and the controller forgets it.
  controller.sync([entry('b', [], other)], now);
  now = run(controller, now, 400);
  expect(controller.drawList.includes(page), 'the page has left the draw list').toBe(false);
  expect(page.lowest, 'after ramping all the way down').toEqual([0, 0]);
  expect(
    page.current,
    'and its CPU mirror is written back, because the page is still resident'
  ).toEqual([0.5, 1]);

  // The traversal asks for the same resident page again. The snapshot is taken from the mirror,
  // so a mirror left at zero would ramp the page up to nothing and leave it invisible for good.
  controller.sync([entry('a', [], page), entry('b', [], other)], now);
  run(controller, now, 400);
  expect(page.current, 'it ramps back up to what it arrived with').toEqual([0.5, 1]);
});

test('SplatFadeController#held pages past maxHeldSplats give up their hold early', () => {
  const controller = makeController({maxHeldSplats: 2, hold: 10_000});
  const parentA = new FakeBatch([1, 1]);
  const parentB = new FakeBatch([1, 1]);
  const children = [0, 1].map(() => new FakeBatch([1]));

  controller.sync([entry('a', [], parentA)], 0);
  let now = run(controller, 0, 400);
  controller.sync([entry('a', [], parentA), entry('b', [], parentB)], now);
  now = run(controller, now, 400);

  // Both parents refine at once, and the children stall - a large camera move over a slow network.
  controller.setProps({
    fadeInDuration: 1e9,
    fadeOutDuration: 150,
    holdDuration: 10_000,
    maxHeldSplats: 2
  });
  controller.sync([entry('a/0', ['a'], children[0])], now);
  now = run(controller, now, 32);
  controller.sync([entry('a/0', ['a'], children[0]), entry('b/0', ['b'], children[1])], now);
  now = run(controller, now, 300);

  expect(
    parentA.lowest,
    'the longest-held page gives up its hold rather than starving the new frontier'
  ).toEqual([0, 0]);
  expect(controller.getAlpha(parentB), 'while the most recent hold, within the bound, stays').toBe(
    1
  );
});
