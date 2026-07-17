export const reconciliationFixtureCases = Object.freeze([
  Object.freeze({
    caseId: 'shared-apn-distinct-units',
    sourceRecordKeys: Object.freeze(['permit-shared-apn', 'unit-a', 'unit-b']),
    expectedState: 'ambiguous',
    expectedDuplicateClass: 'shared_apn_distinct_units',
    visibility: 'public',
  }),
  Object.freeze({
    caseId: 'candidate-review-boundary',
    sourceRecordKeys: Object.freeze(['permit-address-only', 'property-address-candidate']),
    expectedState: 'candidate',
    expectedDuplicateClass: null,
    visibility: 'authenticated',
  }),
  Object.freeze({
    caseId: 'false-merge-unit-mismatch',
    sourceRecordKeys: Object.freeze(['permit-unit-a', 'property-unit-b']),
    expectedState: 'unresolved',
    expectedDuplicateClass: null,
    visibility: 'public',
  }),
  Object.freeze({
    caseId: 'blocked-business-capability',
    sourceRecordKeys: Object.freeze(['business-capability-blocked']),
    expectedState: 'unknown',
    expectedDuplicateClass: null,
    visibility: 'public',
  }),
  Object.freeze({
    caseId: 'partial-ownership-history',
    sourceRecordKeys: Object.freeze(['ownership-interest-partial', 'property-ownership-target']),
    expectedState: 'accepted',
    evidenceAvailability: 'partial',
    strictClaimEligible: false,
    expectedDuplicateClass: null,
    visibility: 'restricted',
  }),
  Object.freeze({
    caseId: 'permit-owner-text-not-current-owner',
    sourceRecordKeys: Object.freeze(['permit-owner-text-only']),
    expectedState: 'unresolved',
    expectedDuplicateClass: null,
    visibility: 'prohibited_public',
  }),
] as const);

export const reconciliationCoverageFixture = Object.freeze({
  jurisdiction: 'Santa Clara County',
  timeWindow: Object.freeze({
    start: '2010-01-01T00:00:00.000Z',
    end: '2026-07-17T00:00:00.000Z',
  }),
  expected: 6,
  observed: 4,
  gapReasons: Object.freeze(['source_partial', 'ambiguous_links']),
  visibilityCounts: Object.freeze({
    public: 2,
    authenticated: 1,
    restricted: 1,
    prohibited_public: 0,
  }),
});
