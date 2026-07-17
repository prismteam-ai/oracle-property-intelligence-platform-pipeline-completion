import type { ArtifactId, SnapshotId, SourceId } from '@oracle/contracts/ids';
import type { Visibility } from '@oracle/contracts/visibility';
import type { CsvDecodedRecord } from '../../spi/decode.js';

export type OwnershipCapabilitySupportState = 'complete' | 'partial' | 'blocked';

export interface OwnershipCapabilityPageEvidence {
  readonly key: string;
  readonly url: string;
  readonly retrievedAt: string;
  readonly lastModified: string | null;
  readonly sha256: string;
  readonly byteSize: number;
}

export interface OwnershipTransferCapability {
  readonly schemaVersion: '1.0.0';
  readonly sourceId: SourceId;
  readonly sourceAuthority: 'County of Santa Clara Office of the Clerk-Recorder';
  readonly sourceProduct: 'Grantor and grantee index';
  readonly sourceVersion: string;
  readonly supportState: OwnershipCapabilitySupportState;
  readonly measuredAt: string;
  readonly access: Readonly<{
    route: 'paid_sftp_subscription';
    unauthenticatedBulkOrApi: false;
    subscriptionRequired: true;
    currentSnapshotAcquired: boolean;
  }>;
  readonly actualSourceFields: Readonly<{
    partyName: 'available';
    partyRole: 'grantor_or_grantee';
    instrumentDocumentNumber: 'available';
    recordingDate: 'available';
    documentType: 'available';
    apn: 'not_in_standard_index';
    address: 'not_in_standard_index';
  }>;
  readonly coverage: Readonly<{
    startsOn: string | null;
    endsOn: string | null;
    expectedRecords: number | null;
    observedRecords: number;
    titleTransferDocumentCoverage: 'complete' | 'partial' | 'unknown';
    propertyLinkage: 'authoritative_apn' | 'address_candidate' | 'none';
    chainCompleteness: 'verified' | 'partial' | 'unknown';
  }>;
  readonly defaultVisibility: 'restricted';
  readonly publicProjection: 'denied';
  readonly restrictions: readonly string[];
  readonly lineage: readonly OwnershipCapabilityPageEvidence[];
}

export interface OwnershipIndexRow {
  readonly sourceId: SourceId;
  readonly sourceVersion: string;
  readonly artifactId: ArtifactId;
  readonly ordinal: number;
  readonly instrumentDocumentNumber: string;
  readonly recordingDate: string;
  readonly documentType: string;
  readonly partyRole: 'grantor' | 'grantee';
  readonly partyName: string;
  readonly apn: null;
  readonly address: null;
  readonly visibility: 'restricted';
  readonly lineage: Readonly<{
    recordKey: string;
    recordSha256: string;
    rawPointer: string;
  }>;
}

export interface OwnershipIndexValidationFailure {
  readonly status: 'rejected';
  readonly issues: readonly Readonly<{
    code: string;
    field: string;
    message: string;
  }>[];
}

export interface OwnershipIndexValidationSuccess {
  readonly status: 'accepted';
  readonly record: OwnershipIndexRow;
}

export type OwnershipIndexValidation =
  OwnershipIndexValidationFailure | OwnershipIndexValidationSuccess;

export interface OwnershipExchangeEvidenceResult {
  readonly supportState: 'supported' | 'unknown' | 'unsupported';
  readonly noRecordedExchangeInInterval: boolean | null;
  readonly interval: Readonly<{ startsOn: string; endsOn: string }>;
  readonly latestVerifiedTransferDate: string | null;
  readonly sourceVersion: string;
  readonly evidenceDocumentNumbers: readonly string[];
  readonly limitations: readonly string[];
  readonly visibility: 'restricted';
}

/** The blocked SPI never decodes rows; this type keeps the frozen SPI generic explicit. */
export interface OwnershipCapabilityDecodedRecord extends CsvDecodedRecord {
  readonly snapshotId: SnapshotId;
  readonly recordKey: string;
  readonly recordSha256: string;
}

export interface OwnershipCapabilityValidatedRecord extends OwnershipCapabilityDecodedRecord {
  readonly visibility: Visibility;
}
