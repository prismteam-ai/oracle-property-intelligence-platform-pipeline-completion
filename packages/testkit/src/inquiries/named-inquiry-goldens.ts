export type NamedInquiryGolden = Readonly<{
  id: string;
  inquiry:
    | 'roof_age'
    | 'water_view_candidate'
    | 'ownership_age'
    | 'regional_owner'
    | 'transit_walkability'
    | 'starbucks_walkability'
    | 'combined_review';
  expectedPropertyIds: readonly string[];
  expectedSupport: 'supported' | 'proxy' | 'unknown' | 'mixed';
  prohibitsPositiveClaimFromAbsence: boolean;
}>;

/** Source-shaped synthetic IDs only; these fixtures never represent production county records. */
export const NAMED_INQUIRY_GOLDENS: readonly NamedInquiryGolden[] = Object.freeze([
  {
    id: 'roof-strict-older-than-15',
    inquiry: 'roof_age',
    expectedPropertyIds: Object.freeze(['sc:entity:property:golden-a']),
    expectedSupport: 'supported',
    prohibitsPositiveClaimFromAbsence: true,
  },
  {
    id: 'water-terrain-candidate',
    inquiry: 'water_view_candidate',
    expectedPropertyIds: Object.freeze(['sc:entity:property:golden-a']),
    expectedSupport: 'supported',
    prohibitsPositiveClaimFromAbsence: true,
  },
  {
    id: 'ownership-complete-history-only',
    inquiry: 'ownership_age',
    expectedPropertyIds: Object.freeze(['sc:entity:property:golden-a']),
    expectedSupport: 'supported',
    prohibitsPositiveClaimFromAbsence: true,
  },
  {
    id: 'regional-owner-supported-only',
    inquiry: 'regional_owner',
    expectedPropertyIds: Object.freeze(['sc:entity:property:golden-a']),
    expectedSupport: 'supported',
    prohibitsPositiveClaimFromAbsence: true,
  },
  {
    id: 'transit-routed-distance',
    inquiry: 'transit_walkability',
    expectedPropertyIds: Object.freeze(['sc:entity:property:golden-a']),
    expectedSupport: 'supported',
    prohibitsPositiveClaimFromAbsence: true,
  },
  {
    id: 'starbucks-routed-distance',
    inquiry: 'starbucks_walkability',
    expectedPropertyIds: Object.freeze(['sc:entity:property:golden-a']),
    expectedSupport: 'supported',
    prohibitsPositiveClaimFromAbsence: true,
  },
  {
    id: 'combined-transparent-ranking',
    inquiry: 'combined_review',
    expectedPropertyIds: Object.freeze([
      'sc:entity:property:golden-a',
      'sc:entity:property:golden-b',
    ]),
    expectedSupport: 'mixed',
    prohibitsPositiveClaimFromAbsence: true,
  },
  {
    id: 'blocked-ownership-is-empty-not-positive',
    inquiry: 'ownership_age',
    expectedPropertyIds: Object.freeze([]),
    expectedSupport: 'unknown',
    prohibitsPositiveClaimFromAbsence: true,
  },
]);
