import type {
  ArtifactBody,
  ArtifactByteRange,
  ImmutableArtifactWrite,
  RecoverableArtifactStore,
  StreamingImmutableArtifactWrite,
  StoredArtifact,
} from '@oracle/artifacts/artifact-store';
import type {
  CheckpointCommit,
  CheckpointCommitResult,
  CheckpointEnvelope,
  CheckpointStore,
  CheckpointValue,
} from '@oracle/artifacts/checkpoint-store';
import { snapshotIdSchema, type RunId } from '@oracle/contracts/ids';
import type {
  AcquisitionRequest,
  SourceCheckpoint,
  ValidationIssue,
} from '@oracle/contracts/source';
import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../../spi/bytes.js';
import type { AcquiredArtifactSource } from '../../spi/acquired-artifact.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../../spi/http.js';
import { createSharedRecordBudget } from '../../spi/record-budget.js';
import {
  WATER_VIEW_LIMITATIONS,
  assertWaterViewClaim,
  classifyHttpStatus,
  createNoaaCuspShorelineAdapter,
  createNoaaUsgsWaterElevationAdapters,
  createUsgs3depElevationAdapter,
  createUsgs3dhpHydrographyAdapter,
  type WaterElevationDecodedRecord,
} from './adapter.js';
import { NOAA_CUSP_SHORELINE } from './catalog.js';
import { decodeNoaaShorelineArchiveStream } from './formats.js';

const NOW = '2026-07-17T13:00:00.000Z';
const clock = { now: () => NOW };
const analyticalRuntime = {} as never;

function body(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () {
    await Promise.resolve();
    yield Uint8Array.from(bytes);
  })();
}

interface ScriptedResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly bytes?: Uint8Array;
}

class QueueTransport implements HttpTransport {
  public readonly requests: HttpRequest[] = [];

  public constructor(private readonly responses: ScriptedResponse[]) {}

  public send(request: HttpRequest, signal: AbortSignal): Promise<HttpResponse> {
    signal.throwIfAborted();
    this.requests.push(request);
    const next = this.responses.shift();
    if (next === undefined) throw new Error(`Unexpected request ${request.method} ${request.url}`);
    return Promise.resolve({
      status: next.status,
      headers: next.headers ?? Object.freeze({}),
      body: body(next.bytes ?? new Uint8Array()),
    });
  }
}

