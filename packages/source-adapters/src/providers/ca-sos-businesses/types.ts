import type { RunId, SnapshotId } from '@oracle/contracts/ids';
import type { SourceAsOf } from '@oracle/contracts/source';
import type { Visibility } from '@oracle/contracts/visibility';
import type { CsvDecodedRecord } from '../../spi/decode.js';

import type { CA_SOS_INTERCHANGE_HEADER } from './constants.js';

export type CaSosInterchangeColumn = (typeof CA_SOS_INTERCHANGE_HEADER)[number];

export interface CaSosBusinessSourceLock {
  /** Exact selected CSV path inside a ZIP; null only for a direct CSV artifact. */
  readonly csvEntryPath: string | null;
  /** Exact ordered raw provider header. Additional provider columns are retained in record hashing. */
  readonly orderedHeader: readonly string[];
  /** SHA-256 of orderedHeader joined with U+001F. */
  readonly schemaFingerprint: string;
  /** Complete one-to-one mapping from the frozen interchange to raw provider columns. */
  readonly fieldMapping: Readonly<Record<CaSosInterchangeColumn, string>>;
}

export interface CaSosBusinessAdapterOptions {
  readonly runId: RunId;
  readonly normalizationTimestamp: string;
  readonly bulkArtifactUrl: string;
  readonly sourceAsOf: string;
  readonly expectedSha256: string;
  readonly expectedRecordCount: number;
  readonly sourceVersion: string;
  readonly encoding: 'csv' | 'zip';
  readonly sourceLock: CaSosBusinessSourceLock;
  readonly maximumBytes?: number;
}

export interface CaSosDecodedBusinessRecord extends CsvDecodedRecord {
  readonly snapshotId: SnapshotId;
  readonly sourceAsOf: SourceAsOf;
  readonly retrievedAt: string;
  readonly sourceVersion: string;
  readonly recordKey: string;
  readonly recordSha256: string;
}

export type CaSosEntityNumberKind = 'legacy_numeric' | 'new_b_prefixed';

export interface CaSosValidatedBusinessRecord extends CaSosDecodedBusinessRecord {
  readonly raw: Readonly<Record<(typeof CA_SOS_INTERCHANGE_HEADER)[number], string>>;
  readonly entityNumber: string;
  readonly previousEntityNumber: string | null;
  readonly entityNumberKind: CaSosEntityNumberKind;
  readonly legalName: string;
  readonly businessType: string;
  readonly status: string;
  readonly initialFilingAt: string;
  readonly jurisdiction: string;
  readonly streetAddress: string | null;
  readonly mailingAddress: string | null;
  readonly agentName: string | null;
  readonly agentAddress: string | null;
  readonly sourceUpdatedAt: string | null;
  readonly visibility: Visibility;
}
