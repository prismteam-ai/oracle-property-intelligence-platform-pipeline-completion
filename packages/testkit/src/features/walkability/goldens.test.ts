import { describe, expect, it } from 'vitest';

import { WALKABILITY_GOLDEN_CASES } from './goldens.js';

describe('walkability semantic golden registry', () => {
  it('has stable unique IDs and covers every inquiry family', () => {
    const ids = WALKABILITY_GOLDEN_CASES.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...new Set(WALKABILITY_GOLDEN_CASES.map(({ family }) => family))].sort()).toEqual([
      'ranking',
      'routing',
      'starbucks',
      'transit',
    ]);
  });

  it('requires a reason for every prohibited positive claim', () => {
    const prohibited = WALKABILITY_GOLDEN_CASES.filter(
      ({ prohibitsPositiveClaim }) => prohibitsPositiveClaim,
    );
    expect(prohibited.length).toBeGreaterThan(0);
    expect(prohibited.every(({ expectedReason }) => expectedReason !== null)).toBe(true);
    expect(
      prohibited.every(({ expectedSupportState }) => expectedSupportState !== 'supported'),
    ).toBe(true);
  });
});
