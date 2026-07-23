import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type {
  ArtifactBody,
  ImmutableArtifactWrite,
  StreamingImmutableArtifactWrite,
  StoredArtifact,
} from '@oracle/artifacts/artifact-store';
import {
  createCheckpointEnvelope,
  type CheckpointCommit,
  type CheckpointCommitResult,
  type CheckpointEnvelope,
  type CheckpointValue,
} from '@oracle/artifacts/checkpoint-store';
import type { CanonicalMutation } from '@oracle/contracts/canonical/mutation';
import { runIdSchema } from '@oracle/contracts/ids';
import {
  acquisitionRequestSchema,
  acquiredArtifactSchema,
  sourceCheckpointSchema,
} from '@oracle/contracts/source';
import { describe, expect, it } from 'vitest';

import { createAcquiredByteArtifact } from '../../spi/acquired-artifact.js';
import type {
  DiscoveryResult,
  NormalizationContext,
  RepeatableObservationValues,
  StreamingDecodeContext,
  ValidationContext,
} from '../../spi/adapter.js';
import { sha256Hex } from '../../spi/bytes.js';
import { createSharedRecordBudget } from '../../spi/record-budget.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../../spi/http.js';
import {
  createSantaClaraSocrataParcelsAdapter,
  type SantaClaraSocrataParcelsAdapter,
} from './adapter.js';
import {
  SANTA_CLARA_PARCELS_COUNT_URLS,
  SANTA_CLARA_PARCELS_DESCRIPTOR,
  SANTA_CLARA_PARCELS_METADATA_URL,
  SANTA_CLARA_PARCELS_SCHEMA_COLUMNS,
  SANTA_CLARA_PARCELS_SCHEMA_FINGERPRINT,
} from './constants.js';
import { normalizeSantaClaraParcelApn, type SantaClaraParcelDecodedRecord } from './records.js';

const HASH = 'a'.repeat(64);
const SNAPSHOT_ID = `sc:snapshot:santa-clara-socrata-parcels:${HASH}` as const;
const RUN_ID = runIdSchema.parse(`sc:run:${'b'.repeat(64)}`);
const FIXTURE_URL = new URL(
  '../../../../testkit/src/sources/santa-clara-socrata-parcels/duplicate-apn.geojson',
  import.meta.url,
);
const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json' });
const GEOJSON_HEADERS = Object.freeze({
  'content-type': 'application/vnd.geo+json; charset=UTF-8',
  etag: '"fixture"',
  'last-modified': 'Mon, 23 Mar 2026 07:08:59 GMT',
});

interface ResponseSpec {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly bytes: Uint8Array;
}

async function* responseBody(bytes: Uint8Array, signal: AbortSignal): AsyncIterable<Uint8Array> {
  signal.throwIfAborted();
  await Promise.resolve();
  yield Uint8Array.from(bytes);
}

class RouteTransport implements HttpTransport {
  readonly #routes: Map<string, ResponseSpec[]>;
  readonly requests: HttpRequest[] = [];

  public constructor(routes: Readonly<Record<string, readonly ResponseSpec[]>>) {
    this.#routes = new Map(
      Object.entries(routes).map(([url, responses]) => [
        url,
        responses.map((response) => ({ ...response })),
      ]),
    );
  }

  public async send(request: HttpRequest, signal: AbortSignal): Promise<HttpResponse> {
    signal.throwIfAborted();
    this.requests.push(request);
    const response = this.#routes.get(request.url)?.shift();
    if (response === undefined) {
      throw new Error(`No response scripted for ${request.url}`);
    }
    return Promise.resolve({
      status: response.status,
      headers: response.headers,
      body: responseBody(response.bytes, signal),
    });
  }
}

class FixedClock {
  public now(): string {
    return '2026-07-17T13:00:00.000Z';
  }
}

class RecordingDelay {
  public readonly waits: number[] = [];

  public async wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.waits.push(milliseconds);
    await Promise.resolve();
  }
}

async function bytesFromBody(body: ArtifactBody): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    return Uint8Array.from(body);
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    chunks.push(Uint8Array.from(chunk));
  }
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

