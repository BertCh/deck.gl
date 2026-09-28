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
  /** Desktop or laptop with a discrete or high-end integrated GPU. */
  | 'desktop'
  /** Desktop or laptop with a low-end integrated GPU. */
  | 'integrated'
  /** iOS or iPadOS. */
  | 'mobile-high'
  /** Android and other mobile devices, where memory headroom is least predictable. */
  | 'mobile'
  /** Standalone headsets, which render every frame twice. */
  | 'headset';

/** Bytes a resident splat costs, across source columns, projection scratch and one SH band. */
const RESIDENT_BYTES_PER_SPLAT = 120;

/** Splat budgets by device class. */
const SPLAT_BUDGET_BY_DEVICE_CLASS: Record<SplatDeviceClass, number> = {
  desktop: 2_500_000,
  integrated: 1_500_000,
  'mobile-high': 1_500_000,
  mobile: 1_000_000,
  headset: 500_000
};

/** Ready-made residency budgets, keyed by device class. */
export const SPLAT_DEVICE_BUDGETS: Record<SplatDeviceClass, SplatResidencyBudget> = Object.freeze(
  Object.fromEntries(
    Object.entries(SPLAT_BUDGET_BY_DEVICE_CLASS).map(([deviceClass, maxResidentSplats]) => [
      deviceClass,
      Object.freeze({
        maxResidentSplats,
        maxGpuBytes: maxResidentSplats * RESIDENT_BYTES_PER_SPLAT
      })
    ])
  )
) as Record<SplatDeviceClass, SplatResidencyBudget>;

/**
 * Classifies a device from what it reports about itself.
 *
 * Deliberately coarse. The properties a `Device` exposes - its backend, its storage limits, its
 * reported vendor - separate a phone from a workstation reliably and separate two workstations not
 * at all, so this sorts into the buckets it can actually distinguish and leaves finer tuning to an
 * explicit budget.
 */
export function getSplatDeviceClass(device: Device): SplatDeviceClass {
  // WebGL2 has no storage buffers, so a splat scene is sorted and repacked on the CPU there. That
  // is a far lower ceiling than any GPU limit implies, whatever the machine.
  if (device.type !== 'webgpu') {
    return 'mobile';
  }

  const info = device.info as {type?: string; vendor?: string; gpu?: string} | undefined;
  const description = `${info?.vendor ?? ''} ${info?.gpu ?? ''}`.toLowerCase();
  if (/adreno|mali|powervr|immortalis/.test(description)) {
    return 'mobile';
  }
  if (/apple/.test(description) && info?.type === 'integrated-gpu') {
    // Apple silicon shares memory between CPU and GPU but has ample bandwidth for it.
    return 'mobile-high';
  }
  if (info?.type === 'integrated-gpu') {
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
 * splat count or vice versa.
 */
export function getSplatDeviceBudget(
  device: Device,
  overrides?: SplatResidencyBudget
): SplatResidencyBudget {
  return {...SPLAT_DEVICE_BUDGETS[getSplatDeviceClass(device)], ...overrides};
}
