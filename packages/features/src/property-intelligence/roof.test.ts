import { describe, expect, it } from 'vitest';

import type { BuildingAgeObservation, RoofPermitObservation } from './roof.js';
import { classifyRoofWork, deriveRoofAge } from './roof.js';
import {
  PROPERTY_ID,
  PERMIT_ID,
  SECOND_PERMIT_ID,
  completeCoverage,
  sourceObservation,
} from './test-helpers.test-support.js';

function permit(overrides: Partial<RoofPermitObservation> = {}): RoofPermitObservation {
  const source = sourceObservation('permit', 'permit-1', {
    permitType: 'Reroof',
    description: 'Tear off and replace roof',
    status: 'Finaled',
    issuedAt: '2005-05-01T00:00:00.000Z',
    completedAt: '2005-06-01T00:00:00.000Z',
  });
  return Object.freeze({
    ...source,
    permitId: PERMIT_ID,
    permitType: 'Reroof',
    description: 'Tear off and replace roof',
    status: 'Finaled',
    issuedAt: '2005-05-01T00:00:00.000Z',
    completedAt: '2005-06-01T00:00:00.000Z',
    ...overrides,
  });
}

function building(overrides: Partial<BuildingAgeObservation> = {}): BuildingAgeObservation {
  return Object.freeze({
    ...sourceObservation('property-building-age', 'building-1', {
      yearBuilt: 1965,
      effectiveYearBuilt: null,
    }),
    yearBuilt: 1965,
    effectiveYearBuilt: null,
    ...overrides,
  });
}

describe('roof evidence classifier', () => {
  it('distinguishes replacement, repair, incidental roof wording, and ambiguity', () => {
    expect(classifyRoofWork({ permitType: 'Reroof', description: 'Tear-off and replace' })).toBe(
      'replacement',
    );
    expect(classifyRoofWork({ permitType: 'Re-roof', description: null })).toBe('replacement');
    expect(classifyRoofWork({ permitType: 'Building', description: 'Roof repair only' })).toBe(
      'repair',
    );
    expect(classifyRoofWork({ permitType: 'Solar', description: 'Roof mounted PV array' })).toBe(
      'not_roof_work',
    );
    expect(classifyRoofWork({ permitType: 'Building', description: 'Roof work' })).toBe(
      'ambiguous_roof_work',
    );
  });
});

