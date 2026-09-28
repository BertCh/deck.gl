# RFC: Gaussian Splat Rendering at Scale

* **Author**: Robert Christie
* **Date**: September 2026
* **Status**: **Conceptual Draft**, partly implemented (see Status)

## Status (2026-09-28)

This RFC was written against `@luma.gl/splats@9.4.2` and an earlier state of
`examples/experimental/swiss-splat-terrain`. The `splat-layers` branch has since implemented part of
the plan, so the "Current state, read from the code" section describes the starting point, not the
branch:

- **Done on the branch:** W2.1–W2.3 (Mip-Splatting compensation, a 0.3 px² filter variance, linear
  and float16 depth keys), W3.1 (radix sort tiling), W5.1 (`@deck.gl/splat-layers`), W5.2 (a
  `compute` stage in the deck.gl layer lifecycle), W5.3 (`presentation: false`), W5.4 (WebGPU
  picking) and W5.5 (`SplatClipExtension`), plus a residency budget and view-weighted streaming LOD
  toward W6. The luma.gl side is on the luma.gl `deck-splat-layers` branch.
- **Prototyped and removed:** the baked LOD archive, its baker and verifier, and the PLY captures.
  The example now streams live terrain only, so the archive analysis below (including the settling
  experiment and `bake-splat-scene.ts`) is design history rather than a description of code in the
  repository.
- **Not started:** W0, W1, W4, and the rest of W3, W5 and W6.

The literature figures below were gathered at search level and are marked unverified where they
were not checked against the source.

## Summary

A plan to make deck.gl + luma.gl the best web stack for large-scale Gaussian splat rendering,
grounded in a survey of the 2024–2026 literature, the shipping web engines, and the code currently in
`@luma.gl/splats@9.4.2` and `examples/experimental/swiss-splat-terrain`.

The survey's short version: **the architecture is right and the implementation has two specific,
well-understood holes, while the strategic exposure is interop rather than performance.** The WebGPU
path (compute projection → culling → global radix sort → indirect draw over borrowed storage buffers)
is the same shape the fastest shipping web renderer uses. The WebGL2 path is the only implementation
in the ecosystem that physically permutes source attributes per frame, which is the entire reason it
is three orders of magnitude slower. And the delivery format has been standardized by exactly the
peer set deck.gl competes with — Cesium, Esri and Niantic co-authored `KHR_gaussian_splatting`, which
Khronos ratified in Q2 2026 — while our archive is bespoke.

## Motivation

### Where the field is, late 2026

Three things changed in the last eighteen months and all three matter here.

**1. The delivery layer got a ratified standard.** `KHR_gaussian_splatting` is Complete and Ratified
by Khronos (RC 2026-02-03), authored by Cesium, Esri, Niantic Spatial, Autodesk, Huawei, NVIDIA and
XGRIDS. It is normative about things a renderer can get wrong: `mode` must be POINTS, attributes are
`KHR_gaussian_splatting:ROTATION/SCALE/OPACITY` plus `SH_DEGREE_l_COEF_n` in increasing `(l, m)`
order, colorspace must be declared, the kernel is `"ellipse"`, the Gaussian cutoff is 3σ, default
sorting is `cameraDistance` back-to-front, and `COLOR_0` is the point-cloud fallback. It is
deliberately uncompressed (~196 B/splat at degree 3); compression lives in three competing unratified
child extensions, of which only `KHR_gaussian_splatting_compression_spz_2` (Cesium + Niantic + Esri)
ships. The spec says **nothing** about LOD or tiling, so hierarchy is delegated upward to 3D Tiles,
and every vendor's tree is still proprietary.

**2. City scale became a shipping claim.** Cesium published hierarchical-LOD splat tilesets in April
2026 with a 110M-splat, 3.7 km², 3 cm GSD reference dataset (Microsoft Redmond, 20,169 photos).
PlayCanvas streams a 259M-splat city (517M stored across 10 LOD levels, 20,767 files, 6.1 GB). World
Labs' Spark 2.0 streams 106M-splat scenes — on WebGL2, to phones. Apple announced Flyover moving to
3DGS at WWDC 2026 for iOS 27. Our largest tested scene is 1.7M splats.

**3. Sorting stopped being the interesting problem, twice over.** On the GPU, HiGS (2026, in gsplat
1.6.0) decouples sort granularity from raster granularity with 64×32 px macro-tiles and per-macro-tile
*segmented* 32-bit sorts: the sort drops from 2.5–4.2 ms to under 0.08 ms at 4K, tile–Gaussian pairs
fall 85–92%, and the whole rasterizer runs fp16 at bit-comparable quality (27.68 dB). In the other
direction, the sort is being deleted: StochasticSplats (ICCV 2025) and PlayCanvas' shipped stochastic
alpha mode dither coverage, blend opaquely and write depth. Meanwhile WebSplatter (arXiv 2602.03207)
measured that a correctly built WebGPU renderer is *never* sort-bound — it becomes preprocess-bound
(47% of frame on an MX350) or raster-bound (51.8–62.6% on fast GPUs).

### What no web renderer does

This is the opportunity, and it is unusually wide. Verified across PlayCanvas, Spark, CesiumJS,
three.js r186, Babylon.js 9, antimatter15, mkkellogg and WebSplatter — **not one** of them implements:

* any antialiasing beyond the base 3DGS dilation (no Mip-Splatting opacity compensation, no
  Analytic-Splatting pixel integral, no per-level refiltering);
