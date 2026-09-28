// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';

import {Layer, LayerExtension, LayerManager, MapView, Viewport} from '@deck.gl/core';
import ComputeLayersPass from '@deck.gl/core/passes/compute-layers-pass';
import type {LayerComputeParameters} from '@deck.gl/core/passes/compute-layers-pass';
import {device} from '@deck.gl/test-utils/vitest';

type ComputeRecord = {layerId: string; viewportId: string; pass: string; isPicking: boolean};

/** An ordinary layer, which does not declare a compute stage. */
class PlainLayer extends Layer<{onCompute?: (record: ComputeRecord) => void}> {
  static layerName = 'PlainLayer';
  initializeState() {}

  compute(params: LayerComputeParameters): void {
    this.props.onCompute?.({
      layerId: this.id,
      viewportId: params.viewport.id,
      pass: params.pass,
      isPicking: params.isPicking
    });
  }
}

/** A layer that records GPU work before the render pass opens. */
class ComputingLayer extends PlainLayer {
  static layerName = 'ComputingLayer';

  get needsComputePass(): boolean {
    return true;
  }
}

/** A layer whose compute stage fails. */
class ThrowingLayer extends ComputingLayer {
  static layerName = 'ThrowingLayer';

  compute(): void {
    throw new Error('compute failed');
  }
}

/** An extension that piggybacks on a layer's compute stage. */
class RecordingExtension extends LayerExtension<{onCompute: (layerId: string) => void}> {
  static extensionName = 'RecordingExtension';

  compute(this: Layer, _params: LayerComputeParameters, extension: RecordingExtension): void {
    extension.opts.onCompute(this.id);
  }
}

/** An extension that only draws, and so must not opt its layer into compute. */
class DrawOnlyExtension extends LayerExtension {
  static extensionName = 'DrawOnlyExtension';
}

function makeViewport(id: string): Viewport {
  return new MapView({id}).makeViewport({
    width: 100,
    height: 100,
    viewState: {longitude: 0, latitude: 0, zoom: 1}
  }) as Viewport;
}

function updateLayers(layers: Layer[], onError?: (error: Error) => void) {
  const layerManager = new LayerManager(device, {viewport: makeViewport('a')});
  if (onError) {
    layerManager.setProps({onError});
  }
  layerManager.setLayers(layers);
  return layerManager;
}

test('ComputeLayersPass#computes the given layers with deck.gl encoder and pass context', () => {
  const computed: ComputeRecord[] = [];
  const encoders: unknown[] = [];
  class EncoderLayer extends ComputingLayer {
    static layerName = 'EncoderLayer';
    compute(params: LayerComputeParameters): void {
      encoders.push(params.commandEncoder);
      super.compute(params);
    }
  }
  const layerManager = updateLayers([
    new EncoderLayer({id: 'computing', onCompute: record => computed.push(record)})
  ]);
  const pass = new ComputeLayersPass(device, {id: 'compute'});

  pass.computeViewport(makeViewport('left'), {pass: 'screen', layers: layerManager.getLayers()});

  expect(computed).toEqual([
    {layerId: 'computing', viewportId: 'left', pass: 'screen', isPicking: false}
  ]);
  expect(encoders[0], 'the encoder is the device encoder').toBe(device.commandEncoder);
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

  pass.computeViewport(makeViewport('a'), {pass: 'screen', layers: layerManager.getLayers()});

  expect(order, 'extensions get to record first, as they do for draw').toEqual([
    'extension',
    'layer'
  ]);
  layerManager.finalize();
});

test('ComputeLayersPass#an extension compute hook opts its layer in', () => {
  const layerManager = updateLayers([
    new PlainLayer({id: 'plain'}),
    new PlainLayer({id: 'draw-only', extensions: [new DrawOnlyExtension()]}),
    new PlainLayer({
      id: 'extended',
      extensions: [new RecordingExtension({onCompute: () => {}})]
    })
  ]);
  const [plain, drawOnly, extended] = layerManager.getLayers();

  expect(plain.needsComputePass, 'an ordinary layer needs no compute').toBe(false);
  expect(drawOnly.needsComputePass, 'an extension without compute changes nothing').toBe(false);
  expect(extended.needsComputePass, 'an extension with compute opts the layer in').toBe(true);
  layerManager.finalize();
});

test('ComputeLayersPass#errors thrown by compute are reported through onError', () => {
  const errors: Error[] = [];
  const computed: ComputeRecord[] = [];
  const layerManager = updateLayers(
    [
      new ThrowingLayer({id: 'throwing'}),
      new ComputingLayer({id: 'computing', onCompute: record => computed.push(record)})
    ],
    error => errors.push(error)
  );
  const pass = new ComputeLayersPass(device, {id: 'compute'});

  pass.computeViewport(makeViewport('a'), {pass: 'screen', layers: layerManager.getLayers()});

  expect(errors).toHaveLength(1);
  expect(errors[0].message).toMatch(/computing ThrowingLayer.*throwing.*compute failed/);
  expect(computed, 'the remaining layers still compute').toHaveLength(1);
  layerManager.finalize();
});
