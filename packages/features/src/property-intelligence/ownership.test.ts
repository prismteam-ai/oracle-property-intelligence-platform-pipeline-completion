import { describe, expect, it } from 'vitest';

import type {
  CurrentOwnerObservation,
  OwnershipInquiryCoverage,
  TransferObservation,
} from './ownership.js';
import {
  BAY_AREA_NINE_COUNTIES_POLICY,
  deriveOwnershipTenure,
  deriveRegionalOwner,
} from './ownership.js';
import {
  EVENT_ID,
  INTEREST_ID,
  PARTY_ID,
  PROPERTY_ID,
  SECOND_EVENT_ID,
  SECOND_INTEREST_ID,
  SECOND_PARTY_ID,
  completeCoverage,
  sourceObservation,
} from './test-helpers.test-support.js';

function ownershipCoverage(
  overrides: Partial<OwnershipInquiryCoverage> = {},
): OwnershipInquiryCoverage {
  return Object.freeze({
    ...completeCoverage(),
    currentOwnerState: 'complete',
    transferHistoryState: 'complete',
    ...overrides,
  });
}

function owner(overrides: Partial<CurrentOwnerObservation> = {}): CurrentOwnerObservation {
  return Object.freeze({
    ...sourceObservation(
      'current-owner-interest',
      'interest-1',
      { ownerName: 'Jane Example', mailingAddress: '123 Private Street' },
      'restricted',
      'test-ownership',
    ),
    interestId: INTEREST_ID,
    partyId: PARTY_ID,
    supportState: 'supported',
    effectiveFrom: '2010-06-01T00:00:00.000Z',
    effectiveTo: null,
    mailingLocation: Object.freeze({
      county: 'Santa Clara County',
      state: 'CA',
      country: 'US',
      validation: 'verified_county',
    }),
    ...overrides,
  });
}

function transfer(overrides: Partial<TransferObservation> = {}): TransferObservation {
  return Object.freeze({
    ...sourceObservation(
      'ownership-transfer',
      'transfer-1',
      { occurredAt: '2010-06-01T00:00:00.000Z' },
      'restricted',
      'test-ownership',
    ),
    eventId: EVENT_ID,
    supportState: 'supported',
    occurredAt: '2010-06-01T00:00:00.000Z',
    granteePartyIds: Object.freeze([PARTY_ID]),
    ...overrides,
  });
}

describe('ownership tenure evidence', () => {
  it('supports a strict no-exchange answer only with complete matching evidence', () => {
    const result = deriveOwnershipTenure({
      propertyId: PROPERTY_ID,
      asOf: '2026-07-17T00:00:00.000Z',
      currentOwners: [owner()],
      transfers: [transfer()],
      coverage: ownershipCoverage(),
    });

    expect(result.supportClass).toBe('supported');
    expect(result.value).toEqual({
      latestVerifiedTransferAt: '2010-06-01T00:00:00.000Z',
      tenureYears: 16,
      minimumTenureYears: 10,
      hasNotExchangedOwnership: true,
      currentOwnerCount: 1,
      strictEvidence: true,
    });
  });

  it('treats the exact ten-year boundary as not more than ten years', () => {
    const boundary = '2016-07-17T00:00:00.000Z';
    const result = deriveOwnershipTenure({
      propertyId: PROPERTY_ID,
      asOf: '2026-07-17T00:00:00.000Z',
      currentOwners: [owner({ effectiveFrom: boundary })],
      transfers: [transfer({ occurredAt: boundary })],
      coverage: ownershipCoverage(),
    });

    expect(result.value).toMatchObject({
      tenureYears: 10,
      hasNotExchangedOwnership: false,
    });
  });

  it.each(['partial', 'blocked'] as const)(
    'returns unknown for %s transfer history even when old records exist',
    (state) => {
      const result = deriveOwnershipTenure({
        propertyId: PROPERTY_ID,
        asOf: '2026-07-17T00:00:00.000Z',
        currentOwners: [owner()],
        transfers: [transfer()],
        coverage: ownershipCoverage({ state, transferHistoryState: state }),
      });

      expect(result.supportClass).toBe('unknown');
      expect(result.value).toBeNull();
      expect(result.limitations.join(' ')).toMatch(/cannot support/u);
    },
  );

  it('denies a positive claim from missing transfer records', () => {
    const result = deriveOwnershipTenure({
      propertyId: PROPERTY_ID,
      asOf: '2026-07-17T00:00:00.000Z',
      currentOwners: [owner()],
      transfers: [],
      coverage: ownershipCoverage(),
    });

    expect(result.supportClass).toBe('unknown');
    expect(result.value).toBeNull();
    expect(result.limitations.join(' ')).toMatch(/Missing records/u);
  });

  it('fails closed for future, invalid, or non-supported transfer evidence', () => {
    for (const candidate of [
      transfer({ occurredAt: '2027-01-01T00:00:00.000Z' }),
      transfer({ occurredAt: 'not-a-date' }),
      transfer({ supportState: 'proxy' }),
    ]) {
      const result = deriveOwnershipTenure({
        propertyId: PROPERTY_ID,
        asOf: '2026-07-17T00:00:00.000Z',
        currentOwners: [owner()],
        transfers: [candidate],
        coverage: ownershipCoverage(),
      });
      expect(result.supportClass).toBe('unknown');
    }
  });

  it('does not resolve contradictory transfer rows by input order', () => {
    const conflicting = transfer({
      ...sourceObservation(
        'ownership-transfer',
        'transfer-conflict',
        { occurredAt: '2012-01-01T00:00:00.000Z' },
        'restricted',
        'test-ownership',
      ),
      occurredAt: '2012-01-01T00:00:00.000Z',
    });
    const result = deriveOwnershipTenure({
      propertyId: PROPERTY_ID,
      asOf: '2026-07-17T00:00:00.000Z',
      currentOwners: [owner()],
      transfers: [transfer(), conflicting],
      coverage: ownershipCoverage(),
    });

    expect(result.supportClass).toBe('unknown');
    expect(result.limitations.join(' ')).toMatch(/row order/u);
  });

  it('requires latest transfer grantees to agree with supported current owners', () => {
    const result = deriveOwnershipTenure({
      propertyId: PROPERTY_ID,
      asOf: '2026-07-17T00:00:00.000Z',
      currentOwners: [owner({ partyId: SECOND_PARTY_ID })],
      transfers: [transfer()],
      coverage: ownershipCoverage(),
    });

    expect(result.supportClass).toBe('unknown');
    expect(result.limitations.join(' ')).toMatch(/do not agree/u);
  });
});

