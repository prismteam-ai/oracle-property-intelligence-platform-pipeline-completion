import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

import { LocalArtifactStore } from '@oracle/artifacts/implementations/local-artifact-store';
import { LocalCheckpointStore } from '@oracle/artifacts/implementations/local-checkpoint-store';
import {
  canonicalMutationSchema,
  type CanonicalMutation,
} from '@oracle/contracts/canonical/mutation';
import {
  artifactIdSchema,
  runIdSchema,
  snapshotIdSchema,
  sourceIdSchema,
} from '@oracle/contracts/ids';
import { acquiredArtifactSchema } from '@oracle/contracts/source';
import { normalizePropertyRecord } from '@oracle/canonical-model/normalizers/property';
import type { CanonicalNormalizationContext } from '@oracle/canonical-model/normalizers/core';

import { canonicalJson } from './canonical-json.js';
import { createBoundedPipelineProcessors } from './bounded-processors.js';
import type { ChunkSequence } from './chunks.js';
import type {
  BoundedCountyProcessingRequest,
  PipelineConfiguration,
  SourceExecutionManifest,
} from './types.js';

const NOW = '2026-07-18T10:00:00.000Z';
const DEFAULT_RECORDS = 1_000_000;
const PAGE_RECORDS = 2_048;
const SOURCE_ID = sourceIdSchema.parse('sc:source:bounded-county-offline-stress');
const SNAPSHOT_ID = snapshotIdSchema.parse(
  `sc:snapshot:bounded-county-offline-stress:${'a'.repeat(64)}`,
);
const RUN_ID = runIdSchema.parse(`sc:run:${'d'.repeat(64)}`);
const RAW_BODY = new TextEncoder().encode('bounded county offline stress acquisition\n');
const RAW_SHA256 = createHash('sha256').update(RAW_BODY).digest('hex');
const ARTIFACT_ID = artifactIdSchema.parse(`sc:artifact:sha256:${RAW_SHA256}`);
const LICENSE_REF = `sc:license:bounded-county-offline-stress:${'b'.repeat(64)}`;

const records = parsePositiveInteger(process.env.ORACLE_BOUNDED_STRESS_RECORDS, DEFAULT_RECORDS);
const outputPageRecords = parsePositiveInteger(
  process.env.ORACLE_BOUNDED_STRESS_OUTPUT_PAGE_RECORDS,
  512,
);
if (outputPageRecords > 512) {
  throw new RangeError('ORACLE_BOUNDED_STRESS_OUTPUT_PAGE_RECORDS cannot exceed 512');
}
const root = process.env.ORACLE_BOUNDED_STRESS_ROOT
  ? resolve(process.env.ORACLE_BOUNDED_STRESS_ROOT)
  : await mkdtemp(join(tmpdir(), 'oracle-bounded-county-stress-'));
await mkdir(root, { recursive: true });

let sampledPeakRssBytes = process.memoryUsage().rss;
const sample = (): void => {
  sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss);
};
const sampler = setInterval(sample, 100);
sampler.unref();
const startedAt = Date.now();

