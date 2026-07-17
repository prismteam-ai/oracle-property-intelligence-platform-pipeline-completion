import { describe, expect, it } from 'vitest';

import { scoreReconciliation } from './scoring.js';

const thresholds = { autoLink: 0.9, review: 0.65 } as const;

describe('reconciliation scoring', () => {
  it('produces deterministic weighted classifications', () => {
    const decision = scoreReconciliation(
      [
        { key: 'normalized-address', agreement: 0.8, weight: 1 },
        { key: 'source-apn', agreement: 1, weight: 4 },
      ],
      thresholds,
    );

    expect(decision.score).toBe(0.96);
    expect(decision.classification).toBe('auto_link');
    expect(decision.contributions.map(({ key }) => key)).toEqual([
      'normalized-address',
      'source-apn',
    ]);
  });

  it('makes a hard contradiction non-overridable', () => {
    const decision = scoreReconciliation(
      [
        { key: 'same-county', agreement: 1, weight: 100 },
        { key: 'conflicting-authoritative-id', agreement: 0, weight: 1, hardBlock: true },
      ],
      thresholds,
    );

    expect(decision.score).toBeGreaterThan(0.9);
    expect(decision.hardBlocked).toBe(true);
    expect(decision.classification).toBe('reject');
  });

  it('rejects duplicate signals and invalid thresholds', () => {
    expect(() =>
      scoreReconciliation(
        [
          { key: 'apn', agreement: 1, weight: 1 },
          { key: 'apn', agreement: 1, weight: 1 },
        ],
        thresholds,
      ),
    ).toThrow(/unique/u);
    expect(() =>
      scoreReconciliation([{ key: 'apn', agreement: 1, weight: 1 }], {
        autoLink: 0.5,
        review: 0.5,
      }),
    ).toThrow(/thresholds/u);
  });
});
