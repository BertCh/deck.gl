// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {CommandEncoder} from '@luma.gl/core';

import Pass from './pass';
import type Layer from '../lib/layer';
import type Viewport from '../viewports/viewport';
import type {FilterContext} from './layers-pass';

/**
 * Parameters supplied to a layer's compute stage.
 *
 * The encoder is deck.gl's own, the same one the render pass that immediately follows is recorded
 * into, so anything written here is visible to that draw without a second submission and without
 * any explicit synchronization.
 */
export type LayerComputeParameters = {
  /** Encoder deck.gl submits together with the render pass that follows. */
  commandEncoder: CommandEncoder;
  /** Viewport the layer is about to be drawn with. */
  viewport: Viewport;
  /** Name of the render pass that follows, for example `'screen'` or `'picking'`. */
  pass: string;
  /** Whether the following pass renders picking colors rather than display colors. */
  isPicking: boolean;
};

/** What a compute stage needs to know about the render pass it precedes. */
export type ComputeLayersPassOptions = {
  pass: string;
  layers: Layer[];
  isPicking?: boolean;
  layerFilter?: ((context: FilterContext) => boolean) | null;
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
 * This stage gives that work a home, and is deliberately not tied to any one layer type: an
 * aggregation layer binning on the GPU and a Gaussian splat layer projecting and sorting on the
 * GPU want exactly the same thing.
 *
 * It runs **per viewport**, interleaved with the render passes rather than batched ahead of them.
 * That matters as soon as there is more than one view: what a layer computes is camera-dependent,
 * so computing every viewport up front would leave every view drawing the last one's result. A
 * split-screen pair of cameras gets a correct depth order each, which is the reason to pay for the
 * interleaving.
 *
 * @remarks
 * This pass opens no render pass and submits nothing. Layers record into deck.gl's encoder; the
 * render pass follows on the same encoder and one submission covers both.
 */
export default class ComputeLayersPass extends Pass {
  /** Layer/viewport pairs whose compute stage ran during the most recent frame. */
  computedLayerCount = 0;

  /** Clears the per-frame counter. Called once before a frame's viewports are walked. */
  beginFrame(): void {
    this.computedLayerCount = 0;
  }

  /**
   * Runs the compute stage for every layer that declares one, for a single viewport.
   *
   * Returns immediately when no layer in the stack needs it, so a stack of ordinary layers pays
   * one array scan per viewport and nothing else.
   */
  computeViewport(viewport: Viewport, options: ComputeLayersPassOptions): void {
    const {layers, pass, isPicking = false, layerFilter} = options;
    if (!layers.some(layer => layer.needsComputePass)) {
      return;
    }

    const commandEncoder = this.device.commandEncoder;
    for (const layer of layers) {
      if (!layer.needsComputePass || !layer.isDrawable || layer.isComposite) {
        continue;
      }
      if (layerFilter && !layerFilter({layer, viewport, isPicking, renderPass: pass})) {
        continue;
      }
      layer._computeLayer({commandEncoder, viewport, pass, isPicking});
      this.computedLayerCount++;
    }
  }

  /** Runs the compute stage across a list of viewports, in order. */
  render(options: ComputeLayersPassOptions & {viewports: Viewport[]}): void {
    this.beginFrame();
    for (const viewport of options.viewports) {
      this.computeViewport(viewport, options);
    }
  }
}
