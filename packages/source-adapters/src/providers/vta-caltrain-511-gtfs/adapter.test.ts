import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type {
  CheckpointCommit,
  CheckpointCommitResult,
  CheckpointEnvelope,
  CheckpointStore,
  CheckpointValue,
} from '@oracle/artifacts/checkpoint-store';
import { canonicalMutationSchema } from '@oracle/contracts/canonical/mutation';
import {
  artifactIdSchema,
  schemaFingerprintValueSchema,
  snapshotIdSchema,
  sourceIdSchema,
  type RunId,
} from '@oracle/contracts/ids';
import { licenseSnapshotSchema, type SourceCheckpoint } from '@oracle/contracts/source';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { createAcquiredByteArtifact } from '../../spi/acquired-artifact.js';
import { sha256Hex } from '../../spi/bytes.js';
import { createStaticGtfsAdapter } from './adapter.js';
import {
  compareTransitSnapshots,
  selectTransitSnapshot,
  validateTransitFeedFamilyConfig,
} from './family.js';
import { decodeGtfsZip } from './gtfs.js';
import { createCanonicalTransitMutations, normalizeTransitSnapshot } from './normalize.js';
import { CALTRAIN_2026_06_10_SNAPSHOT, VTA_2026_07_15_SNAPSHOT } from './snapshots.js';
import type {
  NormalizedTransitSnapshot,
  TransitFeedSnapshotConfig,
  ValidatedGtfsFeed,
} from './types.js';

type Operator = 'vta' | 'caltrain';
type Members = Readonly<Record<string, string>>;

interface OfficialExcerptFile {
  readonly vta: Readonly<{ members: Members }>;
  readonly caltrain: Readonly<{ members: Members }>;
}

const officialExcerpts: OfficialExcerptFile = JSON.parse(
  readFileSync(
    new URL(
      '../../../../testkit/src/sources/vta-caltrain-511-gtfs/official-excerpts.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

function frozenZip(members: Members): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(members).map(([name, content]) => [name, new TextEncoder().encode(content)]),
    ),
    { level: 0, mtime: new Date('1980-01-01T00:00:00.000Z') },
  );
}

function fixture(
  operator: Operator,
): Readonly<{ bytes: Uint8Array; config: TransitFeedSnapshotConfig }> {
  const source = operator === 'vta' ? VTA_2026_07_15_SNAPSHOT : CALTRAIN_2026_06_10_SNAPSHOT;
  const bytes = frozenZip(officialExcerpts[operator].members);
  return {
    bytes,
    config: Object.freeze({
      ...source,
      expectedZipSha256: sha256Hex(bytes),
      expectedZipBytes: bytes.byteLength,
    }),
  };
}

function artifactFor(bytes: Uint8Array, config: TransitFeedSnapshotConfig) {
  const sha256 = sha256Hex(bytes);
  const artifactId = artifactIdSchema.parse(`sc:artifact:sha256:${sha256}`);
  const snapshotId = snapshotIdSchema.parse(
    `sc:snapshot:${config.sourceId.replace('sc:source:', '')}:${sha256}`,
  );
  return createAcquiredByteArtifact(
    {
      artifactId,
      sourceId: config.sourceId,
      snapshotId,
      retrievedAt: config.retrievedAt,
      sourceAsOf: config.sourceAsOf,
      request: {
        requestKey: `${config.operator}-${config.role}-gtfs`,
        method: 'GET',
        url: config.url,
        headers: [],
        bodySha256: null,
        attempt: 1,
      },
      response: { httpStatus: 200, etag: null, lastModified: null, finalUrl: config.url },
      mediaType: 'application/zip',
      encoding: 'zip',
      byteSize: bytes.byteLength,
      sha256,
      schemaFingerprint: {
        algorithm: 'sha256',
        value: schemaFingerprintValueSchema.parse(
          createHash('sha256').update('fixture-schema').digest('hex'),
        ),
        schemaName: 'fixture-gtfs',
        canonicalizationVersion: '1.0.0',
      },
      rawUri: `file://fixtures/${config.operator}.zip`,
      licenseSnapshotRef: config.license.licenseSnapshotId,
      visibility: config.visibility,
    },
    bytes,
  );
}

