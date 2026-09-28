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
| `desktop`      | 2,500,000       | Discrete GPU, or one that does not report its kind           |
| `integrated`   | 1,500,000       | Integrated GPU other than Apple's                            |
| `mobile-high`  | 1,500,000       | Apple GPUs — shared memory, ample bandwidth                  |
| `mobile`       | 1,000,000       | Android and other mobile, every WebGL2 device, software GPUs |
| `headset`      | 500,000         | Standalone headsets, which render every frame twice          |

Byte ceilings are derived from the splat counts rather than guessed: at roughly 52 bytes of source
columns plus 32 bytes of projection scratch plus one band of harmonics, a resident splat costs about
120 bytes. That prices the *budget*, not a scene: a degree-3 page costs nearly twice as much, which
is why [SplatLayer](./splat-layer.md) plans its selection from what resident pages actually cost.

## `getSplatDeviceClass(device)`

Classifies a device from what it reports about itself, and returns the class whose preset
`getSplatDeviceBudget` would use. Deliberately coarse: the properties a `Device` exposes separate a
phone from a workstation reliably and two workstations not at all.

It reads luma.gl's `device.info`: `gpuType` (`'discrete'`, `'integrated'`, `'cpu'`), `gpu` (the
family, such as `'apple'` or `'nvidia'`) and the `vendor`, `renderer` and `gpuArchitecture` strings.

- Mobile GPU families (Adreno, Mali, PowerVR and the like) are `'mobile'`.
- Apple GPUs that are not discrete are `'mobile-high'`.
- Other integrated GPUs are `'integrated'`.
- Anything else is `'desktop'`.

Three rules override the reported name:

- **WebGL2 is always `'mobile'`.** It has no storage buffers, so the sorted order is materialized on
  the CPU — a far lower ceiling than any GPU limit implies, on any machine.
- **A software rasterizer is `'mobile'`.** It has no memory of its own to budget and far less
  throughput than any GPU.
- **A small `maxStorageBufferBindingSize` demotes to `'integrated'`.** A device that will not bind a
  large storage buffer cannot hold a large resident scene, whatever it calls itself.

```js
// Show the viewer which budget it is running under.
const deviceClass = getSplatDeviceClass(device);
```

## `getSplatDeviceBudget(device, overrides?)`

Returns the preset for the device, with `overrides` applied field by field. A field an override
leaves `undefined`, explicitly or not, keeps the preset's value. A preset's byte ceiling
is its splat count priced per splat, so a `maxResidentSplats` given without a `maxGpuBytes` brings
the byte ceiling that count implies rather than keeping the preset's:

```js
// Four million splats, and the byte ceiling four million splats needs.
getSplatDeviceBudget(device, {maxResidentSplats: 4_000_000});
// The preset's splat count, capped at 256 MB.
getSplatDeviceBudget(device, {maxGpuBytes: 256 * 1024 * 1024});
```