describe('regional-owner evidence', () => {
  it('freezes the exact nine-county outside-region policy', () => {
    expect(BAY_AREA_NINE_COUNTIES_POLICY.includedCounties).toEqual([
      'Alameda',
      'Contra Costa',
      'Marin',
      'Napa',
      'San Francisco',
      'San Mateo',
      'Santa Clara',
      'Solano',
      'Sonoma',
    ]);
    expect(BAY_AREA_NINE_COUNTIES_POLICY.regionalOwnerDefinition).toBe('outside_included_counties');
  });

  it('classifies Santa Clara inside and adjacent Santa Cruz outside the policy boundary', () => {
    const inside = deriveRegionalOwner({
      propertyId: PROPERTY_ID,
      asOf: '2026-07-17T00:00:00.000Z',
      currentOwners: [owner()],
      transfers: [transfer()],
      coverage: ownershipCoverage(),
    });
    const outsideOwner = owner({
      mailingLocation: {
        county: 'Santa Cruz',
        state: 'CA',
        country: 'US',
        validation: 'verified_county',
      },
    });
    const outside = deriveRegionalOwner({
      propertyId: PROPERTY_ID,
      asOf: '2026-07-17T00:00:00.000Z',
      currentOwners: [outsideOwner],
      transfers: [transfer()],
      coverage: ownershipCoverage(),
    });

    expect(inside.value).toMatchObject({ isRegionalOwner: false, insideRegionOwnerCount: 1 });
    expect(outside.value).toMatchObject({ isRegionalOwner: true, outsideRegionOwnerCount: 1 });
  });

  it('returns unknown for PO boxes, failed geocodes, and incomplete history', () => {
    const poBox = deriveRegionalOwner({
      propertyId: PROPERTY_ID,
      asOf: '2026-07-17T00:00:00.000Z',
      currentOwners: [
        owner({
          mailingLocation: {
            county: 'Alameda',
            state: 'CA',
            country: 'US',
            validation: 'po_box',
          },
        }),
      ],
      transfers: [transfer()],
      coverage: ownershipCoverage(),
    });
    const partial = deriveRegionalOwner({
      propertyId: PROPERTY_ID,
      asOf: '2026-07-17T00:00:00.000Z',
      currentOwners: [owner()],
      transfers: [transfer()],
      coverage: ownershipCoverage({ transferHistoryState: 'partial' }),
    });

    expect(poBox.supportClass).toBe('unknown');
    expect(partial.supportClass).toBe('unknown');
  });

  it('supports multiple current owners deterministically and reports any outside owner', () => {
    const secondOwner = owner({
      ...sourceObservation(
        'current-owner-interest',
        'interest-2',
        { mailingCounty: 'Napa' },
        'restricted',
        'test-ownership',
      ),
      interestId: SECOND_INTEREST_ID,
      partyId: SECOND_PARTY_ID,
      mailingLocation: {
        county: 'Nevada',
        state: 'NV',
        country: 'US',
        validation: 'verified_county',
      },
    });
    const latestTransfer = transfer({
      ...sourceObservation(
        'ownership-transfer',
        'transfer-2',
        { occurredAt: '2010-06-01T00:00:00.000Z' },
        'restricted',
        'test-ownership',
      ),
      eventId: SECOND_EVENT_ID,
      granteePartyIds: Object.freeze([PARTY_ID, SECOND_PARTY_ID]),
    });
    const forward = deriveRegionalOwner({
      propertyId: PROPERTY_ID,
      asOf: '2026-07-17T00:00:00.000Z',
      currentOwners: [owner(), secondOwner],
      transfers: [latestTransfer],
      coverage: ownershipCoverage(),
    });
    const reverse = deriveRegionalOwner({
      propertyId: PROPERTY_ID,
      asOf: '2026-07-17T00:00:00.000Z',
      currentOwners: [secondOwner, owner()],
      transfers: [latestTransfer],
      coverage: ownershipCoverage(),
    });

    expect(forward.value).toMatchObject({
      isRegionalOwner: true,
      insideRegionOwnerCount: 1,
      outsideRegionOwnerCount: 1,
    });
    expect(reverse.evidence.evidenceId).toBe(forward.evidence.evidenceId);
  });

  it('preserves prohibited-public visibility while redacting raw owner evidence', () => {
    const prohibited = owner({ visibility: 'prohibited_public' });
    const result = deriveRegionalOwner({
      propertyId: PROPERTY_ID,
      asOf: '2026-07-17T00:00:00.000Z',
      currentOwners: [prohibited],
      transfers: [transfer({ visibility: 'prohibited_public' })],
      coverage: ownershipCoverage(),
    });
    const serialized = JSON.stringify(result);

    expect(result.visibility).toBe('prohibited_public');
    expect(result.value?.rawOwnerIdentityExposed).toBe(false);
    expect(serialized).not.toContain('Jane Example');
    expect(serialized).not.toContain('123 Private Street');
  });
});
