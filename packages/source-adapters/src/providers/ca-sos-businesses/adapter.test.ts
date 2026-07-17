import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { ArtifactStore, StoredArtifact } from '@oracle/artifacts/artifact-store';
import type { CheckpointEnvelope, CheckpointValue } from '@oracle/artifacts/checkpoint-store';
import type { CanonicalMutation } from '@oracle/contracts/canonical/mutation';
import { runIdSchema, snapshotIdSchema } from '@oracle/contracts/ids';
import { acquisitionRequestSchema, type SourceCheckpoint } from '@oracle/contracts/source';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import type {
  AcquisitionContext,
  DecodeContext,
  DiscoveryContext,
  NormalizationContext,
  PlanningContext,
  ValidationContext,
} from '../../spi/adapter.js';
import { sha256Hex } from '../../spi/bytes.js';
import type { HttpRequest, HttpResponse } from '../../spi/http.js';
import { createCaSosBusinessAdapter } from './adapter.js';
import {
  CA_SOS_BUSINESS_SOURCE_ID,
  CA_SOS_INTERCHANGE_HEADER,
  CA_SOS_SCHEMA_FINGERPRINT,
} from './constants.js';
import type {
  CaSosBusinessAdapterOptions,
  CaSosBusinessSourceLock,
  CaSosDecodedBusinessRecord,
  CaSosInterchangeColumn,
  CaSosValidatedBusinessRecord,
} from './types.js';

const SOURCE_AS_OF = '2026-07-12T00:00:00.000Z';
const FIXED_TIME = '2026-07-17T12:00:00.000Z';
const BULK_URL = 'https://bizfileonline.sos.ca.gov/api/data-request/download/business.zip';
const SNAPSHOT_ID = snapshotIdSchema.parse(`sc:snapshot:ca-sos-businesses:${'1'.repeat(64)}`);
const RUN_ID = runIdSchema.parse(`sc:run:${'2'.repeat(64)}`);
const IDENTITY_FIELD_MAPPING = Object.freeze(
  Object.fromEntries(CA_SOS_INTERCHANGE_HEADER.map((column) => [column, column])),
) as Readonly<Record<CaSosInterchangeColumn, string>>;
const IDENTITY_SOURCE_LOCK: CaSosBusinessSourceLock = Object.freeze({
  csvEntryPath: 'BusinessEntities.csv',
  orderedHeader: CA_SOS_INTERCHANGE_HEADER,
  schemaFingerprint: CA_SOS_SCHEMA_FINGERPRINT,
  fieldMapping: IDENTITY_FIELD_MAPPING,
});

function sourceLock(
  orderedHeader: readonly string[],
  fieldMapping: Readonly<Record<CaSosInterchangeColumn, string>>,
  csvEntryPath = 'BusinessEntities.csv',
): CaSosBusinessSourceLock {
  return Object.freeze({
    csvEntryPath,
    orderedHeader: Object.freeze([...orderedHeader]),
    schemaFingerprint: sha256Hex(new TextEncoder().encode(orderedHeader.join('\u001f'))),
    fieldMapping: Object.freeze({ ...fieldMapping }),
  });
}

function csvCell(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function fixturePath(): string {
  return fileURLToPath(
    new URL(
      '../../../../testkit/src/sources/ca-sos-businesses/official-bizfile-safe-excerpt.csv',
      import.meta.url,
    ),
  );
}

function zipCsv(csv: Uint8Array, path = 'BusinessEntities.csv'): Uint8Array {
  return zipSync({ [path]: csv }, { level: 6 });
}

function options(
  bytes: Uint8Array,
  expectedRecordCount = 1,
  sourceLock: CaSosBusinessSourceLock = IDENTITY_SOURCE_LOCK,
): CaSosBusinessAdapterOptions {
  return {
    runId: RUN_ID,
    normalizationTimestamp: FIXED_TIME,
    bulkArtifactUrl: BULK_URL,
    sourceAsOf: SOURCE_AS_OF,
    expectedSha256: sha256Hex(bytes),
    expectedRecordCount,
    sourceVersion: 'be-weekly-2026-07-12',
    encoding: 'zip',
    sourceLock,
    maximumBytes: 1024 * 1024,
  };
}

class FixedClock {
  public now(): string {
    return FIXED_TIME;
  }
}

class TestDelay {
  public readonly waits: number[] = [];

  public wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.waits.push(milliseconds);
    return Promise.resolve();
  }
}