try {
  const inventory = await materializeMutationPages(join(root, 'mutation-pages'), records, sample);
  const sequence = chunkSequence(inventory.chunks, inventory.logicalSha256);
  const artifactStore = new LocalArtifactStore({
    rootDirectory: join(root, 'artifacts'),
    now: () => NOW,
  });
  const storedRaw =
    (await artifactStore.headByLogicalKey('stress/acquisition/source.txt')) ??
    (await artifactStore.putImmutable({
      logicalKey: 'stress/acquisition/source.txt',
      mediaType: 'text/plain',
      body: RAW_BODY,
      expectedSha256: RAW_SHA256,
      metadata: { proofScope: 'offline-processBoundedCounty-full-profile' },
      ifAbsent: true,
    }));
  if (storedRaw.sha256 !== RAW_SHA256 || storedRaw.byteSize !== RAW_BODY.byteLength) {
    throw new Error('Offline stress acquisition orphan changed');
  }
  const acquired = acquiredArtifactSchema.parse({
    artifactId: ARTIFACT_ID,
    sourceId: SOURCE_ID,
    snapshotId: SNAPSHOT_ID,
    retrievedAt: NOW,
    sourceAsOf: { state: 'reported', at: NOW },
    request: {
      requestKey: 'offline-stress',
      method: 'GET',
      url: 'https://stress.invalid/bounded-county-source',
      headers: [],
      bodySha256: null,
      attempt: 1,
    },
    response: {
      httpStatus: 200,
      etag: null,
      lastModified: NOW,
      finalUrl: 'https://stress.invalid/bounded-county-source',
    },
    mediaType: 'text/plain',
    encoding: 'other',
    byteSize: storedRaw.byteSize,
    sha256: storedRaw.sha256,
    schemaFingerprint: {
      algorithm: 'sha256',
      value: 'c'.repeat(64),
      schemaName: 'offline-bounded-county-property-v1',
      canonicalizationVersion: '1.0.0',
    },
    rawUri: storedRaw.uri,
    licenseSnapshotRef: LICENSE_REF,
    visibility: 'public',
  });
  const configuration = Object.freeze({
    runId: RUN_ID,
    pipelineVersion: '1.0.0',
    requestedAt: NOW,
    profile: Object.freeze({
      name: 'full' as const,
      recordCap: null,
      maxConcurrentSources: 1,
      maxBufferedRecords: 512,
    }),
    sources: Object.freeze([]),
    maximumPhaseAttempts: 1,
  }) satisfies PipelineConfiguration;
  const source = sourceManifest(records);
  const checkpointStore = new LocalCheckpointStore({ rootDirectory: join(root, 'checkpoints') });
  const processor = createBoundedPipelineProcessors({
    outputDirectory: join(root, 'output'),
    scratchDirectory: join(root, 'scratch'),
    partitionCount: 32,
    budget: {
      policyVersion: 'bounded-process-budget-v1',
      maxBufferedRecords: 512,
      maxBufferedBytes: 8 * 1024 * 1024,
      maxRssBytes: 512 * 1024 * 1024,
      duckdbMemoryBytes: 128 * 1024 * 1024,
      runtimeReserveBytes: 128 * 1024 * 1024,
      maxOpenFiles: 64,
      maxWorkers: 1,
      maxRecordsPerOutputChunk: outputPageRecords,
      maxBytesPerOutputChunk: 8 * 1024 * 1024,
      rssSampleIntervalRecords: 1_000,
    },
  });
  const request: BoundedCountyProcessingRequest = Object.freeze({
    configuration,
    mutationSources: Object.freeze([
      Object.freeze({ sourceId: SOURCE_ID, snapshotId: SNAPSHOT_ID, sequence }),
    ]),
    acquiredSources: Object.freeze([
      Object.freeze({ sourceId: SOURCE_ID, artifacts: Object.freeze([acquired]) }),
    ]),
    sources: Object.freeze([source]),
    existing: Object.freeze({
      reconcileArtifact: null,
      featureArtifact: null,
      martArtifact: null,
    }),
    artifactStore,
    checkpointStore,
    clock: Object.freeze({ now: () => NOW }),
    signal: new AbortController().signal,
  });
  const result = await processor.processBoundedCounty?.(request);
  if (result === undefined) throw new Error('Bounded county processor was not configured');
  sample();
  const resourcePeakRssBytes = process.resourceUsage().maxRSS * 1024;
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 'oracle-process-bounded-county-stress-v1',
      proofScope: 'offline_full_profile_processBoundedCounty_downstream',
      requestedRecords: records,
      mutationRecords: sequence.recordCount,
      mutationPages: sequence.chunks.length,
      configuredOutputPageRecords: outputPageRecords,
      configuredMaxRssBytes: 512 * 1024 * 1024,
      sampledPeakRssBytes,
      resourcePeakRssBytes,
      under512MiB: Math.max(sampledPeakRssBytes, resourcePeakRssBytes) <= 512 * 1024 * 1024,
      countyCompletionClaim: result.countyCompletionClaim,
      reconcileDescriptorSha256: result.reconcileArtifact.sha256,
      featureDescriptorSha256: result.featureArtifact.sha256,
      martDescriptorSha256: result.martArtifact.sha256,
      elapsedMilliseconds: Date.now() - startedAt,
      retainedProofRoot: root,
    })}\n`,
  );
} finally {
  clearInterval(sampler);
}

type StressChunk = ChunkSequence<CanonicalMutation>['chunks'][number];

async function materializeMutationPages(
  directory: string,
  recordCount: number,
  sampleRss: () => void,
): Promise<Readonly<{ chunks: readonly StressChunk[]; logicalSha256: string }>> {
  await mkdir(directory, { recursive: true });
  const chunks: StressChunk[] = [];
  const logical = createHash('sha256');
  let mutationOrdinal = 0;
  for (let pageStart = 0; pageStart < recordCount; pageStart += PAGE_RECORDS) {
    const sequence = chunks.length;
    const path = join(directory, `${sequence.toString().padStart(8, '0')}.ndjson`);
    const handle = await open(path, 'w');
    const physical = createHash('sha256');
    let byteSize = 0;
    let pageMutations = 0;
    const firstOrdinal = mutationOrdinal;
    try {
      const pageEnd = Math.min(recordCount, pageStart + PAGE_RECORDS);
      for (let recordOrdinal = pageStart; recordOrdinal < pageEnd; recordOrdinal += 1) {
        const context = normalizationContext(recordOrdinal, mutationOrdinal);
        const mutations = normalizePropertyRecord(
          {
            apn: recordOrdinal.toString().padStart(8, '0'),
            jurisdiction: 'Santa Clara',
            address: null,
            unit: null,
            parcelGeometry: null,
            landAreaSquareMeters: null,
            yearBuilt: 1950 + (recordOrdinal % 75),
            effectiveYearBuilt: null,
          },
          context,
        );
        for (const mutation of mutations) {
          const line = Buffer.from(`${canonicalJson(mutation)}\n`, 'utf8');
          await handle.write(line);
          physical.update(line);
          logical.update(line);
          byteSize += line.byteLength;
          pageMutations += 1;
          mutationOrdinal += 1;
        }
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    const digest = physical.digest('hex');
    chunks.push(
      Object.freeze({
        schemaVersion: '2.0.0' as const,
        sequence,
        firstOrdinal,
        lastOrdinal: mutationOrdinal - 1,
        recordCount: pageMutations,
        logicalKey: `stress/mutations/${sequence.toString().padStart(8, '0')}.ndjson`,
        uri: pathToFileURL(path).href,
        mediaType: 'application/x-ndjson' as const,
        byteSize,
        sha256: digest,
        visibility: 'public' as const,
        licenseSnapshotRef: LICENSE_REF,
        resumeCursor: null,
      }),
    );
    sampleRss();
  }
  return Object.freeze({
    chunks: Object.freeze(chunks),
    logicalSha256: logical.digest('hex'),
  });
}

function chunkSequence(
  chunks: readonly StressChunk[],
  logicalSha256: string,
): ChunkSequence<CanonicalMutation> {
  const recordCount = chunks.reduce((total, chunk) => total + chunk.recordCount, 0);
  return Object.freeze({
    schemaVersion: '2.0.0',
    recordCount,
    logicalSha256,
    chunks,
    read: async function* () {
      for (const chunk of chunks) {
        const lines = createInterface({
          input: createReadStream(new URL(chunk.uri)),
          crlfDelay: Infinity,
        });
        for await (const line of lines) {
          if (line.length > 0) yield canonicalMutationSchema.parse(JSON.parse(line));
        }
      }
    },
  });
}

function normalizationContext(
  recordOrdinal: number,
  sequenceStart: number,
): CanonicalNormalizationContext {
  return Object.freeze({
    sourceId: SOURCE_ID,
    snapshotId: SNAPSHOT_ID,
    artifactId: ARTIFACT_ID,
    runId: RUN_ID,
    sourceRecordKey: `property-${recordOrdinal.toString().padStart(8, '0')}`,
    sourceRecordSha256: createHash('sha256').update(String(recordOrdinal)).digest('hex'),
    rawPointer: `/properties/${recordOrdinal}`,
    observedAt: NOW,
    sourceAsOf: NOW,
    transformName: 'offline-bounded-county-stress-normalizer',
    transformVersion: '1.0.0',
    authorityRank: 100,
    confidence: 1,
    visibility: 'public',
    sequenceStart,
  });
}

function sourceManifest(accepted: number): SourceExecutionManifest {
  return Object.freeze({
    sourceId: SOURCE_ID,
    snapshotId: SNAPSHOT_ID,
    snapshotIdentity: Object.freeze({
      intentId: SNAPSHOT_ID,
      observedContentId: SNAPSHOT_ID,
      method: 'configured_intent_plus_observed_content_v1' as const,
    }),
    scope: 'offline bounded county stress fixture',
    capability: 'santa_clara_parcels',
    executionMode: 'execute',
    supportState: 'available',
    requiredForCountyCompletion: true,
    terminalState: 'complete',
    sourceHash: RAW_SHA256,
    sourceAsOf: NOW,
    license: Object.freeze({
      redistribution: 'approved' as const,
      containsPersonalData: false,
      defaultVisibility: 'public' as const,
    }),
    schemaHashes: Object.freeze(['c'.repeat(64)]),
    checkpointRevision: null,
    coverage: Object.freeze({
      expectedRecords: accepted,
      observedRecords: accepted,
      acceptedRecords: accepted,
      quarantinedRecords: 0,
      denominatorMethod: 'configured' as const,
      ratio: 1,
    }),
    timings: Object.freeze([]),
    artifacts: Object.freeze([]),
    limitations: Object.freeze([]),
    errorCodes: Object.freeze([]),
    summary: null,
  });
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000_000) {
    throw new RangeError('ORACLE_BOUNDED_STRESS_RECORDS must be a positive safe integer');
  }
  return value;
}
