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
} from '@oracle/contracts/source';
import {
  createStreamingAcquiredArtifact,
  type AcquiredArtifactSource,
} from '@oracle/source-adapters/spi/acquired-artifact';
import type {
  Clock,
  DiscoveryResult,
  SourceRunObservationV2,
  StreamingAcquisitionContext,
  StreamingSourceAdapter,
} from '@oracle/source-adapters/spi/adapter';
import type { CsvDecodedRecord } from '@oracle/source-adapters/spi/decode';

import { runPipeline } from './runner.js';
import type {
  OrchestrationDependencies,
  PipelineConfiguration,
  PipelineProcessors,
  SourceConfiguration,
} from './types.js';

const INSTANT = '2026-07-18T00:00:00.000Z';
const RECORDS = 1_000_000;
const MAX_BUFFERED_RECORDS = 1_000;
const RAW_BYTES = new TextEncoder().encode('generated-v2-stress\n');
const RAW_SHA256 = createHash('sha256').update(RAW_BYTES).digest('hex');
const SOURCE_ID = sourceIdSchema.parse('sc:source:generated-streaming-stress');
const SNAPSHOT_ID = snapshotIdSchema.parse(
  `sc:snapshot:generated-streaming-stress:${'a'.repeat(64)}`,
);
const RUN_ID = runIdSchema.parse(`sc:run:${'5'.repeat(64)}`);

class FixedClock implements Clock {
  public now(): string {
    return INSTANT;
  }
}

class MillionRecordAdapter implements StreamingSourceAdapter<CsvDecodedRecord, CsvDecodedRecord> {
  public projectedLogicalSha256: string | null = null;
  public decodedRecords = 0;
  public normalizedMutations = 0;
  public peakHeapBytes = process.memoryUsage().heapUsed;

