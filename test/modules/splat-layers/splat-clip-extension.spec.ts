// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';

import type {Layer, UpdateParameters} from '@deck.gl/core';
import {SplatClipExtension} from '@deck.gl/splat-layers';
import type {SplatClipExtensionProps} from '@deck.gl/splat-layers';
import {getSplatClipCoverage, packSplatClipUniforms} from '@luma.gl/splats';

/**
 * Drives the extension directly rather than through a layer stack.
 *
 * The extension's whole contract is "given these props and the previous ones, what region does the
 * layer end up holding", and exercising that without a device keeps it runnable everywhere.
 */
function runExtension(
  props: SplatClipExtensionProps,
  previous?: {props: SplatClipExtensionProps; state: Record<string, unknown>}
): {props: SplatClipExtensionProps; state: Record<string, unknown>} {
  const state: Record<string, unknown> = {...(previous?.state ?? {})};
  const host = {
    state,
    setState(partial: Record<string, unknown>) {
      Object.assign(state, partial);
    }
  } as unknown as Layer<SplatClipExtensionProps>;
  const extension = new SplatClipExtension();
  const resolved = {...getDefaultProps(), ...props};

  extension.updateState.call(
    host,
    {
      props: resolved,
      oldProps: previous?.props ?? ({} as SplatClipExtensionProps),
      changeFlags: {},
      context: {},
      oldContext: {},
      changeFlagsCleared: false
    } as unknown as UpdateParameters<Layer<SplatClipExtensionProps>>,
    extension
  );
  return {props: resolved, state};
}

/**
 * Resolves the extension's declared defaults the way deck.gl's prop system does.
 *
 * `defaultProps` entries are descriptors - `{type, value, min}` - not values, and handing a
 * descriptor to the extension would put the descriptor itself into the region.
 */
function getDefaultProps(): SplatClipExtensionProps {
  const declared = SplatClipExtension.defaultProps as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(declared).map(([name, declaration]) => [
      name,
      declaration && typeof declaration === 'object' && 'value' in declaration
        ? (declaration as {value: unknown}).value
        : declaration
    ])
  ) as SplatClipExtensionProps;
}

/** The region the layer would hand to its renderer. */
function getRegion(result: {state: Record<string, unknown>}) {
  return SplatClipExtension.getClipRegion({state: result.state} as unknown as Layer);
}

test('SplatClipExtension#a region is only built when planes are supplied', () => {
  expect(
    getRegion(runExtension({})),
    'a layer with the extension but no planes clips nothing'
  ).toBe(undefined);

  const region = getRegion(runExtension({clipPlanes: [{normal: [0, 0, 1], distance: -10}]}));
  expect(region?.planes.length, 'one plane produces a one-plane region').toBe(1);
  expect(region?.combine, 'combining as an intersection by default').toBe('intersection');
  expect(region?.softness, 'with a one-sigma transition').toBe(1);
  expect(region?.invert, 'keeping the region rather than its complement').toBe(false);
});

test('SplatClipExtension#the region is stable across updates that did not change it', () => {
  // The renderer compares the region by identity, so a new object every frame would rewrite the
  // clip uniform block sixty times a second for a region that never moved.
  const planes = [{normal: [0, 0, 1] as const, distance: -10}];
  const first = runExtension({clipPlanes: planes});
  const second = runExtension({clipPlanes: planes}, first);

  expect(getRegion(second), 'the same region object is retained').toBe(getRegion(first));
});

test('SplatClipExtension#a changed control rebuilds the region', () => {
  const planes = [{normal: [0, 0, 1] as const, distance: -10}];
  const first = runExtension({clipPlanes: planes});
  const second = runExtension({clipPlanes: planes, clipSoftness: 0.25}, first);

  expect(getRegion(second) === getRegion(first), 'a different softness is a different region').toBe(
    false
  );
  expect(getRegion(second)?.softness, 'and carries the new value').toBe(0.25);
});

test('SplatClipExtension#every control reaches the region it builds', () => {
  const region = getRegion(
    runExtension({
      clipPlanes: [
        {normal: [1, 0, 0], distance: 1},
        {normal: [-1, 0, 0], distance: 1}
      ],
      clipCombine: 'union',
      clipSoftness: 0.25,
      clipInverted: true
    })
  )!;

  expect(region.planes.length, 'both planes').toBe(2);
  expect(region.combine, 'combined as a union').toBe('union');
  expect(region.softness, 'with a quarter-sigma transition').toBe(0.25);
  expect(region.invert, 'inverted').toBe(true);
  expect(
    packSplatClipUniforms(region).byteLength,
    'and it packs into the uniform block the projection pass binds'
  ).toBe(144);
});

test('SplatClipExtension#the boundary follows each Gaussian rather than a fixed distance', () => {
  // This is the reason the extension exists: a center-based clip cuts a volumetric primitive along
  // a ragged edge, because a large splat straddling the plane either survives whole or vanishes.
  const region = getRegion(runExtension({clipPlanes: [{normal: [1, 0, 0], distance: 0}]}))!;
  const position: [number, number, number] = [1, 0, 0];
  const smallAxes = [
    [0.1, 0, 0],
    [0, 0.1, 0],
    [0, 0, 0.1]
  ] as const;
  const largeAxes = [
    [10, 0, 0],
    [0, 10, 0],
    [0, 0, 10]
  ] as const;

  expect(
    getSplatClipCoverage(region, position, smallAxes) > 0.99,
    'a splat much smaller than its offset is fully inside'
  ).toBe(true);
  const large = getSplatClipCoverage(region, position, largeAxes);
  expect(
    large > 0.5 && large < 0.6,
    'a splat much larger than its offset is barely cut, rather than kept or dropped whole'
  ).toBe(true);
});