async function collectArtifactBody(value: ArtifactBody): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of value) {
    chunks.push(Uint8Array.from(chunk));
    length += chunk.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

class MemoryArtifactStore implements RecoverableArtifactStore {
  public readonly writes: ImmutableArtifactWrite[] = [];
  readonly #stored = new Map<string, { metadata: StoredArtifact; bytes: Uint8Array }>();

  public putImmutable(request: ImmutableArtifactWrite): Promise<StoredArtifact> {
    return this.putImmutableStreaming(request);
  }

  public async putImmutableStreaming(
    request: StreamingImmutableArtifactWrite,
  ): Promise<StoredArtifact> {
    const bytes = await collectArtifactBody(request.body);
    const sha256 = sha256Hex(bytes);
    if (request.expectedSha256 !== undefined && sha256 !== request.expectedSha256) {
      throw new Error('INTEGRITY: streamed bytes drifted');
    }
    this.writes.push(request as ImmutableArtifactWrite);
    const stored = Object.freeze({
      logicalKey: request.logicalKey,
      uri: `file://test-artifacts/${encodeURIComponent(request.logicalKey)}`,
      mediaType: request.mediaType,
      byteSize: bytes.byteLength,
      sha256,
      storedAt: NOW,
      metadata: request.metadata,
    });
    this.#stored.set(stored.uri, { metadata: stored, bytes });
    return stored;
  }

  public head(uri: string): Promise<StoredArtifact | undefined> {
    return Promise.resolve(this.#stored.get(uri)?.metadata);
  }

  public headByLogicalKey(logicalKey: string): Promise<StoredArtifact | undefined> {
    const stored = [...this.#stored.values()].find(
      ({ metadata }) => metadata.logicalKey === logicalKey,
    );
    if (stored !== undefined && sha256Hex(stored.bytes) !== stored.metadata.sha256) {
      throw new Error(`test artifact integrity mismatch: ${logicalKey}`);
    }
    return Promise.resolve(stored?.metadata);
  }

  public removeByLogicalKey(logicalKey: string): void {
    for (const [uri, stored] of this.#stored) {
      if (stored.metadata.logicalKey === logicalKey) this.#stored.delete(uri);
    }
  }

  public corruptByLogicalKey(logicalKey: string): void {
    for (const stored of this.#stored.values()) {
      if (stored.metadata.logicalKey !== logicalKey || stored.bytes.byteLength === 0) continue;
      stored.bytes[0] = (stored.bytes[0] ?? 0) ^ 1;
    }
  }

  public async *read(uri: string, range?: ArtifactByteRange): AsyncIterable<Uint8Array> {
    await Promise.resolve();
    const stored = this.#stored.get(uri);
    if (stored === undefined) throw new Error('missing test artifact');
    yield range === undefined
      ? Uint8Array.from(stored.bytes)
      : stored.bytes.slice(range.start, range.endInclusive + 1);
  }
}

function repeatable<T>(values: readonly T[]) {
  return Object.freeze({
    count: values.length,
    logicalSha256: '0'.repeat(64),
    read: async function* () {
      await Promise.resolve();
      for (const value of values) yield value;
    },
  });
}

class MemoryCheckpointStore implements CheckpointStore {
  public value: CheckpointEnvelope | undefined;

  public load(): Promise<CheckpointEnvelope | undefined> {
    return Promise.resolve(this.value);
  }

  public commit<TPayload extends CheckpointValue>(
    request: CheckpointCommit<TPayload>,
  ): Promise<CheckpointCommitResult<TPayload>> {
    if ((this.value?.revision ?? null) !== request.expectedRevision) {
      return Promise.resolve({ status: 'conflict', current: this.value });
    }
    this.value = request.checkpoint;
    return Promise.resolve({ status: 'committed', checkpoint: request.checkpoint });
  }
}

const immediateDelay = {
  waits: [] as number[],
  wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.waits.push(milliseconds);
    return Promise.resolve();
  },
};

function hydroFeature(id: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id,
          geometry: {
            type: 'LineString',
            coordinates: [
              [-121.9501, 37.4201],
              [-121.9499, 37.4203],
            ],
          },
          properties: {
            id3dhp: id,
            objectid: Number(id.replace(/\D/g, '')) || 1,
            featuretypelabel: 'Stream/River',
            gnisidlabel: 'Fixture Creek',
            workunitid: '3DHP test excerpt',
          },
        },
      ],
    }),
  );
}

function requestFor(
  sourceId: ReturnType<typeof createUsgs3dhpHydrographyAdapter>['describe'] extends () => infer T
    ? T extends { sourceId: infer S }
      ? S
      : never
    : never,
): AcquisitionRequest {
  return {
    sourceId,
    snapshotId: snapshotIdSchema.parse(
      `sc:snapshot:${sourceId.replace('sc:source:', '')}:${'a'.repeat(64)}`,
    ),
    requestedAt: NOW,
    mode: 'full',
    requestedSourceAsOf: { state: 'reported', at: '2026-06-26T00:00:00.000Z' },
  };
}

