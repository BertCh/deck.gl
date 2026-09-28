// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {defineConfig} from 'vite';
import {createRequire} from 'module';
import {existsSync, readdirSync, readFileSync} from 'fs';
import {dirname, join} from 'path';
import {fileURLToPath} from 'url';

const exampleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(exampleDir, '..', '..', '..');

/**
 * Redirects bare `@scope/name` imports to a single physical copy without rewriting
 * package export subpaths such as `@luma.gl/experimental/gpu-tables`.
 */
function pinScope(scope, packagesDir) {
  return {
    find: new RegExp(`^${scope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/]+)$`),
    replacement: join(packagesDir, `${scope}/$1`)
  };
}

/**
 * Aliases every `@luma.gl` entry point to a luma.gl checkout's TypeScript sources.
 *
 * The aliases are derived from each module's own `exports` map rather than guessed, because the
 * subpaths are not uniform - `@luma.gl/gpgpu/gpu-core` lives at `src/gpu-core` but
 * `@luma.gl/gpgpu/cpu` lives at `src/operations/cpu`. Reading the map keeps this correct as luma
 * adds entry points, and an unmapped subpath fails loudly instead of resolving to the wrong file.
 */
function aliasLumaSources(lumaRoot) {
  const modulesDir = join(lumaRoot, 'modules');
  if (!existsSync(modulesDir)) {
    throw new Error(`LUMA_SOURCE is set but ${modulesDir} does not exist.`);
  }

  const aliases = [];
  for (const moduleName of readdirSync(modulesDir)) {
    const manifestPath = join(modulesDir, moduleName, 'package.json');
    if (!existsSync(manifestPath)) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      const distPath = typeof target === 'string' ? target : target.import;
      if (!distPath) {
        continue;
      }
      const sourcePath = distPath
        .replace(/^\.\/dist\//, './src/')
        .replace(/\/index\.js$/, '')
        .replace(/\.js$/, '');
      aliases.push({
        find: `${manifest.name}${subpath.replace(/^\./, '')}`,
        replacement: join(modulesDir, moduleName, sourcePath.replace(/^\.\//, ''))
      });
    }
  }
  // Longest first, so `@luma.gl/gpgpu/gpu-core` is not swallowed by `@luma.gl/gpgpu`.
  return aliases.sort((a, b) => b.find.length - a.find.length);
}

/**
 * Resolves a source tree's bare dependencies from this folder's `node_modules`.
 *
 * Source mode compiles files that live outside this example - `deck.gl/modules/*` and a luma.gl
 * checkout - and Node resolves their imports by walking up from *their* directory, which never
 * reaches this folder. Without this, importing `TerrainLayer` fails on `a5-js`: the package is
 * installed here, but `modules/geo-layers/src` cannot see it.
 *
 * Only bare specifiers are handled, and only after the aliases above have had their say, so this
 * never overrides an explicit mapping.
 */
function resolveFromExample(packagesDir) {
  const requireFromExample = createRequire(join(packagesDir, 'noop.js'));
  return {
    name: 'resolve-from-example',
    enforce: 'post',
    resolveId(source) {
      if (source.startsWith('.') || source.startsWith('/') || source.startsWith('\0')) {
        return null;
      }
      try {
        return requireFromExample.resolve(source);
      } catch {
        return null;
      }
    }
  };
}

const exampleModules = join(exampleDir, 'node_modules');

// `@luma.gl/splats` pins exact sibling versions, and deck.gl performs `instanceof Device`
// checks, so every `@luma.gl` and `@math.gl` import must resolve to one physical copy.
const aliases = [
  pinScope('@luma.gl', exampleModules),
  pinScope('@math.gl', exampleModules),
  pinScope('@probe.gl', exampleModules)
];

// LUMA_SOURCE=<path> runs the example against a luma.gl checkout's sources. It implies
// DECK_SOURCE, because the splat layer in `modules/splat-layers` and the splat renderer in
// `@luma.gl/splats` have to come from the same side of any unreleased API change.
const lumaSource = process.env.LUMA_SOURCE;
if (lumaSource) {
  aliases.unshift(...aliasLumaSources(lumaSource));
}

// DECK_SOURCE=1 runs the example against this repo's TypeScript sources instead of the
// published deck.gl packages. Without LUMA_SOURCE, luma stays pinned above so deck.gl and the
// splat renderer continue to share a single Device implementation.
if (process.env.DECK_SOURCE || lumaSource) {
  aliases.unshift({
    find: /^@deck\.gl\/([^/]+)$/,
    replacement: join(repoRoot, 'modules/$1/src')
  });
}

// `@deck.gl/splat-layers` is unreleased, and it calls `@luma.gl/splats` APIs that are unreleased
// too, so it is only usable when both come from source. Everywhere else the example falls back to
// its own copy of the layer: the same code before it was promoted, minus the compute stage,
// deck.gl picking and clipping. Pointing at the promoted module without LUMA_SOURCE would fail on
// a missing luma export rather than on anything the reader did wrong.
if (!lumaSource) {
  aliases.unshift({
    find: /^@deck\.gl\/splat-layers$/,
    replacement: join(exampleDir, 'splat-layer.ts')
  });
}

// The opacity-ramp controller is shared rather than copied, in both modes.
//
// It is the one part of the promoted module that touches no `@luma.gl` API at all - it is written
// against a structural type that `GPUSplatData` happens to satisfy - so it resolves against the
// published packages exactly as well as against a source checkout. Aliasing it here is what keeps
// the fork above from growing a second, drifting implementation of the anti-popping behaviour, which
// is the whole reason the fork is a liability in the first place.
aliases.unshift({
  find: '@deck.gl/splat-layers/fade-controller',
  replacement: join(repoRoot, 'modules/splat-layers/src/splat-fade-controller.ts')
});

export default defineConfig({
  define: {
    /**
     * Whether the build is running the promoted `@deck.gl/splat-layers` rather than the fork above.
     *
     * A few of the layer's fidelity controls - the analytic fragment kernel, the antialiasing mode,
     * the depth-key distribution - call `@luma.gl/splats` APIs that are not in a published release, so
     * they exist only on the promoted layer. The app reads this to offer them exactly when they are
     * real, instead of silently passing props that nothing consumes.
     */
    __PROMOTED_SPLAT_LAYER__: JSON.stringify(Boolean(lumaSource))
  },
  plugins: lumaSource || process.env.DECK_SOURCE ? [resolveFromExample(exampleModules)] : [],
  resolve: {alias: aliases},
  // `repoRoot` so the shared fade controller - and, in source mode, `modules/*/src` - can be served
  // from outside this folder.
  server: {port: 8080, fs: {allow: [exampleDir, repoRoot]}},
  optimizeDeps: {esbuildOptions: {target: 'es2022'}},
  build: {target: 'es2022'}
});
