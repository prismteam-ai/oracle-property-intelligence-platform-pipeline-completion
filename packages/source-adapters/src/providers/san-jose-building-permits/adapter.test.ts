import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type {
  ArtifactBody,
  ArtifactStore,
  ImmutableArtifactWrite,
  StoredArtifact,
} from '@oracle/artifacts/artifact-store';
import type {
  CheckpointCommit,
  CheckpointCommitResult,
  CheckpointEnvelope,
  CheckpointStore,
  CheckpointValue,
} from '@oracle/artifacts/checkpoint-store';
import type { CanonicalMutation } from '@oracle/contracts/canonical/mutation';
import {
  artifactIdSchema,
  runIdSchema,
  schemaFingerprintValueSchema,
  snapshotIdSchema,
  sourceIdSchema,
} from '@oracle/contracts/ids';
import {
  acquiredArtifactSchema,
  acquisitionPlanSchema,
  acquisitionRequestSchema,
  sourceCheckpointSchema,
  type AcquisitionPlan,
  type SourceCheckpoint,
} from '@oracle/contracts/source';
import type {
  AnalyticalRuntime,
  AnalyticalSession,
  AnalyticalSnapshot,
} from '@oracle/data-runtime/analytical-runtime';
import { describe, expect, it } from 'vitest';

import type {
  AcquisitionContext,
  Clock,
  DecodeContext,
  Delay,
  DiscoveryContext,
  NormalizationContext,
  SourceRunObservation,
  ValidationContext,
} from '../../spi/adapter.js';
import {
  createAcquiredByteArtifact,
  type AcquiredByteArtifact,
} from '../../spi/acquired-artifact.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../../spi/http.js';
import { createSanJoseBuildingPermitAdapter, summarizeSanJoseBuildingPermits } from './adapter.js';
import {
  SAN_JOSE_BUILDING_PERMIT_LICENSE_ID,
  SAN_JOSE_BUILDING_PERMIT_SOURCE_ID,
  SAN_JOSE_CSV_HEADER,
  SAN_JOSE_FEED_CONFIG,
  SAN_JOSE_FEEDS,
  SAN_JOSE_SCHEMA_FINGERPRINT,
  sanJoseCsvUrl,
  type SanJosePermitFeed,
} from './constants.js';
import type { SanJoseDecodedPermitRecord, SanJoseValidatedPermitRecord } from './types.js';

const HASH = '4'.repeat(64);
const RUN_ID = runIdSchema.parse(`sc:run:${'5'.repeat(64)}`);
const SNAPSHOT_ID = snapshotIdSchema.parse(`sc:snapshot:san-jose-building-permits:${HASH}`);
const NOW = '2026-07-17T13:20:00.000Z';
const SOURCE_AS_OF = '2026-07-17T11:02:50.000Z';

const FIXTURE_FILE: Readonly<Record<SanJosePermitFeed, string>> = Object.freeze({
  active: 'active.csv',
  expired: 'expired.csv',
  under_inspection: 'under-inspection.csv',
});

class FixedClock implements Clock {
  public now(): string {
    return NOW;
  }
}

class RecordingDelay implements Delay {
  public readonly waits: number[] = [];

  public wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.waits.push(milliseconds);
    return Promise.resolve();
  }
}

class UnusedAnalyticalRuntime implements AnalyticalRuntime {
  public open(_snapshot: AnalyticalSnapshot, signal?: AbortSignal): Promise<AnalyticalSession> {
    signal?.throwIfAborted();
    throw new Error('Analytical runtime is not used by this adapter');
  }
}

async function collectBody(body: ArtifactBody): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    return Uint8Array.from(body);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    chunks.push(Uint8Array.from(chunk));
    size += chunk.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

class MemoryArtifactStore implements ArtifactStore {
  public readonly writes: ImmutableArtifactWrite[] = [];
  readonly #bytes = new Map<string, Uint8Array>();
  readonly #corruption: 'none' | 'sha256' | 'size';

  public constructor(corruption: 'none' | 'sha256' | 'size' = 'none') {
    this.#corruption = corruption;
  }

