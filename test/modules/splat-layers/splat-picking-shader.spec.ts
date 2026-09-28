// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {WgslExec, WgslParser, WgslReflect} from 'wgsl_reflect';

import {Layer} from '@deck.gl/core';
import type {Viewport} from '@deck.gl/core';
// Internal to the package, so imported from source rather than from its public entry point.
import PickLayersPass from '../../../modules/core/src/passes/pick-layers-pass';
import {
  getSplatPickingParameters,
  SPLAT_COMPATIBLE_PICKING_SHADER,
  SPLAT_COMPATIBLE_PICKING_SHADER_LAYOUT,
  SPLAT_PICKING_COLOR_WGSL,
  SPLAT_PICKING_SHADER,
  SPLAT_PICKING_SHADER_LAYOUT
} from '../../../modules/splat-layers/src/splat-picking-shader';

/**
 * Runs the picking shader's own `getSplatPickingColor` on the CPU, through a WGSL interpreter.
 *
 * The function is executed from the exact source string the picking pipelines compile, wrapped in
 * a one-line compute kernel, so what is compared below is the shader's behaviour rather than a
 * JavaScript restatement of it.
 */
function encodeInShader(rowIndices: number[]): [number, number, number, number][] {
  const source = `${SPLAT_PICKING_COLOR_WGSL}
@group(0) @binding(0) var<storage, read> rows: array<u32>;
@group(0) @binding(1) var<storage, read_write> colors: array<vec4<f32>>;
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  colors[id.x] = getSplatPickingColor(rows[id.x]);
}`;
  const rows = new Uint32Array(rowIndices);
  const colors = new Float32Array(rowIndices.length * 4);
  new WgslExec(new WgslParser().parse(source)).dispatchWorkgroups('main', rowIndices.length, {
    0: {0: rows, 1: colors}
  });
  // What an `rgba8unorm` attachment stores for each channel.
  return rowIndices.map(
    (_, index) =>
      Array.from(colors.subarray(index * 4, index * 4 + 4), value => Math.round(value * 255)) as [
        number,
        number,
        number,
        number
      ]
  );
}

class ProbeLayer extends Layer {
  static layerName = 'ProbeLayer';
  initializeState() {}
}

test('SplatPickingShader#the shader encodes exactly what deck.gl decodes', () => {
  // Sharing an encoding across a CPU function and a shader is the kind of thing that stays correct
  // right up until one of them changes, so this runs the shader and compares it with deck.gl.
  const layer = new ProbeLayer({id: 'probe'});
  const rowIndices = [0, 1, 254, 255, 256, 65535, 65536, 16777213];
  const encoded = encodeInShader(rowIndices);
  rowIndices.forEach((rowIndex, index) => {
    const [r, g, b] = encoded[index];
    expect([r, g, b], `row ${rowIndex} encodes as deck does`).toEqual(
      layer.encodePickingColor(rowIndex)
    );
    expect(layer.decodePickingColor(new Uint8Array([r, g, b])), `and decodes back`).toBe(rowIndex);
  });
  const [r, g, b] = encodeInShader([16777215])[0];
  expect(
    [r, g, b],
    'and a row past what 24 bits can carry reports nothing rather than aliasing onto another row'
  ).toEqual([0, 0, 0]);
});

