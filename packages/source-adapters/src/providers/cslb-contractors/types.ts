import type { RunId, SnapshotId } from '@oracle/contracts/ids';
import type { SourceAsOf } from '@oracle/contracts/source';
import type { CsvDecodedRecord } from '../../spi/decode.js';

import type { CslbMasterField } from './constants.js';

export interface CslbContractorAdapterOptions {
  readonly runId: RunId;
  readonly normalizationTimestamp: string;
  /** Independent source-lock denominator; omit when the portal publishes none. */
  readonly expectedRecordCount?: number;
  /** Fails closed before an unexpectedly large response exhausts memory. */
  readonly maximumArtifactBytes?: number;
}

export interface CslbDecodedContractorRecord extends CsvDecodedRecord {
  readonly snapshotId: SnapshotId;
  readonly sourceAsOf: SourceAsOf;
  readonly retrievedAt: string;
  readonly recordKey: string;
  readonly recordSha256: string;
}

export interface CslbValidatedContractorRecord extends CslbDecodedContractorRecord {
  readonly raw: Readonly<Record<CslbMasterField, string>>;
  readonly licenseNumber: string;
  readonly legalName: string;
  readonly classifications: readonly string[];
  readonly status: string;
  readonly lastUpdatedAt: string;
  readonly issueDate: string;
  readonly expirationDate: string;
}
