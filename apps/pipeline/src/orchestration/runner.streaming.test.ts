import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalArtifactStore } from '@oracle/artifacts/implementations/local-artifact-store';
import { LocalCheckpointStore } from '@oracle/artifacts/implementations/local-checkpoint-store';
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
import { afterEach, describe, expect, it } from 'vitest';

import { runPipeline } from './runner.js';
import type {
  OrchestrationDependencies,
  PipelineConfiguration,
  PipelineProcessors,
  SourceConfiguration,
} from './types.js';

const INSTANT = '2026-07-18T00:00:00.000Z';
const roots: string[] = [];

afterEach(async () => {
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
  abortAfterFirstAcquireYield?: boolean;
  replayRequestKeyOverride?: string;
  abortAfterFirstFinalizeYield?: boolean;
  abortInValidate?: boolean;
  failValidate?: boolean;
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
    return { status: 'accepted', record, issues: [] };
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