class TestArtifactStore {
  readonly #artifacts = new Map<string, { descriptor: StoredArtifact; bytes: Uint8Array }>();

  public async putImmutable(request: ImmutableArtifactWrite): Promise<StoredArtifact> {
    if (this.#artifacts.has(request.logicalKey)) {
      throw new Error(`duplicate artifact ${request.logicalKey}`);
    }
    const bytes = await bytesFromBody(request.body);
    const sha256 = sha256Hex(bytes);
    if (sha256 !== request.expectedSha256) {
      throw new Error('fixture artifact digest mismatch');
    }
    const descriptor = Object.freeze({
      logicalKey: request.logicalKey,
      uri: `s3://oracle-test/${encodeURIComponent(request.logicalKey)}`,
      mediaType: request.mediaType,
      byteSize: bytes.byteLength,
      sha256,
      storedAt: '2026-07-17T13:00:00.000Z',
      metadata: request.metadata,
    });
    this.#artifacts.set(request.logicalKey, { descriptor, bytes });
    return descriptor;
  }

  public async putImmutableStreaming(
    request: StreamingImmutableArtifactWrite,
  ): Promise<StoredArtifact> {
    const bytes = await bytesFromBody(request.body);
    const sha256 = sha256Hex(bytes);
    return this.putImmutable({
      ...request,
      body: bytes,
      expectedSha256: request.expectedSha256 ?? sha256,
    });
  }