test('SplatPickingShader#the picking pipeline keeps deck.gl picking blend contract', () => {
  // deck.gl tells pickable layers apart by alpha, written through a blend constant. Run its own
  // picking pass's parameter logic for a pickable layer, then check the splat picking pipeline
  // keeps the part of it that carries the layer's identity.
  const pickLayersPass = new PickLayersPass({type: 'webgpu'} as never, {id: 'pick'});
  const passInternals = pickLayersPass as unknown as {
    _resetColorEncoder(pickZ: boolean): unknown;
    getLayerParameters(layer: Layer, layerIndex: number, viewport: Viewport): object;
  };
  passInternals._resetColorEncoder(false);
  const layer = {props: {parameters: {}, pickable: true, operation: 'draw'}} as unknown as Layer;
  const deckParameters = passInternals.getLayerParameters(layer, 0, {id: 'main'} as Viewport);
  const parameters = getSplatPickingParameters(deckParameters) as Record<string, unknown>;

  expect(parameters.blend, 'blending on, or the constant never reaches the target').toBe(true);
  for (const name of [
    'blendColorOperation',
    'blendColorSrcFactor',
    'blendColorDstFactor',
    'blendAlphaOperation',
    'blendAlphaSrcFactor',
    'blendAlphaDstFactor'
  ]) {
    expect(parameters[name], `${name} is deck's`).toBe(
      (deckParameters as Record<string, unknown>)[name]
    );
  }
  expect(parameters.blendAlphaSrcFactor, 'so alpha comes from the blend constant').toBe('constant');
  expect(
    'blendConstant' in parameters,
    'which is dynamic render-pass state, set by deck, not a pipeline parameter'
  ).toBe(false);
  expect(parameters.depthWriteEnabled, 'the nearest covered Gaussian wins the pixel').toBe(true);
  expect(parameters.depthCompare).toBe('less-equal');
});

test('SplatPickingShader#both variants parse and expose one vertex and one fragment entry', () => {
  for (const [name, source] of [
    ['storage', SPLAT_PICKING_SHADER],
    ['compatible', SPLAT_COMPATIBLE_PICKING_SHADER]
  ] as const) {
    const reflect = new WgslReflect(source);
    expect(
      reflect.entry.vertex.map(entry => entry.name),
      `${name}: one vertex entry`
    ).toEqual(['vertexMain']);
    expect(
      reflect.entry.fragment.map(entry => entry.name),
      `${name}: one fragment entry`
    ).toEqual(['fragmentMain']);
  }
});

test('SplatPickingShader#the compatibility variant binds no vertex-stage storage buffers', () => {
  const compatible = new WgslReflect(SPLAT_COMPATIBLE_PICKING_SHADER);

  expect(
    compatible.storage.length,
    'WebGPU compatibility mode reports zero storage buffers in the vertex stage'
  ).toBe(0);
  expect(
    compatible.entry.vertex[0]?.inputs?.map(input => input.name).sort(),
    'so the records and their source rows arrive as instance streams'
  ).toEqual(['instanceClipCenter', 'instancePackedRecord', 'instanceSortedId', 'vertexIndex']);
  expect(
    SPLAT_COMPATIBLE_PICKING_SHADER_LAYOUT.attributes.map(attribute => attribute.name),
    'which the declared layout matches'
  ).toEqual(['instanceClipCenter', 'instancePackedRecord', 'instanceSortedId']);
});

test('SplatPickingShader#the storage variant matches its declared bindings', () => {
  const storage = new WgslReflect(SPLAT_PICKING_SHADER);

  expect(
    [
      ...storage.uniforms.map(resource => ({name: resource.name, location: resource.binding})),
      ...storage.storage.map(resource => ({name: resource.name, location: resource.binding}))
    ],
    'camera uniforms, the projected records, and the sort order'
  ).toEqual(
    SPLAT_PICKING_SHADER_LAYOUT.bindings.map(binding => ({
      name: binding.name,
      location: binding.location
    }))
  );
});

test('SplatPickingShader#a fragment must cover the pixel before it can claim it', () => {
  // Picking a volume by first hit is ambiguous: the faint outer support of a large, nearly
  // transparent Gaussian routinely sits in front of a small opaque one.
  for (const [name, source] of [
    ['storage', SPLAT_PICKING_SHADER],
    ['compatible', SPLAT_COMPATIBLE_PICKING_SHADER]
  ] as const) {
    expect(source, `${name}: the coverage threshold gates the pick`).toMatch(
      /alpha < max\(uniforms\.alphaCutoff, uniforms\.pickingAlphaThreshold\)/
    );
    expect(source, `${name}: and the same Gaussian evaluation the display pass uses`).toMatch(
      /getSplatFragmentCoverage\(/
    );
  }
});
