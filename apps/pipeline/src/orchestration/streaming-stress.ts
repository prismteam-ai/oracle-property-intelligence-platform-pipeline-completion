import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalArtifactStore } from '@oracle/artifacts/implementations/local-artifact-store';
import { LocalCheckpointStore } from '@oracle/artifacts/implementations/local-checkpoint-store';
import type { CanonicalMutation } from '@oracle/contracts/canonical/mutation';
import {
  artifactIdSchema,
  runIdSchema,
  snapshotIdSchema,
  sourceIdSchema,
} from '@oracle/contracts/ids';
import { normalizePropertyRecord } from '@oracle/canonical-model/normalizers/property';
import { testContext } from '@oracle/canonical-model/normalizers/test-context.test-support';
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
const RECORDS = 20_000;
const MAX_BUFFERED_RECORDS = 8;
const MAX_RSS_BYTES = 512 * 1024 * 1024;
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
  public peakRssBytes = process.memoryUsage().rss;

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
    const apn = `${String(100 + Math.floor(record.ordinal / 100_000)).padStart(3, '0')}-${String(
      Math.floor(record.ordinal / 1_000) % 100,
    ).padStart(2, '0')}-${String(record.ordinal % 1_000).padStart(3, '0')}`;
    const sourceRecordSha256 = createHash('sha256')
      .update(`parcel:${record.ordinal}`)
      .digest('hex');
    const mutations = normalizePropertyRecord(
      {
        apn,
        jurisdiction: 'SANTA CLARA',
        address: {
          line1: `${100 + (record.ordinal % 9_000)} Assessment Avenue`,
          locality: 'San Jose',
          postalCode: '95113',
          location: {
            type: 'Point',
            coordinates: [
              -121.9 + (record.ordinal % 100) / 10_000,
              37.3 + (record.ordinal % 100) / 10_000,
            ],
          },
        },
        unit: null,
        parcelGeometry: null,
        landAreaSquareMeters: 450 + (record.ordinal % 1_000),
        yearBuilt: 1900 + (record.ordinal % 125),
        effectiveYearBuilt: null,
      },
      testContext({
        sourceId: SOURCE_ID,
        snapshotId: SNAPSHOT_ID,
        artifactId: artifactIdSchema.parse(`sc:artifact:sha256:${RAW_SHA256}`),
        runId: RUN_ID,
        sourceRecordKey: `parcel-${record.ordinal}`,
        sourceRecordSha256,
        rawPointer: `/parcels/${record.ordinal}`,
        transformName: 'parcel-ledger-stress',
        sequenceStart: record.ordinal * 32,
      }),
    );
    const mutation = mutations.find(({ kind }) => kind === 'entity_upsert');
    if (mutation === undefined) throw new Error('Parcel stress normalizer omitted entity mutation');
    yield await Promise.resolve(mutation);
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
    const memory = process.memoryUsage();
    this.peakHeapBytes = Math.max(this.peakHeapBytes, memory.heapUsed);
    this.peakRssBytes = Math.max(this.peakRssBytes, memory.rss);
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
  const checkpointStore = new LocalCheckpointStore({ rootDirectory: join(root, 'checkpoints') });
  const dependencies: OrchestrationDependencies = {
    artifactStore: new LocalArtifactStore({
      rootDirectory: join(root, 'artifacts'),
      now: () => INSTANT,
    }),
    checkpointStore,
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
  const checkpoint = await checkpointStore.load(`pipeline-run:${RUN_ID}`);
  const persistedSource = ((
    checkpoint?.payload as Readonly<{ sources?: readonly Record<string, unknown>[] }>
  ).sources ?? [])[0];
  const mutationLedger = persistedSource?.mutationLedger as
    Readonly<{ totalRecords: number; totalChunks: number }> | undefined;
  const normalizationLedger = persistedSource?.normalizationLedger as
    Readonly<{ totalRecords: number; totalChunks: number }> | undefined;
  const assertions: readonly [boolean, string][] = [
    [sourceResult?.terminalState === 'complete', 'source did not complete'],
    [adapter.decodedRecords === RECORDS, 'decoded record count changed'],
    [adapter.normalizedMutations === RECORDS, 'normalization count changed'],
    [reconciledMutations === RECORDS, 'projection read count changed'],
    [adapter.projectedLogicalSha256 !== null, 'projection hash is missing'],
    [(mutationLedger?.totalRecords ?? 0) === RECORDS, 'mutation ledger is not truthful'],
    [(mutationLedger?.totalChunks ?? 0) > 0, 'mutation ledger has no physical chunks'],
    [(normalizationLedger?.totalRecords ?? 0) > RECORDS, 'event ledger was not materialized'],
    [(normalizationLedger?.totalChunks ?? 0) > 0, 'event ledger has no physical chunks'],
    [adapter.peakRssBytes <= MAX_RSS_BYTES, 'peak RSS exceeded the 512 MiB gate'],
    [result.manifest.backpressure.activeRecordsAtCompletion === 0, 'record leases leaked'],
    [result.manifest.backpressure.bufferedEventsAtCompletion === 0, 'event leases leaked'],
  ];
  const failedAssertions = assertions.filter(([passed]) => !passed).map(([, message]) => message);
  if (failedAssertions.length > 0) {
    throw new Error(`Streaming ledger stress failed: ${failedAssertions.join('; ')}`);
  }
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 'oracle-streaming-runner-foundation-stress-v3',
      pass: true,
      proofScope: 'foundation_only_acquisition_normalization_runner',
      downstreamCountyProof: false,
      logicalRecords: adapter.decodedRecords,
      normalizedMutations: adapter.normalizedMutations,
      reconciledMutations,
      configuredMaxBufferedRecords: MAX_BUFFERED_RECORDS,
      maximumRssBytes: MAX_RSS_BYTES,
      mutationLedgerRecords: mutationLedger?.totalRecords ?? null,
      mutationLedgerChunks: mutationLedger?.totalChunks ?? null,
      normalizationLedgerRecords: normalizationLedger?.totalRecords ?? null,
      normalizationLedgerChunks: normalizationLedger?.totalChunks ?? null,
      observedHighWaterRecords: result.manifest.backpressure.observedHighWaterRecords,
      observedHighWaterActiveRecords: result.manifest.backpressure.observedHighWaterActiveRecords,
      observedHighWaterBufferedEvents: result.manifest.backpressure.observedHighWaterBufferedEvents,
      observedHighWaterCombinedRecordsAndEvents:
        result.manifest.backpressure.observedHighWaterCombinedRecordsAndEvents,
      activeRecordsAtCompletion: result.manifest.backpressure.activeRecordsAtCompletion,
      bufferedEventsAtCompletion: result.manifest.backpressure.bufferedEventsAtCompletion,
      totalBudgetAcquisitions: result.manifest.backpressure.totalBudgetAcquisitions,
      peakHeapBytes: adapter.peakHeapBytes,
      peakRssBytes: adapter.peakRssBytes,
      logicalSha256: adapter.projectedLogicalSha256,
      terminalState: sourceResult?.terminalState ?? null,
      coverageRatio: sourceResult?.coverage.ratio ?? null,
    })}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
