import { describe, expect, it } from 'vitest';
import { createSharedRecordBudget } from '../../spi/record-budget.js';

import { OvertureStarbucksAdapter } from './adapter.js';
import { deduplicateStarbucksCandidates } from './deduplication.js';
import { applyManualLocatorValidation } from './manual-validation.js';
import { classifyStarbucksMatch } from './matching.js';
import {
  TestArtifactStore,
  TestClock,
  UNUSED_RUNTIME,
  acquiredFixture,
  fixtureConfig,
} from './test-helpers.js';
import type { OvertureDecodedPlace, OvertureStarbucksCandidate } from './types.js';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function records(): Promise<
  Readonly<{
    adapter: OvertureStarbucksAdapter;
    decoded: readonly OvertureDecodedPlace[];
    candidates: readonly OvertureStarbucksCandidate[];
  }>
> {
  const adapter = new OvertureStarbucksAdapter({ artifact: await fixtureConfig() });
  const decoded = await collect(
    adapter.decode(await acquiredFixture(), {
      artifactStore: new TestArtifactStore(),
      analyticalRuntime: UNUSED_RUNTIME,
      recordBudget: createSharedRecordBudget(1),
      clock: new TestClock(),
      signal: signal(),
    }),
  );
  const results = await Promise.all(
    decoded.map((record) =>
      adapter.validate(record, {
        clock: new TestClock(),
        signal: signal(),
      }),
    ),
  );
  const candidates = results.flatMap((result) =>
    result.status === 'accepted' ? [result.record] : [],
  );
  return Object.freeze({
    adapter,
    decoded: Object.freeze(decoded),
    candidates: Object.freeze(candidates),
  });
}

