// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * One tile of terrain as one GeoArrow `RecordBatch`, and that batch as the columns luma.gl's splat
 * renderer binds. No copy at either step.
 *
 * ## What this module is for
 *
 * The baked half of this example makes a narrow claim: a splat archive can be published and streamed
 * like any other tiled dataset. This is that claim with the archive taken away. The inputs are a
 * public elevation service and public orthophotography on the plain `{z}/{x}/{y}` endpoints anybody
 * can fetch, and the thing in the middle is ordinary columnar geospatial data:
 *
 * ```text
 *   geometry  FixedSizeList<f32>[3]   geoarrow.point, scene east/north/up metres
 *   color     FixedSizeList<u8>[4]    RGBA, display space
 *   scale     FixedSizeList<f32>[3]   one-sigma extents, metres
 *   rotation  FixedSizeList<f32>[4]   [w, x, y, z]
 *   opacity   f32
 * ```
 *
 * which is a schema a renderer can be handed, not a file format it has to be taught. The worker
 * writes those five buffers; this wraps them in Arrow without touching them; {@link readSplatSource}
 * reads them back out as the exact same `Float32Array`s, and `SplatLayer` uploads those.
 * {@link assertZeroCopy} is not a comment about that, it is a check.
 *
 * ## The two honest deviations
 *
 * Both are the same question.
 *
 * - GeoArrow says a point's coordinates are `double`. These are `float32`, because they are *local
 *   metres* rather than degrees and a covariance has no precision to spare. The declared CRS says so.
 * - They are local metres at all because the splat renderer has no projection stage: it takes world
 *   XYZ and a matrix. deck.gl's own GeoArrow layers hand the GPU lon/lat `f64` and project in the
 *   shader, which is precisely the piece missing between these two halves - a GeoArrow splat layer
 *   would keep the geometry column geographic and do here what every other deck.gl layer already
 *   does.
 *
 * That gap is one accessor wide, and naming it is most of the point of building this the long way.
 */

import {
  Field,
  FixedSizeList,
  Float32,
  makeData,
  RecordBatch,
  Schema,
  Struct,
  Uint8,
  type Data
} from 'apache-arrow';
import type {SplatSource} from '@luma.gl/splats';

import type {TerrainTileColumns} from './terrain-tile-protocol';

/** The GeoArrow extension name every point column carries. */
const GEOARROW_POINT = 'geoarrow.point';

/**
 * Wraps a built tile's buffers in a `RecordBatch`.
 *
 * Nothing is read, converted or validated per row: Arrow's `makeData` takes a typed array and keeps
 * it, so this is five allocations of metadata over buffers the worker already filled.
 */
export function makeTerrainRecordBatch(
  columns: TerrainTileColumns,
  origin: {longitude: number; latitude: number}
): RecordBatch {
  const {count} = columns;

  const geometry = float32List(
    'geometry',
    'xyz',
    3,
    count,
    columns.positions,
    // GeoArrow carries the CRS beside the column rather than in a sidecar, so the frame these metres
    // are in travels with them. `crs_type: unknown` is the honest code: this is a local east/north/up
    // frame pinned at one point, not anything with an authority code.
    new Map([
      ['ARROW:extension:name', GEOARROW_POINT],
      [
        'ARROW:extension:metadata',
        JSON.stringify({
          crs: `ENU metres about ${origin.longitude.toFixed(4)}, ${origin.latitude.toFixed(4)}`,
          crs_type: 'unknown'
        })
      ]
    ])
  );
  const color = uint8List('color', 'rgba', 4, count, columns.colors);
  const scale = float32List('scale', 'xyz', 3, count, columns.scales);
  const rotation = float32List('rotation', 'wxyz', 4, count, columns.rotations);
  const opacity = {
    field: new Field('opacity', new Float32(), false),
    data: makeData({type: new Float32(), length: count, data: columns.opacities})
  };

  const parts = [geometry, color, scale, rotation, opacity];
  const fields = parts.map(part => part.field);
  return new RecordBatch(
    new Schema(fields),
    makeData({
      type: new Struct(fields),
      length: count,
      nullCount: 0,
      children: parts.map(part => part.data)
    })
  );
}

