# The `splat-layers` branch

This is a reference branch of [visgl/deck.gl](https://github.com/visgl/deck.gl) that adds Gaussian
splat rendering: a new `@deck.gl/splat-layers` package, a compute stage in the deck.gl layer
lifecycle, a reworked `TerrainController`, and a live Swiss terrain example. It is not a pull
request and it does not build on released packages alone: the layer needs luma.gl work from a
companion branch. This file says what is here, what it depends on, and how to run it.

State as of 2026-10-04.

## Summary

- Branch `splat-layers`, merged with upstream deck.gl `master` at `295811df8`
  (`git log --first-parent upstream/master..splat-layers` lists the branch's own commits).
- Companion branch: luma.gl `deck-splat-layers`, merged with upstream luma.gl `master` at
  `5d2150b5d` (`10.0.0-alpha.2`).
  `@deck.gl/splat-layers` calls `@luma.gl/splats` APIs that exist only there (see
  [The luma.gl dependency](#the-luma-gl-dependency)).
- The core changes (compute stage, `TerrainController`, the image-prop and `SimpleMeshLayer`
  texture fixes) build and test against published luma.gl `10.0.0-alpha.2`, the version upstream
  deck.gl `master` uses. Only the splat package, its tests and the example need the luma.gl branch.

## The repositories

| Repo | Branch | Base | Required? |
| --- | --- | --- | --- |
| deck.gl ([BertCh/deck.gl](https://github.com/BertCh/deck.gl/tree/splat-layers)) | `splat-layers` | upstream `master` `295811df8` (lerna `9.4.0-beta.4`) | this repo |
| luma.gl ([BertCh/luma.gl](https://github.com/BertCh/luma.gl/tree/deck-splat-layers)) | `deck-splat-layers` | upstream `master` `5d2150b5d` | **yes**, for `@deck.gl/splat-layers` and the example |
| loaders.gl | `splat-loaders` (not published) | upstream `master` `52d8abee5` | no |

### luma.gl: `deck-splat-layers`

Three commits on `80fc29583`, then a formatting fix (`f9f0c602b`), a merge of upstream `master`
(`89b86c9dc`) and one test fix:

1. `c457f53a0` **feat(splats,gpgpu)**: the APIs `@deck.gl/splat-layers` needs: clip regions and
   planes, antialiasing modes, depth-key modes, fragment kernels, residency budgets, stage timings,
   radix-sort tiling, and shared WGSL exports.
2. `5f0405233` **fix(webgpu)**: an explicit `blend: false` removes blend state. Independent of the
   splat work; deck.gl's depth-picking pass needs it, because its float target is not blendable.
3. `41ab2acda` **fix(splats,gpgpu)**: streaming fixes (no traversal per rejected load, cancelled
   pages recovered, unwanted pages demoted so residency can evict them), view-weighted LOD
   (`requestErrorScale`, `focusDistance`, `distanceFalloff`), float16 depth-key clamping,
   orthographic depth keys, degenerate-covariance opacity, and picking that follows `alphaCutoff`.
4. `66b6185b2` **test(experimental)**: upstream's GPUDataFrame bounded global-sort test is resized,
   because 2,048-key radix tiles no longer need a 3D dispatch at its old row count.

Changed defaults and constants are listed in that branch's `docs/upgrade-guide.md` and
`docs/whats-new.md`. The commits before the merge were made with `--no-verify` because that
checkout had no `node_modules`, or none matching their tree; since the merge the branch passes its own `yarn test-fast` hook (see
[What has been verified](#what-has-been-verified)).

### loaders.gl: `splat-loaders` (related, not required)

`GaussianPLYLoader`, `SOGLoader`, an SPZ codec and encoder, and coordinate-system and
spherical-harmonics helpers for `@loaders.gl/splats`. Upstream #4023 has since added its own SPZ
gzip path; the rebased commit routes it through this branch's parser, which also reads version 1
and decodes version-2 rotations the way the reference packer writes them. Nothing in this repo imports it; until those
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
- `yarn.lock` resolves every `@luma.gl/*` package to `10.0.0-alpha.2`, so one copy of
  `@luma.gl/core` is installed (two copies break deck.gl's `instanceof Device` checks).
  `@luma.gl/splats` is only a peer dependency: luma.gl 10 does not publish it, and the npm 9.4.2
  release would pull in a second `@luma.gl/core`.
- `scripts/luma-source-aliases.mjs`: the `LUMA_SOURCE` aliases, shared by the example's Vite config
  and `vitest.config.ts`.

## The luma.gl dependency

`@deck.gl/splat-layers` imports types, constants, WGSL and renderer props from `@luma.gl/splats`
that no published luma.gl has: `@luma.gl/splats@9.4.2` lacks them, and luma.gl 10 does not publish
`@luma.gl/splats` at all. Against npm luma.gl:

- `yarn build` builds every other package, then fails on `modules/splat-layers`.
- `yarn test-headless` leaves out the `test/modules/splat-layers` browser specs, which cannot
  import. Browser projects share one module graph, so one failed import would fail every file.
- The example refuses to start.

Against the `deck-splat-layers` branch, the tests and the example work: run
`LUMA_SOURCE=<luma.gl checkout> yarn test-headless` to alias `@luma.gl/*` to that checkout in every
vitest project and include the splat specs. The example's `vite.config.mjs` requires
`LUMA_SOURCE=<luma.gl checkout>`, aliases every `@luma.gl` entry point to that checkout's sources
and `@deck.gl/*` to this repo's `modules/*/src`. Its `tsconfig.json` assumes the luma.gl checkout
sits at `../vis.gl-build/luma.gl` beside this repository; adjust the `paths` there if yours
does not.

Once luma.gl publishes `@luma.gl/splats` with these APIs, add it back to the dependencies of
`modules/splat-layers/package.json` and the example, and drop `LUMA_SOURCE`.

## Running it

Prerequisites: Node 22 (`.nvmrc`), git, and Yarn 1 for the root workspace.

```bash
git clone --filter=blob:none -b splat-layers https://github.com/BertCh/deck.gl.git deck.gl
git clone --filter=blob:none -b deck-splat-layers https://github.com/BertCh/luma.gl.git vis.gl-build/luma.gl

cd deck.gl && yarn                                          # root workspace
cd examples/experimental/swiss-splat-terrain && npm install # the example is not a workspace
LUMA_SOURCE=../../../../vis.gl-build/luma.gl npm start      # serves on :8080
```

The luma.gl checkout does not need its own install to be used through `LUMA_SOURCE`. The example
needs WebGPU for the full feature set; on WebGL2 it falls back to a CPU sort and is not pickable.

## What has been verified

On 2026-10-04, after merging upstream `master` into both branches:

| Check | Result |
| --- | --- |
| `yarn lint` | pass |
| `vitest --project node` (whole repo) | pass, with and without `LUMA_SOURCE` |
| `yarn test-headless` (splat specs left out) | 1,046 pass, 1 fail: `DeckGL#mount/unmount` times out in the full run and passes alone |
| `LUMA_SOURCE=<luma.gl branch> yarn test-headless` | 1,063 pass, 5 fail: the React widget-positioning tests, which fail the same way on upstream `master` in a full run and pass alone |
| `test/modules/splat-layers` with `LUMA_SOURCE` | 6 files, 41 tests pass |
| Example `tsc` against the luma.gl branch | 2 errors, both in luma.gl sources (`luma.ts` unused `@ts-expect-error`, `gpu-table-transform.ts` `super` placement) and present before the merge |
| Example `vite build` with `LUMA_SOURCE` | pass; a headless WebGPU frame matches the pre-merge build (RMSE 1.06 / 255) |
| luma.gl branch `yarn build`, `yarn lint`, `yarn test-node` | pass (3,944 tests) |
| luma.gl branch `yarn test-headless` | 2,678 pass; 6 fail, all failing before the merge too (4 splats/gpgpu WebGPU specs on this branch, 1 Transverse Mercator spec upstream, plus a UTM spec that times out only in the full run) |
| `yarn build` | fails at `modules/splat-layers` against npm luma.gl, as described above |
| Render tests, browser tests, `yarn test-website` | not run |

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

Both branches are published, so they take upstream as merges rather than rebases, which keeps the
commit IDs quoted here valid:

```bash
git fetch upstream
git merge upstream/master
```

The work touches `@deck.gl/core` internals (`layer.ts`, `layers-pass.ts`, `deck-renderer.ts`), so
conflicts there are the likely ones; `yarn.lock` conflicts are best resolved by taking upstream's
file and running `yarn`. Merge luma.gl `master` into `deck-splat-layers` the same way, and move both
together: when upstream deck.gl changes its luma.gl version, the luma.gl branch has to match it.
