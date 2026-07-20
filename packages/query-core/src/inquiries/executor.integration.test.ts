import { createHash } from 'node:crypto';

import type { AnalyticalQuery, AnalyticalSession } from '@oracle/data-runtime/analytical-runtime';
import { DuckDBAnalyticalRuntime } from '@oracle/data-runtime/duckdb/duckdb-analytical-runtime';
import { afterEach, describe, expect, it } from 'vitest';

import type { InquiryReleaseContext, RankingCriterion } from './contracts.js';
import { NamedInquiryExecutor } from './executor.js';

const RELEASE_ID = 'santa-clara-golden-release-v1';
const CURSOR_SECRET = Buffer.alloc(32, 7);
const GOLDEN_A = 'sc:entity:property:golden-a';
const GOLDEN_B = 'sc:entity:property:golden-b';
const GOLDEN_C = 'sc:entity:property:golden-c';
const GOLDEN_D = 'sc:entity:property:golden-d';
const GOLDEN_E = 'sc:entity:property:golden-e';
const sessions: AnalyticalSession[] = [];

function projectedEvidence(
  supportClass: 'supported' | 'proxy',
  options: Readonly<{ asOf?: string; feature?: RankingCriterion }> = {},
): string {
  return JSON.stringify([
    {
      evidenceId: `structural-${options.feature ?? 'roof'}-${supportClass}`,
      ...(options.feature === undefined ? {} : { feature: options.feature }),
      supportClass,
      confidence: supportClass === 'supported' ? 1 : 0.5,
      asOf: options.asOf ?? '2026-07-17T00:00:00.000Z',
      algorithmName: 'structural-test',
      algorithmVersion: '1.0.0',
      valueJson: '{}',
      sourceIdsJson: '["source"]',
      limitationsJson: '[]',
      visibility: 'public',
    },
  ]);
}

function rowSession(row: Readonly<Record<string, unknown>>): AnalyticalSession {
  return {
    // The generic is required by the polymorphic AnalyticalSession port.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    execute: async <TRow extends Readonly<Record<string, unknown>>>() => {
      await Promise.resolve();
      return {
        rows: [row] as unknown as readonly TRow[],
        elapsedMs: 1,
        scannedBytes: 1,
        truncated: false,
      };
    },
    [Symbol.asyncDispose]: () => Promise.resolve(),
  };
}

function tamperCursor(cursor: string): string {
  const separator = cursor.indexOf('.');
  if (separator < 0 || separator === cursor.length - 1) throw new Error('Expected signed cursor');
  const signature = cursor.slice(separator + 1);
  const first = signature.charAt(0);
  return `${cursor.slice(0, separator + 1)}${first === 'a' ? 'b' : 'a'}${signature.slice(1)}`;
}

const criteria = Object.freeze([
  'roof_age',
  'water_view_candidate',
  'ownership_age',
  'regional_owner',
  'transit_walkability',
  'starbucks_walkability',
] as const satisfies readonly RankingCriterion[]);

function release(blockOwnership = false, releaseId = RELEASE_ID): InquiryReleaseContext {
  return Object.freeze({
    schemaVersion: '1.0.0',
    releaseId,
    runId: 'run-golden-v1',
    manifestCid: 'bafy-golden-manifest',
    asOf: '2026-07-17T00:00:00.000Z',
    policyVersion: 'bay-area-nine-counties-v1',
    rankingWeights: Object.freeze(
      criteria.map((criterion) => Object.freeze({ criterion, weight: 1, proxyMultiplier: 0.5 })),
    ),
    capabilities: Object.freeze(
      Object.fromEntries(
        criteria.map((criterion) => [
          criterion,
          Object.freeze(
            blockOwnership && (criterion === 'ownership_age' || criterion === 'regional_owner')
              ? {
                  state: 'blocked' as const,
                  supportClasses: Object.freeze(['unknown', 'unsupported'] as const),
                  numerator: 0,
                  denominator: 5,
                  limitations: Object.freeze(['Ownership source is blocked.']),
                }
              : {
                  state: 'supported' as const,
                  supportClasses: Object.freeze(['supported', 'proxy', 'unknown'] as const),
                  numerator: 4,
                  denominator: 5,
                  limitations: Object.freeze(['Synthetic source-shaped golden fixture only.']),
                },
          ),
        ]),
      ) as unknown as InquiryReleaseContext['capabilities'],
    ),
  });
}

