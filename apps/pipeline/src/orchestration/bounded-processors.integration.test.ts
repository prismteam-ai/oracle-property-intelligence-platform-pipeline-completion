import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DuckDBInstance } from '@duckdb/node-api';
import { LocalArtifactStore } from '@oracle/artifacts/implementations/local-artifact-store';
import { LocalCheckpointStore } from '@oracle/artifacts/implementations/local-checkpoint-store';
import {
  artifactIdSchema,
  runIdSchema,
  snapshotIdSchema,
  sourceIdSchema,
} from '@oracle/contracts/ids';
import type { CanonicalMutation } from '@oracle/contracts/canonical/mutation';
import { acquiredArtifactSchema, type AcquiredArtifact } from '@oracle/contracts/source';
import { normalizePropertyRecord } from '@oracle/canonical-model/normalizers/property';
import {
  normalizeHydroFeatureRecord,
  normalizePlaceRecord,
  normalizeTransitStopRecord,
} from '@oracle/canonical-model/normalizers/geospatial';
import { testContext } from '@oracle/canonical-model/normalizers/test-context.test-support';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from './canonical-json.js';
import { readJsonArtifact } from './artifacts.js';
import {
  boundedCandidateAddressNumber,
  createBoundedPipelineProcessors,
  normalizeBoundedIndexValue,
} from './bounded-processors.js';
import type { ChunkSequence } from './chunks.js';
import type {
  BoundedCountyProcessingRequest,
  PipelineConfiguration,
  SourceExecutionManifest,
} from './types.js';

const NOW = '2026-07-18T08:00:00.000Z';
const SOURCE_ID = sourceIdSchema.parse('sc:source:test-source');
const SNAPSHOT_ID = snapshotIdSchema.parse(`sc:snapshot:test-source:${'1'.repeat(64)}`);
const RUN_ID = runIdSchema.parse(`sc:run:${'3'.repeat(64)}`);
const FAILED_SOURCE_ID = sourceIdSchema.parse('sc:source:test-failed-source');
const FAILED_SNAPSHOT_ID = snapshotIdSchema.parse(
  `sc:snapshot:test-failed-source:${'2'.repeat(64)}`,
);

