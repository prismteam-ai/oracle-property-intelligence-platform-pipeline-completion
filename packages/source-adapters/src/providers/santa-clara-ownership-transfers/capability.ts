import { createHash } from 'node:crypto';

import { artifactIdSchema } from '@oracle/contracts/ids';

import { OWNERSHIP_CAPABILITY_SCHEMA_VERSION, OWNERSHIP_TRANSFER_SOURCE_ID } from './constants.js';
import type {
  OwnershipCapabilityPageEvidence,
  OwnershipCapabilitySupportState,
  OwnershipExchangeEvidenceResult,
  OwnershipIndexRow,
  OwnershipIndexValidation,
  OwnershipTransferCapability,
} from './types.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const DOCUMENT_NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9-]{3,31}$/u;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const object = value as Readonly<Record<string, unknown>>;
  return `{${Object.entries(object)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function requiredDate(value: string, label: string): string {
  if (!isDate(value)) throw new TypeError(`${label} must be a valid YYYY-MM-DD date`);
  return value;
}

function capabilityVersion(lineage: readonly OwnershipCapabilityPageEvidence[]): string {
  return `sha256:${sha256(
    lineage
      .map((page) => `${page.key}\u0000${page.url}\u0000${page.sha256}`)
      .sort()
      .join('\n'),
  )}`;
}

export function createOwnershipTransferCapability(
  input: Readonly<{
    supportState: OwnershipCapabilitySupportState;
    measuredAt: string;
    lineage: readonly OwnershipCapabilityPageEvidence[];
    currentSnapshotAcquired?: boolean;
    startsOn?: string | null;
    endsOn?: string | null;
    expectedRecords?: number | null;
    observedRecords?: number;
    titleTransferDocumentCoverage?: 'complete' | 'partial' | 'unknown';
    propertyLinkage?: 'authoritative_apn' | 'address_candidate' | 'none';
    chainCompleteness?: 'verified' | 'partial' | 'unknown';
  }>,
): OwnershipTransferCapability {
  const startsOn = input.startsOn ?? null;
  const endsOn = input.endsOn ?? null;
  if (startsOn !== null) requiredDate(startsOn, 'coverage startsOn');
  if (endsOn !== null) requiredDate(endsOn, 'coverage endsOn');
  if (startsOn !== null && endsOn !== null && startsOn > endsOn) {
    throw new RangeError('Ownership coverage interval is reversed');
  }
  const expectedRecords = input.expectedRecords ?? null;
  const observedRecords = input.observedRecords ?? 0;
  if (expectedRecords !== null && (!Number.isSafeInteger(expectedRecords) || expectedRecords < 0)) {
    throw new RangeError('expectedRecords must be null or a non-negative safe integer');
  }
  if (!Number.isSafeInteger(observedRecords) || observedRecords < 0) {
    throw new RangeError('observedRecords must be a non-negative safe integer');
  }
  if (expectedRecords !== null && observedRecords > expectedRecords) {
    throw new RangeError('observedRecords cannot exceed expectedRecords');
  }

  return Object.freeze({
    schemaVersion: OWNERSHIP_CAPABILITY_SCHEMA_VERSION,
    sourceId: OWNERSHIP_TRANSFER_SOURCE_ID,
    sourceAuthority: 'County of Santa Clara Office of the Clerk-Recorder',
    sourceProduct: 'Grantor and grantee index',
    sourceVersion: capabilityVersion(input.lineage),
    supportState: input.supportState,
    measuredAt: input.measuredAt,
    access: Object.freeze({
      route: 'paid_sftp_subscription',
      unauthenticatedBulkOrApi: false,
      subscriptionRequired: true,
      currentSnapshotAcquired: input.currentSnapshotAcquired ?? false,
    }),
    actualSourceFields: Object.freeze({
      partyName: 'available',
      partyRole: 'grantor_or_grantee',
      instrumentDocumentNumber: 'available',
      recordingDate: 'available',
      documentType: 'available',
      apn: 'not_in_standard_index',
      address: 'not_in_standard_index',
    }),
    coverage: Object.freeze({
      startsOn,
      endsOn,
      expectedRecords,
      observedRecords,
      titleTransferDocumentCoverage: input.titleTransferDocumentCoverage ?? 'unknown',
      propertyLinkage: input.propertyLinkage ?? 'none',
      chainCompleteness: input.chainCompleteness ?? 'unknown',
    }),
    defaultVisibility: 'restricted',
    publicProjection: 'denied',
    restrictions: Object.freeze([
      'No anonymous bulk or API ownership snapshot is supplied by the official route.',
      'The standard index is a paid SFTP subscription and no subscribed snapshot is available to this run.',
      'The standard index omits address and APN, so its rows cannot independently establish property linkage.',
      'The index mixes recorded-document types; grantor/grantee rows are transfer evidence, not a complete current ownership chain.',
      'Permit owner text is not current ownership evidence and is not consumed by this capability.',
      'Owner-bearing party names have no approved public redistribution or irreversible publication basis.',
      'Missing rows cannot support a no-exchange conclusion without measured complete interval and chain coverage.',
    ]),
    lineage: Object.freeze([...input.lineage]),
  });
}

export function validateOwnershipIndexRow(
  input: Readonly<Record<string, unknown>>,
): OwnershipIndexValidation {
  const issues: { code: string; field: string; message: string }[] = [];
  const documentNumber =
    typeof input.instrumentDocumentNumber === 'string'
      ? input.instrumentDocumentNumber.trim().toUpperCase()
      : '';
  const recordingDate = typeof input.recordingDate === 'string' ? input.recordingDate.trim() : '';
  const documentType = typeof input.documentType === 'string' ? input.documentType.trim() : '';
  const partyName = typeof input.partyName === 'string' ? input.partyName.trim() : '';
  const partyRole = input.partyRole;
  const sourceVersion = typeof input.sourceVersion === 'string' ? input.sourceVersion.trim() : '';
  const ordinal = input.ordinal;

  if (!DOCUMENT_NUMBER_PATTERN.test(documentNumber)) {
    issues.push({
      code: 'MALFORMED_DOCUMENT_NUMBER',
      field: 'instrumentDocumentNumber',
      message: 'Expected a 4-32 character official document identifier',
    });
  }
  if (!isDate(recordingDate)) {
    issues.push({
      code: 'MALFORMED_RECORDING_DATE',
      field: 'recordingDate',
      message: 'Expected a real YYYY-MM-DD recording date',
    });
  }
  if (documentType.length === 0) {
    issues.push({
      code: 'MISSING_DOCUMENT_TYPE',
      field: 'documentType',
      message: 'Document type is required to qualify transfer evidence',
    });
  }
  if (partyRole !== 'grantor' && partyRole !== 'grantee') {
    issues.push({
      code: 'MALFORMED_PARTY_ROLE',
      field: 'partyRole',
      message: 'Party role must be grantor or grantee',
    });
  }
  if (partyName.length === 0) {
    issues.push({
      code: 'MISSING_PARTY_NAME',
      field: 'partyName',
      message: 'Official index party name is required',
    });
  }
  if (input.apn !== null && input.apn !== undefined) {
    issues.push({
      code: 'UNSUPPORTED_APN_FIELD',
      field: 'apn',
      message: 'The standard official index does not provide APN',
    });
  }
  if (input.address !== null && input.address !== undefined) {
    issues.push({
      code: 'UNSUPPORTED_ADDRESS_FIELD',
      field: 'address',
      message: 'The standard official index does not provide address',
    });
  }
  if (!Number.isSafeInteger(ordinal) || (ordinal as number) < 1) {
    issues.push({
      code: 'MALFORMED_ORDINAL',
      field: 'ordinal',
      message: 'Ordinal must be a positive safe integer',
    });
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(sourceVersion)) {
    issues.push({
      code: 'MALFORMED_SOURCE_VERSION',
      field: 'sourceVersion',
      message: 'Source version must be a SHA-256 identifier',
    });
  }

  const artifactHash = typeof input.artifactSha256 === 'string' ? input.artifactSha256 : '';
  const artifactId = artifactIdSchema.safeParse(`sc:artifact:sha256:${artifactHash}`);
  if (!artifactId.success) {
    issues.push({
      code: 'MALFORMED_ARTIFACT_HASH',
      field: 'artifactSha256',
      message: 'Artifact hash must be SHA-256',
    });
  }
  if (
    issues.length > 0 ||
    !artifactId.success ||
    (partyRole !== 'grantor' && partyRole !== 'grantee')
  ) {
    return Object.freeze({ status: 'rejected', issues: Object.freeze(issues) });
  }
  const recordKey = `${documentNumber}:${recordingDate}:${partyRole}:${ordinal as number}`;
  const recordPayload = {
    documentNumber,
    recordingDate,
    documentType,
    partyRole,
    partyName,
    ordinal,
  };
  const recordSha256 = sha256(canonicalJson(recordPayload));

  return Object.freeze({
    status: 'accepted',
    record: Object.freeze({
      sourceId: OWNERSHIP_TRANSFER_SOURCE_ID,
      sourceVersion,
      artifactId: artifactId.data,
      ordinal: ordinal as number,
      instrumentDocumentNumber: documentNumber,
      recordingDate,
      documentType,
      partyRole,
      partyName,
      apn: null,
      address: null,
      visibility: 'restricted',
      lineage: Object.freeze({
        recordKey,
        recordSha256,
        rawPointer: `/rows/${(ordinal as number) - 1}`,
      }),
    }),
  });
}

export function deduplicateOwnershipIndexRows(
  rows: readonly OwnershipIndexRow[],
): readonly OwnershipIndexRow[] {
  const byIdentity = new Map<string, OwnershipIndexRow>();
  for (const row of rows) {
    const identity = [
      row.instrumentDocumentNumber,
      row.recordingDate,
      row.partyRole,
      row.partyName.trim().toLocaleUpperCase('en-US'),
    ].join('\u0000');
    const existing = byIdentity.get(identity);
    if (existing === undefined || row.lineage.recordSha256 < existing.lineage.recordSha256) {
      byIdentity.set(identity, row);
    }
  }
  return Object.freeze(
    [...byIdentity.values()].sort((left, right) =>
      [left.recordingDate, left.instrumentDocumentNumber, left.partyRole, left.partyName]
        .join('\u0000')
        .localeCompare(
          [
            right.recordingDate,
            right.instrumentDocumentNumber,
            right.partyRole,
            right.partyName,
          ].join('\u0000'),
        ),
    ),
  );
}

function subtractYears(date: string, years: number): string {
  requiredDate(date, 'asOf');
  if (!Number.isSafeInteger(years) || years < 1 || years > 200) {
    throw new RangeError('years must be an integer between 1 and 200');
  }
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const targetYear = year - years;
  const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
  return `${targetYear.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${Math.min(day, lastDay).toString().padStart(2, '0')}`;
}

export function assessNoRecordedExchange(
  input: Readonly<{
    capability: OwnershipTransferCapability;
    rows: readonly OwnershipIndexRow[];
    verifiedTransferDocumentNumbers: readonly string[];
    asOf: string;
    years?: number;
  }>,
): OwnershipExchangeEvidenceResult {
  const endsOn = requiredDate(input.asOf, 'asOf');
  const startsOn = subtractYears(endsOn, input.years ?? 10);
  const interval = Object.freeze({ startsOn, endsOn });
  const base = {
    interval,
    sourceVersion: input.capability.sourceVersion,
    visibility: 'restricted' as const,
  };

  if (input.capability.supportState === 'blocked') {
    return Object.freeze({
      ...base,
      supportState: 'unsupported',
      noRecordedExchangeInInterval: null,
      latestVerifiedTransferDate: null,
      evidenceDocumentNumbers: Object.freeze([]),
      limitations: input.capability.restrictions,
    });
  }

  const coverage = input.capability.coverage;
  const sufficient =
    input.capability.supportState === 'complete' &&
    input.capability.access.currentSnapshotAcquired &&
    coverage.expectedRecords !== null &&
    coverage.observedRecords === coverage.expectedRecords &&
    coverage.startsOn !== null &&
    coverage.startsOn <= startsOn &&
    coverage.endsOn !== null &&
    coverage.endsOn >= endsOn &&
    coverage.titleTransferDocumentCoverage === 'complete' &&
    coverage.propertyLinkage === 'authoritative_apn' &&
    coverage.chainCompleteness === 'verified';
  if (!sufficient) {
    return Object.freeze({
      ...base,
      supportState: 'unknown',
      noRecordedExchangeInInterval: null,
      latestVerifiedTransferDate: null,
      evidenceDocumentNumbers: Object.freeze([]),
      limitations: Object.freeze([
        'No-exchange evidence requires complete title-transfer coverage, authoritative APN linkage, a verified chain, and a coverage interval spanning the query.',
      ]),
    });
  }

  const mismatchedLineage = input.rows.some(
    (row) =>
      row.sourceId !== input.capability.sourceId ||
      row.sourceVersion !== input.capability.sourceVersion,
  );
  if (mismatchedLineage) {
    return Object.freeze({
      ...base,
      supportState: 'unknown',
      noRecordedExchangeInInterval: null,
      latestVerifiedTransferDate: null,
      evidenceDocumentNumbers: Object.freeze([]),
      limitations: Object.freeze([
        'Every ownership row must match the capability source identity and immutable source version; cross-source or cross-snapshot rows cannot support an interval conclusion.',
      ]),
    });
  }

  const deduplicatedRows = deduplicateOwnershipIndexRows(input.rows);
  const availableDocuments = new Set(deduplicatedRows.map((row) => row.instrumentDocumentNumber));
  const verifiedDocuments = new Set(input.verifiedTransferDocumentNumbers);
  if ([...verifiedDocuments].some((documentNumber) => !availableDocuments.has(documentNumber))) {
    return Object.freeze({
      ...base,
      supportState: 'unknown',
      noRecordedExchangeInInterval: null,
      latestVerifiedTransferDate: null,
      evidenceDocumentNumbers: Object.freeze([]),
      limitations: Object.freeze([
        'Verified title-transfer identifiers must resolve to source rows before the interval can be assessed.',
      ]),
    });
  }
  const qualifyingRows = deduplicatedRows.filter(
    (row) =>
      verifiedDocuments.has(row.instrumentDocumentNumber) &&
      row.recordingDate >= startsOn &&
      row.recordingDate <= endsOn,
  );
  const dates = qualifyingRows.map((row) => row.recordingDate).sort();
  const latestVerifiedTransferDate = dates.at(-1) ?? null;
  return Object.freeze({
    ...base,
    supportState: 'supported',
    noRecordedExchangeInInterval: qualifyingRows.length === 0,
    latestVerifiedTransferDate,
    evidenceDocumentNumbers: Object.freeze(
      [...new Set(qualifyingRows.map((row) => row.instrumentDocumentNumber))].sort(),
    ),
    limitations: Object.freeze([
      'The conclusion is limited to recorded title-transfer evidence in the declared complete source interval; it is not a title opinion.',
    ]),
  });
}

export function projectOwnershipRows(
  rows: readonly OwnershipIndexRow[],
  visibility: 'public' | 'authenticated' | 'restricted',
): readonly OwnershipIndexRow[] {
  if (visibility !== 'restricted') {
    throw Object.assign(new Error('Owner-bearing grantor/grantee rows are restricted'), {
      code: 'RESTRICTED_DATA_LEAK' as const,
      retryable: false as const,
      message: 'Owner-bearing grantor/grantee rows are restricted and cannot be projected publicly',
      sourceId: OWNERSHIP_TRANSFER_SOURCE_ID,
      phase: 'normalize',
    });
  }
  return Object.freeze([...rows]);
}
