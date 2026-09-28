// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {LayerExtension} from '@deck.gl/core';
import type {Layer, UpdateParameters} from '@deck.gl/core';
import type {SplatClipCombineMode, SplatClipPlane, SplatClipRegion} from '@luma.gl/splats';

/**
 * Clips Gaussian splats to a half-space, slab, corridor or convex prism, without editing the data.
 *
 * Masking to a parcel, a right of way or a slice plane is routine GIS work, and on a splat scene it
 * is routinely unavailable: Esri documents Slice as unsupported for splat layers and CesiumJS has
 * no clipping-plane path for them at all.
 *
 * The reason it is not simply a clip test is that a Gaussian is a volume, not a point. Testing only
 * its center cuts the scene along a visibly ragged boundary - a large splat straddling the plane
 * either disappears whole or stays whole - which is exactly what makes a center-based clip look
 * wrong on splats and fine on triangles. Measuring the signed distance in units of each splat's own
 * extent along the plane normal instead, and attenuating opacity by the resulting partial coverage,
 * gives a boundary that follows the geometry for one extra term per plane.
 *
 * Nothing is removed from the source data and no buffer is rewritten: the region is evaluated in
 * the projection compute pass the renderer already runs, so it can animate freely.
 *
 * @example Keep only what is above a horizontal plane, fading over each splat's own extent.
 * ```ts
 * new SplatLayer({
 *   // ...
 *   extensions: [new SplatClipExtension()],
 *   clipPlanes: [{normal: [0, 0, 1], distance: -10}]
 * })
 * ```
 *
 * @remarks WebGPU only. The WebGL2 fallback has no projection compute pass to evaluate the region
 * in, and doing it per row in JavaScript would cost more than the layer's whole frame budget.
 */

/** Props {@link SplatClipExtension} adds to a layer. */
export type SplatClipExtensionProps = {
  /**
   * Planes bounding the kept region, in the splat scene's own coordinates.
   *
   * A plane is `{normal, distance}` and keeps the side its normal points toward, so
   * `{normal: [0, 0, 1], distance: -10}` keeps everything above `z = 10`. At most eight.
   */
  clipPlanes?: readonly SplatClipPlane[] | null;
  /**
   * How the planes combine. Defaults to `'intersection'`, a convex prism.
   *
   * `'union'` keeps anything inside any one of them, which is how a set of disjoint regions is
   * expressed.
   */
  clipCombine?: SplatClipCombineMode;
  /**
   * Width of the soft boundary as a multiple of each Gaussian's own extent along the normal.
   *
   * `1`, the default, fades a splat over roughly its own standard deviation, which is the width at
   * which the cut reads as a cut through a volume rather than through a point set. Values below
   * about `0.05` approach a hard, center-based cut.
   */
  clipSoftness?: number;
  /** Keep the complement of the region instead of the region. */
  clipInverted?: boolean;
};

const defaultProps = {
  clipPlanes: {type: 'array', value: null, compare: true},
  clipCombine: 'intersection',
  clipSoftness: {type: 'number', value: 1, min: 0},
  clipInverted: false
};

/** Layer state this extension owns. */
type SplatClipExtensionState = {
  clipRegion?: SplatClipRegion;
};

export default class SplatClipExtension extends LayerExtension {
  static defaultProps = defaultProps;
  static extensionName = 'SplatClipExtension';

  /**
   * Rebuilds the region only when one of its props changed.
   *
   * The layer compares `clipRegion` by identity, so handing it a fresh object every update would
   * rewrite the clip uniform block on every frame for a region that never moved.
   */
  updateState(
    this: Layer<SplatClipExtensionProps>,
    {props, oldProps}: UpdateParameters<Layer<SplatClipExtensionProps>>,
    extension: SplatClipExtension
  ) {
    void extension;
    const changed =
      props.clipPlanes !== oldProps.clipPlanes ||
      props.clipCombine !== oldProps.clipCombine ||
      props.clipSoftness !== oldProps.clipSoftness ||
      props.clipInverted !== oldProps.clipInverted;
    if (!changed && (this.state as SplatClipExtensionState).clipRegion !== undefined) {
      return;
    }

    const planes = props.clipPlanes ?? [];
    this.setState({
      clipRegion: planes.length
        ? {
            planes,
            combine: props.clipCombine,
            softness: props.clipSoftness,
            invert: props.clipInverted
          }
        : undefined
    });
  }

  /**
   * Resolves the region a layer should clip with.
   *
   * Exposed so a layer can consult the extension rather than the extension reaching into the
   * layer's renderer: the layer already forwards its own `clipRegion` prop, and this simply wins
   * over it when the extension is attached.
   */
  static getClipRegion(layer: Layer): SplatClipRegion | undefined {
    return (layer.state as SplatClipExtensionState | undefined)?.clipRegion;
  }
}
