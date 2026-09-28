// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * Reads a freshly written archive back and measures what the quantization actually cost.
 *
 * A lossy format is a claim, and the claim is only worth as much as the measurement behind it.
 * This decodes every chunk with the same functions the browser uses, matches each stored row back
 * to the source row it came from, and reports the worst and the typical error per column -- so
 * "16 bits over a 10 m cell is 0.15 mm" is a number this printed rather than a number someone
 * estimated.
 *
 * Run it as part of a bake with `--verify`.
 */

import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

import {
  decodeCoreChunk,
  getBandBasisCount,
  getBandChunkPath,
  getCoreChunkPath,
  getCumulativeBasisCount,
  mergeBandChunks,
  readBandChunk,
  type SplatArchiveDegree
} from '../splat-archive.ts';

/** The source columns a bake decoded, before any quantization. */
type SourceColumns = {
  positions: Float32Array;
  scales: Float32Array;
  rotations: Float32Array;
  colors: Float32Array;
  opacities: Float32Array;
  sphericalHarmonics?: Float32Array;
  degree: SplatArchiveDegree;
};

/** Just enough of a built node to know which source rows its chunk holds, and in what order. */
type VerifiableNode = {id: string; rows: Uint32Array};

/** Running worst case and root-mean-square of one column's error. */
class ErrorAccumulator {
  maximum = 0;
  private sumOfSquares = 0;
  private count = 0;

  add(error: number): void {
    const magnitude = Math.abs(error);
    if (magnitude > this.maximum) {
      this.maximum = magnitude;
    }
    this.sumOfSquares += magnitude * magnitude;
    this.count++;
  }

  get rms(): number {
    return this.count > 0 ? Math.sqrt(this.sumOfSquares / this.count) : 0;
  }
}

function formatValue(value: number): string {
  if (value === 0) {
    return '0';
  }
  return Math.abs(value) < 1e-3 || Math.abs(value) >= 1e5
    ? value.toExponential(2)
    : value.toPrecision(4);
}

/**
 * Decodes an archive and compares it row for row against the columns it was baked from.
 *
 * `nodes` supplies the mapping: a chunk's rows are, in order, the source rows that node holds, so
 * a mismatch in row order shows up here as a large error rather than as a subtly wrong scene in
 * a browser three steps later.
 */
export async function verifyArchive(
  archiveDirectory: string,
  source: SourceColumns,
  nodes: VerifiableNode[],
  degree: SplatArchiveDegree
): Promise<void> {
  process.stdout.write('  verifying\n');

  const positionError = new ErrorAccumulator();
  const scaleRelativeError = new ErrorAccumulator();
  const rotationDegreesError = new ErrorAccumulator();
  const colorError = new ErrorAccumulator();
  const opacityError = new ErrorAccumulator();
  const harmonicError = new ErrorAccumulator();

  const seenRows = new Set<number>();
  let decodedRowCount = 0;
  const sceneBasisCount = getCumulativeBasisCount(source.degree);
  const archiveBasisCount = getCumulativeBasisCount(degree);

  for (const node of nodes) {
    const coreBuffer = await readFile(join(archiveDirectory, getCoreChunkPath(node.id)));
    const columns = decodeCoreChunk(
      coreBuffer.buffer.slice(
        coreBuffer.byteOffset,
        coreBuffer.byteOffset + coreBuffer.byteLength
      ) as ArrayBuffer
    );

    if (columns.rowCount !== node.rows.length) {
      throw new Error(
        `Node ${node.id} stored ${columns.rowCount} rows but holds ${node.rows.length}`
      );
    }

    let harmonics: Float32Array | undefined;
    if (degree > 0) {
      const bands = [];
      for (let band = 1; band <= degree; band++) {
        const bandBuffer = await readFile(join(archiveDirectory, getBandChunkPath(node.id, band)));
        const chunk = readBandChunk(
          bandBuffer.buffer.slice(
            bandBuffer.byteOffset,
            bandBuffer.byteOffset + bandBuffer.byteLength
          ) as ArrayBuffer
        );
        if (chunk.basisCount !== getBandBasisCount(band)) {
          throw new Error(`Node ${node.id} band ${band} declares ${chunk.basisCount} bases`);
        }
        bands.push(chunk);
      }
      harmonics = mergeBandChunks(bands, columns.rowCount);
    }

    for (let index = 0; index < columns.rowCount; index++) {
      const row = node.rows[index];
      if (seenRows.has(row)) {
        throw new Error(`Source row ${row} appears in more than one chunk`);
      }
      seenRows.add(row);
      decodedRowCount++;

      for (let axis = 0; axis < 3; axis++) {
        positionError.add(columns.positions[index * 3 + axis] - source.positions[row * 3 + axis]);
        const sourceScale = source.scales[row * 3 + axis];
        if (sourceScale > 0) {
          scaleRelativeError.add(
            (columns.scales[index * 3 + axis] - sourceScale) / sourceScale
          );
        }
      }

      // Quaternion error as the rotation angle between the two, which is what actually shows.
      // `q` and `-q` are the same rotation, so the dot product is compared by magnitude.
      let dot = 0;
      for (let component = 0; component < 4; component++) {
        dot += columns.rotations[index * 4 + component] * source.rotations[row * 4 + component];
      }
      const angle = 2 * Math.acos(Math.min(1, Math.abs(dot)));
      rotationDegreesError.add((angle * 180) / Math.PI);

      for (let component = 0; component < 4; component++) {
        colorError.add(columns.colors[index * 4 + component] - source.colors[row * 4 + component]);
      }
      opacityError.add(columns.opacities[index] - source.opacities[row]);

      if (harmonics && source.sphericalHarmonics) {
        for (let value = 0; value < archiveBasisCount * 3; value++) {
          harmonicError.add(
            harmonics[index * archiveBasisCount * 3 + value] -
              source.sphericalHarmonics[row * sceneBasisCount * 3 + value]
          );
        }
      }
    }
  }

  const rows = [
    ['positions (source units)', positionError],
    ['scales (relative)', scaleRelativeError],
    ['rotations (degrees)', rotationDegreesError],
    ['colors (linear radiance)', colorError],
    ['opacities (0..1)', opacityError],
    ...(degree > 0 ? ([['harmonics (coefficient)', harmonicError]] as const) : [])
  ] as [string, ErrorAccumulator][];

  process.stdout.write(`\n  ${'column'.padEnd(26)}${'worst'.padStart(12)}${'rms'.padStart(12)}\n`);
  for (const [label, accumulator] of rows) {
    process.stdout.write(
      `  ${label.padEnd(26)}${formatValue(accumulator.maximum).padStart(12)}${formatValue(
        accumulator.rms
      ).padStart(12)}\n`
    );
  }
  process.stdout.write(
    `\n  ${decodedRowCount.toLocaleString('en-US')} rows round-tripped, each exactly once\n\n`
  );
}
