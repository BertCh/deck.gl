# The `splat-layers` branch

This is a reference branch of [visgl/deck.gl](https://github.com/visgl/deck.gl) that adds Gaussian
splat rendering: a new `@deck.gl/splat-layers` package, a compute stage in the deck.gl layer
lifecycle, a reworked `TerrainController`, and a live Swiss terrain example. It is not a pull
request and it does not build on released packages alone: the layer needs luma.gl work from a
companion branch. This file says what is here, what it depends on, and how to run it.

State as of 2026-09-28.

## Summary

- Branch `splat-layers`, on top of upstream deck.gl `7fa7dc7d9` (`git log 7fa7dc7d9..` lists the
  commits).
- Companion branch: luma.gl `deck-splat-layers`, on top of upstream luma.gl `80fc29583`.
  `@deck.gl/splat-layers` calls `@luma.gl/splats` APIs that exist only there (see
  [The luma.gl dependency](#the-luma-gl-dependency)).
- The core changes (compute stage, `TerrainController`, the image-prop and `SimpleMeshLayer`
  texture fixes) build and test against published luma.gl 9.4.2. Only the splat package and the
  example need the luma.gl branch.

## The repositories

| Repo | Branch | Base | Required? |
| --- | --- | --- | --- |
| deck.gl | `splat-layers` | upstream `master` `7fa7dc7d9` (lerna `9.4.0-beta.4`) | this repo |
| luma.gl | `deck-splat-layers` | upstream `master` `80fc29583` | **yes**, for `@deck.gl/splat-layers` and the example |
| loaders.gl | `splat-loaders` | upstream `46d405d58` | no |

### luma.gl: `deck-splat-layers`

Three commits on `80fc29583`:

1. `c457f53a0` **feat(splats,gpgpu)**: the APIs `@deck.gl/splat-layers` needs: clip regions and
   planes, antialiasing modes, depth-key modes, fragment kernels, residency budgets, stage timings,
   radix-sort tiling, and shared WGSL exports.
2. `5f0405233` **fix(webgpu)**: an explicit `blend: false` removes blend state. Independent of the
   splat work; deck.gl's depth-picking pass needs it, because its float target is not blendable.
3. `41ab2acda` **fix(splats,gpgpu)**: streaming fixes (no traversal per rejected load, cancelled
   pages recovered, unwanted pages demoted so residency can evict them), view-weighted LOD
   (`requestErrorScale`, `focusDistance`, `distanceFalloff`), float16 depth-key clamping,
   orthographic depth keys, degenerate-covariance opacity, and picking that follows `alphaCutoff`.

Changed defaults and constants are listed in that branch's `docs/upgrade-guide.md` and
`docs/whats-new.md`. The commits were made with `--no-verify` because that checkout had no
`node_modules`; its tests were run through deck.gl's vitest instead (see
[What has been verified](#what-has-been-verified)).

### loaders.gl: `splat-loaders` (related, not required)

`GaussianPLYLoader`, `SOGLoader`, an SPZ codec and encoder, and coordinate-system and
spherical-harmonics helpers for `@loaders.gl/splats`. Nothing in this repo imports it; until those
loaders are released, decode captures yourself and pass the columns to `SplatLayer`.

## What this branch changes

**New package: `modules/splat-layers` (`@deck.gl/splat-layers`)**

- `splat-layer.ts`: `SplatLayer`, which draws splats inside deck.gl's render pass and depth buffer,
  with WebGPU picking. It renders into one viewport per frame.
- `splat-clip-extension.ts`: `SplatClipExtension`, soft clipping to planes and regions.
- `splat-device-budgets.ts`: per-device residency budgets, read from luma.gl's `DeviceInfo`.
- `splat-fade-controller.ts`, `splat-motion-detail.ts`, `splat-picking-shader.ts`: internal.

**Changes to `@deck.gl/core`**

- `passes/compute-layers-pass.ts`, `lib/layer.ts`, `lib/layer-extension.ts`,
  `passes/layers-pass.ts`: an optional `compute` hook on layers and extensions, recorded into
  deck's command encoder before each viewport's render pass. It runs only for layers that will be
  drawn, only before draw passes (not picking), and on WebGL each sub-viewport gets its own
  compute and render pass when a layer needs compute.
- `controllers/terrain-controller.ts`: the altitude baseline follows the terrain from the frame
  loop, and an app-set altitude is adopted instead of snapped back.
- `lifecycle/prop-types.ts`: an `image` prop set back to `null` resolves to `null`.

**Changes to `@deck.gl/mesh-layers`**

- `SimpleMeshLayer` unbinds a texture that is removed, instead of drawing with a destroyed one.

**Everything else**

- The example `examples/experimental/swiss-splat-terrain`: terrain splats built live in the browser
  from Mapterhorn elevation and swisstopo orthophoto tiles (Matterhorn, Lauterbrunnen, Aletsch). Its
  [README](examples/experimental/swiss-splat-terrain/README.md) covers the rendering design.
- The RFC `dev-docs/RFCs/proposals/gaussian-splat-rendering-rfc.md`, with a status section saying
  what this branch implements.
- API docs in `docs/api-reference/splat-layers/` and `docs/api-reference/core/`, plus
  `docs/whats-new.md`.
- `yarn.lock` resolves every `@luma.gl/*` package to 9.4.2, so one copy of `@luma.gl/core` is
  installed (`@luma.gl/splats@9.4.2` pins its siblings exactly, and two copies break deck.gl's
  `instanceof Device` checks).

## The luma.gl dependency

`@deck.gl/splat-layers` imports types, constants, WGSL and renderer props from `@luma.gl/splats`
that published `@luma.gl/splats@9.4.2` does not have. Against npm luma.gl:

- `yarn build` builds every other package, then fails on `modules/splat-layers`.
- The `test/modules/splat-layers` specs fail to import.
- The example refuses to start.

Against the `deck-splat-layers` branch, all three work. The example's `vite.config.mjs` requires
`LUMA_SOURCE=<luma.gl checkout>`, aliases every `@luma.gl` entry point to that checkout's sources
and `@deck.gl/*` to this repo's `modules/*/src`. Its `tsconfig.json` assumes the luma.gl checkout
sits at `../vis.gl-build/luma.gl` beside this repository; adjust the `paths` there if yours
does not.

Once luma.gl releases these APIs, raise `@luma.gl/*` in `modules/splat-layers/package.json` and the
root to that release, and drop `LUMA_SOURCE` from the example.

## Running it

Prerequisites: Node 22 (`.nvmrc`), git, and Yarn 1 for the root workspace.

```bash
git clone -b splat-layers <deck.gl remote> deck.gl
git clone -b deck-splat-layers <luma.gl remote> vis.gl-build/luma.gl

cd deck.gl && yarn                                          # root workspace
cd examples/experimental/swiss-splat-terrain && npm ci      # the example is not a workspace
LUMA_SOURCE=../../../../vis.gl-build/luma.gl npm start      # serves on :8080
```

The luma.gl checkout does not need its own install to be used through `LUMA_SOURCE`. The example
needs WebGPU for the full feature set; on WebGL2 it falls back to a CPU sort and is not pickable.

## What has been verified

On 2026-09-28:

| Check | Result |
| --- | --- |
| `yarn lint` | pass |
| `vitest --project node` (whole repo) | pass |
| `vitest --project headless` on `test/modules/core` and `test/modules/mesh-layers` | 72 files, 422 tests pass |
| `test/modules/splat-layers`, with `@luma.gl/*` aliased to the luma.gl branch | 6 files pass |
| `tsc` on `modules/splat-layers` and its tests, against the luma.gl branch | no errors |
| Example `vite build` and `tsc` with `LUMA_SOURCE` | pass |
| luma.gl node specs (`splats`, `gpgpu`, `webgpu` helpers) through deck.gl's vitest | 1,283 tests pass; 5 unrelated gpgpu files cannot load optional packages in that harness |
| `yarn build` | fails at `modules/splat-layers` against npm luma.gl, as described above |
| Render tests, browser tests, `yarn test-website`, WebGPU browser specs in luma.gl | not run |

## Known limits

- **One viewport.** `SplatLayer` shares one traversal and renderer across views, so it draws into
  the first viewport of a frame. Use `layerFilter` to pick the view it belongs to.
- **Picking is WebGPU-only.**

## Known traps

**Headless screenshots lie about pixel density.** Under headless Chrome with WebGPU through
Playwright (`channel: 'chrome'`, `--enable-unsafe-webgpu`), `deviceScaleFactor` does not reach the
canvas. For a supersampled reference image pass deck.gl a number such as `useDevicePixels={4}` and
scale the example's `Detail` setting to match. Turn off `Orbit` before capturing, and give streaming
15 to 20 seconds to settle.

**Headless frame times are noisy.** Orbit frame rates in headless Chrome varied from 13 to 57 fps on
identical code. Don't rank settings on them.

## Keeping up with upstream

```bash
git fetch upstream
git rebase upstream/master
```

The work touches `@deck.gl/core` internals (`layer.ts`, `layers-pass.ts`, `deck-renderer.ts`), so
conflicts there are the likely ones. Rebase luma.gl `deck-splat-layers` onto luma.gl `master` the
same way.
