import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  BOUNDED_PROCESSING_CONTRACT_VERSION,
  BOUNDED_PROCESSING_STAGES,
  BOUNDED_PROCESSOR_KIND,
  BOUNDED_PROCESSOR_COMPATIBILITY_POLICY,
  P8_FROZEN_CID,
  P8_FROZEN_MANIFEST_SHA256,
  assertP8FrozenCompatibility,
  boundedArtifactOrderKey,
  boundedDescriptorPageSha256,
  boundedGenerationSpecSha256,
  boundedProcessingCheckpointSha256,
  boundedProcessingGenerationId,
  boundedStageManifestSha256,
  boundedTrustedAcquisitionManifestSha256,
  boundedTrustedCapabilityEvidenceSha256,
  boundedTrustedCapabilityStateSha256,
  boundedTrustedSchemaSha256,
  boundedTrustedSourceSha256,
  boundedTrustedAcquiredSourceSchema,
  boundedTrustedAcquisitionManifestSchema,
  budgetPolicySha256,
  logicalOutputIdentitySha256,
  partitionPlanSha256,
  physicalMutationManifestSha256,
  releaseIdentitySha256,
  stageVersionsSha256,
  type BoundedMutationLogInput,
  type BoundedProcessingCheckpoint,
  type BoundedProcessingInput,
  type BoundedTrustedAcquiredSource,
  type BoundedTrustedAcquisitionManifest,
  type ImmutableBoundedArtifact,
} from '@oracle/contracts/bounded-processing';
import { runIdSchema, snapshotIdSchema, sourceIdSchema } from '@oracle/contracts/ids';
import { acquiredArtifactSchema, type AcquiredArtifact } from '@oracle/contracts/source';
import { describe, expect, it } from 'vitest';

import {
  BOUNDED_COUNTY_SERVING_RELATIONS,
  BoundedBuildConfigurationError,
  BoundedFinalizationRaceError,
  BoundedPublicPrivacyError,
  BoundedReleaseCorruptionError,
  BoundedReleaseGateError,
  BoundedReleaseMetadataError,
  BoundedServingBudgetError,
  ProcessWideServingBudget,
  boundedServingRowSortKey,
  boundedServingLicenseDecisionSha256,
  boundedServingLineageSha256,
  boundedServingSchemaSha256,
  buildBoundedServingRelease as buildBoundedServingReleasePackage,
  verifyBoundedServingRelease,
  verifyBoundedServingArtifactInventory,
  type BoundedServingRelationInput,
  type BoundedServingReleaseBuildInput,
  type BoundedTrustedCanonicalLineageResolver,
  type BoundedReleaseFinalizationCoordinator,
  type BoundedReleaseFinalizationWinner,
  type BoundedServingReleaseMetadata,
} from './bounded-release.js';
import { REAL_COUNTY_CAPABILITIES } from './real-county-release.js';
import { BOUNDED_SERVING_RELATIONS, type ServingRow, type ServingVisibility } from './schema.js';
import { verifyServingArtifacts } from './verifier.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const trustedByProcessing = new WeakMap<
  BoundedProcessingInput,
  BoundedTrustedAcquisitionManifest
>();
const finalizerByProcessing = new WeakMap<BoundedProcessingInput, TestFinalizer>();

class TestFinalizer implements BoundedReleaseFinalizationCoordinator {
  public finalizeCalls = 0;
  private readonly winners = new Map<
    string,
    Readonly<{ revision: string; winner: BoundedReleaseFinalizationWinner }>
  >();
  private readonly locks = new Map<string, Promise<void>>();
  private crashAfterCas = false;
  private abaAfterFinalize = false;

  public injectCrashAfterCas(): void {
    this.crashAfterCas = true;
  }

  public injectAbaAfterFinalize(): void {
    this.abaAfterFinalize = true;
  }

  public inspect(destinationIdentitySha256: string) {
    return Promise.resolve(this.winners.get(destinationIdentitySha256) ?? null);
  }

  public async finalize(input: {
    readonly destination: string;
    readonly staging: string;
    readonly expectedRevision: string;
    readonly winner: BoundedReleaseFinalizationWinner;
  }) {
    this.finalizeCalls += 1;
    const key = input.winner.destinationIdentitySha256;
    const prior = this.locks.get(key) ?? Promise.resolve();
    let unlock: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const tail = prior.then(() => gate);
    this.locks.set(key, tail);
    await prior;
    try {
      return await this.finalizeLocked(input);
    } finally {
      unlock();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  private async finalizeLocked(input: {
    readonly destination: string;
    readonly staging: string;
    readonly expectedRevision: string;
    readonly winner: BoundedReleaseFinalizationWinner;
  }) {
    const existing = this.winners.get(input.winner.destinationIdentitySha256);
    if (existing !== undefined) {
      if (
        existing.winner.generationId !== input.winner.generationId ||
        existing.winner.releaseManifestSha256 !== input.winner.releaseManifestSha256 ||
        existing.winner.releaseEvidenceSha256 !== input.winner.releaseEvidenceSha256 ||
        existing.winner.expectedRevision !== input.expectedRevision ||
        existing.winner.attemptId !== input.winner.attemptId
      ) {
        throw new BoundedFinalizationRaceError();
      }
      const destinationExists = await access(input.destination).then(
        () => true,
        () => false,
      );
      if (!destinationExists) await rename(input.staging, input.destination);
      return { ...existing, state: 'adopted_identical_winner' as const };
    }
    const revision = digest(`revision:${input.expectedRevision}:${canonicalJson(input.winner)}`);
    this.winners.set(input.winner.destinationIdentitySha256, {
      revision,
      winner: input.winner,
    });
    if (this.crashAfterCas) {
      this.crashAfterCas = false;
      throw new Error('injected crash after finalization CAS');
    }
    await rename(input.staging, input.destination);
    if (this.abaAfterFinalize) {
      this.abaAfterFinalize = false;
      this.winners.set(input.winner.destinationIdentitySha256, {
        revision: digest(`aba:${revision}`),
        winner: input.winner,
      });
    }
    return { revision, winner: input.winner, state: 'promoted' as const };
  }
}

async function buildBoundedServingRelease(
  input: Omit<BoundedServingReleaseBuildInput, 'completedBuildMarts' | 'sharedBudget'> &
    Partial<Pick<BoundedServingReleaseBuildInput, 'completedBuildMarts' | 'sharedBudget'>>,
) {
  const completedBuildMarts = input.completedBuildMarts ?? {
    manifest: buildMartsManifest(input.processing, input.relations),
  };
  const checkpoint = checkpointForBuildMarts(input.checkpoint, completedBuildMarts.manifest);
  return buildBoundedServingReleasePackage({
    ...input,
    checkpoint,
    completedBuildMarts,
    sharedBudget: input.sharedBudget ?? new ProcessWideServingBudget(input.processing.budget),
  });
}

function buildMartsManifest(
  processing: BoundedProcessingInput,
  relations: readonly BoundedServingRelationInput[],
) {
  const artifacts = relations
    .flatMap((relation) => relation.artifacts ?? [])
    .sort((left, right) =>
      boundedArtifactOrderKey(left).localeCompare(boundedArtifactOrderKey(right)),
    );
  const payload = {
    contractVersion: BOUNDED_PROCESSING_CONTRACT_VERSION,
    generationId: processing.generationId,
    stage: 'build_marts' as const,
    stageVersion: processing.stageVersions.build_marts,
    inputLogicalSha256s: [HASH_A, HASH_B, HASH_C].sort(),
    parents: [
      { stage: 'reduce_canonical' as const, manifestSha256: HASH_A },
      { stage: 'reconcile_links' as const, manifestSha256: HASH_B },
      { stage: 'derive_features' as const, manifestSha256: HASH_C },
    ],
    datasets: relations
      .map((relation) => ({
        dataset: `${relation.visibility}/${relation.relation}`,
        schemaSha256: boundedServingSchemaSha256(relation.relation),
        sortKeyVersion: 'bounded-serving-row-sort-v1',
        recordCount: relation.recordCount,
        logicalSha256: relation.logicalSha256,
      }))
      .sort((left, right) => left.dataset.localeCompare(right.dataset)),
    artifacts,
    artifactInventory: null,
  };
  return Object.freeze({ ...payload, manifestSha256: boundedStageManifestSha256(payload) });
}

function checkpointForBuildMarts(
  checkpoint: BoundedProcessingCheckpoint,
  manifest: Readonly<{ manifestSha256: string }>,
): BoundedProcessingCheckpoint {
  const completedStages = checkpoint.completedStages.map((stage) =>
    stage.stage === 'build_marts'
      ? { ...stage, outputManifestSha256: manifest.manifestSha256 }
      : stage,
  );
  const payload = { ...checkpoint, completedStages };
  return {
    ...payload,
    checkpointSha256: boundedProcessingCheckpointSha256(payload),
  };
}

describe('bounded serving release v2', () => {
  it('writes and reopens all seven visibility-preserving relations deterministically', async () => {
    const rootA = await mkdtemp(join(tmpdir(), 'oracle-bounded-serving-a-'));
    const rootB = await mkdtemp(join(tmpdir(), 'oracle-bounded-serving-b-'));
    const processing = processingInput();
    const relationsA = await relationInputs(rootA, processing);
    const relationsB = await relationInputs(rootB, processing);
    const fullControls = releaseControls(processing);
    const reverseMetadataOrder = (
      metadata: BoundedServingReleaseMetadata,
    ): BoundedServingReleaseMetadata => ({
      ...metadata,
      sourceLineage: [...metadata.sourceLineage].reverse(),
      licenseDecision: {
        ...metadata.licenseDecision,
        licenseSnapshotRefs: [...metadata.licenseDecision.licenseSnapshotRefs].reverse(),
      },
    });
    const reorderedControls = {
      ...fullControls,
      dictionaryReleaseMetadata: {
        public: reverseMetadataOrder(fullControls.dictionaryReleaseMetadata.public),
        restricted: reverseMetadataOrder(fullControls.dictionaryReleaseMetadata.restricted),
      },
      releaseGate: {
        ...fullControls.releaseGate,
        requestedScope: 'partial_county' as const,
        sourceStates: [...fullControls.releaseGate.sourceStates].reverse(),
        capabilities: [...fullControls.releaseGate.capabilities].reverse(),
      },
    };

    const first = await buildBoundedServingRelease({
      processing,
      relations: relationsA,
      ...releaseControls(processing),
      outputDirectory: join(rootA, 'release'),
      scratchDirectory: join(rootA, 'scratch'),
      writeBatchRecords: 1,
      maximumLineBytes: 64 * 1024,
    });
    const second = await buildBoundedServingRelease({
      processing,
      relations: [...relationsB].reverse(),
      ...reorderedControls,
      outputDirectory: join(rootB, 'release'),
      scratchDirectory: join(rootB, 'scratch'),
      writeBatchRecords: 2,
      maximumLineBytes: 64 * 1024,
    });

    expect(first.manifest.manifestSha256).toBe(second.manifest.manifestSha256);
    expect(first.manifest.artifacts.map(({ sha256 }) => sha256)).toEqual(
      second.manifest.artifacts.map(({ sha256 }) => sha256),
    );
    expect(first.manifest.artifacts).toHaveLength(14);
    expect(first.evidence.catalogs).toHaveLength(2);
    expect(first.manifest.contractVersion).toBe('1.0.0');
    expect(Object.keys(first.manifest).sort()).toEqual(
      [
        'artifacts',
        'contractVersion',
        'county',
        'duckdbVersion',
        'generatedAt',
        'manifestSha256',
        'releaseId',
        'runId',
        'sourceIds',
        'state',
      ].sort(),
    );
    expect(first.manifest.manifestSha256).toBe(
      digest(`${canonicalJson(withoutKey(first.manifest, 'manifestSha256'))}\n`),
    );
    expect(first.manifest.artifacts[0]).toHaveProperty('columns');
    expect(first.manifest.artifacts[0]).toHaveProperty('nonNullCounts');
    expect(first.manifest.artifacts[0]).toHaveProperty('grain');
    expect(first.manifest.artifacts[0]).toHaveProperty('sourceLineage');
    expect(first.manifest.artifacts[0]).toHaveProperty('limitations');
    expect(first.evidence).toMatchObject({
      portableReopen: 'passed',
      publicRestrictedValueOverlap: 0,
      schemaOrder: 'passed',
      rowOrder: 'passed',
    });
    expect(first.evidence).toMatchObject({
      runStatus: 'succeeded',
      releaseScope: 'partial_county',
      countyCompletionClaim: false,
    });
    expect(second.evidence).toMatchObject({
      releaseScope: 'partial_county',
      countyCompletionClaim: false,
    });
    const queryArtifact = first.manifest.artifacts.find(
      ({ relation }) => relation === 'property_query',
    );
    const evidenceArtifact = first.manifest.artifacts.find(
      ({ relation }) => relation === 'property_evidence',
    );
    expect(queryArtifact?.columns.slice(-2).map(({ name }) => name)).toEqual([
      'source_ids_json',
      'field_source_ids_json',
    ]);
    expect(queryArtifact?.limitations).not.toEqual(evidenceArtifact?.limitations);
    expect(queryArtifact?.sourceLineage[0]?.sourceSha256).not.toBe(
      evidenceArtifact?.sourceLineage[0]?.sourceSha256,
    );
    await expect(verifyBoundedServingRelease(first.outputDirectory)).resolves.toBeDefined();
    await expect(
      verifyServingArtifacts(first.outputDirectory, first.manifest.artifacts),
    ).resolves.toHaveLength(14);

    const adopted = await buildBoundedServingRelease({
      processing,
      relations: relationsA,
      ...releaseControls(processing),
      outputDirectory: join(rootA, 'release'),
      scratchDirectory: join(rootA, 'scratch'),
      writeBatchRecords: 1,
      maximumLineBytes: 64 * 1024,
    });
    expect(adopted.adoptedIdenticalWinner).toBe(true);
  }, 120_000);

  it('fails closed for public sensitive JSON, corrupt chunks, and mixed generations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oracle-bounded-serving-negative-'));
    const processing = processingInput();
    const sensitive = await relationInputs(root, processing, 'string');
    await expect(
      buildBoundedServingRelease({
        processing,
        relations: sensitive,
        ...releaseControls(processing),
        outputDirectory: join(root, 'sensitive-release'),
        scratchDirectory: join(root, 'sensitive-scratch'),
        writeBatchRecords: 1,
        maximumLineBytes: 64 * 1024,
      }),
    ).rejects.toBeInstanceOf(BoundedPublicPrivacyError);

    for (const sensitiveType of ['number', 'boolean'] as const) {
      const nestedSensitive = await relationInputs(
        join(root, `sensitive-${sensitiveType}`),
        processing,
        sensitiveType,
      );
      await expect(
        buildBoundedServingRelease({
          processing,
          relations: nestedSensitive,
          ...releaseControls(processing),
          outputDirectory: join(root, `sensitive-${sensitiveType}-release`),
          scratchDirectory: join(root, `sensitive-${sensitiveType}-scratch`),
          writeBatchRecords: 1,
          maximumLineBytes: 64 * 1024,
        }),
      ).rejects.toBeInstanceOf(BoundedPublicPrivacyError);
    }

    const corrupt = await relationInputs(join(root, 'corrupt'), processing);
    const first = corrupt.at(-1);
    if (first?.artifacts?.[0] === undefined) throw new Error('fixture');
    const corruptRelations = [
      ...corrupt.slice(0, -1),
      { ...first, artifacts: [{ ...first.artifacts[0], sha256: HASH_D }] },
    ];
    await expect(
      buildBoundedServingRelease({
        processing,
        relations: corruptRelations,
        ...releaseControls(processing),
        outputDirectory: join(root, 'corrupt-release'),
        scratchDirectory: join(root, 'corrupt-scratch'),
        writeBatchRecords: 1,
        maximumLineBytes: 64 * 1024,
      }),
    ).rejects.toBeInstanceOf(BoundedReleaseCorruptionError);
    const resumed = await buildBoundedServingRelease({
      processing,
      relations: corrupt,
      ...releaseControls(processing),
      outputDirectory: join(root, 'corrupt-release'),
      scratchDirectory: join(root, 'corrupt-scratch'),
      writeBatchRecords: 1,
      maximumLineBytes: 64 * 1024,
    });
    expect(resumed.adoptedIdenticalWinner).toBe(false);

    const mixed = await relationInputs(join(root, 'mixed'), processing);
    const mixedFirst = mixed[0];
    if (mixedFirst?.artifacts?.[0] === undefined) throw new Error('fixture');
    const mixedRelations = [
      {
        ...mixedFirst,
        artifacts: [{ ...mixedFirst.artifacts[0], generationId: `sc:generation:${HASH_D}` }],
      },
      ...mixed.slice(1),
    ];
    await expect(
      buildBoundedServingRelease({
        processing,
        relations: mixedRelations,
        ...releaseControls(processing),
        outputDirectory: join(root, 'mixed-release'),
        scratchDirectory: join(root, 'mixed-scratch'),
        writeBatchRecords: 1,
        maximumLineBytes: 64 * 1024,
      }),
    ).rejects.toBeInstanceOf(BoundedBuildConfigurationError);

    const metadataFirst = mixed[0];
    const metadataSource = metadataFirst?.releaseMetadata.sourceLineage[0];
    if (metadataFirst === undefined || metadataSource === undefined) throw new Error('fixture');
    const wrongSnapshotRelations = [
      {
        ...metadataFirst,
        releaseMetadata: {
          ...metadataFirst.releaseMetadata,
          sourceLineage: [{ ...metadataSource, snapshotId: `sc:snapshot:other-source:${HASH_D}` }],
        },
      },
      ...mixed.slice(1),
    ];
    await expect(
      buildBoundedServingRelease({
        processing,
        relations: wrongSnapshotRelations,
        ...releaseControls(processing),
        outputDirectory: join(root, 'wrong-snapshot-release'),
        scratchDirectory: join(root, 'wrong-snapshot-scratch'),
        writeBatchRecords: 1,
        maximumLineBytes: 64 * 1024,
      }),
    ).rejects.toBeInstanceOf(BoundedReleaseMetadataError);

    const mismatchedLicenseRelations = [
      {
        ...metadataFirst,
        releaseMetadata: {
          ...metadataFirst.releaseMetadata,
          licenseDecision: {
            ...metadataFirst.releaseMetadata.licenseDecision,
            contentClass: 'changed-without-artifact-rehash',
          },
        },
      },
      ...mixed.slice(1),
    ];
    await expect(
      buildBoundedServingRelease({
        processing,
        relations: mismatchedLicenseRelations,
        ...releaseControls(processing),
        outputDirectory: join(root, 'license-release'),
        scratchDirectory: join(root, 'license-scratch'),
        writeBatchRecords: 1,
        maximumLineBytes: 64 * 1024,
      }),
    ).rejects.toBeInstanceOf(BoundedReleaseMetadataError);

    const incompleteFull = releaseControls(processing);
    await expect(
      buildBoundedServingRelease({
        processing,
        relations: mixed,
        ...incompleteFull,
        releaseGate: {
          ...incompleteFull.releaseGate,
          requestedScope: 'full_county',
        },
        outputDirectory: join(root, 'untrusted-full-release'),
        scratchDirectory: join(root, 'untrusted-full-scratch'),
        writeBatchRecords: 1,
        maximumLineBytes: 64 * 1024,
      }),
    ).rejects.toBeInstanceOf(BoundedReleaseGateError);
    const incompleteCapabilities = incompleteFull.releaseGate.capabilities.map(
      (capability, index) =>
        index === 0
          ? { ...capability, state: 'partial' as const, limitations: ['forged partial state'] }
          : capability,
    );
    await expect(
      buildBoundedServingRelease({
        processing,
        relations: mixed,
        ...incompleteFull,
        releaseGate: {
          ...incompleteFull.releaseGate,
          requestedScope: 'full_county',
          capabilities: incompleteCapabilities,
        },
        outputDirectory: join(root, 'incomplete-full-release'),
        scratchDirectory: join(root, 'incomplete-full-scratch'),
        writeBatchRecords: 1,
        maximumLineBytes: 64 * 1024,
      }),
    ).rejects.toBeInstanceOf(BoundedReleaseGateError);
  }, 120_000);

