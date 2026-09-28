// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {CommandEncoder} from '@luma.gl/core';

import Pass from './pass';
import type Layer from '../lib/layer';
import type Viewport from '../viewports/viewport';

/**
 * Parameters supplied to a layer's compute stage.
 *
 * The encoder is deck.gl's own, the same one the render pass that immediately follows is recorded
 * into, so anything written here is visible to that draw without a second submission and without
 * any explicit synchronization.
 */
export type LayerComputeParameters = {
  /**
   * Encoder deck.gl submits together with the render pass that follows.
   *
   * Only a WebGPU encoder can open compute passes. On WebGL the hook still runs, but the encoder
   * cannot begin a compute pass, so implementations must check `device.type` before doing so.
   */
  commandEncoder: CommandEncoder;
  /** Viewport the layer is about to be drawn with. */
  viewport: Viewport;
  /** Name of the draw pass that follows, for example `'screen'`. Picking passes never compute. */
  pass: string;
  /**
   * Whether the following draw pass renders picking colors rather than display colors. Only
   * `true` in the `drawPickingColors` debug mode; real picking passes do not run compute.
   */
  isPicking: boolean;
};

/** What a compute stage needs to know about the draw pass it precedes. */
export type ComputeLayersPassOptions = {
  /** Name of the draw pass that follows. */
  pass: string;
  /** Layers to compute. The caller has already applied visibility and layer filtering. */
  layers: Layer[];
  isPicking?: boolean;
};

/**
 * Records every layer's GPU compute work immediately before the render pass that consumes it.
 *
 * A layer that computes what it is about to draw - a GPU-driven aggregation, a sort, a culling
 * pass - cannot do that work inside `draw()`, because a compute pass and a render pass cannot be
 * open on the same encoder at once. Without somewhere to put it, such a layer has to open an
 * encoder of its own and submit it separately, which costs an extra submission per layer per frame
 * and gives up the ordering guarantee that makes the result usable.
 *
 * It is driven by `LayersPass`, **per physical viewport**, interleaved with the render passes
 * rather than batched ahead of them: what a layer computes is camera-dependent, so computing every
 * viewport up front would leave every view drawing the last one's result.
 *
 * @remarks
 * This pass opens no render pass and submits nothing. Layers record into deck.gl's encoder; the
 * render pass follows on the same encoder and one submission covers both. It only runs before draw
 * passes; picking passes reuse whatever the preceding draw computed.
 */
export default class ComputeLayersPass extends Pass {
  /**
   * Runs the compute stage of each given layer for a single viewport.
   *
   * Errors thrown by a layer are routed to its `onError`, as they are for `draw`.
   */
  computeViewport(viewport: Viewport, options: ComputeLayersPassOptions): void {
    const {layers, pass, isPicking = false} = options;
    const commandEncoder = this.device.commandEncoder;
    for (const layer of layers) {
      try {
        layer._computeLayer({commandEncoder, viewport, pass, isPicking});
      } catch (err) {
        layer.raiseError(err as Error, `computing ${layer} for ${pass}`);
      }
    }
  }
}