const properties = Object.freeze([
  Object.freeze({
    id: GOLDEN_A,
    parcel: '001',
    city: 'Palo Alto',
    coordinates: [37.441, -122.143],
    roof: ['supported', 20, '2006-01-01'],
    water: ['supported', 100, 'clear_candidate'],
    ownership: ['supported', 12, '2014-01-01'],
    regional: ['supported', true],
    transit: ['supported', 500, 6],
    starbucks: ['supported', 600, 7],
  }),
  Object.freeze({
    id: GOLDEN_B,
    parcel: '002',
    city: 'San Jose',
    coordinates: [37.339, -121.895],
    roof: ['proxy', 30, '1996-01-01'],
    water: ['proxy', 200, 'candidate'],
    ownership: ['unknown', null, null],
    regional: ['unknown', null],
    transit: ['proxy', 400, 5],
    starbucks: ['supported', 700, 8],
  }),
  Object.freeze({
    id: GOLDEN_C,
    parcel: '003',
    city: 'Santa Clara',
    coordinates: [37.354, -121.955],
    roof: ['supported', 40, '1986-01-01'],
    water: ['unknown', null, null],
    ownership: ['unknown', null, null],
    regional: ['unknown', null],
    transit: ['unknown', null, null],
    starbucks: ['unknown', null, null],
  }),
  Object.freeze({
    id: GOLDEN_D,
    parcel: '004',
    city: 'Palo Alto',
    // Coordinates are unavailable for this golden: the identity projection must stay nullable.
    coordinates: [null, null],
    roof: ['supported', 25, '2001-01-01'],
    water: ['unknown', null, null],
    ownership: ['unknown', null, null],
    regional: ['unknown', null],
    transit: ['unknown', null, null],
    starbucks: ['unknown', null, null],
  }),
  Object.freeze({
    id: GOLDEN_E,
    parcel: '005',
    city: 'Palo Alto',
    coordinates: [37.447, -122.152],
    roof: ['supported', 22, '2004-01-01'],
    water: ['unknown', null, null],
    ownership: ['unknown', null, null],
    regional: ['unknown', null],
    transit: ['unknown', null, null],
    starbucks: ['unknown', null, null],
  }),
]);

const evidence = Object.freeze([
  ...criteria.map((feature) =>
    Object.freeze({
      id: `evidence-a-${feature}`,
      property: GOLDEN_A,
      feature,
      support: 'supported',
      value: '{}',
    }),
  ),
  Object.freeze({
    id: 'evidence-b-roof',
    property: GOLDEN_B,
    feature: 'roof_age',
    support: 'proxy',
    value: '{}',
  }),
  Object.freeze({
    id: 'evidence-b-water',
    property: GOLDEN_B,
    feature: 'water_view_candidate',
    support: 'proxy',
    value: '{}',
  }),
  Object.freeze({
    id: 'evidence-b-transit',
    property: GOLDEN_B,
    feature: 'transit_walkability',
    support: 'proxy',
    value: '{}',
  }),
  Object.freeze({
    id: 'evidence-b-starbucks',
    property: GOLDEN_B,
    feature: 'starbucks_walkability',
    support: 'supported',
    value: '{}',
  }),
  Object.freeze({
    id: 'evidence-d-roof',
    property: GOLDEN_D,
    feature: 'roof_age',
    support: 'supported',
    value: '{}',
  }),
  Object.freeze({
    id: 'evidence-e-roof-corrupt',
    property: GOLDEN_E,
    feature: 'roof_age',
    support: 'supported',
    value: '{bad',
  }),
]);

