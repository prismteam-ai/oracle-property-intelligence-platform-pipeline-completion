import { createHash } from 'node:crypto';

import { acquisitionRequestSchema, sourceCheckpointSchema } from '@oracle/contracts/source';
import { describe, expect, it } from 'vitest';

import { OvertureStarbucksAdapter } from './adapter.js';
import {
  OVERTURE_STARBUCKS_QUERY,
  OVERTURE_STARBUCKS_RELEASE,
  OVERTURE_STARBUCKS_SCHEMA_VERSION,
  STARBUCKS_WIKIDATA_ID,
} from './constants.js';
import {
  FIXTURE_LAST_MODIFIED,
  FIXTURE_SHA256,
  FIXTURE_URL,
  SNAPSHOT_ID,
  SequenceTransport,
  TestArtifactStore,
  TestCheckpointStore,
  TestClock,
  TestDelay,
  UNUSED_RUNTIME,
  acquiredFixture,
  fixtureBytes,
  fixtureConfig,
  responseHeaders,
} from './test-helpers.js';

const RATE_POLICY = {
  maxRequestsPerWindow: 30,
  windowMs: 60_000,
  maxConcurrency: 1,
  maxAttempts: 4,
  initialBackoffMs: 500,
  maxBackoffMs: 8_000,
  jitter: 'none' as const,
  respectRetryAfter: true,
};

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function controller(): AbortController {
  return new AbortController();
}

function request() {
  return acquisitionRequestSchema.parse({
    sourceId: 'sc:source:overture-starbucks',
    snapshotId: SNAPSHOT_ID,
    requestedAt: '2026-07-17T10:00:00.000Z',
    mode: 'full',
    requestedSourceAsOf: { state: 'reported', at: FIXTURE_LAST_MODIFIED },
  });
}