function response(
  status: number,
  bytes: Uint8Array,
  headers: Readonly<Record<string, string>> = {},
): HttpResponse {
  return Object.freeze({
    status,
    headers: Object.freeze({ ...headers }),
    body: (async function* body() {
      await Promise.resolve();
      yield Uint8Array.from(bytes);
    })(),
  });
}

class ScriptedHttp {
  readonly #responses: (HttpResponse | Error)[];
  public readonly requests: HttpRequest[] = [];

  public constructor(responses: readonly (HttpResponse | Error)[]) {
    this.#responses = [...responses];
  }

  public send(request: HttpRequest, signal: AbortSignal): Promise<HttpResponse> {
    signal.throwIfAborted();
    this.requests.push(request);
    const next = this.#responses.shift();
    if (next === undefined) throw new Error('No scripted response');
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  }
}

class MemoryArtifacts implements ArtifactStore {
  readonly #values = new Map<string, Readonly<{ descriptor: StoredArtifact; bytes: Uint8Array }>>();

  public async putImmutable(request: {
    readonly logicalKey: string;
    readonly mediaType: string;
    readonly body: Uint8Array | AsyncIterable<Uint8Array>;
    readonly expectedSha256: string;
    readonly metadata: Readonly<Record<string, string>>;
    readonly ifAbsent: true;
  }) {
    if (this.#values.has(request.logicalKey)) throw new Error('duplicate artifact');
    const bytes =
      request.body instanceof Uint8Array ? request.body : await collectBytes(request.body);
    const sha256 = sha256Hex(bytes);
    if (sha256 !== request.expectedSha256) throw new Error('artifact hash mismatch');
    const descriptor = Object.freeze({
      logicalKey: request.logicalKey,
      uri: `s3://test/${encodeURIComponent(request.logicalKey)}`,
      mediaType: request.mediaType,
      byteSize: bytes.byteLength,
      sha256,
      storedAt: FIXED_TIME,
      metadata: request.metadata,
    });
    this.#values.set(request.logicalKey, { descriptor, bytes: Uint8Array.from(bytes) });
    return descriptor;
  }

  public head(uri: string) {
    const value = [...this.#values.values()].find((candidate) => candidate.descriptor.uri === uri);
    return Promise.resolve(value?.descriptor);
  }

  public async *read(uri: string): AsyncIterable<Uint8Array> {
    await Promise.resolve();
    const value = [...this.#values.values()].find((candidate) => candidate.descriptor.uri === uri);
    if (value === undefined) throw new Error('missing artifact');
    yield Uint8Array.from(value.bytes);
  }
}

class MemoryCheckpoints {
  readonly #values = new Map<string, CheckpointEnvelope>();

  public load(scope: string): Promise<CheckpointEnvelope | undefined> {
    return Promise.resolve(this.#values.get(scope));
  }

  public commit<TPayload extends CheckpointValue>(request: {
    readonly expectedRevision: string | null;
    readonly checkpoint: CheckpointEnvelope<TPayload>;
  }) {
    const current = this.#values.get(request.checkpoint.scope);
    if ((current?.revision ?? null) !== request.expectedRevision) {
      return Promise.resolve(Object.freeze({ status: 'conflict' as const, current }));
    }
    this.#values.set(request.checkpoint.scope, request.checkpoint);
    return Promise.resolve(
      Object.freeze({ status: 'committed' as const, checkpoint: request.checkpoint }),
    );
  }
}

async function collectBytes(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
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

function analyticalRuntime() {
  return {
    open: () =>
      Promise.resolve({
        execute: () =>
          Promise.resolve({ rows: [], elapsedMs: 0, scannedBytes: 0, truncated: false }),
        [Symbol.asyncDispose]: () => Promise.resolve(),
      }),
  };
}

function contexts(http: ScriptedHttp, controller = new AbortController()) {
  const clock = new FixedClock();
  const delay = new TestDelay();
  const artifacts = new MemoryArtifacts();
  const checkpoints = new MemoryCheckpoints();
  const ratePolicy = {
    maxRequestsPerWindow: 1,
    windowMs: 1_000,
    maxConcurrency: 1,
    maxAttempts: 3,
    initialBackoffMs: 250,
    maxBackoffMs: 2_000,
    jitter: 'none' as const,
    respectRetryAfter: true,
  };
  return {
    delay,
    discovery: {
      clock,
      signal: controller.signal,
      http,
      ratePolicy,
      delay,
    } satisfies DiscoveryContext,
    planning: { clock, signal: controller.signal } satisfies PlanningContext,
    acquisition: {
      clock,
      signal: controller.signal,
      http,
      ratePolicy,
      delay,
      artifactStore: artifacts,
      checkpointStore: checkpoints,
    } satisfies AcquisitionContext,
    decode: {
      clock,
      signal: controller.signal,
      artifactStore: artifacts,
      analyticalRuntime: analyticalRuntime(),
    } satisfies DecodeContext,
    validation: { clock, signal: controller.signal } satisfies ValidationContext,
    normalization: {
      clock,
      signal: controller.signal,
      analyticalRuntime: analyticalRuntime(),
    } satisfies NormalizationContext,
  };
}

async function plannedAdapter(
  bytes: Uint8Array,
  expectedCount = 1,
  sourceLock: CaSosBusinessSourceLock = IDENTITY_SOURCE_LOCK,
) {
  const adapter = createCaSosBusinessAdapter(options(bytes, expectedCount, sourceLock));
  const ctx = contexts(new ScriptedHttp([]));
  const discovery = await adapter.discover(ctx.discovery);
  const request = acquisitionRequestSchema.parse({
    sourceId: CA_SOS_BUSINESS_SOURCE_ID,
    snapshotId: SNAPSHOT_ID,
    requestedAt: FIXED_TIME,
    mode: 'full',
    requestedSourceAsOf: { state: 'reported', at: SOURCE_AS_OF },
  });
  const plan = await adapter.plan(request, discovery, ctx.planning);
  return { adapter, discovery, request, plan };
}

async function acquireOne(
  bytes: Uint8Array,
  responses?: readonly (HttpResponse | Error)[],
  sourceLock: CaSosBusinessSourceLock = IDENTITY_SOURCE_LOCK,
) {
  const planned = await plannedAdapter(bytes, 1, sourceLock);
  const http = new ScriptedHttp(
    responses ?? [response(200, bytes, { 'content-type': 'application/zip', etag: '"fixture"' })],
  );
  const ctx = contexts(http);
  const artifacts = [];
  for await (const artifact of planned.adapter.acquire(planned.plan, undefined, ctx.acquisition)) {
    artifacts.push(artifact);
  }
  const artifact = artifacts[0];
  if (artifact === undefined) throw new Error('expected artifact');
  return { ...planned, artifact, http, ctx };
}

async function decodedRecords(
  bytes: Uint8Array,
  expectedCount = 1,
  sourceLock: CaSosBusinessSourceLock = IDENTITY_SOURCE_LOCK,
) {
  const planned = await plannedAdapter(bytes, expectedCount, sourceLock);
  const http = new ScriptedHttp([
    response(200, bytes, { 'content-type': 'application/zip', etag: '"fixture"' }),
  ]);
  const ctx = contexts(http);
  const artifacts = [];
  for await (const artifact of planned.adapter.acquire(planned.plan, undefined, ctx.acquisition))
    artifacts.push(artifact);
  const records: CaSosDecodedBusinessRecord[] = [];
  const artifact = artifacts[0];
  if (artifact === undefined) throw new Error('expected artifact');
  for await (const record of planned.adapter.decode(artifact, ctx.decode)) records.push(record);
  return { ...planned, records, ctx, artifact };
}

describe('CA SOS business bulk adapter', () => {
  it('binds discovery and planning to one immutable official ordered export', async () => {
    const bytes = zipCsv(await readFile(fixturePath()));
    const { adapter, discovery, plan } = await plannedAdapter(bytes);
    expect(adapter.describe()).toMatchObject({
      sourceId: CA_SOS_BUSINESS_SOURCE_ID,
      acquisitionMethod: 'bulk_download',
      defaultVisibility: 'prohibited_public',
      authority: { authorityRank: 100 },
    });
    expect(discovery.resources).toEqual([
      expect.objectContaining({
        url: BULK_URL,
        expectedRecords: 1,
        sourceAsOf: { state: 'reported', at: SOURCE_AS_OF },
      }),
    ]);
    expect(plan.items).toEqual([
      expect.objectContaining({ requestKey: 'business-entities', sequence: 0, encoding: 'zip' }),
    ]);
    expect(discovery.limitations.join(' ')).toContain('does not search');
  });

  it('retries transient download failures, validates integrity, and resumes without duplicate effects', async () => {
    const bytes = zipCsv(await readFile(fixturePath()));
    const acquired = await acquireOne(bytes, [
      response(429, new Uint8Array(), { 'retry-after': '1' }),
      response(503, new Uint8Array()),
      response(200, bytes, { 'content-type': 'application/zip' }),
    ]);
    expect(acquired.http.requests).toHaveLength(3);
    expect(acquired.ctx.delay.waits).toEqual([1_000, 500]);
    expect(acquired.artifact.metadata.sha256).toBe(sha256Hex(bytes));
    const resumed = [];
    for await (const artifact of acquired.adapter.acquire(
      acquired.plan,
      undefined,
      acquired.ctx.acquisition,
    ))
      resumed.push(artifact);
    expect(resumed).toEqual([]);
    expect(acquired.http.requests).toHaveLength(3);
  });

  it('retries transport exceptions but propagates AbortError without retry', async () => {
    const bytes = zipCsv(await readFile(fixturePath()));
    const recovered = await acquireOne(bytes, [
      new Error('connection reset'),
      response(200, bytes, { 'content-type': 'application/zip' }),
    ]);
    expect(recovered.http.requests).toHaveLength(2);
    expect(recovered.ctx.delay.waits).toEqual([250]);

    const planned = await plannedAdapter(bytes);
    const abortError = new DOMException('transport aborted', 'AbortError');
    const abortHttp = new ScriptedHttp([
      abortError,
      response(200, bytes, { 'content-type': 'application/zip' }),
    ]);
    const abortContext = contexts(abortHttp);
    await expect(async () => {
      for await (const artifact of planned.adapter.acquire(
        planned.plan,
        undefined,
        abortContext.acquisition,
      ))
        void artifact;
    }).rejects.toBe(abortError);
    expect(abortHttp.requests).toHaveLength(1);
    expect(abortContext.delay.waits).toEqual([]);

    const exhaustedHttp = new ScriptedHttp([
      new Error('reset one'),
      new Error('reset two'),
      new Error('reset three'),
    ]);
    const exhaustedContext = contexts(exhaustedHttp);
    await expect(async () => {
      for await (const artifact of planned.adapter.acquire(
        planned.plan,
        undefined,
        exhaustedContext.acquisition,
      ))
        void artifact;
    }).rejects.toMatchObject({ code: 'TRANSIENT_SOURCE', retryable: true });
    expect(exhaustedHttp.requests).toHaveLength(3);
    expect(exhaustedContext.delay.waits).toEqual([250, 500]);
  });

  it('fails closed on hash, media type, and abort before any request', async () => {
    const bytes = zipCsv(await readFile(fixturePath()));
    const planned = await plannedAdapter(bytes);
    const wrongHttp = new ScriptedHttp([
      response(200, Uint8Array.of(1, 2, 3), { 'content-type': 'application/zip' }),
    ]);
    const wrongContext = contexts(wrongHttp);
    await expect(async () => {
      for await (const artifact of planned.adapter.acquire(
        planned.plan,
        undefined,
        wrongContext.acquisition,
      ))
        void artifact;
    }).rejects.toThrow('SHA-256 mismatch');

    const typeContext = contexts(
      new ScriptedHttp([response(200, bytes, { 'content-type': 'text/html' })]),
    );
    await expect(async () => {
      for await (const artifact of planned.adapter.acquire(
        planned.plan,
        undefined,
        typeContext.acquisition,
      ))
        void artifact;
    }).rejects.toThrow('media type');

    const controller = new AbortController();
    controller.abort(new DOMException('stop', 'AbortError'));
    const abortedHttp = new ScriptedHttp([]);
    const abortedContext = contexts(abortedHttp, controller);
    await expect(async () => {
      for await (const artifact of planned.adapter.acquire(
        planned.plan,
        undefined,
        abortedContext.acquisition,
      ))
        void artifact;
    }).rejects.toThrow();
    expect(abortedHttp.requests).toEqual([]);
  });

  it('decodes the safe official excerpt and fails on count, schema, path, and encoding drift', async () => {
    const csv = await readFile(fixturePath());
    const bytes = zipCsv(csv);
    const decoded = await decodedRecords(bytes);
    expect(decoded.records).toHaveLength(1);
    expect(decoded.records[0]?.values[0]).toBe('6195284');

    const wrongCount = await plannedAdapter(bytes, 2);
    const acquiredWrongCount = await acquireOne(bytes);
    await expect(async () => {
      for await (const record of wrongCount.adapter.decode(
        acquiredWrongCount.artifact,
        acquiredWrongCount.ctx.decode,
      ))
        void record;
    }).rejects.toThrow('record count');

    const changedHeader = new TextEncoder().encode(
      csv.toString('utf8').replace('ENTITY_NUMBER', 'ENTITY_ID'),
    );
    const changedBytes = zipCsv(changedHeader);
    const changed = await acquireOne(changedBytes);
    await expect(async () => {
      for await (const record of changed.adapter.decode(changed.artifact, changed.ctx.decode))
        void record;
    }).rejects.toThrow('header changed');

    const unsafeBytes = zipCsv(csv, '../BusinessEntities.csv');
    const unsafe = await acquireOne(unsafeBytes);
    await expect(async () => {
      for await (const record of unsafe.adapter.decode(unsafe.artifact, unsafe.ctx.decode))
        void record;
    }).rejects.toThrow('unsafe entry path');

    const multipleCsvBytes = zipSync({
      'BusinessEntities.csv': csv,
      'BusinessEntities-weekly.csv': csv,
    });
    const multipleCsv = await acquireOne(multipleCsvBytes);
    const selectedRecords = [];
    for await (const record of multipleCsv.adapter.decode(
      multipleCsv.artifact,
      multipleCsv.ctx.decode,
    ))
      selectedRecords.push(record);
    expect(selectedRecords).toHaveLength(1);

    const missingLockedEntryBytes = zipCsv(csv, 'BusinessEntities-weekly.csv');
    const missingLockedEntry = await acquireOne(missingLockedEntryBytes);
    await expect(async () => {
      for await (const record of missingLockedEntry.adapter.decode(
        missingLockedEntry.artifact,
        missingLockedEntry.ctx.decode,
      ))
        void record;
    }).rejects.toThrow('source-locked CSV entry');

    const oversizedNonCsvBytes = zipSync({
      'BusinessEntities.csv': csv,
      'ignored.bin': new Uint8Array(1024 * 1024),
    });
    const oversizedNonCsv = await acquireOne(oversizedNonCsvBytes);
    await expect(async () => {
      for await (const record of oversizedNonCsv.adapter.decode(
        oversizedNonCsv.artifact,
        oversizedNonCsv.ctx.decode,
      ))
        void record;
    }).rejects.toThrow('aggregate declared bytes');

    const malformedBytes = Uint8Array.of(80, 75, 3, 4, 0);
    const malformed = await acquireOne(malformedBytes);
    await expect(async () => {
      for await (const record of malformed.adapter.decode(malformed.artifact, malformed.ctx.decode))
        void record;
    }).rejects.toThrow('ZIP is malformed');
  });

  it('binds a renamed and reordered raw header to the frozen interchange', async () => {
    const interchangeValues: Readonly<Record<CaSosInterchangeColumn, string>> = {
      ENTITY_NUMBER: '6195284',
      PREVIOUS_ENTITY_NUMBER: '',
      ENTITY_NAME: 'INHIBRX BIOSCIENCES, INC.',
      ENTITY_TYPE: 'Stock Corporation - Out of State - Stock',
      STATUS: 'Active',
      INITIAL_FILING_DATE: '2024-03-29',
      JURISDICTION: 'DELAWARE',
      STREET_ADDRESS: '',
      MAILING_ADDRESS: '',
      AGENT_NAME: '',
      AGENT_ADDRESS: '',
      SOURCE_UPDATED_DATE: '2026-07-12',
    };
    const reordered = [...CA_SOS_INTERCHANGE_HEADER].reverse();
    const orderedHeader = reordered.map((column) => `RAW_${column}`);
    const fieldMapping = Object.freeze(
      Object.fromEntries(CA_SOS_INTERCHANGE_HEADER.map((column) => [column, `RAW_${column}`])),
    ) as Readonly<Record<CaSosInterchangeColumn, string>>;
    const rawCsv = new TextEncoder().encode(
      `${orderedHeader.join(',')}\n${reordered
        .map((column) => csvCell(interchangeValues[column]))
        .join(',')}\n`,
    );
    const bytes = zipCsv(rawCsv, 'exports/BE Master.csv');
    const lock = sourceLock(orderedHeader, fieldMapping, 'exports/BE Master.csv');
    const decoded = await decodedRecords(bytes, 1, lock);
    const record = decoded.records[0];
    if (record === undefined) throw new Error('expected mapped record');
    expect(record.header).toEqual(orderedHeader);
    const validation = await decoded.adapter.validate(record, decoded.ctx.validation);
    expect(validation).toMatchObject({
      status: 'accepted',
      record: {
        entityNumber: '6195284',
        legalName: 'INHIBRX BIOSCIENCES, INC.',
        sourceUpdatedAt: '2026-07-12T00:00:00.000Z',
      },
    });
    expect(decoded.artifact.metadata.schemaFingerprint.value).toBe(lock.schemaFingerprint);
  });

  it('rejects incomplete, unknown, duplicate, and unbound source-lock mappings', async () => {
    const bytes = zipCsv(await readFile(fixturePath()));
    const incomplete = { ...IDENTITY_FIELD_MAPPING } as Record<string, string>;
    delete incomplete.ENTITY_NAME;
    expect(() =>
      createCaSosBusinessAdapter(
        options(bytes, 1, sourceLock(CA_SOS_INTERCHANGE_HEADER, incomplete as never)),
      ),
    ).toThrow('every interchange field only');

    const unknown = { ...IDENTITY_FIELD_MAPPING, UNKNOWN_FIELD: 'ENTITY_NUMBER' };
    expect(() =>
      createCaSosBusinessAdapter(
        options(bytes, 1, sourceLock(CA_SOS_INTERCHANGE_HEADER, unknown as never)),
      ),
    ).toThrow('every interchange field only');

    const duplicate = { ...IDENTITY_FIELD_MAPPING, ENTITY_NAME: 'ENTITY_NUMBER' };
    expect(() =>
      createCaSosBusinessAdapter(
        options(bytes, 1, sourceLock(CA_SOS_INTERCHANGE_HEADER, duplicate)),
      ),
    ).toThrow('unique columns');

    const unbound = { ...IDENTITY_FIELD_MAPPING, ENTITY_NAME: 'NOT_IN_RAW_HEADER' };
    expect(() =>
      createCaSosBusinessAdapter(options(bytes, 1, sourceLock(CA_SOS_INTERCHANGE_HEADER, unbound))),
    ).toThrow('unique columns');

    expect(() =>
      createCaSosBusinessAdapter(
        options(bytes, 1, { ...IDENTITY_SOURCE_LOCK, schemaFingerprint: '0'.repeat(64) }),
      ),
    ).toThrow('does not bind orderedHeader');
  });

  it('supports legacy and new identifiers while quarantining malformed identifiers and dates', async () => {
    const csv = await readFile(fixturePath());
    const bytes = zipCsv(csv);
    const decoded = await decodedRecords(bytes);
    const record = decoded.records[0];
    if (record === undefined) throw new Error('expected record');
    const legacy = await decoded.adapter.validate(record, decoded.ctx.validation);
    expect(legacy.status).toBe('accepted');
    if (legacy.status === 'accepted') expect(legacy.record.entityNumberKind).toBe('legacy_numeric');

    const newValues = [...record.values];
    newValues[0] = 'B12345678901';
    newValues[1] = '6195284';
    const newer = await decoded.adapter.validate(
      { ...record, values: newValues, recordKey: 'new-id', recordSha256: '3'.repeat(64) },
      decoded.ctx.validation,
    );
    expect(newer.status).toBe('accepted');
    if (newer.status === 'accepted') {
      expect(newer.record.entityNumberKind).toBe('new_b_prefixed');
      expect(newer.record.previousEntityNumber).toBe('6195284');
    }

    const invalidValues = [...record.values];
    invalidValues[0] = 'B-INVALID';
    invalidValues[5] = '2026-02-30';
    invalidValues[11] = '07/17/2026';
    const invalid = await decoded.adapter.validate(
      { ...record, values: invalidValues, recordKey: 'bad', recordSha256: '4'.repeat(64) },
      decoded.ctx.validation,
    );
    expect(invalid.status).toBe('rejected');
    if (invalid.status === 'rejected') {
      expect(invalid.issues.map((entry) => entry.code)).toEqual(
        expect.arrayContaining([
          'invalid_entity_number',
          'invalid_initial_filing_date',
          'invalid_source_updated_date',
        ]),
      );
    }
  });

  it('normalizes deterministic history with complete lineage and public-visibility denial', async () => {
    const bytes = zipCsv(await readFile(fixturePath()));
    const decoded = await decodedRecords(bytes);
    const source = decoded.records[0];
    if (source === undefined) throw new Error('expected source');
    const validation = await decoded.adapter.validate(source, decoded.ctx.validation);
    if (validation.status !== 'accepted') throw new Error('expected accepted fixture');
    const normalize = async (
      record: CaSosValidatedBusinessRecord,
    ): Promise<CanonicalMutation[]> => {
      const mutations: CanonicalMutation[] = [];
      for await (const mutation of decoded.adapter.normalize(record, decoded.ctx.normalization))
        mutations.push(mutation);
      return mutations;
    };
    const first = await normalize(validation.record);
    const second = await normalize(validation.record);
    expect(first).toEqual(second);
    expect(first).toHaveLength(14);
    expect(first.every((mutation) => mutation.visibility === 'prohibited_public')).toBe(true);
    const entity = first.find((mutation) => mutation.kind === 'entity_upsert');
    expect(entity).toMatchObject({
      kind: 'entity_upsert',
      entity: {
        entityKind: 'business',
        entityNumber: '6195284',
        addressIds: [],
      },
    });
    const observations = first.filter((mutation) => mutation.kind === 'field_observation');
    expect(observations.map((mutation) => mutation.observation.fieldPath)).toEqual(
      expect.arrayContaining([
        '/sourceCapabilityType',
        '/formationOrRegistrationDate',
        '/sourceStatus',
        '/agentAddress',
        '/sourceVersion',
        '/beneficialOwnership',
      ]),
    );
    const beneficial = observations.find(
      (mutation) => mutation.observation.fieldPath === '/beneficialOwnership',
    );
    expect(beneficial).toMatchObject({
      kind: 'field_observation',
      observation: { value: null, visibility: 'prohibited_public' },
    });
    expect(
      observations.every(
        (mutation) =>
          mutation.observation.lineage.sourceRecord.recordSha256 === source.recordSha256,
      ),
    ).toBe(true);
  });

  it('balances summary accounting and rejects decoded-count drift', async () => {
    const bytes = zipCsv(await readFile(fixturePath()));
    const decoded = await decodedRecords(bytes);
    const source = decoded.records[0];
    if (source === undefined) throw new Error('expected source');
    const validation = await decoded.adapter.validate(source, decoded.ctx.validation);
    if (validation.status !== 'accepted') throw new Error('expected accepted fixture');
    const mutations: CanonicalMutation[] = [];
    for await (const mutation of decoded.adapter.normalize(
      validation.record,
      decoded.ctx.normalization,
    ))
      mutations.push(mutation);
    const checkpoint: SourceCheckpoint = {
      sourceId: CA_SOS_BUSINESS_SOURCE_ID,
      snapshotId: SNAPSHOT_ID,
      contractVersion: '1.0.0',
      cursor: 'sequence:1',
      nextSequence: 1,
      completedRequestKeys: ['business-entities'],
      acquiredArtifactIds: [decoded.artifact.metadata.artifactId],
      updatedAt: FIXED_TIME,
      complete: true,
    };
    const run = {
      descriptor: decoded.adapter.describe(),
      runId: RUN_ID,
      request: decoded.request,
      plan: decoded.plan,
      startedAt: FIXED_TIME,
      completedAt: FIXED_TIME,
      finalCheckpoint: checkpoint,
      artifacts: [decoded.artifact.metadata],
      decodedRecords: 1,
      acceptedRecords: 1,
      rejectedRecords: 0,
      mutations,
      validationIssues: [],
      aborted: false,
    } as const;
    const summaryContext = {
      clock: new FixedClock(),
      signal: new AbortController().signal,
    };
    const summary = decoded.adapter.summarize(run, summaryContext);
    expect(summary).toMatchObject({
      status: 'succeeded',
      decodedRecords: 1,
      acceptedRecords: 1,
      rejectedRecords: 0,
      normalizedMutations: 14,
      visibilityCounts: { prohibited_public: 14 },
    });
    expect(() => decoded.adapter.summarize({ ...run, decodedRecords: 2 }, summaryContext)).toThrow(
      'summary count drift',
    );
  });

  it('preserves duplicate and superseded entity identity without claiming ownership', async () => {
    const header = CA_SOS_INTERCHANGE_HEADER.join(',');
    const rows = [
      '6195284,,"INHIBRX BIOSCIENCES, INC.",Stock Corporation - Out of State - Stock,Active,2024-03-29,DELAWARE,,,,,2025-01-01',
      '6195284,,"INHIBRX BIOSCIENCES, INC.",Stock Corporation - Out of State - Stock,Suspended,2024-03-29,DELAWARE,,,,,2025-02-01',
      'B12345678901,6195284,"INHIBRX BIOSCIENCES, INC.",Stock Corporation - Out of State - Stock,Active,2024-03-29,DELAWARE,,,,,2026-01-01',
    ];
    const bytes = zipCsv(new TextEncoder().encode(`${header}\n${rows.join('\n')}\n`));
    const decoded = await decodedRecords(bytes, 3);
    const accepted: CaSosValidatedBusinessRecord[] = [];
    for (const record of decoded.records) {
      const result = await decoded.adapter.validate(record, decoded.ctx.validation);
      if (result.status === 'accepted') accepted.push(result.record);
    }
    expect(accepted).toHaveLength(3);
    const mutationSets: CanonicalMutation[][] = [];
    for (const record of accepted) {
      const mutations: CanonicalMutation[] = [];
      for await (const mutation of decoded.adapter.normalize(record, decoded.ctx.normalization))
        mutations.push(mutation);
      mutationSets.push(mutations);
    }
    const entityIds = mutationSets.map((set) => {
      const entity = set.find((mutation) => mutation.kind === 'entity_upsert');
      return entity?.kind === 'entity_upsert' ? entity.entity.id : null;
    });
    expect(entityIds[0]).toBe(entityIds[1]);
    expect(entityIds[2]).not.toBe(entityIds[0]);
    expect(
      mutationSets
        .flat()
        .some((mutation) => /beneficial owner/iu.exec(JSON.stringify(mutation)) !== null),
    ).toBe(false);
  });
});
