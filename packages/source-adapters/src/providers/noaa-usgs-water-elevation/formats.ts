import { unzipSync } from 'fflate';
import { fromArrayBuffer } from 'geotiff';

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

function schemaError(message: string): Error {
  return new Error(`SCHEMA_DRIFT: ${message}`);
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

function assertNoaaProjection(prj: Uint8Array): void {
  const projection = Buffer.from(prj).toString('utf8');
  if (!/WGS[_ ]1984|WGS[_ ]84/iu.test(projection)) {
    throw schemaError('NOAA archive projection is not recognized as WGS 84');
  }
}

export function decodeNoaaShorelineArchive(
  bytes: Uint8Array,
  clipBounds: Wgs84Bounds,
): readonly RawVectorFeature[] {
  let entries: Readonly<Record<string, Uint8Array>>;
  try {
    entries = unzipSync(bytes);
  } catch (error) {
    throw schemaError(`NOAA archive is not a valid ZIP: ${String(error)}`);
  }
  const shp = Buffer.from(entry(entries, '.shp'));
  const dbf = Buffer.from(entry(entries, '.dbf'));
  assertNoaaProjection(entry(entries, '.prj'));

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
              Object.freeze([
                shp.readDoubleLE(pointsOffset + pointIndex * 16),
                shp.readDoubleLE(pointsOffset + pointIndex * 16 + 8),
              ]),
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

export function decodeHydroFeatureCollection(
  bytes: Uint8Array,
  clipBounds: Wgs84Bounds,
): readonly RawVectorFeature[] {
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
    const feature = jsonRecord(featureValue, `feature ${ordinal}`);
    const properties = jsonValueRecord(
      jsonRecord(feature.properties, `feature ${ordinal} properties`),
    );
    const id3dhp = properties.id3dhp;
    if (typeof id3dhp !== 'string' || id3dhp.length === 0) {
      throw schemaError(`USGS 3DHP feature ${ordinal} is missing id3dhp`);
    }
    if (identifiers.has(id3dhp)) {
      throw schemaError(`Duplicate USGS 3DHP id3dhp ${id3dhp}`);
    }
    identifiers.add(id3dhp);
    const geometryValue = jsonRecord(feature.geometry, `feature ${ordinal} geometry`);
    if (typeof geometryValue.type !== 'string' || !('coordinates' in geometryValue)) {
      throw schemaError(`USGS 3DHP feature ${ordinal} geometry is malformed`);
    }
    const geometry = parseSupportedGeometry(
      {
        type: geometryValue.type,
        coordinates: geometryValue.coordinates as JsonValue,
      },
      4326,
    );
    if (geometryIntersectsBounds(geometry, clipBounds)) {
      records.push(Object.freeze({ recordKey: id3dhp, geometry, properties }));
    }
  }
  return Object.freeze(records);
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = Uint8Array.from(bytes);
  return copy.buffer;
}

export async function decodeElevationGeoTiff(bytes: Uint8Array): Promise<DecodedElevationImage> {
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