describe('roof age evidence', () => {
  it('supports only the latest finalized conclusive roof work under complete coverage', () => {
    const newer = permit({
      ...sourceObservation('permit', 'permit-2', { completedAt: '2010-06-01T00:00:00.000Z' }),
      permitId: SECOND_PERMIT_ID,
      completedAt: '2010-06-01T00:00:00.000Z',
    });
    const result = deriveRoofAge({
      propertyId: PROPERTY_ID,
      asOf: '2026-07-17T00:00:00.000Z',
      permits: [permit(), newer],
      buildingAge: [],
      permitCoverage: completeCoverage(),
    });

    expect(result.supportClass).toBe('supported');
    expect(result.value).toMatchObject({
      mode: 'explicit_completed_roof_work',
      selectedPermitId: SECOND_PERMIT_ID,
      ageYears: 16,
      olderThanMinimum: true,
      actualRoofAgeProven: true,
    });
  });

  it('treats the exact age boundary as not older than the threshold', () => {
    const result = deriveRoofAge({
      propertyId: PROPERTY_ID,
      asOf: '2026-07-17T00:00:00.000Z',
      minimumAgeYears: 15,
      permits: [permit({ completedAt: '2011-07-17T00:00:00.000Z' })],
      buildingAge: [],
      permitCoverage: completeCoverage(),
    });

    expect(result.value).toMatchObject({ ageYears: 15, olderThanMinimum: false });
  });

  it('keeps an issued-only replacement permit as a proxy', () => {
    const result = deriveRoofAge({
      propertyId: PROPERTY_ID,
      asOf: '2026-07-17T00:00:00.000Z',
      permits: [permit({ status: 'Issued', completedAt: null })],
      buildingAge: [],
      permitCoverage: completeCoverage(),
    });

    expect(result.supportClass).toBe('proxy');
    expect(result.value).toMatchObject({
      mode: 'issued_roof_permit_proxy',
      actualRoofAgeProven: false,
    });
    expect(result.limitations.join(' ')).toMatch(/does not prove/u);
  });

  it('denies an old-roof claim when finalized evidence is not covered through as-of', () => {
    const result = deriveRoofAge({
      propertyId: PROPERTY_ID,
      asOf: '2026-07-17T00:00:00.000Z',
      permits: [permit()],
      buildingAge: [],
      permitCoverage: completeCoverage({
        state: 'partial',
        windowStart: '2000-01-01T00:00:00.000Z',
      }),
    });

    expect(result.supportClass).toBe('unknown');
    expect(result.value).toBeNull();
    expect(result.limitations.join(' ')).toMatch(/cannot establish/u);
  });

  it('does not classify repair-only or incidental rooftop work as replacement', () => {
    const result = deriveRoofAge({
      propertyId: PROPERTY_ID,
      asOf: '2026-07-17T00:00:00.000Z',
      permits: [
        permit({
          permitType: 'Solar',
          description: 'Roof mounted PV',
          completedAt: '2000-01-01T00:00:00.000Z',
        }),
        permit({
          ...sourceObservation('permit', 'repair-permit', { description: 'Roof repair only' }),
          permitId: SECOND_PERMIT_ID,
          permitType: 'Building',
          description: 'Roof repair only',
          completedAt: '2001-01-01T00:00:00.000Z',
        }),
      ],
      buildingAge: [],
      permitCoverage: completeCoverage(),
    });

    expect(result.supportClass).toBe('proxy');
    expect(result.value).toMatchObject({
      mode: 'no_recent_roof_permit',
      actualRoofAgeProven: false,
    });
  });

  it('uses building age only as a visibly labeled fallback proxy', () => {
    const result = deriveRoofAge({
      propertyId: PROPERTY_ID,
      asOf: '2026-07-17T00:00:00.000Z',
      permits: [],
      buildingAge: [building()],
      permitCoverage: completeCoverage({
        state: 'blocked',
        windowStart: null,
        windowEnd: null,
        limitations: ['Permit source unavailable.'],
      }),
    });

    expect(result.supportClass).toBe('proxy');
    expect(result.value).toMatchObject({
      mode: 'building_age_proxy',
      actualRoofAgeProven: false,
    });
    expect(result.limitations.join(' ')).toMatch(/not roof age/u);
  });

  it('does not turn absence into a strict positive claim', () => {
    const result = deriveRoofAge({
      propertyId: PROPERTY_ID,
      asOf: '2026-07-17T00:00:00.000Z',
      permits: [],
      buildingAge: [],
      permitCoverage: completeCoverage(),
    });

    expect(result.supportClass).toBe('proxy');
    expect(result.value).toMatchObject({
      mode: 'no_recent_roof_permit',
      olderThanMinimum: false,
      actualRoofAgeProven: false,
    });
  });

  it('returns unknown for contradictory rows sharing one permit identity', () => {
    const result = deriveRoofAge({
      propertyId: PROPERTY_ID,
      asOf: '2026-07-17T00:00:00.000Z',
      permits: [
        permit(),
        permit({
          ...sourceObservation('permit', 'permit-conflict', { status: 'Expired' }),
          status: 'Expired',
          completedAt: null,
        }),
      ],
      buildingAge: [],
      permitCoverage: completeCoverage(),
    });

    expect(result.supportClass).toBe('unknown');
    expect(result.limitations.join(' ')).toMatch(/row order/u);
  });

  it('is order independent and propagates prohibited-public visibility', () => {
    const first = permit();
    const repair = permit({
      ...sourceObservation('permit', 'permit-repair-replay', { description: 'Roof repair only' }),
      permitId: SECOND_PERMIT_ID,
      permitType: 'Building',
      description: 'Roof repair only',
      completedAt: '2015-01-01T00:00:00.000Z',
    });
    const privateBuilding = building({
      ...sourceObservation(
        'property-building-age',
        'building-private',
        { yearBuilt: 1960 },
        'prohibited_public',
      ),
      yearBuilt: 1960,
    });
    const publicBuilding = building();
    const forward = deriveRoofAge({
      propertyId: PROPERTY_ID,
      asOf: '2026-07-17T00:00:00.000Z',
      permits: [first, repair],
      buildingAge: [privateBuilding, publicBuilding],
      permitCoverage: completeCoverage(),
    });
    const reverse = deriveRoofAge({
      propertyId: PROPERTY_ID,
      asOf: '2026-07-17T00:00:00.000Z',
      permits: [repair, first],
      buildingAge: [publicBuilding, privateBuilding],
      permitCoverage: completeCoverage(),
    });

    expect(reverse.evidence.evidenceId).toBe(forward.evidence.evidenceId);
    expect(forward.visibility).toBe('prohibited_public');
    expect(Object.isFrozen(forward.sourceObservations)).toBe(true);
  });
});