  it('detects the same semantic string across public scalars and restricted owner JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oracle-bounded-serving-semantic-overlap-'));
    const processing = processingInput();
    const controls = releaseControls(processing);
    const finalizer = controls.finalization.coordinator;
    if (!(finalizer instanceof TestFinalizer)) throw new Error('fixture finalizer');
    const relations = await relationInputs(root, processing);
    const publicScalar = await mutateRelationRow(relations, 'public', 'property_query', (row) => {
      row.property_id = 'Cross Scope Owner';
      rebindPropertyQueryFieldLineage(row, 'property_id');
    });
    const restrictedOwner = await mutateRelationRow(
      publicScalar,
      'restricted',
      'property_evidence',
      (row) => {
        row.value_json = canonicalJson({ owner_name: ' cross scope owner ' });
      },
    );
    await expect(
      buildBoundedServingRelease({
        processing,
        relations: restrictedOwner,
        ...controls,
        outputDirectory: join(root, 'release'),
        scratchDirectory: join(root, 'scratch'),
        writeBatchRecords: 1,
        maximumLineBytes: 64 * 1024,
      }),
    ).rejects.toBeInstanceOf(BoundedPublicPrivacyError);
    expect(finalizer.finalizeCalls).toBe(0);
  });

  it('keeps privacy overlap hashes type-safe across scalar and JSON representations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oracle-bounded-serving-typed-overlap-'));
    const processing = processingInput();
    const relations = await relationInputs(root, processing);
    const publicString = await mutateRelationRow(relations, 'public', 'property_query', (row) => {
      row.property_id = '42';
      rebindPropertyQueryFieldLineage(row, 'property_id');
    });
    const restrictedNumber = await mutateRelationRow(
      publicString,
      'restricted',
      'property_evidence',
      (row) => {
        row.value_json = canonicalJson({ owner_name: 42 });
      },
    );
    await expect(
      buildBoundedServingRelease({
        processing,
        relations: restrictedNumber,
        ...releaseControls(processing),
        outputDirectory: join(root, 'release'),
        scratchDirectory: join(root, 'scratch'),
        writeBatchRecords: 1,
        maximumLineBytes: 64 * 1024,
      }),
    ).resolves.toMatchObject({
      evidence: { publicRestrictedValueOverlap: 0 },
    });
  });

  it('omits a failed lane from partial-county content while preserving terminal evidence', async () => {
    const processing = processingWithTrustedRunStatus('failed', 'ownership_transfers');
    const controls = releaseControlsOmittingFailedLineage(processing);
    const finalizer = controls.finalization.coordinator;
    if (!(finalizer instanceof TestFinalizer)) throw new Error('fixture finalizer');
    const root = await mkdtemp(join(tmpdir(), 'oracle-bounded-serving-failed-run-'));
    const ownershipDowngraded = await downgradePropertyQueryClaim(
      await relationInputs(root, processing, false, true),
      'ownership',
    );
    const relations = await downgradePropertyQueryClaim(ownershipDowngraded, 'regional_owner');
    const release = await buildBoundedServingRelease({
      processing,
      relations,
      ...controls,
      outputDirectory: join(root, 'partial-release'),
      scratchDirectory: join(root, 'partial-scratch'),
      writeBatchRecords: 1,
      maximumLineBytes: 64 * 1024,
    });
    const failedSource = release.evidence.sourceStates.find(
      ({ terminalState }) => terminalState === 'failed',
    );
    expect(release.evidence).toMatchObject({
      runStatus: 'failed',
      releaseScope: 'partial_county',
      countyCompletionClaim: false,
    });
    expect(failedSource?.limitations.length).toBeGreaterThan(0);
    expect(
      release.evidence.capabilities.find(({ capability }) => capability === 'ownership_transfers'),
    ).toMatchObject({ state: 'failed', sourceIds: [failedSource?.sourceId] });
    expect(
      release.manifest.artifacts.every(({ sourceLineage }) =>
        sourceLineage.every(({ sourceId }) => sourceId !== failedSource?.sourceId),
      ),
    ).toBe(true);
    await expect(verifyBoundedServingRelease(release.outputDirectory)).resolves.toBeDefined();

    for (const requestedScope of ['pilot', 'full_county'] as const) {
      await expect(
        buildBoundedServingRelease({
          processing,
          relations,
          ...controls,
          releaseGate: { ...controls.releaseGate, requestedScope },
          outputDirectory: join(root, `${requestedScope}-release`),
          scratchDirectory: join(root, `${requestedScope}-scratch`),
          writeBatchRecords: 1,
          maximumLineBytes: 64 * 1024,
        }),
      ).rejects.toBeInstanceOf(BoundedReleaseGateError);
    }
    expect(finalizer.finalizeCalls).toBe(1);
  }, 120_000);

  it('rejects failed lineage leaks and failed-capability claim upgrades', async () => {
    const processing = processingWithTrustedRunStatus('failed', 'ownership_transfers');
    const root = await mkdtemp(join(tmpdir(), 'oracle-bounded-serving-failed-leak-'));
    const ownershipDowngraded = await downgradePropertyQueryClaim(
      await relationInputs(root, processing, false, true),
      'ownership',
    );
    const downgraded = await downgradePropertyQueryClaim(ownershipDowngraded, 'regional_owner');
    await expect(
      buildBoundedServingRelease({
        processing,
        relations: downgraded,
        ...releaseControls(processing),
        outputDirectory: join(root, 'lineage-leak-release'),
        scratchDirectory: join(root, 'lineage-leak-scratch'),
        writeBatchRecords: 1,
        maximumLineBytes: 64 * 1024,
      }),
    ).rejects.toBeInstanceOf(BoundedReleaseMetadataError);

    const regionalSiblingUpgrade = await mutateRelationRow(
      ownershipDowngraded,
      'public',
      'property_query',
      (row) => {
        row.regional_owner_support_class = 'supported';
        rebindPropertyQueryFieldLineage(row, 'regional_owner_support_class');
      },
    );
    await expect(
      buildBoundedServingRelease({
        processing,
        relations: regionalSiblingUpgrade,
        ...releaseControlsOmittingFailedLineage(processing),
        outputDirectory: join(root, 'regional-claim-upgrade-release'),
        scratchDirectory: join(root, 'regional-claim-upgrade-scratch'),
        writeBatchRecords: 1,
        maximumLineBytes: 64 * 1024,
      }),
    ).rejects.toThrow('regional_owner_support_class has a failed or blocked mandatory capability');

    const roofProcessing = processingWithTrustedRunStatus('failed', 'san_jose_permits');
    const roofControls = releaseControlsOmittingFailedLineage(roofProcessing);
    expect(
      roofControls.releaseGate.capabilities.find(
        ({ capability }) => capability === 'palo_alto_year_built',
      ),
    ).toMatchObject({ state: 'succeeded' });
    const roofRelations = await mutateRelationRow(
      await relationInputs(join(root, 'roof'), roofProcessing, false, true),
      'public',
      'property_query',
      (row) => {
        row.roof_support_class = 'proxy';
        rebindPropertyQueryFieldLineage(row, 'roof_support_class');
      },
    );
    await expect(
      buildBoundedServingRelease({
        processing: roofProcessing,
        relations: roofRelations,
        ...roofControls,
        outputDirectory: join(root, 'roof-claim-upgrade-release'),
        scratchDirectory: join(root, 'roof-claim-upgrade-scratch'),
        writeBatchRecords: 1,
        maximumLineBytes: 64 * 1024,
      }),
    ).rejects.toThrow('roof_support_class has a failed or blocked mandatory capability');
  });

  it('rejects water, transit, and Starbucks sibling bypasses for exact failed or blocked dependencies', async () => {
    const cases = [
      {
        prefix: 'water' as const,
        runStatus: 'failed' as const,
        unavailableCapability: 'usgs_elevation' as const,
        succeededSibling: 'usgs_hydrography' as const,
        affectedClaims: ['water'] as const,
      },
      {
        prefix: 'transit' as const,
        runStatus: 'failed' as const,
        unavailableCapability: 'vta_gtfs' as const,
        succeededSibling: 'caltrain_gtfs' as const,
        affectedClaims: ['transit'] as const,
      },
      {
        prefix: 'starbucks' as const,
        runStatus: 'partial' as const,
        unavailableCapability: 'osm_pedestrian_graph' as const,
        succeededSibling: 'overture_starbucks' as const,
        affectedClaims: ['transit', 'starbucks'] as const,
      },
    ];
    const root = await mkdtemp(join(tmpdir(), 'oracle-bounded-serving-exact-dependencies-'));
    for (const testCase of cases) {
      const processing = processingWithTrustedRunStatus(
        testCase.runStatus,
        testCase.unavailableCapability,
      );
      const controls = releaseControlsOmittingFailedLineage(processing);
      const expectedState = testCase.runStatus === 'failed' ? 'failed' : 'blocked';
      expect(
        controls.releaseGate.capabilities.find(
          ({ capability }) => capability === testCase.unavailableCapability,
        ),
      ).toMatchObject({ state: expectedState });
      expect(
        controls.releaseGate.capabilities.find(
          ({ capability }) => capability === testCase.succeededSibling,
        ),
      ).toMatchObject({ state: 'succeeded' });

      let downgraded = await relationInputs(
        join(root, `${testCase.prefix}-relations`),
        processing,
        false,
        true,
      );
      for (const affectedClaim of testCase.affectedClaims) {
        downgraded = await downgradePropertyQueryClaim(downgraded, affectedClaim);
      }
      const siblingBypass = await mutateRelationRow(
        downgraded,
        'public',
        'property_query',
        (row) => {
          const supportField = `${testCase.prefix}_support_class`;
          row[supportField] = 'proxy';
          rebindPropertyQueryFieldLineage(row, supportField);
        },
      );
      await expect(
        buildBoundedServingRelease({
          processing,
          relations: siblingBypass,
          ...controls,
          outputDirectory: join(root, `${testCase.prefix}-release`),
          scratchDirectory: join(root, `${testCase.prefix}-scratch`),
          writeBatchRecords: 1,
          maximumLineBytes: 64 * 1024,
        }),
      ).rejects.toThrow(
        `${testCase.prefix}_support_class has a failed or blocked mandatory capability`,
      );
    }
  });

  it('requires unknown/null for every all-blocked and mixed blocked claim dependency set', async () => {
    const claimCases = [
      {
        prefix: 'roof' as const,
        mandatoryCapabilities: ['san_jose_permits', 'palo_alto_year_built'] as const,
        affectedClaims: ['roof'] as const,
      },
      {
        prefix: 'ownership' as const,
        mandatoryCapabilities: ['ownership_transfers'] as const,
        affectedClaims: ['ownership', 'regional_owner'] as const,
      },
      {
        prefix: 'regional_owner' as const,
        mandatoryCapabilities: ['ownership_transfers'] as const,
        affectedClaims: ['ownership', 'regional_owner'] as const,
      },
      {
        prefix: 'water' as const,
        mandatoryCapabilities: ['noaa_shoreline', 'usgs_hydrography', 'usgs_elevation'] as const,
        affectedClaims: ['water'] as const,
      },
      {
        prefix: 'transit' as const,
        mandatoryCapabilities: ['vta_gtfs', 'caltrain_gtfs', 'osm_pedestrian_graph'] as const,
        affectedClaims: ['transit', 'starbucks'] as const,
      },
      {
        prefix: 'starbucks' as const,
        mandatoryCapabilities: ['overture_starbucks', 'osm_pedestrian_graph'] as const,
        affectedClaims: ['transit', 'starbucks'] as const,
      },
    ];
    const root = await mkdtemp(join(tmpdir(), 'oracle-bounded-serving-unknown-invariant-'));
    for (const claimCase of claimCases) {
      const scenarios = [
        { name: 'all-blocked', capabilities: claimCase.mandatoryCapabilities },
        ...(claimCase.mandatoryCapabilities.length > 1
          ? [{ name: 'mixed', capabilities: claimCase.mandatoryCapabilities.slice(0, 1) }]
          : []),
      ];
      for (const scenario of scenarios) {
        const processing = processingWithTrustedRunStatus('partial', scenario.capabilities);
        const controls = releaseControls(processing);
        for (const capability of scenario.capabilities) {
          expect(
            controls.releaseGate.capabilities.find(
              (candidate) => candidate.capability === capability,
            ),
          ).toMatchObject({ state: 'blocked' });
        }
        if (scenario.name === 'mixed') {
          const unavailableCapabilitySet = new Set<string>(scenario.capabilities);
          const availableSibling = claimCase.mandatoryCapabilities.find(
            (capability) => !unavailableCapabilitySet.has(capability),
          );
          expect(
            controls.releaseGate.capabilities.find(
              ({ capability }) => capability === availableSibling,
            ),
          ).toMatchObject({ state: 'succeeded' });
        }

        let downgraded = await relationInputs(
          join(root, claimCase.prefix, scenario.name),
          processing,
          false,
          true,
        );
        for (const affectedClaim of claimCase.affectedClaims) {
          downgraded = await downgradePropertyQueryClaim(downgraded, affectedClaim);
        }
        for (const rejectedSupportClass of ['unsupported', 'supported', 'proxy'] as const) {
          const invalidClaim = await mutateRelationRow(
            downgraded,
            'public',
            'property_query',
            (row) => {
              const supportField = `${claimCase.prefix}_support_class`;
              row[supportField] = rejectedSupportClass;
              rebindPropertyQueryFieldLineage(row, supportField);
            },
          );
          await expect(
            buildBoundedServingRelease({
              processing,
              relations: invalidClaim,
              ...controls,
              outputDirectory: join(
                root,
                `${claimCase.prefix}-${scenario.name}-${rejectedSupportClass}-release`,
              ),
              scratchDirectory: join(
                root,
                `${claimCase.prefix}-${scenario.name}-${rejectedSupportClass}-scratch`,
              ),
              writeBatchRecords: 1,
              maximumLineBytes: 64 * 1024,
            }),
          ).rejects.toThrow(
            `${claimCase.prefix}_support_class has a failed or blocked mandatory capability`,
          );
        }
      }
    }
  });

  it('rejects failed acquisition and capability states for every release scope', async () => {
    const processing = processingInput();
    const controls = releaseControls(processing);
    const finalizer = controls.finalization.coordinator;
    if (!(finalizer instanceof TestFinalizer)) throw new Error('fixture finalizer');
    const root = await mkdtemp(join(tmpdir(), 'oracle-bounded-serving-failed-state-'));
    const relations = await relationInputs(root, processing);
    const failedStates = [
      {
        sourceStates: controls.releaseGate.sourceStates.map((source, index) =>
          index === 0 ? { ...source, terminalState: 'failed' as const } : source,
        ),
        capabilities: controls.releaseGate.capabilities,
      },
      {
        sourceStates: controls.releaseGate.sourceStates,
        capabilities: controls.releaseGate.capabilities.map((capability, index) =>
          index === 0 ? { ...capability, state: 'failed' as const } : capability,
        ),
      },
    ];
    for (const [failureIndex, failedState] of failedStates.entries()) {
      for (const requestedScope of ['pilot', 'partial_county', 'full_county'] as const) {
        await expect(
          buildBoundedServingRelease({
            processing,
            relations,
            ...controls,
            releaseGate: { ...controls.releaseGate, ...failedState, requestedScope },
            outputDirectory: join(root, `${failureIndex}-${requestedScope}-release`),
            scratchDirectory: join(root, `${failureIndex}-${requestedScope}-scratch`),
            writeBatchRecords: 1,
            maximumLineBytes: 64 * 1024,
          }),
        ).rejects.toBeInstanceOf(BoundedReleaseGateError);
      }
    }
    expect(finalizer.finalizeCalls).toBe(0);
  });

  it('binds a trusted partial run status into partial-scope release evidence', async () => {
    const processing = processingWithTrustedRunStatus('partial');
    const controls = releaseControls(processing);
    const root = await mkdtemp(join(tmpdir(), 'oracle-bounded-serving-partial-evidence-'));
    const release = await buildBoundedServingRelease({
      processing,
      relations: await relationInputs(root, processing),
      ...controls,
      releaseGate: { ...controls.releaseGate, requestedScope: 'partial_county' },
      outputDirectory: join(root, 'release'),
      scratchDirectory: join(root, 'scratch'),
      writeBatchRecords: 1,
      maximumLineBytes: 64 * 1024,
    });
    expect(release.evidence).toMatchObject({
      runStatus: 'partial',
      releaseScope: 'partial_county',
      countyCompletionClaim: false,
    });
  });

  it('requires nonempty exact provenance for supported and proxy evidence rows', async () => {
    const processing = processingInput();
    const controls = releaseControls(processing);
    const finalizer = controls.finalization.coordinator;
    if (!(finalizer instanceof TestFinalizer)) throw new Error('fixture finalizer');
    for (const supportClass of ['supported', 'proxy'] as const) {
      const root = await mkdtemp(join(tmpdir(), `oracle-bounded-serving-empty-${supportClass}-`));
      const relations = await relationInputs(root, processing, false, true);
      const emptyProvenance = await mutateRelationRow(
        relations,
        'public',
        'property_evidence',
        (row) => {
          row.support_class = supportClass;
          row.source_ids_json = '[]';
          row.source_references_json = '[]';
        },
      );
      await expect(
        buildBoundedServingRelease({
          processing,
          relations: emptyProvenance,
          ...controls,
          finalization: {
            attemptId: `empty-${supportClass}`,
            coordinator: finalizer,
          },
          outputDirectory: join(root, 'release'),
          scratchDirectory: join(root, 'scratch'),
          writeBatchRecords: 1,
          maximumLineBytes: 64 * 1024,
        }),
      ).rejects.toBeInstanceOf(BoundedReleaseMetadataError);
    }
    expect(finalizer.finalizeCalls).toBe(0);
  });

  it('rejects property-query row or base-field provenance that is not exact', async () => {
    const processing = processingInput();
    const controls = releaseControls(processing);
    const root = await mkdtemp(join(tmpdir(), 'oracle-bounded-serving-property-lineage-'));
    const relations = await relationInputs(root, processing);
    const missingBaseField = await mutateRelationRow(
      relations,
      'public',
      'property_query',
      (row) => {
        const fields = JSON.parse(String(row.field_source_ids_json)) as {
          field_name: string;
          source_ids: readonly string[];
        }[];
        row.field_source_ids_json = canonicalJson(
          fields.map((field) =>
            field.field_name === 'parcel_identifier' ? { ...field, source_ids: [] } : field,
          ),
        );
      },
    );

    await expect(
      buildBoundedServingRelease({
        processing,
        relations: missingBaseField,
        ...controls,
        outputDirectory: join(root, 'release'),
        scratchDirectory: join(root, 'scratch'),
        writeBatchRecords: 1,
        maximumLineBytes: 64 * 1024,
      }),
    ).rejects.toBeInstanceOf(BoundedReleaseMetadataError);
  });

  it('rejects valid property-query contributors reassigned with recomputed public hashes', async () => {
    const processing = processingInput();
    const controls = releaseControls(processing);
    const fieldNames = ['roof_age_years', 'transit_distance_meters'] as const;

    for (const mutation of ['swap_references', 'move_entire_binding'] as const) {
      const root = await mkdtemp(
        join(tmpdir(), `oracle-bounded-serving-property-record-${mutation}-`),
      );
      const relations = await relationInputs(root, processing);
      const reassigned = await mutateRelationRow(relations, 'public', 'property_query', (row) => {
        const fields = JSON.parse(String(row.field_source_ids_json)) as {
          field_name: string;
          source_ids: readonly string[];
          source_references: readonly Readonly<Record<string, unknown>>[];
          field_lineage_sha256: string;
        }[];
        const left = fields.find(({ field_name: fieldName }) => fieldName === fieldNames[0]);
        const right = fields.find(({ field_name: fieldName }) => fieldName === fieldNames[1]);
        if (left === undefined || right === undefined) throw new Error('fixture field lineage');
        const mutated = fields.map((field) => {
          if (field.field_name === fieldNames[0]) {
            const sourceReferences = right.source_references;
            return {
              ...field,
              ...(mutation === 'move_entire_binding' ? { source_ids: right.source_ids } : {}),
              source_references: sourceReferences,
              field_lineage_sha256: propertyQueryFieldLineageSha256(
                field.field_name,
                row[field.field_name],
                sourceReferences,
              ),
            };
          }
          if (field.field_name === fieldNames[1]) {
            const sourceReferences = left.source_references;
            return {
              ...field,
              ...(mutation === 'move_entire_binding' ? { source_ids: left.source_ids } : {}),
              source_references: sourceReferences,
              field_lineage_sha256: propertyQueryFieldLineageSha256(
                field.field_name,
                row[field.field_name],
                sourceReferences,
              ),
            };
          }
          return field;
        });
        row.field_source_ids_json = canonicalJson(mutated);
      });

      await expect(
        buildBoundedServingRelease({
          processing,
          relations: reassigned,
          ...controls,
          finalization: {
            attemptId: `property-record-${mutation}`,
            coordinator: controls.finalization.coordinator,
          },
          outputDirectory: join(root, 'release'),
          scratchDirectory: join(root, 'scratch'),
          writeBatchRecords: 1,
          maximumLineBytes: 64 * 1024,
        }),
      ).rejects.toBeInstanceOf(BoundedReleaseMetadataError);
    }

    const root = await mkdtemp(join(tmpdir(), 'oracle-bounded-serving-property-cross-property-'));
    const relations = await relationInputs(root, processing);
    const queryRelation = relations.find(
      ({ relation, visibility }) => relation === 'property_query' && visibility === 'public',
    );
    const queryArtifact = queryRelation?.artifacts?.[0];
    if (queryRelation === undefined || queryArtifact === undefined) {
      throw new Error('fixture property_query relation');
    }
    const propertyA = JSON.parse(
      (await readFile(new URL(queryArtifact.uri), 'utf8')).trim(),
    ) as Record<string, null | boolean | number | string>;
    const fieldName = 'roof_age_years';
    interface FieldBinding {
      field_name: string;
      source_ids: readonly string[];
      source_references: readonly Readonly<Record<string, unknown>>[];
      field_lineage_sha256: string;
    }
    const fieldsA = JSON.parse(String(propertyA.field_source_ids_json)) as FieldBinding[];
    const fieldA = fieldsA.find(({ field_name: candidate }) => candidate === fieldName);
    const referenceA = fieldA?.source_references[0];
    if (fieldA === undefined || referenceA === undefined) throw new Error('fixture roof lineage');
    const referenceB = Object.freeze({
      ...referenceA,
      recordKey: `${String(referenceA.recordKey)}:property-b`,
      recordSha256: digest(`fixture-record:${String(referenceA.recordKey)}:property-b`),
      lineageSha256: digest(`fixture-lineage:${fieldName}:property-b`),
    });
    const propertyB: Record<string, null | boolean | number | string> = {
      ...propertyA,
      property_id: `${String(propertyA.property_id)}:property-b`,
    };
    const fieldsB = fieldsA.map((field) => {
      const sourceReferences =
        field.field_name === fieldName ? Object.freeze([referenceB]) : field.source_references;
      return {
        ...field,
        source_references: sourceReferences,
        field_lineage_sha256: propertyQueryFieldLineageSha256(
          field.field_name,
          propertyB[field.field_name],
          sourceReferences,
        ),
      };
    });
    propertyB.field_source_ids_json = canonicalJson(fieldsB);

    const expectedBindings = new Map<string, string>();
    for (const row of [propertyA, propertyB]) {
      const propertyId = String(row.property_id);
      const fields = JSON.parse(String(row.field_source_ids_json)) as FieldBinding[];
      for (const field of fields) {
        expectedBindings.set(
          `${propertyId}\0${field.field_name}`,
          canonicalJson({
            fieldValue: row[field.field_name],
            reference: field.source_references[0],
          }),
        );
      }
    }
    const propertyScopedControls = {
      ...controls,
      trustedCanonicalLineage: Object.freeze({
        verifyPropertyQueryFieldReference: ({
          propertyId,
          fieldName: candidateField,
          fieldValue,
          reference,
        }: Parameters<
          BoundedTrustedCanonicalLineageResolver['verifyPropertyQueryFieldReference']
        >[0]) => {
          const expected = expectedBindings.get(`${propertyId}\0${candidateField}`);
          return expected === undefined
            ? controls.trustedCanonicalLineage.verifyPropertyQueryFieldReference({
                propertyId,
                fieldName: candidateField,
                fieldValue,
                reference,
              })
            : Promise.resolve(expected === canonicalJson({ fieldValue, reference }));
        },
      }),
    };
    const correct = await replaceRelationRows(relations, 'public', 'property_query', [
      propertyA,
      propertyB,
    ]);
    await expect(
      buildBoundedServingRelease({
        processing,
        relations: correct,
        ...propertyScopedControls,
        finalization: {
          attemptId: 'property-record-cross-property-correct',
          coordinator: controls.finalization.coordinator,
        },
        outputDirectory: join(root, 'correct-release'),
        scratchDirectory: join(root, 'correct-scratch'),
        writeBatchRecords: 1,
        maximumLineBytes: 64 * 1024,
      }),
    ).resolves.toBeDefined();

    const swappedFieldsA = fieldsA.map((field) =>
      field.field_name === fieldName
        ? {
            ...field,
            source_references: [referenceB],
            field_lineage_sha256: propertyQueryFieldLineageSha256(fieldName, propertyA[fieldName], [
              referenceB,
            ]),
          }
        : field,
    );
    const swappedPropertyA = {
      ...propertyA,
      field_source_ids_json: canonicalJson(swappedFieldsA),
    };
    const swapped = await replaceRelationRows(correct, 'public', 'property_query', [
      swappedPropertyA,
      propertyB,
    ]);
    await expect(
      buildBoundedServingRelease({
        processing,
        relations: swapped,
        ...propertyScopedControls,
        finalization: {
          attemptId: 'property-record-cross-property-swapped',
          coordinator: controls.finalization.coordinator,
        },
        outputDirectory: join(root, 'swapped-release'),
        scratchDirectory: join(root, 'swapped-scratch'),
        writeBatchRecords: 1,
        maximumLineBytes: 64 * 1024,
      }),
    ).rejects.toBeInstanceOf(BoundedReleaseMetadataError);
  });

  it('contains no whole-corpus production collection escape hatch', async () => {
    const source = await readFile(resolve(import.meta.dirname, 'bounded-release.ts'), 'utf8');
    expect(source).not.toMatch(/\b(?:readAll|runAndReadAll|getRowObjects|readFile|copyFile)\b/u);
    expect(source).not.toMatch(/new\s+Map\s*<[^>]*(?:Artifact|ServingRow)/u);
    expect(BoundedFinalizationRaceError).toBeDefined();
    expect(BOUNDED_PROCESSOR_COMPATIBILITY_POLICY.p8).toMatchObject({
      cid: P8_FROZEN_CID,
      manifestSha256: P8_FROZEN_MANIFEST_SHA256,
    });
    expect(() =>
      assertP8FrozenCompatibility(BOUNDED_PROCESSOR_COMPATIBILITY_POLICY.p8),
    ).not.toThrow();
  });

  it('shares leases across concurrent workers and releases them after errors', async () => {
    const policy = processingInput().budget;
    const shared = new ProcessWideServingBudget(policy);
    const releases = await Promise.all(
      [1, 2].map(async () => {
        await Promise.resolve();
        return shared.acquire(10, 4_096);
      }),
    );
    expect(shared.snapshot()).toMatchObject({ bufferedRecords: 20, bufferedBytes: 8_192 });
    expect(() => shared.acquire(policy.maxBufferedRecords, 1)).toThrow(BoundedServingBudgetError);
    for (const release of releases) release();
    expect(shared.snapshot()).toMatchObject({ bufferedRecords: 0, bufferedBytes: 0 });
  });

  it('verifies a 2,930-descriptor rollup policy without claiming a one-million-row execution', async () => {
    const processing = processingInput();
    const metadata = metadataFor('property_evidence', 'restricted', processing);
    const descriptorCount = 2_930;
    const descriptor = (sequence: number): ImmutableBoundedArtifact => {
      const recordCount = sequence === descriptorCount - 1 ? 1_211 : 341;
      const suffix = sequence.toString().padStart(4, '0');
      return Object.freeze({
        generationId: processing.generationId,
        stage: 'build_marts',
        dataset: 'restricted/property_evidence',
        partitionId: 0,
        sequence,
        logicalKey: `bounded/restricted/property_evidence/${suffix}.ndjson`,
        uri: `file:///immutable/property-evidence/${suffix}.ndjson`,
        mediaType: 'application/x-ndjson',
        byteSize: 1,
        sha256: digest(`descriptor:${suffix}`),
        recordCount,
        firstSortKey: suffix,
        lastSortKey: suffix,
        schemaSha256: boundedServingSchemaSha256('property_evidence'),
        sourceLineageSha256: boundedServingLineageSha256(metadata.sourceLineage),
        licenseIdentitySha256: boundedServingLicenseDecisionSha256(metadata.licenseDecision),
        visibility: 'restricted',
      });
    };
    const root = createHash('sha256');
    let byteSize = 0;
    for (let sequence = 0; sequence < descriptorCount; sequence += 1) {
      const artifact = descriptor(sequence);
      root.update(`${canonicalJson(artifact)}\n`);
      byteSize += artifact.byteSize;
    }
    const source: BoundedServingRelationInput = {
      visibility: 'restricted',
      relation: 'property_evidence',
      logicalSha256: digest('one-million-property-evidence-rows'),
      recordCount: 1_000_000,
      releaseMetadata: metadata,
      rowLineageRule: { kind: 'source_ids_and_references_exact' },
      artifactRollup: {
        format: 'oracle-bounded-serving-artifact-rollup-v1',
        descriptorCount,
        recordCount: 1_000_000,
        byteSize,
        descriptorRootSha256: root.digest('hex'),
        firstOrderKey: boundedArtifactOrderKey(descriptor(0)),
        lastOrderKey: boundedArtifactOrderKey(descriptor(descriptorCount - 1)),
      },
      streamArtifacts: async function* () {
        await Promise.resolve();
        for (let sequence = 0; sequence < descriptorCount; sequence += 1) {
          yield descriptor(sequence);
        }
      },
    };
    await expect(verifyBoundedServingArtifactInventory(source)).resolves.toBeUndefined();
  });

  it('binds serving rollups to an independently verified rooted build_marts manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oracle-bounded-serving-rooted-build-marts-'));
    const processing = processingInput();
    const inline = await relationInputs(root, processing);
    const artifacts = inline
      .flatMap((relation) => relation.artifacts ?? [])
      .sort((left, right) =>
        boundedArtifactOrderKey(left).localeCompare(boundedArtifactOrderKey(right)),
      );
    const firstArtifact = artifacts[0];
    const lastArtifact = artifacts.at(-1);
    if (firstArtifact === undefined || lastArtifact === undefined) {
      throw new Error('fixture rooted artifacts');
    }
    const pageWithoutHash = {
      format: 'oracle-bounded-descriptor-page-v1' as const,
      page: 0,
      descriptors: artifacts,
    };
    const page = {
      ...pageWithoutHash,
      pageSha256: boundedDescriptorPageSha256(pageWithoutHash),
    };
    const pageReference = {
      page: 0,
      uri: 'memory://build-marts/page/0',
      sha256: digest(canonicalJson(page)),
      descriptorCount: artifacts.length,
      firstOrderKey: boundedArtifactOrderKey(firstArtifact),
      lastOrderKey: boundedArtifactOrderKey(lastArtifact),
    };
    const pageIndex = {
      format: 'oracle-bounded-descriptor-page-index-v1' as const,
      pages: [pageReference],
    };
    const descriptorRootSha256 = createHash('sha256')
      .update(artifacts.map((artifact) => `${canonicalJson(artifact)}\n`).join(''))
      .digest('hex');
    const base = buildMartsManifest(processing, inline);
    const rootedPayload = {
      ...base,
      artifacts: [],
      artifactInventory: {
        root: {
          format: 'oracle-bounded-descriptor-root-v1' as const,
          descriptorCount: artifacts.length,
          recordCount: artifacts.reduce((total, artifact) => total + artifact.recordCount, 0),
          byteSize: artifacts.reduce((total, artifact) => total + artifact.byteSize, 0),
          rootSha256: descriptorRootSha256,
          firstOrderKey: boundedArtifactOrderKey(firstArtifact),
          lastOrderKey: boundedArtifactOrderKey(lastArtifact),
          pageCount: 1,
          pageIndexUri: 'memory://build-marts/index',
          pageIndexSha256: digest(canonicalJson(pageIndex)),
        },
        datasets: inline
          .map((relation) => {
            const artifact = relation.artifacts?.[0];
            if (artifact === undefined) throw new Error('fixture rooted artifact');
            return {
              dataset: `${relation.visibility}/${relation.relation}`,
              artifactCount: 1,
              recordCount: artifact.recordCount,
              rootSha256: digest(`${canonicalJson(artifact)}\n`),
            };
          })
          .sort((left, right) => left.dataset.localeCompare(right.dataset)),
      },
    };
    const manifest = {
      ...rootedPayload,
      manifestSha256: boundedStageManifestSha256(rootedPayload),
    };
    const relations = inline.map((relation) => {
      const artifact = relation.artifacts?.[0];
      if (artifact === undefined) throw new Error('fixture rooted artifact');
      const { artifacts: ignoredArtifacts, ...relationWithoutArtifacts } = relation;
      void ignoredArtifacts;
      const orderKey = boundedArtifactOrderKey(artifact);
      return {
        ...relationWithoutArtifacts,
        artifactRollup: {
          format: 'oracle-bounded-serving-artifact-rollup-v1' as const,
          descriptorCount: 1,
          recordCount: artifact.recordCount,
          byteSize: artifact.byteSize,
          descriptorRootSha256: digest(`${canonicalJson(artifact)}\n`),
          firstOrderKey: orderKey,
          lastOrderKey: orderKey,
        },
        streamArtifacts: async function* () {
          await Promise.resolve();
          yield artifact;
        },
      };
    });
    const completedBuildMarts = {
      manifest,
      resolver: {
        loadPageIndex: () => Promise.resolve(pageIndex),
        loadPage: () => Promise.resolve(page),
      },
    };
    await expect(
      buildBoundedServingRelease({
        processing,
        relations,
        completedBuildMarts,
        ...releaseControls(processing),
        outputDirectory: join(root, 'release'),
        scratchDirectory: join(root, 'scratch'),
        writeBatchRecords: 1,
        maximumLineBytes: 64 * 1024,
      }),
    ).resolves.toMatchObject({ adoptedIdenticalWinner: false });

    const first = relations[0];
    if (first?.artifactRollup === undefined) throw new Error('fixture rooted relation');
    const forgedRollup = [
      {
        ...first,
        artifactRollup: { ...first.artifactRollup, descriptorRootSha256: HASH_D },
      },
      ...relations.slice(1),
    ];
    await expect(
      buildBoundedServingRelease({
        processing,
        relations: forgedRollup,
        completedBuildMarts,
        ...releaseControls(processing),
        finalization: {
          attemptId: 'forged-root-attempt',
          coordinator: releaseControls(processing).finalization.coordinator,
        },
        outputDirectory: join(root, 'forged-release'),
        scratchDirectory: join(root, 'forged-scratch'),
        writeBatchRecords: 1,
        maximumLineBytes: 64 * 1024,
      }),
    ).rejects.toBeInstanceOf(BoundedBuildConfigurationError);
  }, 120_000);

  it('emits no false contributor lineage for unknown no-observation evidence rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oracle-bounded-serving-no-observation-'));
    const processing = processingInput();
    const relations = await relationInputs(root, processing, false, true);
    const result = await buildBoundedServingRelease({
      processing,
      relations,
      ...releaseControls(processing),
      outputDirectory: join(root, 'release'),
      scratchDirectory: join(root, 'scratch'),
      writeBatchRecords: 1,
      maximumLineBytes: 64 * 1024,
    });
    const evidenceArtifacts = result.manifest.artifacts.filter(
      ({ relation }) => relation === 'property_evidence',
    );
    expect(evidenceArtifacts).toHaveLength(2);
    expect(evidenceArtifacts.every(({ sourceLineage }) => sourceLineage.length === 0)).toBe(true);
  });

  it('recovers a post-CAS crash and serializes concurrent finalizers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oracle-bounded-serving-finalization-'));
    const processing = processingInput();
    const relations = await relationInputs(root, processing);
    const controls = releaseControls(processing);
    const finalizer = controls.finalization.coordinator;
    if (!(finalizer instanceof TestFinalizer)) throw new Error('fixture finalizer');
    finalizer.injectCrashAfterCas();
    const destination = join(root, 'crash-release');
    await expect(
      buildBoundedServingRelease({
        processing,
        relations,
        ...controls,
        outputDirectory: destination,
        scratchDirectory: join(root, 'crash-scratch-a'),
        writeBatchRecords: 1,
        maximumLineBytes: 64 * 1024,
      }),
    ).rejects.toThrow('injected crash after finalization CAS');
    const recovered = await buildBoundedServingRelease({
      processing,
      relations,
      ...controls,
      finalization: { attemptId: 'fixture-attempt-a', coordinator: finalizer },
      outputDirectory: destination,
      scratchDirectory: join(root, 'crash-scratch-b'),
      writeBatchRecords: 1,
      maximumLineBytes: 64 * 1024,
    });
    expect(recovered.adoptedIdenticalWinner).toBe(true);
    await expect(verifyBoundedServingRelease(destination)).resolves.toBeDefined();
    await expect(
      buildBoundedServingRelease({
        processing,
        relations,
        ...controls,
        finalization: { attemptId: 'fixture-attempt-b', coordinator: finalizer },
        outputDirectory: destination,
        scratchDirectory: join(root, 'crash-scratch-c'),
        writeBatchRecords: 1,
        maximumLineBytes: 64 * 1024,
      }),
    ).rejects.toBeInstanceOf(BoundedFinalizationRaceError);

    const concurrentDestination = join(root, 'concurrent-release');
    const concurrent = await Promise.allSettled(
      ['concurrent-a', 'concurrent-b'].map((attemptId) =>
        buildBoundedServingRelease({
          processing,
          relations,
          ...controls,
          finalization: { attemptId, coordinator: finalizer },
          outputDirectory: concurrentDestination,
          scratchDirectory: join(root, `scratch-${attemptId}`),
          writeBatchRecords: 1,
          maximumLineBytes: 64 * 1024,
        }),
      ),
    );
    expect(concurrent.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    const rejected = concurrent.find(({ status }) => status === 'rejected');
    expect(rejected?.status === 'rejected' ? rejected.reason : undefined).toBeInstanceOf(
      BoundedFinalizationRaceError,
    );
  }, 120_000);

  it('requires exact completed build_marts artifact membership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oracle-bounded-serving-membership-'));
    const processing = processingInput();
    const relations = await relationInputs(root, processing);
    const completedBuildMarts = { manifest: buildMartsManifest(processing, relations) };
    const first = relations[0];
    const artifact = first?.artifacts?.[0];
    if (first === undefined || artifact === undefined) throw new Error('fixture relation');
    const substituted = [
      { ...first, artifacts: [{ ...artifact, sha256: HASH_D }] },
      ...relations.slice(1),
    ];
    await expect(
      buildBoundedServingRelease({
        processing,
        relations: substituted,
        completedBuildMarts,
        ...releaseControls(processing),
        outputDirectory: join(root, 'release'),
        scratchDirectory: join(root, 'scratch'),
        writeBatchRecords: 1,
        maximumLineBytes: 64 * 1024,
      }),
    ).rejects.toBeInstanceOf(BoundedReleaseCorruptionError);
  });

  it('validates row-exact acquired lineage and explicit no-column lineage rules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oracle-bounded-serving-row-lineage-'));
    const processing = processingInput();
    const relations = await relationInputs(root, processing);
    const forgedReferences = await mutateRelationRow(
      relations,
      'public',
      'property_evidence',
      (row) => {
        const references = JSON.parse(String(row.source_references_json)) as Record<
          string,
          unknown
        >[];
        const first = references[0];
        if (first === undefined) throw new Error('fixture source reference');
        first.artifactId = `sc:artifact:sha256:${HASH_D}`;
        row.source_references_json = canonicalJson(references);
      },
    );
    await expect(
      buildBoundedServingRelease({
        processing,
        relations: forgedReferences,
        ...releaseControls(processing),
        outputDirectory: join(root, 'forged-release'),
        scratchDirectory: join(root, 'forged-scratch'),
        writeBatchRecords: 1,
        maximumLineBytes: 64 * 1024,
      }),
    ).rejects.toBeInstanceOf(BoundedReleaseMetadataError);

    const fresh = await relationInputs(join(root, 'metadata'), processing);
    const metadataOnly = fresh.find(
      ({ rowLineageRule }) => rowLineageRule.kind === 'trusted_relation_metadata',
    );
    if (metadataOnly?.rowLineageRule.kind !== 'trusted_relation_metadata') {
      throw new Error('fixture metadata-only relation');
    }
    const forgedRule = fresh.map((candidate) =>
      candidate === metadataOnly
        ? {
            ...candidate,
            rowLineageRule: { ...metadataOnly.rowLineageRule, sourceLineageSha256: HASH_D },
          }
        : candidate,
    );
    await expect(
      buildBoundedServingRelease({
        processing,
        relations: forgedRule,
        ...releaseControls(processing),
        outputDirectory: join(root, 'rule-release'),
        scratchDirectory: join(root, 'rule-scratch'),
        writeBatchRecords: 1,
        maximumLineBytes: 64 * 1024,
      }),
    ).rejects.toBeInstanceOf(BoundedReleaseMetadataError);
  });

  it('rejects normalized sensitive keys with string, number, and boolean leaves', async () => {
    const cases: readonly (readonly [string, string | number | boolean])[] = [
      ['ownerName', 'private'],
      ['owner-name', 17],
      ['owner name', true],
      ['owner.name', 'private'],
      ['mailingAddress', 90210],
      ['mailing-address', false],
    ];
    const processing = processingInput();
    for (const [index, [key, value]] of cases.entries()) {
      const root = await mkdtemp(join(tmpdir(), `oracle-bounded-sensitive-${index}-`));
      const relations = await relationInputs(root, processing);
      const sensitive = await mutateRelationRow(relations, 'public', 'property_evidence', (row) => {
        row.value_json = canonicalJson({ [key]: value });
      });
      await expect(
        buildBoundedServingRelease({
          processing,
          relations: sensitive,
          ...releaseControls(processing),
          finalization: {
            attemptId: `sensitive-${index}`,
            coordinator: releaseControls(processing).finalization.coordinator,
          },
          outputDirectory: join(root, 'release'),
          scratchDirectory: join(root, 'scratch'),
          writeBatchRecords: 1,
          maximumLineBytes: 64 * 1024,
        }),
      ).rejects.toBeInstanceOf(BoundedPublicPrivacyError);
    }
  }, 120_000);

  it('requires a shared coordinator at one worker, bounds metadata early, and denies revision ABA', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oracle-bounded-serving-adversarial-'));
    const processing = processingInput({ budget: { ...processingInput().budget, maxWorkers: 1 } });
    const relations = await relationInputs(root, processing);
    const controls = releaseControls(processing);
    const completedBuildMarts = { manifest: buildMartsManifest(processing, relations) };
    const checkpoint = checkpointForBuildMarts(controls.checkpoint, completedBuildMarts.manifest);
    await expect(
      buildBoundedServingReleasePackage({
        processing,
        relations,
        ...controls,
        checkpoint,
        completedBuildMarts,
        outputDirectory: join(root, 'missing-budget-release'),
        scratchDirectory: join(root, 'missing-budget-scratch'),
        writeBatchRecords: 1,
        maximumLineBytes: 64 * 1024,
      } as unknown as BoundedServingReleaseBuildInput),
    ).rejects.toBeInstanceOf(BoundedBuildConfigurationError);

    const first = relations[0];
    if (first === undefined) throw new Error('fixture relation');
    const hostile = [
      {
        ...first,
        releaseMetadata: {
          ...first.releaseMetadata,
          sourceLineage: Array.from({ length: 65 }, () => first.releaseMetadata.sourceLineage[0]),
        },
      },
      ...relations.slice(1),
    ] as readonly BoundedServingRelationInput[];
    await expect(
      buildBoundedServingRelease({
        processing,
        relations: hostile,
        ...controls,
        outputDirectory: join(root, 'hostile-release'),
        scratchDirectory: join(root, 'hostile-scratch'),
        writeBatchRecords: 1,
        maximumLineBytes: 64 * 1024,
      }),
    ).rejects.toBeInstanceOf(BoundedBuildConfigurationError);

    const aba = new TestFinalizer();
    aba.injectAbaAfterFinalize();
    await expect(
      buildBoundedServingRelease({
        processing,
        relations,
        ...controls,
        finalization: { attemptId: 'aba-attempt', coordinator: aba },
        outputDirectory: join(root, 'aba-release'),
        scratchDirectory: join(root, 'aba-scratch'),
        writeBatchRecords: 1,
        maximumLineBytes: 64 * 1024,
      }),
    ).rejects.toBeInstanceOf(BoundedFinalizationRaceError);
  }, 120_000);

  it('rejects RSS overflow and combined stream buffers without retaining leases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oracle-bounded-serving-budget-'));
    const processing = processingInput();
    const relations = await relationInputs(root, processing);
    const rssBudget = new ProcessWideServingBudget(processing.budget);
    await expect(
      buildBoundedServingRelease({
        processing,
        relations,
        ...releaseControls(processing),
        outputDirectory: join(root, 'rss-release'),
        scratchDirectory: join(root, 'rss-scratch'),
        writeBatchRecords: 1,
        maximumLineBytes: 64 * 1024,
        sharedBudget: rssBudget,
        rssSampler: () => processing.budget.maxRssBytes + 1,
      }),
    ).rejects.toBeInstanceOf(BoundedServingBudgetError);
    expect(rssBudget.snapshot()).toMatchObject({ bufferedRecords: 0, bufferedBytes: 0 });

    const tinyPolicy = {
      ...processing.budget,
      maxBufferedBytes: 512,
      maxBytesPerOutputChunk: 512,
    };
    const tinyProcessing = processingInput({ budget: tinyPolicy });
    const oversized = await relationInputs(join(root, 'combined'), tinyProcessing);
    const combinedBudget = new ProcessWideServingBudget(tinyProcessing.budget);
    await expect(
      buildBoundedServingRelease({
        processing: tinyProcessing,
        relations: oversized,
        ...releaseControls(tinyProcessing),
        outputDirectory: join(root, 'combined-release'),
        scratchDirectory: join(root, 'combined-scratch'),
        writeBatchRecords: 1,
        maximumLineBytes: 512,
        sharedBudget: combinedBudget,
        rssSampler: () => 1,
      }),
    ).rejects.toBeInstanceOf(BoundedServingBudgetError);
    expect(combinedBudget.snapshot()).toMatchObject({ bufferedRecords: 0, bufferedBytes: 0 });
  });
});

