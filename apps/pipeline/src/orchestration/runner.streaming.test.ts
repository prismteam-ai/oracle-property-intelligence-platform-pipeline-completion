import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LocalArtifactStore } from '@oracle/artifacts/implementations/local-artifact-store';
import { LocalCheckpointStore } from '@oracle/artifacts/implementations/local-checkpoint-store';
import { createCheckpointEnvelope, type CheckpointValue } from '@oracle/artifacts/checkpoint-store';
import type { CanonicalMutation } from '@oracle/contracts/canonical/mutation';
import { runIdSchema, snapshotIdSchema, sourceIdSchema } from '@oracle/contracts/ids';
import {
  acquiredArtifactSchema,
  acquisitionPlanSchema,
  sourceDescriptorSchema,
  sourceRunSummarySchema,
  type AcquisitionPlan,
  type AcquisitionRequest,
  type SourceCheckpoint,
  type ValidationIssue,
} from '@oracle/contracts/source';
import {
  createStreamingAcquiredArtifact,
  type AcquiredArtifactSource,
} from '@oracle/source-adapters/spi/acquired-artifact';
import type {
  Clock,
  DiscoveryResult,
  RecordValidation,
  RepeatableAcquiredArtifactSources,
  SourceRunObservationV2,
  StreamingAcquisitionContext,
  StreamingNormalizationContext,
  StreamingSourceAdapter,
  ValidationContext,
} from '@oracle/source-adapters/spi/adapter';
import type { CsvDecodedRecord } from '@oracle/source-adapters/spi/decode';
import {
  createSharedRecordBudget,
  type SharedRecordBudget,
} from '@oracle/source-adapters/spi/record-budget';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { canonicalJson } from './canonical-json.js';
import { materializeNormalizationProjections, runPipeline } from './runner.js';
import {
  emptyChunkLedger,
  openLedgerChunkSequence,
  streamChunkLedgerReferences,
  type ChunkLedger,
  type ChunkReference,
} from './chunks.js';
import type {
  OrchestrationDependencies,
  PipelineConfiguration,
  PipelineProcessors,
  PersistedSourceState,
  SourceConfiguration,
} from './types.js';

type RecordBudgetModule = Readonly<{
  createSharedRecordBudget: typeof createSharedRecordBudget;
}>;

const createdRecordBudgets = vi.hoisted(() => [] as SharedRecordBudget[]);

vi.mock('@oracle/source-adapters/spi/record-budget', async (importOriginal) => {
  const actual = await importOriginal<RecordBudgetModule>();
  return {
    ...actual,
    createSharedRecordBudget(capacity: number): SharedRecordBudget {
      const budget = actual.createSharedRecordBudget(capacity);
      createdRecordBudgets.push(budget);
      return budget;
    },
  };
});

const INSTANT = '2026-07-18T00:00:00.000Z';
const roots: string[] = [];

