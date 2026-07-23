import { createHash } from 'node:crypto';

import {
  licenseSnapshotIdSchema,
  schemaFingerprintValueSchema,
  sourceIdSchema,
} from '@oracle/contracts/ids';

export const OWNERSHIP_TRANSFER_SOURCE_ID = sourceIdSchema.parse(
  'sc:source:santa-clara-ownership-transfers',
);

export const OWNERSHIP_DATA_SALES_URL =
  'https://clerkrecorder.santaclaracounty.gov/official-records/subscribe-data-sales-reports/additional-information-related-data-sales';
export const OWNERSHIP_RESEARCH_URL =
  'https://clerkrecorder.santaclaracounty.gov/official-records/researching-real-estate-documents/request-and-purchase-copies-recorded-documents/additional-information-related-to-purchasing';
export const OWNERSHIP_FEE_SCHEDULE_URL =
  'https://clerkrecorder.santaclaracounty.gov/resources/fee-schedule';

export const OWNERSHIP_CAPABILITY_CAPTURED_AT = '2026-07-17T00:00:00.000Z';
export const OWNERSHIP_CAPABILITY_SCHEMA_VERSION = '1.0.0';

const RIGHTS_SNAPSHOT = [
  OWNERSHIP_CAPABILITY_CAPTURED_AT,
  OWNERSHIP_DATA_SALES_URL,
  OWNERSHIP_RESEARCH_URL,
  OWNERSHIP_FEE_SCHEDULE_URL,
  'paid-sftp-subscription',
  'party-name-document-number-recording-date-document-type',
  'standard-index-omits-address-and-apn',
  'redistribution-not-approved',
].join('\n');

const RIGHTS_SHA256 = createHash('sha256').update(RIGHTS_SNAPSHOT).digest('hex');

export const OWNERSHIP_TRANSFER_LICENSE_SNAPSHOT_ID = licenseSnapshotIdSchema.parse(
  `sc:license:santa-clara-ownership-transfers:${RIGHTS_SHA256}`,
);

export const OWNERSHIP_CAPABILITY_SCHEMA_FINGERPRINT = schemaFingerprintValueSchema.parse(
  createHash('sha256')
    .update(
      [
        'sourceIdentity',
        'supportState',
        'accessRoute',
        'coverageInterval',
        'instrumentDocumentNumber',
        'recordingDate',
        'partyRoles',
        'apnLinkage',
        'addressLinkage',
        'restrictions',
        'lineage',
      ].join('\u001f'),
    )
    .digest('hex'),
);

export const OWNERSHIP_CAPABILITY_PAGE_SPECS = Object.freeze([
  Object.freeze({
    key: 'data-sales',
    url: OWNERSHIP_DATA_SALES_URL,
    requiredMarkers: Object.freeze([
      'locator index data for recorded documents',
      'document number',
      'date of recording',
      'document type',
      'subscriptions',
    ]),
  }),
  Object.freeze({
    key: 'research-access',
    url: OWNERSHIP_RESEARCH_URL,
    requiredMarkers: Object.freeze([
      'addresses are not included',
      "assessor's parcel number",
      'come to county of santa clara clerk-recorder',
    ]),
  }),
  Object.freeze({
    key: 'fee-schedule',
    url: OWNERSHIP_FEE_SCHEDULE_URL,
    requiredMarkers: Object.freeze(['grantor and grantee index', '$43.00', '$446.00']),
  }),
]);
