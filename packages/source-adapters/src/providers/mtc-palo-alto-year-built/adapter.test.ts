import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type {
  ArtifactByteRange,
  ImmutableArtifactWrite,
  RecoverableArtifactStore,
  StreamingImmutableArtifactWrite,
  StoredArtifact,
} from '@oracle/artifacts/artifact-store';
import {
  createCheckpointEnvelope,
  type CheckpointCommit,
  type CheckpointCommitResult,
  type CheckpointEnvelope,
  type CheckpointStore,
  type CheckpointValue,
} from '@oracle/artifacts/checkpoint-store';
import {
  canonicalMutationSchema,
  type CanonicalMutation,
} from '@oracle/contracts/canonical/mutation';
import { runIdSchema, schemaFingerprintValueSchema, snapshotIdSchema } from '@oracle/contracts/ids';
import {
  acquiredArtifactSchema,
  acquisitionRequestSchema,
  sourceCheckpointSchema,
  type SourceCheckpoint,
} from '@oracle/contracts/source';
import { describe, expect, it } from 'vitest';

import {
  createAcquiredByteArtifact,
  type AcquiredArtifactSource,
  type AcquiredByteArtifact,
} from '../../spi/acquired-artifact.js';
import type {
  DiscoveryContext,
  PlanningContext,
  RepeatableObservationValues,
  SourceRunObservationV2,
  StreamingAcquisitionContext,
  StreamingDecodeContext,
} from '../../spi/adapter.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../../spi/http.js';
import { sha256Hex } from '../../spi/bytes.js';
import { createSharedRecordBudget } from '../../spi/record-budget.js';
import { createMtcPaloAltoYearBuiltAdapter, normalizeMtcPaloAltoApn } from './adapter.js';
import {
  MTC_PALO_ALTO_LICENSE_SNAPSHOT_ID,
  MTC_PALO_ALTO_SCHEMA_FINGERPRINT,
  MTC_PALO_ALTO_SOURCE_ID,
} from './constants.js';
import type { MtcPaloAltoDecodedRecord, MtcPaloAltoRawRow } from './types.js';

const HASH = 'a'.repeat(64);
const SNAPSHOT_ID = snapshotIdSchema.parse(`sc:snapshot:mtc-palo-alto-year-built:${HASH}`);
const RUN_ID = runIdSchema.parse(`sc:run:${'b'.repeat(64)}`);
const AT = '2026-07-17T13:01:18.800Z';
const SOURCE_AS_OF = '2026-07-06T12:46:40.000Z';
const FIXTURE_ROOT = new URL(
  '../../../../testkit/src/sources/mtc-palo-alto-year-built/',
  import.meta.url,
);

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(name, FIXTURE_ROOT)));
}

async function officialRows(): Promise<readonly MtcPaloAltoRawRow[]> {
  const parsed: unknown = JSON.parse(
    new TextDecoder().decode(await fixture('official-socrata-duplicate-apn.json')),
  );
  if (!Array.isArray(parsed)) throw new TypeError('Official fixture must be an array');
  return parsed as readonly MtcPaloAltoRawRow[];
}

function stream(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* bytesStream() {
    await Promise.resolve();
    yield Uint8Array.from(bytes);
  })();
}

function response(
  bytes: Uint8Array,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): HttpResponse {
  return Object.freeze({
    status,
    headers: Object.freeze({
      'content-type': 'application/json;charset=utf-8',
      'last-modified': 'Mon, 06 Jul 2026 12:45:55 GMT',
      etag: '"official-fixture"',
      ...headers,
    }),
    body: stream(bytes),
  });
}

type ScriptedHttpStep = HttpResponse | Readonly<{ throws: Error }>;

class ScriptedHttp implements HttpTransport {
  readonly #responses: ScriptedHttpStep[];
  readonly requests: HttpRequest[] = [];

  public constructor(responses: readonly ScriptedHttpStep[]) {
    this.#responses = [...responses];
  }

  public send(request: HttpRequest, signal: AbortSignal): Promise<HttpResponse> {
    signal.throwIfAborted();
    this.requests.push(request);
    const next = this.#responses.shift();
    if (next === undefined) throw new Error(`Missing response for ${request.url}`);
    if ('throws' in next) return Promise.reject(next.throws);
    return Promise.resolve(next);
  }
}

