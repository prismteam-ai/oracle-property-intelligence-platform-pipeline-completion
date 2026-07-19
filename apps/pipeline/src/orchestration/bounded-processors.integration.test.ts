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
import { createSharedRecordBudget } from '@oracle/source-adapters/spi/record-budget';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from './canonical-json.js';
import { readJsonArtifact } from './artifacts.js';
import {
  boundedCandidateAddressNumber,
  createBoundedPipelineProcessors,
  normalizeBoundedIndexValue,
} from './bounded-processors.js';
import {
  CanonicalChunkWriter,
  emptyChunkLedger,
  type ChunkReference,
  type ChunkSequence,
} from './chunks.js';
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
const BLOCKED_SOURCE_ID = sourceIdSchema.parse('sc:source:test-blocked-source');
const BLOCKED_SNAPSHOT_ID = snapshotIdSchema.parse(
  `sc:snapshot:test-blocked-source:${'4'.repeat(64)}`,
);
const FAILED_APN = '999-99-999';

describe('bounded_streaming_v2 pipeline composition', () => {
  it('freezes Unicode, whitespace, locale, and address-number index normalization', () => {
    expect(normalizeBoundedIndexValue('  ＭＡＩＮ\t  STRASSE  ')).toBe('main strasse');
    expect(boundedCandidateAddressNumber(' １２３Ａ  Main Street ')).toBe('123a');
    expect(boundedCandidateAddressNumber('Main Street')).toBeNull();
  });

  it('runs canonical, reconciliation, feature, and portable release stages through opaque artifact URIs without row arrays', async () => {
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
    const failedMutations = normalizePropertyRecord(
      {
        apn: FAILED_APN,
        jurisdiction: 'Santa Clara',
        address: null,
        unit: null,
        parcelGeometry: null,
        landAreaSquareMeters: null,
      },
      testContext({
        sourceId: FAILED_SOURCE_ID,
        snapshotId: FAILED_SNAPSHOT_ID,
        artifactId: acquiredArtifactId(FAILED_SOURCE_ID, FAILED_SNAPSHOT_ID),
        runId: RUN_ID,
      }),
    );
    const failedSequence = chunkSequence(failedMutations);
    expect(failedSequence.recordCount).toBeGreaterThan(0);
    expect(failedSequence.recordCount).toBe(failedMutations.length);
    const localArtifactStore = new LocalArtifactStore({
      rootDirectory: join(root, 'artifacts'),
      now: () => NOW,
    });
    const opaqueMartStore = createOpaqueMartArtifactStore(localArtifactStore);
    const artifactStore = opaqueMartStore.store;
    const checkpointStore = new LocalCheckpointStore({ rootDirectory: join(root, 'checkpoints') });
    const source = sourceManifest(mutations.length);
    const failedSource = Object.freeze({
      ...sourceManifestFor(
        FAILED_SOURCE_ID,
        FAILED_SNAPSHOT_ID,
        'ca_sos_businesses',
        failedMutations.length,
      ),
      supportState: 'blocked' as const,
      terminalState: 'failed' as const,
      coverage: Object.freeze({
        expectedRecords: 1,
        observedRecords: failedMutations.length,
        acceptedRecords: failedMutations.length,
        quarantinedRecords: 0,
        denominatorMethod: 'configured' as const,
        ratio: 1,
      }),
      limitations: Object.freeze([
        'Fixture source failed after normalization; its mutation lane must be omitted from release content.',
      ]),
      errorCodes: Object.freeze(['FIXTURE_ACQUISITION_FAILED']),
    }) satisfies SourceExecutionManifest;
    const blockedSource = Object.freeze({
      ...sourceManifestFor(BLOCKED_SOURCE_ID, BLOCKED_SNAPSHOT_ID, 'ownership_transfers', 0),
      supportState: 'blocked' as const,
      terminalState: 'blocked' as const,
      coverage: Object.freeze({
        expectedRecords: 1,
        observedRecords: 0,
        acceptedRecords: 0,
        quarantinedRecords: 0,
        denominatorMethod: 'configured' as const,
        ratio: 0,
      }),
      limitations: Object.freeze([
        'Fixture transfer acquisition was blocked before bytes arrived.',
      ]),
      errorCodes: Object.freeze(['FIXTURE_ACQUISITION_BLOCKED']),
    }) satisfies SourceExecutionManifest;
    const trustedArtifact = await acquiredArtifact(artifactStore, SOURCE_ID, SNAPSHOT_ID);
    const configuration = {
      runId: RUN_ID,
      pipelineVersion: '2.0.0',
      requestedAt: NOW,
      profile: {
        name: 'pilot',
        recordCap: 5_000,
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
      mutationSources: [
        { sourceId: SOURCE_ID, snapshotId: SNAPSHOT_ID, sequence },
        {
          sourceId: FAILED_SOURCE_ID,
          snapshotId: FAILED_SNAPSHOT_ID,
          sequence: failedSequence,
        },
      ],
      acquiredSources: [
        {
          sourceId: SOURCE_ID,
          artifacts: [trustedArtifact],
        },
      ],
      sources: [source, blockedSource, failedSource],
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

    const rooted = await rootedChunkSequence(artifactStore, mutations);
    const rootedInventory = rooted.chunkInventory;
    if (rootedInventory == null) throw new Error('Expected rooted mutation inventory');
    const rootedRequest = {
      ...request,
      mutationSources: [{ sourceId: SOURCE_ID, snapshotId: SNAPSHOT_ID, sequence: rooted }],
    };
    await expect(
      createProcessor().processBoundedCounty?.({
        ...rootedRequest,
        mutationSources: [
          {
            sourceId: SOURCE_ID,
            snapshotId: SNAPSHOT_ID,
            sequence: Object.freeze({
              ...rooted,
              chunkInventory: Object.freeze({
                ...rootedInventory,
                recordCount: rootedInventory.recordCount + 1,
              }),
            }),
          },
        ],
      }),
    ).rejects.toThrow('descriptor inventory rejected');
    const rootedReferences: ChunkReference[] = [];
    for await (const reference of rooted.readReferences?.() ?? []) rootedReferences.push(reference);
    const firstRootedReference = rootedReferences[0];
    if (firstRootedReference === undefined) throw new Error('Expected rooted mutation reference');
    await expect(
      createProcessor().processBoundedCounty?.({
        ...rootedRequest,
        mutationSources: [
          {
            sourceId: SOURCE_ID,
            snapshotId: SNAPSHOT_ID,
            sequence: Object.freeze({
              ...rooted,
              readReferences: async function* () {
                yield await Promise.resolve(
                  Object.freeze({ ...firstRootedReference, byteSize: 1 }),
                );
              },
            }),
          },
        ],
      }),
    ).rejects.toThrow('Rooted mutation reference changed');
    await expect(
      createProcessor().processBoundedCounty?.({
        ...rootedRequest,
        mutationSources: [
          {
            sourceId: SOURCE_ID,
            snapshotId: SNAPSHOT_ID,
            sequence: Object.freeze({
              ...rooted,
              licenseSnapshotRefs: Object.freeze(['sc:license:substituted']),
            }),
          },
        ],
      }),
    ).rejects.toThrow('Rooted mutation physical identity changed');
    const corruptPageStore: BoundedCountyProcessingRequest['artifactStore'] = Object.freeze({
      putImmutable: artifactStore.putImmutable.bind(artifactStore),
      putImmutableStreaming: artifactStore.putImmutableStreaming.bind(artifactStore),
      head: artifactStore.head.bind(artifactStore),
      headByLogicalKey: artifactStore.headByLogicalKey.bind(artifactStore),
      read: (uri: string, range?: Readonly<{ start: number; endInclusive: number }>) =>
        uri === rootedInventory.pageIndexUri
          ? oneBuffer(Buffer.from('{}', 'utf8'))
          : artifactStore.read(uri, range),
    });
    await expect(
      createProcessor().processBoundedCounty?.({
        ...rootedRequest,
        artifactStore: corruptPageStore,
      }),
    ).rejects.toThrow('semantic hash mismatch');

    await mkdir(join(root, 'output'), { recursive: true });
    const leasePath = join(root, 'output', '.oracle-bounded-resource-lease.json');
    const competingRunId = `sc:run:${'9'.repeat(64)}`;
    const leaseHolder = spawn(
      process.execPath,
      [
        '-e',
        "const fs=require('node:fs');const path=process.argv[1];const record={format:'oracle-bounded-resource-fence-v1',resourceIdentity:'b'.repeat(64),runId:process.argv[2],token:'a'.repeat(64),pid:process.pid};fs.writeFileSync(path,JSON.stringify(record)+'\\n');process.stdout.write('ready\\n');setInterval(()=>{},1000);",
        leasePath,
        competingRunId,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await once(leaseHolder.stdout, 'data');
    try {
      await expect(createProcessor().processBoundedCounty?.(request)).rejects.toThrow(
        'Bounded resource is already leased by process',
      );
    } finally {
      leaseHolder.kill();
      await once(leaseHolder, 'exit');
    }
    const separateRoot = await mkdtemp(join(tmpdir(), 'oracle-bounded-separate-resource-'));
    const separateLeasePath = join(separateRoot, '.oracle-bounded-resource-lease.json');
    const separateLeaseHolder = spawn(
      process.execPath,
      [
        '-e',
        "const fs=require('node:fs');const path=process.argv[1];const record={format:'oracle-bounded-resource-fence-v1',resourceIdentity:'c'.repeat(64),runId:process.argv[2],token:'d'.repeat(64),pid:process.pid};fs.writeFileSync(path,JSON.stringify(record)+'\\n');process.stdout.write('ready\\n');setInterval(()=>{},1000);",
        separateLeasePath,
        competingRunId,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await once(separateLeaseHolder.stdout, 'data');
    try {
      await expect(createProcessor().processBoundedCounty?.(request)).rejects.toThrow(
        `injected ${crashPoints[0]} crash`,
      );
    } finally {
      separateLeaseHolder.kill();
      await once(separateLeaseHolder, 'exit');
    }
    for (const point of crashPoints.slice(1)) {
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
      generationId: string;
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
      sourceStates: readonly Readonly<{
        sourceId: string;
        terminalState: string;
        limitations: readonly string[];
      }>[];
      capabilities: readonly Readonly<{
        capability: string;
        state: string;
        sourceIds: readonly string[];
        limitations: readonly string[];
      }>[];
      budget: Readonly<{
        peakBufferedRecords: number;
        peakBufferedBytes: number;
        maxBufferedRecords: number;
        maxBufferedBytes: number;
      }>;
    }>;
    expect(releaseEvidence).toMatchObject({
      runStatus: 'failed',
      releaseScope: 'partial_county',
      countyCompletionClaim: false,
    });
    expect(releaseEvidence.budget.peakBufferedRecords).toBeLessThanOrEqual(
      releaseEvidence.budget.maxBufferedRecords,
    );
    expect(releaseEvidence.budget.peakBufferedBytes).toBeLessThanOrEqual(
      releaseEvidence.budget.maxBufferedBytes,
    );
    expect(
      releaseEvidence.sourceStates.find(({ sourceId }) => sourceId === BLOCKED_SOURCE_ID),
    ).toMatchObject({ terminalState: 'blocked' });
    expect(
      releaseEvidence.sourceStates.find(({ sourceId }) => sourceId === FAILED_SOURCE_ID),
    ).toMatchObject({
      terminalState: 'failed',
      limitations: [
        'Fixture source failed after normalization; its mutation lane must be omitted from release content.',
      ],
    });
    expect(
      releaseEvidence.capabilities.find(({ capability }) => capability === 'ownership_transfers'),
    ).toMatchObject({
      state: 'blocked',
      sourceIds: [BLOCKED_SOURCE_ID],
    });
    expect(
      releaseEvidence.capabilities.find(({ capability }) => capability === 'ca_sos_businesses'),
    ).toMatchObject({
      state: 'failed',
      sourceIds: [FAILED_SOURCE_ID],
      limitations: [
        'Fixture source failed after normalization; its mutation lane must be omitted from release content.',
      ],
    });
    expect(
      manifest.artifacts.every(({ sourceLineage }) =>
        sourceLineage.every(({ sourceId }) => sourceId !== FAILED_SOURCE_ID),
      ),
    ).toBe(true);
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
    expect(publicPipelineRun.sourceLineage.map(({ sourceId }) => sourceId)).toEqual([
      BLOCKED_SOURCE_ID,
      SOURCE_ID,
    ]);
    const pipelineRows = await readParquetRows(
      join(root, 'output', descriptor.releaseDirectory, publicPipelineRun.relativePath),
    );
    expect(pipelineRows).toHaveLength(1);
    expect(pipelineRows[0]?.status).toBe('failed');
    expect(JSON.parse(String(pipelineRows[0]?.source_ids_json))).toEqual([
      BLOCKED_SOURCE_ID,
      SOURCE_ID,
    ]);
    const publicSourceCoverage = manifest.artifacts.find(
      ({ visibility, relation }) => visibility === 'public' && relation === 'source_coverage',
    );
    if (publicSourceCoverage === undefined) throw new Error('public source_coverage is missing');
    const sourceCoverageRows = await readParquetRows(
      join(root, 'output', descriptor.releaseDirectory, publicSourceCoverage.relativePath),
    );
    expect(
      sourceCoverageRows.find(({ source_id: sourceId }) => sourceId === BLOCKED_SOURCE_ID),
    ).toMatchObject({
      support_class: 'unsupported',
      observed_count: 0n,
      quarantine_count: 0n,
    });
    expect(
      sourceCoverageRows.find(({ source_id: sourceId }) => sourceId === FAILED_SOURCE_ID),
    ).toBeUndefined();
    const publicPropertyQuery = manifest.artifacts.find(
      ({ visibility, relation }) => visibility === 'public' && relation === 'property_query',
    );
    if (publicPropertyQuery === undefined) throw new Error('public property_query is missing');
    const propertyRows = await readParquetRows(
      join(root, 'output', descriptor.releaseDirectory, publicPropertyQuery.relativePath),
    );
    expect(propertyRows).toHaveLength(1);
    expect(propertyRows.some(({ parcel_identifier: apn }) => apn === FAILED_APN)).toBe(false);
    expect(JSON.parse(String(propertyRows[0]?.source_ids_json))).toEqual([SOURCE_ID]);
    expect(['unknown', 'unsupported']).toContain(propertyRows[0]?.ownership_support_class);
    expect(['unknown', 'unsupported']).toContain(propertyRows[0]?.regional_owner_support_class);
    expect(propertyRows[0]?.last_exchange_date).toBeNull();
    const fieldSources = JSON.parse(
      String(propertyRows[0]?.field_source_ids_json),
    ) as readonly Readonly<{
      field_name: string;
      source_ids: readonly string[];
      source_references: readonly Readonly<{
        recordSha256: string;
        lineageSha256: string;
      }>[];
    }>[];
    const fieldSourceIds = Object.fromEntries(
      fieldSources.map(({ field_name: fieldName, source_ids: sourceIds }) => [
        fieldName,
        sourceIds,
      ]),
    );
    expect(fieldSourceIds).toMatchObject({
      property_id: [SOURCE_ID],
      parcel_identifier: [SOURCE_ID],
      address_street: [],
      address_zip: [],
      latitude: [],
      longitude: [],
      last_exchange_date: [],
    });
    expect(
      fieldSources
        .flatMap(({ source_references: sourceReferences }) => sourceReferences)
        .every(
          ({ recordSha256, lineageSha256 }) =>
            /^[a-f0-9]{64}$/u.test(recordSha256) && /^[a-f0-9]{64}$/u.test(lineageSha256),
        ),
    ).toBe(true);
    expect(
      fieldSources.find(({ field_name: fieldName }) => fieldName === 'property_id')
        ?.source_references,
    ).toHaveLength(1);
    for (const visibility of ['public', 'restricted'] as const) {
      for (const relation of ['property_query', 'property_evidence'] as const) {
        const artifact = manifest.artifacts.find(
          (candidate) => candidate.visibility === visibility && candidate.relation === relation,
        );
        if (artifact === undefined) throw new Error(`${visibility}/${relation} is missing`);
        const rows = await readParquetRows(
          join(root, 'output', descriptor.releaseDirectory, artifact.relativePath),
        );
        expect(
          rows.every((row) => {
            const sourceIds: unknown = JSON.parse(String(row.source_ids_json));
            return (
              Array.isArray(sourceIds) &&
              sourceIds.every(
                (sourceId) => typeof sourceId === 'string' && sourceId !== FAILED_SOURCE_ID,
              )
            );
          }),
          `${visibility}/${relation} failed-lane contributor`,
        ).toBe(true);
        if (relation === 'property_query') {
          expect(rows).toHaveLength(1);
          expect(rows.some(({ parcel_identifier: apn }) => apn === FAILED_APN)).toBe(false);
        }
      }
    }
    const durable = await checkpointStore.load(
      `bounded-processing:${RUN_ID}:${descriptor.generationId}`,
    );
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
    const buildMartsStage = checkpoint?.completedStages.find(
      ({ stage }) => stage === 'build_marts',
    );
    if (buildMartsStage === undefined) throw new Error('build_marts stage is missing');
    const buildMartsManifestArtifact = await artifactStore.headByLogicalKey(
      `bsm/${buildMartsStage.outputManifestSha256}.json`,
    );
    if (buildMartsManifestArtifact === undefined) {
      throw new Error('build_marts stage manifest object is missing');
    }
    const buildMartsManifest = (await readStoredJson(
      artifactStore,
      buildMartsManifestArtifact.uri,
    )) as Readonly<{
      artifacts: readonly Readonly<{
        dataset: string;
        logicalKey: string;
        uri: string;
        byteSize: number;
        sha256: string;
      }>[];
    }>;
    const martDescriptors = buildMartsManifest.artifacts
      .map((artifact) => ({
        logicalKey: artifact.logicalKey,
        uri: artifact.uri,
        byteSize: artifact.byteSize,
        sha256: artifact.sha256,
      }))
      .sort((left, right) => left.logicalKey.localeCompare(right.logicalKey, 'en-US'));
    expect(martDescriptors).toEqual(opaqueMartStore.descriptors());
    expect(new Set(buildMartsManifest.artifacts.map(({ dataset }) => dataset)).size).toBe(12);
    expect(martDescriptors.every(({ uri }) => uri.startsWith('file://oracle-artifact/'))).toBe(
      true,
    );
    expect(martDescriptors.every(({ uri }) => opaqueMartStore.readUris().includes(uri))).toBe(true);
    for (const stage of checkpoint?.completedStages ?? []) {
      expect(
        await artifactStore.headByLogicalKey(`bsm/${stage.outputManifestSha256}.json`),
        stage.stage,
      ).toBeDefined();
    }

    const resumed = await createProcessor().processBoundedCounty?.(request);
    expect(resumed?.reconcileArtifact.sha256).toBe(first.reconcileArtifact.sha256);
    expect(resumed?.martArtifact.sha256).toBe(first.martArtifact.sha256);

    const changedGeneration = await createProcessor().processBoundedCounty?.({
      ...request,
      mutationSources: [
        {
          sourceId: SOURCE_ID,
          snapshotId: SNAPSHOT_ID,
          sequence: chunkSequence([...mutations].reverse()),
        },
        {
          sourceId: FAILED_SOURCE_ID,
          snapshotId: FAILED_SNAPSHOT_ID,
          sequence: failedSequence,
        },
      ],
    });
    if (changedGeneration === undefined) throw new Error('changed generation did not complete');
    const changedDescriptor = (await readJsonArtifact(
      artifactStore,
      changedGeneration.martArtifact,
    )) as Readonly<{ generationId: string; releaseDirectory: string }>;
    expect(changedDescriptor.generationId).not.toBe(descriptor.generationId);
    expect(changedDescriptor.releaseDirectory).not.toBe(descriptor.releaseDirectory);
    const generationDirectories = (
      await readdir(join(root, 'scratch', createHash('sha256').update(RUN_ID).digest('hex')), {
        withFileTypes: true,
      })
    )
      .filter((entry) => entry.isDirectory())
      .map(({ name }) => name)
      .sort();
    expect(generationDirectories).toEqual(
      [descriptor.generationId, changedDescriptor.generationId]
        .map((generationId) => generationId.slice(generationId.lastIndexOf(':') + 1, -32))
        .sort(),
    );
    await expect(
      readFile(join(root, 'output', descriptor.releaseDirectory, 'release-manifest.json'), 'utf8'),
    ).resolves.toContain('"manifestSha256"');

    const firstCompletedStage = checkpoint?.completedStages[0];
    if (firstCompletedStage === undefined) throw new Error('completed stage is missing');
    const persistedStage = await localArtifactStore.headByLogicalKey(
      `bsm/${firstCompletedStage.outputManifestSha256}.json`,
    );
    if (persistedStage === undefined) throw new Error('persisted stage object is missing');
    await rm(fileURLToPath(persistedStage.uri), { force: true });
    await expect(createProcessor().processBoundedCounty?.(request)).rejects.toThrow();
  }, 180_000);

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
    const mutationSources = lanes.map(({ sourceId, snapshotId, mutations }) => ({
      sourceId,
      snapshotId,
      sequence: chunkSequence(mutations),
    }));
    const acquiredSources = await Promise.all(
      lanes.map(async ({ sourceId, snapshotId }) => ({
        sourceId,
        artifacts: [await acquiredArtifact(artifactStore, sourceId, snapshotId)],
      })),
    );
    const sourceManifests = lanes.map(({ sourceId, snapshotId, capability, mutations }) =>
      sourceManifestFor(sourceId, snapshotId, capability, mutations.length),
    );
    const request: BoundedCountyProcessingRequest = {
      configuration,
      mutationSources,
      acquiredSources,
      sources: sourceManifests,
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

    const unavailableDependencies = [
      unavailableSourceManifest('noaa-failed', 'noaa_shoreline', 'failed'),
      unavailableSourceManifest('caltrain-blocked', 'caltrain_gtfs', 'blocked'),
      unavailableSourceManifest('osm-failed', 'osm_pedestrian_graph', 'failed'),
    ] as const;
    const unavailableProcessor = createBoundedPipelineProcessors({
      outputDirectory: join(root, 'unavailable-output'),
      scratchDirectory: join(root, 'unavailable-scratch'),
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
    const unavailableResult = await unavailableProcessor.processBoundedCounty?.({
      ...request,
      sources: [...sourceManifests, ...unavailableDependencies],
      checkpointStore: new LocalCheckpointStore({
        rootDirectory: join(root, 'unavailable-checkpoints'),
      }),
    });
    expect(unavailableResult?.countyCompletionClaim).toBe(false);
    const unavailableFeatureFiles = await filesBelow(join(root, 'unavailable-scratch'), '.ndjson');
    const unavailableBundles = (
      await Promise.all(
        unavailableFeatureFiles
          .filter((path) => path.includes('features'))
          .map(async (path) =>
            (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(parseJsonObject),
          ),
      )
    ).flat();
    const unavailableEvidence = unavailableBundles.find(
      (bundle) => bundle.publicEvidence !== undefined,
    )?.publicEvidence;
    if (!Array.isArray(unavailableEvidence) || !unavailableEvidence.every(isJsonObject)) {
      throw new Error('unavailable dependency feature bundle was not materialized');
    }
    const unavailableByFeature = new Map(
      unavailableEvidence.map((row) => [row.feature, row] as const),
    );
    for (const feature of [
      'water_view_candidate',
      'transit_walkability',
      'starbucks_walkability',
    ] as const) {
      expect(unavailableByFeature.get(feature)).toMatchObject({
        supportClass: 'unknown',
        value: null,
      });
    }

    const allBlockedDependencies = [
      'san_jose_permits',
      'palo_alto_year_built',
      'ownership_transfers',
      'overture_starbucks',
      'osm_pedestrian_graph',
      'vta_gtfs',
      'caltrain_gtfs',
      'noaa_shoreline',
      'usgs_hydrography',
      'usgs_elevation',
    ].map((capability) =>
      unavailableSourceManifest(
        `all-blocked-${capability.replaceAll('_', '-')}`,
        capability,
        'blocked',
      ),
    );
    const allBlockedProcessor = createBoundedPipelineProcessors({
      outputDirectory: join(root, 'all-blocked-output'),
      scratchDirectory: join(root, 'all-blocked-scratch'),
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
    const parcelMutationSource = mutationSources[0];
    const parcelAcquiredSource = acquiredSources[0];
    const parcelManifest = sourceManifests[0];
    if (
      parcelMutationSource === undefined ||
      parcelAcquiredSource === undefined ||
      parcelManifest === undefined
    ) {
      throw new Error('parcel fixture lane is missing');
    }
    await allBlockedProcessor.processBoundedCounty?.({
      ...request,
      mutationSources: [parcelMutationSource],
      acquiredSources: [parcelAcquiredSource],
      sources: [parcelManifest, ...allBlockedDependencies],
      checkpointStore: new LocalCheckpointStore({
        rootDirectory: join(root, 'all-blocked-checkpoints'),
      }),
    });
    const allBlockedFeatureFiles = await filesBelow(join(root, 'all-blocked-scratch'), '.ndjson');
    const allBlockedBundles = (
      await Promise.all(
        allBlockedFeatureFiles
          .filter((path) => path.includes('features'))
          .map(async (path) =>
            (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(parseJsonObject),
          ),
      )
    ).flat();
    const allBlockedEvidence = allBlockedBundles.find(
      (bundle) => bundle.publicEvidence !== undefined,
    )?.publicEvidence;
    if (!Array.isArray(allBlockedEvidence) || !allBlockedEvidence.every(isJsonObject)) {
      throw new Error('all-blocked feature bundle was not materialized');
    }
    expect(allBlockedEvidence).toHaveLength(6);
    for (const row of allBlockedEvidence) {
      expect(row).toMatchObject({ supportClass: 'unknown', value: null });
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

function createOpaqueMartArtifactStore(delegate: LocalArtifactStore): Readonly<{
  store: BoundedCountyProcessingRequest['artifactStore'];
  descriptors: () => readonly Readonly<{
    logicalKey: string;
    uri: string;
    byteSize: number;
    sha256: string;
  }>[];
  readUris: () => readonly string[];
}> {
  type PipelineArtifactStore = BoundedCountyProcessingRequest['artifactStore'];
  const descriptors = new Map<
    string,
    Readonly<{ logicalKey: string; uri: string; byteSize: number; sha256: string }>
  >();
  const physicalUris = new Map<string, string>();
  const readUris: string[] = [];
  const isMartKey = (logicalKey: string): boolean => logicalKey.startsWith('bm/');
  const opaqueUri = (logicalKey: string): string =>
    `file://oracle-artifact/${Buffer.from(logicalKey, 'utf8').toString('base64url')}`;
  const logicalKeyFromOpaqueUri = (uri: string): string | null => {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:' || parsed.hostname !== 'oracle-artifact') return null;
    return Buffer.from(parsed.pathname.slice(1), 'base64url').toString('utf8');
  };
  const restore = <
    T extends Readonly<{
      logicalKey: string;
      uri: string;
      byteSize: number;
      sha256: string;
    }>,
  >(
    stored: T,
  ): T => {
    const restored = Object.freeze({ ...stored, uri: opaqueUri(stored.logicalKey) }) as T;
    physicalUris.set(restored.uri, stored.uri);
    if (isMartKey(stored.logicalKey)) {
      descriptors.set(
        stored.logicalKey,
        Object.freeze({
          logicalKey: restored.logicalKey,
          uri: restored.uri,
          byteSize: restored.byteSize,
          sha256: restored.sha256,
        }),
      );
    }
    return restored;
  };
  const physicalUri = async (uri: string): Promise<string> => {
    const logicalKey = logicalKeyFromOpaqueUri(uri);
    if (logicalKey === null) return uri;
    const stored = await delegate.headByLogicalKey(logicalKey);
    if (stored === undefined) throw new Error(`Opaque fixture artifact is missing: ${logicalKey}`);
    return stored.uri;
  };
  const store: PipelineArtifactStore = Object.freeze({
    putImmutable: async (request: Parameters<PipelineArtifactStore['putImmutable']>[0]) =>
      restore(await delegate.putImmutable(request)),
    putImmutableStreaming: async (
      request: Parameters<PipelineArtifactStore['putImmutableStreaming']>[0],
    ) => restore(await delegate.putImmutableStreaming(request)),
    head: async (uri: string) => {
      const stored = await delegate.head(await physicalUri(uri));
      return stored === undefined ? undefined : restore(stored);
    },
    headByLogicalKey: async (logicalKey: string) => {
      const stored = await delegate.headByLogicalKey(logicalKey);
      return stored === undefined ? undefined : restore(stored);
    },
    read: (uri: string, range?: Parameters<PipelineArtifactStore['read']>[1]) =>
      (async function* (): AsyncIterable<Uint8Array> {
        if (logicalKeyFromOpaqueUri(uri) !== null) readUris.push(uri);
        yield* delegate.read(await physicalUri(uri), range);
      })(),
    physicalUri: (uri: string): string => physicalUris.get(uri) ?? uri,
  });
  return Object.freeze({
    store,
    descriptors: () =>
      Object.freeze(
        [...descriptors.values()].sort((left, right) =>
          left.logicalKey.localeCompare(right.logicalKey, 'en-US'),
        ),
      ),
    readUris: () => Object.freeze([...readUris]),
  });
}

async function readStoredJson(
  store: BoundedCountyProcessingRequest['artifactStore'],
  uri: string,
): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of store.read(uri)) {
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }
  return JSON.parse(Buffer.concat(chunks, byteLength).toString('utf8')) as unknown;
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

async function rootedChunkSequence<T>(
  artifactStore: BoundedCountyProcessingRequest['artifactStore'],
  values: readonly T[],
): Promise<ChunkSequence<T>> {
  const logicalPrefix = 'fixture/rooted-mutations';
  let ledger = emptyChunkLedger(logicalPrefix);
  const writer = new CanonicalChunkWriter<T>({
    store: artifactStore,
    logicalPrefix,
    visibility: 'public',
    licenseSnapshotRef: 'license:test:v1',
    budget: createSharedRecordBudget(2),
    signal: new AbortController().signal,
    maximumRecordsPerChunk: 2,
    restoredLedger: ledger,
    onLedger: (next) => {
      ledger = next;
      return Promise.resolve();
    },
  });
  for (const value of values) await writer.append(value);
  return writer.finish();
}

function sourceManifest(accepted: number): SourceExecutionManifest {
  return sourceManifestFor(SOURCE_ID, SNAPSHOT_ID, 'santa_clara_parcels', accepted);
}

async function acquiredArtifact(
  artifactStore: BoundedCountyProcessingRequest['artifactStore'],
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

function unavailableSourceManifest(
  suffix: string,
  capability: SourceExecutionManifest['capability'],
  terminalState: 'failed' | 'blocked',
): SourceExecutionManifest {
  const sourceId = sourceIdSchema.parse(`sc:source:test-${suffix}`);
  const snapshotId = snapshotIdSchema.parse(
    `sc:snapshot:test-${suffix}:${createHash('sha256').update(suffix).digest('hex')}`,
  );
  return Object.freeze({
    ...sourceManifestFor(sourceId, snapshotId, capability, 0),
    supportState: 'blocked' as const,
    terminalState,
    coverage: Object.freeze({
      expectedRecords: 1,
      observedRecords: 0,
      acceptedRecords: 0,
      quarantinedRecords: 0,
      denominatorMethod: 'configured' as const,
      ratio: 0,
    }),
    limitations: Object.freeze([`Fixture ${capability} dependency is ${terminalState}.`]),
    errorCodes: Object.freeze([`FIXTURE_DEPENDENCY_${terminalState.toUpperCase()}`]),
  }) satisfies SourceExecutionManifest;
}
