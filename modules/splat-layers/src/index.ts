// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

export {default as SplatLayer} from './splat-layer';
export type {
  SplatBackendKind,
  SplatHierarchySource,
  SplatLayerProps,
  SplatPickingInfo,
  SplatStreamingStats,
  SplatUpAxis
} from './splat-layer';

export {default as SplatClipExtension} from './splat-clip-extension';
export type {SplatClipExtensionProps} from './splat-clip-extension';

export {
  getSplatDeviceBudget,
  getSplatDeviceClass,
  SPLAT_DEVICE_BUDGETS
} from './splat-device-budgets';
export type {SplatDeviceClass} from './splat-device-budgets';