/**
 * The same five buffers, as the framework-independent columns luma.gl takes.
 *
 * The only thing that matters here is that no CPU-side conversion happens on the way, which is why
 * there is an assertion for it rather than a comment.
 */
export function readSplatSource(batch: RecordBatch, sourceBatchIndex: number): SplatSource {
  return {
    positions: childValues<Float32Array>(batch, 'geometry'),
    scales: childValues<Float32Array>(batch, 'scale'),
    rotations: childValues<Float32Array>(batch, 'rotation'),
    colors: childValues<Uint8Array>(batch, 'color'),
    opacities: batch.getChild('opacity')!.data[0].values as Float32Array,
    sourceBatchIndex
  };
}

/** The schema as the panel prints it, read off the batch rather than retyped. */
export function describeTerrainSchema(batch: RecordBatch): Array<{name: string; type: string}> {
  return batch.schema.fields.map(field => ({name: field.name, type: String(field.type)}));
}

/**
 * Proves the handoff is a view and not a copy.
 *
 * Run once, on the first tile. Arrow hands back a fresh `TypedArray` object over the same
 * `ArrayBuffer`, so identity is the wrong test and `.buffer` is the right one. If some future Arrow
 * starts normalizing buffers on the way in, this module's central claim quietly becomes false and
 * nothing else would say so.
 */
export function assertZeroCopy(batch: RecordBatch, columns: TerrainTileColumns): void {
  const pairs: Array<[string, ArrayBufferLike, ArrayBufferLike]> = [
    ['geometry', childValues<Float32Array>(batch, 'geometry').buffer, columns.positions.buffer],
    ['color', childValues<Uint8Array>(batch, 'color').buffer, columns.colors.buffer],
    ['scale', childValues<Float32Array>(batch, 'scale').buffer, columns.scales.buffer],
    ['rotation', childValues<Float32Array>(batch, 'rotation').buffer, columns.rotations.buffer]
  ];
  for (const [name, fromArrow, fromWorker] of pairs) {
    if (fromArrow !== fromWorker) {
      // eslint-disable-next-line no-console
      console.warn(`[terrain] ${name} was copied into Arrow, not viewed - the claim is off`);
    }
  }
}

type Column = {field: Field; data: Data};

/**
 * A `FixedSizeList<f32>[n]` column over a buffer, kept rather than copied.
 *
 * Arrow's `makeData` is a stack of overloads selected on the concrete type, so a generic
 * `T extends DataType` parameter falls through all of them to the one that takes neither `data` nor
 * `child` and the call stops type-checking. Hence the concrete helper.
 */
function float32List(
  name: string,
  childName: string,
  listSize: number,
  length: number,
  values: Float32Array,
  metadata?: Map<string, string>
): Column {
  const child = makeData({type: new Float32(), length: values.length, data: values});
  const type = new FixedSizeList(listSize, new Field(childName, new Float32(), false));
  return {
    field: new Field(name, type, false, metadata),
    data: makeData({type, length, nullCount: 0, child})
  };
}

function childValues<T extends Float32Array | Uint8Array>(batch: RecordBatch, name: string): T {
  const column = batch.getChild(name);
  if (!column) {
    throw new Error(`terrain batch has no ${name} column`);
  }
  return column.data[0].children[0].values as T;
}

/**
 * A `FixedSizeList<u8>[n]` column over a buffer, kept rather than copied.
 *
 * Written out separately from the float helper for the same reason it is there: `makeData` is a
 * stack of overloads selected on the concrete type, and a generic parameter falls through all of
 * them.
 */
function uint8List(
  name: string,
  childName: string,
  listSize: number,
  length: number,
  values: Uint8Array
): Column {
  const child = makeData({type: new Uint8(), length: values.length, data: values});
  const type = new FixedSizeList(listSize, new Field(childName, new Uint8(), false));
  return {
    field: new Field(name, type, false),
    data: makeData({type, length, nullCount: 0, child})
  };
}
