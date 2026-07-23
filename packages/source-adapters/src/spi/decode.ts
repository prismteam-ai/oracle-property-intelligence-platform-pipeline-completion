import type { ArtifactId } from '@oracle/contracts/ids';
import type { Visibility } from '@oracle/contracts/visibility';

import type { ImmutableBytes } from './bytes.js';

export type JsonScalar = null | boolean | number | string;
export type JsonValue = JsonScalar | readonly JsonValue[] | Readonly<{ [key: string]: JsonValue }>;

interface DecodedRecordBase {
  readonly artifactId: ArtifactId;
  readonly ordinal: number;
  readonly visibility: Visibility;
}

export interface CsvDecodedRecord extends DecodedRecordBase {
  readonly format: 'csv';
  readonly header: readonly string[];
  readonly values: readonly string[];
}

export interface ZipDecodedRecord extends DecodedRecordBase {
  readonly format: 'zip';
  readonly entryPath: string;
  readonly mediaType: string;
  readonly bytes: ImmutableBytes;
}

export interface GeoJsonDecodedRecord extends DecodedRecordBase {
  readonly format: 'geojson';
  readonly featureType: 'Feature';
  readonly geometry: Readonly<{
    type: string;
    coordinates: JsonValue;
  }> | null;
  readonly properties: Readonly<Record<string, JsonValue>>;
}

export interface PbfDecodedRecord extends DecodedRecordBase {
  readonly format: 'pbf';
  readonly layer: string;
  readonly featureId: string | number | null;
  readonly geometryType: 'point' | 'line' | 'polygon' | 'unknown';
  readonly properties: Readonly<Record<string, JsonValue>>;
}

export interface GeoTiffDecodedRecord extends DecodedRecordBase {
  readonly format: 'geotiff';
  readonly imageIndex: number;
  readonly tile: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  readonly bands: readonly number[];
  readonly samples: readonly number[];
  readonly noDataValue: number | null;
}

export type DecodedRecord =
  | CsvDecodedRecord
  | ZipDecodedRecord
  | GeoJsonDecodedRecord
  | PbfDecodedRecord
  | GeoTiffDecodedRecord;
