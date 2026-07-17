import { describe, expect, it } from 'vitest';

import { reconciliationCoverageFixture, reconciliationFixtureCases } from './fixtures.js';

describe('safe reconciliation fixtures', () => {
  it('covers ambiguous, false-merge, blocked, partial, and visibility paths', () => {
    expect(reconciliationFixtureCases.map(({ caseId }) => caseId)).toEqual([
      'shared-apn-distinct-units',
      'candidate-review-boundary',
      'false-merge-unit-mismatch',
      'blocked-business-capability',
      'partial-ownership-history',
      'permit-owner-text-not-current-owner',
    ]);
    expect(
      new Set(reconciliationFixtureCases.flatMap(({ sourceRecordKeys }) => sourceRecordKeys)).size,
    ).toBe(11);
    expect(reconciliationFixtureCases).toContainEqual(
      expect.objectContaining({ expectedState: 'unknown', visibility: 'public' }),
    );
    expect(reconciliationFixtureCases).toContainEqual(
      expect.objectContaining({
        expectedState: 'accepted',
        evidenceAvailability: 'partial',
        strictClaimEligible: false,
        visibility: 'restricted',
      }),
    );
  });

  it('uses explicit denominator, time window, gaps, and visibility arithmetic', () => {
    expect(reconciliationCoverageFixture.observed).toBeLessThan(
      reconciliationCoverageFixture.expected,
    );
    expect(Date.parse(reconciliationCoverageFixture.timeWindow.start)).toBeLessThan(
      Date.parse(reconciliationCoverageFixture.timeWindow.end),
    );
    expect(
      Object.values(reconciliationCoverageFixture.visibilityCounts).reduce<number>(
        (sum, value) => sum + value,
        0,
      ),
    ).toBe(reconciliationCoverageFixture.observed);
    expect(reconciliationCoverageFixture.gapReasons).toEqual(['source_partial', 'ambiguous_links']);
  });
});