async function relationInputs(
  root: string,
  processing: BoundedProcessingInput,
  sensitivePublic: false | 'string' | 'number' | 'boolean' = false,
  noObservationEvidence = false,
): Promise<readonly BoundedServingRelationInput[]> {
  const inputs: BoundedServingRelationInput[] = [];
  const trusted = trustedByProcessing.get(processing);
  if (trusted === undefined) throw new Error('fixture trusted acquisition');
  for (const visibility of ['public', 'restricted'] as const) {
    for (const [relationIndex, relation] of BOUNDED_COUNTY_SERVING_RELATIONS.entries()) {
      const baseMetadata = metadataFor(relation, visibility, processing, relationIndex);
      const noObservation = noObservationEvidence && relation === 'property_evidence';
      const releaseMetadata = noObservation
        ? Object.freeze({ ...baseMetadata, sourceLineage: Object.freeze([]) })
        : baseMetadata;
      const contributor = releaseMetadata.sourceLineage[0]?.sourceId;
      if (contributor === undefined && !noObservation) throw new Error('fixture contributor');
      const acquired = trusted.sources.find(({ sourceId }) => sourceId === contributor);
      const acquiredArtifact = acquired?.acquiredArtifacts[0];
      const row = fixtureRow(
        relation,
        visibility,
        contributor,
        acquiredArtifact === undefined || acquired === undefined
          ? undefined
          : {
              sourceId: acquired.sourceId,
              snapshotId: acquired.snapshotId,
              artifactId: acquiredArtifact.artifactId,
              recordKey: 'fixture-record',
              fieldPaths: ['/fixture'],
            },
        sensitivePublic,
        noObservation,
      );
      const body = `${canonicalJson(row)}\n`;
      const directory = join(root, 'chunks', visibility);
      const path = join(directory, `${relation}.ndjson`);
      await mkdir(directory, { recursive: true });
      await writeFile(path, body, { encoding: 'utf8', flag: 'w' });
      const sha256 = digest(body);
      const sortKey = boundedServingRowSortKey(relation, row);
      const artifact: ImmutableBoundedArtifact = {
        generationId: processing.generationId,
        stage: 'build_marts',
        dataset: `${visibility}/${relation}`,
        partitionId: 0,
        sequence: 0,
        logicalKey: `bounded/${visibility}/${relation}/0.ndjson`,
        uri: pathToFileURL(path).href,
        mediaType: 'application/x-ndjson',
        byteSize: Buffer.byteLength(body),
        sha256,
        recordCount: 1,
        firstSortKey: sortKey,
        lastSortKey: sortKey,
        schemaSha256: boundedServingSchemaSha256(relation),
        sourceLineageSha256: boundedServingLineageSha256(releaseMetadata.sourceLineage),
        licenseIdentitySha256: boundedServingLicenseDecisionSha256(releaseMetadata.licenseDecision),
        visibility,
      };
      inputs.push({
        visibility,
        relation,
        artifacts: [artifact],
        logicalSha256: sha256,
        recordCount: 1,
        releaseMetadata,
        rowLineageRule: rowLineageRule(relation, releaseMetadata),
      });
    }
  }
  return inputs;
}

