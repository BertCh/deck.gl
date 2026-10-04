// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {defineConfig} from 'vite';
import {createRequire} from 'module';
import {dirname, join} from 'path';
import {fileURLToPath} from 'url';
import {getLumaSourceAliases} from '../../../scripts/luma-source-aliases.mjs';

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
 * Resolves a source tree's bare dependencies from this folder's `node_modules`.
 *
 * Source mode compiles files that live outside this example - `deck.gl/modules/*` and a luma.gl
 * checkout - and Node resolves their imports by walking up from *their* directory, which never
 * reaches this folder. Without this, a package installed only here is invisible to the source files
 * that import it.
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
aliases.unshift(...getLumaSourceAliases(lumaSource));
aliases.unshift({
  find: /^@deck\.gl\/([^/]+)$/,
  replacement: join(repoRoot, 'modules/$1/src')
});

export default defineConfig({
  plugins: [resolveFromExample(exampleModules)],
  // `modules/react/src` would otherwise pick up the repo root's React, a second copy whose hooks
  // fail against this example's `react-dom`.
  resolve: {alias: aliases, dedupe: ['react', 'react-dom']},
  // `modules/*/src` and the luma.gl checkout both live outside this folder, and Vite refuses to serve
  // either to the browser unless they are allowed here.
  server: {port: 8080, fs: {allow: [exampleDir, repoRoot, lumaSource]}},
  optimizeDeps: {esbuildOptions: {target: 'es2022'}},
  build: {target: 'es2022'}
});
