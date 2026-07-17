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

  it('uses unique source-shaped synthetic cases and keeps unknown goldens empty', () => {
    expect(new Set(NAMED_INQUIRY_GOLDENS.map(({ id }) => id)).size).toBe(
      NAMED_INQUIRY_GOLDENS.length,
    );
    expect(
      NAMED_INQUIRY_GOLDENS.flatMap(({ expectedPropertyIds }) => expectedPropertyIds).every(
        (propertyId) => propertyId.startsWith('sc:entity:property:golden-'),
      ),
    ).toBe(true);
    expect(
      NAMED_INQUIRY_GOLDENS.filter(({ expectedSupport }) => expectedSupport === 'unknown').every(
        ({ expectedPropertyIds }) => expectedPropertyIds.length === 0,
      ),
    ).toBe(true);
  });
});
