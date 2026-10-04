// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {existsSync, readdirSync, readFileSync} from 'fs';
import {join} from 'path';

/**
 * Aliases every `@luma.gl` entry point to a luma.gl checkout's TypeScript sources.
 *
 * `@deck.gl/splat-layers` calls `@luma.gl/splats` APIs that no published luma.gl has yet, so the
 * example and the tests that exercise it run against a checkout named by `LUMA_SOURCE`.
 *
 * The aliases are derived from each module's own `exports` map rather than guessed, because the
 * subpaths are not uniform - `@luma.gl/gpgpu/gpu-core` lives at `src/gpu-core` but
 * `@luma.gl/gpgpu/cpu` lives at `src/operations/cpu`. Reading the map keeps this correct as luma
 * adds entry points, and an unmapped subpath fails loudly instead of resolving to the wrong file.
 *
 * @param {string} lumaRoot - Root of a luma.gl checkout.
 * @returns {{find: string, replacement: string}[]} Vite aliases, longest first.
 */
export function getLumaSourceAliases(lumaRoot) {
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