async function mutateRelationRow(
  relations: readonly BoundedServingRelationInput[],
  visibility: ServingVisibility,
  relation: (typeof BOUNDED_COUNTY_SERVING_RELATIONS)[number],
  mutate: (row: Record<string, null | boolean | number | string>) => void,
): Promise<readonly BoundedServingRelationInput[]> {
  const target = relations.find(
    (candidate) => candidate.visibility === visibility && candidate.relation === relation,
  );
  const artifact = target?.artifacts?.[0];
  if (target === undefined || artifact === undefined) throw new Error('fixture relation');
  const path = new URL(artifact.uri);
  const row = JSON.parse((await readFile(path, 'utf8')).trim()) as Record<
    string,
    null | boolean | number | string
  >;
  mutate(row);
  const body = `${canonicalJson(row)}\n`;
  await writeFile(path, body, { encoding: 'utf8', flag: 'w' });
  const sha256 = digest(body);
  const sortKey = boundedServingRowSortKey(relation, row);
  const next = {
    ...target,
    logicalSha256: sha256,
    artifacts: [
      {
        ...artifact,
        sha256,
        byteSize: Buffer.byteLength(body),
        firstSortKey: sortKey,
        lastSortKey: sortKey,
      },
    ],
  };
  return relations.map((candidate) => (candidate === target ? next : candidate));
}