  public async putImmutable(request: ImmutableArtifactWrite): Promise<StoredArtifact> {
    const bytes = await collectBody(request.body);
    this.writes.push(request);
    const uri = `s3://oracle-fixtures/${encodeURIComponent(request.logicalKey)}`;
    this.#bytes.set(uri, bytes);
    return Object.freeze({
      logicalKey: request.logicalKey,
      uri,
      mediaType: request.mediaType,
      byteSize: bytes.byteLength + (this.#corruption === 'size' ? 1 : 0),
      sha256:
        this.#corruption === 'sha256'
          ? '0'.repeat(64)
          : createHash('sha256').update(bytes).digest('hex'),
      storedAt: NOW,
      metadata: request.metadata,
    });
  }

  public head(uri: string): Promise<StoredArtifact | undefined> {
    const bytes = this.#bytes.get(uri);
    return Promise.resolve(
      bytes === undefined
        ? undefined
        : Object.freeze({
            logicalKey: uri,
            uri,
            mediaType: 'text/csv',
            byteSize: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            storedAt: NOW,
            metadata: Object.freeze({}),
          }),
    );
  }

  public async *read(uri: string): AsyncIterable<Uint8Array> {
    const bytes = this.#bytes.get(uri);
    if (bytes === undefined) {
      throw new Error(`Missing ${uri}`);
    }
    await Promise.resolve();
    yield Uint8Array.from(bytes);
  }
}

class MemoryCheckpointStore implements CheckpointStore {
  public readonly commits: CheckpointEnvelope[] = [];
  #current: CheckpointEnvelope | undefined;

