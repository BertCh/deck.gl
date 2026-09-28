# @deck.gl/splat-layers

deck.gl layers that render 3D Gaussian splat scenes.

See the [documentation](https://deck.gl/docs/api-reference/splat-layers/overview) for details.

## luma.gl requirement

This package calls `@luma.gl/splats` APIs that are not in any published luma.gl release yet: clip
regions, antialiasing, depth-key and fragment-kernel modes, residency budgets and shared WGSL
sources, among others. Until they are released it builds and runs only against the luma.gl
`deck-splat-layers` branch, for example through the `LUMA_SOURCE` alias used by
`examples/experimental/swiss-splat-terrain`. The `@luma.gl/splats` version range in `package.json`
names the release line these APIs are intended for, not one that already contains them.
