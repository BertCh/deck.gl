// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {Device} from '@luma.gl/core';
import type {SplatResidencyBudget} from '@luma.gl/splats';

/**
 * Device-class residency budgets for streamed Gaussian splat scenes.
 *
 * A splat scene has no natural size - a capture can always be streamed further - so what a viewer
 * keeps resident is a decision, not a property of the data. Making that decision from the machine
 * in front of you is the difference between "works on my workstation" and "works".
 *
 * The splat counts below follow the budgets shipping viewers converged on, and the byte ceilings
 * are derived from them rather than guessed: at the renderer's own resident cost of roughly 52
 * bytes of source columns plus 32 bytes of projection scratch per splat, plus one band of
 * harmonics, a resident splat costs about 120 bytes.
 */

/** A device class a budget can be chosen for. */
export type SplatDeviceClass =
  /** Desktop or laptop with a discrete GPU, or a GPU that does not report its kind. */
  | 'desktop'
  /** Desktop or laptop with an integrated GPU other than Apple's. */
  | 'integrated'
  /**
   * Apple GPUs - Apple silicon Macs, iPhones and iPads - which share memory between CPU and GPU
   * but have the bandwidth for it.
   */
  | 'mobile-high'
  /**
   * Android and other mobile GPUs, where memory headroom is least predictable. Also every WebGL2
   * device and every software rasterizer.
   */
  | 'mobile'
  /** Standalone headsets, which render every frame twice. */
  | 'headset';

/**
 * Bytes a resident splat is priced at when a preset's byte ceiling is derived from its splat count:
 * source columns, projection scratch and one spherical-harmonic band.
 *
 * This prices the *budget*, not any particular scene. A degree-3 scene costs nearly twice this per
 * splat, which is why `SplatLayer` plans its selection from the bytes its pages actually cost
 * rather than from this constant.
 */
export const RESIDENT_BYTES_PER_SPLAT = 120;

/** Splat budgets by device class. */
const SPLAT_BUDGET_BY_DEVICE_CLASS: Record<SplatDeviceClass, number> = {
  desktop: 2_500_000,
  integrated: 1_500_000,
  'mobile-high': 1_500_000,
  mobile: 1_000_000,
  headset: 500_000
};

/**
 * Ready-made residency budgets, keyed by device class. Each preset's `maxGpuBytes` is its
 * `maxResidentSplats` priced at 120 bytes a splat.
 */
export const SPLAT_DEVICE_BUDGETS: Record<SplatDeviceClass, SplatResidencyBudget> = Object.freeze(
  Object.fromEntries(
    Object.entries(SPLAT_BUDGET_BY_DEVICE_CLASS).map(([deviceClass, maxResidentSplats]) => [
      deviceClass,
      Object.freeze({
        maxResidentSplats,
        maxGpuBytes: getSplatGpuBytes(maxResidentSplats)
      })
    ])
  )
) as Record<SplatDeviceClass, SplatResidencyBudget>;

/**
 * Mobile GPU families, matched against the vendor, driver and architecture strings a device reports.
 *
 * WebGPU adapters report short lowercase names - `qualcomm` / `adreno-7xx`, `arm` / `valhall` - and
 * WebGL renderer strings the marketing names, so both spellings are listed.
 */
const MOBILE_GPU_PATTERN =
  /adreno|qualcomm|mali|\barm\b|valhall|bifrost|immortalis|powervr|imagination/;

/**
 * Classifies a device from what it reports about itself.
 *
 * Deliberately coarse. What a `Device` reports - its backend, its GPU family and kind
 * (`info.gpu`, `info.gpuType`), vendor and architecture strings, and its storage limits - separates
 * a phone from a workstation reliably and two workstations not at all, so this sorts into the
 * buckets it can actually distinguish and leaves finer tuning to an explicit budget.
 *
 * @param device The device the layer renders with.
 * @returns The device class whose preset in {@link SPLAT_DEVICE_BUDGETS} applies.
 */
