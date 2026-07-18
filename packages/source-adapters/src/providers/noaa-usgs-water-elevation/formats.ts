import { createHash } from 'node:crypto';
import { closeSync, openSync, writeSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Unzip, UnzipInflate, unzipSync } from 'fflate';
import { fromArrayBuffer, fromFile } from 'geotiff';

import { oracleErrorSchema, type OracleError } from '@oracle/contracts/errors';
import type { JsonValue } from '../../spi/decode.js';
import {
  geometryIntersectsBounds,
  parseSupportedGeometry,
  type SupportedGeometry,
  type Wgs84Bounds,
} from './geometry.js';

export interface RawVectorFeature {
  readonly recordKey: string;
  readonly geometry: SupportedGeometry;
  readonly properties: Readonly<Record<string, JsonValue>>;
}

export interface DecodedElevationImage {
  readonly width: number;
  readonly height: number;
  readonly bands: readonly number[];
  readonly samples: readonly number[];
  readonly noDataValue: number | null;
  readonly bounds: Wgs84Bounds;
  readonly resolutionDegrees: readonly [number, number];
  readonly horizontalEpsg: 4326;
}

export interface DecodedElevationTile extends DecodedElevationImage {
  readonly x: number;
  readonly y: number;
}

const NOAA_ENTRY_LIMITS = Object.freeze({
  '.shp': 256 * 1024 * 1024,
  '.dbf': 128 * 1024 * 1024,
  '.prj': 64 * 1024,
});
const MAX_HYDRO_FEATURE_BYTES = 8 * 1024 * 1024;
const MAX_HYDRO_SKELETON_BYTES = 256 * 1024;
const ELEVATION_TILE_SIZE = 256;
const MAX_NOAA_SHP_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_NOAA_ZIP_ENTRIES = 4096;
const MAX_NOAA_ZIP_ENTRY_NAME_BYTES = 1024;
const MAX_NOAA_ZIP_TOTAL_NAME_BYTES = 256 * 1024;
const LEGACY_FIXTURE_MAX_BYTES = 1024 * 1024;

interface DbfField {
  readonly name: string;
  readonly type: string;
  readonly length: number;
}

const REQUIRED_NOAA_FIELDS = Object.freeze([
  'SRC_DATE',
  'HOR_ACC',
  'ATTRIBUTE',
  'DATA_SOURC',
  'DAT_SET_CR',
  'NOAA_Regio',
]);

function schemaError(message: string): Error & OracleError {
  const parsed = oracleErrorSchema.parse({
    code: 'SCHEMA_DRIFT',
    retryable: false,
    message: `SCHEMA_DRIFT: ${message}`,
    phase: 'decode',
  });
  return Object.assign(new Error(parsed.message), parsed);
}

function entry(entries: Readonly<Record<string, Uint8Array>>, suffix: string): Uint8Array {
  const key = Object.keys(entries).find((candidate) =>
    candidate.toLowerCase().endsWith(suffix.toLowerCase()),
  );
  if (key === undefined) {
    throw schemaError(`NOAA archive is missing ${suffix}`);
  }
  const value = entries[key];
  if (value === undefined) {
    throw schemaError(`NOAA archive entry disappeared: ${key}`);
  }
  return value;
}

function readDbfFields(dbf: Buffer, headerLength: number): readonly DbfField[] {
  const fields: DbfField[] = [];
  for (let offset = 32; offset < headerLength - 1; offset += 32) {
    if (dbf[offset] === 0x0d) {
      break;
    }
    const length = dbf[offset + 16];
    const typeByte = dbf[offset + 11];
    if (length === undefined || typeByte === undefined || length === 0) {
      throw schemaError('NOAA DBF contains a malformed field descriptor');
    }
    fields.push(
      Object.freeze({
        name: dbf
          .subarray(offset, offset + 11)
          .toString('ascii')
          .replace(/\0.*$/u, '')
          .trim(),
        type: String.fromCharCode(typeByte),
        length,
      }),
    );
  }
  for (const required of REQUIRED_NOAA_FIELDS) {
    if (!fields.some((field) => field.name === required)) {
      throw schemaError(`NOAA DBF is missing required field ${required}`);
    }
  }
  return Object.freeze(fields);
}

function readDbfProperties(
  dbf: Buffer,
  fields: readonly DbfField[],
  headerLength: number,
  recordLength: number,
  index: number,
): Readonly<Record<string, JsonValue>> | null {
  const start = headerLength + index * recordLength;
  if (start + recordLength > dbf.byteLength) {
    throw schemaError(`NOAA DBF record ${index + 1} exceeds the file boundary`);
  }
  if (dbf[start] === 0x2a) {
    return null;
  }
  let offset = start + 1;
  const properties: Record<string, JsonValue> = {};
  for (const field of fields) {
    properties[field.name] = dbf
      .subarray(offset, offset + field.length)
      .toString('utf8')
      .trim();
    offset += field.length;
  }
  return Object.freeze(properties);
}

