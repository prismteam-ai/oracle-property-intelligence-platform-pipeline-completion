import { readFile } from 'node:fs/promises';

import type {
  ArtifactBody,
  RecoverableArtifactStore,
  ImmutableArtifactWrite,
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
import {
  artifactIdSchema,
  runIdSchema,
  schemaFingerprintValueSchema,
  snapshotIdSchema,
} from '@oracle/contracts/ids';
import { acquisitionRequestSchema, sourceCheckpointSchema } from '@oracle/contracts/source';
import type {
  AnalyticalRuntime,
  AnalyticalSession,
  AnalyticalSnapshot,
} from '@oracle/data-runtime/analytical-runtime';
import { describe, expect, it } from 'vitest';

import type {
  Clock,
  Delay,
  DiscoveryContext,
  NormalizationContext,
  SourceRunObservationV2,
  StreamingAcquisitionContext,
  StreamingDecodeContext,
} from '../../spi/adapter.js';
import {
  createAcquiredByteArtifact,
  type StreamingAcquiredArtifact,
} from '../../spi/acquired-artifact.js';
import { sha256Hex } from '../../spi/bytes.js';
import { createSharedRecordBudget } from '../../spi/record-budget.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../../spi/http.js';
import { createCslbContractorAdapter } from './adapter.js';
import {
  CSLB_CONTRACTOR_LICENSE_ID,
  CSLB_CONTRACTOR_SOURCE_ID,
  CSLB_MASTER_HEADER,
  CSLB_MASTER_SCHEMA_FINGERPRINT,
  CSLB_PORTAL_URL,
} from './constants.js';
import type { CslbValidatedContractorRecord } from './types.js';

const NOW = '2026-07-17T16:30:00.000Z';
const SOURCE_AS_OF = '2026-07-17T00:00:00.000Z';
const HASH = '8'.repeat(64);
const RUN_ID = runIdSchema.parse(`sc:run:${'7'.repeat(64)}`);
const SNAPSHOT_ID = snapshotIdSchema.parse(`sc:snapshot:cslb-contractors:${HASH}`);
const INITIAL_HTML =
  '<input type="hidden" name="__VIEWSTATE" value="initial" />' +
  '<input type="hidden" name="__EVENTVALIDATION" value="validation" />';
const SELECTED_HTML =
  '<input type="hidden" name="__VIEWSTATE" value="selected" />' +
  '<input type="hidden" name="__EVENTVALIDATION" value="validation-2" />' +
  "<a href=\"javascript:__doPostBack('ctl00$MainContent$lbMasterCSV','')\">download</a>" +
  '<span>Updated as of 7/17/2026</span>';

interface SafeFixture {
  readonly records: readonly Readonly<Record<string, string>>[];
}

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
    throw new Error('CSLB adapter does not use the analytical runtime');
  }
}

async function bodyBytes(body: ArtifactBody): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return Uint8Array.from(body);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    chunks.push(Uint8Array.from(chunk));
    total += chunk.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

class MemoryArtifactStore implements RecoverableArtifactStore {
  public readonly writes: (ImmutableArtifactWrite | StreamingImmutableArtifactWrite)[] = [];
  readonly #stored = new Map<string, Readonly<{ descriptor: StoredArtifact; bytes: Uint8Array }>>();
  readonly #logical = new Map<string, string>();
  readonly #corrupt: boolean;

  public constructor(corrupt = false) {
    this.#corrupt = corrupt;
  }

  public async putImmutable(request: ImmutableArtifactWrite): Promise<StoredArtifact> {
    return this.#put(request);
  }

  public async putImmutableStreaming(
    request: StreamingImmutableArtifactWrite,
  ): Promise<StoredArtifact> {
    return this.#put(request);
  }

  async #put(request: StreamingImmutableArtifactWrite): Promise<StoredArtifact> {
    const bytes = await bodyBytes(request.body);
    this.writes.push(request);
    if (this.#corrupt) throw new Error('Immutable artifact integrity mismatch');
    const actualSha256 = sha256Hex(bytes);
    if (request.expectedSha256 !== undefined && request.expectedSha256 !== actualSha256) {
      throw new Error('test store expected hash mismatch');
    }
    const descriptor = Object.freeze({
      logicalKey: request.logicalKey,
      uri: `s3://oracle-test/${encodeURIComponent(request.logicalKey)}`,
      mediaType: request.mediaType,
      byteSize: bytes.byteLength,
      sha256: actualSha256,
      storedAt: NOW,
      metadata: request.metadata,
    });
    this.#stored.set(descriptor.uri, Object.freeze({ descriptor, bytes }));
    this.#logical.set(request.logicalKey, descriptor.uri);
    return descriptor;
  }

