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

// LUMA_SOURCE=<path> runs the example against a luma.gl checkout's sources, and it is required:
// `@deck.gl/splat-layers` is unreleased and calls `@luma.gl/splats` APIs that no published luma.gl
// has yet, so the layer and the renderer have to come from source together. deck.gl comes from this
// repo's `modules/*/src` for the same reason.
const lumaSource = process.env.LUMA_SOURCE;
if (!lumaSource) {
  throw new Error(
    'swiss-splat-terrain needs LUMA_SOURCE=<path to a luma.gl checkout of the deck-splat-layers ' +
      'branch>, e.g. `LUMA_SOURCE=~/Documents/GitHub/vis.gl-build/luma.gl npm start`. ' +
      'See SPLAT-LAYERS-BRANCH.md at the repo root.'
  );
}
aliases.unshift(...aliasLumaSources(lumaSource));
aliases.unshift({
  find: /^@deck\.gl\/([^/]+)$/,
  replacement: join(repoRoot, 'modules/$1/src')
});

export default defineConfig({
  plugins: [resolveFromExample(exampleModules)],
  resolve: {alias: aliases},
  // `modules/*/src` and the luma.gl checkout both live outside this folder, and Vite refuses to serve
  // either to the browser unless they are allowed here.
  server: {port: 8080, fs: {allow: [exampleDir, repoRoot, lumaSource]}},
  optimizeDeps: {esbuildOptions: {target: 'es2022'}},
  build: {target: 'es2022'}
});