async function validatedFixture(operator: Operator): Promise<{
  config: TransitFeedSnapshotConfig;
  artifact: ReturnType<typeof artifactFor>;
  record: ValidatedGtfsFeed;
}> {
  const { bytes, config } = fixture(operator);
  const artifact = artifactFor(bytes, config);
  const adapter = createStaticGtfsAdapter(config);
  const decoded = decodeGtfsZip(artifact);
  const validation = await adapter.validate(decoded, {
    clock: { now: () => config.retrievedAt },
    signal: new AbortController().signal,
  });
  if (validation.status !== 'accepted') throw new Error(JSON.stringify(validation.issues));
  return { config, artifact, record: validation.record };
}

class ScriptedTransport {
  public readonly requests: { url: string; headers: Readonly<Record<string, string>> }[] = [];
  public constructor(
    private readonly response: Readonly<{
      status: number;
      headers: Readonly<Record<string, string>>;
      chunks: readonly Uint8Array[];
    }>,
  ) {}
  public async send(
    request: Readonly<{ url: string; headers: Readonly<Record<string, string>> }>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    this.requests.push({ url: request.url, headers: request.headers });
    const chunks = this.response.chunks;
    return Promise.resolve({
      status: this.response.status,
      headers: this.response.headers,
      body: (async function* () {
        for (const chunk of chunks) {
          signal.throwIfAborted();
          await Promise.resolve();
          yield Uint8Array.from(chunk);
        }
      })(),
    });
  }
}

class FileArtifactStore {
  public async putImmutable(request: {
    logicalKey: string;
    mediaType: string;
    body: Uint8Array | AsyncIterable<Uint8Array>;
    expectedSha256: string;
    metadata: Readonly<Record<string, string>>;
  }) {
    const bytes = request.body instanceof Uint8Array ? request.body : new Uint8Array();
    expect(sha256Hex(bytes)).toBe(request.expectedSha256);
    return Promise.resolve({
      logicalKey: request.logicalKey,
      uri: `file://test-artifacts/${encodeURIComponent(request.logicalKey)}`,
      mediaType: request.mediaType,
      byteSize: bytes.byteLength,
      sha256: request.expectedSha256,
      storedAt: '2026-07-17T13:00:00.000Z',
      metadata: request.metadata,
    });
  }
  public async head() {
    return Promise.resolve(undefined);
  }
  public async *read(): AsyncIterable<Uint8Array> {
    await Promise.resolve();
    yield new Uint8Array();
  }
}

class MemoryCheckpointStore implements CheckpointStore {
  public value: CheckpointEnvelope | undefined;
  public async load() {
    return Promise.resolve(this.value);
  }
  public async commit<TPayload extends CheckpointValue>(
    request: CheckpointCommit<TPayload>,
  ): Promise<CheckpointCommitResult<TPayload>> {
    if ((this.value?.revision ?? null) !== request.expectedRevision) {
      return Promise.resolve({ status: 'conflict' as const, current: this.value });
    }
    this.value = request.checkpoint;
    return Promise.resolve({ status: 'committed' as const, checkpoint: request.checkpoint });
  }
}

const clock = { now: () => '2026-07-17T13:00:00.000Z' };
const delay = {
  wait: (_milliseconds: number, signal: AbortSignal) => {
    signal.throwIfAborted();
    return Promise.resolve();
  },
};
const analyticalRuntime = {} as never;

async function planFor(config: TransitFeedSnapshotConfig, signal = new AbortController().signal) {
  const adapter = createStaticGtfsAdapter(config);
  const discovery = await adapter.discover({
    clock,
    signal,
    http: {} as never,
    ratePolicy: config.ratePolicy,
    delay,
  });
  const snapshotId = snapshotIdSchema.parse(
    `sc:snapshot:${config.sourceId.replace('sc:source:', '')}:${config.expectedZipSha256}`,
  );
  const request = {
    sourceId: config.sourceId,
    snapshotId,
    requestedAt: config.retrievedAt,
    mode: 'full' as const,
    requestedSourceAsOf: config.sourceAsOf,
  };
  const plan = await adapter.plan(request, discovery, { clock, signal });
  return { adapter, request, plan };
}

