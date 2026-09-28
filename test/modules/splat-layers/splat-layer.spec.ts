// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {testLayer} from '@deck.gl/test-utils/vitest';

import {SplatClipExtension, SplatLayer} from '@deck.gl/splat-layers';
import type {SplatHierarchySource, SplatLayerProps} from '@deck.gl/splat-layers';
import type {SplatSource} from '@luma.gl/splats';

/** Four unit Gaussians on the corners of a square, which is all a lifecycle needs. */
function makeSplatSource(): SplatSource {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1]),
    scales: new Float32Array(12).fill(0.1),
    rotations: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
    colors: new Uint8Array(16).fill(255),
    opacities: new Float32Array([1, 1, 1, 1])
  };
}

/**
 * A streaming source with one root and no data, whose loader never settles.
 *
 * Enough to exercise everything the layer does with a hierarchy - residency, traversal, fades - and
 * to count how often it asks for a page loader, without anything arriving.
 */
function makeHierarchySource(): SplatHierarchySource & {loaderCount: number} {
  const source = {
    loaderCount: 0,
    roots: [{id: 'root', bounds: {center: [0, 0, 0] as const, radius: 1}, geometricError: 1}],
    summary: {splatCount: 1000, nodeCount: 1},
    createPageLoader: () => {
      source.loaderCount++;
      return () => new Promise<never>(() => {});
    }
  };
  return source;
}

const RESIDENT_PROPS: Partial<SplatLayerProps> = {
  id: 'splat-lifecycle',
  splatSource: makeSplatSource(),
  coordinateOrigin: [0, 0, 0]
};

test('SplatLayer#resident scene lifecycle', () => {
  testLayer<SplatLayer>({
    Layer: SplatLayer,
    onError: error => {
      throw error;
    },
    testCases: [
      {
        title: 'binds a backend for a resident scene',
        props: RESIDENT_PROPS,
        onAfterUpdate: ({layer}) => {
          expect(layer.getSplatBackend(), 'a renderer is bound').toBeTruthy();
          expect(layer.state.drawnSplatCount, 'every row is drawn').toBe(4);
          expect(layer.state.placement, 'and the scene is placed').toBeTruthy();
        }
      },
      {
        title: 'a display prop change keeps the renderer',
        updateProps: {radiusScale: 2, exposure: 0.5},
        onAfterUpdate: ({layer, oldState}) => {
          expect(layer.state.backend, 'no rebuild for a uniform').toBe(oldState.backend);
        }
      },
      {
        title: 'removing the source releases the renderer',
        updateProps: {splatSource: null},
        onAfterUpdate: ({layer}) => {
          expect(layer.getSplatBackend(), 'nothing bound').toBe(undefined);
          expect(layer.state.splatData).toEqual([]);
        }
      }
    ]
  });
});

test('SplatLayer#streaming scene lifecycle', () => {
  const hierarchy = makeHierarchySource();
  const scenePercentiles = {
    x: [-1, 1],
    y: [-1, 1],
    z: [-1, 1]
  } as SplatLayerProps['scenePercentiles'];

  testLayer<SplatLayer>({
    Layer: SplatLayer,
    onError: error => {
      throw error;
    },
    testCases: [
      {
        title: 'a hierarchy creates residency, a traversal and one page loader',
        props: {
          id: 'splat-streaming',
          splatHierarchy: hierarchy,
          scenePercentiles,
          coordinateOrigin: [0, 0, 0]
        },
        onAfterUpdate: ({layer}) => {
          expect(layer.state.residency, 'the layer owns the residency window').toBeTruthy();
          expect(layer.state.hierarchy, 'and a traversal over it').toBeTruthy();
          expect(hierarchy.loaderCount, 'the loader is built once for the scene').toBe(1);
          expect(layer.getStreamingStats(), 'stats are available').toBeTruthy();
        }
      },
      {
        title: 'a ramp that starts after an idle spell is timed from now',
        updateProps: {},
        onAfterUpdate: ({layer}) => {
          const {fade} = layer.state;
          expect(fade, 'fades are on by default').toBeTruthy();
          // Settle every ramp, then leave the clock where an idle spell would: far in the past.
          fade!.advance(performance.now(), 16);
          expect(fade!.animating).toBe(false);
          layer.state.lastFadeTime = 1;

          (
            layer as unknown as {_onFrontierChange(batches: unknown[], frontier: unknown[]): void}
          )._onFrontierChange([], []);
          expect(
            layer.state.lastFadeTime > 1,
            'a first step measured from the stale clock would jump straight to full opacity'
          ).toBe(true);
        }
      },
      {
        title: 'a new error threshold rebuilds the traversal, not the loader',
        updateProps: {maximumScreenSpaceError: 4},
        onAfterUpdate: ({layer, oldState}) => {
          expect(layer.state.hierarchy === oldState.hierarchy, 'a new traversal').toBe(false);
          expect(layer.state.residency, 'over the same residency window').toBe(oldState.residency);
          expect(hierarchy.loaderCount, 'and the same loader').toBe(1);
        }
      },
      {
        title: 'fades turned off mid-scene leave nothing pinned',
        updateProps: {fadeInDuration: 0, fadeOutDuration: 0},
        onAfterUpdate: ({layer}) => {
          expect(layer.state.fade, 'no ramp controller').toBe(undefined);
          expect(layer.state.pinnedLingering.size, 'and no pins of its own').toBe(0);
        }
      },
      {
        title: 'a new scene and a new budget in one update build one traversal',
        updateProps: {
          splatHierarchy: makeHierarchySource(),
          residencyBudget: {maxResidentSplats: 500}
        },
        spies: ['_createTraversal'],
        onAfterUpdate: ({layer, spies}) => {
          expect(
            (spies._createTraversal as unknown as {mock: {calls: unknown[]}}).mock.calls.length,
            'the new scene builds its traversal against the new budget once'
          ).toBe(1);
          expect(layer.state.residency?.getStats().maxResidentSplats).toBe(500);
        }
      },
      {
        title: 'a streaming scene with no way to be placed draws nothing',
        updateProps: {scenePercentiles: null},
        onAfterUpdate: ({layer}) => {
          expect(layer.state.placement, 'no placement').toBe(undefined);
          expect(layer.state.warnedMissingPlacement, 'and the caller is told why').toBe(true);
        }
      }
    ]
  });
});

test('SplatLayer#removing SplatClipExtension removes its region', () => {
  testLayer<SplatLayer>({
    Layer: SplatLayer,
    onError: error => {
      throw error;
    },
    testCases: [
      {
        title: 'the extension resolves a region',
        props: {
          ...RESIDENT_PROPS,
          extensions: [new SplatClipExtension()],
          clipPlanes: [{normal: [0, 0, 1], distance: 0}]
        } as Partial<SplatLayerProps>,
        onAfterUpdate: ({layer}) => {
          expect(layer.state.clipRegion?.planes.length).toBe(1);
        }
      },
      {
        title: 'and taking it away clears it',
        updateProps: {extensions: []},
        onAfterUpdate: ({layer}) => {
          expect(layer.state.clipRegion, 'no stale region keeps clipping').toBe(undefined);
        }
      }
    ]
  });
});