* per-pixel or per-tile local depth ordering (all do one global sort of splat centers);
* nonlinear projection (all assume a pinhole camera with a linearized Jacobian);
* splats under a map projection, which is deck.gl's native coordinate system;
* per-splat picking through a streaming LOD hierarchy (CesiumJS issue #13326: "no concept of
  picking", no milestone; Esri documents none);
* non-destructive runtime clipping of splats to a region (Esri documents Slice as unsupported for
  splat layers; Cesium has no clipping-plane path);
* independent sort order per view for multi-view/split-screen (only Spark does, and deck.gl ships
  multi-view as a core feature);
* fp16 rasterization, despite WebGPU exposing `shader-f16`;
* a published, comparable benchmark. Cesium publishes **no** frame time for its 110M-splat dataset.
  Spark publishes device budgets, not frame times. Nobody owns this.

### The strategic finding that reorders the plan

**Interleaved deck.gl on a basemap is WebGL2-only, and will be through at least 2027.** No production
web basemap renderer has shipped WebGPU or has a dated commitment. MapLibre's is Phase 5 of a
six-phase plan whose Phases 3–4 are unstarted (zero PRs; the design issue has been comment-free for
two years, and the non-luma WebGPU PoC was closed unmerged on 2026-09-16 with "so far it looks slower"
than WebGL2). Mapbox's only public statement is "There's no timeline for us to support it" (2020).
Google Maps shares a `WebGLRenderingContext` through `WebGLOverlayView`. Esri's SDK 5.1 still
discusses SceneView in terms of WebGL2 `EXT_float_blend`. Overlay mode is the only route to a WebGPU
splat on a basemap, and it gives up the depth buffer — no basemap renderer exposes depth to an
overlaid canvas, so an overlaid splat cannot be occluded by a MapLibre hill.

So the WebGL2 path is not a fallback tier. For the single most common deck.gl configuration it is
**the** path, and it is currently 1030 ms/frame at 1.7M splats.

The good news is that the ceiling is architectural, not fundamental. PlayCanvas published the
apples-to-apples numbers in June 2026 on an M4 Max at 1298×962: a correctly built WebGL2 splat
renderer reaches **137.2 fps at 1M splats, statistically identical to its own WebGPU path at 138.7
fps**, and only falls behind at scale (15.6 vs 85 fps at 30M). WebGL2 is a legitimate primary target
to roughly 3–5M resident splats.

## Current state, read from the code

Verified by reading `@luma.gl/splats@9.4.2`, `@luma.gl/gpgpu`, and the example.

### What is already right

* **The WebGPU pipeline shape.** `GPUSplatGraphRenderer` does projection, culling, a global radix
  depth sort, SH evaluation and an indirect draw as GPU compute over borrowed source buffers, with a
  command graph whose capacity is reserved ahead of the data. This is the same architecture as
  PlayCanvas' `gsplat-unified` and WebSplatter, and it is ahead of Cesium (WASM CPU sort) and
  Babylon (worker CPU sort).
* **`GPUSort`'s reduce-then-scan structure.** WebSplatter's central finding is that decoupled-lookback
  and OneSweep sorts spin-wait between workgroups, and WebGPU guarantees no forward progress — their
  wait-free hierarchical scan is 4.5× faster on an M1, where a spin-wait sorter collapses to 510.8
  ms/frame. PlayCanvas hard-gates its OneSweep path to NVIDIA with subgroup size ≤ 32 for the same
  reason. luma already has the correct structure; it must not be "upgraded" to OneSweep by default.
* **Pass sharing and depth compositing.** Both pass-sharing renderers record into an existing render
  pass, so terrain occludes splats correctly in one deck.gl pass. Cesium's equivalent bug (#12472,
  splats vs a primitive box) has been open since 1.125.
* **The additive exactly-once LOD archive.** Every splat appears in exactly one node, children add
  detail, no parent Gaussian is refitted. PlayCanvas Streamed SOG is replace-refinement, which costs
  them 517M stored splats for a 259M scene — a 2× storage tax, plus re-download of the parent on
  refinement. EvoGS measures additive residual refinement at 2.4× less transmission and 5.5× less
  VRAM than replacement layering. This is a real, defensible advantage.
* **Georeferencing rigor.** Percentile-fitted scene bounds (robust to floater splats), a float64
  model matrix composed before the float32 handoff, baked scene percentiles so a streamed scene does
  not shift as pages arrive. RPC-GS independently validates the doctrine: geodetic is ill-conditioned,
  ECEF is too large for float32, local ENU normalized is correct.
* **Separating geometry from appearance.** SH lives in separate cumulative band files, so culling
  never touches appearance and bands can be evicted independently. Qualcomm's HPG 2026 work names
  this split as the right structure.

### The specific defects

**D1 — WebGL2 permutes attributes.** `SplatRenderer` allocates one `SplatSortReference` object per
splat per resort, sorts the object array, then physically rewrites five instanced attributes
(positions vec3 + scales vec3 + rotations vec4 + colors vec4 + opacities f32 = 60 B/splat) into
renderer-owned buffers, destroying and reallocating them each rebuild (`splat-renderer.js:673-678`).
At 1.7M splats that is ~102 MB/frame of CPU gather plus upload plus 1.7M object allocations, measured
at ~750 ms repack + 80 ms sort. Every other engine keeps splat data resident in textures and uploads
only a 4 B/splat index permutation — antimatter15 (32 B/splat in one `RGBA32UI` texture, one integer
instance attribute, `texelFetch` for everything else), Spark, PlayCanvas, Babylon, CesiumJS. This is
the single largest defect in the stack and it is an implementation choice, not a platform limit.

