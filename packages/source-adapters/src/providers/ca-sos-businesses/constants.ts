import { createHash } from 'node:crypto';

import {
  licenseSnapshotIdSchema,
  schemaFingerprintValueSchema,
  sourceIdSchema,
} from '@oracle/contracts/ids';
import { sourceDescriptorSchema } from '@oracle/contracts/source';

export const CA_SOS_BUSINESS_SOURCE_ID = sourceIdSchema.parse('sc:source:ca-sos-businesses');

export const CA_SOS_BUSINESS_LICENSE_ID = licenseSnapshotIdSchema.parse(
  'sc:license:ca-sos-businesses:112766f8e79387c920de93678f2b1f92dd196358acf9ee2d156242f7fbf6e86e',
);

export const CA_SOS_CONTRACT_VERSION = '2.0.0';
export const CA_SOS_TRANSFORM_VERSION = '1.0.0';

/**
 * Stable interchange header used by the adapter. A source-lock step maps the
 * exact columns in an ordered bizfile bulk export to this lossless shape and
 * records both schemas. Unknown or missing columns fail closed.
 */
export const CA_SOS_INTERCHANGE_HEADER = [
  'ENTITY_NUMBER',
  'PREVIOUS_ENTITY_NUMBER',
  'ENTITY_NAME',
  'ENTITY_TYPE',
  'STATUS',
  'INITIAL_FILING_DATE',
  'JURISDICTION',
  'STREET_ADDRESS',
  'MAILING_ADDRESS',
  'AGENT_NAME',
  'AGENT_ADDRESS',
  'SOURCE_UPDATED_DATE',
] as const;

export const CA_SOS_SCHEMA_FINGERPRINT = schemaFingerprintValueSchema.parse(
  createHash('sha256').update(CA_SOS_INTERCHANGE_HEADER.join('\u001f')).digest('hex'),
);

export const CA_SOS_BUSINESS_DESCRIPTOR = sourceDescriptorSchema.parse({
  sourceId: CA_SOS_BUSINESS_SOURCE_ID,
  contractVersion: CA_SOS_CONTRACT_VERSION,
  name: 'California Secretary of State bizfile business-entity bulk export',
  authority: {
    authorityType: 'official_government',
    organization: 'California Secretary of State, Business Programs Division',
    jurisdiction: 'California',
    canonicalUrl:
      'https://www.sos.ca.gov/administration/public-records-act-requests/business-entity-records',
    authorityRank: 100,
  },
  acquisitionMethod: 'bulk_download',
  encodings: ['csv', 'zip'],
  entityKinds: ['business'],
  defaultVisibility: 'prohibited_public',
  license: {
    licenseSnapshotId: CA_SOS_BUSINESS_LICENSE_ID,
    capturedAt: '2026-07-17T00:00:00.000Z',
    title: 'California SOS business-entity bulk order and public-record limitations',
    canonicalUrl:
      'https://www.sos.ca.gov/administration/public-records-act-requests/business-entity-records',
    termsSha256: '112766f8e79387c920de93678f2b1f92dd196358acf9ee2d156242f7fbf6e86e',
    redistribution: 'unknown',
    containsPersonalData: true,
    attribution: ['California Secretary of State, Business Programs Division'],
    limitations: [
      'Bulk orders are requested and downloaded through an authenticated bizfile Online account.',
      'The Secretary of State does not collect beneficial ownership information.',
      'Addresses and agent fields remain prohibited_public until a release-specific legal review.',
    ],
  },
  ratePolicy: {
    maxRequestsPerWindow: 1,
    windowMs: 1_000,
    maxConcurrency: 1,
    maxAttempts: 3,
    initialBackoffMs: 250,
    maxBackoffMs: 2_000,
    jitter: 'none',
    respectRetryAfter: true,
  },
  freshnessSemantics:
    'The source-as-of instant is supplied by the ordered master/weekly export manifest and bound into the snapshot request.',
});