async function nativeSession(): Promise<AnalyticalSession> {
  const manifestBytes = Buffer.from('{"release":"golden"}\n');
  const operationNames = [...criteria, 'combined_review'].map((name) => `inquiry.${name}@1.0.0`);
  const runtime = new DuckDBAnalyticalRuntime({
    nowMilliseconds: (() => {
      let now = 0;
      return () => now++;
    })(),
    loadSnapshot: () =>
      Promise.resolve({
        manifestBytes,
        scanBytesByOperation: Object.fromEntries(operationNames.map((name) => [name, 4_096])),
        initialize: async (connection) => {
          await connection.run(`CREATE TABLE property_query(
            property_id VARCHAR, parcel_identifier VARCHAR, address_street VARCHAR,
            address_city VARCHAR, address_zip VARCHAR, latitude DOUBLE, longitude DOUBLE,
            visibility VARCHAR,
            roof_support_class VARCHAR, roof_age_years BIGINT, roof_reference_date VARCHAR,
            water_support_class VARCHAR, water_distance_meters DOUBLE, water_visibility_state VARCHAR,
            ownership_support_class VARCHAR, years_since_exchange BIGINT, last_exchange_date VARCHAR,
            regional_owner_support_class VARCHAR, is_regional_owner BOOLEAN,
            transit_support_class VARCHAR, transit_distance_meters DOUBLE, transit_walk_minutes DOUBLE,
            starbucks_support_class VARCHAR, starbucks_distance_meters DOUBLE, starbucks_walk_minutes DOUBLE
          )`);
          for (const item of properties) {
            await connection.run(
              'INSERT INTO property_query VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              [
                item.id,
                item.parcel,
                `${item.parcel} Golden St`,
                item.city,
                '95000',
                ...item.coordinates,
                'public',
                ...item.roof,
                ...item.water,
                ...item.ownership,
                ...item.regional,
                ...item.transit,
                ...item.starbucks,
              ],
            );
          }
          await connection.run(`CREATE TABLE property_evidence(
            evidence_id VARCHAR, property_id VARCHAR, feature VARCHAR, support_class VARCHAR,
            confidence DOUBLE, as_of VARCHAR, algorithm_name VARCHAR, algorithm_version VARCHAR,
            value_json VARCHAR, source_ids_json VARCHAR, source_references_json VARCHAR,
            limitations_json VARCHAR, visibility VARCHAR
          )`);
          for (const item of evidence) {
            await connection.run(
              'INSERT INTO property_evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              [
                item.id,
                item.property,
                item.feature,
                item.support,
                item.support === 'supported' ? 1 : 0.5,
                '2026-07-17T00:00:00.000Z',
                'golden-algorithm',
                '1.0.0',
                item.value,
                '["source-golden"]',
                '[]',
                '["Synthetic golden only."]',
                'public',
              ],
            );
          }
        },
      }),
  });
  const session = await runtime.open({
    releaseId: RELEASE_ID,
    manifestUri: 'memory://golden-manifest',
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
  });
  sessions.push(session);
  return session;
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session[Symbol.asyncDispose]()));
});