function readDbfPropertiesRecord(
  record: Buffer,
  fields: readonly DbfField[],
): Readonly<Record<string, JsonValue>> | null {
  if (record[0] === 0x2a) return null;
  let offset = 1;
  const properties: Record<string, JsonValue> = {};
  for (const field of fields) {
    properties[field.name] = record
      .subarray(offset, offset + field.length)
      .toString('utf8')
      .trim();
    offset += field.length;
  }
  if (offset > record.byteLength) throw schemaError('NOAA DBF record is truncated');
  return Object.freeze(properties);
}

async function readExactly(
  handle: FileHandle,
  length: number,
  position: number,
  label: string,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (result.bytesRead === 0) throw schemaError(`${label} is truncated`);
    offset += result.bytesRead;
  }
  return buffer;
}

type NoaaSourceEpsg = 4269 | 4326;

function projectionNumber(projection: string, pattern: RegExp, component: string): number {
  const value = pattern.exec(projection)?.[1];
  if (value === undefined) {
    throw schemaError(`NOAA archive projection is missing ${component}`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw schemaError(`NOAA archive projection has invalid ${component}`);
  }
  return parsed;
}

function projectionName(projection: string, pattern: RegExp, component: string): string {
  const value = pattern.exec(projection)?.[1];
  if (value === undefined) {
    throw schemaError(`NOAA archive projection is missing ${component}`);
  }
  return value.replaceAll(' ', '_').toUpperCase();
}

function closeTo(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

function noaaSourceEpsg(prj: Uint8Array): NoaaSourceEpsg {
  const projection = Buffer.from(prj).toString('utf8');
  if (!/^\s*GEOGCS\s*\[/iu.test(projection) || /PROJCS\s*\[/iu.test(projection)) {
    throw schemaError('NOAA archive projection must be a geographic CRS');
  }
  const datum = projectionName(projection, /DATUM\s*\[\s*"([^"]+)"/iu, 'datum');
  const spheroid = projectionName(projection, /SPHEROID\s*\[\s*"([^"]+)"/iu, 'spheroid');
  const semiMajor = projectionNumber(
    projection,
    /SPHEROID\s*\[\s*"[^"]+"\s*,\s*([-+\d.e]+)/iu,
    'spheroid semi-major axis',
  );
  const inverseFlattening = projectionNumber(
    projection,
    /SPHEROID\s*\[\s*"[^"]+"\s*,\s*[-+\d.e]+\s*,\s*([-+\d.e]+)/iu,
    'spheroid inverse flattening',
  );
  const primeMeridian = projectionNumber(
    projection,
    /PRIMEM\s*\[\s*"GREENWICH"\s*,\s*([-+\d.e]+)/iu,
    'Greenwich prime meridian',
  );
  const angularUnit = projectionNumber(
    projection,
    /UNIT\s*\[\s*"DEGREE"\s*,\s*([-+\d.e]+)/iu,
    'degree angular unit',
  );
  if (
    !closeTo(semiMajor, 6_378_137, 1e-6) ||
    !closeTo(primeMeridian, 0, 1e-12) ||
    !closeTo(angularUnit, Math.PI / 180, 1e-15)
  ) {
    throw schemaError('NOAA archive projection parameters are not recognized');
  }
  if (
    datum === 'D_WGS_1984' &&
    spheroid === 'WGS_1984' &&
    closeTo(inverseFlattening, 298.257223563, 1e-9)
  ) {
    return 4326;
  }
  if (
    datum === 'D_NORTH_AMERICAN_1983' &&
    spheroid === 'GRS_1980' &&
    closeTo(inverseFlattening, 298.257222101, 1e-9)
  ) {
    return 4269;
  }
  throw schemaError('NOAA archive projection is not recognized as WGS 84 or NAD83');
}

function noaaCoordinateToWgs84(
  longitude: number,
  latitude: number,
  sourceEpsg: NoaaSourceEpsg,
): readonly [number, number] {
  if (sourceEpsg === 4269) {
    // EPSG:1188 is the applicable NAD83-to-WGS84 null geocentric translation for
    // North America. Its stated 4 m accuracy is preserved in the source catalog.
    return Object.freeze([longitude, latitude]);
  }
  return Object.freeze([longitude, latitude]);
}

export function decodeNoaaShorelineArchive(
  bytes: Uint8Array,
  clipBounds: Wgs84Bounds,
): readonly RawVectorFeature[] {
  if (bytes.byteLength > LEGACY_FIXTURE_MAX_BYTES) {
    throw schemaError('Legacy NOAA whole-byte shoreline decode is limited to 1 MiB fixtures');
  }
  let entries: Readonly<Record<string, Uint8Array>>;
  try {
    entries = unzipSync(bytes);
  } catch (error) {
    throw schemaError(`NOAA archive is not a valid ZIP: ${String(error)}`);
  }
  return decodeNoaaShorelineEntries(entries, clipBounds);
}

function decodeNoaaShorelineEntries(
  entries: Readonly<Record<string, Uint8Array>>,
  clipBounds: Wgs84Bounds,
): readonly RawVectorFeature[] {
  const shp = Buffer.from(entry(entries, '.shp'));
  const dbf = Buffer.from(entry(entries, '.dbf'));
  const sourceEpsg = noaaSourceEpsg(entry(entries, '.prj'));

  if (shp.byteLength < 100 || shp.readInt32BE(0) !== 9994) {
    throw schemaError('NOAA shapefile header is malformed');
  }
  const headerLength = dbf.readUInt16LE(8);
  const recordLength = dbf.readUInt16LE(10);
  const dbfRecordCount = dbf.readUInt32LE(4);
  if (headerLength < 33 || recordLength < 2 || dbf.byteLength < headerLength) {
    throw schemaError('NOAA DBF header is malformed');
  }
  const fields = readDbfFields(dbf, headerLength);

  const features: RawVectorFeature[] = [];
  const recordKeys = new Set<string>();
  let offset = 100;
  let recordIndex = 0;
  while (offset + 8 <= shp.byteLength) {
    const recordNumber = shp.readInt32BE(offset);
    const contentBytes = shp.readInt32BE(offset + 4) * 2;
    const start = offset + 8;
    const end = start + contentBytes;
    if (contentBytes < 4 || end > shp.byteLength) {
      throw schemaError(`NOAA shapefile record ${recordNumber} exceeds the file boundary`);
    }
    const shapeType = shp.readInt32LE(start);
    if (shapeType !== 0 && shapeType !== 3) {
      throw schemaError(`NOAA shoreline expected PolyLine shape type 3, received ${shapeType}`);
    }
    if (shapeType === 3) {
      if (contentBytes < 44) {
        throw schemaError(`NOAA shapefile record ${recordNumber} is truncated`);
      }
      const numberOfParts = shp.readInt32LE(start + 36);
      const numberOfPoints = shp.readInt32LE(start + 40);
      if (numberOfParts < 1 || numberOfPoints < 2) {
        throw schemaError(`NOAA shapefile record ${recordNumber} has invalid part/point counts`);
      }
      const pointsOffset = start + 44 + numberOfParts * 4;
      if (pointsOffset + numberOfPoints * 16 > end) {
        throw schemaError(`NOAA shapefile record ${recordNumber} point array is truncated`);
      }
      const partStarts = Array.from({ length: numberOfParts }, (_, partIndex) =>
        shp.readInt32LE(start + 44 + partIndex * 4),
      );
      const properties = readDbfProperties(dbf, fields, headerLength, recordLength, recordIndex);
      if (properties !== null) {
        for (let partIndex = 0; partIndex < partStarts.length; partIndex += 1) {
          const partStart = partStarts[partIndex];
          const partEnd = partStarts[partIndex + 1] ?? numberOfPoints;
          if (
            partStart === undefined ||
            partStart < 0 ||
            partEnd <= partStart ||
            partEnd > numberOfPoints
          ) {
            throw schemaError(`NOAA shapefile record ${recordNumber} has invalid part offsets`);
          }
          const coordinates: JsonValue[] = [];
          for (let pointIndex = partStart; pointIndex < partEnd; pointIndex += 1) {
            coordinates.push(
              noaaCoordinateToWgs84(
                shp.readDoubleLE(pointsOffset + pointIndex * 16),
                shp.readDoubleLE(pointsOffset + pointIndex * 16 + 8),
                sourceEpsg,
              ),
            );
          }
          const geometry = parseSupportedGeometry(
            Object.freeze({ type: 'LineString', coordinates: Object.freeze(coordinates) }),
            4326,
          );
          if (geometryIntersectsBounds(geometry, clipBounds)) {
            const recordKey = `record-${recordNumber}-part-${partIndex}`;
            if (recordKeys.has(recordKey)) {
              throw schemaError(`Duplicate NOAA source record key ${recordKey}`);
            }
            recordKeys.add(recordKey);
            features.push(Object.freeze({ recordKey, geometry, properties }));
          }
        }
      }
    }
    recordIndex += 1;
    offset = end;
  }
  if (recordIndex !== dbfRecordCount) {
    throw schemaError(
      `NOAA SHP/DBF record count mismatch: SHP=${recordIndex}, DBF=${dbfRecordCount}`,
    );
  }
  return Object.freeze(features);
}

/** Spools reviewed ZIP members and yields one SHP/DBF record at a time. */
export async function* decodeNoaaShorelineArchiveStream(
  chunks: AsyncIterable<Uint8Array>,
  clipBounds: Wgs84Bounds,
  signal: AbortSignal,
): AsyncIterable<RawVectorFeature> {
  const workspace = await mkdtemp(join(tmpdir(), 'oracle-noaa-shoreline-'));
  const extracted = new Map<string, string>();
  const seen = new Set<string>();
  let entryCount = 0;
  let entryNameBytes = 0;
  let streamError: Error | undefined;
  const openDescriptors = new Set<number>();
  try {
    signal.throwIfAborted();
    const unzip = new Unzip((file) => {
      entryCount += 1;
      const currentNameBytes = new TextEncoder().encode(file.name).byteLength;
      entryNameBytes += currentNameBytes;
      if (
        entryCount > MAX_NOAA_ZIP_ENTRIES ||
        currentNameBytes > MAX_NOAA_ZIP_ENTRY_NAME_BYTES ||
        entryNameBytes > MAX_NOAA_ZIP_TOTAL_NAME_BYTES
      ) {
        streamError = schemaError('NOAA ZIP metadata exceeds its reviewed entry/name bounds');
        file.terminate();
        return;
      }
      const normalized = file.name.replaceAll('\\', '/');
      if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
        streamError = schemaError(`Unsafe NOAA ZIP member path: ${file.name}`);
        file.terminate();
        return;
      }
      const suffix = (Object.keys(NOAA_ENTRY_LIMITS) as (keyof typeof NOAA_ENTRY_LIMITS)[]).find(
        (candidate) => normalized.toLowerCase().endsWith(candidate),
      );
      if (suffix === undefined) return;
      if (seen.has(suffix)) {
        streamError = schemaError(`Duplicate NOAA ZIP member for ${suffix}`);
        file.terminate();
        return;
      }
      seen.add(suffix);
      const maximum = NOAA_ENTRY_LIMITS[suffix];
      if (file.originalSize !== undefined && file.originalSize > maximum) {
        streamError = schemaError(`NOAA ZIP member ${file.name} exceeds ${maximum} bytes`);
        file.terminate();
        return;
      }
      const path = resolve(workspace, suffix.slice(1));
      if (
        !path.startsWith(`${resolve(workspace)}\\`) &&
        !path.startsWith(`${resolve(workspace)}/`)
      ) {
        streamError = schemaError(`NOAA spool path escaped workspace: ${suffix}`);
        file.terminate();
        return;
      }
      const descriptor = openSync(path, 'wx');
      openDescriptors.add(descriptor);
      let length = 0;
      file.ondata = (error, chunk, final) => {
        if (error !== null) {
          streamError = schemaError(`NOAA ZIP member ${file.name} failed: ${String(error)}`);
          return;
        }
        if (length + chunk.byteLength > maximum) {
          streamError = schemaError(`NOAA ZIP member ${file.name} exceeds ${maximum} bytes`);
          file.terminate();
          return;
        }
        writeSync(descriptor, chunk);
        length += chunk.byteLength;
        if (final) {
          closeSync(descriptor);
          openDescriptors.delete(descriptor);
          extracted.set(suffix, path);
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    let previous: Uint8Array | undefined;
    for await (const chunk of chunks) {
      signal.throwIfAborted();
      if (streamError !== undefined) throw streamError;
      if (previous !== undefined) unzip.push(previous, false);
      previous = chunk;
    }
    unzip.push(previous ?? new Uint8Array(), true);
    if (streamError !== undefined) throw streamError;
    const shpPath = extracted.get('.shp');
    const dbfPath = extracted.get('.dbf');
    const prjPath = extracted.get('.prj');
    if (shpPath === undefined || dbfPath === undefined || prjPath === undefined) {
      throw schemaError('NOAA archive is missing SHP, DBF, or PRJ');
    }
    const shp = await open(shpPath, 'r');
    const dbf = await open(dbfPath, 'r');
    const prj = await open(prjPath, 'r');
    try {
      const shpSize = (await shp.stat()).size;
      const dbfSize = (await dbf.stat()).size;
      const prjSize = (await prj.stat()).size;
      if (prjSize > NOAA_ENTRY_LIMITS['.prj']) throw schemaError('NOAA PRJ exceeds its bound');
      const sourceEpsg = noaaSourceEpsg(await readExactly(prj, prjSize, 0, 'NOAA PRJ'));
      const shpHeader = await readExactly(shp, 100, 0, 'NOAA SHP header');
      if (shpHeader.readInt32BE(0) !== 9994)
        throw schemaError('NOAA shapefile header is malformed');
      const dbfBaseHeader = await readExactly(dbf, 32, 0, 'NOAA DBF header');
      const headerLength = dbfBaseHeader.readUInt16LE(8);
      const recordLength = dbfBaseHeader.readUInt16LE(10);
      const dbfRecordCount = dbfBaseHeader.readUInt32LE(4);
      if (headerLength < 33 || recordLength < 2 || dbfSize < headerLength) {
        throw schemaError('NOAA DBF header is malformed');
      }
      const fields = readDbfFields(
        await readExactly(dbf, headerLength, 0, 'NOAA DBF field descriptors'),
        headerLength,
      );
      let offset = 100;
      let recordIndex = 0;
      let previousRecordNumber = 0;
      while (offset + 8 <= shpSize) {
        signal.throwIfAborted();
        const recordHeader = await readExactly(shp, 8, offset, 'NOAA SHP record header');
        const recordNumber = recordHeader.readInt32BE(0);
        const contentBytes = recordHeader.readInt32BE(4) * 2;
        if (recordNumber <= previousRecordNumber)
          throw schemaError('NOAA SHP record order is invalid');
        previousRecordNumber = recordNumber;
        if (
          contentBytes < 4 ||
          contentBytes > MAX_NOAA_SHP_RECORD_BYTES ||
          offset + 8 + contentBytes > shpSize
        ) {
          throw schemaError(`NOAA shapefile record ${recordNumber} exceeds its bounded file range`);
        }
        const content = await readExactly(
          shp,
          contentBytes,
          offset + 8,
          `NOAA SHP record ${recordNumber}`,
        );
        const shapeType = content.readInt32LE(0);
        if (shapeType !== 0 && shapeType !== 3) {
          throw schemaError(`NOAA shoreline expected PolyLine shape type 3, received ${shapeType}`);
        }
        const dbfRecord = await readExactly(
          dbf,
          recordLength,
          headerLength + recordIndex * recordLength,
          `NOAA DBF record ${recordIndex + 1}`,
        );
        const properties = readDbfPropertiesRecord(dbfRecord, fields);
        if (shapeType === 3 && properties !== null) {
          if (contentBytes < 44)
            throw schemaError(`NOAA shapefile record ${recordNumber} is truncated`);
          const numberOfParts = content.readInt32LE(36);
          const numberOfPoints = content.readInt32LE(40);
          if (numberOfParts < 1 || numberOfPoints < 2) {
            throw schemaError(
              `NOAA shapefile record ${recordNumber} has invalid part/point counts`,
            );
          }
          const pointsOffset = 44 + numberOfParts * 4;
          if (pointsOffset + numberOfPoints * 16 > content.byteLength) {
            throw schemaError(`NOAA shapefile record ${recordNumber} point array is truncated`);
          }
          for (let partIndex = 0; partIndex < numberOfParts; partIndex += 1) {
            const partStart = content.readInt32LE(44 + partIndex * 4);
            const partEnd =
              partIndex + 1 < numberOfParts
                ? content.readInt32LE(44 + (partIndex + 1) * 4)
                : numberOfPoints;
            if (partStart < 0 || partEnd <= partStart || partEnd > numberOfPoints) {
              throw schemaError(`NOAA shapefile record ${recordNumber} has invalid part offsets`);
            }
            const coordinates: JsonValue[] = [];
            for (let pointIndex = partStart; pointIndex < partEnd; pointIndex += 1) {
              coordinates.push(
                noaaCoordinateToWgs84(
                  content.readDoubleLE(pointsOffset + pointIndex * 16),
                  content.readDoubleLE(pointsOffset + pointIndex * 16 + 8),
                  sourceEpsg,
                ),
              );
            }
            const geometry = parseSupportedGeometry(
              Object.freeze({ type: 'LineString', coordinates: Object.freeze(coordinates) }),
              4326,
            );
            if (geometryIntersectsBounds(geometry, clipBounds)) {
              yield Object.freeze({
                recordKey: `record-${recordNumber}-part-${partIndex}`,
                geometry,
                properties,
              });
            }
          }
        }
        recordIndex += 1;
        offset += 8 + contentBytes;
      }
      if (recordIndex !== dbfRecordCount) {
        throw schemaError(
          `NOAA SHP/DBF record count mismatch: SHP=${recordIndex}, DBF=${dbfRecordCount}`,
        );
      }
    } finally {
      await Promise.all([shp.close(), dbf.close(), prj.close()]);
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error) throw error;
    throw schemaError(`NOAA archive is not a valid bounded ZIP: ${String(error)}`);
  } finally {
    for (const descriptor of openDescriptors) closeSync(descriptor);
    await rm(workspace, { recursive: true, force: true });
  }
}

function jsonRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw schemaError(`Expected ${label} object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function jsonValueRecord(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, JsonValue>> {
  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    ) {
      output[key] = item;
    } else {
      throw schemaError(`GeoJSON property ${key} is not a supported scalar`);
    }
  }
  return Object.freeze(output);
}

function decodeHydroFeature(
  featureValue: unknown,
  ordinal: number,
  clipBounds: Wgs84Bounds,
): RawVectorFeature | null {
  const feature = jsonRecord(featureValue, `feature ${ordinal}`);
  const properties = jsonValueRecord(
    jsonRecord(feature.properties, `feature ${ordinal} properties`),
  );
  const id3dhp = properties.id3dhp;
  if (typeof id3dhp !== 'string' || id3dhp.length === 0) {
    throw schemaError(`USGS 3DHP feature ${ordinal} is missing id3dhp`);
  }
  const geometryValue = jsonRecord(feature.geometry, `feature ${ordinal} geometry`);
  if (typeof geometryValue.type !== 'string' || !('coordinates' in geometryValue)) {
    throw schemaError(`USGS 3DHP feature ${ordinal} geometry is malformed`);
  }
  const geometry = parseSupportedGeometry(
    { type: geometryValue.type, coordinates: geometryValue.coordinates as JsonValue },
    4326,
  );
  return geometryIntersectsBounds(geometry, clipBounds)
    ? Object.freeze({ recordKey: id3dhp, geometry, properties })
    : null;
}

export function decodeHydroFeatureCollection(
  bytes: Uint8Array,
  clipBounds: Wgs84Bounds,
): readonly RawVectorFeature[] {
  if (bytes.byteLength > LEGACY_FIXTURE_MAX_BYTES) {
    throw schemaError('Legacy USGS whole-byte hydro decode is limited to 1 MiB fixtures');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw schemaError(`USGS 3DHP response is not valid UTF-8 GeoJSON: ${String(error)}`);
  }
  const collection = jsonRecord(parsed, 'FeatureCollection');
  if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw schemaError('USGS 3DHP response is not a FeatureCollection');
  }
  const records: RawVectorFeature[] = [];
  const identifiers = new Set<string>();
  for (const [ordinal, featureValue] of collection.features.entries()) {
    const decoded = decodeHydroFeature(featureValue, ordinal, clipBounds);
    if (decoded === null) continue;
    if (identifiers.has(decoded.recordKey))
      throw schemaError(`Duplicate USGS 3DHP id3dhp ${decoded.recordKey}`);
    identifiers.add(decoded.recordKey);
    records.push(decoded);
  }
  return Object.freeze(records);
}

async function markHydroIdentifier(directory: string, identifier: string): Promise<boolean> {
  const hash = createHash('sha256').update(identifier).digest('hex');
  const shard = join(directory, hash.slice(0, 2));
  await mkdir(shard, { recursive: true });
  const path = join(shard, hash.slice(2));
  try {
    const marker = await open(path, 'wx');
    try {
      await marker.writeFile(identifier, 'utf8');
    } finally {
      await marker.close();
    }
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      const existing = await readFile(path, 'utf8');
      if (existing === identifier) return false;
      throw Object.assign(schemaError('USGS 3DHP identifier SHA-256 collision'), { cause: error });
    }
    throw error;
  }
}

/** Incrementally parses features with bounded envelope state and disk-backed duplicate detection. */
export async function* decodeHydroFeatureCollectionStream(
  chunks: AsyncIterable<Uint8Array>,
  clipBounds: Wgs84Bounds,
  signal: AbortSignal,
): AsyncIterable<RawVectorFeature> {
  const workspace = await mkdtemp(join(tmpdir(), 'oracle-usgs-hydro-'));
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const prefixParts: string[] = [];
  const suffixParts: string[] = [];
  let prefixPart = '';
  let suffixPart = '';
  let prefixLength = 0;
  let suffixLength = 0;
  let envelopeObjectDepth = 0;
  let envelopeArrayDepth = 0;
  let envelopeInString = false;
  let envelopeEscaped = false;
  let envelopeString = '';
  let featuresKeyStage: 0 | 1 | 2 = 0;
  let inFeatures = false;
  let finishedFeatures = false;
  let feature = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  let ordinal = 0;
  try {
    const decodedTexts = (async function* (): AsyncIterable<string> {
      for await (const chunk of chunks) {
        signal.throwIfAborted();
        yield decoder.decode(chunk, { stream: true });
      }
      yield decoder.decode();
    })();
    for await (const text of decodedTexts) {
      for (const character of text) {
        signal.throwIfAborted();
        if (!inFeatures) {
          prefixPart += character;
          prefixLength += 1;
          if (prefixPart.length >= 4096) {
            prefixParts.push(prefixPart);
            prefixPart = '';
          }
          if (prefixLength > MAX_HYDRO_SKELETON_BYTES) {
            throw schemaError('USGS 3DHP FeatureCollection prefix exceeds its reviewed bound');
          }
          if (envelopeInString) {
            if (envelopeEscaped) envelopeEscaped = false;
            else if (character === '\\') envelopeEscaped = true;
            else if (character === '"') {
              envelopeInString = false;
              featuresKeyStage =
                envelopeObjectDepth === 1 &&
                envelopeArrayDepth === 0 &&
                envelopeString === 'features'
                  ? 1
                  : 0;
            } else if (envelopeString.length <= 'features'.length) {
              envelopeString += character;
            }
            continue;
          }
          if (character === '"') {
            envelopeInString = true;
            envelopeString = '';
            continue;
          }
          if (featuresKeyStage === 1) {
            if (/\s/u.test(character)) continue;
            featuresKeyStage = character === ':' ? 2 : 0;
            continue;
          }
          if (featuresKeyStage === 2) {
            if (/\s/u.test(character)) continue;
            if (character !== '[') {
              throw schemaError('USGS 3DHP features member is not an array');
            }
            inFeatures = true;
            continue;
          }
          if (character === '{') envelopeObjectDepth += 1;
          else if (character === '}') envelopeObjectDepth -= 1;
          else if (character === '[') envelopeArrayDepth += 1;
          else if (character === ']') envelopeArrayDepth -= 1;
          continue;
        }
        if (finishedFeatures) {
          suffixPart += character;
          suffixLength += 1;
          if (suffixPart.length >= 4096) {
            suffixParts.push(suffixPart);
            suffixPart = '';
          }
          if (suffixLength > MAX_HYDRO_SKELETON_BYTES) {
            throw schemaError('USGS 3DHP FeatureCollection suffix exceeds its reviewed bound');
          }
          continue;
        }
        if (feature.length === 0) {
          if (/\s|,/u.test(character)) continue;
          if (character === ']') {
            suffixPart = ']';
            suffixLength = 1;
            finishedFeatures = true;
            continue;
          }
          if (character !== '{') {
            throw schemaError(`USGS 3DHP feature ${ordinal} is not an object`);
          }
          feature = character;
          depth = 1;
          continue;
        }
        feature += character;
        if (feature.length > MAX_HYDRO_FEATURE_BYTES) {
          throw schemaError(`USGS 3DHP feature ${ordinal} exceeds its reviewed byte bound`);
        }
        if (inString) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') inString = true;
        else if (character === '{' || character === '[') depth += 1;
        else if (character === '}' || character === ']') depth -= 1;
        if (depth !== 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(feature) as unknown;
        } catch (error) {
          throw schemaError(`USGS 3DHP feature ${ordinal} is malformed: ${String(error)}`);
        }
        const decoded = decodeHydroFeature(parsed, ordinal, clipBounds);
        if (
          decoded !== null &&
          !(await markHydroIdentifier(join(workspace, 'identifiers'), decoded.recordKey))
        ) {
          throw schemaError(`Duplicate USGS 3DHP id3dhp ${decoded.recordKey}`);
        }
        ordinal += 1;
        feature = '';
        if (decoded !== null) yield decoded;
      }
    }
    if (!inFeatures || !finishedFeatures || feature.length > 0) {
      throw schemaError('USGS 3DHP FeatureCollection envelope is incomplete');
    }
    let parsedEnvelope: unknown;
    try {
      parsedEnvelope = JSON.parse(
        `${prefixParts.join('')}${prefixPart}${suffixParts.join('')}${suffixPart}`,
      ) as unknown;
    } catch (error) {
      throw schemaError(`USGS 3DHP FeatureCollection envelope is malformed: ${String(error)}`);
    }
    const collection = jsonRecord(parsedEnvelope, 'FeatureCollection');
    if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
      throw schemaError('USGS 3DHP response is not a FeatureCollection');
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = Uint8Array.from(bytes);
  return copy.buffer;
}

export async function decodeElevationGeoTiff(bytes: Uint8Array): Promise<DecodedElevationImage> {
  if (bytes.byteLength > LEGACY_FIXTURE_MAX_BYTES) {
    throw schemaError('Legacy USGS whole-byte GeoTIFF decode is limited to 1 MiB fixtures');
  }
  let image;
  try {
    const tiff = await fromArrayBuffer(exactArrayBuffer(bytes));
    image = await tiff.getImage();
  } catch (error) {
    throw schemaError(`USGS 3DEP artifact is not a readable GeoTIFF: ${String(error)}`);
  }
  const geoKeys = image.getGeoKeys();
  if (geoKeys?.GeographicTypeGeoKey !== 4326) {
    throw schemaError(
      `USGS 3DEP excerpt expected EPSG:4326, received ${String(geoKeys?.GeographicTypeGeoKey)}`,
    );
  }
  const width = image.getWidth();
  const height = image.getHeight();
  const sampleCount = image.getSamplesPerPixel();
  const raster = await image.readRasters({ interleave: true });
  const samples = Array.from(raster, (value) => value);
  if (samples.length !== width * height * sampleCount) {
    throw schemaError('USGS 3DEP raster sample count does not match its dimensions');
  }
  const rawBounds = image.getBoundingBox();
  const boundsArray = [rawBounds[0], rawBounds[1], rawBounds[2], rawBounds[3]];
  if (boundsArray.some((value) => value === undefined)) {
    throw schemaError('USGS 3DEP raster is missing bounds');
  }
  const bounds = boundsArray as [number, number, number, number];
  if (
    !bounds.every(Number.isFinite) ||
    bounds[0] < -180 ||
    bounds[2] > 180 ||
    bounds[1] < -90 ||
    bounds[3] > 90 ||
    bounds[0] > bounds[2] ||
    bounds[1] > bounds[3]
  ) {
    throw schemaError('USGS 3DEP raster bounds are invalid');
  }
  const resolution = image.getResolution();
  const xResolution = resolution[0];
  const yResolution = resolution[1];
  if (
    typeof xResolution !== 'number' ||
    typeof yResolution !== 'number' ||
    !Number.isFinite(xResolution) ||
    !Number.isFinite(yResolution)
  ) {
    throw schemaError('USGS 3DEP raster resolution is invalid');
  }
  const noData = image.getGDALNoData();
  return Object.freeze({
    width,
    height,
    bands: Object.freeze(Array.from({ length: sampleCount }, (_, index) => index + 1)),
    samples: Object.freeze(samples),
    noDataValue: noData,
    bounds: Object.freeze(bounds),
    resolutionDegrees: Object.freeze([Math.abs(xResolution), Math.abs(yResolution)] as const),
    horizontalEpsg: 4326,
  });
}

/** Spools verified bytes once, then uses GeoTIFF window reads so sample arrays stay tile-bounded. */
export async function* decodeElevationGeoTiffTiles(
  chunks: AsyncIterable<Uint8Array>,
  expectedByteLength: number,
  signal: AbortSignal,
): AsyncIterable<DecodedElevationTile> {
  const workspace = await mkdtemp(join(tmpdir(), 'oracle-3dep-'));
  const path = resolve(workspace, 'source.tiff');
  const handle = await open(path, 'wx');
  let written = 0;
  try {
    for await (const chunk of chunks) {
      signal.throwIfAborted();
      written += chunk.byteLength;
      if (written > expectedByteLength) throw schemaError('USGS 3DEP stream exceeds acquired size');
      await handle.write(chunk);
    }
    await handle.sync();
    await handle.close();
    if (written !== expectedByteLength) throw schemaError('USGS 3DEP stream is truncated');
    const tiff = await fromFile(path, signal);
    try {
      const image = await tiff.getImage();
      const geoKeys = image.getGeoKeys();
      if (geoKeys?.GeographicTypeGeoKey !== 4326) {
        throw schemaError(
          `USGS 3DEP excerpt expected EPSG:4326, received ${String(geoKeys?.GeographicTypeGeoKey)}`,
        );
      }
      const width = image.getWidth();
      const height = image.getHeight();
      const sampleCount = image.getSamplesPerPixel();
      const rawBounds = image.getBoundingBox();
      const bounds = [rawBounds[0], rawBounds[1], rawBounds[2], rawBounds[3]] as Wgs84Bounds;
      if (!bounds.every(Number.isFinite)) throw schemaError('USGS 3DEP raster bounds are invalid');
      const resolution = image.getResolution();
      const xResolution = resolution[0];
      const yResolution = resolution[1];
      if (
        typeof xResolution !== 'number' ||
        typeof yResolution !== 'number' ||
        !Number.isFinite(xResolution) ||
        !Number.isFinite(yResolution)
      ) {
        throw schemaError('USGS 3DEP raster resolution is invalid');
      }
      const bands = Object.freeze(Array.from({ length: sampleCount }, (_, index) => index + 1));
      const noDataValue = image.getGDALNoData();
      for (let y = 0; y < height; y += ELEVATION_TILE_SIZE) {
        for (let x = 0; x < width; x += ELEVATION_TILE_SIZE) {
          signal.throwIfAborted();
          const tileWidth = Math.min(ELEVATION_TILE_SIZE, width - x);
          const tileHeight = Math.min(ELEVATION_TILE_SIZE, height - y);
          const raster = await image.readRasters({
            window: [x, y, x + tileWidth, y + tileHeight],
            interleave: true,
            signal,
          });
          const samples = Object.freeze(Array.from(raster, (value) => value));
          if (samples.length !== tileWidth * tileHeight * sampleCount) {
            throw schemaError('USGS 3DEP raster tile sample count does not match its dimensions');
          }
          const west = bounds[0] + x * Math.abs(xResolution);
          const east = west + tileWidth * Math.abs(xResolution);
          const north = bounds[3] - y * Math.abs(yResolution);
          const south = north - tileHeight * Math.abs(yResolution);
          yield Object.freeze({
            x,
            y,
            width: tileWidth,
            height: tileHeight,
            bands,
            samples,
            noDataValue,
            bounds: Object.freeze([west, south, east, north] as Wgs84Bounds),
            resolutionDegrees: Object.freeze([
              Math.abs(xResolution),
              Math.abs(yResolution),
            ] as const),
            horizontalEpsg: 4326 as const,
          });
        }
      }
    } finally {
      await tiff.close();
    }
  } finally {
    await handle.close().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
}

export function summarizeNoDataWindow(
  samples: readonly number[],
  noDataValue: number | null,
): Readonly<{
  validSamples: number;
  noDataSamples: number;
  minimum: number | null;
  maximum: number | null;
}> {
  const valid = samples.filter(
    (sample) => Number.isFinite(sample) && (noDataValue === null || sample !== noDataValue),
  );
  return Object.freeze({
    validSamples: valid.length,
    noDataSamples: samples.length - valid.length,
    minimum: valid.length === 0 ? null : Math.min(...valid),
    maximum: valid.length === 0 ? null : Math.max(...valid),
  });
}