describe('bounded_streaming_v2 pipeline composition', () => {
  it('freezes Unicode, whitespace, locale, and address-number index normalization', () => {
    expect(normalizeBoundedIndexValue('  ＭＡＩＮ\t  STRASSE  ')).toBe('main strasse');
    expect(boundedCandidateAddressNumber(' １２３Ａ  Main Street ')).toBe('123a');
    expect(boundedCandidateAddressNumber('Main Street')).toBeNull();
  });

  it('runs canonical, reconciliation, feature, and portable release stages without row arrays', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oracle-bounded-pipeline-'));
    const mutations = normalizePropertyRecord(
      {
        apn: '123-45-678',
        jurisdiction: 'Santa Clara',
        address: null,
        unit: null,
        parcelGeometry: null,
        landAreaSquareMeters: null,
      },
      testContext({
        sourceId: SOURCE_ID,
        snapshotId: SNAPSHOT_ID,
        artifactId: acquiredArtifactId(SOURCE_ID, SNAPSHOT_ID),
        runId: RUN_ID,
      }),
    );
    const sequence = chunkSequence(mutations);
    const artifactStore = new LocalArtifactStore({
      rootDirectory: join(root, 'artifacts'),
      now: () => NOW,
    });
    const checkpointStore = new LocalCheckpointStore({ rootDirectory: join(root, 'checkpoints') });
    const source = sourceManifest(mutations.length);
    const failedSource = Object.freeze({
      ...sourceManifestFor(FAILED_SOURCE_ID, FAILED_SNAPSHOT_ID, 'county_clerk_transfers', 0),
      supportState: 'blocked' as const,
      terminalState: 'failed' as const,
      coverage: Object.freeze({
        expectedRecords: 1,
        observedRecords: 0,
        acceptedRecords: 0,
        quarantinedRecords: 0,
        denominatorMethod: 'configured' as const,
        ratio: 0,
      }),
      limitations: Object.freeze(['Fixture transfer source failed before acquisition.']),
      errorCodes: Object.freeze(['FIXTURE_ACQUISITION_FAILED']),
    }) satisfies SourceExecutionManifest;
    const trustedArtifact = await acquiredArtifact(artifactStore, SOURCE_ID, SNAPSHOT_ID);
    const configuration = {
      runId: RUN_ID,
      pipelineVersion: '2.0.0',
      requestedAt: NOW,
      profile: {
        name: 'full',
        recordCap: null,
        maxConcurrentSources: 1,
        maxBufferedRecords: 16,
      },
      sources: [],
      maximumPhaseAttempts: 1,
    } as unknown as PipelineConfiguration;
    const crashPoints = [
      'after_mutation_spool',
      'after_canonical_partition',
      'after_link_index',
      'after_reconciliation_relation',
      'after_feature_chunk',
      'after_mart_relation',
      'before_finalize',
    ] as const;
    let crashIndex = 0;
    const createProcessor = () =>
      createBoundedPipelineProcessors({
        outputDirectory: join(root, 'output'),
        scratchDirectory: join(root, 'scratch'),
        partitionCount: 16,
        budget: {
          policyVersion: 'bounded-process-budget-v1',
          maxBufferedRecords: 16,
          maxBufferedBytes: 1024 * 1024,
          maxRssBytes: 1024 * 1024 * 1024,
          duckdbMemoryBytes: 64 * 1024 * 1024,
          runtimeReserveBytes: 128 * 1024 * 1024,
          maxOpenFiles: 16,
          maxWorkers: 1,
          maxRecordsPerOutputChunk: 8,
          maxBytesPerOutputChunk: 1024 * 1024,
          rssSampleIntervalRecords: 1,
        },
        crash: (point) => {
          if (point === crashPoints[crashIndex]) {
            crashIndex += 1;
            throw new Error(`injected ${point} crash`);
          }
        },
      });
    const request: BoundedCountyProcessingRequest = {
      configuration,
      mutationSources: [{ sourceId: SOURCE_ID, snapshotId: SNAPSHOT_ID, sequence }],
      acquiredSources: [
        {
          sourceId: SOURCE_ID,
          artifacts: [trustedArtifact],
        },
      ],
      sources: [source],
      existing: { reconcileArtifact: null, featureArtifact: null, martArtifact: null },
      artifactStore,
      checkpointStore,
      clock: { now: () => NOW },
      signal: new AbortController().signal,
    };
    const incrementalConfiguration = {
      ...configuration,
      profile: { ...configuration.profile, name: 'incremental' as const },
    } satisfies PipelineConfiguration;
    await expect(
      createProcessor().processBoundedCounty?.({
        ...request,
        configuration: incrementalConfiguration,
      }),
    ).rejects.toThrow('incremental processing is fail-closed');

    await expect(
      createProcessor().processBoundedCounty?.({
        ...request,
        sources: [source, failedSource],
      }),
    ).rejects.toThrow(FAILED_SOURCE_ID);

    const missingArtifact = acquiredArtifactSchema.parse({
      ...trustedArtifact,
      rawUri: pathToFileURL(join(root, 'artifacts', 'nonexistent-acquired-object.json')).href,
    });
    await expect(
      createProcessor().processBoundedCounty?.({
        ...request,
        acquiredSources: [{ sourceId: SOURCE_ID, artifacts: [missingArtifact] }],
      }),
    ).rejects.toThrow('Acquired object is missing');

    const corruptingStore: BoundedCountyProcessingRequest['artifactStore'] = Object.freeze({
      putImmutable: artifactStore.putImmutable.bind(artifactStore),
      putImmutableStreaming: artifactStore.putImmutableStreaming.bind(artifactStore),
      head: artifactStore.head.bind(artifactStore),
      headByLogicalKey: artifactStore.headByLogicalKey.bind(artifactStore),
      read: (uri: string, range?: Readonly<{ start: number; endInclusive: number }>) =>
        uri === trustedArtifact.rawUri
          ? oneBuffer(Buffer.from('corrupted acquired bytes', 'utf8'))
          : artifactStore.read(uri, range),
    });
    await expect(
      createProcessor().processBoundedCounty?.({ ...request, artifactStore: corruptingStore }),
    ).rejects.toThrow('Acquired object bytes changed');

    const runRoot = join(root, 'scratch', createHash('sha256').update(RUN_ID).digest('hex'));
    await mkdir(runRoot, { recursive: true });
    const leasePath = join(runRoot, 'bounded-run-lease.json');
    const leaseHolder = spawn(
      process.execPath,
      [
        '-e',
        "const fs=require('node:fs');const path=process.argv[1];const record={format:'oracle-bounded-run-fence-v1',runId:process.argv[2],token:'a'.repeat(64),pid:process.pid};fs.writeFileSync(path,JSON.stringify(record)+'\\n');process.stdout.write('ready\\n');setInterval(()=>{},1000);",
        leasePath,
        RUN_ID,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await once(leaseHolder.stdout, 'data');
    try {
      await expect(createProcessor().processBoundedCounty?.(request)).rejects.toThrow(
        'already leased by process',
      );
    } finally {
      leaseHolder.kill();
      await once(leaseHolder, 'exit');
    }
    for (const point of crashPoints) {
      await expect(createProcessor().processBoundedCounty?.(request)).rejects.toThrow(
        `injected ${point} crash`,
      );
    }
    const first = await createProcessor().processBoundedCounty?.(request);
    expect(first).toMatchObject({ countyCompletionClaim: false });
    expect(first?.reconcileArtifact.byteSize).toBeLessThan(64 * 1024);
    expect(first?.featureArtifact.byteSize).toBeLessThan(64 * 1024);
    expect(first?.martArtifact.byteSize).toBeLessThan(64 * 1024);
    if (first === undefined) throw new Error('bounded processor did not return a result');
    const descriptor = (await readJsonArtifact(artifactStore, first.martArtifact)) as Readonly<{
      releaseDirectory: string;
    }>;
    const manifest = JSON.parse(
      await readFile(
        join(root, 'output', descriptor.releaseDirectory, 'release-manifest.json'),
        'utf8',
      ),
    ) as Readonly<{
      artifacts: readonly Readonly<{
        visibility: string;
        relation: string;
        rowCount: number;
        relativePath: string;
        sourceLineage: readonly Readonly<{ sourceId: string }>[];
      }>[];
    }>;
    const releaseEvidence = JSON.parse(
      await readFile(
        join(root, 'output', descriptor.releaseDirectory, 'release-evidence.json'),
        'utf8',
      ),
    ) as Readonly<{
      runStatus: string;
      releaseScope: string;
      countyCompletionClaim: boolean;
    }>;
    expect(releaseEvidence).toMatchObject({
      runStatus: 'succeeded',
      releaseScope: 'partial_county',
      countyCompletionClaim: false,
    });
    const rowCount = (visibility: string, relation: string): number =>
      manifest.artifacts.find(
        (artifact) => artifact.visibility === visibility && artifact.relation === relation,
      )?.rowCount ?? -1;
    expect(rowCount('public', 'property_query')).toBe(1);
    expect(rowCount('restricted', 'property_query')).toBe(1);
    expect(rowCount('public', 'property_evidence')).toBe(6);
    expect(rowCount('restricted', 'property_evidence')).toBe(6);
    const publicPipelineRun = manifest.artifacts.find(
      ({ visibility, relation }) => visibility === 'public' && relation === 'pipeline_runs',
    );
    if (publicPipelineRun === undefined) throw new Error('public pipeline_runs is missing');
    expect(publicPipelineRun.sourceLineage.map(({ sourceId }) => sourceId)).toEqual([SOURCE_ID]);
    const pipelineRows = await readParquetRows(
      join(root, 'output', descriptor.releaseDirectory, publicPipelineRun.relativePath),
    );
    expect(pipelineRows).toHaveLength(1);
    expect(pipelineRows[0]?.status).toBe('succeeded');
    expect(JSON.parse(String(pipelineRows[0]?.source_ids_json))).toEqual([SOURCE_ID]);
    const durable = await checkpointStore.load(`bounded-processing:${RUN_ID}`);
    const checkpoint = durable?.payload as
      | Readonly<{
          completedStages: readonly Readonly<{
            stage: string;
            outputManifestSha256: string;
          }>[];
          finalization: Readonly<{ state: string }> | null;
        }>
      | undefined;
    expect(checkpoint?.completedStages.map(({ stage }) => stage)).toEqual([
      'partition_mutations',
      'reduce_canonical',
      'build_link_index',
      'reconcile_links',
      'derive_features',
      'build_marts',
      'finalize_release',
    ]);
    expect(checkpoint?.finalization?.state).toMatch(/^(?:promoted|adopted_identical_winner)$/u);
    for (const stage of checkpoint?.completedStages ?? []) {
      expect(
        await artifactStore.headByLogicalKey(`bsm/${stage.outputManifestSha256}.json`),
        stage.stage,
      ).toBeDefined();
    }

    const resumed = await createProcessor().processBoundedCounty?.(request);
    expect(resumed?.reconcileArtifact.sha256).toBe(first.reconcileArtifact.sha256);
    expect(resumed?.martArtifact.sha256).toBe(first.martArtifact.sha256);

    const firstCompletedStage = checkpoint?.completedStages[0];
    if (firstCompletedStage === undefined) throw new Error('completed stage is missing');
    const persistedStage = await artifactStore.headByLogicalKey(
      `bsm/${firstCompletedStage.outputManifestSha256}.json`,
    );
    if (persistedStage === undefined) throw new Error('persisted stage object is missing');
    await rm(fileURLToPath(persistedStage.uri), { force: true });
    await expect(createProcessor().processBoundedCounty?.(request)).rejects.toThrow();
  }, 120_000);

  it('emits four honest public proxies and keeps both ownership inquiries unknown on full-profile inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oracle-bounded-inquiries-'));
    const lanes = [
      sourceLane('parcel', 'santa_clara_parcels', (context) =>
        normalizePropertyRecord(
          {
            apn: '123-45-679',
            jurisdiction: 'Santa Clara',
            address: {
              line1: '100 Main Street',
              locality: 'San Jose',
              postalCode: '95113',
              location: { type: 'Point', coordinates: [-121.8863, 37.3382] },
            },
            unit: null,
            parcelGeometry: null,
            landAreaSquareMeters: 500,
            yearBuilt: 1960,
            effectiveYearBuilt: null,
          },
          context,
        ),
      ),
      sourceLane('transit', 'vta_gtfs', (context) =>
        normalizeTransitStopRecord(
          {
            sourceStopId: 'stop-1',
            agencyId: 'VTA',
            stopCode: '1',
            name: 'Downtown Station',
            location: { longitude: -121.887, latitude: 37.339 },
            boardable: true,
          },
          context,
        ),
      ),
      sourceLane('starbucks', 'overture_starbucks', (context) =>
        normalizePlaceRecord(
          {
            sourcePlaceId: 'starbucks-1',
            name: 'Starbucks Downtown',
            categories: ['coffee_shop'],
            brandIdentifiers: ['starbucks'],
            location: { longitude: -121.885, latitude: 37.337 },
            confidence: 0.95,
            validationState: 'verified_open',
          },
          context,
        ),
      ),
      sourceLane('water', 'usgs_hydrography', (context) =>
        normalizeHydroFeatureRecord(
          {
            sourceFeatureId: 'creek-1',
            name: 'Mapped Creek',
            featureType: 'stream',
            geometry: {
              type: 'LineString',
              coordinates: [
                [-121.89, 37.34],
                [-121.88, 37.33],
              ],
            },
          },
          context,
        ),
      ),
    ] as const;
    const artifactStore = new LocalArtifactStore({
      rootDirectory: join(root, 'artifacts'),
      now: () => NOW,
    });
    const checkpointStore = new LocalCheckpointStore({ rootDirectory: join(root, 'checkpoints') });
    const configuration = {
      runId: RUN_ID,
      pipelineVersion: '2.0.0',
      requestedAt: NOW,
      profile: { name: 'full', recordCap: null, maxConcurrentSources: 1, maxBufferedRecords: 32 },
      sources: [],
      maximumPhaseAttempts: 1,
    } as unknown as PipelineConfiguration;
    const processor = createBoundedPipelineProcessors({
      outputDirectory: join(root, 'output'),
      scratchDirectory: join(root, 'scratch'),
      partitionCount: 16,
      budget: {
        policyVersion: 'bounded-process-budget-v1',
        maxBufferedRecords: 32,
        maxBufferedBytes: 1024 * 1024,
        maxRssBytes: 512 * 1024 * 1024,
        duckdbMemoryBytes: 64 * 1024 * 1024,
        runtimeReserveBytes: 128 * 1024 * 1024,
        maxOpenFiles: 16,
        maxWorkers: 1,
        maxRecordsPerOutputChunk: 8,
        maxBytesPerOutputChunk: 1024 * 1024,
        rssSampleIntervalRecords: 1,
      },
    });
    const request: BoundedCountyProcessingRequest = {
      configuration,
      mutationSources: lanes.map(({ sourceId, snapshotId, mutations }) => ({
        sourceId,
        snapshotId,
        sequence: chunkSequence(mutations),
      })),
      acquiredSources: await Promise.all(
        lanes.map(async ({ sourceId, snapshotId }) => ({
          sourceId,
          artifacts: [await acquiredArtifact(artifactStore, sourceId, snapshotId)],
        })),
      ),
      sources: lanes.map(({ sourceId, snapshotId, capability, mutations }) =>
        sourceManifestFor(sourceId, snapshotId, capability, mutations.length),
      ),
      existing: { reconcileArtifact: null, featureArtifact: null, martArtifact: null },
      artifactStore,
      checkpointStore,
      clock: { now: () => NOW },
      signal: new AbortController().signal,
    };
    const result = await processor.processBoundedCounty?.(request);
    expect(result?.countyCompletionClaim).toBe(false);
    const featureFiles = await filesBelow(join(root, 'scratch'), '.ndjson');
    const bundles = (
      await Promise.all(
        featureFiles
          .filter((path) => path.includes('features'))
          .map(async (path) =>
            (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(parseJsonObject),
          ),
      )
    ).flat();
    const evidence = bundles.find((bundle) => bundle.publicEvidence !== undefined)?.publicEvidence;
    if (!Array.isArray(evidence) || !evidence.every(isJsonObject)) {
      throw new Error('feature bundle was not materialized');
    }
    const support = Object.fromEntries(evidence.map((row) => [row.feature, row.supportClass]));
    expect(support).toEqual({
      roof_age: 'proxy',
      ownership_age: 'unknown',
      regional_owner: 'unknown',
      starbucks_walkability: 'proxy',
      transit_walkability: 'proxy',
      water_view_candidate: 'proxy',
    });
    for (const row of evidence) {
      const references = (row.evidence as Readonly<{ sourceReferences: readonly unknown[] }>)
        .sourceReferences;
      const limitations = row.limitations as readonly string[];
      if (row.supportClass === 'proxy') {
        expect(references.length).toBeGreaterThan(0);
        expect(limitations.length).toBeGreaterThan(0);
      } else {
        expect(references).toEqual([]);
        expect(limitations.some((value) => value.includes('absence is not a negative fact'))).toBe(
          true,
        );
      }
    }
  }, 120_000);
});