  public load(scope: string): Promise<CheckpointEnvelope | undefined> {
    void scope;
    return Promise.resolve(this.#current);
  }

  public commit<TPayload extends CheckpointValue>(
    request: CheckpointCommit<TPayload>,
  ): Promise<CheckpointCommitResult<TPayload>> {
    if ((this.#current?.revision ?? null) !== request.expectedRevision) {
      return Promise.resolve(Object.freeze({ status: 'conflict', current: this.#current }));
    }
    this.#current = request.checkpoint;
    this.commits.push(request.checkpoint);
    return Promise.resolve(Object.freeze({ status: 'committed', checkpoint: request.checkpoint }));
  }
}

interface ScriptedResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly bytes: Uint8Array;
}

async function* responseBody(bytes: Uint8Array, signal: AbortSignal): AsyncIterable<Uint8Array> {
  await Promise.resolve();
  const split = Math.max(1, Math.floor(bytes.byteLength / 2));
  signal.throwIfAborted();
  yield bytes.slice(0, split);
  signal.throwIfAborted();
  yield bytes.slice(split);
}

class ScriptedTransport implements HttpTransport {
  public readonly requests: HttpRequest[] = [];
  readonly #responses: ScriptedResponse[];

  public constructor(responses: readonly ScriptedResponse[]) {
    this.#responses = [...responses];
  }

  public send(request: HttpRequest, signal: AbortSignal): Promise<HttpResponse> {
    signal.throwIfAborted();
    this.requests.push(request);
    const response = this.#responses.shift();
    if (response === undefined) {
      throw new Error(`No scripted response for ${request.url}`);
    }
    return Promise.resolve(
      Object.freeze({
        status: response.status,
        headers: response.headers,
        body: responseBody(response.bytes, signal),
      }),
    );
  }
}

function adapter(expectedRecordCounts?: Readonly<Partial<Record<SanJosePermitFeed, number>>>) {
  return createSanJoseBuildingPermitAdapter({
    runId: RUN_ID,
    normalizationTimestamp: NOW,
    ...(expectedRecordCounts === undefined ? {} : { expectedRecordCounts }),
  });
}

function abortSignal(): AbortSignal {
  return new AbortController().signal;
}

const ANALYTICAL_RUNTIME = new UnusedAnalyticalRuntime();
const ARTIFACT_STORE = new MemoryArtifactStore();

function decodeContext(signal = abortSignal()): DecodeContext {
  return {
    clock: new FixedClock(),
    signal,
    artifactStore: ARTIFACT_STORE,
    analyticalRuntime: ANALYTICAL_RUNTIME,
  };
}

function normalizationContext(signal = abortSignal()): NormalizationContext {
  return { clock: new FixedClock(), signal, analyticalRuntime: ANALYTICAL_RUNTIME };
}

function validationContext(signal = abortSignal()): ValidationContext {
  return { clock: new FixedClock(), signal };
}

async function fixtureBytes(feed: SanJosePermitFeed): Promise<Uint8Array> {
  return readFile(
    new URL(
      `../../../../testkit/src/sources/san-jose-building-permits/${FIXTURE_FILE[feed]}`,
      import.meta.url,
    ),
  );
}

function acquiredArtifact(feed: SanJosePermitFeed, bytes: Uint8Array): AcquiredByteArtifact {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const metadata = acquiredArtifactSchema.parse({
    artifactId: artifactIdSchema.parse(`sc:artifact:sha256:${sha256}`),
    sourceId: SAN_JOSE_BUILDING_PERMIT_SOURCE_ID,
    snapshotId: SNAPSHOT_ID,
    retrievedAt: NOW,
    sourceAsOf: { state: 'reported', at: SOURCE_AS_OF },
    request: {
      requestKey: feed,
      method: 'GET',
      url: sanJoseCsvUrl(feed),
      headers: [{ name: 'accept', valueSha256: HASH }],
      bodySha256: null,
      attempt: 1,
    },
    response: {
      httpStatus: 200,
      etag: `"${feed}"`,
      lastModified: SOURCE_AS_OF,
      finalUrl: sanJoseCsvUrl(feed),
    },
    mediaType: 'text/csv',
    encoding: 'csv',
    byteSize: bytes.byteLength,
    sha256,
    schemaFingerprint: {
      algorithm: 'sha256',
      value: schemaFingerprintValueSchema.parse(SAN_JOSE_SCHEMA_FINGERPRINT),
      schemaName: 'city-of-san-jose-building-permits-v1',
      canonicalizationVersion: '1.0.0',
    },
    rawUri: `s3://oracle-fixtures/${feed}/${sha256}.csv`,
    licenseSnapshotRef: SAN_JOSE_BUILDING_PERMIT_LICENSE_ID,
    visibility: 'public',
  });
  return createAcquiredByteArtifact(metadata, bytes);
}

async function decodeOne(
  feed: SanJosePermitFeed,
  selectedAdapter = adapter(),
): Promise<SanJoseDecodedPermitRecord> {
  const records: SanJoseDecodedPermitRecord[] = [];
  for await (const record of selectedAdapter.decode(
    acquiredArtifact(feed, await fixtureBytes(feed)),
    decodeContext(),
  )) {
    records.push(record);
  }
  expect(records).toHaveLength(1);
  const record = records[0];
  if (record === undefined) {
    throw new Error('Expected one fixture row');
  }
  return record;
}

async function validateAccepted(
  record: SanJoseDecodedPermitRecord,
  selectedAdapter = adapter(),
): Promise<SanJoseValidatedPermitRecord> {
  const result = await selectedAdapter.validate(record, validationContext());
  expect(result.status).toBe('accepted');
  if (result.status !== 'accepted') {
    throw new Error('Expected accepted fixture');
  }
  return result.record;
}

async function mutationsFor(
  record: SanJoseValidatedPermitRecord,
  selectedAdapter = adapter(),
): Promise<readonly CanonicalMutation[]> {
  const mutations: CanonicalMutation[] = [];
  for await (const mutation of selectedAdapter.normalize(record, normalizationContext())) {
    mutations.push(mutation);
  }
  return mutations;
}

function packageMetadata(feed: SanJosePermitFeed): Uint8Array {
  const config = SAN_JOSE_FEED_CONFIG[feed];
  return new TextEncoder().encode(
    JSON.stringify({
      success: true,
      result: {
        id: config.datasetId,
        license_id: 'cc-zero',
        metadata_modified: '2026-07-17T11:02:50.000000',
        resources: [
          {
            id: config.resourceId,
            url: sanJoseCsvUrl(feed),
            last_modified: '2026-07-17T11:02:50.000000',
          },
        ],
      },
    }),
  );
}

function plan(): AcquisitionPlan {
  return acquisitionPlanSchema.parse({
    sourceId: SAN_JOSE_BUILDING_PERMIT_SOURCE_ID,
    snapshotId: SNAPSHOT_ID,
    contractVersion: '1.0.0',
    plannedAt: NOW,
    items: SAN_JOSE_FEEDS.map((feed, sequence) => ({
      requestKey: feed,
      sequence,
      method: 'GET',
      url: sanJoseCsvUrl(feed),
      encoding: 'csv',
      expectedMediaTypes: ['text/csv'],
    })),
  });
}

function acquisitionContext(
  transport: HttpTransport,
  checkpointStore: CheckpointStore,
  artifactStore: ArtifactStore,
  delay: Delay,
  signal = abortSignal(),
): AcquisitionContext {
  return {
    clock: new FixedClock(),
    signal,
    http: transport,
    artifactStore,
    checkpointStore,
    ratePolicy: adapter().describe().ratePolicy,
    delay,
  };
}

function csvResponse(bytes: Uint8Array, status = 200): ScriptedResponse {
  return Object.freeze({
    status,
    headers: Object.freeze({
      'content-type': 'text/csv; charset=utf-8',
      'last-modified': 'Fri, 17 Jul 2026 11:02:50 GMT',
      etag: '"fixture"',
    }),
    bytes,
  });
}

describe('San Jose building permit source family', () => {
  it('discovers and plans exactly the three official independently modified feeds', async () => {
    const transport = new ScriptedTransport(
      SAN_JOSE_FEEDS.map((feed) => ({
        status: 200,
        headers: Object.freeze({ 'content-type': 'application/json' }),
        bytes: packageMetadata(feed),
      })),
    );
    const delay = new RecordingDelay();
    const context: DiscoveryContext = {
      clock: new FixedClock(),
      signal: abortSignal(),
      http: transport,
      ratePolicy: adapter().describe().ratePolicy,
      delay,
    };
    const discovery = await adapter({ active: 17_724 }).discover(context);
    expect(discovery.resources.map((resource) => resource.requestKey)).toEqual(SAN_JOSE_FEEDS);
    expect(discovery.resources[0]?.expectedRecords).toBe(17_724);
    expect(discovery.resources[1]?.expectedRecords).toBeNull();

    const request = acquisitionRequestSchema.parse({
      sourceId: SAN_JOSE_BUILDING_PERMIT_SOURCE_ID,
      snapshotId: SNAPSHOT_ID,
      requestedAt: NOW,
      mode: 'full',
      requestedSourceAsOf: { state: 'reported', at: SOURCE_AS_OF },
    });
    const acquisitionPlan = await adapter().plan(request, discovery, {
      clock: new FixedClock(),
      signal: abortSignal(),
    });
    expect(acquisitionPlan.items.map((item) => item.requestKey)).toEqual(SAN_JOSE_FEEDS);
    expect(acquisitionPlan.items.map((item) => item.sequence)).toEqual([0, 1, 2]);
    expect(delay.waits).toEqual([1_000, 1_000]);

    const mismatchedDiscovery = Object.freeze({
      ...discovery,
      sourceId: sourceIdSchema.parse('sc:source:other-source'),
    });
    expect(() =>
      adapter().plan(request, mismatchedDiscovery, {
        clock: new FixedClock(),
        signal: abortSignal(),
      }),
    ).toThrow('Incomplete or mismatched discovery result');
  });

  it('attributes discovery transport failures to the discovery phase', async () => {
    const transport = new ScriptedTransport([
      { status: 401, headers: Object.freeze({}), bytes: new Uint8Array() },
    ]);
    await expect(
      adapter().discover({
        clock: new FixedClock(),
        signal: abortSignal(),
        http: transport,
        ratePolicy: adapter().describe().ratePolicy,
        delay: new RecordingDelay(),
      }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION', phase: 'discover' });
  });

  it('acquires immutable bytes in order, retries transient responses, and checkpoints each feed', async () => {
    const [active, expired, inspection] = await Promise.all(
      SAN_JOSE_FEEDS.map((feed) => fixtureBytes(feed)),
    );
    const transport = new ScriptedTransport([
      { status: 503, headers: Object.freeze({ 'retry-after': '0' }), bytes: new Uint8Array() },
      csvResponse(active ?? new Uint8Array()),
      csvResponse(expired ?? new Uint8Array()),
      csvResponse(inspection ?? new Uint8Array()),
    ]);
    const checkpoints = new MemoryCheckpointStore();
    const artifacts = new MemoryArtifactStore();
    const delay = new RecordingDelay();
    const acquired: AcquiredByteArtifact[] = [];
    for await (const artifact of adapter().acquire(
      plan(),
      undefined,
      acquisitionContext(transport, checkpoints, artifacts, delay),
    )) {
      acquired.push(artifact);
    }
    expect(acquired.map((artifact) => artifact.metadata.request.requestKey)).toEqual(
      SAN_JOSE_FEEDS,
    );
    expect(acquired[0]?.metadata.request.attempt).toBe(2);
    expect(checkpoints.commits).toHaveLength(3);
    expect(artifacts.writes).toHaveLength(3);
    expect(delay.waits[0]).toBe(0);
    expect(acquired.every((artifact) => artifact.bytes.sha256 === artifact.metadata.sha256)).toBe(
      true,
    );
  });

  it('resumes after a committed feed without reacquiring it', async () => {
    const activeArtifact = acquiredArtifact('active', await fixtureBytes('active'));
    const checkpoint: SourceCheckpoint = sourceCheckpointSchema.parse({
      sourceId: SAN_JOSE_BUILDING_PERMIT_SOURCE_ID,
      snapshotId: SNAPSHOT_ID,
      contractVersion: '1.0.0',
      cursor: 'sequence:1',
      nextSequence: 1,
      completedRequestKeys: ['active'],
      acquiredArtifactIds: [activeArtifact.metadata.artifactId],
      updatedAt: NOW,
      complete: false,
    });
    const transport = new ScriptedTransport([
      csvResponse(await fixtureBytes('expired')),
      csvResponse(await fixtureBytes('under_inspection')),
    ]);
    const resumed: string[] = [];
    for await (const artifact of adapter().acquire(
      plan(),
      checkpoint,
      acquisitionContext(
        transport,
        new MemoryCheckpointStore(),
        new MemoryArtifactStore(),
        new RecordingDelay(),
      ),
    )) {
      resumed.push(artifact.metadata.request.requestKey);
    }
    expect(resumed).toEqual(['expired', 'under_inspection']);
    expect(transport.requests.some((request) => request.url === sanJoseCsvUrl('active'))).toBe(
      false,
    );
  });

  it('resumes a fresh adapter from checkpoint-store state alone and rejects caller disagreement', async () => {
    const checkpoints = new MemoryCheckpointStore();
    const artifacts = new MemoryArtifactStore();
    const firstTransport = new ScriptedTransport([csvResponse(await fixtureBytes('active'))]);
    const firstAcquisition = adapter().acquire(
      plan(),
      undefined,
      acquisitionContext(firstTransport, checkpoints, artifacts, new RecordingDelay()),
    );
    const firstIterator = firstAcquisition[Symbol.asyncIterator]();
    const first = await firstIterator.next();
    expect(first.done).toBe(false);
    expect(first.value?.metadata.request.requestKey).toBe('active');
    await firstIterator.return?.();

    const disagreeingCheckpoint = sourceCheckpointSchema.parse({
      sourceId: SAN_JOSE_BUILDING_PERMIT_SOURCE_ID,
      snapshotId: SNAPSHOT_ID,
      contractVersion: '1.0.0',
      cursor: 'sequence:0',
      nextSequence: 0,
      completedRequestKeys: [],
      acquiredArtifactIds: [],
      updatedAt: NOW,
      complete: false,
    });
    const consumeDisagreement = async (): Promise<void> => {
      for await (const acquired of adapter().acquire(
        plan(),
        disagreeingCheckpoint,
        acquisitionContext(new ScriptedTransport([]), checkpoints, artifacts, new RecordingDelay()),
      )) {
        void acquired;
      }
    };
    await expect(consumeDisagreement()).rejects.toMatchObject({ code: 'RECONCILIATION' });

    const resumedTransport = new ScriptedTransport([
      csvResponse(await fixtureBytes('expired')),
      csvResponse(await fixtureBytes('under_inspection')),
    ]);
    const resumed: string[] = [];
    for await (const acquired of adapter().acquire(
      plan(),
      undefined,
      acquisitionContext(resumedTransport, checkpoints, artifacts, new RecordingDelay()),
    )) {
      resumed.push(acquired.metadata.request.requestKey);
    }
    expect(resumed).toEqual(['expired', 'under_inspection']);
    expect(
      resumedTransport.requests.some((request) => request.url === sanJoseCsvUrl('active')),
    ).toBe(false);
  });

  it('fails closed on missing Content-Type and incorrect immutable-store size or SHA-256', async () => {
    const active = await fixtureBytes('active');
    const consume = async (
      transport: HttpTransport,
      artifactStore: ArtifactStore,
    ): Promise<void> => {
      for await (const acquired of adapter().acquire(
        plan(),
        undefined,
        acquisitionContext(
          transport,
          new MemoryCheckpointStore(),
          artifactStore,
          new RecordingDelay(),
        ),
      )) {
        void acquired;
      }
    };

    const missingContentType = new ScriptedTransport([
      {
        status: 200,
        headers: Object.freeze({ 'last-modified': 'Fri, 17 Jul 2026 11:02:50 GMT' }),
        bytes: active,
      },
    ]);
    const missingTypeStore = new MemoryArtifactStore();
    await expect(consume(missingContentType, missingTypeStore)).rejects.toMatchObject({
      code: 'SCHEMA_DRIFT',
    });
    expect(missingTypeStore.writes).toHaveLength(0);

    for (const corruption of ['size', 'sha256'] as const) {
      await expect(
        consume(new ScriptedTransport([csvResponse(active)]), new MemoryArtifactStore(corruption)),
      ).rejects.toThrow('Immutable store verification failed for active');
    }
  });

  it('propagates abort without transport or artifact side effects', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('stop', 'AbortError'));
    const transport = new ScriptedTransport([]);
    const artifacts = new MemoryArtifactStore();
    const consume = async (): Promise<void> => {
      for await (const _artifact of adapter().acquire(
        plan(),
        undefined,
        acquisitionContext(
          transport,
          new MemoryCheckpointStore(),
          artifacts,
          new RecordingDelay(),
          controller.signal,
        ),
      )) {
        // No artifact may be emitted after abort.
        void _artifact;
      }
    };
    await expect(consume()).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport.requests).toHaveLength(0);
    expect(artifacts.writes).toHaveLength(0);
  });

  it('decodes and validates all official excerpts without collapsing feed identity', async () => {
    for (const feed of SAN_JOSE_FEEDS) {
      const decoded = await decodeOne(feed);
      const validated = await validateAccepted(decoded);
      expect(validated.raw.Status).toBe(SAN_JOSE_FEED_CONFIG[feed].status);
      expect(validated.raw.WORKDESCRIPTION).toBe('ReRoof');
      expect(validated.finaledAt).toBeNull();
      expect(validated.owner).toEqual({ classification: 'missing_or_placeholder', text: null });
    }
  });

  it('preserves duplicate permit identity across feeds while retaining distinct observations', async () => {
    const active = await mutationsFor(await validateAccepted(await decodeOne('active')));
    const inspection = await mutationsFor(
      await validateAccepted(await decodeOne('under_inspection')),
    );
    const activeEntity = active.find((mutation) => mutation.kind === 'entity_upsert');
    const inspectionEntity = inspection.find((mutation) => mutation.kind === 'entity_upsert');
    expect(activeEntity?.kind).toBe('entity_upsert');
    expect(inspectionEntity?.kind).toBe('entity_upsert');
    if (
      activeEntity?.kind !== 'entity_upsert' ||
      activeEntity.entity.entityKind !== 'permit' ||
      inspectionEntity?.kind !== 'entity_upsert' ||
      inspectionEntity.entity.entityKind !== 'permit'
    ) {
      throw new Error('Expected entity upserts');
    }
    expect(activeEntity.entity.id).toBe(inspectionEntity.entity.id);
    expect(activeEntity.entity.status).toBe('Active');
    expect(inspectionEntity.entity.status).toBe('UnderInspection');
    expect(activeEntity.entity.completedAt).toBeNull();
    expect(inspectionEntity.entity.completedAt).toBeNull();
    expect(
      active.find(
        (mutation) =>
          mutation.kind === 'field_observation' &&
          mutation.observation.fieldPath === '/source/feed_identity',
      ),
    ).toBeDefined();
  });

  it('streams quoted commas and embedded newlines without truncating work descriptions', async () => {
    const values = SAN_JOSE_CSV_HEADER.map(() => '');
    const set = (name: (typeof SAN_JOSE_CSV_HEADER)[number], value: string): void => {
      const index = SAN_JOSE_CSV_HEADER.indexOf(name);
      values[index] = value;
    };
    set('Status', 'Active');
    set('ASSESSORS_PARCEL_NUMBER', '49104040');
    set('OWNERNAME', 'NONE');
    set('FOLDERNUMBER', '2026-104199-CI');
    set('FOLDERDESC', 'Commercial/Industrial');
    set('WORKDESCRIPTION', 'Line one, exact\nLine two — retained');
    set('PERMITAPPROVALS', 'B-4. Complete, M-4. Complete');
    set('ISSUEDATE', '2/19/2026 12:00:00 AM');
    set('PERMITVALUATION', '664020');
    set('FOLDERRSN', '2172720');
    const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
    const csv = `${SAN_JOSE_CSV_HEADER.map(quote).join(',')}\n${values.map(quote).join(',')}\n`;
    const records: SanJoseDecodedPermitRecord[] = [];
    for await (const record of adapter().decode(
      acquiredArtifact('active', new TextEncoder().encode(csv)),
      decodeContext(),
    )) {
      records.push(record);
    }
    expect(records[0]?.values[SAN_JOSE_CSV_HEADER.indexOf('WORKDESCRIPTION')]).toBe(
      'Line one, exact\nLine two — retained',
    );
  });

  it('rejects invalid UTF-8, malformed CSV, schema drift, and locked count mismatch', async () => {
    const invalidUtf8 = acquiredArtifact('active', new Uint8Array([0xff, 0xfe, 0xfd]));
    const consume = async (
      selectedAdapter: ReturnType<typeof adapter>,
      artifact: AcquiredByteArtifact,
    ): Promise<void> => {
      for await (const _record of selectedAdapter.decode(artifact, decodeContext())) {
        // Consume to surface terminal validation errors.
        void _record;
      }
    };
    await expect(consume(adapter(), invalidUtf8)).rejects.toMatchObject({
      code: 'RECORD_QUALITY',
    });

    const malformed = new TextEncoder().encode(
      `${SAN_JOSE_CSV_HEADER.map((name) => `"${name}"`).join(',')}\n"Active","too-few"\n`,
    );
    await expect(consume(adapter(), acquiredArtifact('active', malformed))).rejects.toMatchObject({
      code: 'RECORD_QUALITY',
    });

    const driftedHeader: string[] = [...SAN_JOSE_CSV_HEADER];
    driftedHeader[0] = 'ChangedStatus';
    const drifted = new TextEncoder().encode(
      `${driftedHeader.map((name) => `"${name}"`).join(',')}\n`,
    );
    await expect(consume(adapter(), acquiredArtifact('active', drifted))).rejects.toMatchObject({
      code: 'SCHEMA_DRIFT',
    });

    await expect(
      consume(adapter({ active: 2 }), acquiredArtifact('active', await fixtureBytes('active'))),
    ).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
  });

  it('quarantines empty identity, malformed APN, date, and value rows with field reasons', async () => {
    const base = await decodeOne('active');
    const indexes = Object.fromEntries(SAN_JOSE_CSV_HEADER.map((name, index) => [name, index]));
    const values = [...base.values];
    values[indexes.FOLDERNUMBER ?? 0] = '';
    values[indexes.FOLDERRSN ?? 0] = '';
    values[indexes.ASSESSORS_PARCEL_NUMBER ?? 0] = 'bad-apn';
    values[indexes.ISSUEDATE ?? 0] = '2026-02-30';
    values[indexes.PERMITVALUATION ?? 0] = '9007199254740992';
    const result = await adapter().validate(
      Object.freeze({ ...base, values }),
      validationContext(),
    );
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') {
      throw new Error('Expected rejected row');
    }
    expect(result.issues.map((validationIssue) => validationIssue.code)).toEqual(
      expect.arrayContaining([
        'MISSING_PERMIT_NUMBER',
        'MISSING_SOURCE_ROW_ID',
        'MALFORMED_APN',
        'INVALID_ISSUE_DATE',
        'INVALID_VALUATION',
      ]),
    );

    const decimalValues = [...base.values];
    decimalValues[indexes.PERMITVALUATION ?? 0] = '12.34';
    const decimal = await adapter().validate(
      Object.freeze({ ...base, values: decimalValues }),
      validationContext(),
    );
    expect(decimal.status).toBe('accepted');
    if (decimal.status === 'accepted') {
      expect(decimal.record.valuation).toBe(12.34);
    }
  });

  it('emits deterministic full lineage, untruncated fields, and visibility-safe text evidence', async () => {
    const selectedAdapter = adapter();
    const validated = await validateAccepted(
      await decodeOne('expired', selectedAdapter),
      selectedAdapter,
    );
    const first = await mutationsFor(validated, selectedAdapter);
    const second = await mutationsFor(validated, selectedAdapter);
    expect(first).toEqual(second);
    expect(first).toHaveLength(18);
    expect(
      first.every((mutation) =>
        mutation.kind === 'entity_upsert'
          ? mutation.entity.lineage.length > 0
          : mutation.kind !== 'field_observation' ||
            mutation.observation.lineage.transformations.length > 0,
      ),
    ).toBe(true);
    const contractor = first.find(
      (mutation) =>
        mutation.kind === 'field_observation' &&
        mutation.observation.fieldPath === '/source/contractor_text',
    );
    expect(contractor?.visibility).toBe('authenticated');
    const owner = first.find(
      (mutation) =>
        mutation.kind === 'field_observation' &&
        mutation.observation.fieldPath === '/source/owner_text',
    );
    expect(owner?.visibility).toBe('public');
    expect(
      first.find(
        (mutation) =>
          mutation.kind === 'field_observation' &&
          mutation.observation.fieldPath === '/source/work_description',
      ),
    ).toBeDefined();
  });

  it('reconciles base and per-feed summary accounting without a countywide claim', async () => {
    const selectedAdapter = adapter();
    const artifacts = await Promise.all(
      SAN_JOSE_FEEDS.map(async (feed) => acquiredArtifact(feed, await fixtureBytes(feed)).metadata),
    );
    const mutations: CanonicalMutation[] = [];
    for (const feed of SAN_JOSE_FEEDS) {
      mutations.push(...(await mutationsFor(await validateAccepted(await decodeOne(feed)))));
    }
    const finalCheckpoint = sourceCheckpointSchema.parse({
      sourceId: SAN_JOSE_BUILDING_PERMIT_SOURCE_ID,
      snapshotId: SNAPSHOT_ID,
      contractVersion: '1.0.0',
      cursor: 'sequence:3',
      nextSequence: 3,
      completedRequestKeys: SAN_JOSE_FEEDS,
      acquiredArtifactIds: artifacts.map((artifact) => artifact.artifactId),
      updatedAt: NOW,
      complete: true,
    });
    const run: SourceRunObservation = {
      descriptor: selectedAdapter.describe(),
      runId: RUN_ID,
      request: acquisitionRequestSchema.parse({
        sourceId: SAN_JOSE_BUILDING_PERMIT_SOURCE_ID,
        snapshotId: SNAPSHOT_ID,
        requestedAt: NOW,
        mode: 'full',
        requestedSourceAsOf: { state: 'reported', at: SOURCE_AS_OF },
      }),
      plan: plan(),
      startedAt: NOW,
      completedAt: NOW,
      finalCheckpoint,
      artifacts,
      decodedRecords: 3,
      acceptedRecords: 3,
      rejectedRecords: 0,
      mutations,
      validationIssues: [],
      aborted: false,
    };
    const source = selectedAdapter.summarize(run, {
      clock: new FixedClock(),
      signal: abortSignal(),
    });
    const summary = summarizeSanJoseBuildingPermits(run, source);
    expect(source.status).toBe('succeeded');
    expect(source.decodedRecords).toBe(3);
    expect(source.acceptedRecords + source.rejectedRecords).toBe(source.decodedRecords);
    expect(summary.feedSnapshots.map((feed) => feed.acceptedRecords)).toEqual([1, 1, 1]);
    expect(summary.scope).toBe('city_of_san_jose_jurisdiction_only');
    expect(summary.limitations.join(' ')).toContain('not Santa Clara County');

    const incompleteCheckpoint = sourceCheckpointSchema.parse({
      ...finalCheckpoint,
      cursor: 'sequence:2',
      nextSequence: 2,
      completedRequestKeys: ['active', 'expired'],
      acquiredArtifactIds: artifacts.slice(0, 2).map((artifact) => artifact.artifactId),
      complete: false,
    });
    expect(
      selectedAdapter.summarize(
        { ...run, finalCheckpoint: incompleteCheckpoint },
        { clock: new FixedClock(), signal: abortSignal() },
      ).status,
    ).toBe('partial');
    expect(
      selectedAdapter.summarize(
        { ...run, artifacts: artifacts.slice(0, 2) },
        { clock: new FixedClock(), signal: abortSignal() },
      ).status,
    ).toBe('partial');
    expect(() =>
      selectedAdapter.summarize(
        { ...run, decodedRecords: 4 },
        { clock: new FixedClock(), signal: abortSignal() },
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'RECORD_QUALITY',
        phase: 'summarize',
      }),
    );
  });
});
