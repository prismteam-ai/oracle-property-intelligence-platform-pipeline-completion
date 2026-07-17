import { describe, expect, it } from 'vitest';

import { canonicalEntitySchema, canonicalMutationSchema } from './mutation.js';

const hash = 'a'.repeat(64);
const sourceId = 'sc:source:scc-parcels';
const snapshotId = `sc:snapshot:scc-parcels:${hash}`;
const artifactId = `sc:artifact:sha256:${hash}`;
const at = '2026-07-17T00:00:00.000Z';

const lineage = {
  sourceRecord: {
    sourceId,
    snapshotId,
    artifactId,
    recordKey: 'row-1',
    recordSha256: hash,
    rawPointer: '/rows/0',
  },
  transformations: [
    {
      name: 'normalize-fixture',
      version: '1.0.0',
      appliedAt: at,
      inputSha256: hash,
      outputSha256: hash,
    },
  ],
  lineageSha256: hash,
};

function metadata(entityKind: string, stableKey: string) {
  return {
    id: `sc:entity:${entityKind}:${stableKey}`,
    entityKind,
    version: 1,
    validFrom: at,
    validTo: null,
    recordedAt: at,
    visibility: 'public',
    sourceIds: [sourceId],
    lineage: [lineage],
  };
}

const point = { type: 'Point', coordinates: [-121.9, 37.3] };

const property = {
  ...metadata('property', 'apn-123'),
  county: 'Santa Clara',
  state: 'CA',
  apn: '123-456-78',
  jurisdiction: 'Palo Alto',
  primaryAddressId: 'sc:entity:address:addr-1',
  unitIds: ['sc:entity:property-unit:unit-1'],
  parcelGeometry: point,
  landAreaSquareMeters: 500,
};

