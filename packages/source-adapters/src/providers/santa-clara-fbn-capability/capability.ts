import { createHash } from 'node:crypto';

export const SANTA_CLARA_FBN_CAPABILITY_ID = 'santa-clara-fbn-monthly-data-v1';
export const SANTA_CLARA_FBN_DECISION_AS_OF = '2026-07-17T00:00:00.000Z';

export interface BlockedFbnCapability {
  readonly capabilityId: typeof SANTA_CLARA_FBN_CAPABILITY_ID;
  readonly capabilityType: 'fbn';
  readonly authority: 'County of Santa Clara, Office of the Clerk-Recorder';
  readonly jurisdiction: 'Santa Clara County, CA';
  readonly decision: 'blocked';
  readonly supportState: 'unsupported';
  readonly asOf: typeof SANTA_CLARA_FBN_DECISION_AS_OF;
  readonly acquisitionPermission: false;
  readonly privateUsePermission: false;
  readonly publicProjectionPermission: false;
  readonly expectedRecords: null;
  readonly observedRecords: 0;
  readonly coverageRatio: null;
  readonly sourceVersion: 'official-page-observed-2026-07-17';
  readonly affectedFields: readonly [
    'fictitiousBusinessName',
    'registrantName',
    'businessAddress',
    'filingDate',
  ];
  readonly sourceUrls: readonly string[];
  readonly reason: string;
  readonly limitations: readonly string[];
  readonly evidenceSha256: string;
}

export interface UnknownFbnProjection {
  readonly capabilityId: typeof SANTA_CLARA_FBN_CAPABILITY_ID;
  readonly capabilityType: 'fbn';
  readonly supportState: 'unsupported';
  readonly businessId: string;
  readonly value: null;
  readonly asOf: typeof SANTA_CLARA_FBN_DECISION_AS_OF;
  readonly sourceRecordIds: readonly [];
  readonly publicVisibility: 'prohibited_public';
  readonly limitations: readonly string[];
}

const SOURCE_URLS = Object.freeze([
  'https://clerkrecorder.santaclaracounty.gov/official-records/subscribe-data-sales-reports/additional-information-related-data-sales',
  'https://clerkrecorder.santaclaracounty.gov/official-records/subscribe-data-sales-reports',
]);

const REASON =
  'Blocked as of 2026-07-17: the official county route is a paid monthly data-sale subscription containing business names, owner/registrant names, and business addresses. This lane has no purchased immutable snapshot and no approved retention, private-use, or redistribution rights decision.';

const LIMITATIONS = Object.freeze([
  'The county states that not every new business must file an FBN statement.',
  'No denominator is available before an approved subscription snapshot is acquired.',
  'No FBN row is fabricated and absence cannot be interpreted as absence of a fictitious business name.',
  'California SOS entity coverage remains separately supported and does not fill the county FBN gap.',
]);

const EVIDENCE_SHA256 = createHash('sha256')
  .update(
    JSON.stringify({
      asOf: SANTA_CLARA_FBN_DECISION_AS_OF,
      sourceUrls: SOURCE_URLS,
      reason: REASON,
      limitations: LIMITATIONS,
    }),
  )
  .digest('hex');

export const SANTA_CLARA_FBN_BLOCKED_CAPABILITY: BlockedFbnCapability = Object.freeze({
  capabilityId: SANTA_CLARA_FBN_CAPABILITY_ID,
  capabilityType: 'fbn',
  authority: 'County of Santa Clara, Office of the Clerk-Recorder',
  jurisdiction: 'Santa Clara County, CA',
  decision: 'blocked',
  supportState: 'unsupported',
  asOf: SANTA_CLARA_FBN_DECISION_AS_OF,
  acquisitionPermission: false,
  privateUsePermission: false,
  publicProjectionPermission: false,
  expectedRecords: null,
  observedRecords: 0,
  coverageRatio: null,
  sourceVersion: 'official-page-observed-2026-07-17',
  affectedFields: Object.freeze([
    'fictitiousBusinessName',
    'registrantName',
    'businessAddress',
    'filingDate',
  ] as const),
  sourceUrls: SOURCE_URLS,
  reason: REASON,
  limitations: LIMITATIONS,
  evidenceSha256: EVIDENCE_SHA256,
});

/**
 * Freezes the release branch explicitly. A future supported route must replace
 * this function with an approved snapshot adapter rather than relabeling the
 * current zero-row capability.
 */
export function materializeSantaClaraFbnCapability(
  route: 'supported' | 'blocked',
): BlockedFbnCapability {
  if (route === 'supported') {
    throw new Error(
      'Santa Clara FBN supported route is unavailable: no approved immutable snapshot and rights profile exist for this release',
    );
  }
  return SANTA_CLARA_FBN_BLOCKED_CAPABILITY;
}

export function projectUnknownFbn(businessId: string): UnknownFbnProjection {
  if (!/^sc:entity:business:[a-z0-9][a-z0-9._~-]{0,127}$/u.test(businessId)) {
    throw new TypeError('Expected a canonical Santa Clara business ID');
  }
  return Object.freeze({
    capabilityId: SANTA_CLARA_FBN_CAPABILITY_ID,
    capabilityType: 'fbn',
    supportState: 'unsupported',
    businessId,
    value: null,
    asOf: SANTA_CLARA_FBN_DECISION_AS_OF,
    sourceRecordIds: Object.freeze([] as const),
    publicVisibility: 'prohibited_public',
    limitations: SANTA_CLARA_FBN_BLOCKED_CAPABILITY.limitations,
  });
}
