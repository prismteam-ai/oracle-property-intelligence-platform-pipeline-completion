import { describe, expect, it } from 'vitest';

import { createReviewDecision, linkEntities } from './engine.js';
import type { LinkableEntity } from './model.js';

const lineage = Object.freeze([
  Object.freeze({
    sourceId: 'sc:source:test-fixture',
    snapshotId: `sc:snapshot:test-fixture:${'1'.repeat(64)}`,
    artifactId: `sc:artifact:sha256:${'2'.repeat(64)}`,
    recordKey: 'safe-fixture-1',
    recordSha256: '3'.repeat(64),
  }),
]);

function entity(
  entityId: string,
  entityKind: LinkableEntity['entityKind'],
  overrides: Partial<LinkableEntity> = {},
): LinkableEntity {
  return Object.freeze({
    entityId,
    entityKind,
    jurisdiction: 'Santa Clara County',
    identifiers: [],
    normalizedKeys: [],
    candidateAttributes: {},
    evidenceAvailability: 'complete',
    visibility: 'public',
    lineage,
    ...overrides,
  });
}

describe('deterministic entity linking', () => {
  it('uses authoritative identifiers before normalized exact keys', () => {
    const permit = entity('permit-1', 'permit', {
      identifiers: [{ scheme: 'source-property-id', value: 'A-1', scope: 'county' }],
      normalizedKeys: [{ kind: 'address', value: '100 Main St' }],
    });
    const authoritative = entity('property-authoritative', 'property', {
      identifiers: [{ scheme: 'source-property-id', value: 'a-1', scope: 'COUNTY' }],
    });
    const exactAddress = entity('property-address', 'property', {
      normalizedKeys: [{ kind: 'address', value: '100 main st' }],
    });

    const result = linkEntities('permit_property', [permit], [exactAddress, authoritative]);

    expect(result.resolutions[0]).toMatchObject({
      state: 'accepted',
      matchStage: 'authoritative_identifier',
      acceptedTargetEntityId: 'property-authoritative',
    });
  });

  it('keeps shared APN units ambiguous and produces the same run for any input order', () => {
    const permit = entity('permit-shared-apn', 'permit', {
      normalizedKeys: [{ kind: 'apn', value: '123-45-678' }],
    });
    const unitA = entity('unit-a', 'property-unit', {
      parentPropertyId: 'parcel-1',
      normalizedKeys: [{ kind: 'apn', value: '123-45-678' }],
      candidateAttributes: { unit: 'A' },
    });
    const unitB = entity('unit-b', 'property-unit', {
      parentPropertyId: 'parcel-1',
      normalizedKeys: [{ kind: 'apn', value: '123-45-678' }],
      candidateAttributes: { unit: 'B' },
    });

    const forward = linkEntities('permit_property', [permit], [unitA, unitB]);
    const reversed = linkEntities('permit_property', [permit], [unitB, unitA]);

    expect(reversed).toEqual(forward);
    expect(forward.resolutions[0]).toMatchObject({
      state: 'ambiguous',
      acceptedTargetEntityId: null,
      gapReasons: ['ambiguous_normalized_exact', 'review_not_completed'],
    });
    expect(forward.resolutions[0]?.proposals).toHaveLength(2);
    expect(forward.duplicateGroups).toContainEqual(
      expect.objectContaining({ classification: 'shared_apn_distinct_units' }),
    );
  });

  it('prefers an exact address-unit key over a shared parcel APN', () => {
    const permit = entity('permit-unit', 'permit', {
      normalizedKeys: [
        { kind: 'apn', value: '12345678' },
        { kind: 'address_unit', value: '100 main st|unit b' },
      ],
    });
    const units = [
      entity('unit-a', 'property-unit', {
        normalizedKeys: [
          { kind: 'apn', value: '12345678' },
          { kind: 'address_unit', value: '100 main st|unit a' },
        ],
      }),
      entity('unit-b', 'property-unit', {
        normalizedKeys: [
          { kind: 'apn', value: '12345678' },
          { kind: 'address_unit', value: '100 main st|unit b' },
        ],
      }),
    ];

    expect(linkEntities('permit_property', [permit], units).resolutions[0]).toMatchObject({
      state: 'accepted',
      matchStage: 'normalized_exact',
      acceptedTargetEntityId: 'unit-b',
    });
  });

  it('deduplicates identical replays without first-row collapsing distinct entities', () => {
    const permit = entity('permit-replay', 'permit', {
      normalizedKeys: [{ kind: 'apn', value: '11122333' }],
    });
    const property = entity('property-1', 'property', {
      normalizedKeys: [{ kind: 'apn', value: '11122333' }],
    });

    const result = linkEntities('permit_property', [permit, permit], [property, property]);

    expect(result.resolutions).toHaveLength(1);
    expect(
      result.duplicateGroups.filter(({ classification }) => classification === 'replay_duplicate'),
    ).toHaveLength(2);
  });

  it('hard-blocks a false unit merge even when the address is identical', () => {
    const permit = entity('permit-unit-a', 'permit', {
      candidateAttributes: { address: '100 Main Street', unit: 'A', postalCode: '94301' },
    });
    const wrongUnit = entity('unit-b', 'property-unit', {
      candidateAttributes: { address: '100 Main Street', unit: 'B', postalCode: '94301' },
    });

    expect(linkEntities('permit_property', [permit], [wrongUnit]).resolutions[0]).toMatchObject({
      state: 'unresolved',
      acceptedTargetEntityId: null,
      gapReasons: ['candidate_below_threshold', 'no_authoritative_or_exact_match'],
    });
  });

  it('keeps a bounded candidate separate until an immutable review accepts it', () => {
    const permit = entity('permit-candidate', 'permit', {
      candidateAttributes: { address: '500 University Avenue', postalCode: '94301' },
    });
    const property = entity('property-candidate', 'property', {
      candidateAttributes: { address: '500 University Avenue', postalCode: '94301' },
    });
    const proposed = linkEntities('permit_property', [permit], [property]);
    const proposal = proposed.resolutions[0]?.proposals[0];
    expect(proposal).toBeDefined();
    expect(proposed.resolutions[0]).toMatchObject({
      state: 'candidate',
      acceptedTargetEntityId: null,
    });
    expect(proposal).toMatchObject({
      proposalState: 'candidate',
      method: 'bounded_candidate',
      score: 1,
    });
    if (proposal === undefined) throw new Error('Expected a candidate proposal');
    const review = createReviewDecision({
      proposalId: proposal.proposalId,
      outcome: 'accepted',
      reviewerRef: 'review-policy-fixture',
      decidedAt: '2026-07-17T12:00:00.000Z',
      rationale: 'Fixture review confirms the address candidate.',
      supersedesDecisionId: null,
      evidenceLineage: lineage,
      visibility: 'authenticated',
    });

    const reviewed = linkEntities('permit_property', [permit], [property], [review]);

    expect(reviewed.resolutions[0]).toMatchObject({
      state: 'review_accepted',
      acceptedTargetEntityId: 'property-candidate',
      visibility: 'authenticated',
    });
    expect(reviewed.resolutions[0]?.proposals[0]?.proposalState).toBe('candidate');
    expect(reviewed.resolutions[0]?.reviewDecisions).toEqual([review]);
  });

  it('includes the candidate threshold boundary and rejects the value below it', () => {
    const permit = entity('permit-threshold', 'permit', {
      candidateAttributes: {
        address: '100 North Main Street Palo',
        postalCode: '94301',
      },
    });
    const atThreshold = entity('property-at-threshold', 'property', {
      candidateAttributes: { address: '100 North Main Street', postalCode: '94301' },
    });
    const belowThreshold = entity('property-below-threshold', 'property', {
      candidateAttributes: { address: '100 North Main', postalCode: '94301' },
    });

    const result = linkEntities('permit_property', [permit], [atThreshold, belowThreshold]);

    expect(result.resolutions[0]).toMatchObject({ state: 'candidate' });
    expect(result.resolutions[0]?.proposals).toHaveLength(1);
    expect(result.resolutions[0]?.proposals[0]).toMatchObject({
      targetEntityId: 'property-at-threshold',
      score: 0.84,
    });
  });

  it('does not use permit owner-like text as ownership or property evidence', () => {
    const permit = entity('permit-owner-text', 'permit', {
      candidateAttributes: { name: 'Example Owner LLC' },
    });
    const property = entity('property-owner-text', 'property', {
      candidateAttributes: { name: 'Example Owner LLC' },
    });

    expect(linkEntities('permit_property', [permit], [property]).resolutions[0]).toMatchObject({
      state: 'unresolved',
      gapReasons: ['no_candidate_signals', 'no_authoritative_or_exact_match'],
    });
    expect(() => linkEntities('ownership_party', [permit], [entity('party-1', 'party')])).toThrow(
      /subject kind/u,
    );
  });

  it('preserves blocked and partial business/ownership evidence without positive upgrades', () => {
    const blockedBusiness = entity('business-blocked', 'business', {
      evidenceAvailability: 'blocked',
      normalizedKeys: [{ kind: 'address', value: '10 Market St' }],
    });
    const address = entity('address-1', 'address', {
      normalizedKeys: [{ kind: 'address', value: '10 Market St' }],
    });
    expect(
      linkEntities('business_address', [blockedBusiness], [address]).resolutions[0],
    ).toMatchObject({
      state: 'unknown',
      acceptedTargetEntityId: null,
      evidenceAvailability: 'blocked',
      gapReasons: ['source_blocked'],
    });

    const partialInterest = entity('interest-partial', 'ownership-interest', {
      evidenceAvailability: 'partial',
      normalizedKeys: [{ kind: 'apn', value: '22233444' }],
      visibility: 'restricted',
    });
    const property = entity('property-partial', 'property', {
      normalizedKeys: [{ kind: 'apn', value: '22233444' }],
    });
    expect(
      linkEntities('ownership_property', [partialInterest], [property]).resolutions[0],
    ).toMatchObject({
      state: 'accepted',
      evidenceAvailability: 'partial',
      strictClaimEligible: false,
      visibility: 'restricted',
    });
  });

  it.each([
    ['property_address', 'address', 'property', 'county-parcel-id'],
    ['property_unit', 'address', 'property-unit', 'source-unit-id'],
    ['permit_contractor', 'permit', 'contractor', 'cslb-license'],
    ['contractor_business', 'contractor', 'business', 'ca-sos-entity'],
    ['business_address', 'business', 'address', 'source-address-id'],
    ['ownership_party', 'ownership-interest', 'party', 'source-party-id'],
    ['transfer_property', 'ownership-event', 'property', 'source-property-id'],
  ] as const)(
    'links %s by its domain authority identifier',
    (relation, subjectKind, targetKind, scheme) => {
      const subject = entity(`subject-${relation}`, subjectKind, {
        identifiers: [{ scheme, value: 'ID-900', scope: 'statewide' }],
      });
      const target = entity(`target-${relation}`, targetKind, {
        identifiers: [{ scheme, value: 'id-900', scope: 'STATEWIDE' }],
      });
      expect(linkEntities(relation, [subject], [target]).resolutions[0]).toMatchObject({
        state: 'accepted',
        matchStage: 'authoritative_identifier',
        acceptedTargetEntityId: `target-${relation}`,
      });
    },
  );

  it('fails closed when the bounded candidate pool is too large', () => {
    const permit = entity('permit-large-pool', 'permit', {
      candidateAttributes: { address: '1 Main St' },
    });
    const targets = Array.from({ length: 26 }, (_, index) =>
      entity(`property-${index.toString().padStart(2, '0')}`, 'property', {
        candidateAttributes: { address: `1 Main St Unit ${index}` },
      }),
    );

    expect(linkEntities('permit_property', [permit], targets).resolutions[0]).toMatchObject({
      state: 'unresolved',
      gapReasons: ['candidate_pool_exceeded'],
      proposals: [],
    });
  });
});
