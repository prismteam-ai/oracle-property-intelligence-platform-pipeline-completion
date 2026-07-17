import { describe, expect, it } from 'vitest';

import { NAMED_INQUIRY_GOLDENS } from './named-inquiry-goldens.js';

describe('named inquiry golden inventory', () => {
  it('covers every required inquiry and preserves absence semantics', () => {
    expect(new Set(NAMED_INQUIRY_GOLDENS.map(({ inquiry }) => inquiry))).toEqual(
      new Set([
        'roof_age',
        'water_view_candidate',
        'ownership_age',
        'regional_owner',
        'transit_walkability',
        'starbucks_walkability',
        'combined_review',
      ]),
    );
    expect(
      NAMED_INQUIRY_GOLDENS.every(
        ({ prohibitsPositiveClaimFromAbsence }) => prohibitsPositiveClaimFromAbsence,
      ),
    ).toBe(true);
  });
});
