// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';

import {Layer, LayerExtension, LayerManager, MapView, Viewport} from '@deck.gl/core';
import ComputeLayersPass from '@deck.gl/core/passes/compute-layers-pass';
import type {LayerComputeParameters} from '@deck.gl/core/passes/compute-layers-pass';
import {device} from '@deck.gl/test-utils/vitest';

type ComputeRecord = {layerId: string; viewportId: string; pass: string; isPicking: boolean};

/** An ordinary layer, which must never reach the compute stage. */
class PlainLayer extends Layer {
  static layerName = 'PlainLayer';
  initializeState() {}
}

/** A layer that records GPU work before the render pass opens. */
class ComputingLayer extends Layer<{onCompute: (record: ComputeRecord) => void}> {
  static layerName = 'ComputingLayer';

  initializeState() {}

  get needsComputePass(): boolean {
    return true;
  }

  compute(params: LayerComputeParameters): void {
    // The encoder deck.gl hands over must be a live one, not a placeholder.
    expect(Boolean(params.commandEncoder), 'the compute stage receives a command encoder').toBe(
      true
    );
    this.props.onCompute({
      layerId: this.id,
      viewportId: params.viewport.id,
      pass: params.pass,
      isPicking: params.isPicking
    });
  }
}

/** An extension that piggybacks on a layer's compute stage. */
class RecordingExtension extends LayerExtension<{onCompute: (layerId: string) => void}> {
  static extensionName = 'RecordingExtension';

  compute(this: Layer, _params: LayerComputeParameters, extension: RecordingExtension): void {
    extension.opts.onCompute(this.id);
  }
}

function makeViewports(ids: string[]): Viewport[] {
  return ids.map(
    id =>
      new MapView({id}).makeViewport({
        width: 100,
        height: 100,
        viewState: {longitude: 0, latitude: 0, zoom: 1}
      }) as Viewport
  );
}

function updateLayers(layers: Layer[]) {
  const layerManager = new LayerManager(device, {viewport: makeViewports(['a'])[0]});
  layerManager.setLayers(layers);
  return layerManager;
}

test('ComputeLayersPass#only layers that declare a compute stage reach it', () => {
  const computed: ComputeRecord[] = [];
  const layers = [
    new PlainLayer({id: 'plain'}),
    new ComputingLayer({id: 'computing', onCompute: record => computed.push(record)})
  ];
  const layerManager = updateLayers(layers);
  const pass = new ComputeLayersPass(device, {id: 'compute'});

  pass.render({pass: 'screen', layers: layerManager.getLayers(), viewports: makeViewports(['a'])});

  expect(computed.length, 'exactly one layer computed').toBe(1);
  expect(computed[0].layerId, 'and it is the one that declared a compute stage').toBe('computing');
  expect(pass.computedLayerCount, 'which the pass reports').toBe(1);
  layerManager.finalize();
});

test('ComputeLayersPass#a stack with no compute stage does no work at all', () => {
  const layerManager = updateLayers([new PlainLayer({id: 'plain'})]);
  const pass = new ComputeLayersPass(device, {id: 'compute'});

  pass.render({pass: 'screen', layers: layerManager.getLayers(), viewports: makeViewports(['a'])});

  expect(pass.computedLayerCount, 'the common case costs one array scan').toBe(0);
  layerManager.finalize();
});

test('ComputeLayersPass#each viewport computes independently', () => {
  // What a layer computes - a sort order, a culled set - is camera-dependent, so a split-screen
  // view needs one compute per viewport rather than one for the frame.
  const computed: ComputeRecord[] = [];
  const layerManager = updateLayers([
    new ComputingLayer({id: 'computing', onCompute: record => computed.push(record)})
  ]);
  const pass = new ComputeLayersPass(device, {id: 'compute'});

  pass.render({
    pass: 'screen',
    layers: layerManager.getLayers(),
    viewports: makeViewports(['left', 'right'])
  });

  expect(
    computed.map(record => record.viewportId),
    'the layer computed once for each viewport'
  ).toEqual(['left', 'right']);
  layerManager.finalize();
});

test('ComputeLayersPass#one viewport can be computed at a time', () => {
  // This is how the render passes drive it: compute a viewport, draw it, then move on, so the
  // result a draw consumes is always the one computed for its own camera.
  const computed: ComputeRecord[] = [];
  const layerManager = updateLayers([
    new ComputingLayer({id: 'computing', onCompute: record => computed.push(record)})
  ]);
  const pass = new ComputeLayersPass(device, {id: 'compute'});
  const [left, right] = makeViewports(['left', 'right']);
  const options = {pass: 'screen', layers: layerManager.getLayers()};

  pass.beginFrame();
  pass.computeViewport(left, options);
  expect(
    computed.map(record => record.viewportId),
    'only the first camera so far'
  ).toEqual(['left']);
  pass.computeViewport(right, options);
  expect(
    computed.map(record => record.viewportId),
    'then the second'
  ).toEqual(['left', 'right']);
  expect(pass.computedLayerCount, 'counted across the frame').toBe(2);
  layerManager.finalize();
});

test('ComputeLayersPass#the layer filter applies before the compute stage', () => {
  const computed: ComputeRecord[] = [];
  const layerManager = updateLayers([
    new ComputingLayer({id: 'computing', onCompute: record => computed.push(record)})
  ]);
  const pass = new ComputeLayersPass(device, {id: 'compute'});

  pass.render({
    pass: 'screen',
    layers: layerManager.getLayers(),
    viewports: makeViewports(['left', 'right']),
    layerFilter: ({viewport}) => viewport.id === 'right'
  });

  expect(
    computed.map(record => record.viewportId),
    'a layer filtered out of a viewport does not compute for it either'
  ).toEqual(['right']);
  layerManager.finalize();
});

test('ComputeLayersPass#the picking pass is distinguishable from the screen pass', () => {
  const computed: ComputeRecord[] = [];
  const layerManager = updateLayers([
    new ComputingLayer({id: 'computing', onCompute: record => computed.push(record)})
  ]);
  const pass = new ComputeLayersPass(device, {id: 'compute'});

  pass.render({
    pass: 'picking',
    layers: layerManager.getLayers(),
    viewports: makeViewports(['a']),
    isPicking: true
  });

  expect(computed[0].pass, 'the following pass is named').toBe('picking');
  expect(computed[0].isPicking, 'and identified as a picking pass').toBe(true);
  layerManager.finalize();
});

test('ComputeLayersPass#extensions run before the layer itself', () => {
  const order: string[] = [];
  const layerManager = updateLayers([
    new ComputingLayer({
      id: 'computing',
      onCompute: () => order.push('layer'),
      extensions: [new RecordingExtension({onCompute: () => order.push('extension')})]
    })
  ]);
  const pass = new ComputeLayersPass(device, {id: 'compute'});

  pass.render({pass: 'screen', layers: layerManager.getLayers(), viewports: makeViewports(['a'])});

  expect(order, 'extensions get to record first, as they do for draw').toEqual([
    'extension',
    'layer'
  ]);
  layerManager.finalize();
});

test('ComputeLayersPass#an empty viewport list is a no-op', () => {
  const computed: ComputeRecord[] = [];
  const layerManager = updateLayers([
    new ComputingLayer({id: 'computing', onCompute: record => computed.push(record)})
  ]);
  const pass = new ComputeLayersPass(device, {id: 'compute'});

  pass.render({pass: 'screen', layers: layerManager.getLayers(), viewports: []});

  expect(computed.length, 'there is no camera to compute against').toBe(0);
  layerManager.finalize();
});