describe('Overture Starbucks evidence semantics', () => {
  it('classifies Wikidata, brand-name, name/category, name-only, and no-match modes', () => {
    const base = {
      names: { primary: 'Starbucks', common: {}, rules: [] },
      categories: { primary: 'coffee_shop', alternate: [] },
      brand: { wikidata: 'Q37158', names: { primary: 'Starbucks', common: {}, rules: [] } },
    } as const;
    expect(classifyStarbucksMatch(base).mode).toBe('wikidata_exact');
    expect(classifyStarbucksMatch({ ...base, brand: { ...base.brand, wikidata: null } }).mode).toBe(
      'brand_name_exact',
    );
    expect(classifyStarbucksMatch({ ...base, brand: null }).mode).toBe('category_name_combination');
    expect(
      classifyStarbucksMatch({
        ...base,
        brand: null,
        categories: { primary: 'retail', alternate: [] },
      }).mode,
    ).toBe('primary_name_exact');
    expect(
      classifyStarbucksMatch({
        ...base,
        names: { primary: 'Independent Coffee', common: {}, rules: [] },
        brand: null,
      }).mode,
    ).toBe('no_match');
  });

  it('preserves low-confidence, closed, unknown, and prohibited-public states', async () => {
    const { adapter, decoded } = await records();
    const original = decoded[1];
    if (original === undefined) throw new Error('fixture record missing');
    const low = {
      ...original,
      properties: { ...original.properties, confidence: 0.2 },
    } as OvertureDecodedPlace;
    const closed = {
      ...original,
      properties: { ...original.properties, operating_status: 'permanently_closed' },
    } as OvertureDecodedPlace;
    const unknown = {
      ...original,
      properties: { ...original.properties, operating_status: null },
    } as OvertureDecodedPlace;
    const sources = original.properties.sources as unknown as Record<string, unknown>[];
    const unknownLicense = {
      ...original,
      properties: {
        ...original.properties,
        sources: sources.map((source, index) =>
          index === 0 ? { ...source, license: 'Unknown-1.0' } : source,
        ),
      },
    } as OvertureDecodedPlace;
    const lowResult = await adapter.validate(low, { clock: new TestClock(), signal: signal() });
    const closedResult = await adapter.validate(closed, {
      clock: new TestClock(),
      signal: signal(),
    });
    const unknownResult = await adapter.validate(unknown, {
      clock: new TestClock(),
      signal: signal(),
    });
    const licenseResult = await adapter.validate(unknownLicense, {
      clock: new TestClock(),
      signal: signal(),
    });
    expect(lowResult).toMatchObject({
      status: 'accepted',
      record: { candidateState: 'low_confidence_candidate' },
    });
    expect(closedResult).toMatchObject({
      status: 'accepted',
      record: { candidateState: 'closed_candidate' },
    });
    expect(unknownResult).toMatchObject({
      status: 'accepted',
      record: { overtureOperatingStatus: 'unknown', validation: { state: 'not_sampled' } },
    });
    expect(licenseResult).toMatchObject({
      status: 'accepted',
      record: { visibility: 'prohibited_public' },
    });
  });

  it('rejects a non-Starbucks place instead of turning a category into a fact', async () => {
    const { adapter, decoded } = await records();
    const original = decoded[1];
    if (original === undefined) throw new Error('fixture record missing');
    const unrelated = {
      ...original,
      properties: {
        ...original.properties,
        names: { primary: 'Independent Coffee', common: {}, rules: [] },
        brand: null,
      },
    } as OvertureDecodedPlace;
    await expect(
      adapter.validate(unrelated, { clock: new TestClock(), signal: signal() }),
    ).resolves.toMatchObject({ status: 'rejected' });
  });

  it('stores only bounded manual locator outcomes and never locator content', async () => {
    const { candidates } = await records();
    const candidate = candidates[1];
    if (candidate === undefined) throw new Error('fixture candidate missing');
    const sampled = applyManualLocatorValidation(candidate, {
      gersId: candidate.gersId,
      state: 'sampled_open',
      checkedAt: '2026-07-17T12:00:00.000Z',
      note: 'Address and name matched during a manual sample.',
      sampledManually: true,
    });
    expect(sampled.validation).toMatchObject({ state: 'sampled_open', sampledManually: true });
    expect(candidate.validation.state).toBe('not_sampled');
    expect(() =>
      applyManualLocatorValidation(candidate, {
        gersId: candidate.gersId,
        state: 'sampled_unknown',
        checkedAt: '2026-07-17T12:00:00.000Z',
        note: 'See https://restricted.example/result',
        sampledManually: true,
      }),
    ).toThrow(/never locator content/u);
    expect(() =>
      applyManualLocatorValidation(candidate, {
        gersId: '00000000-0000-0000-0000-000000000000',
        state: 'sampled_closed',
        checkedAt: '2026-07-17T12:00:00.000Z',
        note: 'Manually observed a closed listing state.',
        sampledManually: true,
      }),
    ).toThrow(/does not match/u);
  });

  it('deduplicates only with stable/spatial/address evidence and preserves conflicts', async () => {
    const { candidates } = await records();
    const base = candidates[1];
    if (base === undefined) throw new Error('fixture candidate missing');
    const baseAddress = base.addresses[0];
    if (baseAddress === undefined) throw new Error('fixture address missing');
    const newerSameIdentity = {
      ...base,
      version: base.version + 1,
      rawFeatureSha256: 'a'.repeat(64),
    } as OvertureStarbucksCandidate;
    const sameAddressDifferentGers = {
      ...base,
      gersId: '11111111-1111-4111-8111-111111111111',
      rawFeatureSha256: 'b'.repeat(64),
    } as OvertureStarbucksCandidate;
    const nameOnly = {
      ...base,
      gersId: '22222222-2222-4222-8222-222222222222',
      geometry: { type: 'Point', coordinates: [-121.8, 37.4] },
      addresses: [{ ...baseAddress, freeform: 'Different Address' }],
      rawFeatureSha256: 'c'.repeat(64),
    } as OvertureStarbucksCandidate;
    const conflictSameGers = {
      ...base,
      geometry: { type: 'Point', coordinates: [-121.8, 37.4] },
      addresses: [{ ...baseAddress, freeform: 'Conflicting Address' }],
      rawFeatureSha256: 'd'.repeat(64),
    } as OvertureStarbucksCandidate;

    const exact = deduplicateStarbucksCandidates([base, newerSameIdentity]);
    expect(exact.candidates).toHaveLength(1);
    expect(exact.candidates[0]?.version).toBe(newerSameIdentity.version);
    expect(exact.decisions).toContainEqual(
      expect.objectContaining({ duplicate: true, reason: 'same_gers_id' }),
    );

    const spatial = deduplicateStarbucksCandidates([base, sameAddressDifferentGers]);
    expect(spatial.candidates).toHaveLength(1);
    expect(spatial.decisions).toContainEqual(
      expect.objectContaining({
        duplicate: true,
        reason: 'spatial_and_address_match',
        normalizedAddressMatched: true,
      }),
    );

    const distinct = deduplicateStarbucksCandidates([base, nameOnly]);
    expect(distinct.candidates).toHaveLength(2);
    expect(distinct.decisions).toContainEqual(
      expect.objectContaining({
        duplicate: false,
        reason: 'name_only_insufficient',
      }),
    );

    const conflict = deduplicateStarbucksCandidates([base, conflictSameGers]);
    expect(conflict.candidates).toHaveLength(2);
    expect(conflict.decisions).toContainEqual(
      expect.objectContaining({
        duplicate: false,
        reason: 'conflicting_same_gers_id',
      }),
    );
  });

  it('keeps the canonical place ID stable across replay/version while retaining lineage', async () => {
    const { adapter, candidates } = await records();
    const candidate = candidates[1];
    if (candidate === undefined) throw new Error('fixture candidate missing');
    const changedVersion = { ...candidate, version: candidate.version + 1 };
    const first = await collect(
      adapter.normalize(candidate, {
        analyticalRuntime: UNUSED_RUNTIME,
        clock: new TestClock(),
        signal: signal(),
      }),
    );
    const second = await collect(
      adapter.normalize(changedVersion, {
        analyticalRuntime: UNUSED_RUNTIME,
        clock: new TestClock(),
        signal: signal(),
      }),
    );
    expect(first[0]).toMatchObject({ kind: 'entity_upsert' });
    expect(second[0]).toMatchObject({ kind: 'entity_upsert' });
    if (first[0]?.kind !== 'entity_upsert' || second[0]?.kind !== 'entity_upsert') {
      throw new Error('entity mutation missing');
    }
    expect(first[0].entity.id).toBe(second[0].entity.id);
    expect(first[0].entity.lineage[0]?.sourceRecord.snapshotId).toBe(candidate.snapshotId);
    expect(first.some((mutation) => mutation.kind === 'artifact_reference')).toBe(true);
  });
});