describe('NOAA/USGS water and elevation adapter lifecycle', () => {
  it('classifies retry, access, and data-quality responses without retrying credentials', () => {
    expect(classifyHttpStatus(200)).toBeNull();
    expect(classifyHttpStatus(429)).toMatchObject({ code: 'TRANSIENT_SOURCE', retryable: true });
    expect(classifyHttpStatus(503)).toMatchObject({ code: 'TRANSIENT_SOURCE', retryable: true });
    expect(classifyHttpStatus(401)).toMatchObject({ code: 'AUTHENTICATION', retryable: false });
    expect(classifyHttpStatus(403)).toMatchObject({ code: 'TERMS_ACCESS', retryable: false });
    expect(classifyHttpStatus(404)).toMatchObject({ code: 'RECORD_QUALITY', retryable: false });
  });

  it('terminates a NOAA acquisition on HTTP 403 without retrying or persisting state', async () => {
    immediateDelay.waits.length = 0;
    const adapter = createNoaaCuspShorelineAdapter();
    const signal = new AbortController().signal;
    const identityHeaders = {
      etag: '"28897d9-64dc8719a4ec0"',
      'last-modified': 'Tue, 24 Mar 2026 17:25:55 GMT',
      'content-length': '42506201',
      'content-type': 'application/zip',
    };
    const discovery = await adapter.discover({
      clock,
      signal,
      http: new QueueTransport([{ status: 200, headers: identityHeaders }]),
      ratePolicy: adapter.describe().ratePolicy,
      delay: immediateDelay,
    });
    const plan = await adapter.plan(requestFor(adapter.describe().sourceId), discovery, {
      clock,
      signal,
    });
    const transport = new QueueTransport([{ status: 403 }]);
    const artifacts = new MemoryArtifactStore();
    const checkpoints = new MemoryCheckpointStore();

    await expect(
      (async () => {
        for await (const artifact of adapter.acquire(plan, undefined, {
          clock,
          signal,
          http: transport,
          artifactStore: artifacts,
          checkpointStore: checkpoints,
          ratePolicy: adapter.describe().ratePolicy,
          delay: immediateDelay,
        })) {
          void artifact;
        }
      })(),
    ).rejects.toMatchObject({ code: 'TERMS_ACCESS', retryable: false, phase: 'acquire' });
    expect(transport.requests).toHaveLength(1);
    expect(immediateDelay.waits).toEqual([]);
    expect(artifacts.writes).toEqual([]);
    expect(checkpoints.value).toBeUndefined();
  });

  it('discovers both current 3DHP layers, retries 429, checkpoints, and resumes deterministically', async () => {
    immediateDelay.waits.length = 0;
    const adapter = createUsgs3dhpHydrographyAdapter({
      bounds: [-122, 37.4, -121.9, 37.5],
      hydroPageSize: 1,
    });
    const descriptor = adapter.describe();
    const signal = new AbortController().signal;
    const discoveryTransport = new QueueTransport([
      { status: 200, bytes: new TextEncoder().encode('{"count":2}') },
      { status: 200, bytes: new TextEncoder().encode('{"count":0}') },
    ]);
    const discovery = await adapter.discover({
      clock,
      signal,
      http: discoveryTransport,
      ratePolicy: descriptor.ratePolicy,
      delay: immediateDelay,
    });
    expect(discovery.resources.map((resource) => resource.requestKey)).toEqual([
      'layer-50-page-0',
      'layer-50-page-1',
    ]);
    expect(
      discoveryTransport.requests.every((item) => item.url.includes('returnCountOnly=true')),
    ).toBe(true);

    const request = requestFor(descriptor.sourceId);
    const tamperedDiscovery = {
      ...discovery,
      resources: discovery.resources.map((resource, index) =>
        index === 0 ? { ...resource, url: 'https://example.invalid/authority-drift' } : resource,
      ),
    };
    expect(() => adapter.plan(request, tamperedDiscovery, { clock, signal })).toThrow(
      /adapter-authoritative request set/u,
    );
    const plan = await adapter.plan(request, discovery, { clock, signal });
    const artifacts = new MemoryArtifactStore();
    const checkpoints = new MemoryCheckpointStore();
    const transport = new QueueTransport([
      { status: 429, headers: { 'retry-after': '0' } },
      {
        status: 200,
        headers: { 'content-type': 'application/geo+json' },
        bytes: hydroFeature('11JSF'),
      },
      {
        status: 200,
        headers: { 'content-type': 'application/geo+json' },
        bytes: hydroFeature('11JSG'),
      },
    ]);
    const context = {
      clock,
      signal,
      http: transport,
      artifactStore: artifacts,
      checkpointStore: checkpoints,
      ratePolicy: descriptor.ratePolicy,
      delay: immediateDelay,
    };

    const firstRun = adapter.acquire(plan, undefined, context)[Symbol.asyncIterator]();
    const first = await firstRun.next();
    expect(first.done).toBe(false);
    if (first.done) throw new Error('Expected first acquired artifact');
    const firstArtifact = first.value;
    await firstRun.return?.();
    expect(immediateDelay.waits).toEqual([0]);
    expect(firstArtifact.metadata.request.attempt).toBe(2);
    expect(firstArtifact.metadata.rawUri).toMatch(/^file:\/\/test-artifacts\//u);
    expect(firstArtifact.metadata.visibility).toBe('public');
    expect((checkpoints.value?.payload as SourceCheckpoint).nextSequence).toBe(1);

    const ownedCheckpoint = checkpoints.value?.payload as SourceCheckpoint;
    const wrongCheckpoint: SourceCheckpoint = {
      ...ownedCheckpoint,
      snapshotId: snapshotIdSchema.parse(
        `sc:snapshot:${descriptor.sourceId.replace('sc:source:', '')}:${'c'.repeat(64)}`,
      ),
    };
    await expect(
      (async () => {
        for await (const artifact of adapter.acquire(plan, wrongCheckpoint, context)) {
          void artifact;
        }
      })(),
    ).rejects.toThrow(/exact contiguous acquisition prefix/u);

    const resumed: AcquiredArtifactSource[] = [];
    const freshAdapter = createUsgs3dhpHydrographyAdapter({
      bounds: [-122, 37.4, -121.9, 37.5],
      hydroPageSize: 1,
    });
    for await (const artifact of freshAdapter.acquire(plan, undefined, context)) {
      resumed.push(artifact);
    }
    expect(resumed.map(({ metadata }) => metadata.request.requestKey)).toEqual([
      'layer-50-page-0',
      'layer-50-page-1',
    ]);
    expect(resumed[0]?.metadata).toEqual(firstArtifact.metadata);
    const resumedArtifact = resumed[1];
    if (resumedArtifact === undefined) throw new Error('Expected resumed artifact');
    expect(resumedArtifact.metadata.request.requestKey).toBe('layer-50-page-1');
    expect((checkpoints.value?.payload as SourceCheckpoint).complete).toBe(true);
    expect(artifacts.writes).toHaveLength(2);
    const replayTransport = new QueueTransport([]);
    const replayed = [];
    for await (const artifact of createUsgs3dhpHydrographyAdapter({
      bounds: [-122, 37.4, -121.9, 37.5],
      hydroPageSize: 1,
    }).acquire(plan, undefined, { ...context, http: replayTransport })) {
      replayed.push(artifact);
    }
    expect(replayed.map(({ metadata }) => metadata)).toEqual(
      resumed.map(({ metadata }) => metadata),
    );
    expect(replayTransport.requests).toHaveLength(0);

    const completeEnvelope = checkpoints.value;
    if (completeEnvelope === undefined) throw new Error('Expected complete provider checkpoint');
    const completeCheckpoint = completeEnvelope.payload as SourceCheckpoint;
    expect(completeCheckpoint.acquiredArtifactIds).toHaveLength(2);
    const reversedCheckpoints = new MemoryCheckpointStore();
    reversedCheckpoints.value = Object.freeze({
      ...completeEnvelope,
      payload: Object.freeze({
        ...completeCheckpoint,
        acquiredArtifactIds: Object.freeze([...completeCheckpoint.acquiredArtifactIds].reverse()),
      }),
    });
    const reversedTransport = new QueueTransport([]);
    const reversedReplay = createUsgs3dhpHydrographyAdapter({
      bounds: [-122, 37.4, -121.9, 37.5],
      hydroPageSize: 1,
    }).acquire(plan, undefined, {
      ...context,
      http: reversedTransport,
      checkpointStore: reversedCheckpoints,
    });
    await expect(reversedReplay[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: 'SCHEMA_DRIFT',
      retryable: false,
      phase: 'acquire',
      message: expect.stringMatching(/ordered raw prefix/u),
    });
    expect(reversedTransport.requests).toHaveLength(0);

    const decoded: WaterElevationDecodedRecord[] = [];
    for await (const record of adapter.decode(firstArtifact, {
      clock,
      signal,
      artifactStore: artifacts,
      analyticalRuntime,
      recordBudget: createSharedRecordBudget(1),
    })) {
      decoded.push(record);
    }
    expect(decoded).toHaveLength(1);
    const decodedRecord = decoded[0];
    if (decodedRecord === undefined) throw new Error('Expected decoded hydro record');
    const validation = await adapter.validate(decodedRecord, { clock, signal });
    expect(validation.status).toBe('accepted');
    if (validation.status !== 'accepted') throw new Error('Expected accepted hydro record');
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'NO_VIEW_CLAIM', severity: 'warning' }),
      ]),
    );
    const mutations = [];
    for await (const mutation of adapter.normalize(validation.record, {
      clock,
      signal,
      analyticalRuntime,
      recordBudget: createSharedRecordBudget(1),
    })) {
      mutations.push(mutation);
    }
    const repeated = [];
    for await (const mutation of adapter.normalize(validation.record, {
      clock,
      signal,
      analyticalRuntime,
      recordBudget: createSharedRecordBudget(1),
    })) {
      repeated.push(mutation);
    }
    expect(repeated).toEqual(mutations);
    const mutation = mutations[0];
    expect(mutation?.kind).toBe('entity_upsert');
    if (mutation?.kind !== 'entity_upsert') throw new Error('Expected entity upsert mutation');
    expect(mutation.entity.entityKind).toBe('hydro-feature');
    expect(mutation.visibility).toBe(firstArtifact.metadata.visibility);
    expect(mutation.entity.lineage[0]?.sourceRecord.artifactId).toBe(
      firstArtifact.metadata.artifactId,
    );

    const issues: ValidationIssue[] = validation.issues.slice();
    const observation = {
      descriptor,
      request,
      plan,
      runId: `sc:run:${'b'.repeat(64)}` as RunId,
      startedAt: NOW,
      completedAt: NOW,
      finalCheckpoint: checkpoints.value?.payload as SourceCheckpoint,
      artifacts: [firstArtifact.metadata, resumedArtifact.metadata],
      decodedRecords: 2,
      acceptedRecords: 2,
      rejectedRecords: 0,
      mutations: repeatable(mutations),
      validationIssues: repeatable(issues),
      aborted: false,
    } as const;
    const summary = await adapter.summarize(observation, { clock, signal });
    expect(summary).toMatchObject({
      status: 'succeeded',
      artifactsAcquired: 2,
      decodedRecords: 2,
      acceptedRecords: 2,
      normalizedMutations: 1,
      warningCount: 1,
      errorCount: 0,
    });
    await expect(
      adapter.summarize(
        { ...observation, acceptedRecords: 1, rejectedRecords: 0 },
        { clock, signal },
      ),
    ).rejects.toThrow(/accounting mismatch/u);
    expect(
      await adapter.summarize(
        { ...observation, acceptedRecords: 1, rejectedRecords: 1 },
        { clock, signal },
      ),
    ).toMatchObject({ status: 'partial' });

    const authenticatedMutations = [];
    for await (const authenticatedMutation of adapter.normalize(
      { ...validation.record, visibility: 'authenticated' },
      { clock, signal, analyticalRuntime, recordBudget: createSharedRecordBudget(1) },
    )) {
      authenticatedMutations.push(authenticatedMutation);
    }
    expect(authenticatedMutations[0]?.visibility).toBe('authenticated');
  });

  it('replays an exact persisted hydro prefix before HTTP and deduplicates identical bodies', async () => {
    const signal = new AbortController().signal;
    const adapter = createUsgs3dhpHydrographyAdapter({
      bounds: [-122, 37.4, -121.9, 37.5],
      hydroPageSize: 1,
    });
    const descriptor = adapter.describe();
    const discovery = await adapter.discover({
      clock,
      signal,
      http: new QueueTransport([
        { status: 200, bytes: new TextEncoder().encode('{"count":2}') },
        { status: 200, bytes: new TextEncoder().encode('{"count":0}') },
      ]),
      ratePolicy: descriptor.ratePolicy,
      delay: immediateDelay,
    });
    const plan = await adapter.plan(requestFor(descriptor.sourceId), discovery, { clock, signal });
    const identicalBody = hydroFeature('11JSF');
    const seed = async () => {
      const artifactStore = new MemoryArtifactStore();
      const checkpointStore = new MemoryCheckpointStore();
      const transport = new QueueTransport([
        {
          status: 200,
          headers: { 'content-type': 'application/geo+json' },
          bytes: identicalBody,
        },
        {
          status: 200,
          headers: { 'content-type': 'application/geo+json' },
          bytes: identicalBody,
        },
      ]);
      const acquired: AcquiredArtifactSource[] = [];
      for await (const artifact of createUsgs3dhpHydrographyAdapter({
        bounds: [-122, 37.4, -121.9, 37.5],
        hydroPageSize: 1,
      }).acquire(plan, undefined, {
        clock,
        signal,
        http: transport,
        artifactStore,
        checkpointStore,
        ratePolicy: descriptor.ratePolicy,
        delay: immediateDelay,
      })) {
        acquired.push(artifact);
      }
      return { acquired, artifactStore, checkpointStore };
    };

    const seeded = await seed();
    const persisted = seeded.checkpointStore.value?.payload as SourceCheckpoint;
    expect(persisted.completedRequestKeys).toEqual(['layer-50-page-0', 'layer-50-page-1']);
    expect(persisted.acquiredArtifactIds).toHaveLength(1);
    expect(seeded.acquired.map(({ metadata }) => metadata.artifactId)).toEqual([
      persisted.acquiredArtifactIds[0],
      persisted.acquiredArtifactIds[0],
    ]);

    const replayTransport = new QueueTransport([]);
    const replayed: AcquiredArtifactSource[] = [];
    for await (const artifact of createUsgs3dhpHydrographyAdapter({
      bounds: [-122, 37.4, -121.9, 37.5],
      hydroPageSize: 1,
    }).acquire(plan, undefined, {
      clock,
      signal,
      http: replayTransport,
      artifactStore: seeded.artifactStore,
      checkpointStore: seeded.checkpointStore,
      ratePolicy: descriptor.ratePolicy,
      delay: immediateDelay,
    })) {
      replayed.push(artifact);
    }
    expect(replayed.map(({ metadata }) => metadata)).toEqual(
      seeded.acquired.map(({ metadata }) => metadata),
    );
    expect(replayed.map(({ metadata }) => metadata.request.requestKey)).toEqual([
      'layer-50-page-0',
      'layer-50-page-1',
    ]);
    expect(replayTransport.requests).toHaveLength(0);

    const mismatchTransport = new QueueTransport([]);
    const mismatch = adapter.acquire(
      plan,
      { ...persisted, updatedAt: '2026-07-17T13:00:01.000Z' },
      {
        clock,
        signal,
        http: mismatchTransport,
        artifactStore: seeded.artifactStore,
        checkpointStore: seeded.checkpointStore,
        ratePolicy: descriptor.ratePolicy,
        delay: immediateDelay,
      },
    );
    await expect(mismatch[Symbol.asyncIterator]().next()).rejects.toThrow(
      /provider checkpoints disagree/u,
    );
    expect(mismatchTransport.requests).toHaveLength(0);

    const firstLogicalKey = `raw/${plan.sourceId}/${plan.snapshotId}/0-layer-50-page-0`;
    const missing = await seed();
    missing.artifactStore.removeByLogicalKey(firstLogicalKey);
    const missingTransport = new QueueTransport([]);
    const missingRun = adapter.acquire(plan, undefined, {
      clock,
      signal,
      http: missingTransport,
      artifactStore: missing.artifactStore,
      checkpointStore: missing.checkpointStore,
      ratePolicy: descriptor.ratePolicy,
      delay: immediateDelay,
    });
    await expect(missingRun[Symbol.asyncIterator]().next()).rejects.toThrow(
      /missing raw artifact layer-50-page-0/u,
    );
    expect(missingTransport.requests).toHaveLength(0);

    const corrupt = await seed();
    corrupt.artifactStore.corruptByLogicalKey(firstLogicalKey);
    const corruptTransport = new QueueTransport([]);
    const corruptRun = adapter.acquire(plan, undefined, {
      clock,
      signal,
      http: corruptTransport,
      artifactStore: corrupt.artifactStore,
      checkpointStore: corrupt.checkpointStore,
      ratePolicy: descriptor.ratePolicy,
      delay: immediateDelay,
    });
    await expect(corruptRun[Symbol.asyncIterator]().next()).rejects.toThrow(
      /artifact integrity mismatch/u,
    );
    expect(corruptTransport.requests).toHaveLength(0);
  });

  it('keeps unknown-rights NOAA bytes authenticated and fails closed on frozen identity drift', async () => {
    expect(NOAA_CUSP_SHORELINE.descriptor.defaultVisibility).toBe('authenticated');
    expect(NOAA_CUSP_SHORELINE.frozenArtifact).toEqual({
      byteSize: 42_506_201,
      sha256: 'd07277208ab4399b2e62ed6e86d86bbb5cbc7d92cc0bfa499cf156712693b1d6',
      etag: '"28897d9-64dc8719a4ec0"',
      lastModified: '2026-03-24T17:25:55.000Z',
    });
    const signal = new AbortController().signal;
    const production = createNoaaCuspShorelineAdapter();
    await expect(
      production.discover({
        clock,
        signal,
        http: new QueueTransport([
          {
            status: 200,
            headers: {
              etag: '"drifted"',
              'last-modified': 'Tue, 24 Mar 2026 17:25:55 GMT',
              'content-length': '42506201',
            },
          },
        ]),
        ratePolicy: production.describe().ratePolicy,
        delay: immediateDelay,
      }),
    ).rejects.toThrow(/response identity drifted/u);

    const frozenBytes = new TextEncoder().encode('tiny deterministic NOAA acquisition boundary');
    const tinyProduct = {
      ...NOAA_CUSP_SHORELINE,
      productVersion: 'test-only frozen identity',
      frozenArtifact: Object.freeze({
        byteSize: frozenBytes.byteLength,
        sha256: sha256Hex(frozenBytes),
        etag: '"test-etag"',
        lastModified: NOW,
      }),
    };
    const [adapter] = createNoaaUsgsWaterElevationAdapters({ products: [tinyProduct] });
    if (adapter === undefined) throw new Error('Expected test NOAA adapter');
    const identityHeaders = {
      etag: '"test-etag"',
      'last-modified': 'Fri, 17 Jul 2026 13:00:00 GMT',
      'content-length': String(frozenBytes.byteLength),
      'content-type': 'application/zip',
    };
    const discovery = await adapter.discover({
      clock,
      signal,
      http: new QueueTransport([{ status: 200, headers: identityHeaders }]),
      ratePolicy: adapter.describe().ratePolicy,
      delay: immediateDelay,
    });
    const request = requestFor(adapter.describe().sourceId);
    const plan = await adapter.plan(request, discovery, { clock, signal });
    const acquisitionTransport = new QueueTransport([
      { status: 200, headers: identityHeaders, bytes: frozenBytes },
    ]);
    const acquired = [];
    for await (const artifact of adapter.acquire(plan, undefined, {
      clock,
      signal,
      http: acquisitionTransport,
      artifactStore: new MemoryArtifactStore(),
      checkpointStore: new MemoryCheckpointStore(),
      ratePolicy: adapter.describe().ratePolicy,
      delay: immediateDelay,
    })) {
      acquired.push(artifact);
    }
    expect(acquired[0]?.metadata).toMatchObject({
      visibility: 'authenticated',
      rawUri: expect.stringMatching(/^file:\/\/test-artifacts\//u),
      sha256: sha256Hex(frozenBytes),
    });

    const drifted = Uint8Array.from(frozenBytes);
    drifted[0] = (drifted[0] ?? 0) ^ 0xff;
    await expect(
      (async () => {
        for await (const artifact of adapter.acquire(plan, undefined, {
          clock,
          signal,
          http: new QueueTransport([{ status: 200, headers: identityHeaders, bytes: drifted }]),
          artifactStore: new MemoryArtifactStore(),
          checkpointStore: new MemoryCheckpointStore(),
          ratePolicy: adapter.describe().ratePolicy,
          delay: immediateDelay,
        })) {
          void artifact;
        }
      })(),
    ).rejects.toThrow(/bytes drifted/u);
  });

  it('aborts before transport and refuses a verified-view claim', async () => {
    const adapter = createUsgs3depElevationAdapter({ bounds: [-122, 37.4, -121.9, 37.5] });
    const controller = new AbortController();
    controller.abort(new Error('operator abort'));
    const transport = new QueueTransport([]);
    await expect(
      adapter.discover({
        clock,
        signal: controller.signal,
        http: transport,
        ratePolicy: adapter.describe().ratePolicy,
        delay: immediateDelay,
      }),
    ).rejects.toThrow('operator abort');
    const shoreline = decodeNoaaShorelineArchiveStream(
      (async function* () {
        await Promise.resolve();
        yield new Uint8Array();
      })(),
      [-122, 37.4, -121.9, 37.5],
      controller.signal,
    );
    await expect(shoreline[Symbol.asyncIterator]().next()).rejects.toThrow('operator abort');
    expect(transport.requests).toHaveLength(0);
    expect(() => assertWaterViewClaim('verified_view')).toThrow(/never verified views/i);
    expect(WATER_VIEW_LIMITATIONS).toHaveLength(3);
  });
});