class TestArtifactStore implements RecoverableArtifactStore {
  readonly stored = new Map<string, Readonly<{ descriptor: StoredArtifact; bytes: Uint8Array }>>();
  readonly #corruptReturn: boolean;

  public constructor(corruptReturn = false) {
    this.#corruptReturn = corruptReturn;
  }

  public async putImmutable(request: ImmutableArtifactWrite): Promise<StoredArtifact> {
    const chunks: Uint8Array[] = [];
    if (request.body instanceof Uint8Array) {
      chunks.push(request.body);
    } else {
      for await (const chunk of request.body) chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== request.expectedSha256) throw new Error('fixture SHA mismatch');
    const descriptor = Object.freeze({
      logicalKey: request.logicalKey,
      uri: `file:///oracle-test/${encodeURIComponent(request.logicalKey)}`,
      mediaType: request.mediaType,
      byteSize: bytes.byteLength,
      sha256,
      storedAt: AT,
      metadata: request.metadata,
    });
    this.stored.set(descriptor.uri, Object.freeze({ descriptor, bytes }));
    return this.#corruptReturn
      ? Object.freeze({ ...descriptor, byteSize: descriptor.byteSize + 1 })
      : descriptor;
  }

  public async putImmutableStreaming(
    request: StreamingImmutableArtifactWrite,
  ): Promise<StoredArtifact> {
    const chunks: Uint8Array[] = [];
    if (request.body instanceof Uint8Array) chunks.push(request.body);
    else for await (const chunk of request.body) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return this.putImmutable({
      ...request,
      body: bytes,
      expectedSha256: request.expectedSha256 ?? sha256,
    });
  }

  public headByLogicalKey(logicalKey: string): Promise<StoredArtifact | undefined> {
    return Promise.resolve(
      [...this.stored.values()].find(({ descriptor }) => descriptor.logicalKey === logicalKey)
        ?.descriptor,
    );
  }

  public head(uri: string): Promise<StoredArtifact | undefined> {
    return Promise.resolve(this.stored.get(uri)?.descriptor);
  }

  public async *read(uri: string, range?: ArtifactByteRange): AsyncIterable<Uint8Array> {
    await Promise.resolve();
    const item = this.stored.get(uri);
    if (item === undefined) throw new Error('not found');
    yield range === undefined
      ? Uint8Array.from(item.bytes)
      : item.bytes.slice(range.start, range.endInclusive + 1);
  }
}

class TestCheckpointStore implements CheckpointStore {
  readonly values = new Map<string, CheckpointEnvelope>();

  public load(scope: string): Promise<CheckpointEnvelope | undefined> {
    return Promise.resolve(this.values.get(scope));
  }

  public commit<TPayload extends CheckpointValue>(
    request: CheckpointCommit<TPayload>,
  ): Promise<CheckpointCommitResult<TPayload>> {
    const current = this.values.get(request.checkpoint.scope);
    if ((current?.revision ?? null) !== request.expectedRevision) {
      return Promise.resolve(Object.freeze({ status: 'conflict', current }));
    }
    this.values.set(request.checkpoint.scope, request.checkpoint);
    return Promise.resolve(Object.freeze({ status: 'committed', checkpoint: request.checkpoint }));
  }
}

const clock = Object.freeze({ now: () => AT });
const delayCalls: number[] = [];
const delay = Object.freeze({
  wait: (milliseconds: number, signal: AbortSignal) => {
    signal.throwIfAborted();
    delayCalls.push(milliseconds);
    return Promise.resolve();
  },
});

function discoveryContext(
  http: HttpTransport,
  signal = new AbortController().signal,
): DiscoveryContext {
  return {
    http,
    clock,
    signal,
    delay,
    ratePolicy: createMtcPaloAltoYearBuiltAdapter().describe().ratePolicy,
  };
}

function planningContext(signal = new AbortController().signal): PlanningContext {
  return { clock, signal };
}

function acquisitionContext(
  http: HttpTransport,
  artifactStore: RecoverableArtifactStore,
  checkpointStore: CheckpointStore,
  signal = new AbortController().signal,
): StreamingAcquisitionContext {
  return {
    ...discoveryContext(http, signal),
    artifactStore,
    checkpointStore,
  };
}

