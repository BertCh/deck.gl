// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * Runs a baked archive's level-of-detail tree against the real traversal, with no browser.
 *
 * ```bash
 * npm run simulate-lod -- public/splat-archives/train
 * npm run simulate-lod -- public/splat-archives/train --degree 1 --error 4
 * ```
 *
 * The level-of-detail behaviour of an archive is a property of the numbers the baker writes --
 * geometric errors and bounding spheres -- and it is decided long before a GPU is involved.
 * `SplatHierarchyManager` and `SplatResidencyManager` need nothing from a device except a page
 * object with a row count and a byte length, so the actual luma.gl traversal can be driven here
 * over a stub, and what comes out is what a browser would do.
 *
 * That matters because the failure modes are quiet. A tree that refines everything at every
 * distance still renders correctly -- it just downloads the entire scene to draw a thumbnail, and
 * looks *fine* while doing it. The first version of this baker did exactly that, and the table
 * below is what caught it: outlier splats had inflated every bounding sphere until the camera
 * measured as being inside all of them, so every node's error came out effectively infinite.
 *
 * Read the table as a flight toward the scene. `frontier` and `drawn` should rise as the camera
 * closes in and then fall again once the frustum starts excluding things; `rejected` should stay
 * at zero unless the residency budget is deliberately being tested, because a rejection means the
 * traversal wanted a page the budget would not admit.
 */

import {readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {parseArgs} from 'node:util';

import {Matrix4} from '@math.gl/core';
import {
  SplatHierarchyManager,
  SplatResidencyManager,
  type SplatHierarchyView
} from '@luma.gl/splats';

import {
  buildSplatArchiveHierarchy,
  getNodeGpuByteLength,
  type SplatArchiveDegree,
  type SplatArchiveManifest
} from '../splat-archive.ts';

/** Distances to sample, as multiples of the scene's own horizontal extent. */
const DISTANCE_FACTORS = [64, 32, 16, 8, 4, 2, 1, 0.5];

/** Passes per viewpoint. Each one can only refine as far as the level it just loaded. */
const SETTLE_PASSES = 32;

const VIEWPORT_SIZE: [number, number] = [1600, 900];
const VERTICAL_FIELD_OF_VIEW = Math.PI / 3;

function formatCount(count: number): string {
  return count.toLocaleString('en-US');
}

async function main(): Promise<void> {
  const {values, positionals} = parseArgs({
    allowPositionals: true,
    options: {
      degree: {type: 'string', default: '1'},
      error: {type: 'string', default: '2'},
      'max-splats': {type: 'string'}
    }
  });

  const archiveDirectory = resolve(positionals[0] ?? 'public/splat-archives/train');
  const degree = Number(values.degree) as SplatArchiveDegree;
  const maximumScreenSpaceError = Number(values.error);
  const maxResidentSplats = values['max-splats'] ? Number(values['max-splats']) : undefined;

  const manifest = JSON.parse(
    await readFile(join(archiveDirectory, 'manifest.json'), 'utf8')
  ) as SplatArchiveManifest;
  const nodesById = new Map(manifest.nodes.map(node => [node.id, node]));

  // A stand-in for `GPUSplatData`. Residency reads exactly three things off a page -- its row
  // count, its byte length and whether it has been destroyed -- so nothing here needs a device.
  let loadedPageCount = 0;
  const loadStubPage = (id: string) => {
    const node = nodesById.get(id)!;
    loadedPageCount++;
    return {
      length: node.splatCount,
      byteLength: getNodeGpuByteLength(node, degree),
      destroyed: false,
      destroy(): void {
        this.destroyed = true;
      }
    };
  };

  const residency = new SplatResidencyManager(
    maxResidentSplats === undefined ? {} : {maxResidentSplats}
  );
  const hierarchy = new SplatHierarchyManager({
    roots: buildSplatArchiveHierarchy(manifest, degree, 'https://example.invalid/archive/'),
    residencyManager: residency,
    maximumScreenSpaceError,
    // Higher than the app's, so a viewpoint settles in a few passes rather than a few hundred.
    maxConcurrentLoads: 64,
    loadPage: async node => loadStubPage(node.id) as never
  });

  const {percentiles} = manifest.scene;
  const center: [number, number, number] = [
    (percentiles.x[0] + percentiles.x[1]) / 2,
    (percentiles.y[0] + percentiles.y[1]) / 2,
    (percentiles.z[0] + percentiles.z[1]) / 2
  ];
  const extent = Math.max(
    percentiles.x[1] - percentiles.x[0],
    percentiles.z[1] - percentiles.z[0]
  );

  /** An oblique view from `distance` away, roughly the angle the example's camera flies at. */
  function viewAt(distance: number): SplatHierarchyView {
    const eye: [number, number, number] = [
      center[0] + distance * 0.6,
      center[1] - distance * 0.4,
      center[2] + distance * 0.7
    ];
    const modelViewProjectionMatrix = new Matrix4()
      .perspective({
        fovy: VERTICAL_FIELD_OF_VIEW,
        aspect: VIEWPORT_SIZE[0] / VIEWPORT_SIZE[1],
        near: extent / 1000,
        far: extent * 1000
      })
      .multiplyRight(new Matrix4().lookAt({eye, center, up: [0, -1, 0]}));

    return {
      cameraPosition: eye,
      viewportSize: VIEWPORT_SIZE,
      modelViewProjectionMatrix: Array.from(modelViewProjectionMatrix),
      verticalFieldOfView: VERTICAL_FIELD_OF_VIEW
    };
  }

  process.stdout.write(
    `\n${manifest.scene.id}: ${manifest.nodes.length} nodes, ` +
      `${formatCount(manifest.scene.splatCount)} splats, extent ${extent.toFixed(1)} units\n` +
      `traversal: ${maximumScreenSpaceError}px error, degree ${degree}` +
      `${maxResidentSplats ? `, ${formatCount(maxResidentSplats)} splat ceiling` : ''}\n\n` +
      'distance'.padStart(12) +
      'frontier'.padStart(10) +
      'drawn'.padStart(12) +
      'resident'.padStart(12) +
      'GPU MB'.padStart(9) +
      'culled'.padStart(8) +
      'rejected'.padStart(10) +
      '\n'
  );

  for (const factor of DISTANCE_FACTORS) {
    const view = viewAt(extent * factor);
    // Nodes refine only once they are resident, so one pass reveals one more level. Settling
    // here is what makes the columns comparable: they show where the traversal *stops*, not how
    // far it happened to get in a single frame.
    for (let pass = 0; pass < SETTLE_PASSES; pass++) {
      hierarchy.update(view);
      await hierarchy.waitForIdle();
    }
    hierarchy.update(view);

    const traversal = hierarchy.stats;
    const resident = residency.getStats();
    const drawnSplatCount = hierarchy.frontier.reduce(
      (total, entry) => total + entry.chunk.data.length,
      0
    );

    process.stdout.write(
      `${(extent * factor).toFixed(0)}u`.padStart(12) +
        String(traversal.frontierNodeCount).padStart(10) +
        formatCount(drawnSplatCount).padStart(12) +
        formatCount(resident.residentSplatCount).padStart(12) +
        (resident.residentGpuByteLength / 1024 ** 2).toFixed(0).padStart(9) +
        String(traversal.culledNodeCount).padStart(8) +
        String(resident.rejectedChunkCount).padStart(10) +
        '\n'
    );
  }

  process.stdout.write(`\npages loaded over the whole sweep: ${loadedPageCount}\n\n`);
  hierarchy.destroy();
  residency.destroy();
}

main().catch(error => {
  process.stderr.write(`\n${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