describe('VTA/Caltrain direct GTFS adapter', () => {
  it.each(['vta', 'caltrain'] as const)(
    'decodes, validates and deterministically normalizes the real %s excerpt',
    async (operator) => {
      const { config, record } = await validatedFixture(operator);
      const first = normalizeTransitSnapshot(record, config);
      const second = normalizeTransitSnapshot(record, config);
      expect(second).toEqual(first);
      expect(first.selectedServiceDate).toBe('2026-07-17');
      expect(first.activeServiceIds.length).toBeGreaterThan(0);
      expect(first.eligibleDestinations.length).toBeGreaterThan(0);
      expect(first.excludedDestinations.every((stop) => stop.exclusionReasons.length > 0)).toBe(
        true,
      );
    },
  );

  it('preserves parent, entrance/platform, service and exclusion semantics for VTA', async () => {
    const { config, record } = await validatedFixture('vta');
    const snapshot = normalizeTransitSnapshot(record, config);
    expect(snapshot.stops.find((stop) => stop.stopId === 'EL_VIR')).toMatchObject({
      parentStation: 'PS_VIRG',
      locationType: 2,
      boardable: false,
    });
    expect(snapshot.stops.find((stop) => stop.stopId === '4744')).toMatchObject({
      parentStation: 'PS_VIRG',
      platformCode: '1',
    });
    expect(snapshot.eligibleDestinations.map((stop) => stop.stopId)).toContain('4736');
  });

  it('preserves Caltrain parent stations and transfers', async () => {
    const { config, record } = await validatedFixture('caltrain');
    const snapshot = normalizeTransitSnapshot(record, config);
    expect(snapshot.stops.find((stop) => stop.stopId === '70261')?.parentStation).toBe(
      'sj_diridon',
    );
    expect(snapshot.transfers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from_stop_id: '70261', to_stop_id: '70261' }),
      ]),
    );
  });

  it('applies calendar-date removals to the selected service date', async () => {
    const { config, record } = await validatedFixture('vta');
    const holiday = normalizeTransitSnapshot(record, {
      ...config,
      selectedServiceDate: '2026-06-16',
    });
    expect(holiday.activeServiceIds).not.toContain('285.2969.1');
    expect(holiday.stops.find((stop) => stop.stopId === '4736')?.exclusionReasons).toContain(
      'inactive_on_selected_service_date',
    );
  });

  it('does not treat a drop-off-only stop as a boardable destination', async () => {
    const { config, record } = await validatedFixture('vta');
    const dropOffOnlyRecord: ValidatedGtfsFeed = {
      ...record,
      stopTimes: Object.freeze(
        record.stopTimes.map((time) =>
          time.stop_id === '4736'
            ? Object.freeze({ ...time, pickup_type: '1', drop_off_type: '0' })
            : time,
        ),
      ),
    };

    const snapshot = normalizeTransitSnapshot(dropOffOnlyRecord, config);
    expect(snapshot.stops.find((stop) => stop.stopId === '4736')).toMatchObject({
      activeOnSelectedDate: true,
      pickupAllowedOnSelectedDate: false,
      dropOffAllowedOnSelectedDate: true,
      boardable: false,
      exclusionReasons: expect.arrayContaining(['pickup_forbidden']),
    });
    expect(snapshot.eligibleDestinations.map((stop) => stop.stopId)).not.toContain('4736');
  });

  it('emits only selected-date active services backed by calendar-date-only additions', async () => {
    const { config, record } = await validatedFixture('vta');
    const selectedAddition = Object.freeze({
      service_id: '285.2969.1',
      date: '20260717',
      exception_type: '1',
    });
    const exceptionOnlyRecord: ValidatedGtfsFeed = {
      ...record,
      calendars: Object.freeze([]),
      calendarDates: Object.freeze([selectedAddition]),
    };

    const activeSnapshot = normalizeTransitSnapshot(exceptionOnlyRecord, config);
    const first = createCanonicalTransitMutations(exceptionOnlyRecord, activeSnapshot, config);
    const second = createCanonicalTransitMutations(exceptionOnlyRecord, activeSnapshot, config);
    const activeServices = first.filter(
      (mutation) =>
        mutation.kind === 'entity_upsert' && mutation.entity.entityKind === 'transit-service',
    );
    expect(second).toEqual(first);
    expect(activeSnapshot.activeServiceIds).toEqual(['285.2969.1']);
    expect(activeServices).toHaveLength(1);
    expect(
      activeServices[0]?.kind === 'entity_upsert' ? activeServices[0].entity : null,
    ).toMatchObject({
      serviceStartDate: config.selectedServiceDate,
      serviceEndDate: config.selectedServiceDate,
    });

    const inactiveRecord: ValidatedGtfsFeed = {
      ...exceptionOnlyRecord,
      calendarDates: Object.freeze([{ ...selectedAddition, date: '20260718' }]),
    };
    const inactiveSnapshot = normalizeTransitSnapshot(inactiveRecord, config);
    const inactiveServices = createCanonicalTransitMutations(
      inactiveRecord,
      inactiveSnapshot,
      config,
    ).filter(
      (mutation) =>
        mutation.kind === 'entity_upsert' && mutation.entity.entityKind === 'transit-service',
    );
    expect(inactiveSnapshot.activeServiceIds).toEqual([]);
    expect(inactiveServices).toHaveLength(0);
  });

  it('rejects missing, malformed and duplicate GTFS members/IDs', async () => {
    const base = officialExcerpts.vta.members;
    const missingMembers = { ...base } as Record<string, string>;
    delete missingMembers['trips.txt'];
    const { config } = fixture('vta');
    const adapter = createStaticGtfsAdapter(config);
    const missing = await adapter.validate(
      decodeGtfsZip(
        artifactFor(frozenZip(missingMembers), {
          ...config,
          expectedZipSha256: sha256Hex(frozenZip(missingMembers)),
          expectedZipBytes: frozenZip(missingMembers).byteLength,
        }),
      ),
      { clock, signal: new AbortController().signal },
    );
    expect(missing).toMatchObject({ status: 'rejected' });
    expect(missing.issues.map((issue) => issue.code)).toContain('gtfs.missing_member');

    const baseStops = base['stops.txt'];
    if (baseStops === undefined) throw new Error('Expected stops.txt in VTA fixture');
    const duplicateMembers = {
      ...base,
      'stops.txt': `${baseStops}${baseStops.split('\n')[1]}\n`,
    };
    const duplicateBytes = frozenZip(duplicateMembers);
    const duplicate = await adapter.validate(
      decodeGtfsZip(
        artifactFor(duplicateBytes, {
          ...config,
          expectedZipSha256: sha256Hex(duplicateBytes),
          expectedZipBytes: duplicateBytes.byteLength,
        }),
      ),
      { clock, signal: new AbortController().signal },
    );
    expect(duplicate.issues.map((issue) => issue.code)).toContain('gtfs.duplicate_id');

    const malformed = { ...base, 'agency.txt': 'agency_id,agency_name\nVTA,"unterminated\n' };
    const malformedBytes = frozenZip(malformed);
    expect(() =>
      decodeGtfsZip(
        artifactFor(malformedBytes, {
          ...config,
          expectedZipSha256: sha256Hex(malformedBytes),
          expectedZipBytes: malformedBytes.byteLength,
        }),
      ),
    ).toThrow();
  });

  it('emits strict canonical mutations with lineage and source visibility', async () => {
    const { config, artifact, record } = await validatedFixture('vta');
    const adapter = createStaticGtfsAdapter(config);
    const mutations = [];
    for await (const mutation of adapter.normalize(record, {
      clock,
      signal: new AbortController().signal,
      analyticalRuntime,
    })) {
      mutations.push(canonicalMutationSchema.parse(mutation));
    }
    expect(mutations.length).toBeGreaterThan(1);
    expect(mutations.every((mutation) => mutation.visibility === config.visibility)).toBe(true);
    expect(
      mutations.every(
        (mutation) =>
          mutation.kind !== 'entity_upsert' ||
          mutation.entity.lineage[0]?.sourceRecord.artifactId === artifact.metadata.artifactId,
      ),
    ).toBe(true);
  });

  it('classifies 429 and never persists an authorization header', async () => {
    const { config } = fixture('vta');
    const fallbackSourceId = sourceIdSchema.parse('sc:source:511-vta-gtfs');
    const fallbackConfig: TransitFeedSnapshotConfig = {
      ...config,
      role: '511_fallback',
      sourceId: fallbackSourceId,
      sourceName: '511 VTA fallback',
      url: 'https://api.511.org/transit/datafeeds?operator_id=SC',
      requiresInjectedAuthorization: true,
      ratePolicy: { ...config.ratePolicy, maxRequestsPerWindow: 60, windowMs: 3_600_000 },
      license: licenseSnapshotSchema.parse({
        ...config.license,
        licenseSnapshotId: `sc:license:511-vta-gtfs:${config.license.termsSha256}`,
        title: '511 injected fallback boundary fixture metadata',
      }),
    };
    const { adapter, plan } = await planFor(fallbackConfig);
    const transport = new ScriptedTransport({
      status: 429,
      headers: { 'retry-after': '15' },
      chunks: [],
    });
    let failure: unknown;
    try {
      const acquisition = adapter.acquire(plan, undefined, {
        clock,
        signal: new AbortController().signal,
        http: transport,
        artifactStore: new FileArtifactStore(),
        checkpointStore: new MemoryCheckpointStore(),
        ratePolicy: fallbackConfig.ratePolicy,
        delay,
      });
      await acquisition[Symbol.asyncIterator]().next();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'TRANSIENT_SOURCE', details: { retryAfterMs: 15_000 } });
    expect(transport.requests[0]?.headers).toEqual({});
  });

  it('rejects credentials embedded in configuration before transport can observe them', () => {
    const { config } = fixture('vta');
    expect(() =>
      createStaticGtfsAdapter({
        ...config,
        role: '511_fallback',
        requiresInjectedAuthorization: true,
        url: 'https://api.511.org/transit/datafeeds?operator_id=SC&api_key=not-a-real-key',
      }),
    ).toThrow('must not embed credentials');
  });

  it('acquires exact bytes and commits a resumable immutable checkpoint', async () => {
    const { bytes, config } = fixture('vta');
    const { adapter, plan } = await planFor(config);
    const transport = new ScriptedTransport({
      status: 200,
      headers: {
        'content-type': 'application/zip',
        etag: 'fixture-etag',
        'last-modified': 'Wed, 15 Jul 2026 18:03:46 GMT',
      },
      chunks: [bytes.slice(0, 100), bytes.slice(100)],
    });
    const checkpoints = new MemoryCheckpointStore();
    const acquired = [];
    for await (const artifact of adapter.acquire(plan, undefined, {
      clock,
      signal: new AbortController().signal,
      http: transport,
      artifactStore: new FileArtifactStore(),
      checkpointStore: checkpoints,
      ratePolicy: config.ratePolicy,
      delay,
    }))
      acquired.push(artifact);
    expect(acquired).toHaveLength(1);
    expect(acquired[0]?.metadata).toMatchObject({
      sha256: config.expectedZipSha256,
      byteSize: config.expectedZipBytes,
      visibility: config.visibility,
      response: { lastModified: '2026-07-15T18:03:46.000Z' },
    });
    expect(checkpoints.value?.payload).toMatchObject({ complete: true, nextSequence: 1 });
  });

  it('honors checkpoint resume, abort and exact ZIP integrity', async () => {
    const { bytes, config } = fixture('caltrain');
    const { adapter, plan } = await planFor(config);
    const requestKey = plan.items[0]?.requestKey ?? '';
    const complete: SourceCheckpoint = {
      sourceId: config.sourceId,
      snapshotId: plan.snapshotId,
      contractVersion: '1.0.0',
      cursor: 'complete',
      nextSequence: 1,
      completedRequestKeys: [requestKey],
      acquiredArtifactIds: [
        artifactIdSchema.parse(`sc:artifact:sha256:${config.expectedZipSha256}`),
      ],
      updatedAt: config.retrievedAt,
      complete: true,
    };
    const skippedTransport = new ScriptedTransport({ status: 200, headers: {}, chunks: [bytes] });
    const resumed = [];
    for await (const artifact of adapter.acquire(plan, complete, {
      clock,
      signal: new AbortController().signal,
      http: skippedTransport,
      artifactStore: new FileArtifactStore(),
      checkpointStore: new MemoryCheckpointStore(),
      ratePolicy: config.ratePolicy,
      delay,
    }))
      resumed.push(artifact);
    expect(resumed).toHaveLength(0);
    expect(skippedTransport.requests).toHaveLength(0);

    const controller = new AbortController();
    controller.abort();
    const aborted = adapter.acquire(plan, undefined, {
      clock,
      signal: controller.signal,
      http: skippedTransport,
      artifactStore: new FileArtifactStore(),
      checkpointStore: new MemoryCheckpointStore(),
      ratePolicy: config.ratePolicy,
      delay,
    });
    await expect(aborted[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      name: 'AbortError',
    });

    const changed = Uint8Array.from(bytes);
    changed[changed.length - 1] = (changed.at(-1) ?? 0) ^ 1;
    const changedTransport = new ScriptedTransport({ status: 200, headers: {}, chunks: [changed] });
    const integrityRun = adapter.acquire(plan, undefined, {
      clock,
      signal: new AbortController().signal,
      http: changedTransport,
      artifactStore: new FileArtifactStore(),
      checkpointStore: new MemoryCheckpointStore(),
      ratePolicy: config.ratePolicy,
      delay,
    });
    await expect(integrityRun[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: 'SCHEMA_DRIFT',
    });
  });
});