describe('named inquiry direct DuckDB parity', () => {
  it('executes every six-inquiry golden with public evidence and immutable metadata', async () => {
    const session = await nativeSession();
    const executor = new NamedInquiryExecutor(release(), CURSOR_SECRET);
    const base = { releaseId: RELEASE_ID, propertyId: GOLDEN_A };
    const responses = await Promise.all([
      executor.roofAge(base, { session }),
      executor.waterViewCandidates(base, { session }),
      executor.ownershipAge(base, { session }),
      executor.regionalOwners(base, { session }),
      executor.transitWalkability(base, { session }),
      executor.starbucksWalkability(base, { session }),
    ]);
    expect(responses.map(({ query }) => query.name)).toEqual(criteria);
    for (const response of responses) {
      expect(response).toMatchObject({
        schemaVersion: '1.0.0',
        releaseId: RELEASE_ID,
        runId: 'run-golden-v1',
        manifestCid: 'bafy-golden-manifest',
        asOf: '2026-07-17T00:00:00.000Z',
        resultCount: 1,
      });
      expect(response.results[0]).toMatchObject({
        propertyId: GOLDEN_A,
        supportClass: 'supported',
        latitude: 37.441,
        longitude: -122.143,
      });
      expect(response.results[0]?.evidence.length).toBeGreaterThan(0);
    }
    expect(responses[1].results[0]?.value).toMatchObject({ actualViewProven: false });
    expect(responses[2].results[0]?.value).toMatchObject({ completeHistoryRequired: true });
    expect(responses[3].results[0]?.value).toMatchObject({ rawOwnerIdentityExposed: false });
  });

  it('ranks the combined golden deterministically with transparent components', async () => {
    const session = await nativeSession();
    const executor = new NamedInquiryExecutor(release(), CURSOR_SECRET);
    const response = await executor.combinedRanking(
      {
        releaseId: RELEASE_ID,
        criteria: ['roof_age', 'transit_walkability', 'starbucks_walkability'],
        includeProxy: true,
        minimumEvidenceCoverage: 1,
      },
      { session },
    );
    expect(response.results.map(({ propertyId }) => propertyId)).toEqual([GOLDEN_A, GOLDEN_B]);
    expect(response.results.map(({ latitude, longitude }) => [latitude, longitude])).toEqual([
      [37.441, -122.143],
      [37.339, -121.895],
    ]);
    expect(response.results[0]?.value.components).toHaveLength(3);
    expect(response.results.map(({ value }) => value.rank)).toEqual([1, 2]);
    expect(response.results[1]?.value.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          criterion: 'roof_age',
          supportClass: 'proxy',
          contribution: 0.5,
        }),
        expect.objectContaining({
          criterion: 'starbucks_walkability',
          supportClass: 'supported',
          contribution: 1,
        }),
      ]),
    );
  });

  it('never turns blocked or absent ownership evidence into a positive claim', async () => {
    const session = await nativeSession();
    const blocked = new NamedInquiryExecutor(release(true), CURSOR_SECRET);
    await expect(
      blocked.ownershipAge({ releaseId: RELEASE_ID }, { session }),
    ).resolves.toMatchObject({
      resultCount: 0,
      capability: { state: 'blocked', numerator: 0 },
      timing: { bytesScanned: 0 },
    });
    const supported = new NamedInquiryExecutor(release(), CURSOR_SECRET);
    await expect(
      supported.roofAge({ releaseId: RELEASE_ID, propertyId: GOLDEN_C }, { session }),
    ).resolves.toMatchObject({ resultCount: 0 });
    const ranked = await blocked.combinedRanking(
      {
        releaseId: RELEASE_ID,
        propertyId: GOLDEN_A,
        criteria: ['roof_age', 'ownership_age'],
      },
      { session },
    );
    expect(ranked.results[0]?.value).toMatchObject({
      score: 1,
      components: expect.arrayContaining([
        expect.objectContaining({
          criterion: 'ownership_age',
          supportClass: 'unsupported',
          weight: 0,
          contribution: 0,
        }),
      ]),
    });
  });

  it('paginates without duplicates and rejects tampered or stale cursors', async () => {
    const session = await nativeSession();
    const executor = new NamedInquiryExecutor(release(), CURSOR_SECRET);
    const first = await executor.roofAge(
      { releaseId: RELEASE_ID, limit: 1, city: 'Palo Alto' },
      { session },
    );
    expect(first.results.map(({ propertyId }) => propertyId)).toEqual([GOLDEN_A]);
    expect(first.nextCursor).not.toBeNull();
    if (first.nextCursor === null) throw new Error('Expected cursor');
    const second = await executor.roofAge(
      { releaseId: RELEASE_ID, limit: 1, city: 'Palo Alto', cursor: first.nextCursor },
      { session },
    );
    expect(second.results.map(({ propertyId }) => propertyId)).toEqual([GOLDEN_D]);
    expect(second.results[0]).toMatchObject({ latitude: null, longitude: null });
    expect(Buffer.byteLength(first.nextCursor, 'utf8')).toBeLessThanOrEqual(512);
    await expect(
      executor.roofAge(
        { releaseId: RELEASE_ID, limit: 1, city: 'San Jose', cursor: first.nextCursor },
        { session },
      ),
    ).rejects.toThrow(/different normalized query/u);
    await expect(
      executor.roofAge(
        {
          releaseId: RELEASE_ID,
          limit: 1,
          city: 'Palo Alto',
          propertyId: GOLDEN_D,
          cursor: first.nextCursor,
        },
        { session },
      ),
    ).rejects.toThrow(/different normalized query/u);
    await expect(
      executor.roofAge(
        {
          releaseId: RELEASE_ID,
          limit: 1,
          city: 'Palo Alto',
          minimumAgeYears: 16,
          cursor: first.nextCursor,
        },
        { session },
      ),
    ).rejects.toThrow(/different normalized query/u);
    await expect(
      executor.roofAge(
        {
          releaseId: RELEASE_ID,
          limit: 1,
          city: 'Palo Alto',
          includeProxy: true,
          cursor: first.nextCursor,
        },
        { session },
      ),
    ).rejects.toThrow(/different normalized query/u);
    await expect(
      executor.roofAge(
        {
          releaseId: RELEASE_ID,
          limit: 1,
          city: 'Palo Alto',
          cursor: tamperCursor(first.nextCursor),
        },
        { session },
      ),
    ).rejects.toThrow(/signature/u);
    const stale = new NamedInquiryExecutor(release(false, 'release-v2'), CURSOR_SECRET);
    await expect(
      stale.roofAge({ releaseId: 'release-v2', cursor: first.nextCursor }, { session }),
    ).rejects.toThrow(/stale/u);
  });

  it('binds combined pagination to normalized criteria, weights, filters, and release', async () => {
    const session = await nativeSession();
    const executor = new NamedInquiryExecutor(release(), CURSOR_SECRET);
    const request = {
      releaseId: RELEASE_ID,
      criteria: ['roof_age', 'transit_walkability', 'starbucks_walkability'] as const,
      includeProxy: true,
      minimumEvidenceCoverage: 1,
      limit: 1,
    };
    const first = await executor.combinedRanking(request, { session });
    expect(first.results.map(({ propertyId }) => propertyId)).toEqual([GOLDEN_A]);
    expect(first.nextCursor).not.toBeNull();
    if (first.nextCursor === null) throw new Error('Expected combined cursor');
    expect(Buffer.byteLength(first.nextCursor, 'utf8')).toBeLessThanOrEqual(512);
    const second = await executor.combinedRanking(
      { ...request, cursor: first.nextCursor },
      { session },
    );
    expect(second.results.map(({ propertyId }) => propertyId)).toEqual([GOLDEN_B]);
    await expect(
      executor.combinedRanking(
        { ...request, criteria: ['roof_age', 'starbucks_walkability'], cursor: first.nextCursor },
        { session },
      ),
    ).rejects.toThrow(/different normalized query/u);
    await expect(
      executor.combinedRanking(
        {
          ...request,
          weights: [
            { criterion: 'roof_age', weight: 2, proxyMultiplier: 0.5 },
            { criterion: 'transit_walkability', weight: 1, proxyMultiplier: 0.5 },
            { criterion: 'starbucks_walkability', weight: 1, proxyMultiplier: 0.5 },
          ],
          cursor: first.nextCursor,
        },
        { session },
      ),
    ).rejects.toThrow(/different normalized query/u);
    await expect(
      executor.combinedRanking(
        { ...request, city: 'Palo Alto', cursor: first.nextCursor },
        { session },
      ),
    ).rejects.toThrow(/different normalized query/u);
    await expect(
      executor.combinedRanking({ ...request, cursor: tamperCursor(first.nextCursor) }, { session }),
    ).rejects.toThrow(/signature/u);
    const stale = new NamedInquiryExecutor(release(false, 'release-v2'), CURSOR_SECRET);
    await expect(
      stale.combinedRanking(
        { ...request, releaseId: 'release-v2', cursor: first.nextCursor },
        { session },
      ),
    ).rejects.toThrow(/stale/u);
  });

  it('rejects invalid bounds, authority-shaped fields, stale releases, and corrupt rows', async () => {
    const session = await nativeSession();
    const executor = new NamedInquiryExecutor(release(), CURSOR_SECRET);
    await expect(
      executor.roofAge({ releaseId: RELEASE_ID, limit: 101 }, { session }),
    ).rejects.toThrow(/limit/u);
    await expect(
      executor.roofAge({ releaseId: RELEASE_ID, minimumAgeYears: 0 }, { session }),
    ).rejects.toThrow(/minimumAgeYears/u);
    await expect(
      executor.roofAge({ releaseId: RELEASE_ID, sql: 'DROP TABLE property_query' } as never, {
        session,
      }),
    ).rejects.toThrow(/unsupported fields/u);
    await expect(executor.roofAge({ releaseId: 'stale-release' }, { session })).rejects.toThrow(
      /stale/u,
    );
    await expect(
      executor.roofAge({ releaseId: RELEASE_ID, cursor: 'x'.repeat(513) }, { session }),
    ).rejects.toThrow(/cursor/u);
    await expect(
      executor.roofAge({ releaseId: RELEASE_ID, propertyId: GOLDEN_E }, { session }),
    ).rejects.toThrow(/Evidence value is corrupt/u);
  });
});