function phaseContext(signal = new AbortController().signal): StreamingDecodeContext {
  return {
    clock,
    signal,
    artifactStore: new TestArtifactStore(),
    analyticalRuntime: {} as StreamingDecodeContext['analyticalRuntime'],
    recordBudget: createSharedRecordBudget(1),
  };
}

function repeatable<T>(values: readonly T[]): RepeatableObservationValues<T> {
  return {
    count: values.length,
    logicalSha256: sha256Hex(new TextEncoder().encode(JSON.stringify(values))),
    read: async function* () {
      await Promise.resolve();
      for (const value of values) yield value;
    },
  };
}

function request() {
  return acquisitionRequestSchema.parse({
    sourceId: MTC_PALO_ALTO_SOURCE_ID,
    snapshotId: SNAPSHOT_ID,
    requestedAt: AT,
    mode: 'full',
    requestedSourceAsOf: { state: 'reported', at: SOURCE_AS_OF },
  });
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label}`);
  return value;
}

function acquiredArtifact(
  rows: readonly unknown[],
  options: Readonly<{
    expectedRows?: number;
    fingerprint?: string;
    offset?: number;
    sequence?: number;
  }> = {},
): AcquiredByteArtifact {
  const bytes = new TextEncoder().encode(JSON.stringify(rows));
  const sha256 = sha256Hex(bytes);
  return createAcquiredByteArtifact(
    acquiredArtifactSchema.parse({
      artifactId: `sc:artifact:sha256:${sha256}`,
      sourceId: MTC_PALO_ALTO_SOURCE_ID,
      snapshotId: SNAPSHOT_ID,
      retrievedAt: AT,
      sourceAsOf: { state: 'reported', at: SOURCE_AS_OF },
      request: {
        requestKey: `page:${options.sequence ?? 0}:offset:${options.offset ?? 0}:expected:${options.expectedRows ?? rows.length}:asof:1783342000000`,
        method: 'GET',
        url: 'https://data.bayareametro.gov/resource/c252-zdg8.json',
        headers: [{ name: 'accept', valueSha256: HASH }],
        bodySha256: null,
        attempt: 1,
      },
      response: {
        httpStatus: 200,
        etag: '"fixture"',
        lastModified: SOURCE_AS_OF,
        finalUrl: 'https://data.bayareametro.gov/resource/c252-zdg8.json',
      },
      mediaType: 'application/json',
      encoding: 'json',
      byteSize: bytes.byteLength,
      sha256,
      schemaFingerprint: {
        algorithm: 'sha256',
        value: schemaFingerprintValueSchema.parse(
          options.fingerprint ?? MTC_PALO_ALTO_SCHEMA_FINGERPRINT,
        ),
        schemaName: 'mtc-palo-alto-c252-zdg8-v1',
        canonicalizationVersion: '1.0.0',
      },
      rawUri: `file:///official/${sha256}.json`,
      licenseSnapshotRef: MTC_PALO_ALTO_LICENSE_SNAPSHOT_ID,
      visibility: 'prohibited_public',
    }),
    bytes,
  );
}

async function decodeAll(artifact: AcquiredArtifactSource): Promise<MtcPaloAltoDecodedRecord[]> {
  const adapter = createMtcPaloAltoYearBuiltAdapter();
  const decoded: MtcPaloAltoDecodedRecord[] = [];
  for await (const record of adapter.decode(artifact, phaseContext())) decoded.push(record);
  return decoded;
}

async function normalizeAll(record: MtcPaloAltoDecodedRecord): Promise<CanonicalMutation[]> {
  const adapter = createMtcPaloAltoYearBuiltAdapter();
  const validated = await adapter.validate(record, phaseContext());
  if (validated.status !== 'accepted') throw new Error('Expected official row to validate');
  const mutations: CanonicalMutation[] = [];
  for await (const mutation of adapter.normalize(validated.record, phaseContext())) {
    mutations.push(canonicalMutationSchema.parse(mutation));
  }
  return mutations;
}