function sourceLane(
  suffix: string,
  capability: SourceExecutionManifest['capability'],
  build: (context: ReturnType<typeof testContext>) => readonly CanonicalMutation[],
) {
  const sourceId = sourceIdSchema.parse(`sc:source:test-${suffix}`);
  const snapshotId = snapshotIdSchema.parse(
    `sc:snapshot:test-${suffix}:${createHash('sha256').update(suffix).digest('hex')}`,
  );
  const mutations = build(
    testContext({
      sourceId,
      snapshotId,
      artifactId: acquiredArtifactId(sourceId, snapshotId),
      runId: RUN_ID,
    }),
  );
  return Object.freeze({ sourceId, snapshotId, capability, mutations });
}

async function filesBelow(root: string, suffix: string): Promise<readonly string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await filesBelow(path, suffix)));
    else if (path.endsWith(suffix)) result.push(path);
  }
  return result;
}

function parseJsonObject(value: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(value);
  if (!isJsonObject(parsed)) {
    throw new TypeError('Expected an object-valued JSON line');
  }
  return parsed;
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function* oneBuffer(value: Uint8Array): AsyncIterable<Uint8Array> {
  yield await Promise.resolve(value);
}

async function readParquetRows(
  path: string,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    const result = await connection.stream(
      `SELECT * FROM read_parquet('${path.replaceAll("'", "''")}')`,
    );
    const rows: Readonly<Record<string, unknown>>[] = [];
    for await (const batch of result.yieldRowObjectJs()) {
      for (const row of batch) rows.push(row);
    }
    return Object.freeze(rows);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

function chunkSequence<T>(values: readonly T[]): ChunkSequence<T> {
  const body = values.map((value) => `${canonicalJson(value)}\n`).join('');
  const digest = createHash('sha256').update(body).digest('hex');
  return Object.freeze({
    schemaVersion: '2.0.0',
    recordCount: values.length,
    logicalSha256: digest,
    chunks: Object.freeze([
      Object.freeze({
        schemaVersion: '2.0.0' as const,
        sequence: 0,
        firstOrdinal: 0,
        lastOrdinal: values.length - 1,
        recordCount: values.length,
        logicalKey: `fixture/${digest}.ndjson`,
        uri: `file:///fixture/${digest}.ndjson`,
        mediaType: 'application/x-ndjson' as const,
        byteSize: Buffer.byteLength(body),
        sha256: digest,
        visibility: 'public',
        licenseSnapshotRef: 'license:test:v1',
        resumeCursor: null,
      }),
    ]),
    read: async function* () {
      for (const value of values) yield await Promise.resolve(value);
    },
  } satisfies ChunkSequence<T>);
}

function sourceManifest(accepted: number): SourceExecutionManifest {
  return sourceManifestFor(SOURCE_ID, SNAPSHOT_ID, 'santa_clara_parcels', accepted);
}

async function acquiredArtifact(
  artifactStore: LocalArtifactStore,
  sourceId: SourceExecutionManifest['sourceId'],
  snapshotId: SourceExecutionManifest['snapshotId'],
): Promise<AcquiredArtifact> {
  const body = acquiredArtifactBody(sourceId, snapshotId);
  const digest = createHash('sha256').update(body).digest('hex');
  const stored = await artifactStore.putImmutable({
    logicalKey: `trusted/${digest}.json`,
    mediaType: 'application/json',
    body,
    expectedSha256: digest,
    metadata: Object.freeze({ fixture: 'true' }),
    ifAbsent: true,
  });
  return acquiredArtifactSchema.parse({
    artifactId: `sc:artifact:sha256:${digest}`,
    sourceId,
    snapshotId,
    retrievedAt: NOW,
    sourceAsOf: { state: 'reported', at: NOW },
    request: {
      requestKey: `fixture:${sourceId}`,
      method: 'GET',
      url: `https://fixture.invalid/${encodeURIComponent(sourceId)}`,
      headers: [],
      bodySha256: null,
      attempt: 1,
    },
    response: {
      httpStatus: 200,
      etag: null,
      lastModified: NOW,
      finalUrl: `https://fixture.invalid/${encodeURIComponent(sourceId)}`,
    },
    mediaType: 'application/json',
    encoding: 'json',
    byteSize: body.byteLength,
    sha256: digest,
    schemaFingerprint: {
      algorithm: 'sha256',
      value: createHash('sha256').update(`${sourceId}\0schema`).digest('hex'),
      schemaName: 'bounded-offline-fixture-v1',
      canonicalizationVersion: '1.0.0',
    },
    rawUri: stored.uri,
    licenseSnapshotRef: `${sourceId.replace('sc:source:', 'sc:license:')}:${createHash('sha256').update(`${sourceId}\0license`).digest('hex')}`,
    visibility: 'public',
  });
}

function acquiredArtifactBody(
  sourceId: SourceExecutionManifest['sourceId'],
  snapshotId: SourceExecutionManifest['snapshotId'],
): Buffer {
  return Buffer.from(`${sourceId}\0${snapshotId}\0fixture`, 'utf8');
}

function acquiredArtifactId(
  sourceId: SourceExecutionManifest['sourceId'],
  snapshotId: SourceExecutionManifest['snapshotId'],
) {
  const digest = createHash('sha256')
    .update(acquiredArtifactBody(sourceId, snapshotId))
    .digest('hex');
  return artifactIdSchema.parse(`sc:artifact:sha256:${digest}`);
}

function sourceManifestFor(
  sourceId: SourceExecutionManifest['sourceId'],
  snapshotId: SourceExecutionManifest['snapshotId'],
  capability: SourceExecutionManifest['capability'],
  accepted: number,
): SourceExecutionManifest {
  return Object.freeze({
    sourceId,
    snapshotId,
    snapshotIdentity: {
      intentId: snapshotId,
      observedContentId: snapshotId,
      method: 'configured_intent_plus_observed_content_v1' as const,
    },
    scope: 'networkless bounded fixture',
    capability,
    executionMode: 'execute',
    supportState: 'available',
    requiredForCountyCompletion: true,
    terminalState: 'complete',
    sourceHash: '5'.repeat(64),
    sourceAsOf: NOW,
    license: {
      redistribution: 'approved',
      containsPersonalData: false,
      defaultVisibility: 'public',
    },
    schemaHashes: Object.freeze([createHash('sha256').update(`${sourceId}\0schema`).digest('hex')]),
    checkpointRevision: null,
    coverage: {
      expectedRecords: accepted,
      observedRecords: accepted,
      acceptedRecords: accepted,
      quarantinedRecords: 0,
      denominatorMethod: 'configured',
      ratio: 1,
    },
    timings: Object.freeze([]),
    artifacts: Object.freeze([]),
    limitations: Object.freeze([]),
    errorCodes: Object.freeze([]),
    summary: null,
  } satisfies SourceExecutionManifest);
}