async function replaceRelationRows(
  relations: readonly BoundedServingRelationInput[],
  visibility: ServingVisibility,
  relation: (typeof BOUNDED_COUNTY_SERVING_RELATIONS)[number],
  rows: readonly Record<string, null | boolean | number | string>[],
): Promise<readonly BoundedServingRelationInput[]> {
  const target = relations.find(
    (candidate) => candidate.visibility === visibility && candidate.relation === relation,
  );
  const artifact = target?.artifacts?.[0];
  if (target === undefined || artifact === undefined) throw new Error('fixture relation');
  const ordered = [...rows].sort((left, right) => {
    const leftKey = boundedServingRowSortKey(relation, left);
    const rightKey = boundedServingRowSortKey(relation, right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const body = ordered.map((row) => `${canonicalJson(row)}\n`).join('');
  await writeFile(new URL(artifact.uri), body, { encoding: 'utf8', flag: 'w' });
  const sha256 = digest(body);
  const next = {
    ...target,
    logicalSha256: sha256,
    recordCount: ordered.length,
    artifacts: [
      {
        ...artifact,
        sha256,
        byteSize: Buffer.byteLength(body),
        recordCount: ordered.length,
        firstSortKey: boundedServingRowSortKey(relation, ordered[0] ?? {}),
        lastSortKey: boundedServingRowSortKey(relation, ordered.at(-1) ?? {}),
      },
    ],
  };
  return relations.map((candidate) => (candidate === target ? next : candidate));
}

function rowLineageRule(
  relation: (typeof BOUNDED_COUNTY_SERVING_RELATIONS)[number],
  metadata: BoundedServingReleaseMetadata,
): BoundedServingRelationInput['rowLineageRule'] {
  const columns = new Set(BOUNDED_SERVING_RELATIONS[relation].columns.map(({ name }) => name));
  if (columns.has('source_references_json')) {
    return Object.freeze({ kind: 'source_ids_and_references_exact' as const });
  }
  if (columns.has('source_ids_json')) {
    return Object.freeze({ kind: 'source_ids_exact' as const });
  }
  if (columns.has('source_id')) {
    return Object.freeze({ kind: 'source_id_exact' as const });
  }
  return Object.freeze({
    kind: 'trusted_relation_metadata' as const,
    policyVersion: 'bounded-trusted-relation-lineage-v1' as const,
    sourceLineageSha256: boundedServingLineageSha256(metadata.sourceLineage),
  });
}

function fixtureRow(
  relation: (typeof BOUNDED_COUNTY_SERVING_RELATIONS)[number],
  visibility: ServingVisibility,
  contributor: string | undefined,
  sourceReference: Readonly<Record<string, unknown>> | undefined,
  sensitivePublic: false | 'string' | 'number' | 'boolean',
  noObservation: boolean,
): ServingRow {
  const definition = BOUNDED_SERVING_RELATIONS[relation];
  const row: Record<string, null | boolean | number | string> = {};
  for (const column of definition.columns) {
    if (column.name === 'visibility') row[column.name] = visibility;
    else if (column.name === 'source_id') row[column.name] = contributor ?? '';
    else if (column.name === 'source_ids_json') {
      row[column.name] = canonicalJson(contributor === undefined ? [] : [contributor]);
    } else if (column.name === 'field_source_ids_json') {
      row[column.name] = canonicalJson(
        definition.columns
          .map(({ name }) => name)
          .filter((name) => name !== 'source_ids_json' && name !== 'field_source_ids_json')
          .sort()
          .map((fieldName) => {
            const sourceReferences =
              sourceReference === undefined
                ? []
                : [fixturePropertyQuerySourceReference(fieldName, sourceReference)];
            return {
              field_name: fieldName,
              source_ids: contributor === undefined ? [] : [contributor],
              source_references: sourceReferences,
              field_lineage_sha256: propertyQueryFieldLineageSha256(
                fieldName,
                row[fieldName],
                sourceReferences,
              ),
            };
          }),
      );
    } else if (column.name === 'source_references_json') {
      row[column.name] = canonicalJson(sourceReference === undefined ? [] : [sourceReference]);
    } else if (column.name.endsWith('_json')) {
      row[column.name] =
        sensitivePublic === 'string' &&
        visibility === 'public' &&
        relation === 'property_evidence' &&
        column.name === 'value_json'
          ? '{"owner_name":"private person"}'
          : sensitivePublic === 'number' &&
              visibility === 'public' &&
              relation === 'property_evidence' &&
              column.name === 'value_json'
            ? '{"owner_ssn":123456789}'
            : sensitivePublic === 'boolean' &&
                visibility === 'public' &&
                relation === 'property_evidence' &&
                column.name === 'value_json'
              ? '{"is_owner_occupied":true}'
              : column.name.includes('limitations')
                ? '[]'
                : '{}';
    } else if (column.name === 'support_class' || column.name.endsWith('_support_class')) {
      row[column.name] = noObservation ? 'unknown' : 'supported';
    } else if (column.duckdbType === 'VARCHAR') {
      row[column.name] = `${visibility}-${relation}-${column.name}`;
    } else if (column.duckdbType === 'BOOLEAN') row[column.name] = false;
    else row[column.name] = 1;
  }
  return Object.freeze(row);
}

function fixturePropertyQuerySourceReference(
  fieldName: string,
  sourceReference: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const recordKey = `${String(sourceReference.recordKey)}:${fieldName}`;
  return Object.freeze({
    ...sourceReference,
    recordKey,
    recordSha256: digest(`fixture-record:${recordKey}`),
    lineageSha256: digest(`fixture-lineage:${fieldName}`),
    fieldPaths: Object.freeze([`/fixture/${fieldName}`]),
  });
}

function propertyQueryFieldLineageSha256(
  fieldName: string,
  value: ServingRow[string] | undefined,
  sourceReferences: readonly Readonly<Record<string, unknown>>[],
): string {
  if (value === undefined) throw new Error(`fixture field ${fieldName}`);
  return digest(
    `${canonicalJson({
      contract: 'oracle-property-query-field-lineage-v1',
      fieldName,
      value,
      sourceReferences,
    })}\n`,
  );
}

function rebindPropertyQueryFieldLineage(
  row: Record<string, null | boolean | number | string>,
  fieldName: string,
): void {
  const fields = JSON.parse(String(row.field_source_ids_json)) as {
    field_name: string;
    source_ids: readonly string[];
    source_references: readonly Readonly<Record<string, unknown>>[];
    field_lineage_sha256: string;
  }[];
  row.field_source_ids_json = canonicalJson(
    fields.map((field) =>
      field.field_name === fieldName
        ? {
            ...field,
            field_lineage_sha256: propertyQueryFieldLineageSha256(
              fieldName,
              row[fieldName],
              field.source_references,
            ),
          }
        : field,
    ),
  );
}

function metadataFor(
  relation: string,
  visibility: ServingVisibility,
  processing: BoundedProcessingInput,
  relationIndex = 0,
): BoundedServingReleaseMetadata {
  const trusted = trustedByProcessing.get(processing);
  const source = trusted?.sources[relationIndex % trusted.sources.length];
  if (source === undefined) throw new Error('fixture source');
  return Object.freeze({
    sourceLineage: Object.freeze([
      Object.freeze({
        sourceId: source.sourceId,
        snapshotId: source.snapshotId,
        sourceSha256: source.sourceSha256,
        schemaSha256: source.schemaSha256,
        asOf: source.asOf,
        contributors: source.contributors,
        role: relation === 'data_dictionary' ? ('derived' as const) : ('direct' as const),
      }),
    ]),
    limitations: Object.freeze([`Exact ${relation} fixture limitation.`]),
    licenseDecision: Object.freeze({
      policyVersion: 'release-license-v1',
      contentClass: relation === 'data_dictionary' ? 'schema_metadata' : `fixture_${relation}`,
      decision:
        visibility === 'public' ? ('allowed_public' as const) : ('restricted_only' as const),
      licenseSnapshotRefs: Object.freeze([`license:${relation}:${visibility}`]),
    }),
  });
}

function releaseControls(
  processing: BoundedProcessingInput,
): Pick<
  BoundedServingReleaseBuildInput,
  | 'dictionaryReleaseMetadata'
  | 'checkpoint'
  | 'trustedAcquisition'
  | 'trustedCanonicalLineage'
  | 'finalization'
  | 'releaseGate'
> {
  const manifest = trustedByProcessing.get(processing);
  if (manifest === undefined) throw new Error('fixture trusted acquisition');
  let finalizer = finalizerByProcessing.get(processing);
  if (finalizer === undefined) {
    finalizer = new TestFinalizer();
    finalizerByProcessing.set(processing, finalizer);
  }
  const trustedCanonicalLineage: BoundedTrustedCanonicalLineageResolver = Object.freeze({
    verifyPropertyQueryFieldReference: ({
      fieldName,
      reference,
    }: Parameters<
      BoundedTrustedCanonicalLineageResolver['verifyPropertyQueryFieldReference']
    >[0]) => {
      const recordKey = `fixture-record:${fieldName}`;
      return Promise.resolve(
        reference.recordKey === recordKey &&
          reference.recordSha256 === digest(`fixture-record:${recordKey}`) &&
          reference.lineageSha256 === digest(`fixture-lineage:${fieldName}`) &&
          canonicalJson(reference.fieldPaths) === canonicalJson([`/fixture/${fieldName}`]),
      );
    },
  });
  return {
    dictionaryReleaseMetadata: Object.freeze({
      public: dictionaryMetadata('public', processing),
      restricted: dictionaryMetadata('restricted', processing),
    }),
    checkpoint: processingCheckpoint(processing),
    trustedAcquisition: Object.freeze({
      reference: Object.freeze({
        uri: 'file:///trusted/acquisition-manifest.json',
        manifestSha256: manifest.manifestSha256,
      }),
      resolver: Object.freeze({
        loadVerified: () => Promise.resolve(manifest),
      }),
    }),
    trustedCanonicalLineage,
    finalization: Object.freeze({ attemptId: 'fixture-attempt-a', coordinator: finalizer }),
    releaseGate: Object.freeze({
      sourceManifestSha256: processing.sourceManifestSha256,
      capabilityStateSha256: processing.capabilityStateSha256,
      requestedScope: 'partial_county' as const,
      runStatus: manifest.runStatus,
      sourceStates: Object.freeze(
        manifest.sources.map(
          ({ sourceId, snapshotId, terminalState, permissionState, limitations }) =>
            Object.freeze({ sourceId, snapshotId, terminalState, permissionState, limitations }),
        ),
      ),
      capabilities: REAL_COUNTY_CAPABILITIES.map((capability) => {
        const evidence = manifest.capabilities.find(
          (candidate) => candidate.capability === capability,
        );
        if (evidence === undefined) throw new Error(`fixture capability ${capability}`);
        return Object.freeze({
          capability,
          state: evidence.state,
          sourceIds: evidence.sourceIds,
          limitations: evidence.limitations,
        });
      }),
      permitAuthoritiesCovered: new Set(
        manifest.sources.flatMap(({ permitAuthorityIds }) => permitAuthorityIds),
      ).size,
    }),
  };
}

function releaseControlsOmittingFailedLineage(
  processing: BoundedProcessingInput,
): ReturnType<typeof releaseControls> {
  const controls = releaseControls(processing);
  const manifest = trustedByProcessing.get(processing);
  if (manifest === undefined) throw new Error('fixture trusted acquisition');
  const failedSourceIds = new Set<string>(
    manifest.sources
      .filter(({ terminalState }) => terminalState === 'failed')
      .map(({ sourceId }) => sourceId),
  );
  const omitFailed = (metadata: BoundedServingReleaseMetadata): BoundedServingReleaseMetadata =>
    Object.freeze({
      ...metadata,
      sourceLineage: Object.freeze(
        metadata.sourceLineage.filter(({ sourceId }) => !failedSourceIds.has(sourceId)),
      ),
    });
  return Object.freeze({
    ...controls,
    dictionaryReleaseMetadata: Object.freeze({
      public: omitFailed(controls.dictionaryReleaseMetadata.public),
      restricted: omitFailed(controls.dictionaryReleaseMetadata.restricted),
    }),
  });
}

async function downgradePropertyQueryClaim(
  relations: readonly BoundedServingRelationInput[],
  prefix: 'ownership' | 'regional_owner' | 'roof' | 'water' | 'transit' | 'starbucks',
): Promise<readonly BoundedServingRelationInput[]> {
  let current = relations;
  const supportField = `${prefix}_support_class`;
  const valueFields = {
    ownership: ['years_since_exchange', 'last_exchange_date'],
    regional_owner: ['is_regional_owner'],
    roof: ['roof_age_years', 'roof_reference_date'],
    water: ['water_distance_meters', 'water_visibility_state'],
    transit: ['transit_distance_meters', 'transit_walk_minutes'],
    starbucks: ['starbucks_distance_meters', 'starbucks_walk_minutes'],
  }[prefix];
  const claimFields = new Set([supportField, ...valueFields]);
  for (const visibility of ['public', 'restricted'] as const) {
    current = await mutateRelationRow(current, visibility, 'property_query', (row) => {
      row[supportField] = 'unknown';
      for (const fieldName of valueFields) row[fieldName] = null;
      const fields = JSON.parse(String(row.field_source_ids_json)) as {
        field_name: string;
        source_ids: readonly string[];
        source_references: readonly Readonly<Record<string, unknown>>[];
        field_lineage_sha256: string;
      }[];
      row.field_source_ids_json = canonicalJson(
        fields.map((field) =>
          claimFields.has(field.field_name)
            ? {
                ...field,
                source_ids: [],
                source_references: [],
                field_lineage_sha256: propertyQueryFieldLineageSha256(
                  field.field_name,
                  row[field.field_name],
                  [],
                ),
              }
            : field,
        ),
      );
    });
  }
  return current;
}

function dictionaryMetadata(
  visibility: ServingVisibility,
  processing: BoundedProcessingInput,
): BoundedServingReleaseMetadata {
  const trusted = trustedByProcessing.get(processing);
  if (trusted === undefined) throw new Error('fixture trusted acquisition');
  return Object.freeze({
    sourceLineage: Object.freeze(
      trusted.sources.map((source) =>
        Object.freeze({
          sourceId: source.sourceId,
          snapshotId: source.snapshotId,
          sourceSha256: source.sourceSha256,
          schemaSha256: source.schemaSha256,
          asOf: source.asOf,
          contributors: source.contributors,
          role: 'derived' as const,
        }),
      ),
    ),
    limitations: Object.freeze(['Exact data_dictionary fixture limitation.']),
    licenseDecision: Object.freeze({
      policyVersion: 'release-license-v1',
      contentClass: 'schema_metadata',
      decision:
        visibility === 'public' ? ('allowed_public' as const) : ('restricted_only' as const),
      licenseSnapshotRefs: Object.freeze(
        trusted.sources
          .map((source) => source.acquiredArtifacts[0]?.licenseSnapshotRef ?? '')
          .sort(),
      ),
    }),
  });
}

function processingInput(
  overrides: Readonly<{ budget?: BoundedProcessingInput['budget'] }> = {},
): BoundedProcessingInput {
  const runId = runIdSchema.parse(`sc:run:${HASH_A}`);
  const trusted = trustedManifest(runId);
  const mutationWithoutHash: Omit<BoundedMutationLogInput, 'physicalManifestSha256'> = {
    format: 'oracle-bounded-mutation-log-v2',
    recordCount: trusted.sources.length,
    logicalSha256: HASH_A,
    mutationSchemaSha256: HASH_B,
    sources: trusted.sources.map((source, sequence) => {
      const sha256 = digest(`mutation:${source.sourceId}`);
      return {
        sourceId: source.sourceId,
        snapshotId: source.snapshotId,
        mutationSchemaSha256: HASH_B,
        recordCount: 1,
        logicalSha256: sha256,
        chunks: [
          {
            schemaVersion: '2.0.0',
            sequence: 0,
            firstOrdinal: 0,
            lastOrdinal: 0,
            recordCount: 1,
            logicalKey: `test/mutations/${sequence}.ndjson`,
            uri: `file:///immutable/mutations/${sequence}.ndjson`,
            mediaType: 'application/x-ndjson',
            byteSize: 1,
            sha256,
            visibility: 'restricted',
            licenseSnapshotRef: source.acquiredArtifacts[0]?.licenseSnapshotRef ?? 'license:test',
            resumeCursor: null,
          },
        ],
      };
    }),
  };
  const mutationLog = {
    ...mutationWithoutHash,
    physicalManifestSha256: physicalMutationManifestSha256(mutationWithoutHash),
  };
  const semantic = {
    contractVersion: BOUNDED_PROCESSING_CONTRACT_VERSION,
    processorKind: BOUNDED_PROCESSOR_KIND,
    runId,
    pipelineVersion: '2.0.0',
    profile: 'full' as const,
    configurationSha256: HASH_C,
    requestedAt: '2026-07-18T00:00:00.000Z',
    sourceManifestSha256: trusted.manifestSha256,
    capabilityStateSha256: boundedTrustedCapabilityStateSha256(trusted),
    sourceSnapshotIds: trusted.sources.map(({ snapshotId }) => snapshotId),
    release: {
      releaseId: 'santa-clara-bounded-test',
      releaseContractVersion: '1.0.0',
      county: 'Santa Clara' as const,
      state: 'CA' as const,
      generatedAt: '2026-07-18T00:00:00.000Z',
    },
    mutationLog,
    partitionPlan: {
      algorithm: 'sha256-leading-64-bit-modulo-v1' as const,
      partitionCount: 16,
      groupKeyVersion: 'canonical-mutation-group-key-v1' as const,
      mutationSortVersion: 'length-prefixed-utf8-mutation-sort-v1' as const,
    },
    budget: overrides.budget ?? {
      policyVersion: 'bounded-process-budget-v1' as const,
      maxBufferedRecords: 100,
      maxBufferedBytes: 1024 * 1024,
      maxRssBytes: 512 * 1024 * 1024,
      duckdbMemoryBytes: 256 * 1024 * 1024,
      runtimeReserveBytes: 128 * 1024 * 1024,
      maxOpenFiles: 32,
      maxWorkers: 2,
      maxRecordsPerOutputChunk: 100,
      maxBytesPerOutputChunk: 1024 * 1024,
      rssSampleIntervalRecords: 10,
    },
    stageVersions: Object.fromEntries(
      BOUNDED_PROCESSING_STAGES.map((stage) => [stage, `${stage}-v1`]),
    ) as BoundedProcessingInput['stageVersions'],
  };
  const withLogical = {
    ...semantic,
    logicalOutputIdentitySha256: logicalOutputIdentitySha256(semantic),
  };
  const processing = { ...withLogical, generationId: boundedProcessingGenerationId(withLogical) };
  trustedByProcessing.set(processing, trusted);
  return processing;
}

function processingWithTrustedRunStatus(
  runStatus: BoundedTrustedAcquisitionManifest['runStatus'],
  failedCapability?:
    | (typeof REAL_COUNTY_CAPABILITIES)[number]
    | readonly (typeof REAL_COUNTY_CAPABILITIES)[number][],
): BoundedProcessingInput {
  const baseline = processingInput();
  const trusted = trustedByProcessing.get(baseline);
  if (trusted === undefined) throw new Error('fixture trusted acquisition');
  const { manifestSha256: ignoredManifestSha256, ...trustedPayload } = trusted;
  void ignoredManifestSha256;
  const unavailableCapabilities =
    failedCapability === undefined
      ? null
      : new Set(Array.isArray(failedCapability) ? failedCapability : [failedCapability]);
  const selectedSources =
    unavailableCapabilities === null
      ? trusted.sources.slice(0, 1)
      : trusted.sources.filter(({ capabilities }) =>
          capabilities.some((capability) => unavailableCapabilities.has(capability)),
        );
  if (
    selectedSources.length === 0 ||
    (unavailableCapabilities !== null && selectedSources.length !== unavailableCapabilities.size)
  ) {
    throw new Error('fixture failed capability source');
  }
  const selectedSourceIds = new Set(selectedSources.map(({ sourceId }) => sourceId));
  const sources = trusted.sources.map((source) =>
    selectedSourceIds.has(source.sourceId) && runStatus !== 'succeeded'
      ? {
          ...source,
          terminalState: runStatus === 'failed' ? ('failed' as const) : ('blocked' as const),
          limitations: [`Fixture source makes the trusted run ${runStatus}.`],
        }
      : source,
  );
  const sourceMap = new Map<string, BoundedTrustedAcquiredSource>(
    sources.map((source) => [source.sourceId, source]),
  );
  const capabilities = trusted.capabilities.map((capability) => {
    const terminalStates = new Set(
      capability.sourceIds.map((sourceId) => sourceMap.get(sourceId)?.terminalState),
    );
    const state = terminalStates.has('failed')
      ? ('failed' as const)
      : terminalStates.has('blocked')
        ? ('blocked' as const)
        : capability.state;
    const value = {
      ...capability,
      state,
      limitations:
        state === 'succeeded' ? capability.limitations : [`Fixture capability is ${state}.`],
    };
    return {
      ...value,
      evidenceSha256: boundedTrustedCapabilityEvidenceSha256(value, sourceMap),
    };
  });
  const changedPayload = { ...trustedPayload, runStatus, sources, capabilities };
  const changedTrusted = boundedTrustedAcquisitionManifestSchema.parse({
    ...changedPayload,
    manifestSha256: boundedTrustedAcquisitionManifestSha256(changedPayload),
  });
  const sourceBound = {
    ...baseline,
    sourceManifestSha256: changedTrusted.manifestSha256,
    capabilityStateSha256: boundedTrustedCapabilityStateSha256(changedTrusted),
  };
  const withLogicalIdentity = {
    ...sourceBound,
    logicalOutputIdentitySha256: logicalOutputIdentitySha256(sourceBound),
  };
  const processing = {
    ...withLogicalIdentity,
    generationId: boundedProcessingGenerationId(withLogicalIdentity),
  };
  trustedByProcessing.set(processing, changedTrusted);
  return processing;
}

function trustedManifest(
  runId: BoundedProcessingInput['runId'],
): BoundedTrustedAcquisitionManifest {
  const sources = [...REAL_COUNTY_CAPABILITIES]
    .map((capability, index): BoundedTrustedAcquiredSource => {
      const slug = capability.replaceAll('_', '-');
      const sourceId = sourceIdSchema.parse(`sc:source:${slug}`);
      const artifactSha256 = digest(`trusted-artifact:${capability}`);
      const snapshotId = snapshotIdSchema.parse(`sc:snapshot:${slug}:${artifactSha256}`);
      const schemaSha256 = digest(`trusted-schema:${capability}`);
      const artifact: AcquiredArtifact = acquiredArtifactSchema.parse({
        artifactId: `sc:artifact:sha256:${artifactSha256}`,
        sourceId,
        snapshotId,
        retrievedAt: '2026-07-17T00:00:00.000Z',
        sourceAsOf: { state: 'reported', at: '2026-07-16T00:00:00.000Z' },
        request: {
          requestKey: `trusted-${index.toString().padStart(2, '0')}`,
          method: 'GET',
          url: `https://example.test/${slug}.json`,
          headers: [],
          bodySha256: null,
          attempt: 1,
        },
        response: {
          httpStatus: 200,
          etag: null,
          lastModified: null,
          finalUrl: `https://example.test/${slug}.json`,
        },
        mediaType: 'application/json',
        encoding: 'json',
        byteSize: 100 + index,
        sha256: artifactSha256,
        schemaFingerprint: {
          algorithm: 'sha256',
          value: schemaSha256,
          schemaName: `${slug}-schema`,
          canonicalizationVersion: '1.0.0',
        },
        rawUri: `file:///trusted/${slug}/${artifactSha256}.json`,
        licenseSnapshotRef: `sc:license:${slug}:${digest(`license:${capability}`)}`,
        visibility: 'restricted',
      });
      const acquiredArtifacts = [artifact];
      return boundedTrustedAcquiredSourceSchema.parse({
        sourceId,
        snapshotId,
        acquiredArtifacts,
        sourceSha256: boundedTrustedSourceSha256(acquiredArtifacts),
        schemaSha256: boundedTrustedSchemaSha256(acquiredArtifacts),
        asOf: '2026-07-16T00:00:00.000Z',
        contributors: [`Contributor ${capability}`],
        terminalState: 'succeeded',
        permissionState: 'allowed',
        limitations: [],
        capabilities: [capability],
        permitAuthorityIds:
          capability === 'san_jose_permits'
            ? Array.from(
                { length: 16 },
                (_, authority) => `authority-${(authority + 1).toString().padStart(2, '0')}`,
              )
            : [],
      });
    })
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const sourceMap = new Map(sources.map((source) => [source.sourceId, source]));
  const capabilities = [...REAL_COUNTY_CAPABILITIES].sort().map((capability) => {
    const withoutEvidence = {
      capability,
      state: 'succeeded' as const,
      sourceIds: sources
        .filter((source) => source.capabilities.includes(capability))
        .map(({ sourceId }) => sourceId),
      limitations: [],
    };
    return Object.freeze({
      ...withoutEvidence,
      evidenceSha256: boundedTrustedCapabilityEvidenceSha256(withoutEvidence, sourceMap),
    });
  });
  const withoutHash: Omit<BoundedTrustedAcquisitionManifest, 'manifestSha256'> = {
    format: 'oracle-trusted-acquisition-manifest-v1' as const,
    runId,
    county: 'Santa Clara' as const,
    state: 'CA' as const,
    createdAt: '2026-07-18T00:00:00.000Z',
    runStatus: 'succeeded' as const,
    sources,
    capabilities,
  };
  return boundedTrustedAcquisitionManifestSchema.parse({
    ...withoutHash,
    manifestSha256: boundedTrustedAcquisitionManifestSha256(withoutHash),
  });
}

function processingCheckpoint(processing: BoundedProcessingInput): BoundedProcessingCheckpoint {
  const withoutHash: Omit<BoundedProcessingCheckpoint, 'checkpointSha256'> = {
    schemaVersion: 'oracle-bounded-processing-checkpoint-v1',
    generationId: processing.generationId,
    generationSpecSha256: boundedGenerationSpecSha256(processing),
    expectedRevision: digest(`expected-revision:${processing.generationId}`),
    physicalInputManifestSha256: processing.mutationLog.physicalManifestSha256,
    releaseIdentitySha256: releaseIdentitySha256(processing.release),
    logicalOutputIdentitySha256: processing.logicalOutputIdentitySha256,
    partitionPlanSha256: partitionPlanSha256(processing.partitionPlan),
    budgetPolicySha256: budgetPolicySha256(processing.budget),
    stageVersionsSha256: stageVersionsSha256(processing.stageVersions),
    durablePartitions: [],
    activeCursor: null,
    orphanCandidate: null,
    completedStages: BOUNDED_PROCESSING_STAGES.slice(0, 6).map((stage) => ({
      stage,
      outputManifestSha256: digest(`output:${stage}`),
      partitionLedgerManifestSha256: digest(`ledger:${stage}`),
      partitionCount: processing.partitionPlan.partitionCount,
    })),
    finalization: null,
  };
  return Object.freeze({
    ...withoutHash,
    checkpointSha256: boundedProcessingCheckpointSha256(withoutHash),
  });
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    typeof value === 'number'
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object')
    return `{${Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  throw new TypeError('unsupported test value');
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function withoutKey(value: object, key: string): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== key));
}