describe('MTC Palo Alto year-built adapter', () => {
  it('describes the official subset and keeps unknown rights non-public', () => {
    const descriptor = createMtcPaloAltoYearBuiltAdapter().describe();
    expect(descriptor).toMatchObject({
      sourceId: 'sc:source:mtc-palo-alto-year-built',
      defaultVisibility: 'prohibited_public',
      license: { redistribution: 'unknown' },
    });
    expect(descriptor.license.attribution.join(' ')).toContain('FeatureServer');
    expect(descriptor.license.limitations.join(' ')).toContain('Palo Alto subset');
  });

  it('discovers schema/count and plans stable, ordered, uncapped pages', async () => {
    const metadata = await fixture('official-metadata-excerpt.json');
    const http = new ScriptedHttp([
      response(metadata),
      response(new TextEncoder().encode('[{"count":"5"}]')),
    ]);
    const adapter = createMtcPaloAltoYearBuiltAdapter({ pageSize: 2 });
    const discovery = await adapter.discover(discoveryContext(http));
    const plan = await adapter.plan(request(), discovery, planningContext());

    expect(discovery.resources[0]).toMatchObject({
      expectedRecords: 5,
      sourceAsOf: { state: 'reported', at: SOURCE_AS_OF },
    });
    expect(plan.items.map((item) => item.requestKey)).toEqual([
      'page:0:offset:0:expected:2:asof:1783342000000',
      'page:1:offset:2:expected:2:asof:1783342000000',
      'page:2:offset:4:expected:1:asof:1783342000000',
    ]);
    expect(plan.items.every((item) => item.url.includes('%24order=objectid+ASC'))).toBe(true);
    expect(http.requests).toHaveLength(2);
  });

  it('fails discovery on required-schema or ArcGIS identity drift', async () => {
    const metadata = JSON.parse(
      new TextDecoder().decode(await fixture('official-metadata-excerpt.json')),
    ) as { columns: { fieldName: string }[] };
    metadata.columns = metadata.columns.filter((column) => column.fieldName !== 'yearbuilt');
    const http = new ScriptedHttp([response(new TextEncoder().encode(JSON.stringify(metadata)))]);
    await expect(
      createMtcPaloAltoYearBuiltAdapter().discover(discoveryContext(http)),
    ).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
  });

  it('retries thrown transport failures with bounded backoff', async () => {
    delayCalls.length = 0;
    const metadata = await fixture('official-metadata-excerpt.json');
    const http = new ScriptedHttp([
      { throws: new Error('connection reset') },
      response(metadata),
      response(new TextEncoder().encode('[{"count":"2"}]')),
    ]);

    const discovery = await createMtcPaloAltoYearBuiltAdapter().discover(discoveryContext(http));
    expect(discovery.resources[0]?.expectedRecords).toBe(2);
    expect(http.requests).toHaveLength(3);
    expect(delayCalls).toEqual([250]);

    delayCalls.length = 0;
    const exhausted = new ScriptedHttp(
      Array.from({ length: 5 }, () => ({ throws: new Error('network unavailable') })),
    );
    await expect(
      createMtcPaloAltoYearBuiltAdapter().discover(discoveryContext(exhausted)),
    ).rejects.toMatchObject({ code: 'TRANSIENT_SOURCE' });
    expect(exhausted.requests).toHaveLength(5);
    expect(delayCalls).toEqual([250, 500, 1_000, 2_000]);

    delayCalls.length = 0;
    const aborted = new ScriptedHttp([
      { throws: new DOMException('cancelled', 'AbortError') },
      response(metadata),
    ]);
    await expect(
      createMtcPaloAltoYearBuiltAdapter().discover(discoveryContext(aborted)),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted.requests).toHaveLength(1);
    expect(delayCalls).toEqual([]);

    const failFast = new ScriptedHttp([
      {
        throws: Object.assign(new Error('authentication failed'), {
          code: 'AUTHENTICATION' as const,
          retryable: false as const,
          sourceId: MTC_PALO_ALTO_SOURCE_ID,
          phase: 'discover',
        }),
      },
      response(metadata),
    ]);
    await expect(
      createMtcPaloAltoYearBuiltAdapter().discover(discoveryContext(failFast)),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION' });
    expect(failFast.requests).toHaveLength(1);
  });

  it('retries, then re-emits the committed prefix before later pages and on zero-network restart', async () => {
    delayCalls.length = 0;
    const rows = await officialRows();
    const metadata = await fixture('official-metadata-excerpt.json');
    const adapter = createMtcPaloAltoYearBuiltAdapter({ pageSize: 1 });
    const discovery = await adapter.discover(
      discoveryContext(
        new ScriptedHttp([
          response(metadata),
          response(new TextEncoder().encode('[{"count":"3"}]')),
        ]),
      ),
    );
    const plan = await adapter.plan(request(), discovery, planningContext());
    const artifacts = new TestArtifactStore();
    const checkpoints = new TestCheckpointStore();
    const firstHttp = new ScriptedHttp([
      response(new Uint8Array(), 503, { 'retry-after': '1' }),
      response(new TextEncoder().encode(JSON.stringify([rows[0]]))),
    ]);
    const acquisition = adapter.acquire(
      plan,
      undefined,
      acquisitionContext(firstHttp, artifacts, checkpoints),
    );
    const iterator = acquisition[Symbol.asyncIterator]();
    const first = await iterator.next();
    await iterator.return?.();

    expect(first.done).toBe(false);
    expect(delayCalls).toEqual([1_000]);
    expect(first.value?.metadata.request.attempt).toBe(2);
    const storedCheckpoint = [...checkpoints.values.values()][0];
    const checkpoint = sourceCheckpointSchema.parse(storedCheckpoint?.payload);
    expect(checkpoint).toMatchObject({ nextSequence: 1, complete: false });

    const resumed: AcquiredArtifactSource[] = [];
    const secondHttp = new ScriptedHttp([
      // Identical page content hashes are legal even when logical page keys differ.
      response(new TextEncoder().encode(JSON.stringify([rows[0]]))),
      response(new TextEncoder().encode(JSON.stringify([rows[1]]))),
    ]);
    const freshAdapter = createMtcPaloAltoYearBuiltAdapter({ pageSize: 1 });
    for await (const artifact of freshAdapter.acquire(
      plan,
      undefined,
      acquisitionContext(secondHttp, artifacts, checkpoints),
    )) {
      resumed.push(artifact);
    }
    expect(resumed).toHaveLength(3);
    expect(secondHttp.requests).toHaveLength(2);
    expect(resumed.map((item) => item.metadata.request.requestKey)).toEqual(
      plan.items.map((item) => item.requestKey),
    );
    expect(resumed[0]?.metadata.artifactId).toBe(resumed[1]?.metadata.artifactId);
    expect(resumed[2]?.metadata.artifactId).not.toBe(resumed[0]?.metadata.artifactId);
    const finalEnvelope = [...checkpoints.values.values()][0];
    expect(finalEnvelope?.payload).toMatchObject({
      nextSequence: 3,
      complete: true,
      acquiredArtifactIds: [resumed[0]?.metadata.artifactId, resumed[2]?.metadata.artifactId],
    });
    expect(resumed[0]?.metadata).toMatchObject({
      visibility: 'prohibited_public',
      licenseSnapshotRef: MTC_PALO_ALTO_LICENSE_SNAPSHOT_ID,
    });

    const zeroNetwork: AcquiredArtifactSource[] = [];
    const noHttp = new ScriptedHttp([]);
    for await (const artifact of freshAdapter.acquire(
      plan,
      undefined,
      acquisitionContext(noHttp, artifacts, checkpoints),
    )) {
      zeroNetwork.push(artifact);
    }
    expect(noHttp.requests).toHaveLength(0);
    expect(zeroNetwork.map((item) => item.metadata)).toEqual(resumed.map((item) => item.metadata));

    const reversedCheckpointStore = new TestCheckpointStore();
    const finalCheckpoint = sourceCheckpointSchema.parse(finalEnvelope?.payload);
    const reversedCheckpoint = sourceCheckpointSchema.parse({
      ...finalCheckpoint,
      acquiredArtifactIds: [...finalCheckpoint.acquiredArtifactIds].reverse(),
    });
    await reversedCheckpointStore.commit({
      expectedRevision: null,
      checkpoint: createCheckpointEnvelope({
        scope: finalEnvelope?.scope ?? 'missing-scope',
        previousRevision: null,
        writtenAt: reversedCheckpoint.updatedAt,
        payload: reversedCheckpoint,
      }),
    });
    const reversedHttp = new ScriptedHttp([]);
    await expect(async () => {
      for await (const artifact of freshAdapter.acquire(
        plan,
        undefined,
        acquisitionContext(reversedHttp, artifacts, reversedCheckpointStore),
      )) {
        void artifact;
      }
    }).rejects.toMatchObject({ code: 'QUERY_REGRESSION' });
    expect(reversedHttp.requests).toHaveLength(0);

    const conflictingCheckpoint = sourceCheckpointSchema.parse({
      ...checkpoint,
      nextSequence: 0,
      cursor: 'sequence:0',
    });
    await expect(async () => {
      for await (const artifact of freshAdapter.acquire(
        plan,
        conflictingCheckpoint,
        acquisitionContext(new ScriptedHttp([]), artifacts, checkpoints),
      )) {
        void artifact;
      }
    }).rejects.toMatchObject({ code: 'QUERY_REGRESSION' });
  });

  it('rejects missing/unexpected media types and corrupt artifact-store receipts', async () => {
    const rows = await officialRows();
    const metadata = await fixture('official-metadata-excerpt.json');
    const adapter = createMtcPaloAltoYearBuiltAdapter({ pageSize: 2 });
    const discovery = await adapter.discover(
      discoveryContext(
        new ScriptedHttp([
          response(metadata),
          response(new TextEncoder().encode('[{"count":"2"}]')),
        ]),
      ),
    );
    const plan = await adapter.plan(request(), discovery, planningContext());
    const pageBytes = new TextEncoder().encode(JSON.stringify(rows));
    const missingMediaResponse: HttpResponse = Object.freeze({
      status: 200,
      headers: Object.freeze({ 'last-modified': 'Mon, 06 Jul 2026 12:45:55 GMT' }),
      body: stream(pageBytes),
    });

    await expect(async () => {
      for await (const artifact of adapter.acquire(
        plan,
        undefined,
        acquisitionContext(
          new ScriptedHttp([missingMediaResponse]),
          new TestArtifactStore(),
          new TestCheckpointStore(),
        ),
      )) {
        void artifact;
      }
    }).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });

    await expect(async () => {
      for await (const artifact of adapter.acquire(
        plan,
        undefined,
        acquisitionContext(
          new ScriptedHttp([response(pageBytes, 200, { 'content-type': 'text/html' })]),
          new TestArtifactStore(),
          new TestCheckpointStore(),
        ),
      )) {
        void artifact;
      }
    }).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });

    await expect(async () => {
      for await (const artifact of adapter.acquire(
        plan,
        undefined,
        acquisitionContext(
          new ScriptedHttp([response(pageBytes)]),
          new TestArtifactStore(true),
          new TestCheckpointStore(),
        ),
      )) {
        void artifact;
      }
    }).rejects.toThrow('integrity mismatch');
  });

  it('enforces a hard byte ceiling while streaming a production page to storage', async () => {
    const rows = await officialRows();
    const metadata = await fixture('official-metadata-excerpt.json');
    const pageBytes = new TextEncoder().encode(JSON.stringify(rows));
    const adapter = createMtcPaloAltoYearBuiltAdapter({
      pageSize: 2,
      maximumResponseBytes: pageBytes.byteLength - 1,
    });
    const discovery = await adapter.discover(
      discoveryContext(
        new ScriptedHttp([
          response(metadata),
          response(new TextEncoder().encode('[{"count":"2"}]')),
        ]),
      ),
    );
    const plan = await adapter.plan(request(), discovery, planningContext());
    const consume = async (): Promise<void> => {
      for await (const artifact of adapter.acquire(
        plan,
        undefined,
        acquisitionContext(
          new ScriptedHttp([response(pageBytes)]),
          new TestArtifactStore(),
          new TestCheckpointStore(),
        ),
      ))
        void artifact;
    };
    await expect(consume()).rejects.toMatchObject({ code: 'ACQUISITION_BYTE_LIMIT' });
  });

  it('detects page-count and artifact-schema mismatches before normalization', async () => {
    const rows = await officialRows();
    await expect(async () => {
      for await (const record of createMtcPaloAltoYearBuiltAdapter().decode(
        acquiredArtifact(rows, { expectedRows: 3 }),
        phaseContext(),
      )) {
        void record;
      }
    }).rejects.toMatchObject({ code: 'QUERY_REGRESSION' });
    await expect(async () => {
      for await (const record of createMtcPaloAltoYearBuiltAdapter().decode(
        acquiredArtifact(rows, { fingerprint: 'c'.repeat(64) }),
        phaseContext(),
      )) {
        void record;
      }
    }).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
  });

  it('preserves duplicate APN source rows, both year semantics, lineage, and visibility', async () => {
    const rows = await officialRows();
    const decoded = await decodeAll(acquiredArtifact(rows));
    const first = await normalizeAll(required(decoded[0], 'first duplicate row'));
    const second = await normalizeAll(required(decoded[1], 'second duplicate row'));
    const firstEntity = first.find((mutation) => mutation.kind === 'entity_upsert');
    const secondEntity = second.find((mutation) => mutation.kind === 'entity_upsert');

    expect(decoded.map((record) => record.recordKey)).toEqual(['1124651', '1124652']);
    expect(firstEntity?.kind === 'entity_upsert' ? firstEntity.entity.id : null).toBe(
      secondEntity?.kind === 'entity_upsert' ? secondEntity.entity.id : null,
    );
    expect(first.map((mutation) => mutation.mutationId)).not.toEqual(
      second.map((mutation) => mutation.mutationId),
    );
    const observations = first.filter((mutation) => mutation.kind === 'field_observation');
    expect(observations.map((mutation) => mutation.observation.fieldPath)).toEqual(
      expect.arrayContaining([
        '/yearBuilt',
        '/effectiveYearBuilt',
        '/zoning',
        '/floodZone',
        '/nearCreek',
        '/sourceCoordinates',
        '/county',
        '/state',
        '/apn',
        '/jurisdiction',
        '/primaryAddressId',
        '/unitIds',
        '/landAreaSquareMeters',
      ]),
    );
    expect(
      observations
        .filter(({ observation }) =>
          [
            '/county',
            '/state',
            '/apn',
            '/jurisdiction',
            '/primaryAddressId',
            '/unitIds',
            '/parcelGeometry',
            '/landAreaSquareMeters',
          ].includes(observation.fieldPath),
        )
        .map(({ observation }) => observation.fieldPath),
    ).toHaveLength(8);
    expect(
      observations.every(({ observation }) =>
        observation.lineage.transformations.every(({ version }) => version === '1.1.0'),
      ),
    ).toBe(true);
    expect(
      observations.every(
        (mutation) =>
          mutation.visibility === 'prohibited_public' &&
          mutation.observation.lineage.sourceRecord.recordKey === '1124651',
      ),
    ).toBe(true);
  });

  it('uses page offsets for globally unique deterministic mutation sequences', async () => {
    const rows = await officialRows();
    const firstRow = required(rows[0], 'first official row');
    const secondRow = required(rows[1], 'second official row');
    const firstDecoded = required(
      (await decodeAll(acquiredArtifact([firstRow], { offset: 0, sequence: 0 })))[0],
      'first decoded page',
    );
    const secondDecoded = required(
      (await decodeAll(acquiredArtifact([secondRow], { offset: 1, sequence: 1 })))[0],
      'second decoded page',
    );

    expect([firstDecoded.ordinal, secondDecoded.ordinal]).toEqual([0, 1]);
    expect([firstDecoded.rawPointer, secondDecoded.rawPointer]).toEqual(['/0', '/0']);
    const firstMutations = await normalizeAll(firstDecoded);
    const secondMutations = await normalizeAll(secondDecoded);
    const sequences = [...firstMutations, ...secondMutations].map(({ sequence }) => sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(await normalizeAll(secondDecoded)).toEqual(secondMutations);
  });

  it('rejects malformed APN, missing geometry, invalid years, and out-of-subset coordinates', async () => {
    const official = required((await officialRows())[0], 'official row');
    const invalidRows = [
      { ...official, apn: 'bad' },
      { ...official, objectid: '2', the_geom: null },
      { ...official, objectid: '3', yearbuilt: '2200' },
      { ...official, objectid: '4', x: '1', y: '2' },
    ];
    const decoded = await decodeAll(acquiredArtifact(invalidRows));
    const outcomes = await Promise.all(
      decoded.map((record) => createMtcPaloAltoYearBuiltAdapter().validate(record, phaseContext())),
    );
    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true);
    expect(outcomes.flatMap((outcome) => outcome.issues.map(({ code }) => code))).toEqual(
      expect.arrayContaining([
        'INVALID_APN',
        'INVALID_GEOMETRY_OR_SUBSET',
        'INVALID_YEAR_BUILT',
        'INVALID_SOURCE_COORDINATES',
      ]),
    );
  });

  it('keeps year conflicts as distinct evidence and never upgrades water/roof claims', async () => {
    const official = required((await officialRows())[0], 'official row');
    const conflict = { ...official, yearbuilt: '2001', effectiveyearbuilt: '1998' };
    const [decoded] = await decodeAll(acquiredArtifact([conflict]));
    const outcome = await createMtcPaloAltoYearBuiltAdapter().validate(
      required(decoded, 'conflict row'),
      phaseContext(),
    );
    expect(outcome.status).toBe('accepted');
    expect(outcome.issues.map(({ code }) => code)).toContain('YEAR_SEMANTIC_CONFLICT');
    const mutations = await normalizeAll(required(decoded, 'conflict row'));
    const observations = mutations.filter((mutation) => mutation.kind === 'field_observation');
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          observation: expect.objectContaining({ fieldPath: '/yearBuilt', value: 2001 }),
        }),
        expect.objectContaining({
          observation: expect.objectContaining({ fieldPath: '/effectiveYearBuilt', value: 1998 }),
        }),
      ]),
    );
    expect(JSON.stringify(mutations)).not.toMatch(/hasWaterView|roofAgeFact/u);
  });

  it('normalizes deterministically and aborts without emitting after cancellation', async () => {
    expect(normalizeMtcPaloAltoApn('132 38 069')).toBe('132-38-069');
    expect(normalizeMtcPaloAltoApn('bad-apn')).toBeNull();
    const rows = await officialRows();
    const official = required(rows[0], 'official row');
    const [decoded] = await decodeAll(acquiredArtifact([official]));
    const normalizedRecord = required(decoded, 'decoded row');
    expect(await normalizeAll(normalizedRecord)).toEqual(await normalizeAll(normalizedRecord));

    const controller = new AbortController();
    controller.abort();
    await expect(async () => {
      for await (const record of createMtcPaloAltoYearBuiltAdapter().decode(
        acquiredArtifact([official]),
        phaseContext(controller.signal),
      )) {
        void record;
      }
    }).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reconciles summary accounting and fails closed on run count mismatch', async () => {
    const rows = await officialRows();
    const artifact = acquiredArtifact(rows);
    const decoded = await decodeAll(artifact);
    const mutations = (await Promise.all(decoded.map((record) => normalizeAll(record)))).flat();
    const adapter = createMtcPaloAltoYearBuiltAdapter({ pageSize: 2 });
    const metadata = await fixture('official-metadata-excerpt.json');
    const discovery = await adapter.discover(
      discoveryContext(
        new ScriptedHttp([
          response(metadata),
          response(new TextEncoder().encode('[{"count":"2"}]')),
        ]),
      ),
    );
    const plan = await adapter.plan(request(), discovery, planningContext());
    const finalCheckpoint: SourceCheckpoint = {
      sourceId: MTC_PALO_ALTO_SOURCE_ID,
      snapshotId: request().snapshotId,
      contractVersion: '2.0.0',
      cursor: 'sequence:1',
      nextSequence: 1,
      completedRequestKeys: [required(plan.items[0], 'first plan item').requestKey],
      acquiredArtifactIds: [artifact.metadata.artifactId],
      updatedAt: AT,
      complete: true,
    };
    const run: SourceRunObservationV2 = {
      descriptor: adapter.describe(),
      runId: RUN_ID,
      request: request(),
      plan,
      startedAt: AT,
      completedAt: AT,
      finalCheckpoint,
      artifacts: [artifact.metadata],
      decodedRecords: 2,
      acceptedRecords: 2,
      rejectedRecords: 0,
      mutations: repeatable(mutations),
      validationIssues: repeatable([]),
      aborted: false,
    };
    const summary = await adapter.summarize(run, phaseContext());
    expect(summary).toMatchObject({
      status: 'succeeded',
      decodedRecords: 2,
      acceptedRecords: 2,
      rejectedRecords: 0,
      visibilityCounts: { prohibited_public: mutations.length },
    });
    await expect(
      adapter.summarize({ ...run, decodedRecords: 1 }, phaseContext()),
    ).rejects.toThrow();
  });
});
