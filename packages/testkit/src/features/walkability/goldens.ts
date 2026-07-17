export interface WalkabilityGoldenCase {
  readonly id: string;
  readonly family: 'routing' | 'transit' | 'starbucks' | 'ranking';
  readonly scenario: string;
  readonly expectedSupportState: 'supported' | 'proxy' | 'unknown' | 'not_applicable';
  readonly expectedReason: string | null;
  readonly prohibitsPositiveClaim: boolean;
}

/**
 * Safe, source-shaped semantic cases for downstream query/API/MCP parity tests.
 * Geometry and identities are synthetic and can never be mistaken for county data.
 */
export const WALKABILITY_GOLDEN_CASES: readonly WalkabilityGoldenCase[] = Object.freeze([
  {
    id: 'routing-directed-known-small-graph',
    family: 'routing',
    scenario: 'A directed two-edge pedestrian path is reachable.',
    expectedSupportState: 'not_applicable',
    expectedReason: null,
    prohibitsPositiveClaim: false,
  },
  {
    id: 'routing-one-way-reverse',
    family: 'routing',
    scenario: 'Only the reverse of the requested path exists.',
    expectedSupportState: 'not_applicable',
    expectedReason: 'no_route',
    prohibitsPositiveClaim: true,
  },
  {
    id: 'routing-barrier-crossing-level',
    family: 'routing',
    scenario: 'The apparent connection violates barrier, crossing, or level semantics.',
    expectedSupportState: 'not_applicable',
    expectedReason: 'origin_snap_failed',
    prohibitsPositiveClaim: true,
  },
  {
    id: 'routing-disconnected-components',
    family: 'routing',
    scenario: 'Both endpoints snap, but their pedestrian components are disconnected.',
    expectedSupportState: 'not_applicable',
    expectedReason: 'disconnected_components',
    prohibitsPositiveClaim: true,
  },
  {
    id: 'routing-bounded-snap-failure',
    family: 'routing',
    scenario: 'No route-eligible node is inside the requested snap radius.',
    expectedSupportState: 'not_applicable',
    expectedReason: 'origin_snap_failed',
    prohibitsPositiveClaim: true,
  },
  {
    id: 'transit-active-boardable-platform-via-entrance',
    family: 'transit',
    scenario: 'An entrance is topologically linked to an active passenger-boardable platform.',
    expectedSupportState: 'supported',
    expectedReason: null,
    prohibitsPositiveClaim: false,
  },
  {
    id: 'transit-calendar-exception-removed',
    family: 'transit',
    scenario: 'calendar_dates removes service on the selected date.',
    expectedSupportState: 'unknown',
    expectedReason: 'inactive_on_service_date',
    prohibitsPositiveClaim: true,
  },
  {
    id: 'transit-forbidden-transfer',
    family: 'transit',
    scenario: 'A transfer_type=3 edge cannot establish boarding topology.',
    expectedSupportState: 'unknown',
    expectedReason: 'no_eligible_destination',
    prohibitsPositiveClaim: true,
  },
  {
    id: 'starbucks-sampled-open',
    family: 'starbucks',
    scenario: 'An Overture candidate has sampled-open validation and a routed path.',
    expectedSupportState: 'supported',
    expectedReason: null,
    prohibitsPositiveClaim: false,
  },
  {
    id: 'starbucks-unconfirmed-strict',
    family: 'starbucks',
    scenario: 'An otherwise eligible Overture candidate has not been officially sampled.',
    expectedSupportState: 'unknown',
    expectedReason: 'unconfirmed_candidate',
    prohibitsPositiveClaim: true,
  },
  {
    id: 'starbucks-unconfirmed-opt-in-proxy',
    family: 'starbucks',
    scenario: 'The caller explicitly includes an unconfirmed Overture candidate.',
    expectedSupportState: 'proxy',
    expectedReason: 'review_required',
    prohibitsPositiveClaim: false,
  },
  {
    id: 'starbucks-closed',
    family: 'starbucks',
    scenario: 'Overture or sampled validation marks the destination closed.',
    expectedSupportState: 'unknown',
    expectedReason: 'closed_candidate',
    prohibitsPositiveClaim: true,
  },
  {
    id: 'ranking-missing-evidence',
    family: 'ranking',
    scenario: 'A configured component is absent.',
    expectedSupportState: 'unknown',
    expectedReason: 'missing_evidence',
    prohibitsPositiveClaim: true,
  },
] satisfies readonly WalkabilityGoldenCase[]);
