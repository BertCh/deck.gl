// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';

import {
  getSplatDeviceBudget,
  getSplatDeviceClass,
  SPLAT_DEVICE_BUDGETS
} from '@deck.gl/splat-layers';
import type {SplatDeviceClass} from '@deck.gl/splat-layers';
import type {Device} from '@luma.gl/core';

/** A minimal stand-in for the properties the classifier reads. */
function makeDevice(options: {
  type?: string;
  info?: {type?: string; vendor?: string; gpu?: string};
  maxStorageBufferBindingSize?: number;
}): Device {
  return {
    type: options.type ?? 'webgpu',
    info: options.info ?? {},
    limits: {maxStorageBufferBindingSize: options.maxStorageBufferBindingSize ?? 2 ** 31}
  } as unknown as Device;
}

test('SplatDeviceBudgets#every preset is internally consistent', () => {
  for (const [deviceClass, budget] of Object.entries(SPLAT_DEVICE_BUDGETS)) {
    expect(
      typeof budget.maxResidentSplats === 'number' && budget.maxResidentSplats > 0,
      `${deviceClass} budgets a positive splat count`
    ).toBe(true);
    expect(
      typeof budget.maxGpuBytes === 'number' && budget.maxGpuBytes > budget.maxResidentSplats!,
      `${deviceClass} budgets more bytes than splats, since a splat costs more than a byte`
    ).toBe(true);
  }
  expect(
    SPLAT_DEVICE_BUDGETS.desktop.maxResidentSplats! >
      SPLAT_DEVICE_BUDGETS.mobile.maxResidentSplats!,
    'a desktop holds more than a phone'
  ).toBe(true);
  expect(
    SPLAT_DEVICE_BUDGETS.mobile.maxResidentSplats! >
      SPLAT_DEVICE_BUDGETS.headset.maxResidentSplats!,
    'and a phone more than a headset, which renders every frame twice'
  ).toBe(true);
});

test('SplatDeviceBudgets#classification separates the cases it can actually tell apart', () => {
  const cases: [string, Device, SplatDeviceClass][] = [
    [
      'a discrete GPU',
      makeDevice({info: {type: 'discrete-gpu', vendor: 'NVIDIA', gpu: 'RTX 4090'}}),
      'desktop'
    ],
    [
      'an Intel integrated GPU',
      makeDevice({info: {type: 'integrated-gpu', vendor: 'Intel', gpu: 'Iris Xe'}}),
      'integrated'
    ],
    [
      'Apple silicon, which shares memory but has the bandwidth for it',
      makeDevice({info: {type: 'integrated-gpu', vendor: 'Apple', gpu: 'Apple M3 Pro'}}),
      'mobile-high'
    ],
    [
      'a mobile GPU, whatever it calls its memory',
      makeDevice({info: {type: 'integrated-gpu', vendor: 'Qualcomm', gpu: 'Adreno 750'}}),
      'mobile'
    ],
    ['a Mali GPU', makeDevice({info: {vendor: 'ARM', gpu: 'Mali-G715'}}), 'mobile']
  ];

  for (const [description, device, expected] of cases) {
    expect(getSplatDeviceClass(device), description).toBe(expected);
  }
});

test('SplatDeviceBudgets#WebGL2 is budgeted by its sort, not by its GPU', () => {
  // WebGL2 has no storage buffers, so the sorted order is materialized on the CPU. That ceiling is
  // far below any GPU limit, on any machine.
  const workstation = makeDevice({
    type: 'webgl',
    info: {type: 'discrete-gpu', vendor: 'NVIDIA', gpu: 'RTX 4090'}
  });

  expect(getSplatDeviceClass(workstation), 'the backend decides, not the hardware').toBe('mobile');
});

test('SplatDeviceBudgets#a small storage limit overrides a confident name', () => {
  const device = makeDevice({
    info: {type: 'discrete-gpu', vendor: 'SomeVendor', gpu: 'Fast Sounding Name'},
    maxStorageBufferBindingSize: 128 * 1024 * 1024
  });

  expect(
    getSplatDeviceClass(device),
    'a device that will not bind a large buffer cannot hold a large scene'
  ).toBe('integrated');
});

test('SplatDeviceBudgets#overrides apply field by field', () => {
  const device = makeDevice({info: {type: 'discrete-gpu', vendor: 'NVIDIA'}});
  const budget = getSplatDeviceBudget(device, {maxResidentSplats: 100_000});

  expect(budget.maxResidentSplats, 'the override wins for the field it names').toBe(100_000);
  expect(budget.maxGpuBytes, 'and the preset still supplies the field it does not').toBe(
    SPLAT_DEVICE_BUDGETS.desktop.maxGpuBytes
  );
  expect(
    getSplatDeviceBudget(device),
    'with no overrides the preset is returned unchanged'
  ).toEqual(SPLAT_DEVICE_BUDGETS.desktop);
});
