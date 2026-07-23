import { readFileSync } from 'node:fs';

import { canonicalMutationSchema } from '@oracle/contracts/canonical/mutation';
import { describe, expect, it } from 'vitest';

import { reduceCanonicalMutations } from '../entities/reducer.js';
import { normalizePropertyRecord } from './property.js';
import type { PropertySourceRecord } from './property.js';
import { testContext } from './test-context.test-support.js';

type FixtureFile = Readonly<{
  provenance: Readonly<{ basis: string; repositoryPath: string; sourceHash: string }>;
  parcel: PropertySourceRecord;
}>;

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../testkit/src/canonical/source-fixtures.json', import.meta.url),
    'utf8',
  ),
) as FixtureFile;

describe('property, unit, and address normalization', () => {
  it('normalizes the Wave 1 source-shaped parcel fixture with full field lineage', () => {
    expect(fixture.provenance).toMatchObject({
      basis: 'Wave 1 official Santa Clara County Parcels excerpt',
      repositoryPath:
        'packages/testkit/src/sources/santa-clara-socrata-parcels/duplicate-apn.geojson',
      sourceHash: '5a6579c59fbe93034334ed8f4ff16b75851369b31b2bada7fcdebd7b3b2de433',
    });
    const mutations = normalizePropertyRecord(fixture.parcel, testContext());
    expect(mutations.every((mutation) => canonicalMutationSchema.safeParse(mutation).success)).toBe(
      true,
    );
    expect(new Set(mutations.map(({ mutationId }) => mutationId)).size).toBe(mutations.length);

    const reduction = reduceCanonicalMutations(mutations);
    expect(reduction.entities.map(({ entity }) => entity.entityKind).sort()).toEqual([
      'address',
      'property',
    ]);
    const property = reduction.entities.find(({ entity }) => entity.entityKind === 'property');
    expect(property?.entity).toMatchObject({ apn: '127-69-001', jurisdiction: 'PALO ALTO' });
    expect(property?.observations.map(({ fieldPath }) => fieldPath)).toEqual(
      expect.arrayContaining([
        '/apn',
        '/jurisdiction',
        '/landAreaSquareMeters',
        '/parcelGeometry',
        '/primaryAddressId',
        '/unitIds',
        '/yearBuilt',
        '/effectiveYearBuilt',
      ]),
    );
    expect(property?.observations.every(({ lineage }) => lineage.transformations.length > 0)).toBe(
      true,
    );
  });

  it('preserves shared-APN units instead of selecting the first row', () => {
    const base = { ...fixture.parcel, address: null } satisfies PropertySourceRecord;
    const first = normalizePropertyRecord(
      { ...base, unit: { unitIdentifier: '101', assessmentIdentifier: 'ASSESS-101' } },
      testContext({ sourceRecordKey: 'unit-101', sourceRecordSha256: '5'.repeat(64) }),
    );
    const second = normalizePropertyRecord(
      { ...base, unit: { unitIdentifier: '102', assessmentIdentifier: 'ASSESS-102' } },
      testContext({
        sourceRecordKey: 'unit-102',
        sourceRecordSha256: '6'.repeat(64),
        sequenceStart: 100,
      }),
    );

    const reduction = reduceCanonicalMutations([...second, ...first]);
    const property = reduction.entities.find(({ entity }) => entity.entityKind === 'property');
    const units = reduction.entities.filter(({ entity }) => entity.entityKind === 'property-unit');
    expect(units).toHaveLength(2);
    expect(property?.entity).toMatchObject({
      unitIds: units.map(({ entity }) => entity.id).sort(),
    });
    expect(property?.conflicts).toContainEqual(
      expect.objectContaining({
        fieldPath: '/unitIds',
        resolution: expect.objectContaining({ state: 'coexist', method: 'multivalued' }),
      }),
    );
  });

  it('is deterministic across APN formatting and input replay', () => {
    const first = normalizePropertyRecord(fixture.parcel, testContext());
    const second = normalizePropertyRecord({ ...fixture.parcel, apn: '127-69-001' }, testContext());
    const firstProperty = first.find(
      (mutation) => mutation.kind === 'entity_upsert' && mutation.entity.entityKind === 'property',
    );
    const secondProperty = second.find(
      (mutation) => mutation.kind === 'entity_upsert' && mutation.entity.entityKind === 'property',
    );
    expect(firstProperty?.kind === 'entity_upsert' ? firstProperty.entity.id : null).toBe(
      secondProperty?.kind === 'entity_upsert' ? secondProperty.entity.id : null,
    );
    expect(reduceCanonicalMutations([...first, ...first])).toEqual(reduceCanonicalMutations(first));
  });

  it('rejects malformed coordinates, postal codes, and areas', () => {
    const address = fixture.parcel.address;
    if (address === null || address === undefined) {
      throw new Error('Expected the Wave 1 address fixture');
    }
    expect(() =>
      normalizePropertyRecord(
        {
          ...fixture.parcel,
          address: { ...address, location: { type: 'Point', coordinates: [-222, 37] } },
        },
        testContext(),
      ),
    ).toThrow();
    expect(() =>
      normalizePropertyRecord(
        { ...fixture.parcel, address: { ...address, postalCode: '9430' } },
        testContext(),
      ),
    ).toThrow(/postalCode/u);
    expect(() =>
      normalizePropertyRecord({ ...fixture.parcel, landAreaSquareMeters: -1 }, testContext()),
    ).toThrow(/landArea/u);
  });

  it('rejects source schema drift instead of silently dropping fields', () => {
    const drifted = { ...fixture.parcel, roofAge: 20 };
    expect(() => normalizePropertyRecord(drifted, testContext())).toThrow(/unexpected field/u);
  });

  it('preserves building-year evidence without inventing roof age', () => {
    const aggregate = reduceCanonicalMutations(
      normalizePropertyRecord(
        { ...fixture.parcel, yearBuilt: 1962, effectiveYearBuilt: 1998 },
        testContext(),
      ),
    ).entities.find(({ entity }) => entity.entityKind === 'property');
    expect(aggregate?.observations.find(({ fieldPath }) => fieldPath === '/yearBuilt')?.value).toBe(
      1962,
    );
    expect(
      aggregate?.observations.find(({ fieldPath }) => fieldPath === '/effectiveYearBuilt')?.value,
    ).toBe(1998);
    expect(aggregate?.entity).not.toHaveProperty('roofAge');
    expect(aggregate?.entity).not.toHaveProperty('yearBuilt');
  });
});