describe('OvertureStarbucksAdapter', () => {
  it('pins release, schema, legal attribution, and deterministic query authority', async () => {
    const adapter = new OvertureStarbucksAdapter({ artifact: await fixtureConfig() });
    const descriptor = adapter.describe();
    expect(OVERTURE_STARBUCKS_RELEASE).toBe('2026-06-17.0');
    expect(OVERTURE_STARBUCKS_SCHEMA_VERSION).toBe('1.17.0');
    expect(descriptor.sourceId).toBe('sc:source:overture-starbucks');
    expect(descriptor.license.redistribution).toBe('approved');
    expect(descriptor.license.attribution.join(' ')).toContain('Foursquare');
    expect(OVERTURE_STARBUCKS_QUERY).toContain('read_parquet(?)');
    expect(OVERTURE_STARBUCKS_QUERY).not.toContain(FIXTURE_SHA256);
  });

  it('fails closed when immutable release headers drift', async () => {
    const config = await fixtureConfig();
    const adapter = new OvertureStarbucksAdapter({ artifact: config });
    await expect(
      adapter.discover({
        http: new SequenceTransport([
          {
            status: 200,
            headers: {
              ...responseHeaders(config),
              'content-length': String(config.expectedBytes + 1),
            },
          },
        ]),
        clock: new TestClock(),
        delay: new TestDelay(),
        signal: controller().signal,
        ratePolicy: RATE_POLICY,
      }),
    ).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
  });

  it('executes frozen discovery/acquisition/decode/validate/normalize phases', async () => {
    const bytes = await fixtureBytes();
    const config = await fixtureConfig();
    const transport = new SequenceTransport([
      { status: 200, headers: responseHeaders(config) },
      {
        status: 200,
        headers: responseHeaders(config),
        chunks: [bytes.slice(0, 1000), bytes.slice(1000)],
      },
    ]);
    const clock = new TestClock();
    const delay = new TestDelay();
    const signal = controller().signal;
    const adapter = new OvertureStarbucksAdapter({ artifact: config });
    const discovery = await adapter.discover({
      http: transport,
      clock,
      delay,
      signal,
      ratePolicy: RATE_POLICY,
    });
    expect(discovery.complete).toBe(true);
    expect(discovery.resources).toHaveLength(1);
    expect(discovery.limitations.join(' ')).toContain('not silently confirmed');
    const plan = await adapter.plan(request(), discovery, { clock, signal });
    const artifactStore = new TestArtifactStore();
    const checkpointStore = new TestCheckpointStore();
    const artifacts = await collect(
      adapter.acquire(plan, undefined, {
        http: transport,
        artifactStore,
        checkpointStore,
        clock,
        delay,
        signal,
        ratePolicy: RATE_POLICY,
      }),
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.metadata.sha256).toBe(FIXTURE_SHA256);
    expect(transport.requests.map((entry) => entry.method)).toEqual(['HEAD', 'GET']);
    const artifact = artifacts[0];
    if (artifact === undefined) throw new Error('acquired artifact missing');
    const decoded = await collect(
      adapter.decode(artifact, { artifactStore, analyticalRuntime: UNUSED_RUNTIME, clock, signal }),
    );
    expect(decoded.map((entry) => entry.gersId)).toEqual([
      '08a87f75-fe95-455d-ab8f-42f37424a70a',
      '346ea5cb-3d37-4661-9001-7d0b0ea36a5a',
      '8fce41a2-c2b5-40f4-b90d-c39f2fa2ec7d',
    ]);
    const validated = await Promise.all(
      decoded.map((entry) => adapter.validate(entry, { clock, signal })),
    );
    expect(validated.every((entry) => entry.status === 'accepted')).toBe(true);
    const accepted = validated.flatMap((entry) =>
      entry.status === 'accepted' ? [entry.record] : [],
    );
    expect(accepted[0]?.sourceLicenses).toContain('Apache-2.0');
    expect(accepted[0]?.sourceNotices).toEqual([
      'Overture Maps Foundation, overturemaps.org',
      'Foursquare data © 2024 Foursquare Labs, Inc.; available under Apache-2.0; transformed to the Overture schema; see Overture NOTICE.',
    ]);
    expect(accepted[1]?.sourceNotices).toEqual([
      'Overture Maps Foundation, overturemaps.org',
      'AllThePlaces data is available under CC0-1.0.',
      'Overture-derived confidence evidence is available under CDLA-Permissive-2.0.',
    ]);
    expect(accepted[1]?.matchEvidence.mode).toBe('wikidata_exact');
    expect(accepted[1]?.updateTime).toBe('2026-06-11T11:57:15.000Z');
    expect(accepted.every((entry) => entry.validation.state === 'not_sampled')).toBe(true);
    const acceptedCandidate = accepted[1];
    if (acceptedCandidate === undefined) throw new Error('accepted candidate missing');
    const firstMutations = await collect(
      adapter.normalize(acceptedCandidate, { analyticalRuntime: UNUSED_RUNTIME, clock, signal }),
    );
    const replayMutations = await collect(
      adapter.normalize(acceptedCandidate, { analyticalRuntime: UNUSED_RUNTIME, clock, signal }),
    );
    expect(replayMutations).toEqual(firstMutations);
    expect(firstMutations[0]).toMatchObject({
      kind: 'entity_upsert',
      entity: {
        id: 'sc:entity:place:overture-346ea5cb-3d37-4661-9001-7d0b0ea36a5a',
        operatingState: 'candidate',
      },
    });
    const entityMutation = firstMutations[0];
    if (entityMutation?.kind !== 'entity_upsert' || entityMutation.entity.entityKind !== 'place') {
      throw new Error('place entity mutation missing');
    }
    const domainKeys = [
      'name',
      'categories',
      'brandIdentifiers',
      'location',
      'confidence',
      'operatingState',
    ] as const;
    for (const key of domainKeys) {
      const observation = firstMutations.find(
        (entry) => entry.kind === 'field_observation' && entry.observation.fieldPath === `/${key}`,
      );
      expect(observation).toMatchObject({
        kind: 'field_observation',
        observation: {
          fieldPath: `/${key}`,
          value: entityMutation.entity[key],
          visibility: entityMutation.entity.visibility,
        },
      });
    }
    expect(
      firstMutations.some(
        (entry) =>
          entry.kind === 'field_observation' &&
          entry.observation.fieldPath === '/overture/sourceLicenses',
      ),
    ).toBe(true);
    expect(
      firstMutations.find(
        (entry) =>
          entry.kind === 'field_observation' && entry.observation.fieldPath === '/categories',
      ),
    ).toMatchObject({
      kind: 'field_observation',
      observation: { value: entityMutation.entity.categories },
    });
    expect(
      firstMutations.find(
        (entry) =>
          entry.kind === 'field_observation' &&
          entry.observation.fieldPath === '/overture/categories',
      ),
    ).toMatchObject({
      kind: 'field_observation',
      observation: { value: acceptedCandidate.categories },
    });
    expect(firstMutations.every((entry) => entry.visibility === 'public')).toBe(true);
  });

  it('retries transient HTTP failure, honors retry-after, and commits a resumable checkpoint', async () => {
    const bytes = await fixtureBytes();
    const config = await fixtureConfig();
    const transport = new SequenceTransport([
      { status: 503, headers: { 'retry-after': '2' } },
      { status: 200, headers: responseHeaders(config), chunks: [bytes] },
    ]);
    const clock = new TestClock();
    const delay = new TestDelay();
    const signal = controller().signal;
    const adapter = new OvertureStarbucksAdapter({ artifact: config });
    const discovery = {
      sourceId: adapter.describe().sourceId,
      discoveredAt: '2026-07-17T10:00:00.000Z',
      resources: [
        {
          requestKey: 'overture-2026-06-17.0-santa-clara-fragment',
          url: config.url,
          sourceAsOf: { state: 'reported' as const, at: FIXTURE_LAST_MODIFIED },
          expectedRecords: null,
          mediaTypes: config.mediaTypes,
          continuationToken: null,
        },
      ],
      complete: true,
      limitations: [],
    };
    const plan = await adapter.plan(request(), discovery, { clock, signal });
    const checkpoints = new TestCheckpointStore();
    const artifacts = await collect(
      adapter.acquire(plan, undefined, {
        http: transport,
        artifactStore: new TestArtifactStore(),
        checkpointStore: checkpoints,
        clock,
        delay,
        signal,
        ratePolicy: RATE_POLICY,
      }),
    );
    expect(artifacts).toHaveLength(1);
    expect(delay.waits).toEqual([2000]);
    const envelope = checkpoints.checkpoints.get(`${adapter.describe().sourceId}|${SNAPSHOT_ID}`);
    expect(sourceCheckpointSchema.parse(envelope?.payload)).toMatchObject({
      complete: true,
      nextSequence: 1,
    });
    const resumed = await collect(
      adapter.acquire(plan, sourceCheckpointSchema.parse(envelope?.payload), {
        http: new SequenceTransport([]),
        artifactStore: new TestArtifactStore(),
        checkpointStore: checkpoints,
        clock,
        delay,
        signal,
        ratePolicy: RATE_POLICY,
      }),
    );
    expect(resumed).toEqual([]);
  });

  it('propagates abort and optimistic checkpoint conflict without fake success', async () => {
    const config = await fixtureConfig();
    const aborted = controller();
    aborted.abort(new DOMException('stop', 'AbortError'));
    const adapter = new OvertureStarbucksAdapter({ artifact: config });
    await expect(
      adapter.discover({
        http: new SequenceTransport([]),
        clock: new TestClock(),
        delay: new TestDelay(),
        signal: aborted.signal,
        ratePolicy: RATE_POLICY,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    const bytes = await fixtureBytes();
    const clock = new TestClock();
    const signal = controller().signal;
    const discovery = {
      sourceId: adapter.describe().sourceId,
      discoveredAt: clock.now(),
      resources: [
        {
          requestKey: 'overture-2026-06-17.0-santa-clara-fragment',
          url: config.url,
          sourceAsOf: { state: 'reported' as const, at: FIXTURE_LAST_MODIFIED },
          expectedRecords: null,
          mediaTypes: config.mediaTypes,
          continuationToken: null,
        },
      ],
      complete: true,
      limitations: [],
    };
    const plan = await adapter.plan(request(), discovery, { clock, signal });
    const checkpoints = new TestCheckpointStore();
    checkpoints.conflict = true;
    await expect(
      collect(
        adapter.acquire(plan, undefined, {
          http: new SequenceTransport([
            { status: 200, headers: responseHeaders(config), chunks: [bytes] },
          ]),
          artifactStore: new TestArtifactStore(),
          checkpointStore: checkpoints,
          clock,
          delay: new TestDelay(),
          signal,
          ratePolicy: RATE_POLICY,
        }),
      ),
    ).rejects.toMatchObject({ code: 'RECONCILIATION' });
  });

  it('rejects malformed geometry and strict schema drift', async () => {
    const artifact = await acquiredFixture();
    const raw = JSON.parse(new TextDecoder().decode(artifact.bytes.copy()));
    raw.features[0].geometry.coordinates = [-200, 37];
    const bytes = new TextEncoder().encode(JSON.stringify(raw));
    const sha = createHash('sha256').update(bytes).digest('hex');
    const malformed = {
      ...artifact,
      metadata: {
        ...artifact.metadata,
        artifactId: `sc:artifact:sha256:${sha}`,
        byteSize: bytes.byteLength,
        sha256: sha,
      },
      bytes: { byteLength: bytes.byteLength, sha256: sha, copy: () => Uint8Array.from(bytes) },
    } as typeof artifact;
    const adapter = new OvertureStarbucksAdapter({ artifact: await fixtureConfig() });
    await expect(
      collect(
        adapter.decode(malformed, {
          artifactStore: new TestArtifactStore(),
          analyticalRuntime: UNUSED_RUNTIME,
          clock: new TestClock(),
          signal: controller().signal,
        }),
      ),
    ).rejects.toThrow(/outside the frozen Santa Clara/u);

    raw.features[0].geometry.coordinates = [-121.9, 37.3];
    raw.features[0].properties.unexpected = true;
    const driftBytes = new TextEncoder().encode(JSON.stringify(raw));
    const driftSha = createHash('sha256').update(driftBytes).digest('hex');
    const drift = {
      ...malformed,
      metadata: {
        ...malformed.metadata,
        artifactId: `sc:artifact:sha256:${driftSha}`,
        byteSize: driftBytes.byteLength,
        sha256: driftSha,
      },
      bytes: {
        byteLength: driftBytes.byteLength,
        sha256: driftSha,
        copy: () => Uint8Array.from(driftBytes),
      },
    } as typeof artifact;
    await expect(
      collect(
        adapter.decode(drift, {
          artifactStore: new TestArtifactStore(),
          analyticalRuntime: UNUSED_RUNTIME,
          clock: new TestClock(),
          signal: controller().signal,
        }),
      ),
    ).rejects.toThrow(/keys changed/u);
  });

  it('uses the analytical runtime for pinned Parquet with fixed SQL, parameters, bounds, and disposal', async () => {
    const config = await fixtureConfig('parquet');
    const artifact = await acquiredFixture('parquet');
    let disposed = false;
    let observedQuery: unknown;
    const runtime = {
      open: async () => {
        await Promise.resolve();
        return {
          execute: async (query: unknown) => {
            await Promise.resolve();
            observedQuery = query;
            return {
              rows: [
                {
                  id: '346ea5cb-3d37-4661-9001-7d0b0ea36a5a',
                  version: 3,
                  names: { primary: 'Starbucks', common: null, rules: [] },
                  categories: { primary: 'coffee_shop', alternate: ['cafe'] },
                  confidence: 0.8,
                  brand: {
                    wikidata: STARBUCKS_WIKIDATA_ID,
                    names: { primary: 'Starbucks', common: null, rules: [] },
                  },
                  addresses: [
                    {
                      freeform: '2801 Stevens Creek Blvd',
                      locality: 'Santa Clara',
                      postcode: '95050',
                      region: 'CA',
                      country: 'US',
                    },
                  ],
                  sources: [
                    {
                      property: '',
                      dataset: 'AllThePlaces',
                      license: 'CC0-1.0',
                      record_id: 'record',
                      update_time: '2026-06-02T15:18:54.000Z',
                      confidence: 0.8,
                      between: null,
                    },
                  ],
                  operating_status: null,
                  basic_category: 'coffee_shop',
                  taxonomy: {
                    primary: 'coffee_shop',
                    hierarchy: ['food_and_drink', 'coffee_shop'],
                    alternates: [],
                  },
                  longitude: -121.9425,
                  latitude: 37.3251,
                  theme: 'places',
                  type: 'place',
                },
              ],
              elapsedMs: 5,
              scannedBytes: config.expectedBytes,
              truncated: false,
            };
          },
          [Symbol.asyncDispose]: async () => {
            await Promise.resolve();
            disposed = true;
          },
        };
      },
    };
    const adapter = new OvertureStarbucksAdapter({ artifact: config, maximumRows: 25 });
    const decoded = await collect(
      adapter.decode(artifact, {
        artifactStore: new TestArtifactStore(),
        analyticalRuntime: runtime as never,
        clock: new TestClock(),
        signal: controller().signal,
      }),
    );
    expect(decoded).toHaveLength(1);
    expect(observedQuery).toMatchObject({
      operation: 'decode_overture_santa_clara_starbucks_candidates',
      statement: OVERTURE_STARBUCKS_QUERY,
      maximumRows: 25,
      maximumScanBytes: config.expectedBytes,
      parameters: expect.arrayContaining([STARBUCKS_WIKIDATA_ID, '%starbucks%']),
    });
    expect(disposed).toBe(true);
  });

  it('reports deterministic summary accounting including aborted state', async () => {
    const adapter = new OvertureStarbucksAdapter({ artifact: await fixtureConfig() });
    const checkpoint = sourceCheckpointSchema.parse({
      sourceId: adapter.describe().sourceId,
      snapshotId: SNAPSHOT_ID,
      contractVersion: '1.0.0',
      cursor: 'none',
      nextSequence: 0,
      completedRequestKeys: [],
      acquiredArtifactIds: [],
      updatedAt: '2026-07-17T10:00:00.000Z',
      complete: false,
    });
    const summary = adapter.summarize(
      {
        descriptor: adapter.describe(),
        runId: `sc:run:${'1'.repeat(64)}` as never,
        request: request(),
        plan: {
          sourceId: adapter.describe().sourceId,
          snapshotId: SNAPSHOT_ID,
          contractVersion: '1.0.0',
          plannedAt: '2026-07-17T10:00:00.000Z',
          items: [
            {
              requestKey: 'one',
              sequence: 0,
              method: 'GET',
              url: FIXTURE_URL,
              encoding: 'geojson',
              expectedMediaTypes: ['application/geo+json'],
            },
          ],
        },
        startedAt: '2026-07-17T10:00:00.000Z',
        completedAt: '2026-07-17T10:00:01.000Z',
        finalCheckpoint: checkpoint,
        artifacts: [],
        decodedRecords: 0,
        acceptedRecords: 0,
        rejectedRecords: 0,
        mutations: [],
        validationIssues: [],
        aborted: true,
      },
      { clock: new TestClock(), signal: controller().signal },
    );
    expect(summary).toMatchObject({
      status: 'aborted',
      artifactsAcquired: 0,
      normalizedMutations: 0,
    });
  });
});
