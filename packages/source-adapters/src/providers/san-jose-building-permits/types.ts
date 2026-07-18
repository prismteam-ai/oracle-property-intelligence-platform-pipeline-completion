import type { RunId, SnapshotId } from '@oracle/contracts/ids';
import type { SourceAsOf, SourceRunSummary } from '@oracle/contracts/source';
import type { Visibility } from '@oracle/contracts/visibility';
import type { CsvDecodedRecord } from '../../spi/decode.js';

import type { SAN_JOSE_CSV_HEADER, SanJosePermitFeed } from './constants.js';

export interface SanJoseBuildingPermitAdapterOptions {
  readonly runId: RunId;
  readonly normalizationTimestamp: string;
  /** A source-lock count. Omit when no independent snapshot denominator exists. */
  readonly expectedRecordCounts?: Readonly<Partial<Record<SanJosePermitFeed, number>>>;
  /** Hard ceiling for each production feed response. */
  readonly maximumResponseBytes?: number;
  /** Hard csv-parse ceiling for one logical CSV record, including quoted embedded newlines. */
  readonly maximumRecordBytes?: number;
}

export interface SanJoseDecodedPermitRecord extends CsvDecodedRecord {
  readonly feed: SanJosePermitFeed;
  readonly snapshotId: SnapshotId;
  readonly sourceAsOf: SourceAsOf;
  readonly retrievedAt: string;
  readonly recordKey: string;
  readonly recordSha256: string;
}

export type PermitTextClassification =
  | Readonly<{ classification: 'missing_or_placeholder'; text: null }>
  | Readonly<{
      classification: 'permit_applicant_text' | 'permit_contractor_text' | 'permit_owner_text';
      text: string;
      limitation: string;
    }>;

export interface SanJoseValidatedPermitRecord extends SanJoseDecodedPermitRecord {
  readonly raw: Readonly<Record<(typeof SAN_JOSE_CSV_HEADER)[number], string>>;
  readonly permitNumber: string;
  readonly sourceRowId: string;
  readonly sourceApn: string | null;
  readonly normalizedApn: string | null;
  readonly issuedAt: string | null;
  readonly finaledAt: string | null;
  readonly valuation: number | null;
  readonly applicant: PermitTextClassification;
  readonly owner: PermitTextClassification;
  readonly contractor: PermitTextClassification;
  readonly visibility: Visibility;
}

export interface SanJoseFeedSnapshotSummary {
  readonly feed: SanJosePermitFeed;
  readonly artifactCount: number;
  readonly acceptedRecords: number;
  readonly rejectedRecords: number;
  readonly decodedRecords: number;
  readonly byteSize: number;
  readonly sha256: string | null;
  readonly sourceAsOf: SourceAsOf | null;
  readonly lastModified: string | null;
}

export interface SanJoseBuildingPermitSummary {
  readonly source: SourceRunSummary;
  readonly scope: 'city_of_san_jose_jurisdiction_only';
  readonly feedSnapshots: readonly SanJoseFeedSnapshotSummary[];
  readonly limitations: readonly string[];
}