  public async headByLogicalKey(logicalKey: string): Promise<StoredArtifact | undefined> {
    return Promise.resolve(this.#artifacts.get(logicalKey)?.descriptor);
  }

  public async head(uri: string): Promise<StoredArtifact | undefined> {
    return Promise.resolve(
      [...this.#artifacts.values()].find(({ descriptor }) => descriptor.uri === uri)?.descriptor,
    );
  }

  public async *read(uri: string): AsyncIterable<Uint8Array> {
    await Promise.resolve();
    const artifact = [...this.#artifacts.values()].find(({ descriptor }) => descriptor.uri === uri);
    if (artifact === undefined) {
      throw new Error(`missing artifact ${uri}`);
    }
    yield Uint8Array.from(artifact.bytes);
  }

  public deleteLogicalKey(logicalKey: string): void {
    this.#artifacts.delete(logicalKey);
  }
}

class TestCheckpointStore {
  readonly #values = new Map<string, CheckpointEnvelope>();

  public async load(scope: string): Promise<CheckpointEnvelope | undefined> {
    return Promise.resolve(this.#values.get(scope));
  }

  public async commit<TPayload extends CheckpointValue>(
    request: CheckpointCommit<TPayload>,
  ): Promise<CheckpointCommitResult<TPayload>> {
    const current = this.#values.get(request.checkpoint.scope);
    if ((current?.revision ?? null) !== request.expectedRevision) {
      return Promise.resolve({ status: 'conflict', current });
    }
    this.#values.set(request.checkpoint.scope, request.checkpoint);
    return Promise.resolve({ status: 'committed', checkpoint: request.checkpoint });
  }
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function success(
  bytes: Uint8Array,
  headers: Readonly<Record<string, string>> = JSON_HEADERS,
): ResponseSpec {
  return { status: 200, headers, bytes };
}

function metadata(
  columns: readonly Readonly<{
    position: number;
    fieldName: string;
    dataTypeName: string;
  }>[] = SANTA_CLARA_PARCELS_SCHEMA_COLUMNS,
): Uint8Array {
  return encodeJson({ rowsUpdatedAt: 1_774_250_320, columns });
}

function discoveryRoutes(overrides: Readonly<Record<string, readonly ResponseSpec[]>> = {}) {
  return {
    [SANTA_CLARA_PARCELS_METADATA_URL]: [success(metadata())],
    [SANTA_CLARA_PARCELS_COUNT_URLS.countyRows]: [success(encodeJson([{ count: '502789' }]))],
    [SANTA_CLARA_PARCELS_COUNT_URLS.countyDistinctApns]: [
      success(encodeJson([{ count: '495188' }])),
    ],
    [SANTA_CLARA_PARCELS_COUNT_URLS.paloAltoRows]: [success(encodeJson([{ count: '21028' }]))],
    [SANTA_CLARA_PARCELS_COUNT_URLS.paloAltoDistinctApns]: [
      success(encodeJson([{ count: '21007' }])),
    ],
    ...overrides,
  };
}

function baseContext(transport: HttpTransport, signal = new AbortController().signal) {
  return {
    http: transport,
    clock: new FixedClock(),
    signal,
    ratePolicy: SANTA_CLARA_PARCELS_DESCRIPTOR.ratePolicy,
    delay: new RecordingDelay(),
  };
}

function request(mode: 'full' | 'resume' = 'full') {
  return acquisitionRequestSchema.parse({
    sourceId: SANTA_CLARA_PARCELS_DESCRIPTOR.sourceId,
    snapshotId: SNAPSHOT_ID,
    requestedAt: '2026-07-17T13:00:00.000Z',
    mode,
    requestedSourceAsOf: { state: 'reported', at: '2026-03-23T07:08:59.000Z' },
  });
}

function discovery(expectedRecords: number): DiscoveryResult {
  return {
    sourceId: SANTA_CLARA_PARCELS_DESCRIPTOR.sourceId,
    discoveredAt: '2026-07-17T13:00:00.000Z',
    resources: [
      {
        requestKey: 'county-rows',
        url: 'https://data.sccgov.org/resource/ubcd-cewv.geojson',
        sourceAsOf: { state: 'reported', at: '2026-03-23T07:08:59.000Z' },
        expectedRecords,
        mediaTypes: ['application/vnd.geo+json'],
        continuationToken: null,
      },
      {
        requestKey: 'county-distinct-apns',
        url: SANTA_CLARA_PARCELS_COUNT_URLS.countyDistinctApns,
        sourceAsOf: { state: 'reported', at: '2026-03-23T07:08:59.000Z' },
        expectedRecords: Math.max(1, expectedRecords - 1),
        mediaTypes: ['application/json'],
        continuationToken: null,
      },
      {
        requestKey: 'palo-alto-rows',
        url: SANTA_CLARA_PARCELS_COUNT_URLS.paloAltoRows,
        sourceAsOf: { state: 'reported', at: '2026-03-23T07:08:59.000Z' },
        expectedRecords: 2,
        mediaTypes: ['application/json'],
        continuationToken: null,
      },
      {
        requestKey: 'palo-alto-distinct-apns',
        url: SANTA_CLARA_PARCELS_COUNT_URLS.paloAltoDistinctApns,
        sourceAsOf: { state: 'reported', at: '2026-03-23T07:08:59.000Z' },
        expectedRecords: 1,
        mediaTypes: ['application/json'],
        continuationToken: null,
      },
    ],
    complete: true,
    limitations: [],
  };
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) {
    result.push(value);
  }
  return result;
}

async function fixtureArtifact() {
  const bytes = new Uint8Array(await readFile(FIXTURE_URL));
  const sha256 = sha256Hex(bytes);
  const metadataValue = acquiredArtifactSchema.parse({
    artifactId: `sc:artifact:sha256:${sha256}`,
    sourceId: SANTA_CLARA_PARCELS_DESCRIPTOR.sourceId,
    snapshotId: SNAPSHOT_ID,
    retrievedAt: '2026-07-17T12:59:10.000Z',
    sourceAsOf: { state: 'reported', at: '2026-03-23T07:08:59.000Z' },
    request: {
      requestKey: 'official-duplicate-apn-excerpt',
      method: 'GET',
      url: 'https://data.sccgov.org/resource/ubcd-cewv.geojson?%24where=apn%3D%2712769001%27&%24order=objectid&%24limit=2',
      headers: [],
      bodySha256: null,
      attempt: 1,
    },
    response: {
      httpStatus: 200,
      etag: '"fixture"',
      lastModified: '2026-03-23T07:08:59.000Z',
      finalUrl:
        'https://data.sccgov.org/resource/ubcd-cewv.geojson?%24where=apn%3D%2712769001%27&%24order=objectid&%24limit=2',
    },
    mediaType: 'application/vnd.geo+json',
    encoding: 'geojson',
    byteSize: bytes.byteLength,
    sha256,
    schemaFingerprint: {
      algorithm: 'sha256',
      value: SANTA_CLARA_PARCELS_SCHEMA_FINGERPRINT,
      schemaName: 'santa-clara-socrata-parcels-ubcd-cewv',
      canonicalizationVersion: '1.0.0',
    },
    rawUri: `s3://oracle-test/${sha256}.geojson`,
    licenseSnapshotRef: SANTA_CLARA_PARCELS_DESCRIPTOR.license.licenseSnapshotId,
    visibility: 'public',
  });
  return createAcquiredByteArtifact(metadataValue, bytes);
}

function decodeContext(signal = new AbortController().signal): StreamingDecodeContext {
  return {
    clock: new FixedClock(),
    signal,
    artifactStore: new TestArtifactStore(),
    analyticalRuntime: { open: () => Promise.reject(new Error('not used')) },
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

function validationContext(signal = new AbortController().signal): ValidationContext {
  return { clock: new FixedClock(), signal };
}

function normalizationContext(signal = new AbortController().signal): NormalizationContext {
  return {
    clock: new FixedClock(),
    signal,
    analyticalRuntime: { open: () => Promise.reject(new Error('not used')) },
  };
}

async function decodedAndValidated(adapter: SantaClaraSocrataParcelsAdapter) {
  const decoded = await collect(adapter.decode(await fixtureArtifact(), decodeContext()));
  const validated = await Promise.all(
    decoded.map((record) => adapter.validate(record, validationContext())),
  );
  return {
    decoded,
    accepted: validated.map((result) => {
      if (result.status !== 'accepted') {
        throw new Error(`official fixture rejected: ${JSON.stringify(result.issues)}`);
      }
      return result.record;
    }),
  };
}

describe('Santa Clara Socrata parcel adapter', () => {
  it('normalizes APN formatting inputs without inventing malformed identifiers', () => {
    expect(normalizeSantaClaraParcelApn('127-69-001')).toBe('12769001');
    expect(normalizeSantaClaraParcelApn(' 127 69 001 ')).toBe('12769001');
    expect(normalizeSantaClaraParcelApn('12769X01')).toBeNull();
    expect(normalizeSantaClaraParcelApn('123')).toBeNull();
  });

  it('discovers the frozen schema and keeps county/subset row and APN denominators explicit', async () => {
    const transport = new RouteTransport(discoveryRoutes());
    const result = await createSantaClaraSocrataParcelsAdapter().discover(baseContext(transport));

    expect(result.complete).toBe(true);
    expect(
      result.resources.map(({ requestKey, expectedRecords }) => [requestKey, expectedRecords]),
    ).toEqual([
      ['county-rows', 502_789],
      ['county-distinct-apns', 495_188],
      ['palo-alto-rows', 21_028],
      ['palo-alto-distinct-apns', 21_007],
    ]);
    expect(result.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('separate denominators'),
        expect.stringContaining('never county completion'),
        expect.stringContaining('not a raw-row key'),
      ]),
    );
    expect(transport.requests).toHaveLength(5);
  });

  it('fails closed on schema drift and malformed count responses', async () => {
    const changedColumns = SANTA_CLARA_PARCELS_SCHEMA_COLUMNS.map((column) =>
      column.fieldName === 'apn' ? { ...column, dataTypeName: 'number' } : column,
    );
    const schemaTransport = new RouteTransport(
      discoveryRoutes({ [SANTA_CLARA_PARCELS_METADATA_URL]: [success(metadata(changedColumns))] }),
    );
    await expect(
      createSantaClaraSocrataParcelsAdapter().discover(baseContext(schemaTransport)),
    ).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });

    const countTransport = new RouteTransport(
      discoveryRoutes({
        [SANTA_CLARA_PARCELS_COUNT_URLS.countyRows]: [success(encodeJson([{ total: '502789' }]))],
      }),
    );
    await expect(
      createSantaClaraSocrataParcelsAdapter().discover(baseContext(countTransport)),
    ).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
  });

  it('plans stable objectid-ordered, uncapped pages from the measured county denominator', async () => {
    const adapter = createSantaClaraSocrataParcelsAdapter({ pageSize: 2 });
    const plan = await adapter.plan(request(), discovery(5), {
      clock: new FixedClock(),
      signal: new AbortController().signal,
    });

    expect(plan.items).toHaveLength(3);
    expect(plan.items.map((item) => item.sequence)).toEqual([0, 1, 2]);
    expect(plan.items.map((item) => new URL(item.url).searchParams.get('$offset'))).toEqual([
      '0',
      '2',
      '4',
    ]);
    expect(
      plan.items.every((item) => new URL(item.url).searchParams.get('$order') === 'objectid ASC'),
    ).toBe(true);
    expect(plan.items.map((item) => new URL(item.url).searchParams.get('$limit'))).toEqual([
      '2',
      '2',
      '1',
    ]);
  });

  it('re-emits the exact committed prefix before acquiring later pages and supports zero-network restart', async () => {
    const fixture = new Uint8Array(await readFile(FIXTURE_URL));
    const secondPageFixture = new Uint8Array(fixture.byteLength + 1);
    secondPageFixture.set(fixture);
    secondPageFixture[fixture.byteLength] = 0x20;
    const adapter = createSantaClaraSocrataParcelsAdapter({ pageSize: 2 });
    const plan = await adapter.plan(request('resume'), discovery(5), {
      clock: new FixedClock(),
      signal: new AbortController().signal,
    });
    const artifactStore = new TestArtifactStore();
    const checkpointStore = new TestCheckpointStore();
    const firstTransport = new RouteTransport({
      [plan.items[0]?.url ?? 'missing-0']: [success(fixture, GEOJSON_HEADERS)],
    });
    const firstAcquisition = adapter.acquire(plan, undefined, {
      ...baseContext(firstTransport),
      artifactStore,
      checkpointStore,
    });
    const firstIterator = firstAcquisition[Symbol.asyncIterator]();
    const first = await firstIterator.next();
    await firstIterator.return?.();
    expect(first.done).toBe(false);
    expect(first.value?.metadata.request.requestKey).toBe('page-000000');
    expect(
      sourceCheckpointSchema.parse(
        (await checkpointStore.load(`source-adapter:${plan.snapshotId}`))?.payload,
      ),
    ).toMatchObject({
      nextSequence: 1,
      completedRequestKeys: ['page-000000'],
    });

    const transport = new RouteTransport({
      // The second page deliberately has the same bytes/hash as the committed first page.
      [plan.items[1]?.url ?? 'missing-1']: [success(fixture, GEOJSON_HEADERS)],
      [plan.items[2]?.url ?? 'missing-2']: [success(secondPageFixture, GEOJSON_HEADERS)],
    });
    const context = {
      ...baseContext(transport),
      artifactStore,
      checkpointStore,
    };

    const artifacts = await collect(adapter.acquire(plan, undefined, context));
    expect(artifacts).toHaveLength(3);
    expect(artifacts.map((item) => item.metadata.request.requestKey)).toEqual([
      'page-000000',
      'page-000001',
      'page-000002',
    ]);
    expect(artifacts[0]?.metadata.artifactId).toBe(artifacts[1]?.metadata.artifactId);
    expect(transport.requests.map((item) => new URL(item.url).searchParams.get('$offset'))).toEqual(
      ['2', '4'],
    );
    const persisted = await checkpointStore.load(`source-adapter:${plan.snapshotId}`);
    expect(sourceCheckpointSchema.parse(persisted?.payload)).toMatchObject({
      complete: true,
      nextSequence: 3,
      completedRequestKeys: ['page-000000', 'page-000001', 'page-000002'],
      acquiredArtifactIds: [artifacts[0]?.metadata.artifactId, artifacts[2]?.metadata.artifactId],
    });
    const recoveredFirst = artifacts[0];
    if (recoveredFirst?.content === undefined) {
      throw new Error('expected resumed artifact');
    }
    const firstCopy = await bytesFromBody(recoveredFirst.content.read());
    firstCopy[0] = 0;
    expect(recoveredFirst.content.sha256).toBe(recoveredFirst.metadata.sha256);
    expect((await bytesFromBody(recoveredFirst.content.read()))[0]).not.toBe(0);

    const zeroNetwork = new RouteTransport({});
    const restarted = await collect(
      adapter.acquire(plan, undefined, {
        ...baseContext(zeroNetwork),
        artifactStore,
        checkpointStore,
      }),
    );
    expect(zeroNetwork.requests).toHaveLength(0);
    expect(restarted.map((item) => item.metadata)).toEqual(artifacts.map((item) => item.metadata));

    const reversedCheckpointStore = new TestCheckpointStore();
    const persistedCheckpoint = sourceCheckpointSchema.parse(persisted?.payload);
    const reversedCheckpoint = sourceCheckpointSchema.parse({
      ...persistedCheckpoint,
      acquiredArtifactIds: [...persistedCheckpoint.acquiredArtifactIds].reverse(),
    });
    const scope = `source-adapter:${plan.snapshotId}`;
    await reversedCheckpointStore.commit({
      expectedRevision: null,
      checkpoint: createCheckpointEnvelope({
        scope,
        previousRevision: null,
        writtenAt: reversedCheckpoint.updatedAt,
        payload: reversedCheckpoint,
      }),
    });
    const reversedTransport = new RouteTransport({});
    await expect(
      collect(
        adapter.acquire(plan, undefined, {
          ...baseContext(reversedTransport),
          artifactStore,
          checkpointStore: reversedCheckpointStore,
        }),
      ),
    ).rejects.toMatchObject({ code: 'RECONCILIATION' });
    expect(reversedTransport.requests).toHaveLength(0);

    artifactStore.deleteLogicalKey(
      `raw/santa-clara-socrata-parcels/${plan.snapshotId}/000000.geojson`,
    );
    await expect(
      collect(
        adapter.acquire(plan, undefined, {
          ...baseContext(new RouteTransport({})),
          artifactStore,
          checkpointStore,
        }),
      ),
    ).rejects.toMatchObject({ code: 'RECONCILIATION' });
  });

  it('retries transient pages within policy and propagates abort without another emission', async () => {
    const fixture = new Uint8Array(await readFile(FIXTURE_URL));
    const adapter = createSantaClaraSocrataParcelsAdapter({ pageSize: 2 });
    const plan = await adapter.plan(request(), discovery(2), {
      clock: new FixedClock(),
      signal: new AbortController().signal,
    });
    const transport = new RouteTransport({
      [plan.items[0]?.url ?? 'missing']: [
        { status: 503, headers: {}, bytes: new Uint8Array() },
        success(fixture, GEOJSON_HEADERS),
      ],
    });
    const delay = new RecordingDelay();
    const artifacts = await collect(
      adapter.acquire(plan, undefined, {
        ...baseContext(transport),
        delay,
        artifactStore: new TestArtifactStore(),
        checkpointStore: new TestCheckpointStore(),
      }),
    );
    expect(artifacts).toHaveLength(1);
    expect(transport.requests).toHaveLength(2);
    expect(delay.waits).toEqual([250]);

    const controller = new AbortController();
    controller.abort();
    const aborted = adapter.acquire(plan, undefined, {
      ...baseContext(new RouteTransport({}), controller.signal),
      artifactStore: new TestArtifactStore(),
      checkpointStore: new TestCheckpointStore(),
    });
    await expect(aborted[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('streams acquisition through the immutable store and enforces the configured byte ceiling', async () => {
    const fixture = new Uint8Array(await readFile(FIXTURE_URL));
    const adapter = createSantaClaraSocrataParcelsAdapter({
      pageSize: 2,
      maximumResponseBytes: fixture.byteLength - 1,
    });
    const plan = await adapter.plan(request(), discovery(2), {
      clock: new FixedClock(),
      signal: new AbortController().signal,
    });
    const transport = new RouteTransport({
      [plan.items[0]?.url ?? 'missing']: [success(fixture, GEOJSON_HEADERS)],
    });
    const consume = async (): Promise<void> => {
      for await (const artifact of adapter.acquire(plan, undefined, {
        ...baseContext(transport),
        artifactStore: new TestArtifactStore(),
        checkpointStore: new TestCheckpointStore(),
      }))
        void artifact;
    };
    await expect(consume()).rejects.toMatchObject({ code: 'ACQUISITION_BYTE_LIMIT' });
  });

  it('preserves stable source order, duplicate APNs, and distinct official geometries', async () => {
    const adapter = createSantaClaraSocrataParcelsAdapter();
    const { decoded, accepted } = await decodedAndValidated(adapter);

    expect(decoded.map((record) => record.rowKey)).toEqual(['10649', '10650']);
    expect(accepted.map((record) => record.apn)).toEqual(['12769001', '12769001']);
    expect(accepted[0]?.geometry).not.toEqual(accepted[1]?.geometry);
  });

  it('rejects malformed APNs, source row keys, CRS, coordinates, and open rings', async () => {
    const adapter = createSantaClaraSocrataParcelsAdapter();
    const { decoded } = await decodedAndValidated(adapter);
    const valid = decoded[0];
    if (valid === undefined) {
      throw new Error('expected official feature');
    }
    const malformed: SantaClaraParcelDecodedRecord = {
      ...valid,
      rowKey: 'not-an-objectid',
      crs: 'EPSG:3857',
      properties: { ...valid.properties, apn: 'bad-apn', jurisdiction: '' },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [181, 37],
              [-122, 37],
              [-122, 38],
              [181, 38],
            ],
          ],
        ],
      },
    };
    const result = await adapter.validate(malformed, validationContext());
    expect(result.status).toBe('rejected');
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'SCC_PARCELS_OBJECTID_INVALID',
        'SCC_PARCELS_APN_INVALID',
        'SCC_PARCELS_JURISDICTION_INVALID',
        'SCC_PARCELS_GEOMETRY_INVALID',
      ]),
    );

    const unsafeSequenceInput = await adapter.validate(
      { ...valid, rowKey: String(Number.MAX_SAFE_INTEGER) },
      validationContext(),
    );
    expect(unsafeSequenceInput.status).toBe('rejected');
    expect(unsafeSequenceInput.issues.map((issue) => issue.code)).toContain(
      'SCC_PARCELS_OBJECTID_INVALID',
    );
  });

