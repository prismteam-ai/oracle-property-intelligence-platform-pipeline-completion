import type { CanonicalMutation } from '@oracle/contracts/canonical/mutation';
import type { GeoMultiPolygon } from '@oracle/contracts/canonical/geospatial';
import type { SnapshotId } from '@oracle/contracts/ids';
import type { ValidationIssue } from '@oracle/contracts/source';
import type { GeoJsonDecodedRecord, JsonValue } from '../../spi/decode.js';

export type MtcPaloAltoRawRow = Readonly<Record<string, JsonValue>>;

export type MtcPaloAltoDecodedRecord = GeoJsonDecodedRecord &
  Readonly<{
    snapshotId: SnapshotId;
    retrievedAt: string;
    sourceAsOf: string | null;
    recordKey: string;
    recordSha256: string;
    rawPointer: string;
    raw: MtcPaloAltoRawRow;
  }>;

export interface MtcPaloAltoValidatedRecord {
  readonly visibility: 'prohibited_public';
  readonly artifactId: MtcPaloAltoDecodedRecord['artifactId'];
  readonly snapshotId: SnapshotId;
  readonly retrievedAt: string;
  readonly sourceAsOf: string | null;
  readonly ordinal: number;
  readonly recordKey: string;
  readonly recordSha256: string;
  readonly rawPointer: string;
  readonly raw: MtcPaloAltoRawRow;
  readonly objectId: string;
  readonly gid: string | null;
  readonly apnInput: string;
  readonly canonicalApn: string;
  readonly yearBuilt: number | null;
  readonly effectiveYearBuilt: number | null;
  readonly zoning: string | null;
  readonly floodZone: string | null;
  readonly nearCreek: string | null;
  readonly addressDescription: string | null;
  readonly modifiedAt: string | null;
  readonly sourceCoordinates: Readonly<{
    x: number;
    y: number;
    crs: 'EPSG:2227';
    semantics: 'label_point';
  }>;
  readonly geometry: GeoMultiPolygon;
  readonly issues: readonly ValidationIssue[];
}

export type MtcPaloAltoMutation = CanonicalMutation;
