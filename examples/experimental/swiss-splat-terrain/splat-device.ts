// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * The WebGPU device this example asks for, and the splat budget that device can actually hold.
 *
 * ## Why this file exists
 *
 * `GPUSplatGraphRenderer` keeps one projected record per resident splat -- 32 bytes
 * (`GPU_SPLAT_PROJECTED_RECORD_BYTE_LENGTH`) of clip-space centre, two screen-space axes and a
 * colour -- in a **single storage binding**. WebGPU's default limit for one storage binding is
 * 128 MiB, so that binding alone caps the scene at about 4.2M splats, and `resolveSplatCapacity`
 * throws `projected records exceed the device storage binding limit` past it.
 *
 * That cap is not the hardware's. The adapter on this machine reports **4 GiB**; 128 MiB is what a
 * device gets when nobody asks for more. luma.gl only forwards `requiredLimits` when
 * `featureLevel: 'max'` is requested -- and that same setting also force-enables *every* feature
 * the adapter supports, which is a much larger change than asking for a bigger buffer and is what
 * invalidates the depth sort's compute pipelines.
 *
 * So the two are separated here. {@link createSplatWebGPUAdapter} wraps the adapter luma.gl would
 * have used and injects `requiredLimits` into the device descriptor, changing nothing else: same
 * feature level, same features, same everything the sort compiles against. A request for limits the
 * adapter supports is ordinary WebGPU and either succeeds or rejects -- it cannot silently
 * downgrade -- and if it does reject, the plain adapter is used and the budget falls back to what
 * 128 MiB allows.
 */

import {webgpuAdapter} from '@luma.gl/webgpu';
import type {WebGPUAdapter} from '@luma.gl/webgpu';
import type {Device} from '@luma.gl/core';
import {GPU_SPLAT_PROJECTED_RECORD_BYTE_LENGTH} from '@luma.gl/splats';

/** Bytes of GPU storage the splat graph spends per resident splat, projecting it once per frame. */
const PROJECTED_RECORD_BYTES = GPU_SPLAT_PROJECTED_RECORD_BYTE_LENGTH;

/**
 * Margin kept between the largest budget offered and what the storage binding could hold.
 *
 * The layer sizes the projected buffer to the selected budget itself (`expectedSplatCount`), and
 * pages lingering in a fade are pinned inside that same budget, so a budget of exactly
 * `binding / 32` would fit. The margin is there so a residency count that briefly runs past the
 * budget still does not reach the binding limit, where the graph throws instead of degrading.
 */
const RESERVATION_FACTOR = 1.3;

/**
 * Storage binding this example asks for, when the adapter will give it.
 *
 * 512 MiB is about 12.9M resident splats after the reservation factor, so the ladder in `app.tsx`
 * is offered up to its 12.8M rung. Each rung above that needs twice the binding: 25.6M needs about
 * 1 GiB, 102.4M about 4 GiB. Asking for more is free in itself -- a limit is a ceiling, not an
 * allocation -- but the reservation *is* allocated up front, so the budget offered to the user is
 * what bounds real memory, not this number.
 */
const REQUESTED_STORAGE_BINDING_BYTES = 512 * 1024 * 1024;

/** WebGPU's guaranteed floor, and what a device gets when nobody asks for more. */
const DEFAULT_STORAGE_BINDING_BYTES = 128 * 1024 * 1024;

/**
 * The adapter luma.gl should use, with a larger storage binding requested.
 *
 * `WebGPUAdapter.create()` builds the whole device descriptor itself and there is no prop for
 * limits, so the injection point is one level down: `requestGPUAdapter` is what `create()` calls to
 * get the `GPUAdapter`, and the proxy it returns differs from the real one in exactly one respect --
 * `requestDevice` merges `requiredLimits` into whatever descriptor luma.gl passes.
 */
export function createSplatWebGPUAdapter(): WebGPUAdapter {
  const gpu = globalThis.navigator?.gpu as GPU | undefined;
  if (!gpu) {
    return webgpuAdapter;
  }

  // Inherits from luma.gl's own adapter rather than subclassing it, because the package exports the
  // class as a type only. `create()` reaches its adapter through `this.requestGPUAdapter`, so an
  // override on a descendant object is all it takes; everything else resolves up the chain.
  const adapter = Object.create(webgpuAdapter) as WebGPUAdapter & {
    requestGPUAdapter(options?: GPURequestAdapterOptions): Promise<GPUAdapter | null>;
  };

  adapter.requestGPUAdapter = async (options?: GPURequestAdapterOptions) => {
    const gpuAdapter = await gpu.requestAdapter(options);
    if (!gpuAdapter) {
      return null;
    }

    // Never ask for more than the adapter advertises: `requestDevice` rejects outright on an
    // unsupported limit, and losing the device is a far worse outcome than a smaller budget.
    const storageBindingBytes = Math.min(
      REQUESTED_STORAGE_BINDING_BYTES,
      gpuAdapter.limits.maxStorageBufferBindingSize
    );
    const bufferBytes = Math.max(
      storageBindingBytes,
      Math.min(REQUESTED_STORAGE_BINDING_BYTES, gpuAdapter.limits.maxBufferSize)
    );

    return new Proxy(gpuAdapter, {
      get(target, property) {
        if (property === 'requestDevice') {
          return async (descriptor: GPUDeviceDescriptor = {}) => {
            const requiredLimits = {
              ...descriptor.requiredLimits,
              maxStorageBufferBindingSize: storageBindingBytes,
              // A binding cannot exceed the buffer holding it, so this has to come up with it.
              maxBufferSize: bufferBytes
            };
            try {
              return await target.requestDevice({...descriptor, requiredLimits});
            } catch {
              // Whatever the driver objected to, the unraised device still runs this example --
              // `getMaxResidentSplats` reads what was granted rather than what was asked for.
              return await target.requestDevice(descriptor);
            }
          };
        }
        // `target` as the receiver, deliberately: `limits`, `features` and `info` are native
        // getters that throw `Illegal invocation` if `this` is the proxy rather than the adapter.
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  };

  return adapter;
}

/**
 * The largest residency budget this device can actually hold, in splats.
 *
 * Read from the device rather than assumed, because it is the one number that decides how much of a
 * live scene can be resolved at once and it differs by a factor of four depending on whether the
 * limit above was granted. Offering a budget the graph will throw on is worse than offering a small
 * one, so this is deliberately the conservative end: the reservation, not the frontier.
 */
export function getMaxResidentSplats(device: Device | null | undefined): number {
  const bindingBytes =
    device && device.limits.maxStorageBufferBindingSize > 0
      ? device.limits.maxStorageBufferBindingSize
      : DEFAULT_STORAGE_BINDING_BYTES;
  return Math.floor(bindingBytes / (PROJECTED_RECORD_BYTES * RESERVATION_FACTOR));
}
