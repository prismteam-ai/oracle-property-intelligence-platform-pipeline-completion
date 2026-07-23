import { snapshotIdSchema } from '@oracle/contracts/ids';
import { describe, expect, it } from 'vitest';

import { reduceCanonicalMutations } from '../entities/reducer.js';
import { normalizePermitRecord } from './permit.js';
import type { PermitSourceRecord } from './permit.js';
import { testContext } from './test-context.test-support.js';

const issuedOnly: PermitSourceRecord = {
  permitNumber: 'B-2020-001',
  jurisdiction: 'San Jose',
  permitType: 'Roof replacement',
  status: 'Issued',
  statusAsOf: '2020-02-01T00:00:00.000Z',
  description: 'Reroof residence',
  apn: '123-45-678',
  appliedAt: '2020-01-01T00:00:00.000Z',
  issuedAt: '2020-02-01T00:00:00.000Z',
  finaledAt: null,
  expiredAt: null,
  ownerText: 'SOURCE OWNER TEXT',
};

describe('permit normalization', () => {
  it('keeps applied, issued, finaled, and expired dates distinct', () => {
    const mutations = normalizePermitRecord(issuedOnly, testContext());
    const aggregate = reduceCanonicalMutations(mutations).entities[0];
    expect(aggregate?.entity).toMatchObject({
      entityKind: 'permit',
      issuedAt: '2020-02-01T00:00:00.000Z',
      completedAt: null,
      status: 'Issued',
    });
    const observations = Object.fromEntries(
      (aggregate?.observations ?? []).map(({ fieldPath, value }) => [fieldPath, value]),
    );
    expect(observations).toMatchObject({
      '/appliedAt': '2020-01-01T00:00:00.000Z',
      '/issuedAt': '2020-02-01T00:00:00.000Z',
      '/finaledAt': null,
      '/expiredAt': null,
    });
  });

  it('never treats owner text as ownership or issued work as completed work', () => {
    const reduction = reduceCanonicalMutations(normalizePermitRecord(issuedOnly, testContext()));
    expect(reduction.entities).toHaveLength(1);
    expect(reduction.entities[0]?.entity.entityKind).toBe('permit');
    expect(reduction.entities[0]?.entity).toMatchObject({ completedAt: null });
    expect(
      reduction.entities[0]?.observations.find(({ fieldPath }) => fieldPath === '/sourceOwnerText')
        ?.value,
    ).toBe('SOURCE OWNER TEXT');
  });

  it('populates completedAt only from explicit finaled evidence and preserves history', () => {
    const earlier = normalizePermitRecord(
      issuedOnly,
      testContext({
        observedAt: '2020-02-02T00:00:00.000Z',
        sourceAsOf: '2020-02-01T00:00:00.000Z',
      }),
    );
    const later = normalizePermitRecord(
      {
        ...issuedOnly,
        status: 'Finaled',
        statusAsOf: '2020-08-01T00:00:00.000Z',
        finaledAt: '2020-08-01T00:00:00.000Z',
      },
      testContext({
        snapshotId: snapshotIdSchema.parse(`sc:snapshot:test-source:${'7'.repeat(64)}`),
        sourceRecordSha256: '8'.repeat(64),
        observedAt: '2020-08-02T00:00:00.000Z',
        sourceAsOf: '2020-08-01T00:00:00.000Z',
        sequenceStart: 100,
      }),
    );
    const aggregate = reduceCanonicalMutations([...later, ...earlier]).entities[0];
    expect(aggregate?.entity).toMatchObject({
      status: 'Finaled',
      completedAt: '2020-08-01T00:00:00.000Z',
    });
    expect(
      aggregate?.observations
        .filter(({ fieldPath }) => fieldPath === '/status')
        .map(({ value }) => value),
    ).toEqual(expect.arrayContaining(['Issued', 'Finaled']));
    expect(aggregate?.conflicts).toEqual(
      expect.arrayContaining([expect.objectContaining({ fieldPath: '/status' })]),
    );
  });

  it('represents missing property evidence as unknown instead of inventing a link', () => {
    const aggregate = reduceCanonicalMutations(
      normalizePermitRecord({ ...issuedOnly, apn: null }, testContext()),
    ).entities[0];
    expect(aggregate?.entity).toMatchObject({ propertyLinks: [] });
    expect(
      aggregate?.observations.find(({ fieldPath }) => fieldPath === '/sourceApn')?.value,
    ).toBeNull();
  });

  it('does not treat expiration as completion', () => {
    const aggregate = reduceCanonicalMutations(
      normalizePermitRecord(
        {
          ...issuedOnly,
          status: 'Expired',
          statusAsOf: '2021-02-01T00:00:00.000Z',
          finaledAt: null,
          expiredAt: '2021-02-01T00:00:00.000Z',
        },
        testContext(),
      ),
    ).entities[0];
    expect(aggregate?.entity).toMatchObject({ status: 'Expired', completedAt: null });
    expect(aggregate?.observations.find(({ fieldPath }) => fieldPath === '/expiredAt')?.value).toBe(
      '2021-02-01T00:00:00.000Z',
    );
  });

  it('rejects malformed APNs and dates without coercion', () => {
    expect(() => normalizePermitRecord({ ...issuedOnly, apn: '12-34' }, testContext())).toThrow(
      /eight digits/u,
    );
    expect(() =>
      normalizePermitRecord({ ...issuedOnly, issuedAt: '2020-02-01' }, testContext()),
    ).toThrow(/ISO-8601/u);
    expect(() =>
      normalizePermitRecord({ ...issuedOnly, statusAsOf: 'not-a-date' }, testContext()),
    ).toThrow(/ISO-8601/u);
  });
});