  it('normalizes deterministically with complete field lineage and unchanged public visibility', async () => {
    const adapter = createSantaClaraSocrataParcelsAdapter();
    const { accepted } = await decodedAndValidated(adapter);
    const first = accepted[0];
    const second = accepted[1];
    if (first === undefined || second === undefined) {
      throw new Error('expected both official duplicate rows');
    }
    const firstRun = await collect(adapter.normalize(first, normalizationContext()));
    const repeatRun = await collect(adapter.normalize(first, normalizationContext()));
    const secondRun = await collect(adapter.normalize(second, normalizationContext()));

    expect(firstRun).toEqual(repeatRun);
    expect(firstRun.every((mutation) => mutation.visibility === 'public')).toBe(true);
    const firstEntity = firstRun.find((mutation) => mutation.kind === 'entity_upsert');
    const secondEntity = secondRun.find((mutation) => mutation.kind === 'entity_upsert');
    expect(firstEntity?.kind === 'entity_upsert' ? firstEntity.entity.id : null).toBe(
      secondEntity?.kind === 'entity_upsert' ? secondEntity.entity.id : null,
    );
    expect(
      firstEntity?.kind === 'entity_upsert' && firstEntity.entity.entityKind === 'property'
        ? firstEntity.entity.landAreaSquareMeters
        : undefined,
    ).toBeNull();
    const geometryObservation = firstRun.find(
      (mutation) =>
        mutation.kind === 'field_observation' &&
        mutation.observation.fieldPath === '/parcelGeometry',
    );
    const secondGeometryObservation = secondRun.find(
      (mutation) =>
        mutation.kind === 'field_observation' &&
        mutation.observation.fieldPath === '/parcelGeometry',
    );
    expect(geometryObservation).not.toEqual(secondGeometryObservation);
    const observationPaths = firstRun.flatMap((mutation) =>
      mutation.kind === 'field_observation' ? [mutation.observation.fieldPath] : [],
    );
    expect(observationPaths).toEqual(
      expect.arrayContaining([
        '/county',
        '/state',
        '/apn',
        '/jurisdiction',
        '/primaryAddressId',
        '/unitIds',
        '/parcelGeometry',
        '/landAreaSquareMeters',
      ]),
    );
    expect(
      firstRun.some(
        (mutation) =>
          mutation.kind === 'field_observation' && mutation.observation.fieldPath === '/source/apn',
      ),
    ).toBe(true);
    expect(
      firstRun.some(
        (mutation) =>
          mutation.kind === 'field_observation' &&
          mutation.observation.fieldPath === '/source/shape_area' &&
          mutation.observation.value === '1805.5702283133601',
      ),
    ).toBe(true);
    for (const mutation of firstRun) {
      if (mutation.kind === 'field_observation') {
        expect(mutation.observation.lineage.sourceRecord).toMatchObject({
          recordKey: '10649',
          rawPointer: '/features/0',
          artifactId: first.artifactId,
        });
        expect(mutation.observation.lineage.transformations).toHaveLength(1);
        expect(mutation.observation.lineage.transformations[0]?.version).toBe('1.1.0');
      }
    }
  });