**D2 — No opacity compensation for the 2D filter.** Both shaders add `kernel2DSize²` to the covariance
diagonal and then do nothing. Mip-Splatting's compensation `ρ = sqrt(det Σ / det(Σ + εI))` — shipped
in gsplat as `rasterize_mode='antialiased'` — is the fix, and the gap it closes is large: at 1/8
resolution 3DGS collapses to 27.45 dB while Mip-Splatting holds 30.66. One-eighth resolution is
precisely what a geospatial camera does when it zooms out. Separately, the default `kernel2DSize` of
0.3 gives **variance** 0.09 px², where 3DGS uses 0.3 px² (σ ≈ 0.548) — sub-pixel splats are
under-filtered by ~3.3×. The `maxScreenSpaceSplatSize` clamp also rescales axes with no compensation.

**D3 — The depth key is 16 bits of NDC depth.** `gpu-splat-graph-shaders.js:289` packs
`clamp(clipCenter.z/clipCenter.w * 0.5 + 0.5)` into 16 bits. NDC depth is hyperbolic, so at
geospatial near/far ratios almost the entire key range is spent near the camera and distant splats
collapse into ties — arbitrary order, popping under rotation. The CPU path meanwhile declares
`SPLAT_DEPTH_KEY_BITS = 24`. The industry has converged on ~16 bits but over better distributions:
Spark uses the f16 bit pattern (31,745 buckets, non-uniform spacing that naturally matches perspective
depth), PlayCanvas uses camera-relative bin weights with `compareBits = clamp(round(log2(N/4)), 10, 20)`.
Note: no published source measures the visual error of *any* key width or distribution for splats, so
this must be measured in-repo, not argued from the literature.

**D4 — `GPUSort` processes one element per thread.** `RADIX_DIGIT_BITS = 4` is right — PlayCanvas
benchmarked 6-bit, 8-bit shared, 8-bit subgroup and OneSweep across M1/M2/M4, NVIDIA and Mali/IMG and
kept 4-bit. But their workgroup covers 2048 keys (256 threads × 8 elements) where luma's covers 256.
At 1.7M splats that is 6,641 workgroups and a 106,256-entry per-pass histogram, versus 831 and 13,296
— and one fewer level of hierarchical scan. Same algorithm, same shader structure, ~8× less scan and
launch overhead. Also: luma spends four 4-bit passes on a 16-bit key, where WebSplatter spends four
8-bit passes on a full 32-bit key. Same pass count, four times the precision.

**D5 — GPU footprint is roughly 2× the state of the art.** Source columns are float32 throughout
(positions 12 + scales 12 + rotations 16 + colors 4 + opacities 4 + rowIndices 4 = 52 B/splat), SH is
**float32** (180 B/splat at degree 3), and the graph adds ~64 B/splat of scratch, of which
`ProjectedSplat` alone is 48 B (`vec4` clip center + two `vec2` axes + `vec4` color). ≈116 B/splat
before SH. HiGS runs the entire rasterizer in fp16 with a Cholesky sum-of-squares form of the inverse
covariance at *zero* measured quality loss. Babylon is 32 B/splat resident.

**D6 — The WebGPU render path may be broken in WebGPU compatibility mode.** Chrome 146 (Feb 2026)
sets `maxStorageBuffersInVertexStage` to 0. luma's render model indexes `projectedRecords` and
`sortedIds` storage buffers from the vertex shader by `instance_index` — the universal web splat
pattern, and exactly what compat mode forbids. Compat mode exists for the populations that need it:
~31% of Chrome-on-Windows users lack D3D11.1+, ~23% of Android users lack Vulkan 1.1. No published web
splat renderer has a compat-safe render path. **This needs verifying against a real compat-mode
device before it is treated as fact, but if it holds, a large population can run our compute and not
our draw.**

**D7 — deck.gl core has no compute stage.** `modules/core` contains no `createCommandEncoder` and no
compute hook in the layer lifecycle. `SplatLayer` therefore opens its own encoder and submits
separately each frame, and because luma 9.4's compiled graph always includes its own presentation
pass, the splats are rasterized twice per frame — once into a canvas pass deck then clears over.

**D8 — No interop, and no splat loaders at all.** `loaders.gl` has zero splat support (no
`@loaders.gl/splat`, no SPZ, no gaussian-PLY) despite shipping `ply`, `potree`, `3d-tiles` and
`tiles`. `splat-gltf` exists but has not been checked against the ratified `KHR_gaussian_splatting`
semantics. The 23 B/splat archive is a good internal format and an interop dead end as a public face.

