# The `splat-layers` branch

This repository is a branch of [visgl/deck.gl](https://github.com/visgl/deck.gl) that adds
Gaussian splat rendering. It is not a standalone project, and it does not fully build on its own: the
main layer depends on luma.gl work that has not been released or pushed anywhere yet. This file
explains what is here, what it depends on, and how to get it running on another machine.

State as of 2026-09-28.

## Summary

- Branch `splat-layers`, one commit on top of upstream deck.gl `7fa7dc7d9`.
- `modules/splat-layers` (the new `@deck.gl/splat-layers` package) imports 26 names from
  `@luma.gl/splats`. **10 of them exist only on a local luma.gl branch** that is not on GitHub.
- Without that luma branch, the package typechecks only partly, its tests fail to import, and the
  example quietly runs an older copy of the layer instead of this one.
- The example itself, `examples/experimental/swiss-splat-terrain`, builds and runs against
  published npm packages.

## How this repository was made

The code arrived as a GitHub zip download of deck.gl `master`, with no git history. The zip's file
timestamps (2026-09-15 02:35 EDT) match upstream commit
[`7fa7dc7d9`](https://github.com/visgl/deck.gl/commit/7fa7dc7d9ce7cc6a5f3bd3907e0c8347c7076e34)
("website: Addition of Chicago Summit placeholder website (#10695)") to the minute. Diffing the
working tree against that commit shows exactly the files edited after download, which confirms it as
the base.

The history was fetched as a blobless clone (`--filter=blob:none`), so old file contents download
on demand the first time `git log -p` or `git blame` needs them.

| | |
| --- | --- |
| Branch | `splat-layers` |
| Base | upstream `master` at `7fa7dc7d9` (lerna version `9.4.0-beta.4`) |
| Remote | `upstream` → `https://github.com/visgl/deck.gl.git` (fetch only, no fork yet) |

## The three repositories

The work spans three checkouts on the original machine. **Only the deck.gl one is required, and none
of the three branches has been pushed.** Until they are, the paths below are the only copies.

| Repo | Path (original machine) | Branch | Commit | Required? |
| --- | --- | --- | --- | --- |
| deck.gl | `~/Documents/GitHub/deck.gl-master` | `splat-layers` | `9c1d573b2` on `7fa7dc7d9` | this repo |
| luma.gl | `~/Documents/GitHub/vis.gl-build/luma.gl` | `deck-splat-layers` | `c457f53a0`, `49544a02f` on `80fc29583` | **yes**, for the promoted layer |
| loaders.gl | `~/Documents/GitHub/vis.gl-upstream/loaders.gl` | `splat-loaders` | `255abe921` on `46d405d58` | no |

### luma.gl: `deck-splat-layers`

Based on upstream luma.gl `master` at `80fc29583` ("feat(gpgpu): complete general column-operation
batching (#3279)"). Two commits on top:

1. `c457f53a0` **feat(splats,gpgpu)**: the APIs `@deck.gl/splat-layers` needs, which are clip
   regions and planes, antialiasing modes, depth-key modes, fragment kernels, residency budgets,
   stage timings, radix-sort tiling, and shared WGSL exports. 29 files, about 2,500 lines. This work
   was done 2026-09-16 to 09-20 and sat uncommitted until 09-28.
2. `49544a02f` **chore(build)**: removes the `@deck.gl-community/panels` git dependency from the root
   `package.json` so the workspace installs without fetching deck.gl-community from GitHub. This is
   a local build workaround. Drop it before proposing anything upstream.

Both were committed with `--no-verify`: that checkout's pre-commit hook calls
`./node_modules/pre-commit/hook`, which is missing because the checkout's dependencies are not
installed. No lint or test ran on these commits.

`~/Documents/GitHub/vis.gl-build/luma-master-80fc29583/` holds npm tarballs packed from **clean**
`80fc29583`. They do not contain the new APIs and cannot stand in for the branch.

### loaders.gl: `splat-loaders` (related, not required)

`GaussianPLYLoader`, `SOGLoader`, an SPZ gzip codec and encoder, and coordinate-system and
spherical-harmonics helpers for `@loaders.gl/splats`. Nothing in this repo imports it. The example
decodes PLY with its own `gaussian-ply.ts`, because `@loaders.gl/ply` does not understand Gaussian
splat attributes. This branch is a candidate replacement for that file, not a dependency.

## What this branch changes

**New package: `modules/splat-layers` (`@deck.gl/splat-layers`)**

- `splat-layer.ts`: `SplatLayer`, which draws splats inside deck.gl's render pass, depth buffer and
  picking.
- `splat-clip-extension.ts`: clips splats to planes or regions.
- `splat-picking-shader.ts`: picking support.
- `splat-fade-controller.ts`: opacity ramps that stop splats popping in and out. It uses no luma API,
  so the example shares it in every mode.
- `splat-device-budgets.ts`: per-device limits on splat counts and memory.

**Changes to `@deck.gl/core`**

- `controllers/terrain-controller.ts`: new `TerrainController`.
- `passes/compute-layers-pass.ts`: new pass that records layers' GPU compute work before drawing.
- `lib/layer.ts`, `lib/layer-extension.ts`, `lib/deck-renderer.ts`, `passes/layers-pass.ts`: hooks
  the compute pass needs.

**Everything else**

- The example `examples/experimental/swiss-splat-terrain` (live and baked Swiss terrain splats). Its
  [README](examples/experimental/swiss-splat-terrain/README.md) covers the rendering design in depth.
- The RFC `dev-docs/RFCs/proposals/gaussian-splat-rendering-rfc.md`.
- API docs in `docs/api-reference/splat-layers/`, plus `docs/api-reference/core/terrain-controller.md`.
- Wiring: `tsconfig.json` and `vitest.config.ts` aliases, `docs/table-of-contents.json`,
  `docs/whats-new.md`, `docs/upgrade-guide.md`, and the test indexes.

## The luma.gl dependency, precisely

`modules/splat-layers/src` imports 26 names from `@luma.gl/splats`. Checked against each source:

| Source | Has all 26? |
| --- | --- |
| npm `@luma.gl/splats@9.4.2` (installed here) | no, 10 missing |
| upstream luma.gl `master` (`7a85511a5`, 2026-09-15) | no, same 10 missing |
| luma.gl branch `deck-splat-layers` | **yes** |

The 10 names: `SplatClipRegion`, `SplatClipPlane`, `SplatClipCombineMode`, `GPUSplatAlphaMode`,
`SplatAntialiasingMode`, `SplatDepthKeyMode`, `SplatFragmentKernel`,
`GPU_SPLAT_FRAGMENT_SHARED_SHADER_WGSL`, `GPU_SPLAT_GRAPH_SHARED_WGSL`,
`GPU_SPLAT_QUAD_EXPANSION_SHADER_WGSL`.

Because of this, the example has two layers and picks one at build time in `vite.config.mjs`:

| Command (in the example folder) | Layer used | luma.gl used |
| --- | --- | --- |
| `npm start` | the example's own copy, `splat-layer.ts` | npm packages |
| `npm run start-local` (`DECK_SOURCE=1`) | the example's own copy | npm packages; deck.gl from `modules/*/src` |
| `LUMA_SOURCE=<luma checkout> npm run start-local` | **`modules/splat-layers`** | the checkout's sources |

The example's copy is the layer as it was before it moved into `modules/`. It lacks the compute pass,
deck.gl picking, clipping, and the `antialiasing` / `fragmentKernel` / `depthKeyMode` controls. The
app reads the build-time flag `__PROMOTED_SPLAT_LAYER__` and shows those controls only when they
would do something.

`LUMA_SOURCE` has to point at the `deck-splat-layers` branch. A plain luma.gl checkout fails on the
missing exports.

## Setting it up on a new machine

Prerequisites: Node 22 (`.nvmrc` says `22.22.0`; `22.20.0` works), git, and Yarn 1 for the root
workspace. The example scripts use `node --experimental-strip-types`, which needs Node 22.6 or later.

**1. Make the luma.gl branch reachable.** Do this on the original machine first. It is the step that
cannot be recovered later.

```bash
cd ~/Documents/GitHub/vis.gl-build/luma.gl
git remote add fork git@github.com:<you>/luma.gl.git   # fork visgl/luma.gl on GitHub first
git push -u fork deck-splat-layers
```

Do the same for this repo (`splat-layers`) and, if you want it, loaders.gl (`splat-loaders`).

**2. Clone.**

```bash
git clone --filter=blob:none -b splat-layers git@github.com:<you>/deck.gl.git
git clone --filter=blob:none -b deck-splat-layers git@github.com:<you>/luma.gl.git
cd deck.gl && git remote add upstream https://github.com/visgl/deck.gl.git
```

**3. Install.**

```bash
yarn                                                        # root workspace
cd examples/experimental/swiss-splat-terrain && npm ci      # the example is not a workspace
```

The example has its own `package-lock.json` and `node_modules`. Its `vite.config.mjs` resolves every
`@luma.gl`, `@math.gl` and `@probe.gl` import to that folder's single copy. The luma.gl checkout does
not need its own install to be used through `LUMA_SOURCE`.

**4. Run.**

```bash
npm start                                                   # fallback layer, published packages
LUMA_SOURCE=../../../../luma.gl npm run start-local         # the real layer
npm run bake-terrain                                        # optional: baked Lauterbrunnen scene
```

## What has been verified

Checked on 2026-09-28 on the original machine:

| Check | Result |
| --- | --- |
| Example `vite build` with no env vars | builds; bundle contains the fallback layer only |
| Example `vite build` with `LUMA_SOURCE` at `deck-splat-layers` | builds; bundle contains `SplatClipExtension` and `depthKeyMode` |
| `vitest --project node` on `test/modules/splat-layers` | 11/11 pass (fade controller) |
| `vitest --project headless`: terrain controller, compute layers pass | pass |
| `vitest --project headless`: 3 of 4 splat-layer spec files | **fail to import**: `@luma.gl/splats` does not export `GPU_SPLAT_FRAGMENT_SHARED_SHADER_WGSL` |
| Promoted layer rendering in a browser | **not verified** in this pass |
| `yarn build`, `yarn lint`, full `yarn test` | not run (`yarn` is not on `PATH` on the original machine) |

The headless failures are expected. The root workspace installs luma.gl from npm, and there is no
`LUMA_SOURCE` equivalent in `vitest.config.ts` yet. Those three spec files will fail until luma.gl
releases the APIs or vitest gains a source alias.

## Known traps

**The installed root `node_modules` does not match `yarn.lock`.** `@luma.gl/splats@9.4.2` depends
on exactly `@luma.gl/core@9.4.2`, while deck.gl's packages ask for `^9.4.0`, which the lockfile
resolves to `9.4.0`. `yarn.lock` therefore records two copies of `@luma.gl/core`, but only the
`9.4.0` copy is installed here, so splats currently borrows it and works by accident. A fresh `yarn`
installs both copies. deck.gl checks `instanceof Device`, and those checks fail when two luma cores
are loaded. The example avoids this through its vite aliases; the root workspace and its tests do
not. The clean fix is to move deck.gl's `@luma.gl/*` ranges to `^9.4.2` together, or add a root
`resolutions` entry. Verify either one with a fresh install.

**Headless screenshots lie about pixel density.** The example runs under headless Chrome with WebGPU
through Playwright (`channel: 'chrome'`, `--enable-unsafe-webgpu`). Playwright's
`deviceScaleFactor` does not reach the canvas, so for a supersampled reference image, pass deck.gl a
number such as `useDevicePixels={4}` and scale the `Detail` setting to match. Turn off `Orbit`
before capturing, and give streaming 15 to 20 seconds to settle.

**The visual-quality reference is in another repo.** `~/Documents/GitHub/poopdeck-presentation`
(`src/splat-runtime/`) is a standalone luma.gl splat terrain viewer that this work is measured
against. Its constants record how it was tuned, but not all of them were measured. Its terrain
surfel `THICKNESS = 0.12` was wrong, and this example uses `0.45`. Nothing in either repo links to
the other.

## Keeping up with upstream

```bash
git fetch upstream
git rebase upstream/master          # replays the splat-layers commit onto current deck.gl
```

The work touches `@deck.gl/core` internals (`layer.ts`, `layers-pass.ts`, `deck-renderer.ts`), so
conflicts there are the likely ones. For luma.gl, rebase `deck-splat-layers` onto luma `master`
the same way. Once luma.gl publishes a release containing the 10 names above, bump
`@luma.gl/splats` in `modules/splat-layers/package.json`, remove the fallback copy and the
`LUMA_SOURCE` logic from the example, and this dependency problem goes away.