describe('canonical entities', () => {
  it('accepts every frozen canonical entity kind', () => {
    const entities = [
      property,
      {
        ...metadata('property-unit', 'unit-1'),
        propertyId: property.id,
        unitIdentifier: 'A',
        assessmentIdentifier: 'ASSESS-1',
        addressId: 'sc:entity:address:addr-1',
      },
      {
        ...metadata('address', 'addr-1'),
        line1: '1 Main St',
        line2: null,
        locality: 'Palo Alto',
        region: 'CA',
        postalCode: '94301',
        country: 'US',
        normalized: '1 MAIN ST PALO ALTO CA 94301',
        location: point,
      },
      {
        ...metadata('permit', 'permit-1'),
        permitNumber: 'P-1',
        jurisdiction: 'Palo Alto',
        permitType: 'Roof',
        status: 'Finaled',
        statusAsOf: at,
        description: 'Roof replacement',
        issuedAt: at,
        completedAt: at,
        propertyLinks: [
          { propertyId: property.id, propertyUnitId: null, method: 'source_identifier', score: 1 },
        ],
        contractorIds: ['sc:entity:contractor:license-1'],
      },
      {
        ...metadata('party', 'party-1'),
        partyKind: 'organization',
        displayName: 'Example Holdings LLC',
        identifiers: [{ scheme: 'ca-sos', value: 'B12345678901' }],
        addressIds: ['sc:entity:address:addr-1'],
      },
      {
        ...metadata('ownership-interest', 'interest-1'),
        propertyId: property.id,
        propertyUnitId: null,
        partyId: 'sc:entity:party:party-1',
        interestType: 'fee-simple',
        share: 1,
        effectiveFrom: at,
        effectiveTo: null,
        supportState: 'supported',
      },
      {
        ...metadata('ownership-event', 'event-1'),
        propertyId: property.id,
        propertyUnitId: null,
        eventType: 'transfer',
        recordedDocumentId: 'DOC-1',
        occurredAt: at,
        grantorPartyIds: ['sc:entity:party:party-1'],
        granteePartyIds: ['sc:entity:party:party-2'],
        supportState: 'supported',
      },
      {
        ...metadata('contractor', 'license-1'),
        licenseNumber: '123456',
        legalName: 'Roof Co',
        status: 'active',
        classifications: ['C-39'],
        businessIds: ['sc:entity:business:business-1'],
        addressIds: ['sc:entity:address:addr-1'],
      },
      {
        ...metadata('business', 'business-1'),
        jurisdiction: 'CA',
        entityNumber: 'B12345678901',
        legalName: 'Roof Co LLC',
        status: 'active',
        businessType: 'LLC',
        addressIds: ['sc:entity:address:addr-1'],
      },
      {
        ...metadata('transit-stop', 'stop-1'),
        agencyId: 'VTA',
        stopCode: '1001',
        name: 'University Ave',
        location: point,
        parentStopId: null,
        boardable: true,
        serviceIds: ['sc:entity:transit-service:service-1'],
      },
      {
        ...metadata('transit-service', 'service-1'),
        agencyId: 'VTA',
        routeId: '22',
        mode: 'bus',
        serviceStartDate: '2026-07-01',
        serviceEndDate: '2026-12-31',
      },
      {
        ...metadata('place', 'place-1'),
        name: 'Starbucks',
        categories: ['coffee_shop'],
        brandIdentifiers: ['wikidata:Q37158'],
        location: point,
        confidence: 0.9,
        operatingState: 'candidate',
      },
      {
        ...metadata('hydro-feature', 'water-1'),
        name: 'San Francisco Bay',
        featureType: 'shoreline',
        geometry: {
          type: 'LineString',
          coordinates: [
            [-122, 37.4],
            [-121.9, 37.3],
          ],
        },
      },
      {
        ...metadata('pedestrian-graph-ref', 'graph-1'),
        artifactId,
        bounds: [-122.2, 37.1, -121.5, 37.6],
        nodeCount: 100,
        edgeCount: 200,
        routingProfileVersion: '1.0.0',
      },
      {
        ...metadata('elevation-raster-ref', 'dem-1'),
        artifactId,
        bounds: [-122.2, 37.1, -121.5, 37.6],
        horizontalResolutionMeters: 10,
        verticalDatum: 'NAVD88',
        sourceAsOf: at,
      },
    ];

    expect(entities.map((entity) => canonicalEntitySchema.parse(entity).entityKind)).toEqual([
      'property',
      'property-unit',
      'address',
      'permit',
      'party',
      'ownership-interest',
      'ownership-event',
      'contractor',
      'business',
      'transit-stop',
      'transit-service',
      'place',
      'hydro-feature',
      'pedestrian-graph-ref',
      'elevation-raster-ref',
    ]);
  });

  it('rejects entities with missing lineage or mismatched deterministic ID namespaces', () => {
    const withoutLineage = Object.fromEntries(
      Object.entries(property).filter(([key]) => key !== 'lineage'),
    );
    expect(canonicalEntitySchema.safeParse(withoutLineage).success).toBe(false);
    expect(
      canonicalEntitySchema.safeParse({
        ...property,
        id: 'sc:entity:permit:apn-123',
      }).success,
    ).toBe(false);
  });

  it('preserves visibility through discriminated canonical mutations', () => {
    const context = {
      mutationId: `sc:mutation:${hash}`,
      runId: `sc:run:${hash}`,
      sourceId,
      snapshotId,
      sequence: 0,
      emittedAt: at,
      visibility: 'public',
    };
    const mutation = {
      kind: 'entity_upsert',
      ...context,
      entity: property,
    };
    expect(canonicalMutationSchema.parse(mutation).kind).toBe('entity_upsert');
    expect(
      canonicalMutationSchema.safeParse({ ...mutation, visibility: 'restricted' }).success,
    ).toBe(false);

    const crossSourceContext = {
      ...context,
      snapshotId: `sc:snapshot:other-source:${hash}`,
    };
    const crossSourceMutations = [
      { kind: 'entity_upsert', ...crossSourceContext, entity: property },
      {
        kind: 'field_observation',
        ...crossSourceContext,
        observation: {
          observationId: `sc:observation:${hash}`,
          entityId: property.id,
          entityKind: 'property',
          fieldPath: '/apn',
          value: property.apn,
          observedAt: at,
          sourceAsOf: at,
          authorityRank: 100,
          confidence: 1,
          visibility: 'public',
          lineage,
        },
      },
      {
        kind: 'link_candidate',
        ...crossSourceContext,
        link: {
          linkId: `sc:link:${hash}`,
          fromEntityId: property.id,
          toEntityId: 'sc:entity:address:addr-1',
          method: 'authoritative',
          score: 1,
          evidenceObservationIds: [`sc:observation:${hash}`],
          algorithmVersion: '1.0.0',
          reviewStatus: 'accepted',
        },
      },
      {
        kind: 'artifact_reference',
        ...crossSourceContext,
        artifact: {
          artifactId,
          role: 'canonical',
          entityId: property.id,
          description: 'Canonical property artifact',
        },
      },
    ];

    expect(
      crossSourceMutations.every(
        (crossSourceMutation) => !canonicalMutationSchema.safeParse(crossSourceMutation).success,
      ),
    ).toBe(true);
  });
});