**D9 — LOD selection is a threshold, not a budget.** `SplatHierarchyManager` fixes its SSE threshold
at construction and answers "is this node good enough?". Under a hard GPU budget the right question is
"where does my next 100K splats buy the most quality?" — PlayCanvas' `GSplatBudgetBalancer` answers it
with a greedy knapsack over `coverage × error-removed-per-splat`, plus three non-obvious anti-flicker
rules (fixed bucket scale rather than a per-frame derived range; stop at the first upgrade that does
not fit rather than skipping it; only ever queue a node's next unbought upgrade). Also, the traversal
runs in full every frame, where Voyager and Atlas both measure **>99% of the selected cut unchanged
between consecutive frames**, and Atlas measures 0.1 dB PSNR cost for updating the cut only every 4
frames.

**D10 — No published numbers.** The example's ~1.0 ms figure is CPU time between `onBeforeRender` and
`onAfterRender`. It attributes nothing to the sort, includes no GPU time, and covers one scene on one
device. Every performance claim in this space is currently self-reported by everyone, which makes an
honest benchmark a landgrab rather than table stakes.

## Plan

Six workstreams. W0 gates everything; W1–W3 are de-risked by shipping implementations elsewhere;
W4–W5 are the strategic and differentiating work; W6 is the research bet.

### W0 — Measurement floor

Nothing below should be merged on an argument. Nobody in this field publishes comparable numbers, so
build the harness first and then own the benchmark.

1. **Per-pass GPU timing.** WebGPU timestamp queries plumbed through the command graph, exposed on
   `graphStats`. luma has a graph autotuner with no real GPU times feeding it. Report projection /
   sort / raster as separate lines, which is the split WebSplatter publishes and we cannot currently
   reproduce for our own renderer.
2. **Quality harness.** PSNR/SSIM/LPIPS against held-out views, rendered *through `SplatLayer`* at a
   fixed width. Scenes: MipNeRF360 `bicycle` and `garden` as the fast loop (both are published by
   GoDe, MGS and WebSplatter, so our numbers land on existing axes), plus one Hierarchical-3DGS
   `SmallCity` chunk for scale.
3. **Device matrix.** M-series Mac, NVIDIA discrete, Intel iGPU, iPhone, mid-range Android — the
   spread is three orders of magnitude (wgpu_sort: 317 µs for 1M keys on an A5000, 38.7 ms for 1M on
   Intel HD 4600), so single-device numbers are close to meaningless.
4. **Publish** splat count × resolution × ms/frame × GPU MB × device, for both backends. Cesium
   publishes nothing for 110M splats; Spark publishes budgets, not frame times; PlayCanvas publishes
   fps on one laptop. This is unclaimed ground and it makes every later claim checkable.

### W1 — Rewrite the WebGL2 path (highest impact)

Target: 1030 ms → ≤30 ms at 1.7M splats, and parity with PlayCanvas' WebGL2 numbers at 1M.

1. **Texture-resident splat data, index-only per-frame upload.** Splat columns live permanently in
   textures; the vertex shader takes exactly one integer instance attribute (the sorted index) via
   `vertexAttribIPointer` and `texelFetch`es the rest. Per-frame data movement drops from ~60 B/splat
   to 4 B/splat (15×), the gather loop disappears, and the `SplatSortReference` object array
   disappears with it. Precompute the 2D covariance terms into the texture as packed halves
   (antimatter15 stores 6 covariance terms as three `packHalf2x16` words) so the per-frame quaternion
   →matrix work leaves the vertex shader too.
2. **Index-only worker sort.** A single-pass counting sort on f16 bit-pattern buckets (Spark: 31,745
   buckets, with f16 infinity `0x7c00` doubling as the cull sentinel) or PlayCanvas' adaptive
   `compareBits`. Reproduced measurements of all four production sorters on an M3 Pro: 4.7–5.8 ms at
   1M, 22.6–30.4 ms at 5M, 100–134 ms at 20M.
3. **Compute depth keys on the GPU, read back packed RGBA8.** Spark is the only engine that does
   this; it roughly doubles effective sort throughput (170–220 → ~400 keys/ms) because the CPU only
   histograms a readback instead of transforming positions. It costs one frame of latency; bound the
   resulting error during fast rotation and report it.
4. **Resort throttle.** `|dot(prevViewProj.row2, viewProj.row2) - 1| < 0.01` (antimatter15) removes
   the resort entirely on pure translation. Five lines.
5. **SH in the vertex shader.** WebGL2 can `texelFetch` in the vertex stage, so the CPU SH pass is
   unnecessary. This also removes the "raising SH degree rebuilds the scene" limitation on that path.
6. **Render the previous order while the next is in flight** — the standard pattern in every engine
   surveyed; only CesiumJS parallelizes across workers (`hardwareConcurrency - 1`), which is worth
   copying above ~5M where the single worker thread becomes the binding constraint.

Note an interaction with the baker: Morton ordering within chunks exists to make the CPU gather
cache-coherent (measured ~745 → ~265 ms). When the gather disappears, so does most of Morton's value
at runtime — which frees the ordering to be chosen for compressibility instead (see W6.5).

### W2 — Quality: be the only web stack with antialiasing

All of this is shader math. No retraining, no format change, no extra buffers.

1. **Mip-Splatting opacity compensation.** `ρ = sqrt((c00ᵒ·c11ᵒ − c01²) / (c00·c11 − c01²))` multiplied
   into alpha, where `ᵒ` is pre-dilation. ~5 instructions in both the WGSL and GLSL vertex shaders.
   Apply the same compensation to the `maxScreenSpaceSplatSize` clamp, which currently distorts the
   covariance silently.
2. **Fix the filter width.** `kernel2DSize` should default so the added *variance* is ~0.3 px² to
   match the reference rasterizer, i.e. σ ≈ 0.548, not 0.3. Consider renaming the prop to name the
   variance, since the current name invites the confusion.
3. **Depth key distribution.** Replace NDC depth with either linear view-space depth normalized over
   the current visible range, or the f16 bit pattern. Unify the WebGPU (16-bit) and CPU (24-bit) key
   widths behind one constant. Then *measure* the artifact rate as a function of key width on a scene
   with geospatial depth spread — this number does not exist anywhere in the literature and is the
   prerequisite for every approximate-sort decision later.
4. **Opacity-derived support radius.** `r = sqrt(2 ln(255·σ·α))` instead of a fixed 3σ, which is
   also what `KHR_gaussian_splatting` mandates as a cutoff. WebSplatter measures 15% of frame time
   from dynamic radius sizing alone — the largest single item in their ablation — and Speedy-Splat's
   SnugBox/AccuTile bounds are the tighter version of the same idea.
5. **Analytic-Splatting as an opt-in fragment path.** Replace `exp(-0.5·dot(g,g))` with the product of
   two logistic-CDF differences, `S(x) = 1/(1 + exp(-1.6x - 0.07x³))`, integrating the Gaussian over
   the pixel footprint. +0.39 dB over Mip-Splatting on multi-scale MipNeRF360 for ~10% frame time. It
   needs σ₁, σ₂ and the rotated pixel offset as varyings — three extra floats — and the eigenvalues
   are already computed in the vertex shader. Fold device pixel ratio into the window width correctly;
   the constants were fit for unit-width windows.
6. **Per-level refiltering (LODGE).** `Σ → Σ + s(d/f)·I` with the same `sqrt(|Σ|/|Σ + s(d/f)I|)`
   normalization, where the per-level part is **one scalar** — 4 B per manifest node, 0 B per splat.
   This is the LOD-side antialiasing nobody on the web has. The related training-free result SA-GS
   measures +12.9 dB at 1/8 resolution for a test-time-only change; how much of that survives without
   LODGE's 1,000 fine-tuning steps per level is the open question W6 must answer.
7. **LOD transition fade.** Synthesize CLoD-GS' continuous fade from data already in the manifest:
   derive each node's fade band from its `geometricError` versus the layer's
   `maximumScreenSpaceError`. Zero extra bytes, and it is the one popping mitigation an exactly-once
   additive tree can use, since there is no refitted parent to interpolate against.

### W3 — GPU efficiency

1. **`GPUSort`: 8 elements per thread, keep 4-bit digits.** Lowest-risk, highest-confidence change in
   the plan (D4).
2. **Audit `GPUSort` for inter-workgroup spin-waiting.** This is a *correctness* question on Apple
   Silicon and mobile, not a performance one, and it was never checked. If any lookback exists, remove
   it; WebSplatter's 4.5× M1 gain came entirely from removing spin-waits. Add explicit capability
   gating (`supportsCompute`, subgroup support and size, forward-progress allowlist) so a fast path
   can never be selected where it hangs.
3. **Widen keys to 32 bits, or spend the same passes better.** Four 8-bit passes give a full 32-bit
   key for the same dispatch count we currently spend on 16 bits. Measure against W2.3's artifact data.
4. **fp16 everywhere it is safe.** `ProjectedSplat` from 48 B to ~24 B (packed-half axes, packed
   color, depth instead of a full clip vector), and the HiGS Cholesky sum-of-squares form of the
   inverse covariance, which is what makes fp16 numerically safe — they measure 27.68 dB, identical to
   fp32. Also evaluate *not* storing projected records at all and reprojecting in the vertex shader,
   which is what PlayCanvas and Spark do: it trades a 48 B/splat VRAM round trip for cheap
   recomputation, and at 10M splats that buffer alone is 480 MB.
5. **SH storage.** float32 SH is 180 B/splat at degree 3 and dominates GPU memory. Three options, in
   increasing ambition: int8 or f16 buffers (4×/2× for near-free); a k-means SH palette plus a 16-bit
   label (SOG v2 — at 1.7M splats SH1 drops from ~15 MB to a centroid atlas plus 2 B/splat, ~4×); or
   ASTC/UASTC block-compressed SH textures (Qualcomm HPG 2026: BC7-dc + BC1-rest at **9 B/primitive
   for 37.9–40.1 dB** against a 196 B float reference, with O(1) random access and a hardware
   decoder). The texture path has a second benefit that matters disproportionately here: a compressed
   texture is *sampled*, not fetched from a storage buffer, so **SH evaluation works identically on
   WebGL2 and in WebGPU compatibility mode.** BCn is not exposed on the open web, so the practical
   split is ASTC where available and UASTC transcode elsewhere.
6. **A compat-safe render path** for D6 — projected records in a texture, or vertex-buffer stepping
   instead of `instance_index` storage indexing — gated on confirming the limit on a real device.

### W4 — Interop: stop being a bespoke format

This is the highest-leverage non-performance work, and it is mostly loader work rather than research.

1. **`KHR_gaussian_splatting` conformance.** Bring `splat-gltf` to the ratified semantics: attribute
   names and `(l, m)` ordering, log-space scale, declared colorspace, the 3σ cutoff, `cameraDistance`
   sorting, `COLOR_0` fallback. The contributor list is the strategic fact — Cesium, Esri and Niantic
   are deck.gl's exact peer set in geospatial and they have already agreed the payload.
2. **`@loaders.gl/splat`.** SPZ v4 reader first (it is what Scaniverse, Postshot, Spark and the KHR
   compression extension all center on: 32-byte plaintext header, TOC, six parallel per-attribute
   ZSTD streams — a direct fit for our per-attribute column layout, so a worker pool can decode six
   ways in parallel straight into `makeGPUSplatData` with no interleaved repack). Then gaussian-PLY,
   promoted out of the example. Then SOG v2, which is read by PlayCanvas, Babylon, Spark and
   SuperSplat. Two correctness traps to handle explicitly: SPZ's 16 coordinate conventions, and the
   Wigner D-matrix SH rotation required when converting between them — unavoidable for a stack that
   reprojects into ENU or ECEF.
3. **`KHR_gaussian_splatting_compression_spz_2`**, with its version caveat as a known risk: it pins
   SPZ **v2** (8-bit quaternion with derived w, single-stream gzip, 10M-point cap), not v4.
4. **3D Tiles splat tilesets.** `SplatHierarchyManager`'s SSE traversal is already isomorphic to 3D
   Tiles geometric-error traversal, and 3D Tiles `refine: ADD` is exactly our additive semantics — so
   this is an adapter over `@loaders.gl/tiles`, not a rewrite. **Blocker to resolve first:** whether
   Cesium's splat tilesets refine by ADD or REPLACE, and whether parent tiles hold refitted, decimated
   or independently retrained Gaussians, is unresolved — four of seven researchers flagged it, and
   `GaussianSplat3DTileContent.js` reportedly contains no refine check at all. Read a real tileset
   before designing the adapter.
5. **Keep the archive, document the mapping, publish the comparison.** 23 B/splat with SH beats SPZ's
   ~64 and sits near SOG's ~6–7 per Gaussian; the flat quantized layout is a *defensible* choice
   against entropy coding, which reaches >100× (HAC++: 676 MB → 3.1 MB at *better* PSNR) but needs
   ~31 s to decode and forbids random access, range requests and partial residency — ProGS measures
   12.84 s just to decode level 0. Say so, with numbers, on the 3DGS.zip axis (size vs PSNR), where we
   currently report bytes and no quality at all.

### W5 — The geospatial moat

Each of these is something no competitor has, and each is a normal thing a GIS user expects.

1. **A first-class module.** Promote `SplatLayer` out of `examples/experimental` into a supported
   module with TSDoc, docs, and render tests on both backends.
2. **A compute stage in the deck.gl layer lifecycle** (D7). Layers need to record compute work into
   deck's own encoder before the render pass opens. This deserves its own RFC — it is not
   splat-specific (aggregation layers and any GPU-driven layer want it) — and it removes a per-frame
   submit plus the double rasterization.
3. **`presentation: false` on the luma graph renderer**, so projection and sorting can be encoded
   without the mandatory presentation node. Pairs with (2).
4. **Picking.** `SplatPicker` and `GPUSplatGraphPicker` already exist in luma; the gap is wiring them
   into deck's picking pass, which is a plumbing problem, not a research one. Resolve the genuine
   ambiguity explicitly — a large near-transparent splat's 3σ border can sit in front of a small
   opaque one — with a transmittance-threshold pick rather than first-hit, and resolve the hit against
   whichever LOD level is resident. Cesium has no splat picking and no milestone for it; Esri has
   none. For a framework whose entire proposition is interactive layers, this is unclaimed ground.
5. **`SplatClipExtension`.** In the existing projection/culling compute pass, compute each splat's
   signed distance to a clip plane or polygon prism *in units of its own projected σ* and multiply
   opacity by the resulting partial-coverage factor. That gives RaRa Clipper's soft boundary for one
   extra term and no ray tracer. Center-based clipping is visibly wrong on volumetric primitives, and
   masking to a parcel, corridor or slice plane is routine GIS work that Esri documents as unsupported.
6. **Globe and projected CRS.** Per-tile RTC ENU anchors in float64 reduced to float32 locals. Then
   the harder, genuinely novel piece: under a map projection the covariance must be projected through
   the projection's local Jacobian (latitude-dependent for Web Mercator), not merely have its mean
   transformed. RPC-GS derives exactly this kind of Jacobian chain for satellite RPC cameras; no web
   renderer has applied it to a map projection. Accept a proper source CRS plus a 7-parameter
   similarity transform applied consistently to means, scales and rotations — Cesium's answer is a
   manual "Adjust Tileset Location" button that users report cannot handle transverse-Mercator
   datasets with scale factors.
7. **Orthographic / top-down.** The ortho branch of the covariance projection, plus a sort key that
   switches from radial distance to distance along the view direction. `KHR_gaussian_splatting`
   reserves a `projection` field defaulting to `perspective` and nobody implements the other branch —
   yet top-down is the default GIS view, and Tortho-Gaussian shows an orthographic splat render *is*
   an orthophoto with occlusion falling out of the compositing.
8. **Per-view sort order** for multi-view and split-screen. A single global order is wrong for two
   cameras; only Spark supports this.
9. **Device-class budget presets.** Spark ships 2.5M desktop / 1.5M iOS / 1M Android / 750K Vision Pro
   / 500K Quest. We have a byte budget and no presets, which is the difference between "works on my
   4090" and "works".
10. **Stochastic alpha mode.** Dithered coverage (blue noise), opaque blending, depth writes — no sort
    at all. PlayCanvas ships it and keeps the sorted path for picking. This is worth more to deck.gl
    than to anyone else, because it makes splats behave like opaque geometry inside deck's existing
    render pass: correct occlusion against terrain with no ordering negotiation, no separate
    presentation pass, and free participation in depth prepass, SSAO and DOF. It is also the escape
    hatch above ~5M splats on WebGL2. Cost is noise, resolved by TAA or jittered accumulation, and
    **the quality cost at 1 SPP on web hardware is unmeasured anywhere** — measure it before shipping
    it as a default.

### W6 — Streaming, LOD and the research bet

1. **Baker importance ordering.** Replace `getSplatImportance() = opacity · cbrt(sx·sy·sz)` with
   PRoGS' accumulated rendered contribution `B_i = Σ_views Σ_pixels T_i·α_i`, keeping the top ~20
   contributors per pixel. PRoGS beats exactly our heuristic family on PSNR, SSIM and LPIPS at every
   prefix fraction, and MGS independently shows ordering dominates: opacity-descending beats
   SH-energy-descending by **4.6 dB at the same 10% budget**. This is an offline change with zero
   runtime and zero format cost, and the existing WebGPU renderer can rasterize the training views and
   accumulate per-splat contribution with an atomic add. Caveat: PRoGS publishes figures, not tables,
   so the dB number has to come from our own harness.
2. **Budget knapsack traversal**, with PlayCanvas' anti-flicker rules copied as *reasoning*, not code
   (D9). The traversal becomes "spend the next 100K splats where they remove most error".
3. **Incremental frontier.** Seed from the previous cut and re-descend only subtrees whose nodes
   crossed the threshold. Justified by >99% frame-to-frame stability (Voyager, Atlas), and worth
   amortizing over ~4 frames at a measured 0.1 dB cost. This is the remaining CPU cost on the WebGPU
   path.
4. **Progressive ordering inside chunks**, so a half-arrived chunk is a coarse whole rather than a
   spatial fragment. Today only `.RAD` and `.splat4d` have this property, and both special-case a
   first chunk rather than holding the guarantee throughout.
5. **Similarity ordering for compressibility.** Sorting primitives by colour similarity before block
   compression is worth **+7 to +14 dB at identical byte cost**, and it is free for splats because
   rendering already indirects through an index buffer. This is the largest unexploited win in the
   entire survey. It composes with — or partly replaces — Morton ordering within chunks, especially
   once W1 removes the CPU gather that Morton exists to serve.
6. **Byte ranges in the manifest** so one range request bootstraps the whole fetch plan (`.splat4d`),
   and **per-node SH deferral** so a bandwidth cap degrades shading rather than dropping splats and
   eating silhouettes. Per-batch SH degree clamping already exists; the missing piece is fetching core
   geometry for a coarse pass and deferring bands per node.
7. **The research bet: macro-tile segmented sorting (HiGS).** Bin into 64×32 px macro-tiles and run
   per-macro-tile *segmented* 32-bit sorts instead of one global sort. Native numbers: sort 2.5–4.2 ms
   → <0.08 ms at 4K, tile–Gaussian pairs −85–92%, frame time growing only 1.6× from 1080p to 4K versus
   2.8× for gsplat. WebGPU has workgroup shared memory, 32-bit atomics and f16, so the scheme, the key
   packing and the inline visibility masks all map to WGSL. GS-TG reaches the same macro-tile shape
   from a different direction, which raises confidence. **No web renderer does this.** Critically,
   keep hardware quad instancing — WebSplatter explicitly rejected a tile-based compute rasterizer on
   memory-traffic grounds, and HiGS' win is in sort granularity, not in replacing the rasterizer. Two
   designs converging plus a clean portability story makes this the right ambitious bet, but sequence
   it after W0 shows whether we are sort-bound, preprocess-bound or raster-bound — WebSplatter says we
   will not be sort-bound, which is an argument for doing W2/W3 first.
8. **Duplex-GS as a middle option.** Sort *cells* exactly (thousands of keys) and use weighted-sum
   blending within a cell (no per-splat sort). The cell proxies map almost one-to-one onto the octree
   nodes the baker already produces, and sorting a few thousand nodes on the CPU is trivial — which
   makes this specifically attractive for WebGL2. Reported 52.2–86.9% of radix-sort overhead removed,
   but the source is search-level and the numbers must be re-verified before they enter a schedule.

## Non-goals

**Triangle splatting and opaque primitives.** Track, do not build. The family bifurcated in a way that
destroys the one argument that would matter: every variant competitive with 3DGS on quality (2DTS
28.18 dB, Elastic TS 27.33, UTrice 28.70) still alpha-blends front-to-back with an explicit depth
sort, so the sort comes back and nothing is won. The one variant that genuinely removes the sort,
Triangle Splatting+, pays 2.00 dB on Mip-NeRF360 and 2.23 dB on Tanks & Temples, and forcing the
original method opaque post-hoc collapses it by ~6 dB — so sort-free is a separate training objective,
not a switch. There is no importer from a trained 3DGS scene (initialization is Delaunay
tetrahedralization of SfM points; post-hoc 3DGS-to-mesh costs 3.1–11.9 dB), no delivery format
(`KHR_gaussian_splatting` defines one kernel, `"ellipse"`, and its extensibility hook is unfilled),
no LOD scheme, no SH evaluation in any web viewer, and no prefilter for subpixel opaque triangles —
the official project recommends 4× supersampling. Against that: a ratified Gaussian format authored by
Cesium, Esri and Niantic, versus two toy triangle viewers (9 stars and 1 star).

**OneSweep as the default sort.** Hangs or misbehaves without forward-progress guarantees. Opt-in
second backend at most.

**Entropy-coded compression.** HAC++ is >100× at better PSNR and structurally incompatible with GPU
rendering: no random access, no range requests, no partial residency, ~31 s decode. GPU rANS exists
(dietgpu, Recoil) with no WebGPU implementation and no splat integration.

**Prefix-aware or per-level training** (Matryoshka GS, GoDe, LODGE's fine-tuning). All need
from-scratch or long fine-tuning runs; a baker that ingests a finished `.ply` structurally cannot do
it. We win on ordering, refiltering and delivery instead — and should say so rather than pretend
otherwise.

**Refitted parent Gaussians — deferred, not rejected.** H3DGS' own ablation says merging only pays at
coarse granularity (+0.6 to +2.6 dB at τ=15 px, but only +0.04 dB at τ=3 px) and needs post-merge
optimization to be worth it, which a baker cannot do. The manifest already carries
`refinement: 'add' | 'replace'`, so a merged interior tier can be added later without a format break.

**A tile-based compute rasterizer** replacing hardware quads. See W6.7.

## The experiment that settles the archive design

The subset-versus-refit question is genuinely unresolved in the literature — no paper isolates one
against the other at a matched primitive count, and the closest proxies point in opposite directions
(GoDe's 100K subset at 25.38 dB versus FLoD's 443K refit level at 24.11 dB on MipNeRF360, against
H3DGS' own +0.6–2.6 dB for merging at coarse granularity). So run it.

Scene: one H3DGS `SmallCity` chunk (public, 5.64M leaves at τ2), with MipNeRF360 `bicycle` as the fast
inner loop. Budgets pinned at exactly 100K, 500K and 2M rendered splats by fixing
`SplatResidencyManager`'s splat budget rather than by camera distance. Four arms, all through
`bake-splat-scene.ts`:

* **(a)** today's prefix, ordered by `opacity · cbrt(volume)`
* **(a′)** the same prefix ordered by PRoGS accumulated `Σ T_i·α_i`, top-20 contributors per pixel
* **(b)** arm (a′) plus per-splat Mip-Splatting `filter_3D` (float16, +2 B/splat) and per-node LODGE
  inflation with the shipped compensation — **no retraining**
* **(c)** an H3DGS-style merged-parent tier built in the baker (`w = o·sqrt(|Σ|)`, weighted mean and
  covariance merge), published as `refinement: 'replace'` interior nodes — **no retraining**

Metric: PSNR/SSIM/LPIPS on held-out test views through `SplatLayer` at 1600 px, plus ms/frame and GPU
MB. **Pass criteria:** (b) must recover ≥1.5 dB of the (c)−(a) gap at 100K and ≥50% at 500K, at
≤ +2 B/splat and ≤ +0.15 ms/frame. If (b) recovers <0.5 dB, refit parents are required and the format
needs a `replace` interior tier. If (a′) alone closes most of the gap, ordering was the whole problem
and neither refiltering nor refitting is urgent.

## Open questions and unverified claims

Load-bearing things this plan does **not** know, listed so nothing silently rests on them:

* **Whether `GPUSort` spin-waits between workgroups.** Unchecked. Determines whether the 1.0 ms figure
  holds on Apple Silicon and mobile at all.
* **luma's own sort cost.** Never measured. The ~1.0 ms is end-to-end CPU and attributes nothing to
  the sort; the D4 workgroup arithmetic is arithmetic, not a benchmark.
* **The WebGPU-capable share of real users.** ~85–87% is page-weighted global traffic, not
  splat-viewer traffic, and Firefox's default-off state is the largest unknown component. This number
  is load-bearing for how much W1 is worth, and it is not established.
* **Whether compat mode actually breaks our render path** (D6). Needs a real device.
* **Cesium's splat refine semantics** (ADD vs REPLACE, and what parent tiles contain). Blocks the 3D
  Tiles adapter design.
* **Any frame-time number for Cesium at 110M splats.** Three researchers looked; none exists. So
  head-to-head claims are unsupportable in *both* directions, including ours.
* **The visual error of every approximate-sort knob.** Not bucket count, not stale order versus
  angular velocity, not per-chunk versus per-splat ordering. Every shipping threshold in the industry
  — the 0.01 dot-product gate, the 0.001 camera epsilon, 16-bit keys, Cesium's 0.5°/1.0 m/3-frame
  resort gate — is asserted without published error data. W2.3 must produce this before W6.8 or W5.10
  is chosen.
* **Splat overdraw and fill rate on integrated and mobile GPUs.** No published measurement exists
  anywhere, and WebSplatter says raster is 51.8–62.6% of frame time on fast GPUs, so this is likely
  the bottleneck after W1–W3.
* **Whether ASTC/UASTC is viable for SH in a browser.** Qualcomm's numbers are BC1/BC7, which the open
  web does not expose.
* **StopThePop's true overhead** (sources give both "+4%" and "1.6× faster at 50% memory"), and the
  numbers for Neo, Duplex-GS, PD-4DGS, OMG, WSR/LC-WSR, EVER, 3DGRT and Speedy-Splat — all from
  search-level summaries, all to be re-verified before entering a schedule. Neo's are
  ASIC-versus-GPU and do not transfer to WGSL at all.
* **Apple Flyover moving to 3DGS** is the strongest "everyone is moving to splats" signal in the
  survey and is search-level only. Confirm from Apple before citing it.
* **Whether deck.gl/luma.gl appear anywhere in the public 2026 splat landscape.** Absence of evidence,
  not evidence of absence — though the negative that no third-party deck.gl splat layer exists was
  verified by repository search.

## Suggested sequencing

| Order | Work | Why now |
| --- | --- | --- |
| 1 | W0 measurement floor | Gates every claim below; the benchmark itself is unclaimed ground |
| 2 | W1 WebGL2 rewrite | Largest absolute win, de-risked by five shipping implementations, and it is the *primary* path for interleaved basemap deployments |
| 3 | W2.1–W2.4 quality + depth key | Hours of shader work; nobody on the web has any of it; W2.3 unblocks later sort decisions |
| 4 | W3.1–W3.2 sort tiling + spin-wait audit | Small, high-confidence, and one half is a latent correctness bug |
| 5 | W4.1–W4.2 KHR + SPZ read path | The ecosystem standardized; the bespoke archive is now a liability as a public face |
| 6 | W5.1–W5.4 module + compute stage + picking | Unblocks everything else in deck, and picking is an unclaimed differentiator |
| 7 | W6.1–W6.3 ordering, budget, incremental traversal | Cheap, offline or CPU-side, large measured effects |
| 8 | W3.4–W3.5, W5.5–W5.10, W6.5–W6.7 | Scale, moat, and the macro-tile bet — sequence by what W0 says actually dominates the frame |