export function getSplatDeviceClass(device: Device): SplatDeviceClass {
  // WebGL2 has no storage buffers, so a splat scene is sorted and repacked on the CPU there. That
  // is a far lower ceiling than any GPU limit implies, whatever the machine.
  if (device.type !== 'webgpu') {
    return 'mobile';
  }

  // `info.type` is the backend; the kind of GPU is `gpuType` and its family is `gpu`.
  const {gpu, gpuType, vendor, renderer, gpuArchitecture} = device.info;
  if (gpuType === 'cpu' || gpu === 'software') {
    // A software rasterizer has no memory of its own to budget and far less throughput than any GPU.
    return 'mobile';
  }
  const description = `${vendor} ${renderer} ${gpuArchitecture ?? ''}`.toLowerCase();
  if (MOBILE_GPU_PATTERN.test(description)) {
    return 'mobile';
  }
  if (gpu === 'apple' && gpuType !== 'discrete') {
    // Apple silicon shares memory between CPU and GPU but has ample bandwidth for it.
    return 'mobile-high';
  }
  if (gpuType === 'integrated') {
    return 'integrated';
  }

  // A device that will not bind a large storage buffer cannot hold a large resident scene however
  // it describes itself, so the limit overrides the name.
  const maximumStorageBytes = device.limits.maxStorageBufferBindingSize;
  if (maximumStorageBytes > 0 && maximumStorageBytes < 256 * 1024 * 1024) {
    return 'integrated';
  }

  return 'desktop';
}

/**
 * Returns the residency budget to stream a scene with on this device.
 *
 * @param overrides Applied on top of the preset, so a caller can cap bytes without restating the
 * splat count or vice versa. See {@link applySplatBudgetOverrides} for how a splat count alone is
 * read.
 */
export function getSplatDeviceBudget(
  device: Device,
  overrides?: SplatResidencyBudget
): SplatResidencyBudget {
  return applySplatBudgetOverrides(SPLAT_DEVICE_BUDGETS[getSplatDeviceClass(device)], overrides);
}

/**
 * Applies caller overrides to a preset.
 *
 * Fields an override leaves `undefined` - or sets to `undefined` explicitly, as an object spread of
 * optional props does - keep the preset's value rather than erasing it.
 *
 * A preset's byte ceiling is not an independent limit: it is its splat count priced at
 * {@link RESIDENT_BYTES_PER_SPLAT}. So an override that names a splat count and no byte ceiling
 * gets the byte ceiling that splat count implies, rather than keeping the preset's - otherwise
 * raising the count above the preset raises nothing, and the window fills on bytes at the preset's
 * size while the traversal plans for the count it was given.
 */
export function applySplatBudgetOverrides(
  preset: SplatResidencyBudget,
  overrides?: SplatResidencyBudget | null
): SplatResidencyBudget {
  const definedOverrides = Object.fromEntries(
    Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined)
  ) as SplatResidencyBudget;
  const {maxResidentSplats, maxGpuBytes} = definedOverrides;
  const impliedGpuBytes =
    maxResidentSplats !== undefined && maxGpuBytes === undefined
      ? {maxGpuBytes: getSplatGpuBytes(maxResidentSplats)}
      : {};
  return {...preset, ...definedOverrides, ...impliedGpuBytes};
}

/** The GPU bytes a number of resident splats is budgeted to cost. */
function getSplatGpuBytes(splatCount: number): number {
  return splatCount * RESIDENT_BYTES_PER_SPLAT;
}

/**
 * The resident splats a GPU byte ceiling holds at a given cost per splat.
 *
 * @param bytesPerSplat What one resident splat actually costs; defaults to the preset pricing.
 */
export function getSplatCountForGpuBytes(
  gpuBytes: number,
  bytesPerSplat: number = RESIDENT_BYTES_PER_SPLAT
): number {
  return Math.floor(gpuBytes / Math.max(bytesPerSplat, 1));
}