describe('named inquiry fixed-plan authority boundary', () => {
  it('keeps caller text in parameters and never interpolates it into SQL', async () => {
    const queries: AnalyticalQuery[] = [];
    const recording: AnalyticalSession = {
      // The generic is required by the polymorphic AnalyticalSession port.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
      execute: async <TRow extends Readonly<Record<string, unknown>>>(query: AnalyticalQuery) => {
        await Promise.resolve();
        queries.push(query);
        return { rows: [] as readonly TRow[], elapsedMs: 1, scannedBytes: 1, truncated: false };
      },
      [Symbol.asyncDispose]: () => Promise.resolve(),
    };
    const executor = new NamedInquiryExecutor(release(), CURSOR_SECRET);
    const hostile = "Palo Alto' OR read_csv_auto('https://attacker.invalid') IS NOT NULL --";
    await executor.roofAge({ releaseId: RELEASE_ID, city: hostile }, { session: recording });
    expect(queries[0]?.statement).not.toContain(hostile);
    expect(queries[0]?.parameters).toContain(hostile);
    expect(queries[0]).toMatchObject({
      operation: 'inquiry.roof_age@1.0.0',
      timeoutMs: 5_000,
      maximumRows: 101,
      maximumScanBytes: 536_870_912,
    });
  });

  it('caps serialized results and rejects contradictory capability metadata', async () => {
    const hugeEvidence = JSON.stringify([
      {
        evidenceId: 'huge-evidence',
        supportClass: 'supported',
        confidence: 1,
        asOf: '2026-07-17T00:00:00.000Z',
        algorithmName: 'bounded-test',
        algorithmVersion: '1.0.0',
        valueJson: '{}',
        sourceIdsJson: '["source"]',
        limitationsJson: JSON.stringify(['x'.repeat(1024 * 1024)]),
        visibility: 'public',
      },
    ]);
    const oversized: AnalyticalSession = {
      // The generic is required by the polymorphic AnalyticalSession port.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
      execute: async <TRow extends Readonly<Record<string, unknown>>>() => {
        await Promise.resolve();
        return {
          rows: [
            {
              property_id: GOLDEN_A,
              parcel_identifier: '001',
              address_street: '1 Golden St',
              address_city: 'Palo Alto',
              address_zip: '95000',
              latitude: 37.441,
              longitude: -122.143,
              support_class: 'supported',
              value_number: 20,
              value_text: '2006-01-01',
              evidence_json: hugeEvidence,
            },
          ] as unknown as readonly TRow[],
          elapsedMs: 1,
          scannedBytes: 1,
          truncated: false,
        };
      },
      [Symbol.asyncDispose]: () => Promise.resolve(),
    };
    const executor = new NamedInquiryExecutor(release(), CURSOR_SECRET);
    await expect(
      executor.roofAge({ releaseId: RELEASE_ID }, { session: oversized }),
    ).rejects.toThrow(/1 MiB/u);

    const invalid = release(true);
    const invalidCapabilities = {
      ...invalid.capabilities,
      ownership_age: {
        ...invalid.capabilities.ownership_age,
        supportClasses: Object.freeze(['supported'] as const),
      },
    };
    expect(
      () =>
        new NamedInquiryExecutor({ ...invalid, capabilities: invalidCapabilities }, CURSOR_SECRET),
    ).toThrow(/blocked capability/u);

    const supportedWithoutSupported = release();
    expect(
      () =>
        new NamedInquiryExecutor(
          {
            ...supportedWithoutSupported,
            capabilities: {
              ...supportedWithoutSupported.capabilities,
              roof_age: {
                ...supportedWithoutSupported.capabilities.roof_age,
                supportClasses: ['proxy', 'unknown'],
              },
            },
          },
          CURSOR_SECRET,
        ),
    ).toThrow(/supported capability must declare supported/u);
  });

  it('fails closed on capability/result, evidence-class, and evidence-time contradictions', async () => {
    const baseRow = {
      property_id: GOLDEN_A,
      parcel_identifier: '001',
      address_street: '1 Golden St',
      address_city: 'Palo Alto',
      address_zip: '95000',
      latitude: 37.441,
      longitude: -122.143,
      value_number: 20,
      value_text: '2006-01-01',
    };
    const supportedOnly = release();
    const supportedOnlyCapabilities = {
      ...supportedOnly.capabilities,
      roof_age: {
        ...supportedOnly.capabilities.roof_age,
        supportClasses: Object.freeze(['supported'] as const),
      },
    };
    const supportedOnlyExecutor = new NamedInquiryExecutor(
      { ...supportedOnly, capabilities: supportedOnlyCapabilities },
      CURSOR_SECRET,
    );
    await expect(
      supportedOnlyExecutor.roofAge(
        { releaseId: RELEASE_ID },
        {
          session: rowSession({
            ...baseRow,
            support_class: 'proxy',
            evidence_json: projectedEvidence('proxy'),
          }),
        },
      ),
    ).rejects.toThrow(/contradicts release capability/u);

    const executor = new NamedInquiryExecutor(release(), CURSOR_SECRET);
    await expect(
      executor.roofAge(
        { releaseId: RELEASE_ID },
        {
          session: rowSession({
            ...baseRow,
            support_class: 'supported',
            evidence_json: projectedEvidence('proxy'),
          }),
        },
      ),
    ).rejects.toThrow(/matching public evidence support class/u);
    await expect(
      executor.roofAge(
        { releaseId: RELEASE_ID },
        {
          session: rowSession({
            ...baseRow,
            support_class: 'unknown',
            evidence_json: projectedEvidence('supported'),
          }),
        },
      ),
    ).rejects.toThrow(/non-positive support class/u);
    await expect(
      executor.roofAge(
        { releaseId: RELEASE_ID },
        {
          session: rowSession({
            ...baseRow,
            support_class: 'supported',
            evidence_json: projectedEvidence('supported', {
              asOf: '2026-07-18T00:00:00.000Z',
            }),
          }),
        },
      ),
    ).rejects.toThrow(/later than the immutable release/u);

    await expect(
      executor.combinedRanking(
        { releaseId: RELEASE_ID, criteria: ['roof_age'] },
        {
          session: rowSession({
            ...baseRow,
            score: 1,
            evidence_coverage: 1,
            ranking_position: 1,
            roof_state: 'supported',
            water_state: 'unknown',
            ownership_state: 'unknown',
            regional_owner_state: 'unknown',
            transit_state: 'unknown',
            starbucks_state: 'unknown',
            evidence_json: projectedEvidence('proxy', { feature: 'roof_age' }),
          }),
        },
      ),
    ).rejects.toThrow(/positive component lacks matching public evidence/u);
  });
});