  it('reconstructs the count from a persisted plan after restart and fails a mismatch', async () => {
    const adapter = createSantaClaraSocrataParcelsAdapter({ pageSize: 2 });
    const plan = await adapter.plan(request(), discovery(2), {
      clock: new FixedClock(),
      signal: new AbortController().signal,
    });
    const artifact = await fixtureArtifact();
    const { accepted } = await decodedAndValidated(adapter);
    const mutations: CanonicalMutation[] = [];
    const record = accepted[0];
    if (record === undefined) {
      throw new Error('expected accepted fixture row');
    }
    mutations.push(...(await collect(adapter.normalize(record, normalizationContext()))));
    const finalCheckpoint = sourceCheckpointSchema.parse({
      sourceId: plan.sourceId,
      snapshotId: plan.snapshotId,
      contractVersion: plan.contractVersion,
      cursor: 'complete',
      nextSequence: 1,
      completedRequestKeys: ['page-000000'],
      acquiredArtifactIds: [artifact.metadata.artifactId],
      updatedAt: '2026-07-17T13:05:00.000Z',
      complete: true,
    });
    const restartedAdapter = createSantaClaraSocrataParcelsAdapter();
    const summary = await restartedAdapter.summarize(
      {
        descriptor: restartedAdapter.describe(),
        runId: RUN_ID,
        request: request(),
        plan,
        startedAt: '2026-07-17T13:00:00.000Z',
        completedAt: '2026-07-17T13:05:00.000Z',
        finalCheckpoint,
        artifacts: [artifact.metadata],
        decodedRecords: 1,
        acceptedRecords: 1,
        rejectedRecords: 0,
        mutations: repeatable(mutations),
        validationIssues: repeatable([]),
        aborted: false,
      },
      { clock: new FixedClock(), signal: new AbortController().signal },
    );
    expect(summary).toMatchObject({ status: 'failed', errorCount: 1, decodedRecords: 1 });
    expect(summary.visibilityCounts.public).toBe(mutations.length);
  });

  it('binds the fixture payload hash to the recorded official excerpt', async () => {
    const fixture = await readFile(FIXTURE_URL);
    expect(createHash('sha256').update(fixture).digest('hex')).toBe(
      '5a6579c59fbe93034334ed8f4ff16b75851369b31b2bada7fcdebd7b3b2de433',
    );
  });
});
