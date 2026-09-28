# Device budgets

A Gaussian splat scene has no natural size — a capture can always be streamed further — so what a
viewer keeps resident is a decision, not a property of the data. Making that decision from the
machine in front of you is the difference between "works on my workstation" and "works".

```js
import {getSplatDeviceBudget, getSplatDeviceClass, SPLAT_DEVICE_BUDGETS} from '@deck.gl/splat-layers';
```

[SplatLayer](./splat-layer.md) applies a preset automatically; these are exported for callers that
want to display the budget, or to cap one field of it without restating the rest.

## Presets

| Class          | Resident splats | Notes                                                       |
| -------------- | --------------- | ----------------------------------------------------------- |
| `desktop`      | 2,500,000       | Discrete or high-end integrated GPU                          |
| `integrated`   | 1,500,000       | Low-end integrated GPU                                       |
| `mobile-high`  | 1,500,000       | Apple silicon — shared memory, ample bandwidth               |
| `mobile`       | 1,000,000       | Android and other mobile, and every WebGL2 device            |
| `headset`      | 500,000         | Standalone headsets, which render every frame twice          |

Byte ceilings are derived from the splat counts rather than guessed: at roughly 52 bytes of source
columns plus 32 bytes of projection scratch plus one band of harmonics, a resident splat costs about
120 bytes.

## `getSplatDeviceClass(device)`

Classifies a device from what it reports about itself. Deliberately coarse: the properties a
`Device` exposes separate a phone from a workstation reliably and two workstations not at all.

Two rules override the reported name:

- **WebGL2 is always `'mobile'`.** It has no storage buffers, so the sorted order is materialized on
  the CPU — a far lower ceiling than any GPU limit implies, on any machine.
- **A small `maxStorageBufferBindingSize` demotes to `'integrated'`.** A device that will not bind a
  large storage buffer cannot hold a large resident scene, whatever it calls itself.

## `getSplatDeviceBudget(device, overrides?)`

Returns the preset for the device, with `overrides` applied field by field:

```js
// Half the splats the device would normally hold, but the preset's byte ceiling.
getSplatDeviceBudget(device, {maxResidentSplats: 500_000});
```
