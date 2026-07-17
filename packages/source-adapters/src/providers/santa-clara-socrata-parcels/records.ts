import { createHash } from 'node:crypto';

import type { GeoMultiPolygon } from '@oracle/contracts/canonical/geospatial';
import type { SnapshotId, SourceId } from '@oracle/contracts/ids';
import type { Visibility } from '@oracle/contracts/visibility';
import type { GeoJsonDecodedRecord, JsonValue } from '../../spi/decode.js';

import { SANTA_CLARA_PARCELS_CRS } from './constants.js';

export interface SantaClaraParcelDecodedRecord extends GeoJsonDecodedRecord {
  readonly sourceId: SourceId;
  readonly snapshotId: SnapshotId;
  readonly retrievedAt: string;
  readonly sourceAsOfAt: string | null;
  readonly rowKey: string;
  readonly crs: string;
  readonly rawFeatureSha256: string;
}

export interface SantaClaraParcelValidatedRecord {
  readonly sourceId: SourceId;
  readonly snapshotId: SnapshotId;
  readonly artifactId: SantaClaraParcelDecodedRecord['artifactId'];
  readonly retrievedAt: string;
  readonly sourceAsOfAt: string | null;
  readonly ordinal: number;
  readonly rowKey: string;
  readonly objectId: number;
  readonly rawFeatureSha256: string;
  readonly visibility: Visibility;
  readonly apn: string;
  readonly jurisdiction: string;
  readonly geometry: GeoMultiPolygon;
  readonly properties: Readonly<Record<string, JsonValue>>;
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

export function stableJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (isJsonArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeSantaClaraParcelApn(input: string): string | null {
  const normalized = input.trim().replace(/[\s-]/gu, '').toUpperCase();
  return /^\d{8}$/u.test(normalized) ? normalized : null;
}

function isFiniteCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parsePosition(value: JsonValue): readonly [number, number] | null {
  if (!isJsonArray(value) || value.length !== 2) {
    return null;
  }
  const longitude = value[0];
  const latitude = value[1];
  if (!isFiniteCoordinate(longitude) || !isFiniteCoordinate(latitude)) {
    return null;
  }
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    return null;
  }
  return [longitude, latitude] as const;
}

function parseRing(value: JsonValue): readonly (readonly [number, number])[] | null {
  if (!isJsonArray(value) || value.length < 4) {
    return null;
  }
  const positions = value.map((position) => parsePosition(position));
  if (!positions.every((position): position is readonly [number, number] => position !== null)) {
    return null;
  }
  const first = positions[0];
  const last = positions.at(-1);
  if (first?.[0] !== last?.[0] || first?.[1] !== last?.[1]) {
    return null;
  }
  return positions;
}

function parsePolygon(
  value: JsonValue,
): readonly (readonly (readonly [number, number])[])[] | null {
  if (!isJsonArray(value) || value.length === 0) {
    return null;
  }
  const rings = value.map((ring) => parseRing(ring));
  return rings.every((ring): ring is readonly (readonly [number, number])[] => ring !== null)
    ? rings
    : null;
}

export function parseCrs84MultiPolygon(
  geometry: SantaClaraParcelDecodedRecord['geometry'],
  crs: string,
): GeoMultiPolygon | null {
  if (crs !== SANTA_CLARA_PARCELS_CRS || geometry?.type !== 'MultiPolygon') {
    return null;
  }
  const coordinates = geometry.coordinates;
  if (!isJsonArray(coordinates) || coordinates.length === 0) {
    return null;
  }
  const polygons = coordinates.map((polygon) => parsePolygon(polygon));
  if (
    !polygons.every(
      (polygon): polygon is readonly (readonly (readonly [number, number])[])[] => polygon !== null,
    )
  ) {
    return null;
  }
  return {
    type: 'MultiPolygon',
    coordinates: polygons.map((polygon) =>
      polygon.map((ring) => ring.map(([longitude, latitude]) => [longitude, latitude])),
    ),
  };
}
