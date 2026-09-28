// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {ShaderLayout} from '@luma.gl/core';
import {
  GPU_SPLAT_FRAGMENT_SHARED_SHADER_WGSL,
  GPU_SPLAT_GRAPH_SHARED_WGSL,
  GPU_SPLAT_QUAD_EXPANSION_SHADER_WGSL
} from '@luma.gl/splats';

/**
 * Picking shaders that write deck.gl's own picking colors.
 *
 * luma.gl ships a Gaussian splat picker of its own, but it renders into integer attachments it
 * owns and resolves the hit itself. Inside deck.gl that is the wrong shape: deck already has a
 * picking framebuffer, a readback path, hover and click dispatch, `autoHighlight`, tooltips and
 * multi-layer depth picking. What the splat layer needs is not another picker but to participate
 * in the one that exists - which means encoding the picked row into deck's RGB picking color and
 * letting everything downstream work unchanged.
 *
 * Two details make the result match what a viewer sees rather than what is merely in front.
 * First, coverage: a Gaussian is a volume, and the faint outer support of a large, nearly
 * transparent splat routinely sits in front of a small opaque one while contributing almost
 * nothing to the pixel, so a fragment only claims the pixel once its own coverage passes a
 * threshold. Second, depth: the picking pass writes and tests depth, which the display pass
 * deliberately does not, so the nearest splat that passes the coverage test wins.
 */

/** Index `picking_getPickingColorFromIndex` treats as "no object". */
const PICKING_INVALID_INDEX = 16777215;

/** Storage-buffer picking layout, matching the render path on devices that allow it. */
export const SPLAT_PICKING_SHADER_LAYOUT = {
  attributes: [],
  bindings: [
    {name: 'graphUniforms', type: 'uniform', group: 0, location: 0},
    {name: 'projectedRecords', type: 'read-only-storage', group: 0, location: 1},
    {name: 'sortedIds', type: 'read-only-storage', group: 0, location: 2}
  ]
} satisfies ShaderLayout;

/** Compatibility picking layout: no storage buffers in the vertex stage. */
export const SPLAT_COMPATIBLE_PICKING_SHADER_LAYOUT = {
  attributes: [
    {name: 'instanceClipCenter', location: 0, type: 'vec4<f32>', stepMode: 'instance'},
    {name: 'instancePackedRecord', location: 1, type: 'vec4<u32>', stepMode: 'instance'},
    {name: 'instanceSortedId', location: 2, type: 'u32', stepMode: 'instance'}
  ],
  bindings: [{name: 'graphUniforms', type: 'uniform', group: 0, location: 0}]
} satisfies ShaderLayout;

const SPLAT_PICKING_SHARED = /* wgsl */ `\
${GPU_SPLAT_GRAPH_SHARED_WGSL}
${GPU_SPLAT_QUAD_EXPANSION_SHADER_WGSL}
${GPU_SPLAT_FRAGMENT_SHARED_SHADER_WGSL}

const PICKING_INVALID_INDEX: u32 = ${PICKING_INVALID_INDEX}u;

struct SplatPickingFragmentInputs {
  @builtin(position) position: vec4<f32>,
  @location(0) gaussianCoordinate: vec2<f32>,
  @location(1) pixelHalfWidth: vec2<f32>,
  @location(2) alpha: f32,
  @location(3) @interpolate(flat) rowIndex: u32,
};

/**
 * Encodes a row index exactly as deck.gl's CPU-side \`encodePickingColor\` does.
 *
 * Index zero is reserved for "nothing picked", so every real row is stored one higher; a row past
 * the 24 bits the encoding carries reports nothing rather than aliasing onto another row.
 */
fn getSplatPickingColor(rowIndex: u32) -> vec4<f32> {
  if (rowIndex >= PICKING_INVALID_INDEX) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  let encoded = rowIndex + 1u;
  return vec4<f32>(
    f32(encoded & 255u) / 255.0,
    f32((encoded >> 8u) & 255u) / 255.0,
    f32((encoded >> 16u) & 255u) / 255.0,
    1.0
  );
}

fn resolveSplatPickingColor(
  uniforms: GraphSplatUniforms,
  input: SplatPickingFragmentInputs
) -> vec4<f32> {
  let coverage = getSplatFragmentCoverage(
    uniforms,
    input.gaussianCoordinate,
    input.pixelHalfWidth
  );
  let alpha = getSplatResolvedAlpha(uniforms, input.alpha, coverage, input.gaussianCoordinate);
  if (alpha < max(uniforms.alphaCutoff, uniforms.pickingAlphaThreshold)) {
    discard;
  }
  return getSplatPickingColor(input.rowIndex);
}
`;

/** Picking shader for devices that allow storage buffers in the vertex stage. */
export const SPLAT_PICKING_SHADER = /* wgsl */ `\
${SPLAT_PICKING_SHARED}

@group(0) @binding(0) var<uniform> graphUniforms: GraphSplatUniforms;
@group(0) @binding(1) var<storage, read> projectedRecords: array<ProjectedSplat>;
@group(0) @binding(2) var<storage, read> sortedIds: array<u32>;

@vertex
fn vertexMain(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32
) -> SplatPickingFragmentInputs {
  let rowIndex = sortedIds[instanceIndex];
  let projected = projectedRecords[rowIndex];
  let quad = expandSplatQuad(
    graphUniforms,
    vertexIndex,
    projected.clipCenter,
    projected.packedAxis0,
    projected.packedAxis1,
    projected.packedColorRG,
    projected.packedColorBA
  );

  var output: SplatPickingFragmentInputs;
  output.position = quad.position;
  output.gaussianCoordinate = quad.gaussianCoordinate;
  output.pixelHalfWidth = quad.pixelHalfWidth;
  output.alpha = quad.color.a;
  output.rowIndex = rowIndex;
  return output;
}

@fragment
fn fragmentMain(input: SplatPickingFragmentInputs) -> @location(0) vec4<f32> {
  return resolveSplatPickingColor(graphUniforms, input);
}
`;

/** Picking shader for WebGPU compatibility mode, reading the gathered sorted vertex stream. */
export const SPLAT_COMPATIBLE_PICKING_SHADER = /* wgsl */ `\
${SPLAT_PICKING_SHARED}

@group(0) @binding(0) var<uniform> graphUniforms: GraphSplatUniforms;

@vertex
fn vertexMain(
  @builtin(vertex_index) vertexIndex: u32,
  @location(0) instanceClipCenter: vec4<f32>,
  @location(1) instancePackedRecord: vec4<u32>,
  @location(2) instanceSortedId: u32
) -> SplatPickingFragmentInputs {
  let quad = expandSplatQuad(
    graphUniforms,
    vertexIndex,
    instanceClipCenter,
    instancePackedRecord.x,
    instancePackedRecord.y,
    instancePackedRecord.z,
    instancePackedRecord.w
  );

  var output: SplatPickingFragmentInputs;
  output.position = quad.position;
  output.gaussianCoordinate = quad.gaussianCoordinate;
  output.pixelHalfWidth = quad.pixelHalfWidth;
  output.alpha = quad.color.a;
  output.rowIndex = instanceSortedId;
  return output;
}

@fragment
fn fragmentMain(input: SplatPickingFragmentInputs) -> @location(0) vec4<f32> {
  return resolveSplatPickingColor(graphUniforms, input);
}
`;