  readonly #descriptor = sourceDescriptorSchema.parse({
    sourceId: SOURCE_ID,
    contractVersion: '2.0.0',
    name: 'Generated million-record bounded streaming stress',
    authority: {
      authorityType: 'official_government',
      organization: 'Generated stress fixture',
      jurisdiction: 'Santa Clara County, California',
      canonicalUrl: 'https://stress.invalid/',
      authorityRank: 1,
    },
    acquisitionMethod: 'bulk_download',
    encodings: ['csv'],
    entityKinds: ['generated_stress_record'],
    defaultVisibility: 'public',
    license: {
      licenseSnapshotId: `sc:license:generated-streaming-stress:${'b'.repeat(64)}`,
      capturedAt: INSTANT,
      title: 'Generated fixture; no source rows',
      canonicalUrl: 'https://stress.invalid/terms',
      termsSha256: 'b'.repeat(64),
      redistribution: 'approved',
      containsPersonalData: false,
      attribution: ['Generated stress fixture'],
      limitations: [],
    },
    ratePolicy: {
      maxRequestsPerWindow: 1,
      windowMs: 1_000,
      maxConcurrency: 1,
      maxAttempts: 1,
      initialBackoffMs: 0,
      maxBackoffMs: 1,
      jitter: 'none',
      respectRetryAfter: true,
    },
    freshnessSemantics: 'Frozen generated stress snapshot',
  });

  public describe() {
    return this.#descriptor;
  }

  public discover(): Promise<DiscoveryResult> {
    return Promise.resolve({
      sourceId: SOURCE_ID,
      discoveredAt: INSTANT,
      resources: [
        {
          requestKey: 'million-records',
          url: 'https://stress.invalid/million.csv',
          sourceAsOf: { state: 'reported', at: INSTANT },
          expectedRecords: RECORDS,
          mediaTypes: ['text/csv'],
          continuationToken: null,
        },
      ],
      complete: true,
      limitations: [],
    });
  }

  public plan(request: AcquisitionRequest, discovery: DiscoveryResult) {
    return Promise.resolve(
      acquisitionPlanSchema.parse({
        sourceId: SOURCE_ID,
        snapshotId: request.snapshotId,
        contractVersion: '2.0.0',
        plannedAt: INSTANT,
        items: [
          {
            requestKey: discovery.resources[0]?.requestKey,
            sequence: 0,
            method: 'GET',
            url: discovery.resources[0]?.url,
            encoding: 'csv',
            expectedMediaTypes: ['text/csv'],
          },
        ],
      }),
    );
  }

  public async *acquire(
    plan: AcquisitionPlan,
    _checkpoint: never,
    context: StreamingAcquisitionContext,
  ) {
    const item = plan.items[0];
    if (item === undefined) throw new Error('Generated stress plan item is missing');
    const logicalKey = 'raw/generated-streaming-stress/million.csv';
    const stored =
      (await context.artifactStore.headByLogicalKey(logicalKey)) ??
      (await context.artifactStore.putImmutableStreaming({
        logicalKey,
        mediaType: 'text/csv',
        body: RAW_BYTES,
        expectedSha256: RAW_SHA256,
        metadata: { sourceId: SOURCE_ID, requestKey: item.requestKey },
        ifAbsent: true,
      }));
    const metadata = acquiredArtifactSchema.parse({
      artifactId: `sc:artifact:sha256:${stored.sha256}`,
      sourceId: SOURCE_ID,
      snapshotId: plan.snapshotId,
      retrievedAt: INSTANT,
      sourceAsOf: { state: 'reported', at: INSTANT },
      request: {
        requestKey: item.requestKey,
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
        schemaName: 'generated-million-stress-v2',
        canonicalizationVersion: '1.0.0',
      },
      rawUri: stored.uri,
      licenseSnapshotRef: this.#descriptor.license.licenseSnapshotId,
      visibility: 'public',
    });
    yield createStreamingAcquiredArtifact(metadata, context.artifactStore);
  }

  public async *decode(artifact: AcquiredArtifactSource): AsyncIterable<CsvDecodedRecord> {
    if (artifact.content === undefined) {
      throw new Error('Generated stress requires a streaming v2 acquired artifact');
    }
    for await (const chunk of artifact.content.read()) void chunk;
    for (let ordinal = 0; ordinal < RECORDS; ordinal += 1) {
      this.decodedRecords += 1;
      if (ordinal % MAX_BUFFERED_RECORDS === 0) this.#sampleHeap();
      yield {
        format: 'csv',
        artifactId: artifact.metadata.artifactId,
        ordinal,
        visibility: 'public',
        header: ['ordinal'],
        values: [String(ordinal)],
      };
    }
  }

  public validate(record: CsvDecodedRecord) {
    return Promise.resolve({ status: 'accepted' as const, record, issues: [] });
  }

  public async *normalize(record: CsvDecodedRecord): AsyncIterable<CanonicalMutation> {
    this.normalizedMutations += 1;
    if (record.ordinal % MAX_BUFFERED_RECORDS === 0) this.#sampleHeap();
    yield await Promise.resolve(
      Object.freeze({
        kind: 'generated_streaming_stress_mutation',
        ordinal: record.ordinal,
      }) as unknown as CanonicalMutation,
    );
  }

  public summarize(run: SourceRunObservationV2) {
    this.projectedLogicalSha256 = run.mutations.logicalSha256;
    this.#sampleHeap();
    return Promise.resolve(
      sourceRunSummarySchema.parse({
        sourceId: SOURCE_ID,
        snapshotId: SNAPSHOT_ID,
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

  public sampleHeap(): void {
    this.#sampleHeap();
  }

  #sampleHeap(): void {
    this.peakHeapBytes = Math.max(this.peakHeapBytes, process.memoryUsage().heapUsed);
  }
}

const root = await mkdtemp(join(tmpdir(), 'oracle-million-runner-stress-'));
try {
  const adapter = new MillionRecordAdapter();
  const controller = new AbortController();
  let reconciledMutations = 0;
  const processors: PipelineProcessors = {
    memoryProfile: 'bounded_streaming_v2',
    reconcile: async (mutations) => {
      for await (const mutation of mutations.read()) {
        void mutation;
        reconciledMutations += 1;
        if (reconciledMutations % MAX_BUFFERED_RECORDS === 0) adapter.sampleHeap();
      }
      return { canonical: { count: reconciledMutations }, links: [] };
    },
    deriveFeatures: () => Promise.resolve({}),
    buildMarts: () => Promise.resolve({}),
  };
  const source: SourceConfiguration = {
    adapter,
    snapshotId: SNAPSHOT_ID,
    scope: 'generated million-record stress',
    capability: 'generated_streaming_stress',
    executionMode: 'execute',
    supportState: 'available',
    acquisitionItemCap: null,
    discoveryDenominatorStrategy: 'sum_non_null',
    requiredForCountyCompletion: false,
  };
  const configuration: PipelineConfiguration = {
    runId: RUN_ID,
    pipelineVersion: 'streaming-runner-stress-v2',
    requestedAt: INSTANT,
    profile: {
      name: 'pilot',
      recordCap: null,
      maxConcurrentSources: 1,
      maxBufferedRecords: MAX_BUFFERED_RECORDS,
    },
    sources: [source],
    maximumPhaseAttempts: 1,
  };
  const dependencies: OrchestrationDependencies = {
    artifactStore: new LocalArtifactStore({
      rootDirectory: join(root, 'artifacts'),
      now: () => INSTANT,
    }),
    checkpointStore: new LocalCheckpointStore({ rootDirectory: join(root, 'checkpoints') }),
    analyticalRuntime: { open: () => Promise.reject(new Error('analytical runtime not used')) },
    http: { send: () => Promise.reject(new Error('HTTP not used')) },
    clock: new FixedClock(),
    delay: { wait: () => Promise.resolve() },
    processors,
    signal: controller.signal,
  };
  const result = await runPipeline(configuration, dependencies);
  adapter.sampleHeap();
  const sourceResult = result.manifest.sources[0];
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 'oracle-streaming-runner-stress-v2',
      logicalRecords: adapter.decodedRecords,
      normalizedMutations: adapter.normalizedMutations,
      reconciledMutations,
      configuredMaxBufferedRecords: MAX_BUFFERED_RECORDS,
      observedHighWaterRecords: result.manifest.backpressure.observedHighWaterRecords,
      observedHighWaterActiveRecords: result.manifest.backpressure.observedHighWaterActiveRecords,
      observedHighWaterBufferedEvents: result.manifest.backpressure.observedHighWaterBufferedEvents,
      observedHighWaterCombinedRecordsAndEvents:
        result.manifest.backpressure.observedHighWaterCombinedRecordsAndEvents,
      activeRecordsAtCompletion: result.manifest.backpressure.activeRecordsAtCompletion,
      bufferedEventsAtCompletion: result.manifest.backpressure.bufferedEventsAtCompletion,
      totalBudgetAcquisitions: result.manifest.backpressure.totalBudgetAcquisitions,
      peakHeapBytes: adapter.peakHeapBytes,
      logicalSha256: adapter.projectedLogicalSha256,
      terminalState: sourceResult?.terminalState ?? null,
      coverageRatio: sourceResult?.coverage.ratio ?? null,
    })}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
