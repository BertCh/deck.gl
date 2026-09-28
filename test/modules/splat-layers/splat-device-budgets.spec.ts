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
import type {Device, DeviceInfo} from '@luma.gl/core';

/** The `DeviceInfo` fields the classifier reads, in the shape luma.gl reports them. */
type DeviceInfoFields = Partial<
  Pick<DeviceInfo, 'type' | 'vendor' | 'renderer' | 'gpu' | 'gpuType' | 'gpuArchitecture'>
>;

/** A minimal stand-in for the properties the classifier reads. */
function makeDevice(options: {
  type?: 'webgpu' | 'webgl';
  info?: DeviceInfoFields;
  maxStorageBufferBindingSize?: number;
}): Device {
  const type = options.type ?? 'webgpu';
  return {
    type,
    // `info.type` is the backend, as it is on a real device; the GPU's kind is `gpuType`.
    info: {
      type,
      vendor: 'unknown',
      renderer: '',
      gpu: 'unknown',
      gpuType: 'unknown',
      ...options.info
    },
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
  // Vendor and architecture strings as Chrome's WebGPU adapter info reports them.
  const cases: [string, Device, SplatDeviceClass][] = [
    [
      'a discrete GPU',
      makeDevice({info: {vendor: 'nvidia', gpu: 'nvidia', gpuType: 'discrete'}}),
      'desktop'
    ],
    [
      'an Intel integrated GPU',
      makeDevice({
        info: {vendor: 'intel', gpu: 'intel', gpuType: 'integrated', gpuArchitecture: 'gen-12lp'}
      }),
      'integrated'
    ],
    [
      'Apple silicon, which shares memory but has the bandwidth for it',
      makeDevice({
        info: {vendor: 'apple', gpu: 'apple', gpuType: 'integrated', gpuArchitecture: 'metal-3'}
      }),
      'mobile-high'
    ],
    [
      'Apple silicon on a browser that does not report the GPU kind',
      makeDevice({info: {vendor: 'apple', gpu: 'apple', gpuArchitecture: 'metal-3'}}),
      'mobile-high'
    ],
    [
      'a mobile GPU, whatever it calls its memory',
      makeDevice({
        info: {vendor: 'qualcomm', gpuType: 'integrated', gpuArchitecture: 'adreno-7xx'}
      }),
      'mobile'
    ],
    ['a Mali GPU', makeDevice({info: {vendor: 'arm', gpuArchitecture: 'valhall'}}), 'mobile'],
    [
      'a software rasterizer',
      makeDevice({
        info: {vendor: 'google', gpu: 'software', gpuType: 'cpu', gpuArchitecture: 'swiftshader'}
      }),
      'mobile'
    ],
    ['a device that reports nothing at all', makeDevice({}), 'desktop']
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
    info: {vendor: 'NVIDIA Corporation', gpu: 'nvidia', gpuType: 'discrete'}
  });

  expect(getSplatDeviceClass(workstation), 'the backend decides, not the hardware').toBe('mobile');
});

test('SplatDeviceBudgets#a small storage limit overrides a confident name', () => {
  const device = makeDevice({
    info: {vendor: 'somevendor', gpuType: 'discrete', gpuArchitecture: 'fast-sounding-name'},
    maxStorageBufferBindingSize: 128 * 1024 * 1024
  });

  expect(
    getSplatDeviceClass(device),
    'a device that will not bind a large buffer cannot hold a large scene'
  ).toBe('integrated');
});

test('SplatDeviceBudgets#overrides apply field by field', () => {
  const device = makeDevice({info: {vendor: 'nvidia', gpu: 'nvidia', gpuType: 'discrete'}});
  const bytesOnly = getSplatDeviceBudget(device, {maxGpuBytes: 1_000_000});

  expect(bytesOnly.maxGpuBytes, 'the override wins for the field it names').toBe(1_000_000);
  expect(bytesOnly.maxResidentSplats, 'and the preset still supplies the field it does not').toBe(
    SPLAT_DEVICE_BUDGETS.desktop.maxResidentSplats
  );
  expect(
    getSplatDeviceBudget(device, {maxResidentSplats: 100_000, maxGpuBytes: 1_000_000}),
    'both fields named are both kept'
  ).toEqual({maxResidentSplats: 100_000, maxGpuBytes: 1_000_000});
  expect(
    getSplatDeviceBudget(device),
    'with no overrides the preset is returned unchanged'
  ).toEqual(SPLAT_DEVICE_BUDGETS.desktop);
});

test('SplatDeviceBudgets#a splat count alone brings the byte ceiling it implies', () => {
  const device = makeDevice({info: {vendor: 'nvidia', gpu: 'nvidia', gpuType: 'discrete'}});
  const preset = SPLAT_DEVICE_BUDGETS.desktop;
  const bytesPerSplat = preset.maxGpuBytes! / preset.maxResidentSplats!;
  const raised = getSplatDeviceBudget(device, {maxResidentSplats: 6_400_000});

  expect(raised.maxResidentSplats).toBe(6_400_000);
  expect(
    raised.maxGpuBytes,
    'raising the splat count past the preset must not leave the preset byte ceiling binding first'
  ).toBe(6_400_000 * bytesPerSplat);
});

test('SplatDeviceBudgets#an override left undefined keeps the preset value', () => {
  const device = makeDevice({info: {vendor: 'nvidia', gpu: 'nvidia', gpuType: 'discrete'}});
  // What `{maxResidentSplats: props.maxSplats}` produces when the prop is not set.
  const budget = getSplatDeviceBudget(device, {
    maxResidentSplats: undefined,
    maxGpuBytes: undefined,
    maxResidentChunks: 64
  });

  expect(budget, 'undefined fields do not erase the preset').toEqual({
    ...SPLAT_DEVICE_BUDGETS.desktop,
    maxResidentChunks: 64
  });
});