describe('direct-versus-511 reconciliation and summary accounting', () => {
  it('retains parity/disagreement while always preferring the direct operator snapshot', async () => {
    const { config, record } = await validatedFixture('caltrain');
    const primary = normalizeTransitSnapshot(record, config);
    const parityFallback: NormalizedTransitSnapshot = { ...primary, role: '511_fallback' };
    expect(compareTransitSnapshots(primary, parityFallback)).toHaveLength(0);
    const firstStop = parityFallback.stops[0];
    if (firstStop === undefined) throw new Error('Expected a Caltrain stop fixture');
    const changedStop = { ...firstStop, name: 'Injected disagreement' };
    const disagreementFallback: NormalizedTransitSnapshot = {
      ...parityFallback,
      stops: [changedStop, ...parityFallback.stops.slice(1)],
    };
    const selection = selectTransitSnapshot(primary, disagreementFallback);
    expect(selection.selected).toBe(primary);
    expect(selection.selectedRole).toBe('operator_primary');
    expect(selection.discrepancies).toEqual(
      expect.arrayContaining([expect.objectContaining({ entityKind: 'stop', field: 'name' })]),
    );
    expect(selectTransitSnapshot(null, parityFallback)).toMatchObject({
      selectedRole: '511_fallback',
    });
  });

  it('rejects a family without both direct authoritative dependencies or rate-safe 511', () => {
    expect(() =>
      validateTransitFeedFamilyConfig({
        vta: {
          ...VTA_2026_07_15_SNAPSHOT,
          role: '511_fallback',
          requiresInjectedAuthorization: true,
        },
        caltrain: CALTRAIN_2026_06_10_SNAPSHOT,
      }),
    ).toThrow(/operator-authoritative/u);
  });

  it('balances summary counts and mutation visibility', async () => {
    const { config, artifact, record } = await validatedFixture('caltrain');
    const adapter = createStaticGtfsAdapter(config);
    const mutations = [];
    for await (const mutation of adapter.normalize(record, {
      clock,
      signal: new AbortController().signal,
      analyticalRuntime,
    }))
      mutations.push(mutation);
    const checkpoint: SourceCheckpoint = {
      sourceId: config.sourceId,
      snapshotId: artifact.metadata.snapshotId,
      contractVersion: '1.0.0',
      cursor: 'complete',
      nextSequence: 1,
      completedRequestKeys: ['caltrain-operator_primary-gtfs'],
      acquiredArtifactIds: [artifact.metadata.artifactId],
      updatedAt: config.retrievedAt,
      complete: true,
    };
    const summary = adapter.summarize(
      {
        descriptor: adapter.describe(),
        runId: `sc:run:${'1'.repeat(64)}` as RunId,
        request: {
          sourceId: config.sourceId,
          snapshotId: artifact.metadata.snapshotId,
          requestedAt: config.retrievedAt,
          mode: 'full',
          requestedSourceAsOf: config.sourceAsOf,
        },
        plan: {
          sourceId: config.sourceId,
          snapshotId: artifact.metadata.snapshotId,
          contractVersion: '1.0.0',
          plannedAt: config.retrievedAt,
          items: [
            {
              requestKey: 'caltrain-operator_primary-gtfs',
              sequence: 0,
              method: 'GET',
              url: config.url,
              encoding: 'zip',
              expectedMediaTypes: ['application/zip'],
            },
          ],
        },
        startedAt: config.retrievedAt,
        completedAt: config.retrievedAt,
        finalCheckpoint: checkpoint,
        artifacts: [artifact.metadata],
        decodedRecords: 1,
        acceptedRecords: 1,
        rejectedRecords: 0,
        mutations,
        validationIssues: [],
        aborted: false,
      },
      { clock, signal: new AbortController().signal },
    );
    expect(summary.status).toBe('succeeded');
    expect(summary.acceptedRecords + summary.rejectedRecords).toBe(summary.decodedRecords);
    expect(Object.values(summary.visibilityCounts).reduce((sum, value) => sum + value, 0)).toBe(
      summary.normalizedMutations,
    );
  });
});
