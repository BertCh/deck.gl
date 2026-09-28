// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {WgslReflect} from 'wgsl_reflect';

import {Layer} from '@deck.gl/core';
import {
  SPLAT_COMPATIBLE_PICKING_SHADER,
  SPLAT_COMPATIBLE_PICKING_SHADER_LAYOUT,
  SPLAT_PICKING_SHADER,
  SPLAT_PICKING_SHADER_LAYOUT
} from '@deck.gl/splat-layers';

/** Reproduces the shader's encoding so the two can be compared directly. */
function encodeInShader(rowIndex: number): [number, number, number] {
  if (rowIndex >= 16777215) {
    return [0, 0, 0];
  }
  const encoded = rowIndex + 1;
  return [
    Math.round((((encoded & 255) / 255) * 255) as number),
    Math.round(((((encoded >> 8) & 255) / 255) * 255) as number),
    Math.round(((((encoded >> 16) & 255) / 255) * 255) as number)
  ];
}

class ProbeLayer extends Layer {
  static layerName = 'ProbeLayer';
  initializeState() {}
}

test('SplatPickingShader#the shader encodes exactly what deck.gl decodes', () => {
  // Sharing an encoding across a CPU function and a shader is the kind of thing that stays correct
  // right up until one of them changes, so this compares them rather than restating either.
  const layer = new ProbeLayer({id: 'probe'});
  for (const rowIndex of [0, 1, 254, 255, 256, 65535, 65536, 16777213]) {
    expect(encodeInShader(rowIndex), `row ${rowIndex}`).toEqual(layer.encodePickingColor(rowIndex));
  }
  expect(
    encodeInShader(16777215),
    'and a row past what 24 bits can carry reports nothing rather than aliasing onto another row'
  ).toEqual([0, 0, 0]);
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
