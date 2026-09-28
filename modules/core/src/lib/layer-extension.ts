// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {deepEqual} from '../utils/deep-equal';
import type Layer from './layer';
import type CompositeLayer from './composite-layer';
import type {UpdateParameters} from './layer';
import type {LayerContext} from './layer-manager';
import type {LayerComputeParameters} from '../passes/compute-layers-pass';

export default abstract class LayerExtension<OptionsT = unknown> {
  static defaultProps = {};
  static extensionName = 'LayerExtension';

  static get componentName() {
    return Object.prototype.hasOwnProperty.call(this, 'extensionName') ? this.extensionName : '';
  }

  opts!: OptionsT;

  constructor(opts?: OptionsT) {
    if (opts) {
      this.opts = opts;
    }
  }

  /** Returns true if two extensions are equivalent */
  equals(extension: LayerExtension<OptionsT>): boolean {
    if (this === extension) {
      return true;
    }

    // Compare extensions shallowly
    return this.constructor === extension.constructor && deepEqual(this.opts, extension.opts, 1);
  }

  /** Only called if attached to a primitive layer */
  getShaders(this: Layer, extension: this): any {
    return null;
  }

  /** Only called if attached to a CompositeLayer */
  getSubLayerProps(this: CompositeLayer, extension: this): any {
    const {defaultProps} = extension.constructor as typeof LayerExtension;
    const newProps = {
      updateTriggers: {}
    };

    /* eslint-disable max-depth */
    for (const key in defaultProps) {
      if (key in this.props) {
        const propDef = defaultProps[key];
        const propValue = this.props[key];
        newProps[key] = propValue;
        if (propDef && propDef.type === 'accessor') {
          newProps.updateTriggers[key] = this.props.updateTriggers[key];
          if (typeof propValue === 'function') {
            newProps[key] = this.getSubLayerAccessor(propValue);
          }
        }
      }
    }
    /* eslint-enable max-depth */
    return newProps;
  }

  /* eslint-disable @typescript-eslint/no-empty-function */
  initializeState(this: Layer, context: LayerContext, extension: this): void {}

  updateState(this: Layer, params: UpdateParameters<Layer>, extension: this): void {}

  onNeedsRedraw(this: Layer, extension: this): void {}

  getNeedsPickingBuffer(this: Layer, extension: this): boolean {
    return false;
  }

  draw(this: Layer, params: any, extension: this): void {}

  /**
   * Records GPU compute work before the render pass that draws the layer opens.
   *
   * Called before the layer's own `compute`, with the same parameters, whenever the layer is about
   * to be drawn in a viewport. Defining this hook is enough to opt the layer in: the base
   * `Layer.needsComputePass` returns `true` for any layer with an extension that overrides it.
   * Not called before picking passes. On WebGL the encoder cannot open compute passes, so check
   * `this.context.device.type` first.
   */
  compute(this: Layer, params: LayerComputeParameters, extension: this): void {}

  finalizeState(this: Layer, context: LayerContext, extension: this): void {}
}