  public head(uri: string): Promise<StoredArtifact | undefined> {
    return Promise.resolve(this.#stored.get(uri)?.descriptor);
  }

  public headByLogicalKey(logicalKey: string): Promise<StoredArtifact | undefined> {
    const uri = this.#logical.get(logicalKey);
    return Promise.resolve(uri === undefined ? undefined : this.#stored.get(uri)?.descriptor);
  }

  public async *read(uri: string): AsyncIterable<Uint8Array> {
    await Promise.resolve();
    const stored = this.#stored.get(uri);
    if (stored === undefined) throw new Error(`Missing artifact: ${uri}`);
    yield Uint8Array.from(stored.bytes);
  }
}

class MemoryCheckpointStore implements CheckpointStore {
  readonly #values = new Map<string, CheckpointEnvelope>();

  public load(scope: string): Promise<CheckpointEnvelope | undefined> {
    return Promise.resolve(this.#values.get(scope));
  }

  public commit<TPayload extends CheckpointValue>(
    request: CheckpointCommit<TPayload>,
  ): Promise<CheckpointCommitResult<TPayload>> {
    const current = this.#values.get(request.checkpoint.scope);
    if ((current?.revision ?? null) !== request.expectedRevision) {
      return Promise.resolve(Object.freeze({ status: 'conflict', current }));
    }
    this.#values.set(request.checkpoint.scope, request.checkpoint);
    return Promise.resolve(Object.freeze({ status: 'committed', checkpoint: request.checkpoint }));
  }
}

interface ScriptedResponse {
  readonly status: number;
  readonly text: string;
  readonly headers?: Readonly<Record<string, string>>;
}

class ScriptedHttp implements HttpTransport {
  public readonly requests: HttpRequest[] = [];
  readonly #responses: ScriptedResponse[];

  public constructor(responses: readonly ScriptedResponse[]) {
    this.#responses = [...responses];
  }

  public send(request: HttpRequest, signal: AbortSignal): Promise<HttpResponse> {
    signal.throwIfAborted();
    this.requests.push(request);
    const response = this.#responses.shift();
    if (response === undefined) throw new Error('Unexpected HTTP request');
    const bytes = new TextEncoder().encode(response.text);
    return Promise.resolve(
      Object.freeze({
        status: response.status,
        headers: Object.freeze(response.headers ?? {}),
        body: (async function* body(): AsyncIterable<Uint8Array> {
          await Promise.resolve();
          signal.throwIfAborted();
          yield bytes;
        })(),
      }),
    );
  }
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function discoveryContext(http: HttpTransport, delay = new RecordingDelay()): DiscoveryContext {
  return {
    clock: new FixedClock(),
    signal: signal(),
    http,
    delay,
    ratePolicy: createCslbContractorAdapter({
      runId: RUN_ID,
      normalizationTimestamp: NOW,
    }).describe().ratePolicy,
  };
}

function acquisitionContext(
  http: HttpTransport,
  artifactStore = new MemoryArtifactStore(),
  checkpointStore = new MemoryCheckpointStore(),
  delay = new RecordingDelay(),
): StreamingAcquisitionContext {
  return {
    ...discoveryContext(http, delay),
    artifactStore,
    checkpointStore,
  };
}

function decodeContext(): StreamingDecodeContext {
  return {
    clock: new FixedClock(),
    signal: signal(),
    artifactStore: new MemoryArtifactStore(),
    analyticalRuntime: new UnusedAnalyticalRuntime(),
    recordBudget: createSharedRecordBudget(2),
  };
}

function normalizationContext(): NormalizationContext {
  return {
    clock: new FixedClock(),
    signal: signal(),
    analyticalRuntime: new UnusedAnalyticalRuntime(),
  };
}

function csvEscape(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function csvFromRecords(records: readonly Readonly<Record<string, string>>[]): string {
  const rows = records.map((record) =>
    CSLB_MASTER_HEADER.map((field) => csvEscape(record[field] ?? '')).join(','),
  );
  return `${CSLB_MASTER_HEADER.join(',')}\n${rows.join('\n')}\n`;
}

async function safeFixture(): Promise<SafeFixture> {
  const bytes = await readFile(
    new URL(
      '../../../../testkit/src/sources/cslb-contractors/official-master-safe-excerpt.json',
      import.meta.url,
    ),
  );
  return JSON.parse(bytes.toString('utf8')) as SafeFixture;
}

function acquired(
  csv: string,
  overrides?: Readonly<{ mediaType?: string; bytes?: Uint8Array }>,
): StreamingAcquiredArtifact {
  const bytes = overrides?.bytes ?? new TextEncoder().encode(csv);
  const sha256 = sha256Hex(bytes);
  const legacy = createAcquiredByteArtifact(
    {
      artifactId: artifactIdSchema.parse(`sc:artifact:sha256:${sha256}`),
      sourceId: CSLB_CONTRACTOR_SOURCE_ID,
      snapshotId: SNAPSHOT_ID,
      retrievedAt: NOW,
      sourceAsOf: {
        state: 'derived',
        at: SOURCE_AS_OF,
        basis: 'official date-only portal value',
      },
      request: {
        requestKey: 'license-master-csv',
        method: 'POST',
        url: CSLB_PORTAL_URL,
        headers: [],
        bodySha256: HASH,
        attempt: 1,
      },
      response: {
        httpStatus: 200,
        etag: null,
        lastModified: null,
        finalUrl: CSLB_PORTAL_URL,
      },
      mediaType: overrides?.mediaType ?? 'text/csv',
      encoding: 'csv',
      byteSize: bytes.byteLength,
      sha256,
      schemaFingerprint: {
        algorithm: 'sha256',
        value: schemaFingerprintValueSchema.parse(CSLB_MASTER_SCHEMA_FINGERPRINT),
        schemaName: 'cslb-license-master-csv-2026-07',
        canonicalizationVersion: '1.0.0',
      },
      rawUri: 'file://cslb-fixture/master.csv',
      licenseSnapshotRef: CSLB_CONTRACTOR_LICENSE_ID,
      visibility: 'authenticated',
    },
    bytes,
  );
  return Object.freeze({
    metadata: legacy.metadata,
    content: Object.freeze({
      formatVersion: '2.0.0' as const,
      byteLength: bytes.byteLength,
      sha256,
      rawUri: legacy.metadata.rawUri,
      read: async function* () {
        await Promise.resolve();
        yield Uint8Array.from(bytes);
      },
    }),
  });
}

function observed<T>(values: readonly T[]) {
  return Object.freeze({
    count: values.length,
    logicalSha256: sha256Hex(new TextEncoder().encode(JSON.stringify(values))),
    read: async function* () {
      await Promise.resolve();
      for (const value of values) yield value;
    },
  });
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = [];
  for await (const value of values) output.push(value);
  return output;
}

async function planFor(
  adapter = createCslbContractorAdapter({ runId: RUN_ID, normalizationTimestamp: NOW }),
) {
  const http = new ScriptedHttp([
    { status: 200, text: INITIAL_HTML, headers: { 'set-cookie': 'anon=one; Path=/; Secure' } },
    { status: 200, text: SELECTED_HTML },
  ]);
  const discovery = await adapter.discover(discoveryContext(http));
  const request = acquisitionRequestSchema.parse({
    sourceId: CSLB_CONTRACTOR_SOURCE_ID,
    snapshotId: SNAPSHOT_ID,
    requestedAt: NOW,
    mode: 'full',
    requestedSourceAsOf: discovery.resources[0]?.sourceAsOf,
  });
  const plan = await adapter.plan(request, discovery, {
    clock: new FixedClock(),
    signal: signal(),
  });
  return { discovery, plan, http };
}

describe('CSLB contractor adapter', () => {
  it('describes the official no-cost bulk route with conservative visibility and rights', () => {
    const descriptor = createCslbContractorAdapter({
      runId: RUN_ID,
      normalizationTimestamp: NOW,
    }).describe();
    expect(descriptor.sourceId).toBe(CSLB_CONTRACTOR_SOURCE_ID);
    expect(descriptor.authority.organization).toBe('California Contractors State License Board');
    expect(descriptor.authority.authorityRank).toBe(100);
    expect(descriptor.acquisitionMethod).toBe('bulk_download');
    expect(descriptor.defaultVisibility).toBe('authenticated');
    expect(descriptor.license.redistribution).toBe('unknown');
    expect(descriptor.license.containsPersonalData).toBe(true);
  });

  it('discovers exactly one terminal resource and freezes a one-file POST plan', async () => {
    const { discovery, plan, http } = await planFor();
    expect(discovery.complete).toBe(true);
    expect(discovery.resources).toHaveLength(1);
    expect(discovery.resources[0]).toMatchObject({
      requestKey: 'license-master-csv',
      expectedRecords: null,
      continuationToken: null,
      sourceAsOf: { state: 'derived', at: SOURCE_AS_OF },
    });
    expect(plan.items).toEqual([
      expect.objectContaining({ sequence: 0, method: 'POST', encoding: 'csv' }),
    ]);
    expect(http.requests).toHaveLength(2);
    expect(new TextDecoder().decode(http.requests[1]?.body)).toContain(
      'ctl00%24MainContent%24ddlStatus=M',
    );
  });

  it('forwards every comma-folded anonymous response cookie to the WebForms POST', async () => {
    const adapter = createCslbContractorAdapter({
      runId: RUN_ID,
      normalizationTimestamp: NOW,
    });
    const http = new ScriptedHttp([
      {
        status: 200,
        text: INITIAL_HTML,
        headers: {
          'set-cookie': 'anon=one; Path=/; Secure, affinity=two; Path=/; HttpOnly',
        },
      },
      { status: 200, text: SELECTED_HTML },
    ]);

    await adapter.discover(discoveryContext(http));

    expect(http.requests).toHaveLength(2);
    expect(http.requests[1]?.headers.cookie).toBe('anon=one; affinity=two');
  });

  it('retries a transient portal response, verifies immutable bytes, checkpoints, and resumes without duplication', async () => {
    const fixture = await safeFixture();
    const csv = csvFromRecords(fixture.records);
    const adapter = createCslbContractorAdapter({ runId: RUN_ID, normalizationTimestamp: NOW });
    const { plan } = await planFor(adapter);
    const delay = new RecordingDelay();
    const artifactStore = new MemoryArtifactStore();
    const checkpointStore = new MemoryCheckpointStore();
    const http = new ScriptedHttp([
      { status: 429, text: '', headers: { 'retry-after': '1' } },
      { status: 200, text: INITIAL_HTML, headers: { 'set-cookie': 'anon=two; Path=/' } },
      { status: 200, text: SELECTED_HTML },
      { status: 200, text: csv, headers: { 'content-type': 'text/csv; charset=utf-8' } },
    ]);
    const context = acquisitionContext(http, artifactStore, checkpointStore, delay);
    const artifacts = await collect(adapter.acquire(plan, undefined, context));
    expect(artifacts).toHaveLength(1);
    const acquiredArtifact = artifacts[0];
    if (acquiredArtifact?.content === undefined) throw new Error('expected streaming artifact');
    expect(acquiredArtifact.content.sha256).toBe(sha256Hex(new TextEncoder().encode(csv)));
    expect(artifactStore.writes).toHaveLength(1);
    expect(delay.waits[0]).toBe(1_000);
    expect(http.requests[1]?.headers.cookie).toBeUndefined();
    expect(http.requests[2]?.headers.cookie).toBe('anon=two');
    const resumed = await collect(adapter.acquire(plan, undefined, context));
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.metadata.sha256).toBe(acquiredArtifact.metadata.sha256);
    expect(http.requests).toHaveLength(4);

    const orphanHttp = new ScriptedHttp([]);
    const adopted = await collect(
      adapter.acquire(
        plan,
        undefined,
        acquisitionContext(orphanHttp, artifactStore, new MemoryCheckpointStore()),
      ),
    );
    expect(adopted).toHaveLength(1);
    expect(orphanHttp.requests).toEqual([]);

    await expect(
      collect(
        adapter.acquire(
          plan,
          undefined,
          acquisitionContext(new ScriptedHttp([]), new MemoryArtifactStore(), checkpointStore),
        ),
      ),
    ).rejects.toMatchObject({ code: 'RECONCILIATION' });
  });

  it('fails acquisition on immutable-store corruption, response-size overflow, and abort', async () => {
    const fixture = await safeFixture();
    const csv = csvFromRecords(fixture.records);
    const baseAdapter = createCslbContractorAdapter({ runId: RUN_ID, normalizationTimestamp: NOW });
    const { plan } = await planFor(baseAdapter);
    const scripted = () =>
      new ScriptedHttp([
        { status: 200, text: INITIAL_HTML },
        { status: 200, text: SELECTED_HTML },
        { status: 200, text: csv, headers: { 'content-type': 'text/csv' } },
      ]);
    await expect(
      collect(
        baseAdapter.acquire(
          plan,
          undefined,
          acquisitionContext(scripted(), new MemoryArtifactStore(true)),
        ),
      ),
    ).rejects.toThrow('Immutable artifact integrity mismatch');

    const limited = createCslbContractorAdapter({
      runId: RUN_ID,
      normalizationTimestamp: NOW,
      maximumArtifactBytes: 32,
    });
    await expect(
      collect(limited.acquire(plan, undefined, acquisitionContext(scripted()))),
    ).rejects.toMatchObject({ code: 'ACQUISITION_BYTE_LIMIT' });

    const controller = new AbortController();
    controller.abort(new DOMException('stop', 'AbortError'));
    await expect(
      baseAdapter.discover({
        ...discoveryContext(new ScriptedHttp([])),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('decodes the real safe excerpt and emits deterministic, authenticated lineage for all supported facts', async () => {
    const fixture = await safeFixture();
    const csv = csvFromRecords(fixture.records);
    const adapter = createCslbContractorAdapter({
      runId: RUN_ID,
      normalizationTimestamp: NOW,
      expectedRecordCount: 2,
    });
    const decoded = await collect(adapter.decode(acquired(csv), decodeContext()));
    expect(decoded).toHaveLength(2);
    const validations = await Promise.all(
      decoded.map((record) =>
        adapter.validate(record, { clock: new FixedClock(), signal: signal() }),
      ),
    );
    expect(validations.every((result) => result.status === 'accepted')).toBe(true);
    const accepted = validations.flatMap((result) =>
      result.status === 'accepted' ? [result.record] : [],
    );
    expect(accepted[1]?.classifications).toEqual(['A', 'B', 'C10', 'C36']);
    const firstAccepted = accepted[0];
    if (firstAccepted === undefined) throw new Error('Expected one accepted fixture record');

    const first = await collect(adapter.normalize(firstAccepted, normalizationContext()));
    const secondPass = await collect(adapter.normalize(firstAccepted, normalizationContext()));
    expect(first).toEqual(secondPass);
    expect(first).toHaveLength(9);
    expect(first.every((mutation) => mutation.visibility === 'authenticated')).toBe(true);
    const contractor = first.find((mutation) => mutation.kind === 'entity_upsert');
    expect(contractor).toMatchObject({
      kind: 'entity_upsert',
      entity: {
        entityKind: 'contractor',
        licenseNumber: '1000012',
        legalName: 'INSTABUILT CONSTRUCTION INC',
        status: 'CLEAR',
        classifications: ['B'],
        addressIds: [],
      },
    });
    const paths = first.flatMap((mutation) =>
      mutation.kind === 'field_observation' ? [mutation.observation.fieldPath] : [],
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        '/source/mailing_locality',
        '/source/status_history',
        '/source/classification_history',
        '/source/contractor_bond',
        '/source/workers_compensation',
        '/source/workers_bond',
        '/source/disciplinary_bond',
      ]),
    );
    expect(
      first.every(
        (mutation) =>
          mutation.kind !== 'field_observation' ||
          mutation.observation.lineage.sourceRecord.recordSha256.length === 64,
      ),
    ).toBe(true);
  });

  it('summarizes balanced visibility and reports rejected or incomplete runs as partial', async () => {
    const fixture = await safeFixture();
    const csv = csvFromRecords(fixture.records);
    const adapter = createCslbContractorAdapter({
      runId: RUN_ID,
      normalizationTimestamp: NOW,
      expectedRecordCount: 2,
    });
    const { discovery, plan } = await planFor(adapter);
    const sourceArtifact = acquired(csv);
    const decoded = await collect(adapter.decode(sourceArtifact, decodeContext()));
    const accepted: CslbValidatedContractorRecord[] = [];
    for (const row of decoded) {
      const result = await adapter.validate(row, { clock: new FixedClock(), signal: signal() });
      if (result.status === 'accepted') accepted.push(result.record);
    }
    const mutations = (
      await Promise.all(
        accepted.map((record) => collect(adapter.normalize(record, normalizationContext()))),
      )
    ).flat();
    const finalCheckpoint = sourceCheckpointSchema.parse({
      sourceId: CSLB_CONTRACTOR_SOURCE_ID,
      snapshotId: SNAPSHOT_ID,
      contractVersion: '2.0.0',
      cursor: 'sequence:1',
      nextSequence: 1,
      completedRequestKeys: ['license-master-csv'],
      acquiredArtifactIds: [sourceArtifact.metadata.artifactId],
      updatedAt: NOW,
      complete: true,
    });
    const run: SourceRunObservationV2 = {
      descriptor: adapter.describe(),
      runId: RUN_ID,
      request: acquisitionRequestSchema.parse({
        sourceId: CSLB_CONTRACTOR_SOURCE_ID,
        snapshotId: SNAPSHOT_ID,
        requestedAt: NOW,
        mode: 'full',
        requestedSourceAsOf: discovery.resources[0]?.sourceAsOf,
      }),
      plan,
      startedAt: NOW,
      completedAt: NOW,
      finalCheckpoint,
      artifacts: [sourceArtifact.metadata],
      decodedRecords: 2,
      acceptedRecords: 2,
      rejectedRecords: 0,
      mutations: observed(mutations),
      validationIssues: observed([]),
      aborted: false,
    };
    const context = { clock: new FixedClock(), signal: signal() };
    const succeeded = await adapter.summarize(run, context);
    expect(succeeded.status).toBe('succeeded');
    expect(succeeded.decodedRecords).toBe(2);
    expect(succeeded.acceptedRecords + succeeded.rejectedRecords).toBe(2);
    expect(succeeded.normalizedMutations).toBe(18);
    expect(succeeded.visibilityCounts).toEqual({
      public: 0,
      authenticated: 18,
      restricted: 0,
      prohibited_public: 0,
    });

    const rejected = await adapter.summarize(
      {
        ...run,
        acceptedRecords: 1,
        rejectedRecords: 1,
        mutations: observed(mutations.slice(0, 9)),
        validationIssues: observed([
          {
            code: 'MALFORMED_LICENSE_NUMBER',
            severity: 'error',
            message: 'License number drift',
            recordKey: 'missing-license:row:2',
            fieldPath: '/LicenseNo',
          },
        ]),
      },
      context,
    );
    expect(rejected.status).toBe('partial');
    expect(rejected.errorCount).toBe(1);
    expect(rejected.visibilityCounts.authenticated).toBe(9);

    const incompleteCheckpoint = sourceCheckpointSchema.parse({
      ...finalCheckpoint,
      cursor: 'sequence:0',
      nextSequence: 0,
      completedRequestKeys: [],
      acquiredArtifactIds: [],
      complete: false,
    });
    expect(
      (await adapter.summarize({ ...run, finalCheckpoint: incompleteCheckpoint }, context)).status,
    ).toBe('partial');
    await expect(adapter.summarize({ ...run, decodedRecords: 3 }, context)).rejects.toMatchObject({
      code: 'RECORD_QUALITY',
      phase: 'summarize',
    });
  });

  it('preserves duplicate-license status/classification observations without inventing a permit-performance link', async () => {
    const fixture = await safeFixture();
    const baseRecord = fixture.records[0];
    if (baseRecord === undefined) throw new Error('Expected a fixture record');
    const older = {
      ...baseRecord,
      LastUpdate: '07/16/2026',
      PrimaryStatus: 'SUSPENDED',
      'Classifications(s)': 'B| C10',
    };
    const newer = {
      ...baseRecord,
      LastUpdate: '07/17/2026',
      PrimaryStatus: 'CLEAR',
      'Classifications(s)': 'B',
    };
    const csv = csvFromRecords([older, newer]);
    const adapter = createCslbContractorAdapter({ runId: RUN_ID, normalizationTimestamp: NOW });
    const decoded = await collect(adapter.decode(acquired(csv), decodeContext()));
    const validated: CslbValidatedContractorRecord[] = [];
    for (const row of decoded) {
      const result = await adapter.validate(row, { clock: new FixedClock(), signal: signal() });
      if (result.status === 'accepted') validated.push(result.record);
    }
    const mutations = await Promise.all(
      validated.map((row) => collect(adapter.normalize(row, normalizationContext()))),
    );
    const ids = mutations.map((batch) => {
      const entity = batch.find((mutation) => mutation.kind === 'entity_upsert');
      return entity?.kind === 'entity_upsert' ? entity.entity.id : undefined;
    });
    expect(ids[0]).toBe(ids[1]);
    expect(mutations[0]?.map((item) => item.mutationId)).not.toEqual(
      mutations[1]?.map((item) => item.mutationId),
    );
    const statuses = mutations.map((batch) =>
      batch.find(
        (mutation) =>
          mutation.kind === 'field_observation' &&
          mutation.observation.fieldPath === '/source/status_history',
      ),
    );
    expect(statuses[0]).not.toEqual(statuses[1]);
    expect(mutations.flat().some((mutation) => mutation.kind === 'link_candidate')).toBe(false);
  });

  it('rejects malformed identifiers, classifications, and dates without losing accepted/rejected accounting', async () => {
    const fixture = await safeFixture();
    const baseRecord = fixture.records[0];
    if (baseRecord === undefined) throw new Error('Expected a fixture record');
    const malformed = [
      { ...baseRecord, LicenseNo: '10A12' },
      { ...baseRecord, 'Classifications(s)': 'B;DROP' },
      { ...baseRecord, LastUpdate: '02/30/2026' },
      { ...baseRecord, WCEffectiveDate: 'yesterday' },
    ];
    const adapter = createCslbContractorAdapter({ runId: RUN_ID, normalizationTimestamp: NOW });
    const decoded = await collect(
      adapter.decode(acquired(csvFromRecords(malformed)), decodeContext()),
    );
    const results = await Promise.all(
      decoded.map((row) => adapter.validate(row, { clock: new FixedClock(), signal: signal() })),
    );
    expect(results).toHaveLength(4);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(results.flatMap((result) => result.issues.map((item) => item.code))).toEqual(
      expect.arrayContaining([
        'MALFORMED_LICENSE_NUMBER',
        'MALFORMED_CLASSIFICATION',
        'MALFORMED_LAST_UPDATE',
        'MALFORMED_OPTIONAL_DATE',
      ]),
    );
  });

  it('fails closed on encoding, header, row-shape, and source-lock count drift', async () => {
    const fixture = await safeFixture();
    const csv = csvFromRecords(fixture.records);
    const countLocked = createCslbContractorAdapter({
      runId: RUN_ID,
      normalizationTimestamp: NOW,
      expectedRecordCount: 3,
    });
    await expect(collect(countLocked.decode(acquired(csv), decodeContext()))).rejects.toMatchObject(
      {
        code: 'SCHEMA_DRIFT',
      },
    );

    const adapter = createCslbContractorAdapter({ runId: RUN_ID, normalizationTimestamp: NOW });
    await expect(
      collect(adapter.decode(acquired(csv.replace('LicenseNo', 'LicenseNumber')), decodeContext())),
    ).rejects.toMatchObject({ code: 'SCHEMA_DRIFT' });
    await expect(
      collect(adapter.decode(acquired(`${CSLB_MASTER_HEADER.join(',')}\n1,2\n`), decodeContext())),
    ).rejects.toMatchObject({ code: 'RECORD_QUALITY' });
    await expect(
      collect(
        adapter.decode(
          acquired('', { bytes: Uint8Array.from([0xff, 0xfe, 0xfd]) }),
          decodeContext(),
        ),
      ),
    ).rejects.toMatchObject({ code: 'RECORD_QUALITY' });
  });
});
