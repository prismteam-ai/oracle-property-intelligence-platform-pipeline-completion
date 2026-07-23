import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

interface GoldenCase {
  readonly id: string;
  readonly feature: string;
  readonly evidenceState: 'complete' | 'partial' | 'blocked';
  readonly expectedSupport: 'supported' | 'proxy' | 'unknown';
  readonly expectedMode: string | null;
  readonly positiveClaimAllowed: boolean;
  readonly actualViewClaimAllowed?: boolean;
}

interface GoldenFixture {
  readonly schemaVersion: string;
  readonly asOf: string;
  readonly cases: readonly GoldenCase[];
  readonly prohibitedPublicOwnerFields: readonly string[];
  readonly requiredWaterLimitations: readonly string[];
}

const fixture = JSON.parse(
  readFileSync(new URL('./goldens.json', import.meta.url), 'utf8'),
) as GoldenFixture;

describe('property-intelligence golden registry', () => {
  it('has unique strict, proxy, and unknown cases for every evidence family', () => {
    expect(new Set(fixture.cases.map(({ id }) => id)).size).toBe(fixture.cases.length);
    expect(new Set(fixture.cases.map(({ expectedSupport }) => expectedSupport))).toEqual(
      new Set(['supported', 'proxy', 'unknown']),
    );
    expect(new Set(fixture.cases.map(({ feature }) => feature))).toEqual(
      new Set(['roof_age', 'water_view_candidate', 'ownership_age', 'regional_owner']),
    );
  });

  it('forbids positive claims for partial or blocked ownership evidence', () => {
    const unavailableOwnership = fixture.cases.filter(
      ({ feature, evidenceState }) =>
        ['ownership_age', 'regional_owner'].includes(feature) && evidenceState !== 'complete',
    );

    expect(unavailableOwnership.length).toBeGreaterThan(0);
    for (const item of unavailableOwnership) {
      expect(item.expectedSupport).toBe('unknown');
      expect(item.positiveClaimAllowed).toBe(false);
    }
  });

  it('never permits a proven-view claim and freezes owner-field redactions', () => {
    const water = fixture.cases.filter(({ feature }) => feature === 'water_view_candidate');
    expect(water.every(({ actualViewClaimAllowed }) => actualViewClaimAllowed === false)).toBe(
      true,
    );
    expect(fixture.prohibitedPublicOwnerFields).toContain('ownerName');
    expect(fixture.prohibitedPublicOwnerFields).toContain('mailingAddress');
    expect(fixture.requiredWaterLimitations).toEqual(
      expect.arrayContaining(['buildings', 'trees', 'windows', 'orientation']),
    );
  });
});