afterEach(async () => {
  createdRecordBudgets.splice(0);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function hash(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

class FixedClock implements Clock {
  public now(): string {
    return INSTANT;
  }
}

interface Counters {
  networkWrites: number;
  acquireYields: number;
  decodeAdvances: number;
  decodeCleanups: number;
  finalizeCalls: number;
  finalizeAdvances: number;
  finalizeCleanups: number;
  finalizeArtifactReads: number;
}

type AdapterBehavior = Readonly<{
  itemCount?: number;
  decodedPerArtifact?: number;
  normalizeFanout?: number;
  oversizedFinalizeBytes?: number;
  abortAfterFirstAcquireYield?: boolean;
  replayRequestKeyOverride?: string;
  abortAfterFirstFinalizeYield?: boolean;
  abortInValidate?: boolean;
  failValidate?: boolean;
  validationIssueCount?: number;
  failNormalize?: boolean;
  finalizeCount?: number;
  waitInPlan?: Promise<void>;
  onValidateStart?: () => Promise<void>;
  onDecodeAdvance?: () => void;
  onFinalizeAdvance?: (index: number) => void | Promise<void>;
  onNormalizeYield?: (index: number) => void;
}>;

class GeneratedAdapter implements StreamingSourceAdapter<CsvDecodedRecord, CsvDecodedRecord> {
  readonly #slug: string;
  readonly #controller: AbortController;
  readonly #counters: Counters;
  readonly #behavior: AdapterBehavior;
  readonly #sourceId;
  readonly #snapshotId;
  readonly #descriptor;

  public constructor(
    slug: string,
    controller: AbortController,
    counters: Counters,
    behavior: AdapterBehavior = {},
  ) {
    this.#slug = slug;
    this.#controller = controller;
    this.#counters = counters;
    this.#behavior = behavior;
    this.#sourceId = sourceIdSchema.parse(`sc:source:${slug}`);
    this.#snapshotId = snapshotIdSchema.parse(`sc:snapshot:${slug}:${'a'.repeat(64)}`);
    this.#descriptor = sourceDescriptorSchema.parse({
      sourceId: this.#sourceId,
      contractVersion: '2.0.0',
      name: `Generated ${slug}`,
      authority: {
        authorityType: 'official_government',
        organization: 'Test authority',
        jurisdiction: 'Santa Clara County, California',
        canonicalUrl: `https://${slug}.example.test/`,
        authorityRank: 1,
      },
      acquisitionMethod: 'bulk_download',
      encodings: ['csv'],
      entityKinds: ['test'],
      defaultVisibility: 'public',
      license: {
        licenseSnapshotId: `sc:license:${slug}:${'b'.repeat(64)}`,
        capturedAt: INSTANT,
        title: 'Test terms',
        canonicalUrl: `https://${slug}.example.test/terms`,
        termsSha256: 'b'.repeat(64),
        redistribution: 'approved',
        containsPersonalData: false,
        attribution: ['Test authority'],
        limitations: [],
      },
      ratePolicy: {
        maxRequestsPerWindow: 10,
        windowMs: 1_000,
        maxConcurrency: 1,
        maxAttempts: 1,
        initialBackoffMs: 0,
        maxBackoffMs: 1,
        jitter: 'none',
        respectRetryAfter: true,
      },
      freshnessSemantics: 'Frozen test snapshot',
    });
  }

  public describe() {
    return this.#descriptor;
  }

  public discover(): Promise<DiscoveryResult> {
    const itemCount = this.#behavior.itemCount ?? 1;
    return Promise.resolve({
      sourceId: this.#sourceId,
      discoveredAt: INSTANT,
      resources: Object.freeze(
        Array.from({ length: itemCount }, (_, index) => ({
          requestKey: `item-${index}`,
          url: `https://${this.#slug}.example.test/item-${index}.csv`,
          sourceAsOf: { state: 'reported' as const, at: INSTANT },
          expectedRecords: 1,
          mediaTypes: ['text/csv'],
          continuationToken: null,
        })),
      ),
      complete: true,
      limitations: [],
    });
  }

  public async plan(request: AcquisitionRequest, discovery: DiscoveryResult) {
    await this.#behavior.waitInPlan;
    return acquisitionPlanSchema.parse({
      sourceId: this.#sourceId,
      snapshotId: request.snapshotId,
      contractVersion: '2.0.0',
      plannedAt: INSTANT,
      items: discovery.resources.map((resource, sequence) => ({
        requestKey: resource.requestKey,
        sequence,
        method: 'GET',
        url: resource.url,
        encoding: 'csv',
        expectedMediaTypes: ['text/csv'],
      })),
    });
  }

  public async *acquire(
    plan: AcquisitionPlan,
    _checkpoint: SourceCheckpoint | undefined,
    context: StreamingAcquisitionContext,
  ) {
    const bytes = new TextEncoder().encode('same,body\n');
    const sha256 = hash(bytes);
    for (const [ordinal, item] of plan.items.entries()) {
      const logicalKey = `raw/${this.#slug}/${item.requestKey}.csv`;
      let stored = await context.artifactStore.headByLogicalKey(logicalKey);
      if (stored === undefined) {
        this.#counters.networkWrites += 1;
        stored = await context.artifactStore.putImmutableStreaming({
          logicalKey,
          mediaType: 'text/csv',
          body: bytes,
          expectedSha256: sha256,
          metadata: { sourceId: this.#sourceId, requestKey: item.requestKey },
          ifAbsent: true,
        });
      }
      const metadata = acquiredArtifactSchema.parse({
        artifactId: `sc:artifact:sha256:${sha256}`,
        sourceId: this.#sourceId,
        snapshotId: plan.snapshotId,
        retrievedAt: INSTANT,
        sourceAsOf: { state: 'reported', at: INSTANT },
        request: {
          requestKey:
            ordinal === 0 && this.#behavior.replayRequestKeyOverride !== undefined
              ? this.#behavior.replayRequestKeyOverride
              : item.requestKey,
          method: 'GET',
          url: item.url,
          headers: [],
          bodySha256: null,
          attempt: 1,
        },
        response: { httpStatus: 200, etag: null, lastModified: null, finalUrl: item.url },
        mediaType: 'text/csv',
        encoding: 'csv',
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        schemaFingerprint: {
          algorithm: 'sha256',
          value: 'c'.repeat(64),
          schemaName: 'generated-csv-v1',
          canonicalizationVersion: '1.0.0',
        },
        rawUri: stored.uri,
        licenseSnapshotRef: this.#descriptor.license.licenseSnapshotId,
        visibility: 'public',
      });
      this.#counters.acquireYields += 1;
      yield await createStreamingAcquiredArtifact(metadata, context.artifactStore);
      if (this.#behavior.abortAfterFirstAcquireYield === true && ordinal === 0) {
        this.#controller.abort(new Error('abort after durable acquisition yield'));
        context.signal.throwIfAborted();
      }
    }
  }

  public async *decode(artifact: AcquiredArtifactSource) {
    try {
      const count = this.#behavior.decodedPerArtifact ?? 1;
      for (let ordinal = 0; ordinal < count; ordinal += 1) {
        this.#counters.decodeAdvances += 1;
        this.#behavior.onDecodeAdvance?.();
        yield await Promise.resolve({
          format: 'csv' as const,
          artifactId: artifact.metadata.artifactId,
          ordinal,
          visibility: 'public' as const,
          header: ['value'],
          values: [String(ordinal)],
        });
      }
    } finally {
      this.#counters.decodeCleanups += 1;
    }
  }

  public async validate(
    record: CsvDecodedRecord,
    context: ValidationContext,
  ): Promise<RecordValidation<CsvDecodedRecord>> {
    await this.#behavior.onValidateStart?.();
    if (this.#behavior.abortInValidate === true) {
      this.#controller.abort(new Error('abort in validate'));
      context.signal.throwIfAborted();
    }
    if (this.#behavior.failValidate === true) throw new Error('validate failed');
    return {
      status: 'accepted',
      record,
      issues: Array.from({ length: this.#behavior.validationIssueCount ?? 0 }, (_, index) => ({
        code: `generated_${index}`,
        severity: 'warning' as const,
        message: `Generated warning ${index}`,
        recordKey: String(record.ordinal),
        fieldPath: 'value',
      })),
    };
  }

  public async *normalize(record: CsvDecodedRecord): AsyncIterable<CanonicalMutation> {
    if (this.#behavior.failNormalize === true) throw new Error('normalize failed');
    for (let index = 0; index < (this.#behavior.normalizeFanout ?? 0); index += 1) {
      this.#behavior.onNormalizeYield?.(index);
      yield await Promise.resolve(testMutation(`${this.#slug}-record-${record.ordinal}-${index}`));
    }
  }

  public finalizeFromAcquiredArtifacts(
    artifacts: RepeatableAcquiredArtifactSources,
    context: StreamingNormalizationContext,
  ): AsyncIterable<CanonicalMutation> {
    this.#counters.finalizeCalls += 1;
    const counters = this.#counters;
    const behavior = this.#behavior;
    const controller = this.#controller;
    const slug = this.#slug;
    return (async function* finalize(): AsyncIterable<CanonicalMutation> {
      try {
        for await (const artifact of artifacts.read()) {
          void artifact;
          counters.finalizeArtifactReads += 1;
        }
        if (behavior.oversizedFinalizeBytes !== undefined) {
          counters.finalizeAdvances += 1;
          yield Object.freeze({
            ...testMutation(`${slug}-oversized-final`),
            payload: 'x'.repeat(behavior.oversizedFinalizeBytes),
          });
          return;
        }
        for (let index = 0; index < (behavior.finalizeCount ?? 0); index += 1) {
          counters.finalizeAdvances += 1;
          await behavior.onFinalizeAdvance?.(index);
          yield testMutation(`${slug}-final-${index}`);
          if (behavior.abortAfterFirstFinalizeYield === true && index === 0) {
            controller.abort(new Error('abort after finalizer output'));
            context.signal.throwIfAborted();
          }
        }
      } finally {
        counters.finalizeCleanups += 1;
      }
    })();
  }

  public summarize(run: SourceRunObservationV2) {
    return Promise.resolve(
      sourceRunSummarySchema.parse({
        sourceId: this.#sourceId,
        snapshotId: this.#snapshotId,
        runId: run.runId,
        contractVersion: '2.0.0',
        status: 'succeeded',
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        artifactsAcquired: run.artifacts.length,
        bytesAcquired: run.artifacts.reduce((sum, artifact) => sum + artifact.byteSize, 0),
        decodedRecords: run.decodedRecords,
        acceptedRecords: run.acceptedRecords,
        rejectedRecords: run.rejectedRecords,
        normalizedMutations: run.mutations.count,
        visibilityCounts: {
          public: run.mutations.count,
          authenticated: 0,
          restricted: 0,
          prohibited_public: 0,
        },
        warningCount: 0,
        errorCount: 0,
        finalCheckpoint: run.finalCheckpoint,
      }),
    );
  }
}

function testMutation(id: string): CanonicalMutation {
  return Object.freeze({ kind: 'generated_test_mutation', id }) as unknown as CanonicalMutation;
}

function testIssue(id: string): ValidationIssue {
  return Object.freeze({
    code: `generated_${id}`,
    severity: 'warning',
    message: `Generated issue ${id}`,
    recordKey: id,
    fieldPath: 'value',
  });
}

type TestProjectionEvent =
  | Readonly<{ kind: 'mutation'; value: CanonicalMutation }>
  | Readonly<{ kind: 'validation_issue'; value: ValidationIssue }>;

function projectionEvents(
  events: readonly TestProjectionEvent[],
  onRead: () => void = () => undefined,
): Parameters<typeof materializeNormalizationProjections>[0]['events'] {
  return Object.freeze({
    schemaVersion: '2.0.0' as const,
    recordCount: events.length,
    logicalSha256: logicalSha256(events),
    chunks: Object.freeze([]),
    chunkInventory: null,
    read: () => {
      onRead();
      return (async function* readEvents() {
        for (const [index, event] of events.entries()) {
          yield await Promise.resolve({
            schemaVersion: '2.0.0' as const,
            ...event,
            cursor: {
              artifactIndex: 0,
              recordOrdinal: index,
              issueOffset: event.kind === 'validation_issue' ? 1 : 0,
              mutationOffset: event.kind === 'mutation' ? 1 : 0,
              recordComplete: false,
              decodedRecords: 0,
              acceptedRecords: 0,
              rejectedRecords: 0,
            },
          });
        }
      })();
    },
  });
}

function logicalSha256(values: readonly unknown[]): string {
  const logical = createHash('sha256');
  for (const value of values) logical.update(`${canonicalJson(value)}\n`);
  return logical.digest('hex');
}

async function collect<T>(sequence: Readonly<{ read(): AsyncIterable<T> }>): Promise<readonly T[]> {
  const values: T[] = [];
  for await (const value of sequence.read()) values.push(value);
  return Object.freeze(values);
}

function requiredFixture<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing projection test fixture value');
  return value;
}

function projectionHarness(
  store: Awaited<ReturnType<typeof stores>>['artifacts'],
  label: string,
  capacity: number,
  maximumRecordsPerChunk = 3,
) {
  const mutationPrefix = `runs/${label}/normalize/mutations`;
  const validationIssuePrefix = `runs/${label}/normalize/validation-issues`;
  let mutationLedger = emptyChunkLedger(mutationPrefix);
  let validationIssueLedger = emptyChunkLedger(validationIssuePrefix);
  const budget = createSharedRecordBudget(capacity);
  const signal = new AbortController().signal;

  return {
    budget,
    mutationPrefix,
    validationIssuePrefix,
    get mutationLedger() {
      return mutationLedger;
    },
    get validationIssueLedger() {
      return validationIssueLedger;
    },
    run: (
      events: Parameters<typeof materializeNormalizationProjections>[0]['events'],
      options: Readonly<{
        expectedMutations?: Readonly<{ recordCount: number; logicalSha256: string }>;
        expectedValidationIssues?: Readonly<{ recordCount: number; logicalSha256: string }>;
        onMutationLedger?: (ledger: ChunkLedger) => Promise<void>;
        onValidationIssueLedger?: (ledger: ChunkLedger) => Promise<void>;
      }> = {},
    ) =>
      materializeNormalizationProjections({
        events,
        store,
        budget,
        signal,
        maximumRecordsPerChunk,
        visibility: 'public',
        licenseSnapshotRef: 'sc:license:projection:test',
        mutation: {
          logicalPrefix: mutationPrefix,
          restoredLedger: mutationLedger,
          onLedger: async (ledger) => {
            await options.onMutationLedger?.(ledger);
            mutationLedger = ledger;
          },
          ...(options.expectedMutations === undefined
            ? {}
            : { expected: options.expectedMutations }),
        },
        validationIssue: {
          logicalPrefix: validationIssuePrefix,
          restoredLedger: validationIssueLedger,
          onLedger: async (ledger) => {
            await options.onValidationIssueLedger?.(ledger);
            validationIssueLedger = ledger;
          },
          ...(options.expectedValidationIssues === undefined
            ? {}
            : { expected: options.expectedValidationIssues }),
        },
      }),
  };
}

function counters(): Counters {
  return {
    networkWrites: 0,
    acquireYields: 0,
    decodeAdvances: 0,
    decodeCleanups: 0,
    finalizeCalls: 0,
    finalizeAdvances: 0,
    finalizeCleanups: 0,
    finalizeArtifactReads: 0,
  };
}

async function stores(label: string) {
  const root = await mkdtemp(join(tmpdir(), `oracle-streaming-runner-${label}-`));
  roots.push(root);
  return {
    artifacts: new LocalArtifactStore({
      rootDirectory: join(root, 'artifacts'),
      now: () => INSTANT,
    }),
    checkpoints: new LocalCheckpointStore({ rootDirectory: join(root, 'checkpoints') }),
  };
}

function configuration(
  runHash: string,
  sources: readonly SourceConfiguration[],
  options: Readonly<{ recordCap?: number | null; maxBufferedRecords?: number }> = {},
): PipelineConfiguration {
  return {
    runId: runIdSchema.parse(`sc:run:${runHash}`),
    pipelineVersion: 'streaming-runner-test-v2',
    requestedAt: INSTANT,
    profile: {
      name: 'pilot',
      recordCap: options.recordCap ?? null,
      maxConcurrentSources: sources.length,
      maxBufferedRecords: options.maxBufferedRecords ?? 2,
    },
    sources,
    maximumPhaseAttempts: 1,
  };
}

function source(adapter: GeneratedAdapter): SourceConfiguration {
  return {
    adapter,
    snapshotId: snapshotIdSchema.parse(
      `${adapter.describe().sourceId.replace('sc:source:', 'sc:snapshot:')}:${'a'.repeat(64)}`,
    ),
    scope: 'generated test',
    capability: `generated_${adapter.describe().sourceId}`,
    executionMode: 'execute',
    supportState: 'available',
    acquisitionItemCap: null,
    discoveryDenominatorStrategy: 'sum_non_null',
    requiredForCountyCompletion: false,
  };
}

function dependencies(
  store: Awaited<ReturnType<typeof stores>>,
  controller: AbortController,
): OrchestrationDependencies {
  const processors: PipelineProcessors = {
    memoryProfile: 'bounded_streaming_v2',
    reconcile: async (mutations) => {
      let count = 0;
      for await (const mutation of mutations.read()) {
        void mutation;
        count += 1;
      }
      return { canonical: { count }, links: [] };
    },
    deriveFeatures: () => Promise.resolve({}),
    buildMarts: () => Promise.resolve({}),
  };
  return {
    artifactStore: store.artifacts,
    checkpointStore: store.checkpoints,
    analyticalRuntime: { open: () => Promise.reject(new Error('analytical runtime not used')) },
    http: { send: () => Promise.reject(new Error('HTTP not used')) },
    clock: new FixedClock(),
    delay: { wait: () => Promise.resolve() },
    processors,
    signal: controller.signal,
  };
}

describe('streaming runner restart and budget contracts', () => {
  it('releases a pre-transfer oversized event lease so another source can progress', async () => {
    const store = await stores('oversized-event-lease');
    const controller = new AbortController();
    const oversized = new GeneratedAdapter('oversized-event', controller, counters(), {
      decodedPerArtifact: 0,
      oversizedFinalizeBytes: 1024 * 1024,
    });
    const healthy = new GeneratedAdapter('healthy-after-oversized', controller, counters(), {
      normalizeFanout: 1,
    });
    const baseConfiguration = configuration('d'.repeat(64), [source(oversized), source(healthy)], {
      maxBufferedRecords: 2,
    });
    const pipelineConfiguration = {
      ...baseConfiguration,
      profile: { ...baseConfiguration.profile, maxConcurrentSources: 1 },
    } satisfies PipelineConfiguration;
    createdRecordBudgets.splice(0);
    const result = await runPipeline(pipelineConfiguration, dependencies(store, controller));
    const oversizedResult = result.manifest.sources.find(
      ({ sourceId }) => sourceId === oversized.describe().sourceId,
    );
    const healthyResult = result.manifest.sources.find(
      ({ sourceId }) => sourceId === healthy.describe().sourceId,
    );
    expect(oversizedResult).toMatchObject({ terminalState: 'failed', summary: null });
    expect(oversizedResult?.limitations).toContainEqual(
      expect.stringContaining('Canonical record exceeds'),
    );
    expect(healthyResult).toMatchObject({
      terminalState: 'complete',
      summary: { normalizedMutations: 1 },
    });
    expect(result.manifest.backpressure).toMatchObject({
      activeRecordsAtCompletion: 0,
      bufferedEventsAtCompletion: 0,
    });
    expect(createdRecordBudgets).toHaveLength(1);
    expect(createdRecordBudgets[0]?.metrics()).toMatchObject({
      capacity: 2,
      highWaterRecords: 2,
      inUse: 0,
    });
  });

  it('releases both projection leases after checkpoint failure and resumes exactly', async () => {
    const store = await stores('projection-checkpoint-failure');
    const harness = projectionHarness(store.artifacts, 'projection-checkpoint-failure', 2, 2);
    const mutations = [testMutation('projection-0'), testMutation('projection-1')];
    const issues = [testIssue('projection-0'), testIssue('projection-1')];
    const mixed = projectionEvents([
      { kind: 'mutation', value: requiredFixture(mutations[0]) },
      { kind: 'validation_issue', value: requiredFixture(issues[0]) },
      { kind: 'mutation', value: requiredFixture(mutations[1]) },
      { kind: 'validation_issue', value: requiredFixture(issues[1]) },
    ]);
    let failCheckpoint = true;
    await expect(
      harness.run(mixed, {
        onMutationLedger: () => {
          if (failCheckpoint) {
            failCheckpoint = false;
            return Promise.reject(new Error('injected projection checkpoint failure'));
          }
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow('injected projection checkpoint failure');
    expect(harness.budget.metrics()).toMatchObject({ inUse: 0, waiting: 0 });
    expect(harness.mutationLedger.totalRecords).toBe(0);
    expect(harness.validationIssueLedger.totalRecords).toBe(1);

    const retried = await harness.run(mixed, {
      expectedMutations: { recordCount: mutations.length, logicalSha256: logicalSha256(mutations) },
      expectedValidationIssues: {
        recordCount: issues.length,
        logicalSha256: logicalSha256(issues),
      },
    });
    expect(await collect(retried.mutations)).toEqual(mutations);
    expect(await collect(retried.validationIssues)).toEqual(issues);
    expect(harness.mutationLedger.totalRecords).toBe(2);
    expect(harness.validationIssueLedger.totalRecords).toBe(2);
    expect(harness.budget.metrics()).toMatchObject({ inUse: 0, waiting: 0 });
  });

  it('projects a mixed stream in one read with the prior order, identity, and ledger semantics', async () => {
    const store = await stores('one-pass-mixed');
    const harness = projectionHarness(store.artifacts, 'one-pass-mixed', 2, 3);
    const mutations = [testMutation('mixed-0'), testMutation('mixed-1'), testMutation('mixed-2')];
    const issues = [testIssue('mixed-0'), testIssue('mixed-1'), testIssue('mixed-2')];
    let reads = 0;
    const result = await harness.run(
      projectionEvents(
        [
          { kind: 'validation_issue', value: requiredFixture(issues[0]) },
          { kind: 'mutation', value: requiredFixture(mutations[0]) },
          { kind: 'mutation', value: requiredFixture(mutations[1]) },
          { kind: 'validation_issue', value: requiredFixture(issues[1]) },
          { kind: 'mutation', value: requiredFixture(mutations[2]) },
          { kind: 'validation_issue', value: requiredFixture(issues[2]) },
        ],
        () => {
          reads += 1;
        },
      ),
      {
        expectedMutations: {
          recordCount: mutations.length,
          logicalSha256: logicalSha256(mutations),
        },
        expectedValidationIssues: {
          recordCount: issues.length,
          logicalSha256: logicalSha256(issues),
        },
      },
    );

    expect(reads).toBe(1);
    expect(await collect(result.mutations)).toEqual(mutations);
    expect(await collect(result.validationIssues)).toEqual(issues);
    expect(result.mutations).toMatchObject({
      recordCount: mutations.length,
      logicalSha256: logicalSha256(mutations),
      licenseSnapshotRefs: ['sc:license:projection:test'],
    });
    expect(result.validationIssues).toMatchObject({
      recordCount: issues.length,
      logicalSha256: logicalSha256(issues),
      licenseSnapshotRefs: ['sc:license:projection:test'],
    });
    expect(harness.mutationLedger).toMatchObject({
      logicalPrefix: harness.mutationPrefix,
      totalRecords: mutations.length,
      resumeCursor: null,
      licenseSnapshotRefs: ['sc:license:projection:test'],
    });
    expect(harness.validationIssueLedger).toMatchObject({
      logicalPrefix: harness.validationIssuePrefix,
      totalRecords: issues.length,
      resumeCursor: null,
      licenseSnapshotRefs: ['sc:license:projection:test'],
    });
  });

  it('resumes independently partial mutation and issue ledgers without replacing committed chunks', async () => {
    const store = await stores('independent-projection-prefixes');
    const harness = projectionHarness(store.artifacts, 'independent-projection-prefixes', 2, 1);
    const mutations = [
      testMutation('prefix-0'),
      testMutation('prefix-1'),
      testMutation('prefix-2'),
    ];
    const issues = [testIssue('prefix-0'), testIssue('prefix-1'), testIssue('prefix-2')];
    let mutationCheckpoints = 0;
    await expect(
      harness.run(
        projectionEvents([
          { kind: 'mutation', value: requiredFixture(mutations[0]) },
          { kind: 'validation_issue', value: requiredFixture(issues[0]) },
          { kind: 'validation_issue', value: requiredFixture(issues[1]) },
          { kind: 'mutation', value: requiredFixture(mutations[1]) },
        ]),
        {
          onMutationLedger: () => {
            mutationCheckpoints += 1;
            return mutationCheckpoints === 1
              ? Promise.resolve()
              : Promise.reject(new Error('interrupt independently partial projections'));
          },
        },
      ),
    ).rejects.toThrow('interrupt independently partial projections');
    expect(harness.budget.metrics()).toMatchObject({ inUse: 0, waiting: 0 });
    expect(harness.mutationLedger.totalRecords).toBe(1);
    expect(harness.validationIssueLedger.totalRecords).toBe(2);
    const committedMutationReferences: ChunkReference[] = [];
    for await (const reference of streamChunkLedgerReferences(
      store.artifacts,
      harness.mutationLedger,
      harness.mutationPrefix,
    )) {
      committedMutationReferences.push(reference);
    }
    const committedIssueReferences: ChunkReference[] = [];
    for await (const reference of streamChunkLedgerReferences(
      store.artifacts,
      harness.validationIssueLedger,
      harness.validationIssuePrefix,
    )) {
      committedIssueReferences.push(reference);
    }

    let reads = 0;
    const resumed = await harness.run(
      projectionEvents(
        [
          { kind: 'mutation', value: requiredFixture(mutations[0]) },
          { kind: 'validation_issue', value: requiredFixture(issues[0]) },
          { kind: 'mutation', value: requiredFixture(mutations[1]) },
          { kind: 'validation_issue', value: requiredFixture(issues[1]) },
          { kind: 'mutation', value: requiredFixture(mutations[2]) },
          { kind: 'validation_issue', value: requiredFixture(issues[2]) },
        ],
        () => {
          reads += 1;
        },
      ),
    );
    const resumedMutationReferences: ChunkReference[] = [];
    for await (const reference of streamChunkLedgerReferences(
      store.artifacts,
      harness.mutationLedger,
      harness.mutationPrefix,
    )) {
      resumedMutationReferences.push(reference);
    }
    const resumedIssueReferences: ChunkReference[] = [];
    for await (const reference of streamChunkLedgerReferences(
      store.artifacts,
      harness.validationIssueLedger,
      harness.validationIssuePrefix,
    )) {
      resumedIssueReferences.push(reference);
    }

    expect(reads).toBe(1);
    expect(resumedMutationReferences.slice(0, committedMutationReferences.length)).toEqual(
      committedMutationReferences,
    );
    expect(resumedIssueReferences.slice(0, committedIssueReferences.length)).toEqual(
      committedIssueReferences,
    );
    expect(await collect(resumed.mutations)).toEqual(mutations);
    expect(await collect(resumed.validationIssues)).toEqual(issues);
    expect(harness.budget.metrics()).toMatchObject({ inUse: 0, waiting: 0 });
  });

  it('rejects a corrupt committed projection while restoring its exact prefix', async () => {
    const store = await stores('corrupt-projection-prefix');
    const harness = projectionHarness(store.artifacts, 'corrupt-projection-prefix', 2, 1);
    const mutation = testMutation('corrupt');
    const issue = testIssue('corrupt');
    const events = projectionEvents([
      { kind: 'mutation', value: mutation },
      { kind: 'validation_issue', value: issue },
    ]);
    await harness.run(events);
    const references: ChunkReference[] = [];
    for await (const reference of streamChunkLedgerReferences(
      store.artifacts,
      harness.mutationLedger,
      harness.mutationPrefix,
    )) {
      references.push(reference);
    }
    const bodyUri = references[0]?.uri;
    if (bodyUri === undefined) throw new Error('Missing committed mutation projection');
    await writeFile(fileURLToPath(bodyUri), 'corrupt\n');

    await expect(harness.run(events)).rejects.toThrow(/mismatch|corrupt/iu);
    expect(harness.budget.metrics()).toMatchObject({ inUse: 0, waiting: 0 });
  });

  it('rejects a committed projection that exceeds the event source', async () => {
    const store = await stores('excess-projection-prefix');
    const harness = projectionHarness(store.artifacts, 'excess-projection-prefix', 2, 1);
    const first = testMutation('excess-0');
    await harness.run(
      projectionEvents([
        { kind: 'mutation', value: first },
        { kind: 'mutation', value: testMutation('excess-1') },
        { kind: 'validation_issue', value: testIssue('excess-0') },
      ]),
    );

    await expect(
      harness.run(
        projectionEvents([
          { kind: 'mutation', value: first },
          { kind: 'validation_issue', value: testIssue('excess-0') },
        ]),
      ),
    ).rejects.toThrow('Persisted mutation projection exceeds its event source');
    expect(harness.budget.metrics()).toMatchObject({ inUse: 0, waiting: 0 });
  });

  it('rejects a committed projection that is not the exact event prefix', async () => {
    const store = await stores('changed-projection-prefix');
    const harness = projectionHarness(store.artifacts, 'changed-projection-prefix', 2, 1);
    await harness.run(
      projectionEvents([
        { kind: 'mutation', value: testMutation('original') },
        { kind: 'validation_issue', value: testIssue('original') },
      ]),
    );

    await expect(
      harness.run(
        projectionEvents([
          { kind: 'mutation', value: testMutation('changed') },
          { kind: 'validation_issue', value: testIssue('original') },
        ]),
      ),
    ).rejects.toThrow('Persisted mutation projection is not an exact event prefix');
    expect(harness.budget.metrics()).toMatchObject({ inUse: 0, waiting: 0 });
  });

  it('rejects an expected projection SHA-256 mismatch after releasing all leases', async () => {
    const store = await stores('expected-projection-mismatch');
    const harness = projectionHarness(store.artifacts, 'expected-projection-mismatch', 2, 2);
    const mutations = [testMutation('expected-0'), testMutation('expected-1')];
    await expect(
      harness.run(
        projectionEvents(mutations.map((value) => ({ kind: 'mutation' as const, value }))),
        {
          expectedMutations: {
            recordCount: mutations.length,
            logicalSha256: '0'.repeat(64),
          },
        },
      ),
    ).rejects.toThrow('Projected mutation logical identity mismatch');
    expect(harness.budget.metrics()).toMatchObject({ inUse: 0, waiting: 0 });
  });

  it.each([1, 2])(
    'coordinates dual writers without deadlock or lease leaks at capacity %i',
    async (capacity) => {
      const store = await stores(`projection-capacity-${capacity}`);
      const harness = projectionHarness(
        store.artifacts,
        `projection-capacity-${capacity}`,
        capacity,
        8,
      );
      const mutations = Array.from({ length: 32 }, (_, index) => testMutation(`capacity-${index}`));
      const issues = Array.from({ length: 32 }, (_, index) => testIssue(`capacity-${index}`));
      const events = mutations.flatMap((mutation, index): readonly TestProjectionEvent[] => [
        { kind: 'mutation', value: mutation },
        { kind: 'validation_issue', value: requiredFixture(issues[index]) },
      ]);

      const result = await harness.run(projectionEvents(events));
      expect(await collect(result.mutations)).toEqual(mutations);
      expect(await collect(result.validationIssues)).toEqual(issues);
      expect(harness.budget.metrics()).toMatchObject({
        capacity,
        inUse: 0,
        waiting: 0,
      });
      expect(harness.budget.metrics().highWaterRecords).toBeLessThanOrEqual(capacity);
    },
    5_000,
  );

  it('materializes two empty projections from one empty event read', async () => {
    const store = await stores('empty-projections');
    const harness = projectionHarness(store.artifacts, 'empty-projections', 1, 1);
    let reads = 0;
    const result = await harness.run(
      projectionEvents([], () => {
        reads += 1;
      }),
    );
    expect(reads).toBe(1);
    expect(result.mutations).toMatchObject({ recordCount: 0, logicalSha256: hash('') });
    expect(result.validationIssues).toMatchObject({ recordCount: 0, logicalSha256: hash('') });
    expect(harness.mutationLedger).toMatchObject({ totalChunks: 0, totalRecords: 0 });
    expect(harness.validationIssueLedger).toMatchObject({ totalChunks: 0, totalRecords: 0 });
    expect(harness.budget.metrics()).toMatchObject({ inUse: 0, waiting: 0 });
  });

  it('keeps issue-heavy projection order and identity bounded in one event pass', async () => {
    const store = await stores('issue-heavy-projection');
    const harness = projectionHarness(store.artifacts, 'issue-heavy-projection', 2, 7);
    const issues = Array.from({ length: 257 }, (_, index) => testIssue(`heavy-${index}`));
    const mutations: CanonicalMutation[] = [];
    const events: TestProjectionEvent[] = [];
    for (const [index, issue] of issues.entries()) {
      events.push({ kind: 'validation_issue', value: issue });
      if (index % 64 === 0) {
        const mutation = testMutation(`heavy-${index}`);
        mutations.push(mutation);
        events.push({ kind: 'mutation', value: mutation });
      }
    }
    let reads = 0;
    const result = await harness.run(
      projectionEvents(events, () => {
        reads += 1;
      }),
    );

    expect(reads).toBe(1);
    expect(await collect(result.mutations)).toEqual(mutations);
    expect(await collect(result.validationIssues)).toEqual(issues);
    expect(result.mutations.logicalSha256).toBe(logicalSha256(mutations));
    expect(result.validationIssues.logicalSha256).toBe(logicalSha256(issues));
    expect(harness.budget.metrics()).toMatchObject({ inUse: 0, waiting: 0 });
    expect(harness.budget.metrics().highWaterRecords).toBeLessThanOrEqual(2);
  });

  it('persists each yielded acquisition and replays identical-body plan items without reacquiring', async () => {
    const store = await stores('acquire-replay');
    const measured = counters();
    const firstController = new AbortController();
    const first = new GeneratedAdapter('acquire-replay', firstController, measured, {
      itemCount: 2,
      abortAfterFirstAcquireYield: true,
    });
    const config = configuration('1'.repeat(64), [source(first)]);
    await expect(runPipeline(config, dependencies(store, firstController))).rejects.toThrow(
      'abort after durable acquisition yield',
    );

    const secondController = new AbortController();
    const second = new GeneratedAdapter('acquire-replay', secondController, measured, {
      itemCount: 2,
    });
    const result = await runPipeline(
      configuration('1'.repeat(64), [source(second)]),
      dependencies(store, secondController),
    );
    expect(result.manifest.sources[0]?.summary?.artifactsAcquired).toBe(2);
    expect(measured.networkWrites).toBe(2);
    expect(measured.acquireYields).toBe(3);
    expect(result.manifest.sources[0]?.coverage.observedRecords).toBe(2);
  });

  it('rejects a changed durable acquisition prefix with the typed actionable incompatibility', async () => {
    const store = await stores('acquire-mismatch');
    const measured = counters();
    const firstController = new AbortController();
    const first = new GeneratedAdapter('acquire-mismatch', firstController, measured, {
      itemCount: 2,
      abortAfterFirstAcquireYield: true,
    });
    const config = configuration('6'.repeat(64), [source(first)]);
    await expect(runPipeline(config, dependencies(store, firstController))).rejects.toThrow(
      'abort after durable acquisition yield',
    );

    const secondController = new AbortController();
    const second = new GeneratedAdapter('acquire-mismatch', secondController, measured, {
      itemCount: 2,
      replayRequestKeyOverride: 'changed-prefix',
    });
    const result = await runPipeline(
      configuration('6'.repeat(64), [source(second)]),
      dependencies(store, secondController),
    );
    expect(result.manifest.sources[0]).toMatchObject({
      terminalState: 'failed',
      errorCodes: ['ACQUISITION_REPLAY_INCOMPATIBLE'],
    });
    expect(result.manifest.sources[0]?.limitations[0]).toContain(
      'must re-emit every committed artifact in exact deterministic order',
    );
    expect(measured.networkWrites).toBe(1);
  });

  it('reconstructs fresh-process finalization from acquired artifacts and resumes exact output offset', async () => {
    const store = await stores('finalize-resume');
    const firstMeasured = counters();
    const firstController = new AbortController();
    const first = new GeneratedAdapter('finalize-resume', firstController, firstMeasured, {
      finalizeCount: 2,
      abortAfterFirstFinalizeYield: true,
    });
    await expect(
      runPipeline(
        configuration('2'.repeat(64), [source(first)]),
        dependencies(store, firstController),
      ),
    ).rejects.toThrow('abort after finalizer output');
    expect(firstMeasured.decodeAdvances).toBe(1);
    expect(firstMeasured.decodeCleanups).toBe(1);

    const secondMeasured = counters();
    const secondController = new AbortController();
    const second = new GeneratedAdapter('finalize-resume', secondController, secondMeasured, {
      finalizeCount: 2,
    });
    const result = await runPipeline(
      configuration('2'.repeat(64), [source(second)]),
      dependencies(store, secondController),
    );
    expect(secondMeasured.decodeAdvances).toBe(0);
    expect(secondMeasured.finalizeCalls).toBe(1);
    expect(secondMeasured.finalizeArtifactReads).toBe(1);
    expect(result.manifest.sources[0]?.summary?.normalizedMutations).toBe(2);
  });

  it('migrates a persisted legacy run only after exact byte/prefix identity and leaves failures authoritative', async () => {
    const store = await stores('persisted-ledger-migration');
    const config = configuration('9'.repeat(64), [
      source(
        new GeneratedAdapter('persisted-ledger-migration', new AbortController(), counters(), {
          finalizeCount: 2,
          validationIssueCount: 2,
        }),
      ),
    ]);
    const firstController = new AbortController();
    const interrupted = new GeneratedAdapter(
      'persisted-ledger-migration',
      firstController,
      counters(),
      { finalizeCount: 2, validationIssueCount: 2, abortAfterFirstFinalizeYield: true },
    );
    await expect(
      runPipeline(
        configuration('9'.repeat(64), [source(interrupted)]),
        dependencies(store, firstController),
      ),
    ).rejects.toThrow('abort after finalizer output');

    const scope = `pipeline-run:${config.runId}`;
    const toLegacy = async (tamper: boolean) => {
      const current = await store.checkpoints.load(scope);
      if (current === undefined) throw new Error('Expected persisted run checkpoint');
      const payload = current.payload as unknown as Record<string, unknown>;
      const sources = payload.sources as Record<string, unknown>[];
      const currentSource = sources[0];
      if (currentSource === undefined) throw new Error('Expected persisted source state');
      const ledger = currentSource.normalizationLedger as ChunkLedger;
      const references: ChunkReference[] = [];
      for await (const reference of streamChunkLedgerReferences(
        store.artifacts,
        ledger,
        ledger.logicalPrefix,
      )) {
        references.push(reference);
      }
      if (tamper && references[0] !== undefined) {
        references[0] = Object.freeze({ ...references[0], sha256: '0'.repeat(64) });
      }
      const legacySource = { ...currentSource };
      delete legacySource.normalizationLedger;
      delete legacySource.mutationLedger;
      delete legacySource.validationIssueLedger;
      legacySource.normalizationChunks = references;
      const completedNormalization =
        legacySource.completedPhase === 'normalize' || legacySource.completedPhase === 'summarize';
      legacySource.mutationChunks = completedNormalization ? references : [];
      legacySource.validationIssueChunks = completedNormalization ? references : [];
      const legacyPayload = Object.freeze({
        ...payload,
        sources: Object.freeze([Object.freeze(legacySource), ...sources.slice(1)]),
      });
      const envelope = createCheckpointEnvelope({
        scope,
        previousRevision: current.revision,
        writtenAt: INSTANT,
        payload: legacyPayload as CheckpointValue,
      });
      const committed = await store.checkpoints.commit({
        expectedRevision: current.revision,
        checkpoint: envelope,
      });
      if (committed.status !== 'committed') throw new Error('Legacy fixture commit conflicted');
      return committed.checkpoint;
    };

    let legacy = await toLegacy(false);
    const validLegacyPayload = legacy.payload;
    const commitLegacyPayload = async (payload: CheckpointValue) => {
      const current = await store.checkpoints.load(scope);
      if (current === undefined) throw new Error('Expected current legacy checkpoint');
      const envelope = createCheckpointEnvelope({
        scope,
        previousRevision: current.revision,
        writtenAt: INSTANT,
        payload,
      });
      const committed = await store.checkpoints.commit({
        expectedRevision: current.revision,
        checkpoint: envelope,
      });
      if (committed.status !== 'committed') throw new Error('Legacy mutation conflicted');
      return committed.checkpoint;
    };
    const corruptAlias = async (field: 'mutationChunks' | 'validationIssueChunks') => {
      const payload = validLegacyPayload as unknown as Record<string, unknown>;
      const sources = payload.sources as Record<string, unknown>[];
      const currentSource = sources[0];
      if (currentSource === undefined) throw new Error('Expected legacy source');
      const normalizationReferences = currentSource.normalizationChunks as ChunkReference[];
      const corrupt = Object.freeze({
        ...currentSource,
        [field]: Object.freeze([
          Object.freeze({
            ...normalizationReferences[0],
            resumeCursor: 'corrupt-partial-projection-cursor',
          }),
        ]),
      });
      const corrupted = await commitLegacyPayload(
        Object.freeze({
          ...payload,
          sources: Object.freeze([corrupt, ...sources.slice(1)]),
        }) as CheckpointValue,
      );
      const controller = new AbortController();
      await expect(
        runPipeline(
          configuration('9'.repeat(64), [
            source(
              new GeneratedAdapter('persisted-ledger-migration', controller, counters(), {
                finalizeCount: 2,
                validationIssueCount: 2,
              }),
            ),
          ]),
          dependencies(store, controller),
        ),
      ).rejects.toThrow(`Legacy ${field} has invalid partial zero-state semantics`);
      expect((await store.checkpoints.load(scope))?.revision).toBe(corrupted.revision);
      legacy = await commitLegacyPayload(validLegacyPayload);
    };
    await corruptAlias('mutationChunks');
    await corruptAlias('validationIssueChunks');
    const rejectCorruptState = async (
      mutate: (payload: Record<string, unknown>) => CheckpointValue,
      message: string,
    ) => {
      const corrupted = await commitLegacyPayload(
        mutate(validLegacyPayload as unknown as Record<string, unknown>),
      );
      const controller = new AbortController();
      await expect(
        runPipeline(
          configuration('9'.repeat(64), [
            source(
              new GeneratedAdapter('persisted-ledger-migration', controller, counters(), {
                finalizeCount: 2,
                validationIssueCount: 2,
              }),
            ),
          ]),
          dependencies(store, controller),
        ),
      ).rejects.toThrow(message);
      expect((await store.checkpoints.load(scope))?.revision).toBe(corrupted.revision);
      legacy = await commitLegacyPayload(validLegacyPayload);
    };
    await rejectCorruptState((payload) => {
      const sources = payload.sources as Record<string, unknown>[];
      return Object.freeze({
        ...payload,
        sources: Object.freeze([
          Object.freeze({
            ...sources[0],
            normalizationLedger: emptyChunkLedger('mixed-format/events'),
          }),
        ]),
      });
    }, 'mixed or incomplete chunk formats');
    await rejectCorruptState((payload) => {
      const sources = payload.sources as Record<string, unknown>[];
      const current = { ...sources[0] };
      delete current.normalizationChunks;
      delete current.mutationChunks;
      delete current.validationIssueChunks;
      current.normalizationLedger = emptyChunkLedger('incomplete-current/events');
      current.mutationLedger = emptyChunkLedger('incomplete-current/mutations');
      return Object.freeze({
        ...payload,
        sources: Object.freeze([Object.freeze(current)]),
      }) as unknown as CheckpointValue;
    }, 'mixed or incomplete chunk formats');
    await rejectCorruptState(
      (payload) => Object.freeze({ ...payload, runId: `sc:run:${'8'.repeat(64)}` }),
      'run/configuration identity changed',
    );
    await rejectCorruptState((payload) => {
      const sources = payload.sources as Record<string, unknown>[];
      return Object.freeze({
        ...payload,
        sources: Object.freeze([
          Object.freeze({ ...sources[0], snapshotId: `sc:snapshot:changed:${'0'.repeat(64)}` }),
        ]),
      });
    }, 'source order or snapshot identity changed');
    await rejectCorruptState((payload) => {
      const sources = payload.sources as Record<string, unknown>[];
      return Object.freeze({
        ...payload,
        sources: Object.freeze([
          Object.freeze({ ...sources[0], acceptedRecords: Number.MAX_SAFE_INTEGER + 1 }),
        ]),
      });
    }, 'invalid acceptedRecords counter');
    await rejectCorruptState((payload) => {
      const sources = payload.sources as Record<string, unknown>[];
      return Object.freeze({
        ...payload,
        sources: Object.freeze([Object.freeze({ ...sources[0], mutationRecords: 1 })]),
      });
    }, 'projection zero-state is inconsistent');
    await rejectCorruptState((payload) => {
      const sources = payload.sources as Record<string, unknown>[];
      return Object.freeze({
        ...payload,
        sources: Object.freeze([
          Object.freeze({
            ...sources[0],
            decodedRecords: 2,
            acceptedRecords: 1,
            rejectedRecords: 0,
          }),
        ]),
      });
    }, 'record balance changed');
    await rejectCorruptState((payload) => {
      const sources = payload.sources as Record<string, unknown>[];
      const current = sources[0];
      const cursor = current?.normalizationCursor as Record<string, unknown>;
      return Object.freeze({
        ...payload,
        sources: Object.freeze([
          Object.freeze({
            ...current,
            normalizationCursor: Object.freeze({
              ...cursor,
              decodedRecords: 1,
              acceptedRecords: 0,
              rejectedRecords: 0,
            }),
          }),
        ]),
      });
    }, 'cursor record balance');
    const legacySourceBeforeResume = (
      (legacy.payload as unknown as Record<string, unknown>).sources as Record<string, unknown>[]
    )[0];
    expect(
      (legacySourceBeforeResume?.normalizationChunks as ChunkReference[]).length,
    ).toBeGreaterThan(0);
    const legacyDownstreamScope = `bounded-processing:${config.runId}`;
    const downstreamScopePrefix = `${legacyDownstreamScope}:`;
    const downstreamController = new AbortController();
    const downstreamDependencies = Object.freeze({
      ...dependencies(store, downstreamController),
      checkpointStore: Object.freeze({
        load: (requestedScope: string) =>
          requestedScope === legacyDownstreamScope ||
          requestedScope.startsWith(downstreamScopePrefix)
            ? Promise.resolve(
                createCheckpointEnvelope({
                  scope: requestedScope,
                  previousRevision: null,
                  writtenAt: INSTANT,
                  payload: Object.freeze({ authority: 'begun' }),
                }),
              )
            : store.checkpoints.load(requestedScope),
        commit: store.checkpoints.commit.bind(store.checkpoints),
      }),
    });
    await expect(
      runPipeline(
        configuration('9'.repeat(64), [
          source(
            new GeneratedAdapter('persisted-ledger-migration', downstreamController, counters(), {
              finalizeCount: 2,
              validationIssueCount: 2,
            }),
          ),
        ]),
        downstreamDependencies,
      ),
    ).rejects.toThrow('after bounded processing has begun');
    expect((await store.checkpoints.load(scope))?.revision).toBe(legacy.revision);
    const resumeController = new AbortController();
    const resumed = new GeneratedAdapter(
      'persisted-ledger-migration',
      resumeController,
      counters(),
      { finalizeCount: 2, validationIssueCount: 2 },
    );
    const result = await runPipeline(
      configuration('9'.repeat(64), [source(resumed)]),
      dependencies(store, resumeController),
    );
    expect(result.manifest.sources[0]?.summary?.normalizedMutations).toBe(2);
    const migrated = await store.checkpoints.load(scope);
    expect(migrated?.revision).not.toBe(legacy.revision);
    const migratedSource = (
      (migrated?.payload as unknown as Record<string, unknown>).sources as Record<string, unknown>[]
    )[0];
    expect(migratedSource?.normalizationLedger).toMatchObject({
      schemaVersion: 'oracle-chunk-ledger-v1',
    });
    expect(migratedSource).not.toHaveProperty('normalizationChunks');
    const persistedSource = migratedSource as unknown as PersistedSourceState;
    const mutationSequence = await openLedgerChunkSequence<CanonicalMutation>(
      store.artifacts,
      persistedSource.mutationLedger,
      {
        recordCount: persistedSource.mutationRecords,
        logicalSha256: persistedSource.mutationLogicalSha256 ?? '',
        logicalPrefix: persistedSource.mutationLedger.logicalPrefix,
      },
    );
    const issueSequence = await openLedgerChunkSequence<ValidationIssue>(
      store.artifacts,
      persistedSource.validationIssueLedger,
      {
        recordCount: persistedSource.validationIssueRecords,
        logicalSha256: persistedSource.validationIssueLogicalSha256 ?? '',
        logicalPrefix: persistedSource.validationIssueLedger.logicalPrefix,
      },
    );
    const mutations: CanonicalMutation[] = [];
    for await (const mutation of mutationSequence.read()) mutations.push(mutation);
    const issues: ValidationIssue[] = [];
    for await (const issue of issueSequence.read()) issues.push(issue);
    expect(mutations).toEqual([
      testMutation('persisted-ledger-migration-final-0'),
      testMutation('persisted-ledger-migration-final-1'),
    ]);
    expect(issues.map(({ code }) => code)).toEqual(['generated_0', 'generated_1']);
    expect(mutationSequence.chunkInventory?.recordCount).toBe(2);
    expect(issueSequence.chunkInventory?.recordCount).toBe(2);
    const expectedLicense = resumed.describe().license.licenseSnapshotId;
    expect(mutationSequence.licenseSnapshotRefs).toEqual([expectedLicense]);
    expect(issueSequence.licenseSnapshotRefs).toEqual([expectedLicense]);
    const legacyPayload = legacy.payload as unknown as Record<string, unknown>;
    const migratedPayload = migrated?.payload as unknown as Record<string, unknown>;
    expect(migratedPayload.runId).toBe(legacyPayload.runId);
    expect(migratedPayload.configurationHash).toBe(legacyPayload.configurationHash);
    const legacySource = (legacyPayload.sources as Record<string, unknown>[])[0];
    const legacyReferences = legacySource?.normalizationChunks as ChunkReference[];
    const migratedReferences: ChunkReference[] = [];
    for await (const reference of streamChunkLedgerReferences(
      store.artifacts,
      persistedSource.normalizationLedger,
      persistedSource.normalizationLedger.logicalPrefix,
    )) {
      migratedReferences.push(reference);
    }
    expect(migratedReferences.slice(0, legacyReferences.length)).toEqual(legacyReferences);
    expect(legacySource?.normalizationCursor).toEqual(
      JSON.parse(legacyReferences.at(-1)?.resumeCursor ?? 'null'),
    );
    expect(persistedSource.normalizationCursor).toEqual(
      JSON.parse(persistedSource.normalizationLedger.resumeCursor ?? 'null'),
    );

    const invalidLegacy = await toLegacy(true);
    const rejectedController = new AbortController();
    const rejected = new GeneratedAdapter(
      'persisted-ledger-migration',
      rejectedController,
      counters(),
      { finalizeCount: 2, validationIssueCount: 2 },
    );
    await expect(
      runPipeline(
        configuration('9'.repeat(64), [source(rejected)]),
        dependencies(store, rejectedController),
      ),
    ).rejects.toBeInstanceOf(Error);
    expect((await store.checkpoints.load(scope))?.revision).toBe(invalidLegacy.revision);
  });

  it('acquires the one global permit before advancing concurrent finalizers and cleans up rejection', async () => {
    const store = await stores('finalizer-budget');
    const runHash = '7'.repeat(64);
    const seedController = new AbortController();
    const seedFirstCounters = counters();
    const seedSecondCounters = counters();
    const failAfterDurableFinalizerPrefix = (index: number): void => {
      if (index === 1) throw new Error('stop after durable finalizer prefix');
    };
    const seedFirst = new GeneratedAdapter('finalizer-first', seedController, seedFirstCounters, {
      decodedPerArtifact: 0,
      finalizeCount: 2,
      onFinalizeAdvance: failAfterDurableFinalizerPrefix,
    });
    const seedSecond = new GeneratedAdapter(
      'finalizer-second',
      seedController,
      seedSecondCounters,
      {
        decodedPerArtifact: 0,
        finalizeCount: 2,
        onFinalizeAdvance: failAfterDurableFinalizerPrefix,
      },
    );
    const seedDummy = new GeneratedAdapter('finalizer-dummy', seedController, counters());
    const seedConfiguration = configuration(
      runHash,
      [source(seedFirst), source(seedSecond), source(seedDummy)],
      { maxBufferedRecords: 1 },
    );
    await expect(
      runPipeline(seedConfiguration, {
        ...dependencies(store, seedController),
        beforePhase: (phase) => {
          if (phase === 'reconcile') throw new Error('stop after seeding finalizer prefixes');
        },
      }),
    ).rejects.toThrow('stop after seeding finalizer prefixes');
    expect(seedFirstCounters.finalizeAdvances).toBe(2);
    expect(seedSecondCounters.finalizeAdvances).toBe(2);

    let firstAdvanced!: () => void;
    const firstAdvance = new Promise<void>((resolve) => {
      firstAdvanced = resolve;
    });
    let releaseFirst!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let winner: 'first' | 'second' | undefined;
    const finalizerBarrier =
      (candidate: 'first' | 'second') =>
      async (index: number): Promise<void> => {
        if (index !== 0) return;
        if (winner === undefined) {
          winner = candidate;
          firstAdvanced();
          await release;
          return;
        }
        throw new Error('finalizer rejected');
      };
    const firstCounters = counters();
    const secondCounters = counters();
    const controller = new AbortController();
    const first = new GeneratedAdapter('finalizer-first', controller, firstCounters, {
      decodedPerArtifact: 0,
      finalizeCount: 3,
      onFinalizeAdvance: finalizerBarrier('first'),
    });
    const second = new GeneratedAdapter('finalizer-second', controller, secondCounters, {
      decodedPerArtifact: 0,
      finalizeCount: 3,
      onFinalizeAdvance: finalizerBarrier('second'),
    });
    const dummy = new GeneratedAdapter('finalizer-dummy', controller, counters());
    const running = runPipeline(
      configuration(runHash, [source(first), source(second), source(dummy)], {
        maxBufferedRecords: 1,
      }),
      dependencies(store, controller),
    );
    await Promise.race([
      firstAdvance,
      running.then(() => {
        throw new Error('pipeline completed before either finalizer advanced');
      }),
    ]);
    if (winner === undefined) throw new Error('finalizer barrier did not select a winner');
    const losingCounters = winner === 'first' ? secondCounters : firstCounters;
    let result: Awaited<ReturnType<typeof runPipeline>>;
    try {
      for (let attempt = 0; attempt < 200 && losingCounters.finalizeCalls === 0; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
      expect(losingCounters.finalizeCalls).toBe(1);
      expect(losingCounters.finalizeAdvances).toBe(0);
    } finally {
      releaseFirst();
      result = await running;
    }
    const winningCounters = winner === 'first' ? firstCounters : secondCounters;
    expect(winningCounters).toMatchObject({
      finalizeCalls: 1,
      finalizeAdvances: 3,
      finalizeCleanups: 1,
    });
    expect(losingCounters).toMatchObject({
      finalizeCalls: 1,
      finalizeAdvances: 1,
      finalizeCleanups: 1,
    });
    const winningSourceIndex = winner === 'first' ? 0 : 1;
    const losingSourceIndex = winningSourceIndex === 0 ? 1 : 0;
    expect(result.manifest.sources[winningSourceIndex]?.summary?.normalizedMutations).toBe(3);
    expect(result.manifest.sources[losingSourceIndex]?.terminalState).toBe('failed');
    expect(result.manifest.backpressure).toMatchObject({
      maxBufferedRecords: 1,
      observedHighWaterRecords: 1,
      observedHighWaterActiveRecords: 1,
      observedHighWaterBufferedEvents: 1,
      observedHighWaterCombinedRecordsAndEvents: 1,
      activeRecordsAtCompletion: 0,
      bufferedEventsAtCompletion: 0,
    });
  });

  it.each([
    ['record cap', { decodedPerArtifact: 2 }, 1],
    ['validate rejection', { failValidate: true }, null],
    ['normalize rejection', { failNormalize: true, normalizeFanout: 1 }, null],
    ['abort', { abortInValidate: true }, null],
  ] as const)('awaits decoder cleanup on %s', async (_label, behavior, recordCap) => {
    const store = await stores(`cleanup-${_label.replace(' ', '-')}`);
    const measured = counters();
    const controller = new AbortController();
    const adapter = new GeneratedAdapter(
      `cleanup-${hash(_label).slice(0, 8)}`,
      controller,
      measured,
      behavior,
    );
    const run = runPipeline(
      configuration(hash(_label), [source(adapter)], { recordCap }),
      dependencies(store, controller),
    );
    if ('abortInValidate' in behavior) {
      await expect(run).rejects.toThrow('abort in validate');
    } else await run;
    expect(measured.decodeCleanups).toBe(1);
  });

  it('holds one shared record-lifetime slot through validation and complete normalization fan-out', async () => {
    const store = await stores('shared-record-budget');
    let validationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      validationStarted = resolve;
    });
    let releaseValidation!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const ordering: string[] = [];
    const firstCounters = counters();
    const secondCounters = counters();
    const controller = new AbortController();
    const first = new GeneratedAdapter('budget-first', controller, firstCounters, {
      normalizeFanout: 5,
      onValidateStart: async () => {
        validationStarted();
        await release;
      },
      onNormalizeYield: (index) => ordering.push(`first-${index}`),
    });
    const second = new GeneratedAdapter('budget-second', controller, secondCounters, {
      waitInPlan: started,
      onDecodeAdvance: () => ordering.push('second-decode'),
    });
    const running = runPipeline(
      configuration('3'.repeat(64), [source(first), source(second)], {
        maxBufferedRecords: 1,
      }),
      dependencies(store, controller),
    );
    await started;
    let blockedDecodeAdvances: number;
    let result: Awaited<ReturnType<typeof runPipeline>>;
    try {
      for (let attempt = 0; attempt < 2_000 && secondCounters.acquireYields === 0; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
      expect(secondCounters.acquireYields).toBe(1);
      blockedDecodeAdvances = secondCounters.decodeAdvances;
    } finally {
      releaseValidation();
      result = await running;
    }
    expect(blockedDecodeAdvances).toBe(0);
    expect(ordering.indexOf('second-decode')).toBeGreaterThan(ordering.indexOf('first-4'));
    expect(result.manifest.backpressure.observedHighWaterRecords).toBe(1);
    expect(result.manifest.backpressure).toMatchObject({
      observedHighWaterActiveRecords: 1,
      observedHighWaterBufferedEvents: 1,
      observedHighWaterCombinedRecordsAndEvents: 1,
      activeRecordsAtCompletion: 0,
      bufferedEventsAtCompletion: 0,
    });
  });

  it('globally bounds concurrent multi-source normalization fan-out in the one permit pool', async () => {
    const store = await stores('global-fanout');
    const controller = new AbortController();
    const first = new GeneratedAdapter('fanout-first', controller, counters(), {
      normalizeFanout: 20,
    });
    const second = new GeneratedAdapter('fanout-second', controller, counters(), {
      normalizeFanout: 20,
    });
    const result = await runPipeline(
      configuration('4'.repeat(64), [source(first), source(second)], {
        maxBufferedRecords: 4,
      }),
      dependencies(store, controller),
    );
    expect(result.manifest.sources.map(({ summary }) => summary?.normalizedMutations)).toEqual([
      20, 20,
    ]);
    expect(result.manifest.backpressure.observedHighWaterActiveRecords).toBeLessThanOrEqual(2);
    expect(result.manifest.backpressure.observedHighWaterBufferedEvents).toBeLessThanOrEqual(4);
    expect(result.manifest.backpressure.observedHighWaterCombinedRecordsAndEvents).toBe(4);
    expect(result.manifest.backpressure).toMatchObject({
      maxBufferedRecords: 4,
      observedHighWaterRecords: 4,
      activeRecordsAtCompletion: 0,
      bufferedEventsAtCompletion: 0,
    });
  });
});
