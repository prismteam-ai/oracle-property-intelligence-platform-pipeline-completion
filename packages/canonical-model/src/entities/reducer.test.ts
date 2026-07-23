import { sourceIdSchema } from '@oracle/contracts/ids';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../normalizers/core.js';
import { normalizePropertyRecord } from '../normalizers/property.js';
import { testContext } from '../normalizers/test-context.test-support.js';
import { reduceCanonicalMutations } from './reducer.js';

const record = {
  apn: '123-45-678',
  jurisdiction: 'Palo Alto',
  address: null,
  unit: null,
  parcelGeometry: null,
  landAreaSquareMeters: null,
} as const;

describe('canonical mutation reduction', () => {
  it('is replay-idempotent and independent of mutation input order', () => {
    const mutations = normalizePropertyRecord(record, testContext());
    const forward = reduceCanonicalMutations(mutations);
    const reverse = reduceCanonicalMutations([...mutations].reverse());
    const replay = reduceCanonicalMutations([...mutations, ...mutations]);
    expect(canonicalJson(reverse)).toBe(canonicalJson(forward));
    expect(canonicalJson(replay)).toBe(canonicalJson(forward));
  });

  it('uses frozen precedence, preserves conflict history, and prevents visibility downgrade', () => {
    const official = normalizePropertyRecord(
      record,
      testContext({
        sourceId: sourceIdSchema.parse('sc:source:county-parcels'),
        authorityRank: 90,
        observedAt: '2026-01-02T00:00:00.000Z',
        sourceAsOf: '2026-01-01T00:00:00.000Z',
        visibility: 'restricted',
      }),
    );
    const newerLowerAuthority = normalizePropertyRecord(
      { ...record, jurisdiction: 'Conflicting City' },
      testContext({
        sourceId: sourceIdSchema.parse('sc:source:secondary-map'),
        authorityRank: 20,
        observedAt: '2026-07-17T00:00:00.000Z',
        sourceAsOf: '2026-07-16T00:00:00.000Z',
        visibility: 'public',
        sequenceStart: 100,
      }),
    );
    const aggregate = reduceCanonicalMutations([...newerLowerAuthority, ...official]).entities[0];
    expect(aggregate?.entity).toMatchObject({
      jurisdiction: 'Palo Alto',
      visibility: 'restricted',
    });
    expect(aggregate?.entity.sourceIds).toEqual([
      'sc:source:county-parcels',
      'sc:source:secondary-map',
    ]);
    expect(aggregate?.conflicts).toContainEqual(
      expect.objectContaining({
        fieldPath: '/jurisdiction',
        resolution: expect.objectContaining({
          state: 'selected',
          method: 'authority_precedence',
        }),
      }),
    );
    expect(
      aggregate?.observations.filter(({ fieldPath }) => fieldPath === '/jurisdiction'),
    ).toHaveLength(2);
  });

  it('preserves prohibited_public when a later public replay arrives', () => {
    const prohibited = normalizePropertyRecord(
      record,
      testContext({ visibility: 'prohibited_public' }),
    );
    const laterPublic = normalizePropertyRecord(
      record,
      testContext({
        observedAt: '2026-07-18T00:00:00.000Z',
        sourceAsOf: '2026-07-18T00:00:00.000Z',
        sourceRecordSha256: 'a'.repeat(64),
        visibility: 'public',
        sequenceStart: 100,
      }),
    );
    expect(
      reduceCanonicalMutations([...prohibited, ...laterPublic]).entities[0]?.entity.visibility,
    ).toBe('prohibited_public');
  });

  it('retains every visibility class through reduction', () => {
    const visibilities = ['public', 'authenticated', 'restricted', 'prohibited_public'] as const;
    const mutations = visibilities.flatMap((visibility, index) =>
      normalizePropertyRecord(
        record,
        testContext({
          sourceRecordKey: `visibility-${visibility}`,
          sourceRecordSha256: (index + 1).toString().repeat(64),
          visibility,
          sequenceStart: index * 100,
        }),
      ),
    );
    const aggregate = reduceCanonicalMutations(mutations).entities[0];
    expect(aggregate?.entity.visibility).toBe('prohibited_public');
    expect(new Set(aggregate?.observations.map(({ visibility }) => visibility))).toEqual(
      new Set(visibilities),
    );
  });

  it('rejects strict-schema additions, missing lineage, and missing field observations', () => {
    const mutations = normalizePropertyRecord(record, testContext());
    expect(() => reduceCanonicalMutations([{ ...mutations[0], unexpected: true }])).toThrow();

    const observation = mutations.find((mutation) => mutation.kind === 'field_observation');
    if (observation === undefined) {
      throw new Error('Expected a field observation fixture');
    }
    const withoutLineage = structuredClone(observation) as unknown as {
      observation: { lineage?: unknown };
    };
    delete withoutLineage.observation.lineage;
    expect(() => reduceCanonicalMutations([withoutLineage])).toThrow();

    const withoutJurisdiction = mutations.filter(
      (mutation) =>
        mutation.kind !== 'field_observation' || mutation.observation.fieldPath !== '/jurisdiction',
    );
    expect(() => reduceCanonicalMutations(withoutJurisdiction)).toThrow(
      /missing immutable observation/u,
    );
  });

  it('rejects identity reuse with different content', () => {
    const mutations = normalizePropertyRecord(record, testContext());
    const first = mutations[0];
    if (first === undefined) {
      throw new Error('Expected mutation fixture');
    }
    const forged = { ...first, sequence: first.sequence + 1 };
    expect(() => reduceCanonicalMutations([first, forged])).toThrow(
      /reused for different content/u,
    );
    expect(() => reduceCanonicalMutations([{ ...first, mutationId: 'malformed' }])).toThrow();
  });

  it('sorts multiple entity aggregates by deterministic ID', () => {
    const first = normalizePropertyRecord(record, testContext());
    const second = normalizePropertyRecord(
      { ...record, apn: '999-99-999' },
      testContext({
        sourceRecordKey: 'row-2',
        sourceRecordSha256: 'b'.repeat(64),
        sequenceStart: 100,
      }),
    );
    const ids = reduceCanonicalMutations([...second, ...first]).entities.map(
      ({ entity }) => entity.id,
    );
    expect(ids).toEqual([...ids].sort());
  });
});
