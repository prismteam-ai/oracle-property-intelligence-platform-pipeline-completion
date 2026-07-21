import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, link, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DuckDBInstance, type DuckDBAppender, type DuckDBConnection } from '@duckdb/node-api';
import {
  createCheckpointEnvelope,
  type CheckpointEnvelope,
} from '@oracle/artifacts/checkpoint-store';
import {
  BOUNDED_PROCESSING_CONTRACT_VERSION,
  BOUNDED_PROCESSOR_KIND,
  BOUNDED_AUTHORITATIVE_CAPABILITY_SOURCE_IDS,
  BOUNDED_AUTHORITATIVE_COUNTY_CAPABILITIES,
  BOUNDED_AUTHORITATIVE_PERMIT_AUTHORITIES,
  BOUNDED_MAX_STAGE_ARTIFACTS,
  boundedProcessingGenerationId,
  boundedProcessingInputSchema,
  boundedProcessingCheckpointSha256,
  boundedArtifactOrderKey,
  boundedStageManifestSchema,
  boundedStageManifestSha256,
  boundedDescriptorPageSha256,
  immutableBoundedArtifactSchema,
  streamVerifiedBoundedDescriptorInventory,
  boundedTrustedAcquisitionManifestSchema,
  boundedAuthoritativeCountyRegistrySchema,
  boundedTrustedAcquisitionManifestSha256,
  boundedTrustedCapabilityEvidenceSha256,
  boundedTrustedCapabilityStateSha256,
  boundedTrustedSchemaSha256,
  boundedTrustedSourceSha256,
  boundedAuthoritativeCountyRegistrySha256,
  assertCheckpointMatchesInput,
  boundedGenerationSpecSha256,
  budgetPolicySha256,
  partitionPlanSha256,
  releaseIdentitySha256,
  stageVersionsSha256,
  boundedMutationLogInputSchema,
  logicalOutputIdentitySha256,
  mutationSortKeyHex,
  mutationChunkInputSchema,
  partitionForMutation,
  physicalMutationManifestSha256,
  boundedProcessingBudgetSchema,
  type BoundedMutationLogInput,
  type BoundedProcessingBudget,
  type BoundedProcessingInput,
  type BoundedProcessingStage,
  type BoundedProcessingCheckpoint,
  type BoundedStageManifest,
  type BoundedAuthoritativeCountyRegistry,
  type BoundedTrustedAcquisitionManifest,
  type BoundedTrustedAcquisitionReference,
  type BoundedTrustedAcquisitionResolver,
  type BoundedDescriptorPageResolver,
  type ImmutableBoundedArtifact,
} from '@oracle/contracts/bounded-processing';
import {
  canonicalMutationSchema,
  type CanonicalEntity,
} from '@oracle/contracts/canonical/mutation';
import type { FieldObservation } from '@oracle/contracts/canonical/lineage';
import type { EvidenceSourceReference } from '@oracle/contracts/evidence';
import { reduceBoundedCanonicalPartition } from '@oracle/canonical-model/entities/bounded-reducer';
import type {
  BoundedCanonicalPartitionSummary,
  BoundedCanonicalPartitionTransaction,
} from '@oracle/canonical-model/entities/bounded-reducer';
import type { CanonicalEntityAggregate } from '@oracle/canonical-model/entities/reducer';
import { ProcessWideBoundedBudget } from '@oracle/canonical-model/bounded-budget';
import {
  LINK_RELATIONS,
  reconcileBoundedRelation,
  type BoundedCandidateStage,
  type BoundedDuplicateMember,
  type BoundedReconciliationRepository,
  type BoundedReconciliationSubjectClaim,
  type BoundedReconciliationSummary,
} from '@oracle/reconciliation/entity-linking/bounded-linker';
import { policyFor } from '@oracle/reconciliation/entity-linking/policies';
import type {
  LinkRelation,
  LinkResolution,
  LinkableEntity,
  NormalizedExactKey,
  ReviewDecision,
} from '@oracle/reconciliation/entity-linking/model';
import {
  boundedFeatureValueSha256,
  runBoundedFeaturePartition,
  type BoundedFeatureChunkIdentity,
  type BoundedFeatureChunkSink,
  type BoundedFeatureCursor,
  type BoundedFeatureDurableCheckpoint,
  type BoundedFeatureInput,
  type BoundedFeatureOutput,
} from '@oracle/features/bounded-stage';
import {
  deriveRoofAge,
  type BuildingAgeObservation,
  type RoofPermitObservation,
} from '@oracle/features/property-intelligence/roof';
import {
  buildInquiryResult,
  type InquiryResult,
  type SourceObservation,
} from '@oracle/features/property-intelligence/common';
import {
  BOUNDED_COUNTY_SERVING_RELATIONS,
  boundedServingLicenseDecisionSha256,
  boundedServingLineageSha256,
  boundedServingRowSortKey,
  boundedServingSchemaSha256,
  buildBoundedServingRelease,
  verifyBoundedServingRelease,
  type BoundedServingLicenseDecision,
  type BoundedServingRelationInput,
  type BoundedServingReleaseMetadata,
  type BoundedServingSourceLineage,
  type BoundedPropertyQuerySourceReference,
  type BoundedTrustedCanonicalLineageResolver,
  type BoundedReleaseFinalizationCoordinator,
  type BoundedReleaseFinalizationWinner,
} from '@oracle/data-runtime/serving/bounded-release';
import {
  SERVING_RELATIONS,
  type ServingRow,
  type ServingVisibility,
} from '@oracle/data-runtime/serving/schema';

import { capabilityStates } from './default-processors.js';
import { canonicalJson, sha256 } from './canonical-json.js';
import { readCanonicalLines } from './chunks.js';
import type {
  BoundedCountyProcessingRequest,
  BoundedCountyProcessingResult,
  PhaseArtifact,
  PipelineProcessors,
  SourceExecutionManifest,
} from './types.js';

const HASH_EMPTY = createHash('sha256').digest('hex');
const MUTATION_SCHEMA_SHA256 = sha256({ contract: 'canonical-mutation', version: '1' });
const PARTITION_COUNT = 32;
const FEATURE_KINDS = Object.freeze([
  'roof_age',
  'ownership_age',
  'regional_owner',
  'starbucks_walkability',
  'transit_walkability',
  'water_view_candidate',
] as const);
const FEATURE_BUNDLE_SCHEMA_SHA256 = sha256({
  contract: 'county-feature-bundle',
  version: '1',
  features: FEATURE_KINDS,
  projections: ['public', 'restricted'],
});
const PROCESS_BUDGETS = new Map<string, ProcessWideBoundedBudget>();
const ACTIVE_PROCESS_RESOURCES = new Map<string, string>();

type CountyFeatureKind = (typeof FEATURE_KINDS)[number];
type CountyFeatureEvidence = InquiryResult<unknown>;
type ExactEvidenceSourceReference = Readonly<
  Omit<EvidenceSourceReference, 'fieldPaths'> &
    Pick<BoundedPropertyQuerySourceReference, 'recordSha256' | 'lineageSha256'> & {
      fieldPaths: readonly string[];
    }
>;
type FeatureBundle = Readonly<{
  propertyId: string;
  publicEvidence: readonly CountyFeatureEvidence[];
  restrictedEvidence: readonly CountyFeatureEvidence[];
}>;

type TrustedAcquisitionBinding = Readonly<{
  manifest: BoundedTrustedAcquisitionManifest;
  reference: BoundedTrustedAcquisitionReference;
  resolver: BoundedTrustedAcquisitionResolver;
}>;

type MartRowEnvelope = Readonly<{
  row: ServingRow;
  sourceIds: readonly string[];
  fieldSourceIds?: Readonly<Record<string, readonly string[]>>;
}>;

export type BoundedPipelineProcessorOptions = Readonly<{
  outputDirectory: string;
  scratchDirectory?: string;
  partitionCount?: number;
  budget?: BoundedProcessingBudget;
  crash?: (
    point: BoundedPipelineCrashPoint,
    identity: Readonly<{ partitionId?: number; relation?: string; sequence?: number }>,
  ) => void | Promise<void>;
}>;

export type BoundedPipelineCrashPoint =
  | 'after_mutation_spool'
  | 'after_canonical_partition'
  | 'after_link_index'
  | 'after_reconciliation_relation'
  | 'after_feature_chunk'
  | 'after_mart_relation'
  | 'before_finalize';

const DEFAULT_BUDGET: BoundedProcessingBudget = Object.freeze({
  policyVersion: 'bounded-process-budget-v1',
  maxBufferedRecords: 2_048,
  maxBufferedBytes: 16 * 1024 * 1024,
  maxRssBytes: 512 * 1024 * 1024,
  duckdbMemoryBytes: 128 * 1024 * 1024,
  runtimeReserveBytes: 256 * 1024 * 1024,
  maxOpenFiles: 32,
  maxWorkers: 1,
  maxRecordsPerOutputChunk: 2_048,
  maxBytesPerOutputChunk: 16 * 1024 * 1024,
  rssSampleIntervalRecords: 2_048,
});

/** Production bounded downstream. Every row-bearing intermediate lives in DuckDB or NDJSON. */
export function createBoundedPipelineProcessors(
  options: BoundedPipelineProcessorOptions,
): PipelineProcessors {
  const outputRoot = resolve(options.outputDirectory);
  const scratchRoot = resolve(options.scratchDirectory ?? join(outputRoot, 'bounded-scratch'));
  const resourceRoots = Object.freeze([...new Set([scratchRoot, outputRoot])].sort(compareUtf8));
  const resourceIdentity = sha256({
    format: 'oracle-bounded-resource-identity-v1',
    roots: resourceRoots,
  });
  const partitionCount = options.partitionCount ?? PARTITION_COUNT;
  const budget = applyOperatorCeilings(options.budget ?? DEFAULT_BUDGET);
  const sharedBudget = processGlobalBudget(budget, resourceIdentity);
  if (!Number.isSafeInteger(partitionCount) || partitionCount < 12) {
    throw new RangeError('partitionCount must be a safe integer of at least 12');
  }
  return Object.freeze({
    memoryProfile: 'bounded_streaming_v2' as const,
    processBoundedCounty: (request: BoundedCountyProcessingRequest) =>
      processBoundedCounty(request, {
        outputRoot,
        scratchRoot,
        partitionCount,
        budget,
        sharedBudget,
        resourceRoots,
        resourceIdentity,
        ...(options.crash === undefined ? {} : { crash: options.crash }),
      }),
    reconcile: () => Promise.reject(new Error('bounded_streaming_v2 uses processBoundedCounty')),
    deriveFeatures: () =>
      Promise.reject(new Error('bounded_streaming_v2 uses processBoundedCounty')),
    buildMarts: () => Promise.reject(new Error('bounded_streaming_v2 uses processBoundedCounty')),
  });
}

type RuntimeOptions = Readonly<{
  outputRoot: string;
  scratchRoot: string;
  partitionCount: number;
  budget: BoundedProcessingBudget;
  sharedBudget: ProcessWideBoundedBudget;
  resourceRoots: readonly string[];
  resourceIdentity: string;
  crash?: BoundedPipelineProcessorOptions['crash'];
}>;

async function processBoundedCounty(
  request: BoundedCountyProcessingRequest,
  options: RuntimeOptions,
): Promise<BoundedCountyProcessingResult> {
  if (
    request.configuration.profile.name !== 'pilot' &&
    request.configuration.profile.name !== 'full' &&
    request.configuration.profile.name !== 'incremental'
  ) {
    throw new TypeError(
      'bounded_streaming_v2 is reserved for production pilot, full, and incremental profiles',
    );
  }
  if (request.configuration.profile.name === 'incremental') {
    throw new BoundedPipelineIntegrityError(
      'Bounded incremental processing is fail-closed until existing county artifacts can be verified and merged',
    );
  }
  request.signal.throwIfAborted();
  const releaseProcessRun = acquireProcessRun(options.resourceRoots, request.configuration.runId);
  try {
    await Promise.all(options.resourceRoots.map((root) => mkdir(root, { recursive: true })));
    const runRoot = confinedRunRoot(options.scratchRoot, request.configuration.runId);
    await mkdir(runRoot, { recursive: true });
    const sharedBudget = options.sharedBudget;
    sharedBudget.assertPolicy(options.budget);
    const activeBudget = sharedBudget.snapshot();
    if (activeBudget.bufferedRecords !== 0 || activeBudget.bufferedBytes !== 0) {
      throw new BoundedPipelineBudgetError(
        'Another bounded county worker holds the process budget',
      );
    }
    const runLease = await acquireRunLease(
      options.resourceRoots,
      request.configuration.runId,
      options.resourceIdentity,
    );
    try {
      const trustedAcquisition = await materializeTrustedAcquisition(
        request,
        sharedBudget,
        options.budget.maxBufferedBytes,
      );
      assertReleaseableSourceInventory(request.sources, trustedAcquisition.manifest);
      const releaseContentRequest = withoutFailedLaneMutations(
        request,
        trustedAcquisition.manifest,
      );
      await verifyRootedMutationSequences(
        releaseContentRequest,
        sharedBudget,
        options.budget.maxBufferedBytes,
      );
      const exactMutationLogicalSha256 =
        await computeExactMutationLogicalSha256(releaseContentRequest);
      const processing = createProcessingInput(
        releaseContentRequest,
        options,
        exactMutationLogicalSha256,
        trustedAcquisition.manifest.manifestSha256,
        boundedTrustedCapabilityStateSha256(trustedAcquisition.manifest),
      );
      const confined = confinedChild(runRoot, generationPath(processing.generationId));
      await mkdir(confined, { recursive: true });
      const databasePath = join(confined, 'bounded-county.duckdb');
      const temporaryDirectory = boundedDuckDbTemporaryDirectory(
        options.scratchRoot,
        request.configuration.runId,
        processing.generationId,
      );
      let instance: DuckDBInstance | undefined;
      let connection: DuckDBConnection | undefined;
      try {
        await removeDuckDbTemporaryDirectory(temporaryDirectory);
        await mkdir(temporaryDirectory, { recursive: true });
        instance = await openDuckDatabase(databasePath, temporaryDirectory, options.budget);
        connection = await instance.connect();
        await initializeDatabase(connection);
        await bindGeneration(connection, processing, runLease.token);
        await ingestMutations(connection, releaseContentRequest, processing);
        await materializeAllMutationPartitions(
          request,
          connection,
          processing,
          confined,
          sharedBudget,
        );
        await options.crash?.('after_mutation_spool', {});
        await commitBoundedProgress(
          request,
          connection,
          processing,
          'partition_mutations',
          sharedBudget,
        );
        await request.beforePhase?.('reconcile');
        const canonical = await reduceCanonical(
          request,
          connection,
          processing,
          confined,
          request.signal,
          sharedBudget,
          options.crash,
        );
        await commitBoundedProgress(
          request,
          connection,
          processing,
          'reduce_canonical',
          sharedBudget,
        );
        const linkIndexArtifact = await buildLinkIndex(
          request,
          connection,
          processing,
          confined,
          request.signal,
          sharedBudget,
        );
        await commitBoundedUnit(request, connection, processing, 'build_link_index', 0, 1, [
          linkIndexArtifact,
        ]);
        await options.crash?.('after_link_index', {});
        await commitBoundedProgress(
          request,
          connection,
          processing,
          'build_link_index',
          sharedBudget,
        );
        const reconciliation = await reconcileAll(
          request,
          connection,
          processing,
          confined,
          request.signal,
          sharedBudget,
          options.crash,
        );
        await commitBoundedProgress(
          request,
          connection,
          processing,
          'reconcile_links',
          sharedBudget,
        );
        const reconcileArtifact = await writeDescriptor(request, 'reconcile', {
          contractVersion: BOUNDED_PROCESSING_CONTRACT_VERSION,
          processorKind: BOUNDED_PROCESSOR_KIND,
          generationId: processing.generationId,
          logicalOutputIdentitySha256: processing.logicalOutputIdentitySha256,
          canonical,
          reconciliation,
        });

        await request.beforePhase?.('derive_features');
        const features = await deriveFeatures(
          request,
          connection,
          processing,
          confined,
          request.signal,
          sharedBudget,
          options.crash,
        );
        await commitBoundedProgress(
          request,
          connection,
          processing,
          'derive_features',
          sharedBudget,
        );
        const featureArtifact = await writeDescriptor(request, 'derive_features', {
          generationId: processing.generationId,
          logicalSha256: features.logicalSha256,
          propertyCount: features.propertyCount,
          evidenceCount: features.evidenceCount,
          artifactCount: features.artifactCount,
        });

        await request.beforePhase?.('build_marts');
        const mart = await buildMarts(
          request,
          connection,
          processing,
          request.sources,
          confined,
          options.outputRoot,
          request.signal,
          sharedBudget,
          options.crash,
          trustedAcquisition,
        );
        await commitBoundedProgress(request, connection, processing, 'build_marts', sharedBudget);
        const finalizationArtifacts = await materializeFinalizationArtifacts(
          request,
          connection,
          processing,
          confined,
          mart,
          sharedBudget,
        );
        await commitBoundedUnit(
          request,
          connection,
          processing,
          'finalize_release',
          0,
          finalizationArtifacts.length,
          finalizationArtifacts,
        );
        await commitBoundedFinalization(
          request,
          processing,
          mart,
          mart.finalizationExpectedRevision,
        );
        await options.crash?.('before_finalize', {});
        await commitBoundedProgress(
          request,
          connection,
          processing,
          'finalize_release',
          sharedBudget,
        );
        await promoteBoundedFinalization(request, processing, mart.adoptedIdenticalWinner);
        const martArtifact = await writeDescriptor(request, 'build_marts', {
          generationId: processing.generationId,
          releaseDirectory: portableRelative(options.outputRoot, mart.outputDirectory),
          manifestSha256: mart.manifest.manifestSha256,
          evidenceSha256: mart.evidence.evidenceSha256,
          artifactCount: mart.manifest.artifacts.length,
          countyCompletionClaim: mart.evidence.countyCompletionClaim,
          budget: mart.evidence.budget,
        });
        return Object.freeze({
          reconcileArtifact,
          featureArtifact,
          martArtifact,
          countyCompletionClaim: mart.evidence.countyCompletionClaim,
        });
      } finally {
        try {
          connection?.closeSync();
        } finally {
          try {
            instance?.closeSync();
          } finally {
            // Best-effort: teardown cleanup must never replace the run's result.
            await removeDuckDbTemporaryDirectoryBestEffort(temporaryDirectory);
          }
        }
      }
    } finally {
      await runLease.release();
    }
  } finally {
    releaseProcessRun();
  }
}

function acquireProcessRun(resourceRoots: readonly string[], runId: string): () => void {
  const conflict = resourceRoots.find((root) => ACTIVE_PROCESS_RESOURCES.has(root));
  if (conflict !== undefined) {
    throw new BoundedPipelineIntegrityError(
      `A bounded county invocation already owns resource ${conflict}: ${ACTIVE_PROCESS_RESOURCES.get(conflict)}`,
    );
  }
  for (const root of resourceRoots) ACTIVE_PROCESS_RESOURCES.set(root, runId);
  let released = false;
  return () => {
    if (released) return;
    if (resourceRoots.some((root) => ACTIVE_PROCESS_RESOURCES.get(root) !== runId)) {
      throw new BoundedPipelineIntegrityError('Process-wide bounded resource fence changed');
    }
    released = true;
    for (const root of resourceRoots) ACTIVE_PROCESS_RESOURCES.delete(root);
  };
}

function processGlobalBudget(
  policy: BoundedProcessingBudget,
  resourceIdentity: string,
): ProcessWideBoundedBudget {
  const key = `${resourceIdentity}\0${budgetPolicySha256(policy)}`;
  const existing = PROCESS_BUDGETS.get(key);
  if (existing !== undefined) return existing;
  const created = new ProcessWideBoundedBudget(policy);
  PROCESS_BUDGETS.set(key, created);
  return created;
}

function sourceInventoryRunStatus(
  sources: readonly SourceExecutionManifest[],
): BoundedTrustedAcquisitionManifest['runStatus'] {
  if (sources.some(({ terminalState }) => terminalState === 'failed')) return 'failed';
  return sources.every(({ terminalState }) => terminalState === 'complete')
    ? 'succeeded'
    : 'partial';
}

function assertReleaseableSourceInventory(
  sources: readonly SourceExecutionManifest[],
  trusted: BoundedTrustedAcquisitionManifest,
): void {
  const runStatus = sourceInventoryRunStatus(sources);
  if (runStatus !== trusted.runStatus) {
    throw new BoundedPipelineIntegrityError(
      `Serving runStatus differs from the complete source-state inventory`,
    );
  }
  const trustedStates = new Map(trusted.sources.map((source) => [source.sourceId, source]));
  const unbound = sources
    .filter((source) => {
      const bound = trustedStates.get(source.sourceId);
      const expectedTerminalState =
        source.executionMode === 'discover_only' &&
        source.terminalState === 'partial' &&
        source.coverage.observedRecords === 0 &&
        source.coverage.acceptedRecords === 0 &&
        bound?.acquiredArtifacts.length === 0
          ? 'blocked'
          : source.terminalState === 'complete'
            ? 'succeeded'
            : source.terminalState;
      return (
        bound?.snapshotId !==
          (source.snapshotIdentity.observedContentId ?? source.snapshotIdentity.intentId) ||
        bound.terminalState !== expectedTerminalState
      );
    })
    .map(({ sourceId }) => sourceId)
    .sort(compareUtf8);
  if (trustedStates.size !== sources.length || unbound.length !== 0) {
    throw new BoundedPipelineIntegrityError(
      `Trusted acquisition omits complete source state: ${unbound.join(',')}`,
    );
  }
}

function withoutFailedLaneMutations(
  request: BoundedCountyProcessingRequest,
  trusted: BoundedTrustedAcquisitionManifest,
): BoundedCountyProcessingRequest {
  const failedSourceIds = new Set(
    trusted.sources
      .filter(({ terminalState }) => terminalState === 'failed')
      .map(({ sourceId }) => sourceId),
  );
  if (failedSourceIds.size === 0) return request;
  return Object.freeze({
    ...request,
    mutationSources: Object.freeze(
      request.mutationSources.filter(({ sourceId }) => !failedSourceIds.has(sourceId)),
    ),
  });
}

/**
 * Execution-only operator override for the DuckDB working-set ceiling. The
 * bounded budget policy object, its hashes, and the generation identity are
 * intentionally unchanged: the DuckDB memory limit does not alter logical
 * outputs or artifact layout. County-scale derive_features/build_marts can
 * exceed the default 128 MiB working set; an operator may raise ONLY the
 * enforcement ceiling via ORACLE_PIPELINE_DUCKDB_MEMORY_BYTES (a safe integer
 * of bytes, at least the policy value).
 */
function operatorDuckdbMemoryBytes(policyBytes: number): number {
  return operatorCeiling('ORACLE_PIPELINE_DUCKDB_MEMORY_BYTES', policyBytes);
}

/**
 * Execution-only operator override for the resident-set ceiling, the companion
 * of ORACLE_PIPELINE_DUCKDB_MEMORY_BYTES. Like it, this changes no logical
 * output, no budget hash, and no generation identity.
 *
 * Raising the DuckDB working set ALONE is not a safe lever: DuckDB's allocation
 * counts toward process RSS, but the reducer/linker guards enforce
 * `budget.maxRssBytes`, which defaulted to 512 MiB. An 8 GiB DuckDB ceiling
 * therefore drove RSS past the guard and aborted reduce_canonical with
 * "Canonical entity group exceeded the shared process budget". The two ceilings
 * must move together, which is precisely the invariant
 * boundedProcessingBudgetSchema already encodes
 * (maxBufferedBytes + duckdbMemoryBytes + runtimeReserveBytes <= maxRssBytes) —
 * an invariant the open-time-only override silently bypassed.
 */
function operatorMaxRssBytes(policyBytes: number): number {
  return operatorCeiling('ORACLE_PIPELINE_MAX_RSS_BYTES', policyBytes);
}

function operatorCeiling(variable: string, policyBytes: number): number {
  const raw = process.env[variable];
  if (raw === undefined || raw.trim() === '') return policyBytes;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < policyBytes) {
    throw new RangeError(`${variable} must be a safe integer of at least ${policyBytes}`);
  }
  return parsed;
}

/**
 * Apply the operator ceilings to the budget POLICY rather than only at DuckDB
 * open time, so that boundedProcessingBudgetSchema validates the raised values
 * as a set. A configuration that raises the DuckDB working set without matching
 * RSS headroom now fails immediately at startup with a precise message, instead
 * of running for hours and aborting mid-compute.
 */
function applyOperatorCeilings(policy: BoundedProcessingBudget): BoundedProcessingBudget {
  const duckdbMemoryBytes = operatorDuckdbMemoryBytes(policy.duckdbMemoryBytes);
  const maxRssBytes = operatorMaxRssBytes(policy.maxRssBytes);
  // Several per-record leases are derived from maxBufferedBytes, so this is the lever
  // for county-scale rows without editing each derivation. Schema-validated below.
  const maxBufferedBytes = operatorCeiling(
    'ORACLE_PIPELINE_MAX_BUFFERED_BYTES',
    policy.maxBufferedBytes,
  );
  if (
    duckdbMemoryBytes === policy.duckdbMemoryBytes &&
    maxRssBytes === policy.maxRssBytes &&
    maxBufferedBytes === policy.maxBufferedBytes
  ) {
    return policy;
  }
  return Object.freeze(
    boundedProcessingBudgetSchema.parse({
      ...policy,
      duckdbMemoryBytes,
      maxRssBytes,
      maxBufferedBytes,
    }),
  );
}

async function openDuckDatabase(
  databasePath: string,
  temporaryDirectory: string,
  budget: BoundedProcessingBudget,
): Promise<DuckDBInstance> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await DuckDBInstance.create(databasePath, {
        threads: String(budget.maxWorkers),
        memory_limit: `${operatorDuckdbMemoryBytes(budget.duckdbMemoryBytes)}B`,
        temp_directory: temporaryDirectory,
      });
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof Error) ||
        !/(?:used by another process|being used by another process|file is already open)/iu.test(
          error.message,
        )
      ) {
        throw error;
      }
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
  throw lastError;
}

type RunLease = Readonly<{
  token: string;
  release(): Promise<void>;
}>;

async function acquireRunLease(
  resourceRoots: readonly string[],
  runId: string,
  resourceIdentity: string,
): Promise<RunLease> {
  const token = randomBytes(32).toString('hex');
  const releases: (() => Promise<void>)[] = [];
  try {
    for (const root of resourceRoots) {
      releases.push(await acquireResourceLease(root, runId, resourceIdentity, token));
    }
  } catch (error) {
    while (releases.length > 0) await releases.pop()?.();
    throw error;
  }
  return Object.freeze({
    token,
    release: async () => {
      while (releases.length > 0) await releases.pop()?.();
    },
  });
}

async function acquireResourceLease(
  root: string,
  runId: string,
  resourceIdentity: string,
  token: string,
): Promise<() => Promise<void>> {
  const path = confinedChild(root, '.oracle-bounded-resource-lease.json');
  const record = {
    format: 'oracle-bounded-resource-fence-v1' as const,
    resourceIdentity,
    runId,
    token,
    pid: process.pid,
  };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidatePath = confinedChild(
      root,
      `.oracle-bounded-resource-lease.candidate-${token}.json`,
    );
    try {
      const handle = await open(candidatePath, 'wx');
      try {
        await handle.writeFile(`${canonicalJson(record)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(candidatePath, path);
      } finally {
        await rm(candidatePath, { force: true });
      }
      return async () => {
        let current: unknown;
        try {
          const handle = await open(path, 'r');
          try {
            current = JSON.parse(await handle.readFile({ encoding: 'utf8' })) as unknown;
          } finally {
            await handle.close();
          }
        } catch (error) {
          if (isErrno(error, 'ENOENT')) return;
          throw error;
        }
        if (
          current === null ||
          typeof current !== 'object' ||
          (current as { resourceIdentity?: unknown }).resourceIdentity !== resourceIdentity ||
          (current as { runId?: unknown }).runId !== runId ||
          (current as { token?: unknown }).token !== token ||
          (current as { pid?: unknown }).pid !== process.pid
        ) {
          throw new BoundedPipelineIntegrityError('Bounded resource lease winner changed');
        }
        await rm(path, { force: true });
      };
    } catch (error) {
      await rm(candidatePath, { force: true });
      if (!isErrno(error, 'EEXIST')) throw error;
      const existing = await readRunLease(path);
      if (existing === null) {
        const age = Date.now() - (await stat(path)).mtimeMs;
        if (age < 30_000) {
          await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
          continue;
        }
      }
      if (existing !== null && processIsAlive(existing.pid)) {
        throw new BoundedPipelineIntegrityError(
          `Bounded resource is already leased by process ${existing.pid}`,
        );
      }
      const orphanPath = confinedChild(
        root,
        `.oracle-bounded-resource-lease.orphan-${sha256(existing ?? { unreadable: true }).slice(0, 16)}.json`,
      );
      try {
        await rename(path, orphanPath);
        await rm(orphanPath, { force: true });
      } catch (adoptionError) {
        if (!isErrno(adoptionError, 'ENOENT')) throw adoptionError;
      }
    }
  }
  throw new BoundedPipelineIntegrityError('Bounded resource lease could not be acquired');
}

async function readRunLease(
  path: string,
): Promise<Readonly<{ pid: number; token: string }> | null> {
  try {
    const handle = await open(path, 'r');
    try {
      const value = JSON.parse(await handle.readFile({ encoding: 'utf8' })) as unknown;
      if (
        value === null ||
        typeof value !== 'object' ||
        !Number.isSafeInteger((value as { pid?: unknown }).pid) ||
        typeof (value as { token?: unknown }).token !== 'string' ||
        !/^[a-f0-9]{64}$/u.test((value as { token: string }).token)
      ) {
        return null;
      }
      return Object.freeze({
        pid: (value as { pid: number }).pid,
        token: (value as { token: string }).token,
      });
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, 'ESRCH');
  }
}

async function initializeDatabase(connection: DuckDBConnection): Promise<void> {
  await connection.run('SET preserve_insertion_order = false');
  await connection.run(`CREATE TABLE IF NOT EXISTS bounded_generation (
    generation_id VARCHAR PRIMARY KEY, logical_output_sha256 VARCHAR NOT NULL,
    physical_input_sha256 VARCHAR NOT NULL, fence_token VARCHAR)`);
  await connection.run(
    'ALTER TABLE bounded_generation ADD COLUMN IF NOT EXISTS fence_token VARCHAR',
  );
  await connection.run(`CREATE TABLE IF NOT EXISTS raw_mutation (
    generation_id VARCHAR NOT NULL, source_id VARCHAR NOT NULL, source_ordinal BIGINT NOT NULL,
    partition_id INTEGER NOT NULL, sort_key VARCHAR NOT NULL,
    mutation_id VARCHAR NOT NULL, content_sha256 VARCHAR NOT NULL, mutation_json VARCHAR NOT NULL)`);
  await connection.run('DROP INDEX IF EXISTS raw_partition_sort');
  await connection.run(`CREATE TABLE IF NOT EXISTS canonical_claim (
    generation_id VARCHAR NOT NULL, mutation_id VARCHAR NOT NULL, content_sha256 VARCHAR NOT NULL,
    PRIMARY KEY(generation_id, mutation_id))`);
  await connection.run(`CREATE TABLE IF NOT EXISTS canonical_entity (
    generation_id VARCHAR NOT NULL, partition_id INTEGER NOT NULL, entity_id VARCHAR NOT NULL, entity_kind VARCHAR NOT NULL,
    entity_json VARCHAR NOT NULL, aggregate_json VARCHAR NOT NULL, aggregate_sha256 VARCHAR NOT NULL,
    PRIMARY KEY(generation_id, entity_id))`);
  await connection.run(`CREATE TABLE IF NOT EXISTS canonical_field_lineage (
    generation_id VARCHAR NOT NULL, entity_id VARCHAR NOT NULL, observation_id VARCHAR NOT NULL,
    field_path VARCHAR NOT NULL, source_id VARCHAR NOT NULL, snapshot_id VARCHAR NOT NULL,
    artifact_id VARCHAR NOT NULL, record_key VARCHAR NOT NULL, record_sha256 VARCHAR NOT NULL,
    lineage_sha256 VARCHAR NOT NULL)`);
  await connection.run(
    'CREATE INDEX IF NOT EXISTS canonical_field_lineage_lookup ON canonical_field_lineage(generation_id, source_id, snapshot_id, artifact_id, record_key, record_sha256, lineage_sha256, field_path)',
  );
  await connection.run(`CREATE TABLE IF NOT EXISTS canonical_link_candidate (
    generation_id VARCHAR NOT NULL, link_id VARCHAR NOT NULL, link_json VARCHAR NOT NULL,
    PRIMARY KEY(generation_id, link_id))`);
  await connection.run(`CREATE TABLE IF NOT EXISTS canonical_artifact_reference (
    generation_id VARCHAR NOT NULL, artifact_id VARCHAR NOT NULL, artifact_json VARCHAR NOT NULL,
    PRIMARY KEY(generation_id, artifact_id))`);
  await connection.run(`CREATE TABLE IF NOT EXISTS stage_partition (
    generation_id VARCHAR NOT NULL, stage VARCHAR NOT NULL, partition_id INTEGER NOT NULL,
    summary_json VARCHAR NOT NULL, summary_sha256 VARCHAR NOT NULL,
    PRIMARY KEY(generation_id, stage, partition_id))`);
  await connection.run(`CREATE TABLE IF NOT EXISTS stage_output_artifact (
    generation_id VARCHAR NOT NULL, stage VARCHAR NOT NULL, dataset VARCHAR NOT NULL,
    partition_id INTEGER NOT NULL, sequence INTEGER NOT NULL, artifact_json VARCHAR NOT NULL,
    PRIMARY KEY(generation_id, stage, dataset, partition_id, sequence))`);
  await connection.run(`CREATE TABLE IF NOT EXISTS stage_unit_manifest (
    generation_id VARCHAR NOT NULL, stage VARCHAR NOT NULL, partition_id INTEGER NOT NULL,
    manifest_json VARCHAR NOT NULL, manifest_sha256 VARCHAR NOT NULL,
    PRIMARY KEY(generation_id, stage, partition_id))`);
  await connection.run(`CREATE TABLE IF NOT EXISTS stage_manifest (
    generation_id VARCHAR NOT NULL, stage VARCHAR NOT NULL,
    manifest_json VARCHAR NOT NULL, manifest_sha256 VARCHAR NOT NULL,
    PRIMARY KEY(generation_id, stage))`);
  await connection.run(`CREATE TABLE IF NOT EXISTS feature_artifact (
    generation_id VARCHAR NOT NULL, partition_id INTEGER NOT NULL, sequence INTEGER NOT NULL,
    artifact_json VARCHAR NOT NULL, PRIMARY KEY(generation_id, partition_id, sequence))`);
  await connection.run(`CREATE TABLE IF NOT EXISTS feature_input_cursor (
    generation_id VARCHAR NOT NULL, partition_id INTEGER NOT NULL, ordinal BIGINT NOT NULL,
    sort_key VARCHAR NOT NULL, content_sha256 VARCHAR NOT NULL,
    PRIMARY KEY(generation_id, partition_id, ordinal))`);
  await connection.run(`CREATE TABLE IF NOT EXISTS feature_input_spool (
    generation_id VARCHAR NOT NULL, partition_id INTEGER NOT NULL, ordinal BIGINT NOT NULL,
    entity_id VARCHAR NOT NULL, sort_key VARCHAR NOT NULL, byte_size BIGINT NOT NULL,
    content_sha256 VARCHAR NOT NULL, work_json VARCHAR NOT NULL,
    PRIMARY KEY(generation_id, partition_id, ordinal),
    UNIQUE(generation_id, partition_id, entity_id))`);
  await connection.run(`CREATE TABLE IF NOT EXISTS feature_input_spool_state (
    generation_id VARCHAR NOT NULL, partition_id INTEGER NOT NULL, record_count BIGINT NOT NULL,
    logical_sha256 VARCHAR NOT NULL, PRIMARY KEY(generation_id, partition_id))`);
  await connection.run(`CREATE TABLE IF NOT EXISTS feature_proxy_candidate (
    generation_id VARCHAR NOT NULL, property_id VARCHAR NOT NULL, feature VARCHAR NOT NULL,
    aggregate_json VARCHAR NOT NULL, longitude DOUBLE NOT NULL, latitude DOUBLE NOT NULL,
    PRIMARY KEY(generation_id, property_id, feature))`);
  await connection.run(`CREATE TABLE IF NOT EXISTS feature_proxy_candidate_state (
    generation_id VARCHAR PRIMARY KEY, candidate_count BIGINT NOT NULL)`);
  await connection.run(`CREATE TABLE IF NOT EXISTS property_query_coverage (
    generation_id VARCHAR NOT NULL, visibility VARCHAR NOT NULL, field_name VARCHAR NOT NULL,
    numerator BIGINT NOT NULL, denominator BIGINT NOT NULL, source_ids_json VARCHAR NOT NULL,
    PRIMARY KEY(generation_id, visibility, field_name))`);
  await connection.run(`CREATE TABLE IF NOT EXISTS partition_artifact (
    generation_id VARCHAR NOT NULL, partition_id INTEGER NOT NULL,
    artifact_json VARCHAR NOT NULL, PRIMARY KEY(generation_id, partition_id))`);
  await connection.run(`CREATE TABLE IF NOT EXISTS linkable_entity (
    generation_id VARCHAR NOT NULL, entity_id VARCHAR NOT NULL, entity_kind VARCHAR NOT NULL,
    jurisdiction_norm VARCHAR NOT NULL, evidence_availability VARCHAR NOT NULL,
    linkable_json VARCHAR NOT NULL, PRIMARY KEY(generation_id, entity_id))`);
  await connection.run(`CREATE TABLE IF NOT EXISTS authority_identifier (
    generation_id VARCHAR NOT NULL, entity_id VARCHAR NOT NULL, scheme VARCHAR NOT NULL,
    scope_norm VARCHAR NOT NULL, value_norm VARCHAR NOT NULL)`);
  await connection.run(`CREATE TABLE IF NOT EXISTS normalized_exact_key (
    generation_id VARCHAR NOT NULL, entity_id VARCHAR NOT NULL, key_kind VARCHAR NOT NULL,
    value_norm VARCHAR NOT NULL)`);
  await connection.run(`CREATE TABLE IF NOT EXISTS candidate_attribute (
    generation_id VARCHAR NOT NULL, entity_id VARCHAR NOT NULL, attribute_name VARCHAR NOT NULL,
    value_norm VARCHAR NOT NULL)`);
  await connection.run(`CREATE TABLE IF NOT EXISTS permit_property_index (
    generation_id VARCHAR NOT NULL, property_id VARCHAR NOT NULL, permit_id VARCHAR NOT NULL,
    PRIMARY KEY(generation_id, property_id, permit_id))`);
  await connection.run(
    'CREATE INDEX IF NOT EXISTS permit_property_lookup ON permit_property_index(generation_id, property_id, permit_id)',
  );
  await connection.run(`CREATE TABLE IF NOT EXISTS geospatial_candidate (
    generation_id VARCHAR NOT NULL, entity_kind VARCHAR NOT NULL, entity_id VARCHAR NOT NULL,
    longitude DOUBLE NOT NULL, latitude DOUBLE NOT NULL,
    PRIMARY KEY(generation_id, entity_kind, entity_id))`);
  await connection.run(
    'CREATE INDEX IF NOT EXISTS geospatial_candidate_lookup ON geospatial_candidate(generation_id, entity_kind, longitude, latitude, entity_id)',
  );
  await connection.run(
    'CREATE INDEX IF NOT EXISTS linkable_kind ON linkable_entity(generation_id, entity_kind, entity_id)',
  );
  await connection.run(
    'CREATE INDEX IF NOT EXISTS authority_lookup ON authority_identifier(generation_id, scheme, scope_norm, value_norm, entity_id)',
  );
  await connection.run(
    'CREATE INDEX IF NOT EXISTS exact_lookup ON normalized_exact_key(generation_id, key_kind, value_norm, entity_id)',
  );
  await connection.run(
    'CREATE INDEX IF NOT EXISTS candidate_lookup ON candidate_attribute(generation_id, attribute_name, value_norm, entity_id)',
  );
  await connection.run(`CREATE TABLE IF NOT EXISTS reconciliation_claim (
    generation_id VARCHAR NOT NULL, relation VARCHAR NOT NULL, subject_entity_id VARCHAR NOT NULL,
    content_sha256 VARCHAR NOT NULL, claim_state VARCHAR NOT NULL DEFAULT 'claimed',
    PRIMARY KEY(generation_id, relation, subject_entity_id))`);
  await connection.run(
    "ALTER TABLE reconciliation_claim ADD COLUMN IF NOT EXISTS claim_state VARCHAR DEFAULT 'claimed'",
  );
  await connection.run(`CREATE TABLE IF NOT EXISTS link_resolution (
    generation_id VARCHAR NOT NULL, relation VARCHAR NOT NULL, subject_entity_id VARCHAR NOT NULL,
    resolution_json VARCHAR NOT NULL, resolution_sha256 VARCHAR NOT NULL,
    PRIMARY KEY(generation_id, relation, subject_entity_id))`);
  await connection.run(`CREATE TABLE IF NOT EXISTS duplicate_member (
    generation_id VARCHAR NOT NULL, relation VARCHAR NOT NULL, classification VARCHAR NOT NULL,
    duplicate_key VARCHAR NOT NULL, entity_id VARCHAR NOT NULL, ordinal INTEGER NOT NULL,
    PRIMARY KEY(generation_id, relation, classification, duplicate_key, entity_id))`);
}

type IngestResult = Readonly<{ logicalSha256: string; recordCount: number }>;
type DeclaredMutationSource = BoundedProcessingInput['mutationLog']['sources'][number];

async function ingestMutations(
  connection: DuckDBConnection,
  request: BoundedCountyProcessingRequest,
  processing: BoundedProcessingInput,
): Promise<IngestResult> {
  const existingCount = await scalarCount(
    connection,
    `SELECT count(*)::BIGINT AS value FROM raw_mutation WHERE generation_id=${sql(processing.generationId)}`,
  );
  const declaredCount = request.mutationSources.reduce(
    (total, source) => total + source.sequence.recordCount,
    0,
  );
  if (existingCount !== 0) {
    if (existingCount > declaredCount) {
      throw new BoundedPipelineIntegrityError(
        'Durable mutation spool count exceeds immutable chunk inventory',
      );
    }
    if (existingCount === declaredCount) {
      return verifyMutationSpoolIntegrity(connection, processing, declaredCount);
    }
    await connection.run(
      `DELETE FROM raw_mutation WHERE generation_id=${sql(processing.generationId)}`,
    );
  }

  const ordered = [...request.mutationSources].sort((a, b) => compareUtf8(a.sourceId, b.sourceId));
  const appender = await connection.createAppender('raw_mutation');
  try {
    for (const source of ordered) {
      let sourceOrdinal = 0;
      for await (const value of source.sequence.read()) {
        request.signal.throwIfAborted();
        const mutation = canonicalMutationSchema.parse(value);
        if (mutation.sourceId !== source.sourceId) {
          throw new BoundedPipelineIntegrityError(
            'Mutation source does not match its immutable chunk lane',
          );
        }
        const body = canonicalJson(mutation);
        const contentSha256 = createHash('sha256').update(body).digest('hex');
        appender.appendVarchar(processing.generationId);
        appender.appendVarchar(source.sourceId);
        appender.appendBigInt(BigInt(sourceOrdinal));
        appender.appendInteger(
          partitionForMutation(mutation, processing.partitionPlan.partitionCount),
        );
        appender.appendVarchar(mutationSortKeyHex(mutation));
        appender.appendVarchar(mutation.mutationId);
        appender.appendVarchar(contentSha256);
        appender.appendVarchar(body);
        appender.endRow();
        sourceOrdinal += 1;
      }
    }
    appender.flushSync();
  } catch (error) {
    try {
      appender.closeSync();
    } catch {
      // Preserve the actionable read/parse/cancel error. The next run replays any underfilled
      // durable generation; a close failure after a successful stream still propagates below.
    }
    throw error;
  }
  appender.closeSync();
  return verifyMutationSpoolIntegrity(connection, processing, declaredCount);
}

async function verifyMutationSpoolIntegrity(
  connection: DuckDBConnection,
  processing: BoundedProcessingInput,
  declaredCount: number,
): Promise<IngestResult> {
  const declaredSources = orderedDeclaredMutationSources(processing);
  const durableCount = await scalarCount(
    connection,
    `SELECT count(*)::BIGINT AS value FROM raw_mutation WHERE generation_id=${sql(processing.generationId)}`,
  );
  if (durableCount !== declaredCount) {
    throw new BoundedPipelineIntegrityError(
      'Durable mutation spool count differs from immutable chunk inventory',
    );
  }
  const declaredDomain = declaredSources
    .filter(({ recordCount }) => recordCount !== 0)
    .map(
      ({ sourceId, recordCount }) =>
        `(source_id=${sql(sourceId)} AND source_ordinal>=0 AND source_ordinal<${recordCount})`,
    )
    .join(' OR ');
  const outsideDeclaredDomain = await scalarCount(
    connection,
    `SELECT count(*)::BIGINT AS value FROM raw_mutation WHERE generation_id=${sql(processing.generationId)} AND NOT (${declaredDomain === '' ? 'FALSE' : declaredDomain})`,
  );
  if (outsideDeclaredDomain !== 0) {
    throw new BoundedPipelineIntegrityError(
      'Durable mutation spool contains an unknown source or out-of-range source ordinal',
    );
  }
  await verifyMutationIdentityCollisions(connection, processing, declaredCount);
  const verified = await verifyMutationSpool(connection, processing, declaredSources);
  if (verified.recordCount !== declaredCount) {
    throw new BoundedPipelineIntegrityError(
      'Durable mutation spool count differs from immutable chunk inventory',
    );
  }
  if (verified.logicalSha256 !== processing.mutationLog.logicalSha256) {
    throw new BoundedPipelineIntegrityError(
      'Durable mutation spool logical hash differs from immutable chunks',
    );
  }
  return verified;
}

async function computeExactMutationLogicalSha256(
  request: BoundedCountyProcessingRequest,
): Promise<string> {
  const hash = createHash('sha256');
  let count = 0;
  for (const source of [...request.mutationSources].sort((a, b) =>
    compareUtf8(a.sourceId, b.sourceId),
  )) {
    let sourceCount = 0;
    const sourceHash = createHash('sha256');
    for await (const value of source.sequence.read()) {
      const mutation = canonicalMutationSchema.parse(value);
      if (mutation.sourceId !== source.sourceId)
        throw new BoundedPipelineIntegrityError(
          'Mutation source differs during logical verification',
        );
      const line = `${canonicalJson(mutation)}\n`;
      hash.update(line);
      sourceHash.update(line);
      count += 1;
      sourceCount += 1;
    }
    if (
      sourceCount !== source.sequence.recordCount ||
      sourceHash.digest('hex') !== source.sequence.logicalSha256
    ) {
      throw new BoundedPipelineIntegrityError(
        `Immutable chunk sequence logical identity mismatch: ${source.sourceId}`,
      );
    }
  }
  const declared = request.mutationSources.reduce(
    (total, source) => total + source.sequence.recordCount,
    0,
  );
  if (count !== declared)
    throw new BoundedPipelineIntegrityError('Immutable mutation inventory count mismatch');
  return hash.digest('hex');
}

async function verifyRootedMutationSequences(
  request: BoundedCountyProcessingRequest,
  sharedBudget: ProcessWideBoundedBudget,
  maximumBytes: number,
): Promise<void> {
  for (const source of request.mutationSources) {
    const root = source.sequence.chunkInventory;
    if (root == null) continue;
    if (source.sequence.readReferences === undefined) {
      throw new BoundedPipelineIntegrityError(
        `Rooted mutation sequence omitted references: ${source.sourceId}`,
      );
    }
    const inventory = streamVerifiedBoundedDescriptorInventory({
      root,
      resolver: descriptorPageResolver(request, sharedBudget, maximumBytes),
      parseDescriptor: (value) => mutationChunkInputSchema.parse(value),
      orderKey: ({ sequence }) => sequence.toString().padStart(16, '0'),
      recordCount: ({ recordCount }) => recordCount,
      byteSize: ({ byteSize }) => byteSize,
    });
    // The descriptor iterator and completion reject together; attach immediately so a resolver
    // failure cannot become an unhandled rejection before iterator cleanup reaches the catch.
    void inventory.completion.catch(() => undefined);
    const rooted = inventory.descriptors[Symbol.asyncIterator]();
    const declared = source.sequence.readReferences()[Symbol.asyncIterator]();
    const logical = createHash('sha256');
    const licenses = new Set<string>();
    let recordCount = 0;
    try {
      for (;;) {
        const [rootedNext, declaredNext] = await Promise.all([rooted.next(), declared.next()]);
        if (rootedNext.done || declaredNext.done) {
          if (rootedNext.done !== declaredNext.done) {
            throw new BoundedPipelineIntegrityError(
              `Rooted mutation references differ from their page inventory: ${source.sourceId}`,
            );
          }
          break;
        }
        const descriptor = rootedNext.value;
        const reference = declaredNext.value;
        if (canonicalJson(descriptor) !== canonicalJson(reference)) {
          throw new BoundedPipelineIntegrityError(
            `Rooted mutation reference changed: ${source.sourceId}`,
          );
        }
        const stored = await request.artifactStore.headByLogicalKey(reference.logicalKey);
        if (
          stored?.uri !== reference.uri ||
          stored.sha256 !== reference.sha256 ||
          stored.byteSize !== reference.byteSize ||
          stored.mediaType !== reference.mediaType
        ) {
          throw new BoundedPipelineIntegrityError(
            `Rooted mutation chunk changed: ${reference.logicalKey}`,
          );
        }
        let chunkRecords = 0;
        let chunkBytes = 0;
        for await (const line of readCanonicalLines(request.artifactStore, reference)) {
          if (line.byteLength > maximumBytes) {
            throw new BoundedPipelineBudgetError('Rooted mutation record exceeds byte budget');
          }
          canonicalMutationSchema.parse(
            JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(line)) as unknown,
          );
          logical.update(line);
          chunkRecords += 1;
          chunkBytes += line.byteLength;
        }
        if (chunkRecords !== reference.recordCount || chunkBytes !== reference.byteSize) {
          throw new BoundedPipelineIntegrityError(
            `Rooted mutation chunk counts changed: ${reference.logicalKey}`,
          );
        }
        recordCount += chunkRecords;
        licenses.add(reference.licenseSnapshotRef);
      }
      await inventory.completion;
      await rooted.return?.();
      await declared.return?.();
    } catch (error) {
      await rooted.return?.();
      await declared.return?.();
      throw error;
    }
    const declaredLicenses = [...new Set(source.sequence.licenseSnapshotRefs ?? [])].sort(
      compareUtf8,
    );
    if (
      recordCount !== source.sequence.recordCount ||
      logical.digest('hex') !== source.sequence.logicalSha256 ||
      canonicalJson([...licenses].sort(compareUtf8)) !== canonicalJson(declaredLicenses)
    ) {
      throw new BoundedPipelineIntegrityError(
        `Rooted mutation physical identity changed: ${source.sourceId}`,
      );
    }
  }
}

async function verifyMutationSpool(
  connection: DuckDBConnection,
  processing: BoundedProcessingInput,
  declaredSources: readonly DeclaredMutationSource[],
): Promise<IngestResult> {
  const hash = createHash('sha256');
  let recordCount = 0;
  const pageRecords = Math.max(1, Math.min(2_048, processing.budget.maxBufferedRecords));
  for (const source of declaredSources) {
    const sourceHash = createHash('sha256');
    let sourceRecordCount = 0;
    for (let firstOrdinal = 0; firstOrdinal < source.recordCount; firstOrdinal += pageRecords) {
      const lastOrdinalExclusive = Math.min(source.recordCount, firstOrdinal + pageRecords);
      const pending = [{ firstOrdinal, lastOrdinalExclusive }];
      while (pending.length !== 0) {
        const range = pending.pop();
        if (range === undefined) {
          throw new BoundedPipelineIntegrityError('Mutation verification range disappeared');
        }
        const expectedPageRecords = range.lastOrdinalExclusive - range.firstOrdinal;
        const preflight = await scalarRow(
          connection,
          `SELECT count(*)::BIGINT AS record_count, coalesce(sum(octet_length(encode(mutation_json))), 0)::BIGINT AS byte_size FROM raw_mutation WHERE generation_id=${sql(processing.generationId)} AND source_id=${sql(source.sourceId)} AND source_ordinal>=${range.firstOrdinal} AND source_ordinal<${range.lastOrdinalExclusive}`,
        );
        const preflightRecords = numberValue(preflight?.record_count ?? 0);
        const preflightBytes = numberValue(preflight?.byte_size ?? 0);
        if (preflightRecords !== expectedPageRecords) {
          throw new BoundedPipelineIntegrityError(
            `Durable mutation spool source ordinals are not contiguous: ${source.sourceId}`,
          );
        }
        if (preflightBytes > processing.budget.maxBufferedBytes) {
          if (expectedPageRecords === 1) {
            throw new BoundedPipelineBudgetError(
              'Durable mutation spool row exceeds verification byte budget',
            );
          }
          const middleOrdinal = range.firstOrdinal + Math.floor(expectedPageRecords / 2);
          pending.push(
            { firstOrdinal: middleOrdinal, lastOrdinalExclusive: range.lastOrdinalExclusive },
            { firstOrdinal: range.firstOrdinal, lastOrdinalExclusive: middleOrdinal },
          );
          continue;
        }
        const page: Readonly<Record<string, unknown>>[] = [];
        for await (const row of streamRows(
          connection,
          `SELECT source_id, source_ordinal, partition_id, sort_key, mutation_id, content_sha256, mutation_json FROM raw_mutation WHERE generation_id=${sql(processing.generationId)} AND source_id=${sql(source.sourceId)} AND source_ordinal>=${range.firstOrdinal} AND source_ordinal<${range.lastOrdinalExclusive} LIMIT ${expectedPageRecords + 1}`,
        )) {
          page.push(row);
        }
        if (page.length !== expectedPageRecords) {
          throw new BoundedPipelineIntegrityError(
            `Durable mutation spool source ordinals are not contiguous: ${source.sourceId}`,
          );
        }
        page.sort(
          (left, right) => numberValue(left.source_ordinal) - numberValue(right.source_ordinal),
        );
        let pageBytes = 0;
        for (let pageIndex = 0; pageIndex < page.length; pageIndex += 1) {
          const row = page[pageIndex];
          if (row === undefined) {
            throw new BoundedPipelineIntegrityError('Mutation page disappeared');
          }
          const sourceOrdinal = numberValue(row.source_ordinal);
          if (sourceOrdinal !== range.firstOrdinal + pageIndex) {
            throw new BoundedPipelineIntegrityError(
              `Durable mutation spool source ordinals are not contiguous: ${source.sourceId}`,
            );
          }
          const body = stringValue(row.mutation_json);
          pageBytes += Buffer.byteLength(body, 'utf8');
          const mutation = canonicalMutationSchema.parse(JSON.parse(body));
          if (
            stringValue(row.source_id) !== source.sourceId ||
            mutation.sourceId !== source.sourceId ||
            mutation.mutationId !== stringValue(row.mutation_id) ||
            canonicalJson(mutation) !== body ||
            createHash('sha256').update(body).digest('hex') !== stringValue(row.content_sha256)
          ) {
            throw new BoundedPipelineIntegrityError(
              'Durable mutation spool row identity/content mismatch',
            );
          }
          if (
            numberValue(row.partition_id) !==
              partitionForMutation(mutation, processing.partitionPlan.partitionCount) ||
            stringValue(row.sort_key) !== mutationSortKeyHex(mutation)
          ) {
            throw new BoundedPipelineIntegrityError(
              'Durable mutation spool derived routing metadata mismatch',
            );
          }
          const line = `${body}\n`;
          sourceHash.update(line);
          hash.update(line);
          sourceRecordCount += 1;
          recordCount += 1;
        }
        if (pageBytes !== preflightBytes) {
          throw new BoundedPipelineIntegrityError(
            'Durable mutation spool bytes changed during verification',
          );
        }
      }
    }
    if (
      sourceRecordCount !== source.recordCount ||
      sourceHash.digest('hex') !== source.logicalSha256
    ) {
      throw new BoundedPipelineIntegrityError(
        `Durable mutation spool source logical hash differs from immutable chunks: ${source.sourceId}`,
      );
    }
  }
  return Object.freeze({ logicalSha256: hash.digest('hex'), recordCount });
}

function orderedDeclaredMutationSources(
  processing: BoundedProcessingInput,
): readonly DeclaredMutationSource[] {
  const sources = [...processing.mutationLog.sources].sort((left, right) =>
    compareUtf8(left.sourceId, right.sourceId),
  );
  for (let index = 1; index < sources.length; index += 1) {
    if (sources[index - 1]?.sourceId === sources[index]?.sourceId) {
      throw new BoundedPipelineIntegrityError(
        'Durable mutation spool declaration contains duplicate source identifiers',
      );
    }
  }
  return Object.freeze(sources);
}

async function verifyMutationIdentityCollisions(
  connection: DuckDBConnection,
  processing: BoundedProcessingInput,
  declaredCount: number,
): Promise<void> {
  const collisionMemoryBytes = Math.max(1, Math.floor(processing.budget.duckdbMemoryBytes / 4));
  const maximumRowsPerBucket = Math.max(1, Math.floor(collisionMemoryBytes / 512));
  const bucketCount = Math.max(1, Math.ceil(declaredCount / maximumRowsPerBucket));
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const collisions = await scalarCount(
      connection,
      `SELECT count(*)::BIGINT AS value FROM (SELECT mutation_id FROM raw_mutation WHERE generation_id=${sql(processing.generationId)} AND hash(mutation_id)%${bucketCount}=${bucket} GROUP BY mutation_id HAVING min(content_sha256)<>max(content_sha256) LIMIT 1)`,
    );
    if (collisions !== 0) {
      throw new BoundedPipelineIntegrityError('Mutation identity was reused for different content');
    }
  }
}

async function materializeTrustedAcquisition(
  request: BoundedCountyProcessingRequest,
  sharedBudget: ProcessWideBoundedBudget,
  maximumBufferedBytes: number,
): Promise<TrustedAcquisitionBinding> {
  const acquiredBySource = new Map(
    request.acquiredSources.map((source) => [source.sourceId, source.artifacts] as const),
  );
  if (acquiredBySource.size !== request.acquiredSources.length) {
    throw new BoundedPipelineIntegrityError(
      'Trusted acquisition source identifiers must be unique',
    );
  }
  const sourceInventory = new Map(request.sources.map((source) => [source.sourceId, source]));
  if (sourceInventory.size !== request.sources.length) {
    throw new BoundedPipelineIntegrityError('Complete source-state inventory contains duplicates');
  }
  for (const lane of request.acquiredSources) {
    const source = sourceInventory.get(lane.sourceId);
    if (source === undefined) {
      throw new BoundedPipelineIntegrityError(
        `Trusted acquisition has undeclared source ${lane.sourceId}`,
      );
    }
    for (const artifact of lane.artifacts) {
      const snapshotId =
        source.snapshotIdentity.observedContentId ?? source.snapshotIdentity.intentId;
      if (
        artifact.sourceId !== source.sourceId ||
        artifact.snapshotId !== snapshotId ||
        !source.schemaHashes.includes(artifact.schemaFingerprint.value)
      ) {
        throw new BoundedPipelineIntegrityError(
          `Acquired object identity/schema does not close ${source.sourceId}@${snapshotId}`,
        );
      }
      await verifyAcquiredObject(request, artifact, sharedBudget, maximumBufferedBytes);
    }
  }
  const trustedSources = [...request.sources]
    .sort((left, right) => compareUtf8(left.sourceId, right.sourceId))
    .map((source) => {
      const acquiredArtifacts = [...(acquiredBySource.get(source.sourceId) ?? [])].sort(
        (left, right) => compareUtf8(left.artifactId, right.artifactId),
      );
      const snapshotId =
        source.snapshotIdentity.observedContentId ?? source.snapshotIdentity.intentId;
      const zeroByteDiscoverOnlyLane =
        source.executionMode === 'discover_only' &&
        source.terminalState === 'partial' &&
        source.coverage.observedRecords === 0 &&
        source.coverage.acceptedRecords === 0 &&
        acquiredArtifacts.length === 0;
      if (
        ((source.terminalState === 'complete' || source.terminalState === 'partial') &&
          acquiredArtifacts.length === 0 &&
          !zeroByteDiscoverOnlyLane) ||
        acquiredArtifacts.some(
          (artifact) => artifact.sourceId !== source.sourceId || artifact.snapshotId !== snapshotId,
        )
      ) {
        throw new BoundedPipelineIntegrityError(
          `Trusted acquisition artifacts do not close ${source.sourceId}@${snapshotId}`,
        );
      }
      acquiredBySource.delete(source.sourceId);
      const terminalState = zeroByteDiscoverOnlyLane
        ? ('blocked' as const)
        : source.terminalState === 'complete'
          ? ('succeeded' as const)
          : source.terminalState;
      const permissionState =
        source.license.redistribution === 'prohibited'
          ? ('prohibited' as const)
          : source.license.redistribution === 'restricted' || source.license.containsPersonalData
            ? ('restricted' as const)
            : source.license.redistribution === 'approved'
              ? ('allowed' as const)
              : ('pending' as const);
      const limitations = [
        ...exactSourceIds(
          source.limitations.length > 0
            ? source.limitations
            : terminalState !== 'succeeded' || permissionState !== 'allowed'
              ? [
                  `${source.sourceId} is ${terminalState} with ${permissionState} public permission; county use remains limited.`,
                ]
              : [],
        ),
      ];
      const boundCapabilities = BOUNDED_AUTHORITATIVE_COUNTY_CAPABILITIES.filter((capability) =>
        BOUNDED_AUTHORITATIVE_CAPABILITY_SOURCE_IDS[capability].some(
          (sourceId) => sourceId === source.sourceId,
        ),
      );
      const declaredCapability = BOUNDED_AUTHORITATIVE_COUNTY_CAPABILITIES.find(
        (capability) => capability === source.capability,
      );
      const capabilities =
        declaredCapability === undefined
          ? boundCapabilities
          : [...new Set([...boundCapabilities, declaredCapability])].sort(compareUtf8);
      const permitAuthority = BOUNDED_AUTHORITATIVE_PERMIT_AUTHORITIES.find(
        ({ sourceId }) => sourceId === source.sourceId,
      );
      return {
        sourceId: source.sourceId,
        snapshotId,
        acquiredArtifacts,
        sourceSha256: boundedTrustedSourceSha256(acquiredArtifacts),
        schemaSha256: boundedTrustedSchemaSha256(acquiredArtifacts),
        asOf: source.sourceAsOf,
        contributors: [source.sourceId],
        terminalState,
        permissionState,
        limitations,
        capabilities,
        permitAuthorityIds:
          permitAuthority === undefined || terminalState !== 'succeeded'
            ? []
            : [permitAuthority.authorityId],
      };
    });
  if (acquiredBySource.size !== 0) {
    throw new BoundedPipelineIntegrityError(
      `Trusted acquisition has undeclared sources: ${[...acquiredBySource.keys()].sort(compareUtf8).join(',')}`,
    );
  }
  const trustedSourceMap = new Map<string, (typeof trustedSources)[number]>(
    trustedSources.map((source) => [source.sourceId, source]),
  );
  const capabilities = capabilityStates(request.sources)
    .map((capability) => {
      const terminalStates = new Set(
        capability.sourceIds.map((sourceId) => trustedSourceMap.get(sourceId)?.terminalState),
      );
      const state =
        capability.sourceIds.length === 0
          ? ('not_configured' as const)
          : terminalStates.size > 1
            ? ('partial' as const)
            : terminalStates.has('succeeded')
              ? ('succeeded' as const)
              : terminalStates.has('partial')
                ? ('partial' as const)
                : terminalStates.has('blocked')
                  ? ('blocked' as const)
                  : ('failed' as const);
      const value = {
        capability: capability.capability,
        state,
        sourceIds: [...capability.sourceIds].sort(compareUtf8),
        limitations: [...exactSourceIds(capability.limitations)],
      };
      return {
        ...value,
        evidenceSha256: boundedTrustedCapabilityEvidenceSha256(value, trustedSourceMap),
      };
    })
    .sort((left, right) => compareUtf8(left.capability, right.capability));
  const payload = {
    format: 'oracle-trusted-acquisition-manifest-v1' as const,
    runId: request.configuration.runId,
    county: 'Santa Clara' as const,
    state: 'CA' as const,
    createdAt: request.configuration.requestedAt,
    runStatus: sourceInventoryRunStatus(request.sources),
    sources: trustedSources,
    capabilities,
    ...authoritativeRegistry(trustedSources, capabilities),
  };
  const manifest = boundedTrustedAcquisitionManifestSchema.parse({
    ...payload,
    manifestSha256: boundedTrustedAcquisitionManifestSha256(payload),
  });
  const body = Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8');
  const bodySha256 = createHash('sha256').update(body).digest('hex');
  const logicalKey = `bounded/trusted-acquisition/${manifest.manifestSha256}.json`;
  let stored;
  try {
    stored = await request.artifactStore.putImmutable({
      logicalKey,
      mediaType: 'application/json',
      body,
      expectedSha256: bodySha256,
      metadata: Object.freeze({
        manifestSha256: manifest.manifestSha256,
        format: manifest.format,
      }),
      ifAbsent: true,
    });
  } catch (error) {
    stored = await request.artifactStore.headByLogicalKey(logicalKey);
    if (stored === undefined) throw error;
    if (stored.sha256 !== bodySha256 || stored.byteSize !== body.byteLength) throw error;
  }
  const reference = Object.freeze({
    uri: stored.uri,
    manifestSha256: manifest.manifestSha256,
  });
  const resolver: BoundedTrustedAcquisitionResolver = Object.freeze({
    loadVerified: async (candidate: BoundedTrustedAcquisitionReference) => {
      if (
        candidate.uri !== reference.uri ||
        candidate.manifestSha256 !== reference.manifestSha256
      ) {
        throw new BoundedPipelineIntegrityError('Trusted acquisition reference changed');
      }
      const head = await request.artifactStore.head(candidate.uri);
      if (head === undefined) {
        throw new BoundedPipelineIntegrityError('Trusted acquisition object is missing or changed');
      }
      if (
        head.logicalKey !== logicalKey ||
        head.sha256 !== bodySha256 ||
        head.byteSize !== body.byteLength
      ) {
        throw new BoundedPipelineIntegrityError('Trusted acquisition object is missing or changed');
      }
      const chunks: Uint8Array[] = [];
      let byteSize = 0;
      for await (const chunk of request.artifactStore.read(candidate.uri)) {
        byteSize += chunk.byteLength;
        if (byteSize > 16 * 1024 * 1024) {
          throw new BoundedPipelineBudgetError('Trusted acquisition manifest exceeds 16 MiB');
        }
        chunks.push(chunk);
      }
      const loaded = boundedTrustedAcquisitionManifestSchema.parse(
        JSON.parse(Buffer.concat(chunks, byteSize).toString('utf8')),
      );
      if (loaded.manifestSha256 !== candidate.manifestSha256) {
        throw new BoundedPipelineIntegrityError('Trusted acquisition semantic hash changed');
      }
      return loaded;
    },
  });
  return Object.freeze({ manifest, reference, resolver });
}

async function verifyAcquiredObject(
  request: BoundedCountyProcessingRequest,
  artifact: BoundedCountyProcessingRequest['acquiredSources'][number]['artifacts'][number],
  sharedBudget: ProcessWideBoundedBudget,
  maximumBufferedBytes: number,
): Promise<void> {
  const head = await request.artifactStore.head(artifact.rawUri);
  if (
    head?.sha256 !== artifact.sha256 ||
    head.byteSize !== artifact.byteSize ||
    head.mediaType !== artifact.mediaType
  ) {
    throw new BoundedPipelineIntegrityError(
      `Acquired object is missing or its immutable metadata changed: ${artifact.artifactId}`,
    );
  }
  const hash = createHash('sha256');
  let byteSize = 0;
  for await (const chunk of request.artifactStore.read(artifact.rawUri)) {
    if (chunk.byteLength > maximumBufferedBytes) {
      throw new BoundedPipelineBudgetError(
        `Acquired object segment exceeds byte budget: ${artifact.artifactId}`,
      );
    }
    const release = sharedBudget.acquire(0, chunk.byteLength);
    try {
      hash.update(chunk);
      byteSize += chunk.byteLength;
    } finally {
      release();
    }
  }
  if (byteSize !== artifact.byteSize || hash.digest('hex') !== artifact.sha256) {
    throw new BoundedPipelineIntegrityError(
      `Acquired object bytes changed: ${artifact.artifactId}`,
    );
  }
}

function authoritativeRegistry(
  sources: BoundedTrustedAcquisitionManifest['sources'],
  capabilities: BoundedTrustedAcquisitionManifest['capabilities'],
): Readonly<{ authoritativeCountyRegistry?: BoundedAuthoritativeCountyRegistry }> {
  const trustedSource = (sourceId: string) =>
    sources.find((source) => source.sourceId === sourceId);
  const complete =
    sources.every(
      ({ terminalState, permissionState }) =>
        terminalState === 'succeeded' && permissionState === 'allowed',
    ) &&
    capabilities.every(
      ({ capability, state }) =>
        state === 'succeeded' ||
        (capability === 'transit_511_fallback' && state === 'not_configured'),
    ) &&
    BOUNDED_AUTHORITATIVE_COUNTY_CAPABILITIES.every((capability) =>
      BOUNDED_AUTHORITATIVE_CAPABILITY_SOURCE_IDS[capability].every(
        (sourceId) => trustedSource(sourceId) !== undefined,
      ),
    ) &&
    BOUNDED_AUTHORITATIVE_PERMIT_AUTHORITIES.every(
      ({ sourceId }) => trustedSource(sourceId) !== undefined,
    );
  if (!complete) return Object.freeze({});
  const binding = (sourceId: string) => {
    const source = trustedSource(sourceId);
    if (source === undefined) {
      throw new BoundedPipelineIntegrityError(`Authoritative source disappeared: ${sourceId}`);
    }
    return {
      sourceId: source.sourceId,
      sourceSha256: source.sourceSha256,
      schemaSha256: source.schemaSha256,
      artifactIds: source.acquiredArtifacts.map(({ artifactId }) => artifactId),
    };
  };
  const body = {
    format: 'oracle-santa-clara-authoritative-registry-v1' as const,
    county: 'Santa Clara' as const,
    state: 'CA' as const,
    capabilities: BOUNDED_AUTHORITATIVE_COUNTY_CAPABILITIES.map((capability) => ({
      capability,
      sources: BOUNDED_AUTHORITATIVE_CAPABILITY_SOURCE_IDS[capability].map(binding),
    })),
    permitAuthorities: BOUNDED_AUTHORITATIVE_PERMIT_AUTHORITIES.map(
      ({ authorityId, sourceId }) => ({ authorityId, source: binding(sourceId) }),
    ),
  };
  const registry = boundedAuthoritativeCountyRegistrySchema.parse({
    ...body,
    registrySha256: boundedAuthoritativeCountyRegistrySha256(body),
  });
  return Object.freeze({ authoritativeCountyRegistry: registry });
}

function mutationLicenseSnapshotRefs(processing: BoundedProcessingInput): readonly string[] {
  return Object.freeze(
    [
      ...new Set(
        processing.mutationLog.sources.flatMap(
          (source) =>
            source.licenseSnapshotRefs ??
            source.chunks.map(({ licenseSnapshotRef }) => licenseSnapshotRef),
        ),
      ),
    ].sort(compareUtf8),
  );
}

function createProcessingInput(
  request: BoundedCountyProcessingRequest,
  options: RuntimeOptions,
  logicalSha256: string,
  trustedSourceManifestSha256: string,
  trustedCapabilityStateSha256: string,
): BoundedProcessingInput {
  const orderedSources = [...request.mutationSources].sort((a, b) =>
    compareUtf8(a.sourceId, b.sourceId),
  );
  const sources = orderedSources.map(({ sourceId, snapshotId, sequence }) => ({
    sourceId,
    snapshotId,
    mutationSchemaSha256: MUTATION_SCHEMA_SHA256,
    recordCount: sequence.recordCount,
    logicalSha256: sequence.logicalSha256,
    chunks:
      sequence.chunkInventory == null
        ? sequence.chunks.map((chunk) => mutationChunkInputSchema.parse(chunk))
        : [],
    chunkInventory: sequence.chunkInventory ?? null,
    ...(sequence.chunkInventory == null
      ? {}
      : {
          licenseSnapshotRefs: [...new Set(sequence.licenseSnapshotRefs ?? [])].sort(compareUtf8),
        }),
  }));
  const mutationLogWithoutHash = {
    format: 'oracle-bounded-mutation-log-v2' as const,
    recordCount: sources.reduce((total, source) => total + source.recordCount, 0),
    logicalSha256,
    mutationSchemaSha256: MUTATION_SCHEMA_SHA256,
    sources,
  };
  const mutationLog: BoundedMutationLogInput = boundedMutationLogInputSchema.parse({
    ...mutationLogWithoutHash,
    physicalManifestSha256: physicalMutationManifestSha256(mutationLogWithoutHash),
  });
  const sourceSnapshotIds = sources.map(({ snapshotId }) => snapshotId).sort(compareUtf8);
  const releaseId = `santa-clara-${sha256({ runId: request.configuration.runId, sourceSnapshotIds }).slice(0, 24)}`;
  const base = {
    contractVersion: BOUNDED_PROCESSING_CONTRACT_VERSION,
    processorKind: BOUNDED_PROCESSOR_KIND,
    runId: request.configuration.runId,
    pipelineVersion: request.configuration.pipelineVersion,
    profile: request.configuration.profile.name as 'pilot' | 'full' | 'incremental',
    configurationSha256: sha256({
      configuration: request.configuration,
      completeSourceStateInventory: [...request.sources].sort((left, right) =>
        compareUtf8(left.sourceId, right.sourceId),
      ),
    }),
    requestedAt: request.configuration.requestedAt,
    sourceManifestSha256: trustedSourceManifestSha256,
    capabilityStateSha256: trustedCapabilityStateSha256,
    sourceSnapshotIds,
    release: {
      releaseId,
      releaseContractVersion: '1.0.0',
      county: 'Santa Clara' as const,
      state: 'CA' as const,
      generatedAt: request.configuration.requestedAt,
    },
    mutationLog,
    partitionPlan: {
      algorithm: 'sha256-leading-64-bit-modulo-v1' as const,
      partitionCount: options.partitionCount,
      groupKeyVersion: 'canonical-mutation-group-key-v1' as const,
      mutationSortVersion: 'length-prefixed-utf8-mutation-sort-v1' as const,
    },
    budget: options.budget,
    stageVersions: {
      partition_mutations: 'pipeline-duckdb-partition-v1',
      reduce_canonical: 'bounded-canonical-reduction-v1',
      build_link_index: 'bounded-link-index-plan-v2',
      reconcile_links: 'bounded-reconciliation-v1',
      derive_features: 'bounded-feature-stage-v1',
      build_marts: 'bounded-serving-release-v1',
      finalize_release: 'bounded-serving-finalize-v1',
    },
  };
  const logicalIdentity = logicalOutputIdentitySha256(base);
  const withoutGeneration = { ...base, logicalOutputIdentitySha256: logicalIdentity };
  return boundedProcessingInputSchema.parse({
    ...withoutGeneration,
    generationId: boundedProcessingGenerationId(withoutGeneration),
  });
}

async function bindGeneration(
  connection: DuckDBConnection,
  processing: BoundedProcessingInput,
  fenceToken: string,
): Promise<void> {
  const existing = await scalarRow(
    connection,
    `SELECT generation_id, logical_output_sha256, physical_input_sha256, fence_token FROM bounded_generation LIMIT 2`,
  );
  if (existing !== null) {
    if (
      existing.generation_id !== processing.generationId ||
      existing.logical_output_sha256 !== processing.logicalOutputIdentitySha256 ||
      existing.physical_input_sha256 !== processing.mutationLog.physicalManifestSha256
    )
      throw new BoundedPipelineMixedGenerationError();
    if (existing.fence_token !== fenceToken) {
      const previousFence =
        existing.fence_token === null
          ? 'fence_token IS NULL'
          : `fence_token=${sql(stringValue(existing.fence_token))}`;
      const fenced = await scalarRow(
        connection,
        `UPDATE bounded_generation SET fence_token=${sql(fenceToken)} WHERE generation_id=${sql(processing.generationId)} AND ${previousFence} RETURNING fence_token`,
      );
      if (fenced?.fence_token !== fenceToken) {
        throw new BoundedPipelineIntegrityError('Bounded generation fence CAS lost');
      }
    }
    return;
  }
  await connection.run(
    `INSERT INTO bounded_generation VALUES (${sql(processing.generationId)}, ${sql(processing.logicalOutputIdentitySha256)}, ${sql(processing.mutationLog.physicalManifestSha256)}, ${sql(fenceToken)})`,
  );
}

async function materializeAllMutationPartitions(
  request: BoundedCountyProcessingRequest,
  connection: DuckDBConnection,
  processing: BoundedProcessingInput,
  root: string,
  sharedBudget: ProcessWideBoundedBudget,
): Promise<void> {
  for (
    let partitionId = 0;
    partitionId < processing.partitionPlan.partitionCount;
    partitionId += 1
  ) {
    const prior = await scalarStringOrNull(
      connection,
      `SELECT artifact_json AS value FROM partition_artifact WHERE generation_id=${sql(processing.generationId)} AND partition_id=${partitionId}`,
    );
    let artifact: ImmutableBoundedArtifact;
    if (prior === null) {
      const value = await materializeMutationPartition(
        connection,
        processing,
        root,
        partitionId,
        sharedBudget,
      );
      const logicalKey = `bp/${generationPath(processing.generationId)}/${partitionId.toString().padStart(6, '0')}`;
      const stored = await persistLocalArtifact(
        request,
        logicalKey,
        'application/x-ndjson',
        value.path,
        value.sha256,
        value.byteSize,
        sharedBudget,
        processing.budget.maxBufferedBytes,
      );
      artifact = Object.freeze({
        generationId: processing.generationId,
        stage: 'partition_mutations',
        dataset: 'canonical-mutations',
        partitionId,
        sequence: 0,
        logicalKey,
        uri: stored.uri,
        mediaType: 'application/x-ndjson',
        byteSize: value.byteSize,
        sha256: value.sha256,
        recordCount: value.recordCount,
        firstSortKey: value.firstSortKey,
        lastSortKey: value.lastSortKey,
        schemaSha256: MUTATION_SCHEMA_SHA256,
        sourceLineageSha256: processing.sourceManifestSha256,
        licenseIdentitySha256: sha256(mutationLicenseSnapshotRefs(processing)),
        visibility: 'mixed_internal',
      });
      await connection.run(
        `INSERT INTO partition_artifact VALUES (${sql(processing.generationId)}, ${partitionId}, ${sql(canonicalJson(artifact))})`,
      );
    } else {
      artifact = JSON.parse(prior) as ImmutableBoundedArtifact;
      const file = await hashFile(
        artifactPath(request.artifactStore, artifact),
        sharedBudget,
        processing.budget.maxBufferedBytes,
      );
      if (file.sha256 !== artifact.sha256 || file.byteSize !== artifact.byteSize) {
        throw new BoundedPipelineIntegrityError(
          `Immutable mutation partition is corrupt: ${partitionId}`,
        );
      }
    }
    await recordStageArtifact(connection, artifact);
    await commitBoundedUnit(
      request,
      connection,
      processing,
      'partition_mutations',
      partitionId,
      artifact.recordCount,
      [artifact],
    );
  }
}

async function reduceCanonical(
  request: BoundedCountyProcessingRequest,
  connection: DuckDBConnection,
  processing: BoundedProcessingInput,
  root: string,
  signal: AbortSignal,
  sharedBudget: ProcessWideBoundedBudget,
  crash: BoundedPipelineProcessorOptions['crash'],
): Promise<readonly BoundedCanonicalPartitionSummary[]> {
  const summaries: BoundedCanonicalPartitionSummary[] = [];
  for (
    let partitionId = 0;
    partitionId < processing.partitionPlan.partitionCount;
    partitionId += 1
  ) {
    signal.throwIfAborted();
    const prior = await scalarStringOrNull(
      connection,
      `SELECT summary_json AS value FROM stage_partition WHERE generation_id=${sql(processing.generationId)} AND stage='reduce_canonical' AND partition_id=${partitionId}`,
    );
    if (prior !== null) {
      const summary = JSON.parse(prior) as BoundedCanonicalPartitionSummary;
      summaries.push(summary);
      const artifact = await materializeStageValueArtifact(
        request,
        connection,
        processing,
        'reduce_canonical',
        'canonical-partition-summary',
        partitionId,
        root,
        summary,
        sharedBudget,
      );
      await commitBoundedUnit(
        request,
        connection,
        processing,
        'reduce_canonical',
        partitionId,
        summary.inputRecords,
        [artifact],
      );
      continue;
    }
    const artifactText = await scalarStringOrNull(
      connection,
      `SELECT artifact_json AS value FROM partition_artifact WHERE generation_id=${sql(processing.generationId)} AND partition_id=${partitionId}`,
    );
    if (artifactText === null) {
      throw new BoundedPipelineIntegrityError(`Partition manifest omitted ${partitionId}`);
    }
    const artifact = JSON.parse(artifactText) as ImmutableBoundedArtifact;
    const transaction = new DuckCanonicalTransaction(
      connection,
      processing.generationId,
      partitionId,
    );
    await transaction.begin();
    // County source records can legitimately produce canonical mutations larger than 64 KiB
    // (for example, bounded geometry/proxy values). Keep one validation lease small relative to
    // the process-wide budget while allowing those already-bounded rows through. The NDJSON
    // reader additionally accounts for its exact pending/parsed row bytes.
    const maximumMutationBytes = Math.max(
      1,
      Math.min(1024 * 1024, Math.floor(processing.budget.maxBufferedBytes / 16)),
    );
    const summary = await reduceBoundedCanonicalPartition({
      generationId: processing.generationId,
      partitionId,
      partitionCount: processing.partitionPlan.partitionCount,
      artifact,
      budget: processing.budget,
      ...Object.freeze({
        maximumMutationBytes,
        maximumAggregateBytes: Math.max(1, Math.floor(processing.budget.maxBufferedBytes / 2)),
      }),
      mutations: readNdjsonFile(
        artifactPath(request.artifactStore, artifact),
        maximumMutationBytes,
        sharedBudget,
      ),
      transaction,
      sharedBudget,
    });
    summaries.push(summary);
    const summaryArtifact = await materializeStageValueArtifact(
      request,
      connection,
      processing,
      'reduce_canonical',
      'canonical-partition-summary',
      partitionId,
      root,
      summary,
      sharedBudget,
    );
    await commitBoundedUnit(
      request,
      connection,
      processing,
      'reduce_canonical',
      partitionId,
      summary.inputRecords,
      [summaryArtifact],
    );
    await crash?.('after_canonical_partition', { partitionId });
  }
  await rebuildCanonicalFieldLineageIndex(connection, processing.generationId, signal);
  return Object.freeze(summaries);
}

async function rebuildCanonicalFieldLineageIndex(
  connection: DuckDBConnection,
  generationId: string,
  signal: AbortSignal,
): Promise<void> {
  await connection.run('BEGIN TRANSACTION');
  let appender: DuckDBAppender | null = null;
  try {
    await connection.run(
      `DELETE FROM canonical_field_lineage WHERE generation_id=${sql(generationId)}`,
    );
    appender = await connection.createAppender('canonical_field_lineage');
    for await (const aggregate of streamKeysetJson<CanonicalEntityAggregate>(
      connection,
      `SELECT entity_id AS key, aggregate_json AS value FROM canonical_entity WHERE generation_id=${sql(generationId)}`,
      'key',
    )) {
      signal.throwIfAborted();
      for (const observation of aggregate.observations) {
        const sourceRecord = observation.lineage.sourceRecord;
        appender.appendVarchar(generationId);
        appender.appendVarchar(aggregate.entity.id);
        appender.appendVarchar(observation.observationId);
        appender.appendVarchar(observation.fieldPath);
        appender.appendVarchar(sourceRecord.sourceId);
        appender.appendVarchar(sourceRecord.snapshotId);
        appender.appendVarchar(sourceRecord.artifactId);
        appender.appendVarchar(sourceRecord.recordKey);
        appender.appendVarchar(sourceRecord.recordSha256);
        appender.appendVarchar(observation.lineage.lineageSha256);
        appender.endRow();
      }
    }
    appender.flushSync();
    appender.closeSync();
    appender = null;
    await connection.run('COMMIT');
  } catch (error) {
    if (appender !== null) {
      appender.closeSync();
    }
    await connection.run('ROLLBACK');
    throw error;
  }
}

async function materializeMutationPartition(
  connection: DuckDBConnection,
  processing: BoundedProcessingInput,
  root: string,
  partitionId: number,
  sharedBudget: ProcessWideBoundedBudget,
): Promise<
  Readonly<{
    path: string;
    byteSize: number;
    sha256: string;
    recordCount: number;
    firstSortKey: string | null;
    lastSortKey: string | null;
  }>
> {
  const directory = confinedChild(root, 'partition-mutations');
  await mkdir(directory, { recursive: true });
  const path = confinedChild(directory, `${partitionId.toString().padStart(6, '0')}.ndjson`);
  const temporary = `${path}.partial`;
  const handle = await open(temporary, 'w');
  const hash = createHash('sha256');
  let byteSize = 0;
  let recordCount = 0;
  let firstSortKey: string | null = null;
  let lastSortKey: string | null = null;
  try {
    const base = `SELECT DISTINCT sort_key || mutation_id AS key, sort_key, mutation_json AS value FROM raw_mutation WHERE generation_id=${sql(processing.generationId)} AND partition_id=${partitionId} ORDER BY key`;
    for await (const row of streamRows(connection, base)) {
      const sortKey = stringValue(row.sort_key);
      const line = Buffer.from(`${stringValue(row.value)}\n`);
      if (line.byteLength > processing.budget.maxBufferedBytes) {
        throw new BoundedPipelineBudgetError('Canonical mutation row exceeds byte budget');
      }
      const release = sharedBudget.acquire(1, line.byteLength);
      try {
        await handle.write(line);
        hash.update(line);
      } finally {
        release();
      }
      byteSize += line.byteLength;
      recordCount += 1;
      firstSortKey ??= sortKey;
      lastSortKey = sortKey;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  const digest = hash.digest('hex');
  await rename(temporary, path).catch(async (error: unknown) => {
    if (!(await exists(path))) throw error;
    const existing = await hashFile(path, sharedBudget, processing.budget.maxBufferedBytes);
    if (existing.sha256 !== digest || existing.byteSize !== byteSize) {
      throw new BoundedPipelineIntegrityError(`Mutation partition orphan mismatch: ${partitionId}`);
    }
    await rm(temporary, { force: true });
  });
  return Object.freeze({
    path,
    byteSize,
    sha256: digest,
    recordCount,
    firstSortKey,
    lastSortKey,
  });
}

class DuckCanonicalTransaction implements BoundedCanonicalPartitionTransaction {
  private open = false;
  private entityAppender: DuckDBAppender | null = null;
  private linkAppender: DuckDBAppender | null = null;
  private artifactAppender: DuckDBAppender | null = null;
  public constructor(
    private readonly connection: DuckDBConnection,
    public readonly generationId: string,
    public readonly partitionId: number,
  ) {}

  public async begin(): Promise<void> {
    await this.connection.run('BEGIN TRANSACTION');
    this.entityAppender = await this.connection.createAppender('canonical_entity');
    this.linkAppender = await this.connection.createAppender('canonical_link_candidate');
    this.artifactAppender = await this.connection.createAppender('canonical_artifact_reference');
    this.open = true;
  }

  public claimMutation(mutationId: string, contentSha256: string): Promise<'claimed' | 'replay'> {
    void mutationId;
    void contentSha256;
    // The generation-bound raw spool already enforces and verifies mutation identity/content.
    // A partition transaction is atomic, and finalized partitions are skipped on resume.
    return Promise.resolve('claimed');
  }

  public writeEntity(value: CanonicalEntityAggregate): Promise<void> {
    const body = canonicalJson(value);
    const entity = canonicalJson(value.entity);
    const appender = requiredAppender(this.entityAppender);
    appender.appendVarchar(this.generationId);
    appender.appendInteger(this.partitionId);
    appender.appendVarchar(value.entity.id);
    appender.appendVarchar(value.entity.entityKind);
    appender.appendVarchar(entity);
    appender.appendVarchar(body);
    appender.appendVarchar(sha256(value));
    appender.endRow();
    return Promise.resolve();
  }

  public writeLink(
    value: Parameters<BoundedCanonicalPartitionTransaction['writeLink']>[0],
  ): Promise<void> {
    const appender = requiredAppender(this.linkAppender);
    appender.appendVarchar(this.generationId);
    appender.appendVarchar(value.linkId);
    appender.appendVarchar(canonicalJson(value));
    appender.endRow();
    return Promise.resolve();
  }

  public writeArtifact(
    value: Parameters<BoundedCanonicalPartitionTransaction['writeArtifact']>[0],
  ): Promise<void> {
    const appender = requiredAppender(this.artifactAppender);
    appender.appendVarchar(this.generationId);
    appender.appendVarchar(value.artifactId);
    appender.appendVarchar(canonicalJson(value));
    appender.endRow();
    return Promise.resolve();
  }

  public async finalize(summary: BoundedCanonicalPartitionSummary): Promise<void> {
    this.closeAppenders();
    const body = canonicalJson(summary);
    await this.connection.run(
      `INSERT INTO stage_partition VALUES (${sql(this.generationId)}, 'reduce_canonical', ${this.partitionId}, ${sql(body)}, ${sql(sha256(summary))})`,
    );
    await this.connection.run('COMMIT');
    this.open = false;
  }

  public async abort(): Promise<void> {
    if (!this.open) return;
    this.closeAppenders();
    await this.connection.run('ROLLBACK');
    this.open = false;
  }

  private closeAppenders(): void {
    for (const appender of [this.entityAppender, this.linkAppender, this.artifactAppender]) {
      if (appender !== null) {
        appender.flushSync();
        appender.closeSync();
      }
    }
    this.entityAppender = null;
    this.linkAppender = null;
    this.artifactAppender = null;
  }
}

function requiredAppender(value: DuckDBAppender | null): DuckDBAppender {
  if (value === null)
    throw new BoundedPipelineIntegrityError('Canonical transaction appender is closed');
  return value;
}

async function buildLinkIndex(
  request: BoundedCountyProcessingRequest,
  connection: DuckDBConnection,
  processing: BoundedProcessingInput,
  root: string,
  signal: AbortSignal,
  sharedBudget: ProcessWideBoundedBudget,
): Promise<ImmutableBoundedArtifact> {
  const generationId = processing.generationId;
  const done = await scalarStringOrNull(
    connection,
    `SELECT summary_json AS value FROM stage_partition WHERE generation_id=${sql(generationId)} AND stage='build_link_index' AND partition_id=0`,
  );
  if (done !== null) {
    return materializeStageValueArtifact(
      request,
      connection,
      processing,
      'build_link_index',
      'link-index-summary',
      0,
      root,
      JSON.parse(done),
      sharedBudget,
    );
  }
  let count = 0;
  let geospatialCount = 0;
  await connection.run('BEGIN TRANSACTION');
  const linkableAppender = await connection.createAppender('linkable_entity');
  const authorityAppender = await connection.createAppender('authority_identifier');
  const exactKeyAppender = await connection.createAppender('normalized_exact_key');
  const candidateAppender = await connection.createAppender('candidate_attribute');
  const permitAppender = await connection.createAppender('permit_property_index');
  const geospatialAppender = await connection.createAppender('geospatial_candidate');
  let indexAppendersClosed = false;
  const closeIndexAppenders = (): void => {
    if (indexAppendersClosed) return;
    indexAppendersClosed = true;
    for (const appender of [
      linkableAppender,
      authorityAppender,
      exactKeyAppender,
      candidateAppender,
      permitAppender,
      geospatialAppender,
    ]) {
      appender.flushSync();
      appender.closeSync();
    }
  };
  try {
    for await (const aggregate of streamKeysetJson<CanonicalEntityAggregate>(
      connection,
      `SELECT entity_id AS key, aggregate_json AS value FROM canonical_entity WHERE generation_id=${sql(generationId)}`,
      'key',
    )) {
      signal.throwIfAborted();
      const entity = toLinkable(aggregate.entity);
      linkableAppender.appendVarchar(generationId);
      linkableAppender.appendVarchar(entity.entityId);
      linkableAppender.appendVarchar(entity.entityKind);
      linkableAppender.appendVarchar(normalizeIndexValue(entity.jurisdiction));
      linkableAppender.appendVarchar(entity.evidenceAvailability);
      linkableAppender.appendVarchar(canonicalJson(entity));
      linkableAppender.endRow();
      for (const identifier of entity.identifiers) {
        authorityAppender.appendVarchar(generationId);
        authorityAppender.appendVarchar(entity.entityId);
        authorityAppender.appendVarchar(normalizeIndexValue(identifier.scheme));
        authorityAppender.appendVarchar(normalizeIndexValue(identifier.scope));
        authorityAppender.appendVarchar(normalizeIndexValue(identifier.value));
        authorityAppender.endRow();
      }
      for (const key of entity.normalizedKeys) {
        exactKeyAppender.appendVarchar(generationId);
        exactKeyAppender.appendVarchar(entity.entityId);
        exactKeyAppender.appendVarchar(key.kind);
        exactKeyAppender.appendVarchar(normalizeIndexValue(key.value));
        exactKeyAppender.endRow();
      }
      for (const [name, value] of Object.entries(entity.candidateAttributes)) {
        const normalized = normalizeIndexValue(value);
        candidateAppender.appendVarchar(generationId);
        candidateAppender.appendVarchar(entity.entityId);
        candidateAppender.appendVarchar(name);
        candidateAppender.appendVarchar(normalized);
        candidateAppender.endRow();
        if (name === 'address') {
          const addressNumber = candidateAddressNumber(normalized);
          if (addressNumber !== null) {
            candidateAppender.appendVarchar(generationId);
            candidateAppender.appendVarchar(entity.entityId);
            candidateAppender.appendVarchar('addressNumber');
            candidateAppender.appendVarchar(addressNumber);
            candidateAppender.endRow();
          }
        }
      }
      if (aggregate.entity.entityKind === 'permit') {
        for (const link of aggregate.entity.propertyLinks) {
          permitAppender.appendVarchar(generationId);
          permitAppender.appendVarchar(link.propertyId);
          permitAppender.appendVarchar(aggregate.entity.id);
          permitAppender.endRow();
        }
      }
      const point = representativePoint(aggregate.entity);
      if (point !== null) {
        geospatialAppender.appendVarchar(generationId);
        geospatialAppender.appendVarchar(aggregate.entity.entityKind);
        geospatialAppender.appendVarchar(aggregate.entity.id);
        geospatialAppender.appendDouble(point[0]);
        geospatialAppender.appendDouble(point[1]);
        geospatialAppender.endRow();
        geospatialCount += 1;
      }
      count += 1;
    }
    closeIndexAppenders();
    const summary = {
      stageVersion: 'bounded-link-index-plan-v2',
      generationId,
      entityCount: count,
      geospatialCount,
    };
    await connection.run(
      `INSERT INTO stage_partition VALUES (${sql(generationId)}, 'build_link_index', 0, ${sql(canonicalJson(summary))}, ${sql(sha256(summary))})`,
    );
    await connection.run('COMMIT');
  } catch (error) {
    closeIndexAppenders();
    await connection.run('ROLLBACK');
    throw error;
  }
  const completedSummary = {
    stageVersion: 'bounded-link-index-plan-v2',
    generationId,
    entityCount: count,
    geospatialCount,
  };
  return materializeStageValueArtifact(
    request,
    connection,
    processing,
    'build_link_index',
    'link-index-summary',
    0,
    root,
    completedSummary,
    sharedBudget,
  );
}

function normalizedKeys(entity: CanonicalEntity): readonly NormalizedExactKey[] {
  switch (entity.entityKind) {
    case 'property':
      return [{ kind: 'apn', value: entity.apn }];
    case 'property-unit':
      return entity.assessmentIdentifier === null
        ? []
        : [{ kind: 'address_unit', value: entity.assessmentIdentifier }];
    case 'address':
      return [{ kind: 'address', value: entity.normalized }];
    case 'contractor':
      return [{ kind: 'license', value: entity.licenseNumber }];
    case 'business':
      return [{ kind: 'entity_number', value: entity.entityNumber }];
    case 'ownership-event':
      return entity.recordedDocumentId === null
        ? []
        : [{ kind: 'document_id', value: entity.recordedDocumentId }];
    default:
      return [];
  }
}

function jurisdiction(entity: CanonicalEntity): string {
  return 'jurisdiction' in entity && typeof entity.jurisdiction === 'string'
    ? entity.jurisdiction
    : 'Santa Clara, CA';
}

function toLinkable(entity: CanonicalEntity): LinkableEntity {
  const keys = normalizedKeys(entity);
  const identifiers = keys.map((key) => ({
    scheme:
      key.kind === 'apn'
        ? 'county-parcel-id'
        : key.kind === 'license'
          ? 'cslb-license'
          : key.kind === 'entity_number'
            ? 'ca-sos-entity'
            : key.kind === 'document_id'
              ? 'source-document-id'
              : 'source-address-id',
    value: key.value,
    scope: jurisdiction(entity),
  }));
  const candidateAttributes =
    entity.entityKind === 'address'
      ? { address: entity.normalized, postalCode: entity.postalCode }
      : entity.entityKind === 'contractor' || entity.entityKind === 'business'
        ? { name: entity.legalName }
        : {};
  const parentPropertyId =
    entity.entityKind === 'property-unit' ||
    entity.entityKind === 'ownership-interest' ||
    entity.entityKind === 'ownership-event'
      ? entity.propertyId
      : null;
  return Object.freeze({
    entityId: entity.id,
    entityKind: entity.entityKind,
    jurisdiction: jurisdiction(entity),
    parentPropertyId,
    identifiers: Object.freeze(identifiers),
    normalizedKeys: Object.freeze(keys),
    candidateAttributes: Object.freeze(candidateAttributes),
    evidenceAvailability: entity.sourceIds.length > 0 ? 'complete' : 'blocked',
    visibility: entity.visibility,
    lineage: Object.freeze(
      entity.lineage.map(({ sourceRecord }) => ({
        sourceId: sourceRecord.sourceId,
        snapshotId: sourceRecord.snapshotId,
        artifactId: sourceRecord.artifactId,
        recordKey: sourceRecord.recordKey,
        recordSha256: sourceRecord.recordSha256,
      })),
    ),
  });
}

async function reconcileAll(
  request: BoundedCountyProcessingRequest,
  connection: DuckDBConnection,
  processing: BoundedProcessingInput,
  root: string,
  signal: AbortSignal,
  sharedBudget: ProcessWideBoundedBudget,
  crash: BoundedPipelineProcessorOptions['crash'],
): Promise<readonly BoundedReconciliationSummary[]> {
  const summaries: BoundedReconciliationSummary[] = [];
  for (const [index, relation] of LINK_RELATIONS.entries()) {
    signal.throwIfAborted();
    const prior = await scalarStringOrNull(
      connection,
      `SELECT summary_json AS value FROM stage_partition WHERE generation_id=${sql(processing.generationId)} AND stage='reconcile_links' AND partition_id=${index}`,
    );
    if (prior !== null) {
      const summary = JSON.parse(prior) as BoundedReconciliationSummary;
      summaries.push(summary);
      const artifact = await materializeStageValueArtifact(
        request,
        connection,
        processing,
        'reconcile_links',
        'reconciliation-relation-summary',
        index,
        root,
        summary,
        sharedBudget,
      );
      await commitBoundedUnit(
        request,
        connection,
        processing,
        'reconcile_links',
        index,
        summary.subjects,
        [artifact],
      );
      continue;
    }
    const repository = new DuckReconciliationRepository(connection, processing.generationId, index);
    await repository.begin();
    const summary = await reconcileBoundedRelation({
      generationId: processing.generationId,
      relation,
      budget: processing.budget,
      repository,
      ...Object.freeze({
        // Per-SUBJECT lease, and only one subject is in flight at a time (the linker
        // acquires then releases per subject), so dividing the whole byte budget by the
        // record COUNT is the wrong shape: it yielded 16 MiB / 2048 = 8 KiB, three orders
        // of magnitude below the sibling leases in this same file (maximumMutationBytes
        // 1 MiB, maximumAggregateBytes 8 MiB). Any property carrying a normal number of
        // permit/evidence rows serializes past 8 KiB, so reconcile_links aborted with
        // "Reconciliation subject exceeded its preallocated canonical serialization lease"
        // on real county data while passing on fixtures.
        //
        // Enforcement ceiling only: subjects that already fit are unaffected and produce
        // byte-identical output, so this changes no artifact hash or release identity.
        // Stays <= maxBufferedBytes, as bounded-linker.ts:136 requires.
        maximumCanonicalBytesPerRecord: Math.max(
          1,
          Math.min(1024 * 1024, Math.floor(processing.budget.maxBufferedBytes / 16)),
        ),
      }),
      canonicalSha256: sha256,
      canonicalByteLength: (value) => Buffer.byteLength(canonicalJson(value), 'utf8'),
      sharedBudget,
    });
    summaries.push(summary);
    const artifact = await materializeStageValueArtifact(
      request,
      connection,
      processing,
      'reconcile_links',
      'reconciliation-relation-summary',
      index,
      root,
      summary,
      sharedBudget,
    );
    await commitBoundedUnit(
      request,
      connection,
      processing,
      'reconcile_links',
      index,
      summary.subjects,
      [artifact],
    );
    await crash?.('after_reconciliation_relation', { relation });
  }
  return Object.freeze(summaries);
}

class DuckReconciliationRepository implements BoundedReconciliationRepository {
  private open = false;
  public constructor(
    private readonly connection: DuckDBConnection,
    public readonly generationId: string,
    private readonly relationOrdinal: number,
  ) {}

  public async begin(): Promise<void> {
    this.open = true;
    await Promise.resolve();
  }

  public streamSubjects(relation: LinkRelation): AsyncIterable<LinkableEntity> {
    const policy = policyFor(relation);
    return streamKeysetJson<LinkableEntity>(
      this.connection,
      `SELECT entity_id AS key, linkable_json AS value FROM linkable_entity WHERE generation_id=${sql(this.generationId)} AND entity_kind IN (${policy.subjectKinds.map(sql).join(',')})`,
      'entity_id',
    );
  }

  public streamCandidateTargets(
    relation: LinkRelation,
    subject: LinkableEntity,
    stage: BoundedCandidateStage,
  ): AsyncIterable<LinkableEntity> {
    const policy = policyFor(relation);
    const targetKinds = policy.targetKinds.map(sql).join(',');
    const jurisdictionFilter = policy.requireSameJurisdiction
      ? ` AND entity.jurisdiction_norm=${sql(normalizeIndexValue(subject.jurisdiction))}`
      : '';
    if (stage === 'authoritative_identifier') {
      return streamKeysetJson<LinkableEntity>(
        this.connection,
        `SELECT DISTINCT entity.entity_id AS key, entity.linkable_json AS value FROM authority_identifier subject JOIN authority_identifier target ON target.generation_id=subject.generation_id AND target.scheme=subject.scheme AND target.scope_norm=subject.scope_norm AND target.value_norm=subject.value_norm JOIN linkable_entity entity ON entity.generation_id=target.generation_id AND entity.entity_id=target.entity_id WHERE subject.generation_id=${sql(this.generationId)} AND subject.entity_id=${sql(subject.entityId)} AND subject.scheme IN (${policy.authoritativeSchemes.map((value) => sql(normalizeIndexValue(value))).join(',') || "''"}) AND entity.entity_kind IN (${targetKinds}) AND entity.evidence_availability<>'blocked'${jurisdictionFilter}`,
        'entity.entity_id',
      );
    }
    if (stage === 'normalized_exact') {
      return streamKeysetJson<LinkableEntity>(
        this.connection,
        `SELECT DISTINCT entity.entity_id AS key, entity.linkable_json AS value FROM normalized_exact_key subject JOIN normalized_exact_key target ON target.generation_id=subject.generation_id AND target.key_kind=subject.key_kind AND target.value_norm=subject.value_norm JOIN linkable_entity entity ON entity.generation_id=target.generation_id AND entity.entity_id=target.entity_id WHERE subject.generation_id=${sql(this.generationId)} AND subject.entity_id=${sql(subject.entityId)} AND subject.key_kind IN (${policy.normalizedKeyKinds.map(sql).join(',') || "''"}) AND entity.entity_kind IN (${targetKinds}) AND entity.evidence_availability<>'blocked'${jurisdictionFilter}`,
        'entity.entity_id',
      );
    }
    const postal =
      policy.candidateFields.postalCode === undefined ||
      subject.candidateAttributes.postalCode === undefined
        ? null
        : normalizeIndexValue(subject.candidateAttributes.postalCode);
    const addressNumber =
      policy.candidateFields.address === undefined ||
      subject.candidateAttributes.address === undefined
        ? null
        : candidateAddressNumber(normalizeIndexValue(subject.candidateAttributes.address));
    return streamKeysetJson<LinkableEntity>(
      this.connection,
      `SELECT DISTINCT entity.entity_id AS key, entity.linkable_json AS value FROM linkable_entity entity LEFT JOIN candidate_attribute postal ON postal.generation_id=entity.generation_id AND postal.entity_id=entity.entity_id AND postal.attribute_name='postalCode' LEFT JOIN candidate_attribute address_number ON address_number.generation_id=entity.generation_id AND address_number.entity_id=entity.entity_id AND address_number.attribute_name='addressNumber' WHERE entity.generation_id=${sql(this.generationId)} AND entity.entity_kind IN (${targetKinds}) AND entity.evidence_availability<>'blocked'${jurisdictionFilter} AND (${postal === null ? 'TRUE' : `postal.value_norm IS NULL OR postal.value_norm=${sql(postal)}`}) AND (${addressNumber === null ? 'TRUE' : `address_number.value_norm IS NULL OR address_number.value_norm=${sql(addressNumber)}`})`,
      'entity.entity_id',
      policy.maxCandidatePool + 1,
    );
  }

  public streamReviews(): AsyncIterable<ReviewDecision> {
    return emptyAsync();
  }

  public streamDuplicateMembers(relation: LinkRelation): AsyncIterable<BoundedDuplicateMember> {
    const policy = policyFor(relation);
    const kinds = [...new Set([...policy.subjectKinds, ...policy.targetKinds])].map(sql).join(',');
    const base = `SELECT hex(classification) || ':' || hex(duplicate_key) || ':' || lpad(CAST(ordinal AS VARCHAR),12,'0') || ':' || hex(entity_id) AS key, to_json(struct_pack(classification := classification, key := duplicate_key, entityId := entity_id, ordinal := ordinal)) AS value FROM (
      SELECT 'shared_normalized_key' AS classification, key_kind || ':' || value_norm AS duplicate_key, keys.entity_id,
        row_number() OVER (PARTITION BY key_kind, value_norm ORDER BY keys.entity_id)-1 AS ordinal,
        count(*) OVER (PARTITION BY key_kind, value_norm) AS member_count
      FROM normalized_exact_key keys JOIN linkable_entity entity ON entity.generation_id=keys.generation_id AND entity.entity_id=keys.entity_id
      WHERE keys.generation_id=${sql(this.generationId)} AND entity.entity_kind IN (${kinds})
    ) WHERE member_count > 1`;
    return streamKeysetJson<BoundedDuplicateMember>(this.connection, base, 'key');
  }

  public async beginSubject(
    relation: LinkRelation,
    subjectEntityId: string,
    contentSha256: string,
  ): Promise<BoundedReconciliationSubjectClaim> {
    await this.connection.run('BEGIN TRANSACTION');
    let existing: Awaited<ReturnType<typeof scalarRow>>;
    try {
      existing = await scalarRow(
        this.connection,
        `SELECT claim.content_sha256, claim.claim_state, resolution.resolution_sha256 FROM reconciliation_claim claim LEFT JOIN link_resolution resolution ON resolution.generation_id=claim.generation_id AND resolution.relation=claim.relation AND resolution.subject_entity_id=claim.subject_entity_id WHERE claim.generation_id=${sql(this.generationId)} AND claim.relation=${sql(relation)} AND claim.subject_entity_id=${sql(subjectEntityId)}`,
      );
      if (existing !== null && stringValue(existing.content_sha256) !== contentSha256) {
        throw new BoundedPipelineIntegrityError(
          `Reconciliation subject collision: ${relation}/${subjectEntityId}`,
        );
      }
      if (existing !== null && existing.resolution_sha256 !== null) {
        if (stringValue(existing.claim_state) !== 'completed') {
          throw new BoundedPipelineIntegrityError(
            'Reconciliation resolution exists without a completed claim',
          );
        }
        await this.connection.run('COMMIT');
        return Object.freeze({ state: 'replay_completed' as const });
      }
      if (existing === null) {
        const claimed = await scalarRow(
          this.connection,
          `INSERT INTO reconciliation_claim (generation_id, relation, subject_entity_id, content_sha256, claim_state) VALUES (${sql(this.generationId)}, ${sql(relation)}, ${sql(subjectEntityId)}, ${sql(contentSha256)}, 'claimed') RETURNING generation_id, relation, subject_entity_id, content_sha256, claim_state`,
        );
        assertReconciliationClaimRow(
          claimed,
          this.generationId,
          relation,
          subjectEntityId,
          contentSha256,
          'claimed',
        );
      }
      await this.connection.run('COMMIT');
    } catch (error) {
      await this.connection.run('ROLLBACK');
      throw error;
    }
    const state =
      existing === null ? ('claimed' as const) : ('recovered_incomplete_claim' as const);
    return Object.freeze({
      state,
      commit: async (value: LinkResolution): Promise<'committed' | 'replay'> => {
        if (value.subjectEntityId !== subjectEntityId) {
          throw new BoundedPipelineIntegrityError('Reconciliation transaction subject changed');
        }
        const body = canonicalJson(value);
        const digest = sha256(value);
        await this.connection.run('BEGIN TRANSACTION');
        try {
          const durable = await scalarRow(
            this.connection,
            `SELECT claim.content_sha256, claim.claim_state, resolution.resolution_sha256 FROM reconciliation_claim claim LEFT JOIN link_resolution resolution ON resolution.generation_id=claim.generation_id AND resolution.relation=claim.relation AND resolution.subject_entity_id=claim.subject_entity_id WHERE claim.generation_id=${sql(this.generationId)} AND claim.relation=${sql(relation)} AND claim.subject_entity_id=${sql(subjectEntityId)}`,
          );
          if (durable === null || stringValue(durable.content_sha256) !== contentSha256) {
            throw new BoundedPipelineIntegrityError('Reconciliation durable claim changed');
          }
          if (durable.resolution_sha256 !== null) {
            if (
              stringValue(durable.resolution_sha256) !== digest ||
              stringValue(durable.claim_state) !== 'completed'
            ) {
              throw new BoundedPipelineIntegrityError('Reconciliation replay resolution changed');
            }
            await this.connection.run('COMMIT');
            return 'replay';
          }
          const inserted = await scalarRow(
            this.connection,
            `INSERT INTO link_resolution VALUES (${sql(this.generationId)}, ${sql(relation)}, ${sql(subjectEntityId)}, ${sql(body)}, ${sql(digest)}) RETURNING generation_id, relation, subject_entity_id, resolution_sha256`,
          );
          if (
            inserted?.generation_id !== this.generationId ||
            inserted.relation !== relation ||
            inserted.subject_entity_id !== subjectEntityId ||
            inserted.resolution_sha256 !== digest
          ) {
            throw new BoundedPipelineIntegrityError('Reconciliation resolution row effect changed');
          }
          const completed = await scalarRow(
            this.connection,
            `UPDATE reconciliation_claim SET claim_state='completed' WHERE generation_id=${sql(this.generationId)} AND relation=${sql(relation)} AND subject_entity_id=${sql(subjectEntityId)} AND content_sha256=${sql(contentSha256)} AND claim_state='claimed' RETURNING generation_id, relation, subject_entity_id, content_sha256, claim_state`,
          );
          assertReconciliationClaimRow(
            completed,
            this.generationId,
            relation,
            subjectEntityId,
            contentSha256,
            'completed',
          );
          await this.connection.run('COMMIT');
          return 'committed';
        } catch (error) {
          await this.connection.run('ROLLBACK');
          throw error;
        }
      },
      abort: () => Promise.resolve(),
    });
  }

  public async writeDuplicateMember(
    relation: LinkRelation,
    value: BoundedDuplicateMember,
  ): Promise<void> {
    await this.connection.run(
      `INSERT INTO duplicate_member VALUES (${sql(this.generationId)}, ${sql(relation)}, ${sql(value.classification)}, ${sql(value.key)}, ${sql(value.entityId)}, ${value.ordinal}) ON CONFLICT DO NOTHING`,
    );
  }

  public async finalizeRelation(
    relation: LinkRelation,
    summary: BoundedReconciliationSummary,
  ): Promise<void> {
    const body = canonicalJson(summary);
    await this.connection.run(
      `INSERT INTO stage_partition VALUES (${sql(this.generationId)}, 'reconcile_links', ${this.relationOrdinal}, ${sql(body)}, ${sql(sha256(summary))})`,
    );
    this.open = false;
  }

  public abortRelation(): Promise<void> {
    if (!this.open) return Promise.resolve();
    this.open = false;
    return Promise.resolve();
  }
}

function assertReconciliationClaimRow(
  row: Readonly<Record<string, unknown>> | null,
  generationId: string,
  relation: LinkRelation,
  subjectEntityId: string,
  contentSha256: string,
  state: 'claimed' | 'completed',
): void {
  if (
    row?.generation_id !== generationId ||
    row.relation !== relation ||
    row.subject_entity_id !== subjectEntityId ||
    row.content_sha256 !== contentSha256 ||
    row.claim_state !== state
  ) {
    throw new BoundedPipelineIntegrityError('Reconciliation claim row effect changed');
  }
}

type ProxyCandidate = Readonly<{
  aggregate: CanonicalEntityAggregate;
  coordinates: readonly [number, number];
}>;
type RoofWork = Parameters<typeof deriveRoofAge>[0] &
  Readonly<{
    propertyPoint: PropertyPoint | null;
    proxyCandidates: Readonly<
      Partial<
        Record<
          'water_view_candidate' | 'transit_walkability' | 'starbucks_walkability',
          ProxyCandidate
        >
      >
    >;
  }>;
type RoofEvidence = ReturnType<typeof deriveRoofAge>;

type FeatureStageOutput = Readonly<{
  logicalSha256: string;
  propertyCount: number;
  evidenceCount: number;
  artifactCount: number;
}>;

async function deriveFeatures(
  request: BoundedCountyProcessingRequest,
  connection: DuckDBConnection,
  processing: BoundedProcessingInput,
  root: string,
  signal: AbortSignal,
  sharedBudget: ProcessWideBoundedBudget,
  crash: BoundedPipelineProcessorOptions['crash'],
): Promise<FeatureStageOutput> {
  const aggregateHash = createHash('sha256');
  let propertyCount = 0;
  let evidenceCount = 0;
  let artifactCount = 0;
  const featureRoot = join(root, 'features');
  await mkdir(featureRoot, { recursive: true });
  await materializeFeatureProxyCandidates(connection, processing);
  for (
    let partitionId = 0;
    partitionId < processing.partitionPlan.partitionCount;
    partitionId += 1
  ) {
    signal.throwIfAborted();
    const checkpointText = await scalarStringOrNull(
      connection,
      `SELECT summary_json AS value FROM stage_partition WHERE generation_id=${sql(processing.generationId)} AND stage='derive_features' AND partition_id=${partitionId}`,
    );
    const resume =
      checkpointText === null
        ? undefined
        : (JSON.parse(checkpointText) as BoundedFeatureDurableCheckpoint);
    if (resume !== undefined) {
      const file = await hashFile(
        artifactPath(request.artifactStore, resume.lastArtifact),
        sharedBudget,
        processing.budget.maxBufferedBytes,
      );
      if (
        file.sha256 !== resume.lastArtifact.sha256 ||
        file.byteSize !== resume.lastArtifact.byteSize
      ) {
        throw new BoundedPipelineIntegrityError(
          `Feature durable artifact is corrupt: ${partitionId}/${resume.lastArtifact.sequence}`,
        );
      }
      const durableArtifacts = await stageArtifacts(
        connection,
        processing.generationId,
        'derive_features',
        partitionId,
        BOUNDED_MAX_STAGE_ARTIFACTS,
      );
      await commitBoundedUnit(
        request,
        connection,
        processing,
        'derive_features',
        partitionId,
        resume.outputRecordCount,
        durableArtifacts,
      );
    }
    await materializeFeatureInputSpool(
      connection,
      processing,
      partitionId,
      request.sources,
      sharedBudget,
    );
    const initialOrdinal = resume?.nextInputOrdinal ?? 0;
    const featureInputPath = await materializeFeatureValueFile(
      connection,
      processing,
      featureRoot,
      partitionId,
      initialOrdinal,
      sharedBudget,
    );
    const cursor = new RoofFeatureCursor(
      connection,
      processing.generationId,
      partitionId,
      initialOrdinal,
      resume?.lastInputSortKey ?? null,
      featureInputPath,
      Math.max(1, Math.floor(processing.budget.maxBufferedBytes / 4)),
    );
    const store = new FileFeatureChunkStore(
      request,
      featureRoot,
      sharedBudget,
      processing.budget.maxBufferedBytes,
    );
    const result = await runBoundedFeaturePartition<RoofWork, FeatureBundle>(
      {
        generationId: processing.generationId,
        partitionId,
        dataset: 'property_feature_evidence',
        artifactLogicalPrefix: `bf/${generationPath(processing.generationId)}`,
        inputManifestSha256: processing.logicalOutputIdentitySha256,
        outputSchemaSha256: FEATURE_BUNDLE_SCHEMA_SHA256,
        sourceLineageSha256: processing.sourceManifestSha256,
        licenseIdentitySha256: sha256(mutationLicenseSnapshotRefs(processing)),
        budget: processing.budget,
        ...Object.freeze({
          maxInputBytesPerRecord: Math.max(1, Math.floor(processing.budget.maxBufferedBytes / 4)),
        }),
        maxOutputBytesPerRecord: Math.min(
          processing.budget.maxBytesPerOutputChunk,
          Math.max(1, Math.floor(processing.budget.maxBufferedBytes / 2)),
        ),
        cursor,
        store,
        derive: (work): Promise<BoundedFeatureOutput<FeatureBundle>> => {
          const bundle = countyFeatureBundle(work, deriveRoofAge(work), request.sources);
          return Promise.resolve(
            Object.freeze({
              sortKey: bundle.propertyId,
              visibility: 'mixed_internal',
              value: bundle,
            }),
          );
        },
        persistCheckpoint: async (checkpoint) => {
          const body = canonicalJson(checkpoint);
          await connection.run(
            `INSERT INTO stage_partition VALUES (${sql(processing.generationId)}, 'derive_features', ${partitionId}, ${sql(body)}, ${sql(sha256(checkpoint))}) ON CONFLICT DO UPDATE SET summary_json=excluded.summary_json, summary_sha256=excluded.summary_sha256`,
          );
          const artifacts = await stageArtifacts(
            connection,
            processing.generationId,
            'derive_features',
            partitionId,
            BOUNDED_MAX_STAGE_ARTIFACTS,
          );
          await commitBoundedUnit(
            request,
            connection,
            processing,
            'derive_features',
            partitionId,
            checkpoint.outputRecordCount,
            artifacts,
          );
        },
        recordArtifact: async (artifact) => {
          await connection.run(
            `INSERT INTO feature_artifact VALUES (${sql(processing.generationId)}, ${partitionId}, ${artifact.sequence}, ${sql(canonicalJson(artifact))}) ON CONFLICT DO UPDATE SET artifact_json=excluded.artifact_json`,
          );
          await recordStageArtifact(connection, artifact);
          await commitFeatureOrphan(request, connection, processing, artifact);
          await crash?.('after_feature_chunk', { partitionId, sequence: artifact.sequence });
        },
        ...(resume === undefined ? {} : { resume }),
      },
      sharedBudget,
    );
    propertyCount += result.outputRecordCount;
    evidenceCount += result.outputRecordCount * FEATURE_KINDS.length;
  }
  for await (const artifact of streamKeysetJson<ImmutableBoundedArtifact>(
    connection,
    `SELECT lpad(CAST(partition_id AS VARCHAR),12,'0') || lpad(CAST(sequence AS VARCHAR),12,'0') AS key, artifact_json AS value FROM feature_artifact WHERE generation_id=${sql(processing.generationId)}`,
    'key',
  )) {
    aggregateHash.update(`${artifact.logicalKey}\0${artifact.sha256}\n`);
    artifactCount += 1;
  }
  return Object.freeze({
    logicalSha256: aggregateHash.digest('hex'),
    propertyCount,
    evidenceCount,
    artifactCount,
  });
}

async function materializeFeatureProxyCandidates(
  connection: DuckDBConnection,
  processing: BoundedProcessingInput,
): Promise<void> {
  const marker = await scalarStringOrNull(
    connection,
    `SELECT CAST(candidate_count AS VARCHAR) AS value FROM feature_proxy_candidate_state WHERE generation_id=${sql(processing.generationId)}`,
  );
  if (marker !== null) return;
  const available = await scalarCount(
    connection,
    `SELECT count(*)::BIGINT AS value FROM geospatial_candidate WHERE generation_id=${sql(processing.generationId)} AND entity_kind IN ('hydro-feature','transit-stop','place')`,
  );
  await connection.run('BEGIN TRANSACTION');
  try {
    if (available > 0) {
      for (const specification of [
        { feature: 'water_view_candidate', entityKind: 'hydro-feature', predicate: '' },
        { feature: 'transit_walkability', entityKind: 'transit-stop', predicate: '' },
        {
          feature: 'starbucks_walkability',
          entityKind: 'place',
          predicate:
            " AND (lower(entity.entity_json) LIKE '%starbucks%' OR lower(entity.entity_json) LIKE '%sbux%')",
        },
      ] as const) {
        await connection.run(
          `INSERT INTO feature_proxy_candidate SELECT generation_id, property_id, feature, aggregate_json, longitude, latitude FROM (SELECT property.generation_id, property.entity_id AS property_id, ${sql(specification.feature)} AS feature, entity.aggregate_json, candidate.longitude, candidate.latitude, row_number() OVER (PARTITION BY property.entity_id ORDER BY ((candidate.longitude-property_point.longitude)*(candidate.longitude-property_point.longitude)+(candidate.latitude-property_point.latitude)*(candidate.latitude-property_point.latitude)), candidate.entity_id) AS candidate_rank FROM canonical_entity property JOIN geospatial_candidate property_point ON property_point.generation_id=property.generation_id AND property_point.entity_id=coalesce(json_extract_string(property.entity_json,'$.primaryAddressId'), property.entity_id) JOIN geospatial_candidate candidate ON candidate.generation_id=property.generation_id AND candidate.entity_kind=${sql(specification.entityKind)} AND candidate.longitude BETWEEN property_point.longitude-0.5 AND property_point.longitude+0.5 AND candidate.latitude BETWEEN property_point.latitude-0.5 AND property_point.latitude+0.5 JOIN canonical_entity entity ON entity.generation_id=candidate.generation_id AND entity.entity_id=candidate.entity_id WHERE property.generation_id=${sql(processing.generationId)} AND property.entity_kind='property'${specification.predicate}) ranked WHERE candidate_rank=1`,
        );
      }
    }
    const selected = await scalarCount(
      connection,
      `SELECT count(*)::BIGINT AS value FROM feature_proxy_candidate WHERE generation_id=${sql(processing.generationId)}`,
    );
    await connection.run(
      `INSERT INTO feature_proxy_candidate_state VALUES (${sql(processing.generationId)}, ${selected})`,
    );
    await connection.run('COMMIT');
  } catch (error) {
    await connection.run('ROLLBACK');
    throw error;
  }
}

async function materializeFeatureValueFile(
  connection: DuckDBConnection,
  processing: BoundedProcessingInput,
  root: string,
  partitionId: number,
  initialOrdinal: number,
  sharedBudget: ProcessWideBoundedBudget,
): Promise<string> {
  const directory = confinedChild(root, 'input-spool');
  await mkdir(directory, { recursive: true });
  const path = confinedChild(
    directory,
    `${partitionId.toString().padStart(6, '0')}-${initialOrdinal}.ndjson`,
  );
  const temporary = `${path}.partial`;
  const handle = await open(temporary, 'w');
  const hash = createHash('sha256');
  let byteSize = 0;
  try {
    for await (const row of streamRows(
      connection,
      `SELECT work_json FROM feature_input_spool WHERE generation_id=${sql(processing.generationId)} AND partition_id=${partitionId} AND ordinal>=${initialOrdinal} ORDER BY ordinal`,
    )) {
      const line = Buffer.from(`${stringValue(row.work_json)}\n`, 'utf8');
      if (line.byteLength > processing.budget.maxBufferedBytes) {
        throw new BoundedPipelineBudgetError('Feature value spool row exceeds byte budget');
      }
      const release = sharedBudget.acquire(1, line.byteLength);
      try {
        await handle.write(line);
        hash.update(line);
        byteSize += line.byteLength;
      } finally {
        release();
      }
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await adoptLocalFile(
    temporary,
    path,
    hash.digest('hex'),
    byteSize,
    sharedBudget,
    processing.budget.maxBufferedBytes,
  );
  await connection.run(
    `INSERT INTO feature_input_cursor SELECT generation_id, partition_id, ordinal, hex(sort_key), content_sha256 FROM feature_input_spool WHERE generation_id=${sql(processing.generationId)} AND partition_id=${partitionId} ON CONFLICT DO NOTHING`,
  );
  return path;
}

async function materializeFeatureInputSpool(
  connection: DuckDBConnection,
  processing: BoundedProcessingInput,
  partitionId: number,
  sources: readonly SourceExecutionManifest[],
  sharedBudget: ProcessWideBoundedBudget,
): Promise<void> {
  const marker = await scalarRow(
    connection,
    `SELECT record_count, logical_sha256 FROM feature_input_spool_state WHERE generation_id=${sql(processing.generationId)} AND partition_id=${partitionId}`,
  );
  const propertyCount = await scalarCount(
    connection,
    `SELECT count(*)::BIGINT AS value FROM canonical_entity WHERE generation_id=${sql(processing.generationId)} AND partition_id=${partitionId} AND entity_kind='property'`,
  );
  if (marker !== null) {
    const spooled = await scalarCount(
      connection,
      `SELECT count(*)::BIGINT AS value FROM feature_input_spool WHERE generation_id=${sql(processing.generationId)} AND partition_id=${partitionId}`,
    );
    if (numberValue(marker.record_count) !== propertyCount || spooled !== propertyCount) {
      throw new BoundedPipelineIntegrityError(
        `Feature input spool marker changed for partition ${partitionId}`,
      );
    }
    return;
  }
  const durable = await scalarRow(
    connection,
    `SELECT count(*)::BIGINT AS record_count, max(ordinal)::BIGINT AS last_ordinal, max(entity_id) AS last_entity_id FROM feature_input_spool WHERE generation_id=${sql(processing.generationId)} AND partition_id=${partitionId}`,
  );
  let ordinal = numberValue(durable?.record_count ?? 0);
  const lastOrdinal = durable?.last_ordinal;
  if (ordinal > 0 && numberValue(lastOrdinal) !== ordinal - 1) {
    throw new BoundedPipelineIntegrityError(
      `Feature input spool is not contiguous: ${partitionId}`,
    );
  }
  let lastEntityId =
    durable?.last_entity_id === null || durable?.last_entity_id === undefined
      ? ''
      : stringValue(durable.last_entity_id);
  const logical = createHash('sha256');
  let expectedOrdinal = 0;
  for await (const row of streamRows(
    connection,
    `SELECT ordinal, sort_key, byte_size, content_sha256 FROM feature_input_spool WHERE generation_id=${sql(processing.generationId)} AND partition_id=${partitionId} ORDER BY ordinal`,
  )) {
    const actualOrdinal = numberValue(row.ordinal);
    if (actualOrdinal !== expectedOrdinal) {
      throw new BoundedPipelineIntegrityError(
        `Feature input spool has an ordinal gap: ${partitionId}`,
      );
    }
    logical.update(
      `${actualOrdinal}\0${stringValue(row.sort_key)}\0${numberValue(row.byte_size)}\0${stringValue(row.content_sha256)}\n`,
    );
    expectedOrdinal += 1;
  }
  const appender = await connection.createAppender('feature_input_spool');
  let currentPropertyId: string | null = null;
  let currentProperty: CanonicalEntityAggregate | null = null;
  let currentAddress: CanonicalEntityAggregate | null = null;
  let currentCandidates: RoofWork['proxyCandidates'] = Object.freeze({});
  let currentPermits: RoofPermitObservation[] = [];
  const flush = (): void => {
    if (currentPropertyId === null || currentProperty === null) return;
    const work = roofFeatureWork(
      currentProperty,
      currentAddress,
      currentCandidates,
      currentPermits,
      sources,
    );
    const body = canonicalJson(work);
    const byteSize = Buffer.byteLength(body, 'utf8');
    if (byteSize > processing.budget.maxBufferedBytes) {
      throw new BoundedPipelineBudgetError(
        `Property ${currentPropertyId} feature input exceeds the shared byte budget`,
      );
    }
    const release = sharedBudget.acquire(1, byteSize);
    try {
      const sortKey = `${currentPropertyId}:roof_age`;
      const contentSha256 = boundedFeatureValueSha256(work);
      appender.appendVarchar(processing.generationId);
      appender.appendInteger(partitionId);
      appender.appendBigInt(BigInt(ordinal));
      appender.appendVarchar(currentPropertyId);
      appender.appendVarchar(sortKey);
      appender.appendBigInt(BigInt(byteSize));
      appender.appendVarchar(contentSha256);
      appender.appendVarchar(body);
      appender.endRow();
      logical.update(`${ordinal}\0${sortKey}\0${byteSize}\0${contentSha256}\n`);
      ordinal += 1;
      lastEntityId = currentPropertyId;
    } finally {
      release();
    }
  };
  try {
    for await (const row of streamRows(
      connection,
      `SELECT property.entity_id, property.aggregate_json, address.aggregate_json AS address_json, permit.entity_id AS permit_id, permit.aggregate_json AS permit_json, water.aggregate_json AS water_json, water.longitude AS water_longitude, water.latitude AS water_latitude, transit.aggregate_json AS transit_json, transit.longitude AS transit_longitude, transit.latitude AS transit_latitude, coffee.aggregate_json AS coffee_json, coffee.longitude AS coffee_longitude, coffee.latitude AS coffee_latitude FROM canonical_entity property LEFT JOIN canonical_entity address ON address.generation_id=property.generation_id AND address.entity_id=json_extract_string(property.entity_json,'$.primaryAddressId') AND address.entity_kind='address' LEFT JOIN feature_proxy_candidate water ON water.generation_id=property.generation_id AND water.property_id=property.entity_id AND water.feature='water_view_candidate' LEFT JOIN feature_proxy_candidate transit ON transit.generation_id=property.generation_id AND transit.property_id=property.entity_id AND transit.feature='transit_walkability' LEFT JOIN feature_proxy_candidate coffee ON coffee.generation_id=property.generation_id AND coffee.property_id=property.entity_id AND coffee.feature='starbucks_walkability' LEFT JOIN permit_property_index idx ON idx.generation_id=property.generation_id AND idx.property_id=property.entity_id LEFT JOIN canonical_entity permit ON permit.generation_id=idx.generation_id AND permit.entity_id=idx.permit_id WHERE property.generation_id=${sql(processing.generationId)} AND property.partition_id=${partitionId} AND property.entity_kind='property' AND property.entity_id>${sql(lastEntityId)} ORDER BY property.entity_id, permit.entity_id`,
    )) {
      const entityId = stringValue(row.entity_id);
      if (currentPropertyId !== entityId) {
        flush();
        currentPropertyId = entityId;
        currentProperty = JSON.parse(stringValue(row.aggregate_json)) as CanonicalEntityAggregate;
        currentAddress =
          row.address_json === null || row.address_json === undefined
            ? null
            : (JSON.parse(stringValue(row.address_json)) as CanonicalEntityAggregate);
        currentCandidates = Object.freeze({
          ...proxyCandidateFromRow(row, 'water'),
          ...proxyCandidateFromRow(row, 'transit'),
          ...proxyCandidateFromRow(row, 'coffee'),
        });
        currentPermits = [];
      }
      if (row.permit_id !== null && row.permit_id !== undefined) {
        const permitAggregate = JSON.parse(
          stringValue(row.permit_json),
        ) as CanonicalEntityAggregate;
        currentPermits.push(...permitObservations(permitAggregate));
      }
    }
    flush();
  } finally {
    appender.flushSync();
    appender.closeSync();
  }
  if (ordinal !== propertyCount) {
    throw new BoundedPipelineIntegrityError(
      `Feature input spool count differs from canonical properties: ${partitionId}`,
    );
  }
  await connection.run(
    `INSERT INTO feature_input_spool_state VALUES (${sql(processing.generationId)}, ${partitionId}, ${ordinal}, ${sql(logical.digest('hex'))})`,
  );
}

function roofFeatureWork(
  aggregate: CanonicalEntityAggregate,
  address: CanonicalEntityAggregate | null,
  proxyCandidates: RoofWork['proxyCandidates'],
  permits: readonly RoofPermitObservation[],
  sources: readonly SourceExecutionManifest[],
): RoofWork {
  if (aggregate.entity.entityKind !== 'property') {
    throw new BoundedPipelineIntegrityError('Property spool returned a non-property aggregate');
  }
  const property = aggregate.entity;
  return Object.freeze({
    propertyId: property.id,
    asOf: property.recordedAt,
    permits: Object.freeze(permits),
    buildingAge: buildingAgeObservations(aggregate),
    permitCoverage: permitCoverage(property, permits, sources),
    propertyPoint: propertyPointFromAggregates(aggregate, address),
    proxyCandidates,
  });
}

function proxyCandidateFromRow(
  row: Readonly<Record<string, unknown>>,
  prefix: 'water' | 'transit' | 'coffee',
): Readonly<Partial<RoofWork['proxyCandidates']>> {
  const body = row[`${prefix}_json`];
  if (body === null || body === undefined) return Object.freeze({});
  const candidate = Object.freeze({
    aggregate: JSON.parse(stringValue(body)) as CanonicalEntityAggregate,
    coordinates: Object.freeze([
      finiteNumberValue(row[`${prefix}_longitude`]),
      finiteNumberValue(row[`${prefix}_latitude`]),
    ] as const),
  });
  return prefix === 'water'
    ? Object.freeze({ water_view_candidate: candidate })
    : prefix === 'transit'
      ? Object.freeze({ transit_walkability: candidate })
      : Object.freeze({ starbucks_walkability: candidate });
}

class RoofFeatureCursor implements BoundedFeatureCursor<RoofWork> {
  private ordinal: number;
  private lastSortKey: string | null;
  private closed = false;
  private metadata: AsyncIterator<Readonly<Record<string, unknown>>> | null = null;
  private values: AsyncIterator<unknown> | null = null;
  private preview: Omit<BoundedFeatureInput<RoofWork>, 'value'> | null | undefined;

  public constructor(
    private readonly connection: DuckDBConnection,
    private readonly generationId: string,
    private readonly partitionId: number,
    initialOrdinal: number,
    lastSortKey: string | null,
    private readonly valuePath: string,
    private readonly maximumValueBytes: number,
  ) {
    this.ordinal = initialOrdinal;
    this.lastSortKey = lastSortKey;
  }

  public async peek(): Promise<Omit<BoundedFeatureInput<RoofWork>, 'value'> | null> {
    if (this.closed) throw new Error('Feature cursor is closed');
    if (this.preview !== undefined) return this.preview;
    this.metadata ??= streamRows(
      this.connection,
      `SELECT ordinal, sort_key, byte_size, content_sha256 FROM feature_input_spool WHERE generation_id=${sql(this.generationId)} AND partition_id=${this.partitionId} AND ordinal>=${this.ordinal} ORDER BY ordinal`,
    )[Symbol.asyncIterator]();
    const next = await this.metadata.next();
    if (next.done) {
      this.preview = null;
      return null;
    }
    const row = next.value;
    if (numberValue(row.ordinal) !== this.ordinal) {
      throw new BoundedPipelineIntegrityError('Feature spool ordinal changed across resume');
    }
    const sortKey = stringValue(row.sort_key);
    if (this.lastSortKey !== null && compareUtf8(this.lastSortKey, sortKey) >= 0) {
      throw new BoundedPipelineIntegrityError('Feature spool order changed across resume');
    }
    this.preview = Object.freeze({
      partitionId: this.partitionId,
      ordinal: this.ordinal,
      sortKey,
      byteSize: numberValue(row.byte_size),
      contentSha256: stringValue(row.content_sha256),
    });
    return this.preview;
  }

  public async next(): Promise<BoundedFeatureInput<RoofWork> | null> {
    if (this.closed) throw new Error('Feature cursor is closed');
    const preview = await this.peek();
    if (preview === null) return null;
    this.values ??= readReservedNdjsonFile(this.valuePath, this.maximumValueBytes)[
      Symbol.asyncIterator
    ]();
    const value = await this.values.next();
    if (value.done) throw new BoundedPipelineIntegrityError('Feature spool value disappeared');
    const work = value.value as RoofWork;
    const body = canonicalJson(work);
    if (
      Buffer.byteLength(body, 'utf8') !== preview.byteSize ||
      boundedFeatureValueSha256(work) !== preview.contentSha256
    ) {
      throw new BoundedPipelineIntegrityError('Feature spool value differs from metadata peek');
    }
    const result = Object.freeze({
      ...preview,
      value: work,
    });
    this.ordinal += 1;
    this.lastSortKey = preview.sortKey;
    this.preview = undefined;
    return result;
  }

  public close(): Promise<void> {
    this.closed = true;
    return Promise.all([this.metadata?.return?.(), this.values?.return?.()]).then(() => undefined);
  }
}

function permitObservations(aggregate: CanonicalEntityAggregate): readonly RoofPermitObservation[] {
  if (aggregate.entity.entityKind !== 'permit') return Object.freeze([]);
  const entity = aggregate.entity;
  const observations = aggregate.observations.filter(({ fieldPath }) =>
    ['/permitType', '/description', '/status', '/issuedAt', '/completedAt'].includes(fieldPath),
  );
  return Object.freeze(
    observations.map((observation) =>
      Object.freeze({
        ...sourceObservation(observation, 'permit'),
        permitId: entity.id,
        permitType: entity.permitType,
        description: entity.description,
        status: entity.status,
        issuedAt: entity.issuedAt,
        completedAt: entity.completedAt,
      }),
    ),
  );
}

function buildingAgeObservations(
  aggregate: CanonicalEntityAggregate,
): readonly BuildingAgeObservation[] {
  const entity = aggregate.entity;
  if (entity.entityKind !== 'property') return Object.freeze([]);
  return Object.freeze(
    aggregate.observations
      .filter(({ fieldPath }) => fieldPath === '/yearBuilt' || fieldPath === '/effectiveYearBuilt')
      .map((observation) =>
        Object.freeze({
          ...sourceObservation(observation, 'building-age'),
          yearBuilt:
            observation.fieldPath === '/yearBuilt' && typeof observation.value === 'number'
              ? observation.value
              : null,
          effectiveYearBuilt:
            observation.fieldPath === '/effectiveYearBuilt' && typeof observation.value === 'number'
              ? observation.value
              : null,
        }),
      ),
  );
}

function permitCoverage(
  property: Extract<CanonicalEntity, { entityKind: 'property' }>,
  permits: readonly RoofPermitObservation[],
  sources: readonly SourceExecutionManifest[],
): RoofWork['permitCoverage'] {
  const permitSources = sources.filter(({ capability }) => capability.includes('permit'));
  const actualSourceIds = [...new Set(permits.map(({ reference }) => reference.sourceId))].sort(
    compareUtf8,
  );
  const blocked =
    permitSources.length > 0 &&
    permitSources.every(({ terminalState }) => terminalState === 'blocked');
  return Object.freeze({
    state: blocked
      ? ('blocked' as const)
      : permitSources.length === 0
        ? ('unknown' as const)
        : ('partial' as const),
    jurisdiction: property.jurisdiction,
    windowStart: null,
    windowEnd: property.recordedAt,
    measuredAt: property.recordedAt,
    sourceIds: Object.freeze(actualSourceIds),
    limitations: Object.freeze([
      'Committed source manifests do not prove a complete bounded permit-history window for this property; permit absence is not a negative fact.',
    ]),
    observations: Object.freeze([]),
  });
}

function sourceObservation(observation: FieldObservation, kind: string): SourceObservation {
  return Object.freeze({
    observationId: observation.observationId,
    kind,
    reference: Object.freeze({
      sourceId: observation.lineage.sourceRecord.sourceId,
      snapshotId: observation.lineage.sourceRecord.snapshotId,
      artifactId: observation.lineage.sourceRecord.artifactId,
      recordKey: observation.lineage.sourceRecord.recordKey,
      fieldPaths: Object.freeze([observation.fieldPath]),
    }),
    observedAt: observation.observedAt,
    sourceAsOf: observation.sourceAsOf,
    visibility: observation.visibility,
    fields: Object.freeze({
      fieldPath: observation.fieldPath,
      value: observation.value,
      recordSha256: observation.lineage.sourceRecord.recordSha256,
      lineageSha256: observation.lineage.lineageSha256,
    }),
  });
}

type PropertyPoint = Readonly<{
  coordinates: readonly [number, number];
  basis: 'address_point' | 'parcel_geometry_representative';
  observations: readonly SourceObservation[];
}>;

function propertyPointFromAggregates(
  propertyAggregate: CanonicalEntityAggregate,
  addressAggregate: CanonicalEntityAggregate | null,
): PropertyPoint | null {
  if (propertyAggregate.entity.entityKind !== 'property') return null;
  const property = propertyAggregate.entity;
  if (property.primaryAddressId !== null && addressAggregate !== null) {
    if (
      addressAggregate.entity.entityKind === 'address' &&
      addressAggregate.entity.location !== null
    ) {
      const observations = observationsForPaths(
        addressAggregate,
        ['/location'],
        'property-location',
      );
      if (observations.length > 0) {
        return Object.freeze({
          coordinates: Object.freeze(addressAggregate.entity.location.coordinates),
          basis: 'address_point' as const,
          observations,
        });
      }
    }
  }
  const point =
    property.parcelGeometry === null ? null : representativeGeometryPoint(property.parcelGeometry);
  const observations = observationsForPaths(
    propertyAggregate,
    ['/parcelGeometry'],
    'property-location',
  );
  return point === null || observations.length === 0
    ? null
    : Object.freeze({
        coordinates: point,
        basis: 'parcel_geometry_representative' as const,
        observations,
      });
}

function geospatialProxy(
  work: RoofWork,
  propertyPoint: PropertyPoint,
  candidate: ProxyCandidate,
  feature: 'water_view_candidate' | 'transit_walkability' | 'starbucks_walkability',
  sources: readonly SourceExecutionManifest[],
): CountyFeatureEvidence | null {
  const aggregate = candidate.aggregate;
  const candidateCoordinates = candidate.coordinates;
  const distanceMeters = haversineMeters(propertyPoint.coordinates, candidateCoordinates);
  const maximumDistanceMeters = feature === 'water_view_candidate' ? 50_000 : 25_000;
  if (distanceMeters > maximumDistanceMeters) return null;
  const targetPaths =
    feature === 'water_view_candidate'
      ? ['/geometry', '/featureType', '/name']
      : feature === 'transit_walkability'
        ? ['/location', '/name', '/boardable', '/serviceIds']
        : ['/location', '/name', '/brandIdentifiers', '/operatingState', '/categories'];
  const observations = Object.freeze([
    ...propertyPoint.observations,
    ...observationsForPaths(aggregate, targetPaths, feature),
  ]);
  if (observations.length === propertyPoint.observations.length) return null;
  const sourceIds = [...new Set(observations.map(({ reference }) => reference.sourceId))].sort(
    compareUtf8,
  );
  for (const sourceId of sourceIds) {
    if (!sources.some((source) => source.sourceId === sourceId)) {
      throw new BoundedPipelineIntegrityError(
        `Feature evidence references absent source manifest: ${sourceId}`,
      );
    }
  }
  const limitations =
    feature === 'water_view_candidate'
      ? [
          'Mapped-water proximity uses a representative coordinate from source geometry; it does not prove a water view.',
          'Terrain, obstruction, floor height, and line-of-sight were not evaluated.',
        ]
      : [
          'Distance is straight-line geodesic proximity, not a pedestrian-network route.',
          'Estimated walk time is a transparent distance/speed proxy and does not account for barriers or entrances.',
        ];
  const value =
    feature === 'water_view_candidate'
      ? Object.freeze({
          mode: 'mapped_water_proximity_proxy',
          distanceMeters,
          terrainState: 'not_evaluated',
          propertyPointBasis: propertyPoint.basis,
          candidateEntityId: aggregate.entity.id,
        })
      : Object.freeze({
          mode: 'straight_line_distance_proxy',
          straightLineDistanceMeters: distanceMeters,
          estimatedWalkSeconds: Math.round(distanceMeters / 1.34),
          propertyPointBasis: propertyPoint.basis,
          candidateEntityId: aggregate.entity.id,
        });
  return buildInquiryResult({
    propertyId: work.propertyId,
    feature,
    value,
    supportClass: 'proxy',
    confidence: feature === 'water_view_candidate' ? 0.55 : 0.65,
    observations,
    calculation: Object.freeze({
      name:
        feature === 'water_view_candidate'
          ? 'bounded-mapped-water-proximity-proxy'
          : 'bounded-straight-line-walkability-proxy',
      version: '1.0.0',
      parameters: Object.freeze({
        distanceFormula: 'haversine',
        maximumCandidateDistanceMeters: maximumDistanceMeters,
        walkingMetersPerSecond: feature === 'water_view_candidate' ? 0 : 1.34,
      }),
    }),
    asOf: work.asOf,
    coverage: Object.freeze({
      state: 'partial' as const,
      jurisdiction: 'Santa Clara, CA',
      windowStart: null,
      windowEnd: work.asOf,
      measuredAt: work.asOf,
      sourceIds: Object.freeze(sourceIds),
      limitations: Object.freeze(limitations),
      observations: Object.freeze([]),
    }),
    limitations,
  });
}

function observationsForPaths(
  aggregate: CanonicalEntityAggregate,
  paths: readonly string[],
  kind: string,
): readonly SourceObservation[] {
  const selected = new Set(paths);
  return Object.freeze(
    aggregate.observations
      .filter(({ fieldPath }) => selected.has(fieldPath))
      .map((observation) => sourceObservation(observation, kind)),
  );
}

function representativePoint(entity: CanonicalEntity): readonly [number, number] | null {
  switch (entity.entityKind) {
    case 'address':
      return entity.location?.coordinates ?? null;
    case 'transit-stop':
    case 'place':
      return entity.location.coordinates;
    case 'hydro-feature':
      return representativeGeometryPoint(entity.geometry);
    // Properties carry their own parcel geometry and must yield a point, or every
    // proximity feature is structurally empty at any data scale.
    //
    // The spatial join resolves a property's point via
    // coalesce(primaryAddressId, entity_id), so it already falls back to the property
    // itself when there is no linked address — and there never is: both property
    // adapters hardcode primaryAddressId to null, and no code anywhere constructs an
    // 'address' canonical entity. The join was therefore correct but could never match,
    // because properties were never inserted into geospatial_candidate.
    //
    // representativeGeometryPoint already declares parcelGeometry in its own parameter
    // type, so this case was intended and simply missing. Note the point is a genuine
    // vertex of the real parcel geometry, not a synthesized coordinate.
    case 'property':
      return representativeGeometryPoint(entity.parcelGeometry);
    default:
      return null;
  }
}

function representativeGeometryPoint(
  geometry:
    | Extract<CanonicalEntity, { entityKind: 'hydro-feature' }>['geometry']
    | Extract<CanonicalEntity, { entityKind: 'property' }>['parcelGeometry'],
): readonly [number, number] | null {
  if (geometry === null) return null;
  const visit = (value: unknown): readonly [number, number] | null => {
    if (
      Array.isArray(value) &&
      value.length >= 2 &&
      typeof value[0] === 'number' &&
      typeof value[1] === 'number'
    ) {
      return Object.freeze([value[0], value[1]]);
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        const point = visit(child);
        if (point !== null) return point;
      }
    }
    return null;
  };
  return visit(geometry.coordinates);
}

function haversineMeters(
  left: readonly [number, number],
  right: readonly [number, number],
): number {
  const radians = (value: number): number => (value * Math.PI) / 180;
  const latitudeDelta = radians(right[1] - left[1]);
  const longitudeDelta = radians(right[0] - left[0]);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(left[1])) * Math.cos(radians(right[1])) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const FEATURE_ALGORITHMS: Readonly<Record<CountyFeatureKind, string>> = Object.freeze({
  roof_age: 'oracle-roof-evidence',
  ownership_age: 'oracle-complete-transfer-tenure',
  regional_owner: 'oracle-regional-owner-nine-counties',
  starbucks_walkability: 'overture-starbucks-offline-pedestrian-walkability',
  transit_walkability: 'offline-gtfs-pedestrian-walkability',
  water_view_candidate: 'oracle-mapped-water-terrain-candidate',
});

const FEATURE_CAPABILITIES: Readonly<
  Record<CountyFeatureKind, readonly SourceExecutionManifest['capability'][]>
> = Object.freeze({
  roof_age: Object.freeze(['san_jose_permits', 'palo_alto_year_built']),
  ownership_age: Object.freeze(['ownership_transfers']),
  regional_owner: Object.freeze(['ownership_transfers']),
  starbucks_walkability: Object.freeze(['overture_starbucks', 'osm_pedestrian_graph']),
  transit_walkability: Object.freeze(['vta_gtfs', 'caltrain_gtfs', 'osm_pedestrian_graph']),
  water_view_candidate: Object.freeze(['noaa_shoreline', 'usgs_hydrography', 'usgs_elevation']),
});

function countyFeatureBundle(
  work: RoofWork,
  roof: RoofEvidence,
  sources: readonly SourceExecutionManifest[],
): FeatureBundle {
  const actual = new Map<CountyFeatureKind, CountyFeatureEvidence>();
  actual.set('roof_age', roof);
  const propertyPoint = work.propertyPoint;
  if (propertyPoint !== null) {
    const waterCandidate = work.proxyCandidates.water_view_candidate;
    const transitCandidate = work.proxyCandidates.transit_walkability;
    const starbucksCandidate = work.proxyCandidates.starbucks_walkability;
    const water =
      waterCandidate === undefined
        ? null
        : geospatialProxy(work, propertyPoint, waterCandidate, 'water_view_candidate', sources);
    const transit =
      transitCandidate === undefined
        ? null
        : geospatialProxy(work, propertyPoint, transitCandidate, 'transit_walkability', sources);
    const starbucks =
      starbucksCandidate === undefined
        ? null
        : geospatialProxy(
            work,
            propertyPoint,
            starbucksCandidate,
            'starbucks_walkability',
            sources,
          );
    if (water !== null) actual.set('water_view_candidate', water);
    if (transit !== null) actual.set('transit_walkability', transit);
    if (starbucks !== null) actual.set('starbucks_walkability', starbucks);
  }
  const exactCapabilityStates = new Map<string, string>(
    capabilityStates(sources).map(({ capability, state }): [string, string] => [capability, state]),
  );
  const dependencyUnavailableFeatures = new Set<CountyFeatureKind>();
  for (const feature of FEATURE_KINDS) {
    const dependencyUnavailable = FEATURE_CAPABILITIES[feature].some((capability) => {
      const state = exactCapabilityStates.get(capability);
      return state === 'failed' || state === 'blocked';
    });
    if (dependencyUnavailable) {
      dependencyUnavailableFeatures.add(feature);
      actual.delete(feature);
    }
  }
  for (const feature of FEATURE_KINDS) {
    if (actual.has(feature)) continue;
    actual.set(
      feature,
      unavailableFeatureEvidence(
        work,
        feature,
        sources,
        'restricted',
        dependencyUnavailableFeatures.has(feature),
      ),
    );
  }
  const publicEvidence = FEATURE_KINDS.map((feature) => {
    const evidence = requiredFeature(actual, feature);
    if (evidence.visibility === 'public') return evidence;
    return unavailableFeatureEvidence(
      work,
      feature,
      sources,
      'public',
      dependencyUnavailableFeatures.has(feature),
    );
  });
  const restrictedEvidence = FEATURE_KINDS.map((feature) =>
    projectFeatureEvidence(requiredFeature(actual, feature), 'restricted'),
  );
  return Object.freeze({
    propertyId: work.propertyId,
    publicEvidence: Object.freeze(publicEvidence),
    restrictedEvidence: Object.freeze(restrictedEvidence),
  });
}

function requiredFeature(
  values: ReadonlyMap<CountyFeatureKind, CountyFeatureEvidence>,
  feature: CountyFeatureKind,
): CountyFeatureEvidence {
  const value = values.get(feature);
  if (value === undefined)
    throw new BoundedPipelineIntegrityError(`Feature bundle omitted ${feature}`);
  return value;
}

function unavailableFeatureEvidence(
  work: RoofWork,
  feature: CountyFeatureKind,
  sources: readonly SourceExecutionManifest[],
  projection: ServingVisibility,
  mandatoryDependencyUnavailable = false,
): CountyFeatureEvidence {
  const capabilities = new Set(FEATURE_CAPABILITIES[feature]);
  const related = sources.filter(({ capability }) => capabilities.has(capability));
  const visible =
    projection === 'public'
      ? related.filter(
          ({ license }) => license.redistribution === 'approved' && !license.containsPersonalData,
        )
      : related;
  const allBlocked =
    related.length > 0 && related.every(({ terminalState }) => terminalState === 'blocked');
  const supportClass =
    allBlocked && !mandatoryDependencyUnavailable ? ('unsupported' as const) : ('unknown' as const);
  const coverageState = allBlocked
    ? ('blocked' as const)
    : related.length === 0
      ? ('unknown' as const)
      : ('partial' as const);
  const limitations = [
    ...(related.length === 0
      ? [`No ${FEATURE_CAPABILITIES[feature].join('/')} source was configured for this run.`]
      : related.flatMap(({ limitations: values }) => values)),
    projection === 'public' && visible.length !== related.length
      ? 'Restricted or owner-bearing source evidence is excluded from the owner-free public projection.'
      : 'The bounded feature stage found no complete per-property semantic input; absence is not a negative fact.',
  ];
  const result = buildInquiryResult({
    propertyId: work.propertyId,
    feature,
    value: null,
    supportClass,
    confidence: 0,
    observations: [],
    calculation: Object.freeze({
      name: FEATURE_ALGORITHMS[feature],
      version: '1.0.0',
      parameters: Object.freeze({ boundedJoinRequired: true }),
    }),
    asOf: work.asOf,
    coverage: Object.freeze({
      state: coverageState,
      jurisdiction: 'Santa Clara, CA',
      windowStart: null,
      windowEnd: work.asOf,
      measuredAt: work.asOf,
      sourceIds: Object.freeze([]),
      limitations: Object.freeze(limitations),
      observations: Object.freeze([]),
    }),
    limitations,
  });
  return projection === 'restricted' ? projectFeatureEvidence(result, 'restricted') : result;
}

function projectFeatureEvidence(
  evidence: CountyFeatureEvidence,
  visibility: ServingVisibility,
): CountyFeatureEvidence {
  if (evidence.visibility === visibility) return evidence;
  return Object.freeze({
    ...evidence,
    visibility,
    evidence: Object.freeze({ ...evidence.evidence, visibility }),
  });
}

class FileFeatureChunkStore {
  public constructor(
    private readonly request: BoundedCountyProcessingRequest,
    private readonly root: string,
    private readonly sharedBudget: ProcessWideBoundedBudget,
    private readonly maximumBufferedBytes: number,
  ) {}

  public async inspect(
    identity: BoundedFeatureChunkIdentity,
  ): Promise<Readonly<{ uri: string; byteSize: number; sha256: string }> | null> {
    const stored = await this.request.artifactStore.headByLogicalKey(identity.logicalKey);
    if (stored === undefined) return null;
    return Object.freeze({ uri: stored.uri, byteSize: stored.byteSize, sha256: stored.sha256 });
  }

  public async adopt(
    identity: BoundedFeatureChunkIdentity,
    expected: Readonly<{ uri: string; byteSize: number; sha256: string }>,
  ): Promise<Readonly<{ uri: string; byteSize: number; sha256: string }>> {
    const inspected = await this.inspect(identity);
    if (
      inspected?.uri !== expected.uri ||
      inspected.byteSize !== expected.byteSize ||
      inspected.sha256 !== expected.sha256
    ) {
      throw new BoundedPipelineIntegrityError(
        `Feature orphan adoption mismatch: ${identity.logicalKey}`,
      );
    }
    return inspected;
  }

  public async open(identity: BoundedFeatureChunkIdentity): Promise<BoundedFeatureChunkSink> {
    const directory = confinedChild(this.root, identity.partitionId.toString().padStart(6, '0'));
    await mkdir(directory, { recursive: true });
    const finalPath = this.path(identity);
    const temporary = `${finalPath}.partial`;
    const handle = await open(temporary, 'w');
    let byteSize = 0;
    const hash = createHash('sha256');
    let closed = false;
    return {
      write: async (segment) => {
        if (closed) throw new Error('Feature chunk is closed');
        await handle.write(segment);
        byteSize += segment.byteLength;
        hash.update(segment);
      },
      commit: async () => {
        if (closed) throw new Error('Feature chunk is closed');
        closed = true;
        await handle.sync();
        await handle.close();
        const digest = hash.digest('hex');
        try {
          await rename(temporary, finalPath);
        } catch (error) {
          if (!(await exists(finalPath))) throw error;
          const existing = await hashFile(finalPath, this.sharedBudget, this.maximumBufferedBytes);
          if (existing.sha256 !== digest || existing.byteSize !== byteSize)
            throw new BoundedPipelineIntegrityError(`Feature orphan mismatch: ${finalPath}`);
          await rm(temporary, { force: true });
        }
        const stored = await persistLocalArtifact(
          this.request,
          identity.logicalKey,
          'application/x-ndjson',
          finalPath,
          digest,
          byteSize,
          this.sharedBudget,
          this.maximumBufferedBytes,
        );
        return Object.freeze({ uri: stored.uri, byteSize, sha256: digest });
      },
      abort: async () => {
        if (!closed) {
          closed = true;
          await handle.close();
        }
        await rm(temporary, { force: true });
      },
    };
  }

  private path(identity: BoundedFeatureChunkIdentity): string {
    const directory = confinedChild(this.root, identity.partitionId.toString().padStart(6, '0'));
    const name = `${identity.visibility}-${identity.sequence.toString().padStart(8, '0')}.ndjson`;
    return confinedChild(directory, name);
  }
}

async function buildMarts(
  request: BoundedCountyProcessingRequest,
  connection: DuckDBConnection,
  processing: BoundedProcessingInput,
  sources: readonly SourceExecutionManifest[],
  root: string,
  outputRoot: string,
  signal: AbortSignal,
  sharedBudget: ProcessWideBoundedBudget,
  crash: BoundedPipelineProcessorOptions['crash'],
  trustedAcquisition: TrustedAcquisitionBinding,
) {
  await connection.run('DROP TABLE IF EXISTS feature_evidence');
  await connection.run(`CREATE TABLE feature_evidence (
    projection VARCHAR NOT NULL, property_id VARCHAR NOT NULL, feature VARCHAR NOT NULL,
    evidence_id VARCHAR NOT NULL, feature_json VARCHAR NOT NULL,
    PRIMARY KEY(projection, property_id, feature, evidence_id))`);
  await connection.run('DROP TABLE IF EXISTS property_feature_bundle');
  await connection.run(`CREATE TABLE property_feature_bundle (
    projection VARCHAR NOT NULL, property_id VARCHAR NOT NULL, features_json VARCHAR NOT NULL,
    PRIMARY KEY(projection, property_id))`);
  const featureAppender = await connection.createAppender('feature_evidence');
  const bundleAppender = await connection.createAppender('property_feature_bundle');
  const appenderLeases: (() => void)[] = [];
  let bufferedRows = 0;
  const flushFeatures = (): void => {
    featureAppender.flushSync();
    bundleAppender.flushSync();
    while (appenderLeases.length > 0) appenderLeases.pop()?.();
    bufferedRows = 0;
  };
  try {
    for await (const artifact of streamKeysetJson<ImmutableBoundedArtifact>(
      connection,
      `SELECT lpad(CAST(partition_id AS VARCHAR),12,'0') || lpad(CAST(sequence AS VARCHAR),12,'0') AS key, artifact_json AS value FROM feature_artifact WHERE generation_id=${sql(processing.generationId)}`,
      'key',
    )) {
      for await (const value of readNdjsonFile(
        artifactPath(request.artifactStore, artifact),
        processing.budget.maxBufferedBytes,
        sharedBudget,
      )) {
        const bundle = value as FeatureBundle;
        for (const [projection, evidenceRows] of [
          ['public', bundle.publicEvidence],
          ['restricted', bundle.restrictedEvidence],
        ] as const) {
          const bundleBody = canonicalJson(evidenceRows);
          appenderLeases.push(sharedBudget.acquire(1, Buffer.byteLength(bundleBody, 'utf8')));
          bundleAppender.appendVarchar(projection);
          bundleAppender.appendVarchar(bundle.propertyId);
          bundleAppender.appendVarchar(bundleBody);
          bundleAppender.endRow();
          bufferedRows += 1;
          for (const evidence of evidenceRows) {
            const body = canonicalJson(evidence);
            appenderLeases.push(sharedBudget.acquire(1, Buffer.byteLength(body, 'utf8')));
            featureAppender.appendVarchar(projection);
            featureAppender.appendVarchar(evidence.propertyId);
            featureAppender.appendVarchar(evidence.feature);
            featureAppender.appendVarchar(evidence.evidence.evidenceId);
            featureAppender.appendVarchar(body);
            featureAppender.endRow();
            bufferedRows += 1;
            if (
              bufferedRows >= Math.max(1, Math.min(1_024, processing.budget.maxBufferedRecords - 4))
            ) {
              flushFeatures();
            }
          }
        }
      }
    }
    flushFeatures();
  } finally {
    while (appenderLeases.length > 0) appenderLeases.pop()?.();
    featureAppender.closeSync();
    bundleAppender.closeSync();
  }

  const allLineage = servingLineage(
    sources.filter(({ terminalState }) => terminalState !== 'failed'),
    trustedAcquisition.manifest,
  );
  if (allLineage.length === 0)
    throw new BoundedPipelineIntegrityError('Serving release requires source lineage');
  const inputRoot = join(root, 'mart-input');
  await mkdir(inputRoot, { recursive: true });
  const relations: BoundedServingRelationInput[] = [];
  const relationBudgetReleases: (() => void)[] = [];
  let relationOrdinal = 0;
  for (const visibility of ['public', 'restricted'] as const) {
    for (const relation of BOUNDED_COUNTY_SERVING_RELATIONS) {
      signal.throwIfAborted();
      const rows = martRows(
        relation,
        visibility,
        connection,
        processing,
        sources,
        trustedAcquisition.manifest,
        sharedBudget,
      );
      const prepared = await writeRelationInput(
        request,
        inputRoot,
        connection,
        processing,
        visibility,
        relation,
        relationOrdinal,
        rows,
        sources,
        trustedAcquisition.manifest,
        sharedBudget,
      );
      const relationInput = prepared.input;
      relationBudgetReleases.push(prepared.releaseBudget);
      relations.push(relationInput);
      await commitBoundedUnit(
        request,
        connection,
        processing,
        'build_marts',
        relationOrdinal,
        relationInput.recordCount,
        undefined,
        sharedBudget,
      );
      await crash?.('after_mart_relation', { relation: `${visibility}/${relation}` });
      relationOrdinal += 1;
    }
  }
  const capabilities = BOUNDED_AUTHORITATIVE_COUNTY_CAPABILITIES.map((capability) => {
    const value = trustedAcquisition.manifest.capabilities.find(
      (candidate) => candidate.capability === capability,
    );
    if (value === undefined) {
      throw new BoundedPipelineIntegrityError(`Trusted capability disappeared: ${capability}`);
    }
    return Object.freeze({
      capability,
      state: value.state,
      sourceIds: value.sourceIds,
      limitations: value.limitations,
    });
  });
  const permitAuthoritiesCovered = new Set(
    trustedAcquisition.manifest.sources
      .filter(({ terminalState }) => terminalState === 'succeeded')
      .flatMap(({ permitAuthorityIds }) => permitAuthorityIds),
  ).size;
  const propertyCount = await scalarCount(
    connection,
    `SELECT count(*)::BIGINT AS value FROM canonical_entity WHERE generation_id=${sql(processing.generationId)} AND entity_kind='property'`,
  );
  const semanticallyReadyOwnershipRows = await scalarCount(
    connection,
    `SELECT count(*)::BIGINT AS value FROM feature_evidence WHERE projection='restricted' AND feature IN ('ownership_age','regional_owner') AND json_extract_string(feature_json,'$.supportClass')='supported'`,
  );
  const fullReady =
    request.configuration.profile.name === 'full' &&
    sources.every(
      ({ terminalState, supportState }) =>
        terminalState === 'complete' && supportState === 'available',
    ) &&
    capabilities.every(
      ({ capability, state }) =>
        state === 'succeeded' ||
        (capability === 'transit_511_fallback' && state === 'not_configured'),
    ) &&
    permitAuthoritiesCovered === BOUNDED_AUTHORITATIVE_PERMIT_AUTHORITIES.length &&
    trustedAcquisition.manifest.authoritativeCountyRegistry !== undefined &&
    semanticallyReadyOwnershipRows === propertyCount * 2;
  const releaseGenerationRoot = confinedChild(
    join(outputRoot, 'releases'),
    generationPath(processing.generationId),
  );
  await mkdir(releaseGenerationRoot, { recursive: true });
  const releaseDirectory = confinedChild(releaseGenerationRoot, processing.release.releaseId);
  await commitBoundedProgress(request, connection, processing, 'build_marts', sharedBudget);
  const buildCheckpoint = (await loadBoundedCheckpoint(request, processing)).checkpoint;
  if (!buildCheckpoint.completedStages.some(({ stage }) => stage === 'build_marts')) {
    throw new BoundedPipelineIntegrityError('Release hand-off requires completed build_marts');
  }
  const buildMartsManifestText = await scalarStringOrNull(
    connection,
    `SELECT manifest_json AS value FROM stage_manifest WHERE generation_id=${sql(processing.generationId)} AND stage='build_marts'`,
  );
  if (buildMartsManifestText === null) {
    throw new BoundedPipelineIntegrityError('Completed build_marts manifest is missing');
  }
  const buildMartsManifest = boundedStageManifestSchema.parse(JSON.parse(buildMartsManifestText));
  const completedBuildMarts = Object.freeze({
    manifest: buildMartsManifest,
    ...(buildMartsManifest.artifactInventory === undefined
      ? {}
      : {
          resolver: descriptorPageResolver(
            request,
            sharedBudget,
            processing.budget.maxBufferedBytes,
          ),
        }),
  });
  if (buildCheckpoint.completedStages.some(({ stage }) => stage === 'finalize_release')) {
    if (
      buildCheckpoint.finalization === null ||
      buildCheckpoint.finalization.state === 'verified'
    ) {
      throw new BoundedPipelineIntegrityError(
        'Completed release checkpoint lacks a promoted finalization winner',
      );
    }
    const adopted = await verifyBoundedServingRelease(releaseDirectory);
    if (
      adopted.manifest.manifestSha256 !== buildCheckpoint.finalization.releaseManifestSha256 ||
      adopted.evidence.evidenceSha256 !== buildCheckpoint.finalization.releaseEvidenceSha256
    ) {
      throw new BoundedPipelineIntegrityError('Promoted release differs from checkpoint winner');
    }
    while (relationBudgetReleases.length > 0) relationBudgetReleases.pop()?.();
    return Object.freeze({
      outputDirectory: releaseDirectory,
      generationId: processing.generationId,
      manifest: adopted.manifest,
      evidence: adopted.evidence,
      adoptedIdenticalWinner: buildCheckpoint.finalization.state === 'adopted_identical_winner',
      finalizationExpectedRevision: buildCheckpoint.finalization.winnerCasRevision,
    });
  }
  const releaseCheckpoint =
    buildCheckpoint.finalization?.state === 'verified'
      ? withCheckpointHash({
          ...buildCheckpoint,
          expectedRevision: buildCheckpoint.finalization.winnerCasRevision,
          finalization: null,
        })
      : buildCheckpoint;
  // The current release-builder contract rejects a coordinator with caller-held leases.
  // Relation descriptors are therefore hard-capped above and their construction leases
  // are released before hand-off. County-scale use remains gated on rooted relation input.
  while (relationBudgetReleases.length > 0) relationBudgetReleases.pop()?.();
  try {
    const releaseScratch = join(root, 'release-scratch');
    await mkdir(releaseScratch, { recursive: true });
    const built = await buildBoundedServingRelease({
      processing,
      checkpoint: releaseCheckpoint,
      outputDirectory: releaseDirectory,
      scratchDirectory: releaseScratch,
      relations,
      ...Object.freeze({ completedBuildMarts, sharedBudget }),
      writeBatchRecords: Math.max(1, Math.min(1_024, processing.budget.maxBufferedRecords - 4)),
      maximumLineBytes: processing.budget.maxBufferedBytes,
      dictionaryReleaseMetadata: Object.freeze({
        public: releaseMetadata(
          allLineage.filter(({ sourceId }) => publicSourceIds(sources).has(sourceId)),
          'public',
          'data_dictionary',
        ),
        restricted: releaseMetadata(allLineage, 'restricted', 'data_dictionary'),
      }),
      releaseGate: Object.freeze({
        sourceManifestSha256: processing.sourceManifestSha256,
        capabilityStateSha256: processing.capabilityStateSha256,
        requestedScope: fullReady ? ('full_county' as const) : ('partial_county' as const),
        runStatus: sourceInventoryRunStatus(sources),
        sourceStates: Object.freeze(
          trustedAcquisition.manifest.sources.map((source) =>
            Object.freeze({
              sourceId: source.sourceId,
              snapshotId: source.snapshotId,
              terminalState: source.terminalState,
              permissionState: source.permissionState,
              limitations: source.limitations,
            }),
          ),
        ),
        capabilities,
        permitAuthoritiesCovered,
      }),
      trustedAcquisition: Object.freeze({
        reference: trustedAcquisition.reference,
        resolver: trustedAcquisition.resolver,
      }),
      trustedCanonicalLineage: canonicalLineageResolver(connection, processing.generationId),
      readArtifact: (artifact, range) => request.artifactStore.read(artifact.uri, range),
      finalization: Object.freeze({
        attemptId: `${processing.generationId}:${releaseCheckpoint.expectedRevision}`,
        coordinator: new FileReleaseFinalizationCoordinator(join(root, 'release-finalization')),
      }),
      sharedBudget,
    });
    if (releaseCheckpoint.expectedRevision === null) {
      throw new BoundedPipelineIntegrityError('Release finalization requires a CAS revision');
    }
    return Object.freeze({
      ...built,
      finalizationExpectedRevision: releaseCheckpoint.expectedRevision,
    });
  } finally {
    while (relationBudgetReleases.length > 0) relationBudgetReleases.pop()?.();
  }
}

type FileFinalizationRecord = Readonly<{
  format: string;
  revision: string;
  winner: BoundedReleaseFinalizationWinner;
}>;

class FileReleaseFinalizationCoordinator implements BoundedReleaseFinalizationCoordinator {
  public constructor(private readonly root: string) {}

  public async inspect(destinationIdentitySha256: string): Promise<Readonly<{
    revision: string;
    winner: BoundedReleaseFinalizationWinner;
  }> | null> {
    const path = this.recordPath(destinationIdentitySha256);
    let raw: string;
    try {
      const handle = await open(path, 'r');
      try {
        raw = await handle.readFile({ encoding: 'utf8' });
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return null;
      throw error;
    }
    const record = JSON.parse(raw) as FileFinalizationRecord;
    if (
      record.format !== 'oracle-pipeline-release-finalization-v1' ||
      record.winner.destinationIdentitySha256 !== destinationIdentitySha256 ||
      record.revision !== sha256(record.winner)
    ) {
      throw new BoundedPipelineIntegrityError(
        `Release finalization record is corrupt: ${destinationIdentitySha256}`,
      );
    }
    return Object.freeze({ revision: record.revision, winner: Object.freeze(record.winner) });
  }

  public async finalize(
    input: Readonly<{
      destination: string;
      staging: string;
      expectedRevision: string;
      winner: BoundedReleaseFinalizationWinner;
    }>,
  ): Promise<
    Readonly<{
      state: 'promoted' | 'adopted_identical_winner';
      revision: string;
      winner: BoundedReleaseFinalizationWinner;
    }>
  > {
    if (
      input.expectedRevision !== input.winner.expectedRevision ||
      input.winner.destinationIdentitySha256.trim().length === 0
    ) {
      throw new BoundedPipelineIntegrityError('Release finalization revision changed');
    }
    await mkdir(this.root, { recursive: true });
    const revision = sha256(input.winner);
    const record = Object.freeze({
      format: 'oracle-pipeline-release-finalization-v1' as const,
      revision,
      winner: input.winner,
    });
    const path = this.recordPath(input.winner.destinationIdentitySha256);
    let adopted = false;
    try {
      const handle = await open(path, 'wx');
      try {
        await handle.writeFile(`${canonicalJson(record)}\n`, { encoding: 'utf8' });
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
      const existing = await this.inspect(input.winner.destinationIdentitySha256);
      if (existing === null) {
        throw new BoundedPipelineIntegrityError('Release finalization CAS record disappeared');
      }
      if (
        existing.revision !== revision ||
        canonicalJson(existing.winner) !== canonicalJson(input.winner)
      ) {
        throw new BoundedPipelineIntegrityError('Release finalization CAS winner is non-identical');
      }
      adopted = true;
    }
    if (!(await exists(input.destination))) {
      try {
        await rename(input.staging, input.destination);
      } catch (error) {
        if (!(await exists(input.destination))) throw error;
        adopted = true;
      }
    } else {
      adopted = true;
    }
    return Object.freeze({
      state: adopted ? ('adopted_identical_winner' as const) : ('promoted' as const),
      revision,
      winner: input.winner,
    });
  }

  private recordPath(destinationIdentitySha256: string): string {
    if (!/^[a-f0-9]{64}$/u.test(destinationIdentitySha256)) {
      throw new BoundedPipelineIntegrityError('Invalid finalization destination identity');
    }
    return confinedChild(this.root, `${destinationIdentitySha256}.json`);
  }
}

function servingLineage(
  sources: readonly SourceExecutionManifest[],
  trustedAcquisition: BoundedTrustedAcquisitionManifest,
): readonly BoundedServingSourceLineage[] {
  const trusted = new Map(trustedAcquisition.sources.map((source) => [source.sourceId, source]));
  return Object.freeze(
    [...sources]
      .filter(({ sourceId }) => trusted.has(sourceId))
      .sort((a, b) => compareUtf8(a.sourceId, b.sourceId))
      .map((source) => {
        const acquired = trusted.get(source.sourceId);
        if (acquired === undefined) {
          throw new BoundedPipelineIntegrityError('Trusted serving source disappeared');
        }
        return Object.freeze({
          sourceId: source.sourceId,
          snapshotId: source.snapshotIdentity.observedContentId ?? source.snapshotIdentity.intentId,
          sourceSha256: acquired.sourceSha256,
          schemaSha256: acquired.schemaSha256,
          asOf: acquired.asOf,
          role: 'direct' as const,
          contributors: acquired.contributors,
        });
      }),
  );
}

function releaseMetadata(
  sourceLineage: readonly BoundedServingSourceLineage[],
  visibility: ServingVisibility,
  relation: (typeof BOUNDED_COUNTY_SERVING_RELATIONS)[number] | 'data_dictionary',
): BoundedServingReleaseMetadata {
  const canonicalLineage = Object.freeze(
    [...sourceLineage].sort((left, right) =>
      compareUtf8(`${left.sourceId}\0${left.snapshotId}`, `${right.sourceId}\0${right.snapshotId}`),
    ),
  );
  const derived = relation === 'property_query' || relation === 'property_evidence';
  const licenseDecision: BoundedServingLicenseDecision = Object.freeze({
    policyVersion: 'oracle-public-projection-v1',
    contentClass:
      relation === 'data_dictionary'
        ? 'serving_schema_metadata'
        : derived
          ? 'derived_data'
          : 'capability_metadata',
    decision: visibility === 'public' ? 'allowed_public' : 'restricted_only',
    licenseSnapshotRefs: Object.freeze(
      canonicalLineage.length === 0
        ? ['oracle:no-observation-derived-row:v1']
        : [
            ...new Set(
              canonicalLineage.map(({ sourceId, snapshotId }) => `${sourceId}@${snapshotId}`),
            ),
          ].sort(compareUtf8),
    ),
  });
  return Object.freeze({
    sourceLineage: canonicalLineage,
    limitations: Object.freeze([
      visibility === 'public'
        ? derived
          ? `${relation} contains owner-free derived rows only; restricted source values are excluded.`
          : `${relation} contains counts, hashes, support states, and limitations only.`
        : derived
          ? `${relation} preserves restricted evidence visibility and source limitations.`
          : `${relation} is restricted run/coverage metadata with immutable counts and hashes.`,
    ]),
    licenseDecision,
  });
}

async function* martRows(
  relation: (typeof BOUNDED_COUNTY_SERVING_RELATIONS)[number],
  visibility: ServingVisibility,
  connection: DuckDBConnection,
  processing: BoundedProcessingInput,
  sources: readonly SourceExecutionManifest[],
  trustedAcquisition: BoundedTrustedAcquisitionManifest,
  sharedBudget: ProcessWideBoundedBudget,
): AsyncIterable<MartRowEnvelope> {
  const pageRecords = Math.max(1, Math.min(64, processing.budget.maxBufferedRecords - 4));
  if (relation === 'property_query') {
    const publicFilter =
      visibility === 'public'
        ? " AND json_extract_string(property.entity_json,'$.visibility')='public'"
        : '';
    let cursor = '';
    for (;;) {
      let rowsInPage = 0;
      let nextCursor = cursor;
      for await (const row of streamRows(
        connection,
        `SELECT property.entity_id, property.aggregate_json, address.aggregate_json AS address_aggregate_json, evidence.features_json FROM canonical_entity property LEFT JOIN canonical_entity address ON address.generation_id=property.generation_id AND address.entity_kind='address' AND address.entity_id=json_extract_string(property.entity_json,'$.primaryAddressId') LEFT JOIN property_feature_bundle evidence ON evidence.property_id=property.entity_id AND evidence.projection=${sql(visibility)} WHERE property.generation_id=${sql(processing.generationId)} AND property.entity_kind='property'${publicFilter} AND property.entity_id>${sql(cursor)} ORDER BY property.entity_id LIMIT ${pageRecords}`,
      )) {
        const entityId = stringValue(row.entity_id);
        if (compareUtf8(entityId, nextCursor) <= 0) {
          throw new BoundedPipelineIntegrityError('Property mart cursor did not advance');
        }
        nextCursor = entityId;
        rowsInPage += 1;
        const propertyAggregate = JSON.parse(
          stringValue(row.aggregate_json),
        ) as CanonicalEntityAggregate;
        if (propertyAggregate.entity.entityKind !== 'property') {
          throw new BoundedPipelineIntegrityError('Property mart received non-property aggregate');
        }
        const property = propertyAggregate.entity;
        const addressAggregate =
          row.address_aggregate_json === null || row.address_aggregate_json === undefined
            ? null
            : (JSON.parse(stringValue(row.address_aggregate_json)) as CanonicalEntityAggregate);
        const address =
          addressAggregate?.entity.entityKind === 'address' ? addressAggregate.entity : null;
        const features =
          row.features_json === null || row.features_json === undefined
            ? []
            : (JSON.parse(stringValue(row.features_json)) as CountyFeatureEvidence[]);
        if (features.length !== FEATURE_KINDS.length) {
          throw new BoundedPipelineIntegrityError(
            `Feature stage omitted evidence for ${property.id}`,
          );
        }
        const servingRow = propertyServingRow(property, address, features, visibility);
        const fieldSourceReferences = propertyQueryFieldSourceIds(
          propertyAggregate,
          addressAggregate,
          features,
          servingRow,
        );
        const fieldSourceIds = Object.freeze(
          Object.fromEntries(
            Object.entries(fieldSourceReferences).map(([fieldName, references]) => [
              fieldName,
              exactSourceIds(references.map(({ sourceId }) => sourceId)),
            ]),
          ),
        );
        const sourceIds = exactSourceIds(Object.values(fieldSourceIds).flatMap((value) => value));
        const completed = Object.freeze({
          row: Object.freeze({
            ...servingRow,
            source_ids_json: canonicalJson(sourceIds),
            field_source_ids_json: propertyQueryFieldSourceIdsJson(
              fieldSourceReferences,
              servingRow,
            ),
          }),
          sourceIds,
          fieldSourceIds,
        });
        const lease = sharedBudget.acquire(1, Buffer.byteLength(canonicalJson(completed), 'utf8'));
        try {
          yield completed;
        } finally {
          lease();
        }
      }
      if (rowsInPage < pageRecords) return;
      cursor = nextCursor;
    }
  }
  if (relation === 'property_evidence') {
    const publicFilter =
      visibility === 'public'
        ? " AND json_extract_string(property.entity_json,'$.visibility')='public'"
        : '';
    let previousProperty = '';
    let featureCount = 0;
    let cursorProperty = '';
    let cursorFeature = '';
    let cursorEvidence = '';
    for (;;) {
      let rowsInPage = 0;
      let nextProperty = cursorProperty;
      let nextFeature = cursorFeature;
      let nextEvidence = cursorEvidence;
      for await (const row of streamRows(
        connection,
        `SELECT property.entity_id, evidence.feature, evidence.evidence_id, evidence.feature_json FROM canonical_entity property JOIN feature_evidence evidence ON evidence.property_id=property.entity_id AND evidence.projection=${sql(visibility)} WHERE property.generation_id=${sql(processing.generationId)} AND property.entity_kind='property'${publicFilter} AND (property.entity_id>${sql(cursorProperty)} OR (property.entity_id=${sql(cursorProperty)} AND (evidence.feature>${sql(cursorFeature)} OR (evidence.feature=${sql(cursorFeature)} AND evidence.evidence_id>${sql(cursorEvidence)})))) ORDER BY property.entity_id, evidence.feature, evidence.evidence_id LIMIT ${pageRecords}`,
      )) {
        const propertyId = stringValue(row.entity_id);
        nextProperty = propertyId;
        nextFeature = stringValue(row.feature);
        nextEvidence = stringValue(row.evidence_id);
        rowsInPage += 1;
        if (previousProperty !== '' && propertyId !== previousProperty) {
          if (featureCount !== FEATURE_KINDS.length) {
            throw new BoundedPipelineIntegrityError(
              `Feature stage omitted evidence for ${previousProperty}`,
            );
          }
          featureCount = 0;
        }
        previousProperty = propertyId;
        featureCount += 1;
        const feature = JSON.parse(stringValue(row.feature_json)) as CountyFeatureEvidence;
        const value = Object.freeze({
          row: featureServingRow(feature, visibility),
          sourceIds: exactSourceIds(
            feature.evidence.sourceReferences.map(({ sourceId }) => sourceId),
          ),
        });
        const lease = sharedBudget.acquire(1, Buffer.byteLength(canonicalJson(value), 'utf8'));
        try {
          yield value;
        } finally {
          lease();
        }
      }
      if (rowsInPage < pageRecords) break;
      cursorProperty = nextProperty;
      cursorFeature = nextFeature;
      cursorEvidence = nextEvidence;
    }
    if (previousProperty !== '' && featureCount !== FEATURE_KINDS.length) {
      throw new BoundedPipelineIntegrityError(
        `Feature stage omitted evidence for ${previousProperty}`,
      );
    }
    return;
  }
  if (relation === 'source_coverage') {
    const trustedSourceIds = new Set(trustedAcquisition.sources.map(({ sourceId }) => sourceId));
    const eligibleSources =
      visibility === 'public'
        ? sources.filter(
            ({ sourceId }) =>
              trustedSourceIds.has(sourceId) && publicSourceIds(sources).has(sourceId),
          )
        : sources.filter(
            ({ sourceId, terminalState }) =>
              terminalState !== 'failed' && trustedSourceIds.has(sourceId),
          );
    for (const source of [...eligibleSources].sort((a, b) =>
      compareUtf8(`${a.sourceId}\0${a.scope}`, `${b.sourceId}\0${b.scope}`),
    )) {
      const acquired = trustedAcquisition.sources.find(
        ({ sourceId }) => sourceId === source.sourceId,
      );
      const held = leaseMartRow(
        sharedBudget,
        Object.freeze({
          source_id: source.sourceId,
          scope: source.scope,
          support_class:
            source.terminalState === 'complete'
              ? 'supported'
              : source.terminalState === 'blocked'
                ? 'unsupported'
                : 'unknown',
          expected_count: source.coverage.expectedRecords,
          observed_count: source.coverage.acceptedRecords,
          quarantine_count: source.coverage.quarantinedRecords,
          source_sha256: acquired?.sourceSha256 ?? source.sourceHash,
          schema_sha256:
            acquired?.schemaSha256 ?? sha256([...source.schemaHashes].sort(compareUtf8)),
          as_of: source.sourceAsOf,
          limitations_json: canonicalJson(source.limitations),
        }),
        [source.sourceId],
      );
      try {
        yield held.value;
      } finally {
        held.release();
      }
    }
    return;
  }
  if (relation === 'field_coverage') {
    for await (const coverage of streamRows(
      connection,
      `SELECT field_name, numerator, denominator, source_ids_json FROM property_query_coverage WHERE generation_id=${sql(processing.generationId)} AND visibility=${sql(visibility)} ORDER BY field_name`,
    )) {
      const fieldName = stringValue(coverage.field_name);
      const numerator = numberValue(coverage.numerator);
      const denominator = numberValue(coverage.denominator);
      const sourceIds = JSON.parse(stringValue(coverage.source_ids_json)) as string[];
      const held = leaseMartRow(
        sharedBudget,
        Object.freeze({
          relation_name: 'property_query',
          field_name: fieldName,
          support_class: numerator > 0 ? 'supported' : 'unknown',
          numerator,
          denominator,
          ratio: denominator === 0 ? 0 : numerator / denominator,
          source_ids_json: canonicalJson(sourceIds),
          limitations_json: canonicalJson(
            numerator > 0 ? [] : ['No emitted property row contained a non-null field value.'],
          ),
        }),
        sourceIds,
      );
      try {
        yield held.value;
      } finally {
        held.release();
      }
    }
    return;
  }
  if (relation === 'relation_coverage') {
    for (const relationName of [...LINK_RELATIONS].sort(compareUtf8)) {
      const eligibleVisibility =
        visibility === 'public'
          ? " AND subject.linkable_json IS NOT NULL AND json_extract_string(subject.linkable_json,'$.visibility')='public'"
          : '';
      const eligible = await scalarCount(
        connection,
        `SELECT count(*)::BIGINT AS value FROM reconciliation_claim claim LEFT JOIN linkable_entity subject ON subject.generation_id=claim.generation_id AND subject.entity_id=claim.subject_entity_id WHERE claim.generation_id=${sql(processing.generationId)} AND claim.relation=${sql(relationName)}${eligibleVisibility}`,
      );
      const linkedVisibility =
        visibility === 'public'
          ? " AND json_extract_string(resolution_json,'$.visibility')='public'"
          : '';
      const linked = await scalarCount(
        connection,
        `SELECT count(*)::BIGINT AS value FROM link_resolution WHERE generation_id=${sql(processing.generationId)} AND relation=${sql(relationName)} AND json_extract_string(resolution_json,'$.acceptedTargetEntityId') IS NOT NULL${linkedVisibility}`,
      );
      const sourceIds = await reconciliationSourceIds(
        connection,
        processing.generationId,
        relationName,
        visibility,
      );
      const held = leaseMartRow(
        sharedBudget,
        Object.freeze({
          relation_name: relationName,
          support_class: eligible > 0 ? 'supported' : 'unknown',
          linked_count: linked,
          eligible_count: eligible,
          ratio: eligible === 0 ? 0 : linked / eligible,
          method_version: 'entity-linking-v1',
          limitations_json: canonicalJson([]),
        }),
        sourceIds,
      );
      try {
        yield held.value;
      } finally {
        held.release();
      }
    }
    return;
  }
  const expected = sources.every(({ coverage }) => coverage.expectedRecords !== null)
    ? sources.reduce((total, source) => total + (source.coverage.expectedRecords ?? 0), 0)
    : null;
  const inventoryLimitations = exactSourceIds(
    sources.flatMap((source) => [
      ...source.limitations,
      ...(source.terminalState === 'complete' && source.supportState === 'available'
        ? []
        : [
            `${source.sourceId} ended ${source.terminalState}/${source.supportState} without trusted row contribution.`,
          ]),
    ]),
  );
  const held = leaseMartRow(
    sharedBudget,
    Object.freeze({
      run_id: processing.runId,
      status: sourceInventoryRunStatus(sources),
      started_at: processing.requestedAt,
      completed_at: processing.release.generatedAt,
      pipeline_version: processing.pipelineVersion,
      source_ids_json: canonicalJson(
        trustedVisibilitySourceIds(sources, trustedAcquisition, visibility),
      ),
      expected_count: expected,
      observed_count: sources.reduce((total, source) => total + source.coverage.acceptedRecords, 0),
      quarantine_count: sources.reduce(
        (total, source) => total + source.coverage.quarantinedRecords,
        0,
      ),
      limitations_json: canonicalJson(inventoryLimitations),
    }),
    trustedVisibilitySourceIds(sources, trustedAcquisition, visibility),
  );
  try {
    yield held.value;
  } finally {
    held.release();
  }
}

function propertyServingRow(
  entity: Extract<CanonicalEntity, { entityKind: 'property' }>,
  address: Extract<CanonicalEntity, { entityKind: 'address' }> | null,
  evidence: readonly CountyFeatureEvidence[],
  visibility: ServingVisibility,
): ServingRow {
  const byFeature = new Map(evidence.map((value) => [value.feature, value]));
  const roof = byFeature.get('roof_age');
  const water = byFeature.get('water_view_candidate');
  const ownership = byFeature.get('ownership_age');
  const regional = byFeature.get('regional_owner');
  const transit = byFeature.get('transit_walkability');
  const starbucks = byFeature.get('starbucks_walkability');
  const supported = evidence.filter(
    ({ supportClass }) => supportClass === 'supported' || supportClass === 'proxy',
  ).length;
  return Object.freeze({
    property_id: entity.id,
    parcel_identifier: entity.apn,
    address_street: address?.line1 ?? null,
    address_city: address?.locality ?? entity.jurisdiction,
    address_zip: address?.postalCode ?? null,
    latitude: address?.location?.coordinates[1] ?? null,
    longitude: address?.location?.coordinates[0] ?? null,
    roof_support_class: roof?.supportClass ?? 'unknown',
    roof_age_years: featureNumber(roof, 'ageYears'),
    roof_reference_date: featureString(roof, 'basisDate'),
    water_support_class: water?.supportClass ?? 'unknown',
    water_distance_meters: featureNumber(water, 'distanceMeters'),
    water_visibility_state: featureString(water, 'terrainState'),
    ownership_support_class: ownership?.supportClass ?? 'unknown',
    years_since_exchange: featureNumber(ownership, 'tenureYears'),
    last_exchange_date: featureString(ownership, 'latestVerifiedTransferAt'),
    regional_owner_support_class: regional?.supportClass ?? 'unknown',
    is_regional_owner: featureBoolean(regional, 'isRegionalOwner'),
    transit_support_class: transit?.supportClass ?? 'unknown',
    transit_distance_meters:
      featureNumber(transit, 'networkDistanceMeters') ??
      featureNumber(transit, 'straightLineDistanceMeters'),
    transit_walk_minutes: walkMinutes(transit),
    starbucks_support_class: starbucks?.supportClass ?? 'unknown',
    starbucks_distance_meters:
      featureNumber(starbucks, 'networkDistanceMeters') ??
      featureNumber(starbucks, 'straightLineDistanceMeters'),
    starbucks_walk_minutes: walkMinutes(starbucks),
    combined_review_score: null,
    evidence_coverage: supported / FEATURE_KINDS.length,
    visibility,
  });
}

function propertyQueryFieldSourceIds(
  property: CanonicalEntityAggregate,
  address: CanonicalEntityAggregate | null,
  evidence: readonly CountyFeatureEvidence[],
  servingRow: ServingRow,
): Readonly<Record<string, readonly ExactEvidenceSourceReference[]>> {
  const byFeature = new Map(
    evidence.map((value) => [
      value.feature,
      exactSourceReferences(
        value.sourceObservations.map((observation) => exactFeatureSourceReference(observation)),
      ),
    ]),
  );
  const observed = (
    aggregate: CanonicalEntityAggregate | null,
    paths: readonly string[],
  ): readonly ExactEvidenceSourceReference[] =>
    aggregate === null
      ? Object.freeze([])
      : exactSourceReferences(
          aggregate.observations
            .filter(({ fieldPath }) => paths.includes(fieldPath))
            .map(({ fieldPath, lineage }) => ({
              sourceId: lineage.sourceRecord.sourceId,
              snapshotId: lineage.sourceRecord.snapshotId,
              artifactId: lineage.sourceRecord.artifactId,
              recordKey: lineage.sourceRecord.recordKey,
              recordSha256: lineage.sourceRecord.recordSha256,
              lineageSha256: lineage.lineageSha256,
              fieldPaths: [fieldPath],
            })),
        );
  const feature = (kind: CountyFeatureKind): readonly ExactEvidenceSourceReference[] =>
    byFeature.get(kind) ?? Object.freeze([]);
  const allFeatures = exactSourceReferences([...byFeature.values()].flatMap((value) => value));
  const ifPresent = (
    fieldName: string,
    references: readonly ExactEvidenceSourceReference[],
  ): readonly ExactEvidenceSourceReference[] =>
    servingRow[fieldName] === null ? Object.freeze([]) : references;
  const propertyIdentity = observed(property, ['/apn']);
  return Object.freeze({
    property_id: propertyIdentity,
    parcel_identifier: propertyIdentity,
    address_street: ifPresent('address_street', observed(address, ['/line1'])),
    address_city: ifPresent(
      'address_city',
      address !== null ? observed(address, ['/locality']) : observed(property, ['/jurisdiction']),
    ),
    address_zip: ifPresent('address_zip', observed(address, ['/postalCode'])),
    latitude: ifPresent('latitude', observed(address, ['/location'])),
    longitude: ifPresent('longitude', observed(address, ['/location'])),
    roof_support_class: feature('roof_age'),
    roof_age_years: feature('roof_age'),
    roof_reference_date: feature('roof_age'),
    water_support_class: feature('water_view_candidate'),
    water_distance_meters: feature('water_view_candidate'),
    water_visibility_state: feature('water_view_candidate'),
    ownership_support_class: feature('ownership_age'),
    years_since_exchange: feature('ownership_age'),
    last_exchange_date: feature('ownership_age'),
    regional_owner_support_class: feature('regional_owner'),
    is_regional_owner: feature('regional_owner'),
    transit_support_class: feature('transit_walkability'),
    transit_distance_meters: feature('transit_walkability'),
    transit_walk_minutes: feature('transit_walkability'),
    starbucks_support_class: feature('starbucks_walkability'),
    starbucks_distance_meters: feature('starbucks_walkability'),
    starbucks_walk_minutes: feature('starbucks_walkability'),
    combined_review_score: Object.freeze([]),
    evidence_coverage: allFeatures,
    visibility: Object.freeze([]),
  });
}

function exactFeatureSourceReference(observation: SourceObservation): ExactEvidenceSourceReference {
  const candidate = observation.reference;
  const recordSha256 = observation.fields.recordSha256;
  const lineageSha256 = observation.fields.lineageSha256;
  if (
    typeof recordSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(recordSha256) ||
    typeof lineageSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(lineageSha256)
  ) {
    throw new BoundedPipelineIntegrityError(
      'Feature source reference is not bound to canonical record and observation lineage',
    );
  }
  return Object.freeze({
    sourceId: candidate.sourceId,
    snapshotId: candidate.snapshotId,
    artifactId: candidate.artifactId,
    recordKey: candidate.recordKey,
    recordSha256,
    lineageSha256,
    fieldPaths: Object.freeze([...candidate.fieldPaths]),
  });
}

function propertyQueryFieldSourceIdsJson(
  fieldSourceReferences: Readonly<Record<string, readonly ExactEvidenceSourceReference[]>>,
  servingRow: ServingRow,
): string {
  return canonicalJson(
    Object.entries(fieldSourceReferences)
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([fieldName, sourceReferences]) => {
        const sourceIds = exactSourceIds(sourceReferences.map(({ sourceId }) => sourceId));
        return {
          field_name: fieldName,
          source_ids: sourceIds,
          source_references: sourceReferences,
          field_lineage_sha256: propertyQueryFieldLineageSha256(
            fieldName,
            servingRow[fieldName],
            sourceReferences,
          ),
        };
      }),
  );
}

function propertyQueryFieldLineageSha256(
  fieldName: string,
  value: ServingRow[string] | undefined,
  sourceReferences: readonly ExactEvidenceSourceReference[],
): string {
  if (value === undefined) {
    throw new BoundedPipelineIntegrityError(`Property-query field ${fieldName} is absent`);
  }
  return sha256({
    contract: 'oracle-property-query-field-lineage-v1',
    fieldName,
    value,
    sourceReferences,
  });
}

function exactSourceReferences(
  values: readonly ExactEvidenceSourceReference[],
): readonly ExactEvidenceSourceReference[] {
  const canonical = values.map((reference) =>
    Object.freeze({
      sourceId: reference.sourceId,
      snapshotId: reference.snapshotId,
      artifactId: reference.artifactId,
      recordKey: reference.recordKey,
      recordSha256: reference.recordSha256,
      lineageSha256: reference.lineageSha256,
      fieldPaths: Object.freeze(exactSourceIds(reference.fieldPaths)),
    }),
  );
  return Object.freeze(
    [...new Map(canonical.map((reference) => [canonicalJson(reference), reference])).entries()]
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([, reference]) => reference),
  );
}

type CanonicalLineageFieldSpec = Readonly<{
  fieldPaths: readonly string[];
  entityKinds: readonly CanonicalEntity['entityKind'][];
}>;

const PROPERTY_QUERY_IDENTITY_LINEAGE = Object.freeze({
  fieldPaths: Object.freeze(['/apn']),
  entityKinds: Object.freeze(['property'] as const),
}) satisfies CanonicalLineageFieldSpec;
const PROPERTY_QUERY_ROOF_LINEAGE = Object.freeze({
  fieldPaths: Object.freeze([
    '/completedAt',
    '/description',
    '/effectiveYearBuilt',
    '/issuedAt',
    '/permitType',
    '/status',
    '/yearBuilt',
  ]),
  entityKinds: Object.freeze(['permit', 'property'] as const),
}) satisfies CanonicalLineageFieldSpec;
const PROPERTY_QUERY_WATER_LINEAGE = Object.freeze({
  fieldPaths: Object.freeze(['/featureType', '/geometry', '/location', '/name', '/parcelGeometry']),
  entityKinds: Object.freeze(['address', 'hydro-feature', 'property'] as const),
}) satisfies CanonicalLineageFieldSpec;
const PROPERTY_QUERY_TRANSIT_LINEAGE = Object.freeze({
  fieldPaths: Object.freeze(['/boardable', '/location', '/name', '/parcelGeometry', '/serviceIds']),
  entityKinds: Object.freeze(['address', 'property', 'transit-stop'] as const),
}) satisfies CanonicalLineageFieldSpec;
const PROPERTY_QUERY_STARBUCKS_LINEAGE = Object.freeze({
  fieldPaths: Object.freeze([
    '/brandIdentifiers',
    '/categories',
    '/location',
    '/name',
    '/operatingState',
    '/parcelGeometry',
  ]),
  entityKinds: Object.freeze(['address', 'place', 'property'] as const),
}) satisfies CanonicalLineageFieldSpec;
const PROPERTY_QUERY_OWNERSHIP_LINEAGE = Object.freeze({
  fieldPaths: Object.freeze([
    '/effectiveFrom',
    '/effectiveTo',
    '/eventType',
    '/occurredAt',
    '/recordedDocumentId',
    '/supportState',
  ]),
  entityKinds: Object.freeze(['ownership-event', 'ownership-interest'] as const),
}) satisfies CanonicalLineageFieldSpec;
const PROPERTY_QUERY_REGIONAL_OWNER_LINEAGE = Object.freeze({
  fieldPaths: Object.freeze([
    '/addressIds',
    '/displayName',
    '/effectiveFrom',
    '/effectiveTo',
    '/partyId',
    '/partyKind',
    '/supportState',
  ]),
  entityKinds: Object.freeze(['ownership-interest', 'party'] as const),
}) satisfies CanonicalLineageFieldSpec;

function propertyQueryCanonicalLineageSpec(fieldName: string): CanonicalLineageFieldSpec | null {
  if (fieldName === 'property_id' || fieldName === 'parcel_identifier') {
    return PROPERTY_QUERY_IDENTITY_LINEAGE;
  }
  if (fieldName === 'address_street') {
    return Object.freeze({ fieldPaths: Object.freeze(['/line1']), entityKinds: ['address'] });
  }
  if (fieldName === 'address_city') {
    return Object.freeze({
      fieldPaths: Object.freeze(['/jurisdiction', '/locality']),
      entityKinds: Object.freeze(['address', 'property'] as const),
    });
  }
  if (fieldName === 'address_zip') {
    return Object.freeze({ fieldPaths: Object.freeze(['/postalCode']), entityKinds: ['address'] });
  }
  if (fieldName === 'latitude' || fieldName === 'longitude') {
    return Object.freeze({ fieldPaths: Object.freeze(['/location']), entityKinds: ['address'] });
  }
  if (fieldName.startsWith('roof_')) return PROPERTY_QUERY_ROOF_LINEAGE;
  if (fieldName.startsWith('water_')) return PROPERTY_QUERY_WATER_LINEAGE;
  if (
    fieldName.startsWith('ownership_') ||
    fieldName === 'years_since_exchange' ||
    fieldName === 'last_exchange_date'
  ) {
    return PROPERTY_QUERY_OWNERSHIP_LINEAGE;
  }
  if (fieldName.startsWith('regional_owner_') || fieldName === 'is_regional_owner') {
    return PROPERTY_QUERY_REGIONAL_OWNER_LINEAGE;
  }
  if (fieldName.startsWith('transit_')) return PROPERTY_QUERY_TRANSIT_LINEAGE;
  if (fieldName.startsWith('starbucks_')) return PROPERTY_QUERY_STARBUCKS_LINEAGE;
  if (fieldName === 'evidence_coverage') {
    return Object.freeze({
      fieldPaths: Object.freeze(
        exactSourceIds([
          ...PROPERTY_QUERY_ROOF_LINEAGE.fieldPaths,
          ...PROPERTY_QUERY_WATER_LINEAGE.fieldPaths,
          ...PROPERTY_QUERY_OWNERSHIP_LINEAGE.fieldPaths,
          ...PROPERTY_QUERY_REGIONAL_OWNER_LINEAGE.fieldPaths,
          ...PROPERTY_QUERY_TRANSIT_LINEAGE.fieldPaths,
          ...PROPERTY_QUERY_STARBUCKS_LINEAGE.fieldPaths,
        ]),
      ),
      entityKinds: Object.freeze([
        'address',
        'hydro-feature',
        'ownership-event',
        'ownership-interest',
        'party',
        'permit',
        'place',
        'property',
        'transit-stop',
      ] as const),
    });
  }
  return null;
}

function canonicalLineageResolver(
  connection: DuckDBConnection,
  generationId: string,
): BoundedTrustedCanonicalLineageResolver {
  return Object.freeze({
    async verifyPropertyQueryFieldReference({
      propertyId,
      fieldName,
      fieldValue,
      reference,
    }: Parameters<BoundedTrustedCanonicalLineageResolver['verifyPropertyQueryFieldReference']>[0]) {
      if (typeof propertyId !== 'string' || propertyId.trim().length === 0) {
        return false;
      }
      const specification = propertyQueryCanonicalLineageSpec(fieldName);
      if (
        specification === null ||
        reference.fieldPaths.some((fieldPath) => !specification.fieldPaths.includes(fieldPath))
      ) {
        return false;
      }
      let propertyBindingMatched = false;
      for await (const row of streamRows(
        connection,
        `SELECT property.aggregate_json, address.aggregate_json AS address_aggregate_json, evidence.projection, evidence.features_json FROM canonical_entity property LEFT JOIN canonical_entity address ON address.generation_id=property.generation_id AND address.entity_kind='address' AND address.entity_id=json_extract_string(property.entity_json,'$.primaryAddressId') LEFT JOIN property_feature_bundle evidence ON evidence.property_id=property.entity_id WHERE property.generation_id=${sql(generationId)} AND property.entity_kind='property' AND property.entity_id=${sql(propertyId)} ORDER BY evidence.projection`,
      )) {
        const propertyAggregate = JSON.parse(
          stringValue(row.aggregate_json),
        ) as CanonicalEntityAggregate;
        if (propertyAggregate.entity.entityKind !== 'property') return false;
        const addressAggregate =
          row.address_aggregate_json === null || row.address_aggregate_json === undefined
            ? null
            : (JSON.parse(stringValue(row.address_aggregate_json)) as CanonicalEntityAggregate);
        const address =
          addressAggregate?.entity.entityKind === 'address' ? addressAggregate.entity : null;
        const projection = stringValue(row.projection);
        if (projection !== 'public' && projection !== 'restricted') return false;
        const features = JSON.parse(stringValue(row.features_json)) as CountyFeatureEvidence[];
        if (features.length !== FEATURE_KINDS.length) return false;
        const servingRow = propertyServingRow(
          propertyAggregate.entity,
          address,
          features,
          projection,
        );
        const canonicalValue = servingRow[fieldName];
        if (
          canonicalValue === undefined ||
          canonicalJson(canonicalValue) !== canonicalJson(fieldValue)
        ) {
          continue;
        }
        const canonicalReferences = propertyQueryFieldSourceIds(
          propertyAggregate,
          addressAggregate,
          features,
          servingRow,
        )[fieldName];
        if (
          canonicalReferences?.some(
            (candidate) => canonicalJson(candidate) === canonicalJson(reference),
          ) === true
        ) {
          propertyBindingMatched = true;
          break;
        }
      }
      if (!propertyBindingMatched) return false;
      const fieldPaths = exactSourceIds(reference.fieldPaths);
      const matched = await scalarCount(
        connection,
        `SELECT count(DISTINCT lineage.field_path)::BIGINT AS value FROM canonical_field_lineage lineage JOIN canonical_entity entity ON entity.generation_id=lineage.generation_id AND entity.entity_id=lineage.entity_id WHERE lineage.generation_id=${sql(generationId)} AND lineage.source_id=${sql(reference.sourceId)} AND lineage.snapshot_id=${sql(reference.snapshotId)} AND lineage.artifact_id=${sql(reference.artifactId)} AND lineage.record_key=${sql(reference.recordKey)} AND lineage.record_sha256=${sql(reference.recordSha256)} AND lineage.lineage_sha256=${sql(reference.lineageSha256)} AND lineage.field_path IN (${fieldPaths.map(sql).join(',')}) AND entity.entity_kind IN (${specification.entityKinds.map(sql).join(',')})`,
      );
      return matched === fieldPaths.length;
    },
  });
}

function featureServingRow(
  feature: CountyFeatureEvidence,
  visibility: ServingVisibility,
): ServingRow {
  return Object.freeze({
    evidence_id: feature.evidence.evidenceId,
    property_id: feature.propertyId,
    feature: feature.feature,
    support_class: feature.supportClass,
    confidence: feature.confidence,
    as_of: feature.asOf,
    algorithm_name: feature.calculation.name,
    algorithm_version: feature.calculation.version,
    value_json: canonicalJson(feature.value),
    source_ids_json: canonicalJson(
      exactSourceIds(feature.evidence.sourceReferences.map(({ sourceId }) => sourceId)),
    ),
    source_references_json: canonicalJson(feature.evidence.sourceReferences),
    limitations_json: canonicalJson(feature.limitations),
    visibility,
  });
}

function featureRecord(
  evidence: CountyFeatureEvidence | undefined,
): Readonly<Record<string, unknown>> | null {
  const value = evidence?.value;
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function featureNumber(evidence: CountyFeatureEvidence | undefined, key: string): number | null {
  const value = featureRecord(evidence)?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function featureString(evidence: CountyFeatureEvidence | undefined, key: string): string | null {
  const value = featureRecord(evidence)?.[key];
  return typeof value === 'string' ? value : null;
}

function featureBoolean(evidence: CountyFeatureEvidence | undefined, key: string): boolean | null {
  const value = featureRecord(evidence)?.[key];
  return typeof value === 'boolean' ? value : null;
}

function walkMinutes(evidence: CountyFeatureEvidence | undefined): number | null {
  const seconds = featureNumber(evidence, 'estimatedWalkSeconds');
  return seconds === null ? null : seconds / 60;
}

function exactSourceIds(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort(compareUtf8));
}

function publicSourceIds(sources: readonly SourceExecutionManifest[]): ReadonlySet<string> {
  return new Set(
    sources
      .filter(
        ({ license, terminalState }) =>
          terminalState !== 'failed' &&
          license.redistribution === 'approved' &&
          !license.containsPersonalData,
      )
      .map(({ sourceId }) => sourceId),
  );
}

function visibilitySourceIds(
  sources: readonly SourceExecutionManifest[],
  visibility: ServingVisibility,
): readonly string[] {
  const allowed = visibility === 'public' ? publicSourceIds(sources) : null;
  return exactSourceIds(
    sources
      .filter(
        ({ sourceId, terminalState }) =>
          terminalState !== 'failed' && (allowed === null || allowed.has(sourceId)),
      )
      .map(({ sourceId }) => sourceId),
  );
}

function trustedVisibilitySourceIds(
  sources: readonly SourceExecutionManifest[],
  trusted: BoundedTrustedAcquisitionManifest,
  visibility: ServingVisibility,
): readonly string[] {
  const acquired = new Set(trusted.sources.map(({ sourceId }) => sourceId));
  return visibilitySourceIds(
    sources.filter(({ sourceId }) => acquired.has(sourceId)),
    visibility,
  );
}

function lineageForSourceIds(
  sources: readonly SourceExecutionManifest[],
  trustedAcquisition: BoundedTrustedAcquisitionManifest,
  contributingSourceIds: readonly string[],
  visibility: ServingVisibility,
): readonly BoundedServingSourceLineage[] {
  const requested = new Set(contributingSourceIds);
  const allowedPublic = publicSourceIds(sources);
  const selected = sources.filter(
    ({ sourceId }) =>
      requested.has(sourceId) && (visibility !== 'public' || allowedPublic.has(sourceId)),
  );
  if (selected.length !== requested.size) {
    const unavailable = [...requested].filter(
      (sourceId) => !selected.some((source) => source.sourceId === sourceId),
    );
    throw new BoundedPipelineIntegrityError(
      `Serving lineage contains unknown or non-public contributors: ${unavailable.join(',')}`,
    );
  }
  if (selected.length === 0) {
    return Object.freeze([]);
  }
  return servingLineage(selected, trustedAcquisition);
}

function leaseMartRow(
  sharedBudget: ProcessWideBoundedBudget,
  row: ServingRow,
  sourceIds: readonly string[],
): Readonly<{ value: MartRowEnvelope; release: () => void }> {
  const value = Object.freeze({ row, sourceIds: exactSourceIds(sourceIds) });
  const release = sharedBudget.acquire(1, Buffer.byteLength(canonicalJson(value), 'utf8'));
  return Object.freeze({ value, release });
}

async function reconciliationSourceIds(
  connection: DuckDBConnection,
  generationId: string,
  relation: LinkRelation,
  visibility: ServingVisibility,
): Promise<readonly string[]> {
  const ids = new Set<string>();
  const visibilityFilter =
    visibility === 'public'
      ? " AND json_extract_string(entity.linkable_json,'$.visibility')='public'"
      : '';
  const base = `SELECT entity.entity_id AS key, entity.linkable_json AS value FROM reconciliation_claim claim JOIN linkable_entity entity ON entity.generation_id=claim.generation_id AND entity.entity_id=claim.subject_entity_id WHERE claim.generation_id=${sql(generationId)} AND claim.relation=${sql(relation)}${visibilityFilter}`;
  for await (const entity of streamKeysetJson<LinkableEntity>(connection, base, 'key')) {
    for (const source of entity.lineage) ids.add(source.sourceId);
  }
  return exactSourceIds([...ids]);
}

async function writeRelationInput(
  request: BoundedCountyProcessingRequest,
  root: string,
  connection: DuckDBConnection,
  processing: BoundedProcessingInput,
  visibility: ServingVisibility,
  relation: (typeof BOUNDED_COUNTY_SERVING_RELATIONS)[number],
  partitionId: number,
  rows: AsyncIterable<MartRowEnvelope>,
  sources: readonly SourceExecutionManifest[],
  trustedAcquisition: BoundedTrustedAcquisitionManifest,
  sharedBudget: ProcessWideBoundedBudget,
): Promise<Readonly<{ input: BoundedServingRelationInput; releaseBudget: () => void }>> {
  const directory = confinedChild(confinedChild(root, visibility), relation);
  await mkdir(directory, { recursive: true });
  const logicalHash = createHash('sha256');
  const sourceIds = new Set<string>();
  const physicalIndexPath = confinedChild(directory, 'physical-pages.ndjson');
  const physicalIndexTemporary = `${physicalIndexPath}.partial`;
  const physicalIndexHandle = await open(physicalIndexTemporary, 'w');
  const physicalIndexHash = createHash('sha256');
  let pageCount = 0;
  let recordCount = 0;
  const fieldCounts = new Map(
    relation === 'property_query'
      ? SERVING_RELATIONS.property_query.columns.map(({ name }) => [
          name,
          { numerator: 0, sourceIds: new Set<string>() },
        ])
      : [],
  );
  let previousSortKey: string | null = null;
  let sequence = 0;
  let page: Readonly<{
    path: string;
    temporary: string;
    handle: Awaited<ReturnType<typeof open>>;
    hash: ReturnType<typeof createHash>;
    byteSize: number;
    recordCount: number;
    firstSortKey: string | null;
    lastSortKey: string | null;
  }> | null = null;
  const openPage = async () => {
    const path = confinedChild(directory, `${sequence.toString().padStart(8, '0')}.ndjson`);
    const temporary = `${path}.partial`;
    return {
      path,
      temporary,
      handle: await open(temporary, 'w'),
      hash: createHash('sha256'),
      byteSize: 0,
      recordCount: 0,
      firstSortKey: null,
      lastSortKey: null,
    };
  };
  const closePage = async (): Promise<void> => {
    const current = page;
    if (current === null) return;
    await current.handle.sync();
    await current.handle.close();
    const digest = current.hash.digest('hex');
    await rename(current.temporary, current.path).catch(async (error: unknown) => {
      if (!(await exists(current.path))) throw error;
      const existing = await hashFile(
        current.path,
        sharedBudget,
        processing.budget.maxBufferedBytes,
      );
      if (existing.byteSize !== current.byteSize || existing.sha256 !== digest) {
        throw new BoundedPipelineIntegrityError(
          `Mart page orphan mismatch: ${visibility}/${relation}/${sequence}`,
        );
      }
      await rm(current.temporary, { force: true });
    });
    const physical = Object.freeze({
      path: current.path,
      uri: (
        await persistLocalArtifact(
          request,
          `bm/${generationPath(processing.generationId)}/${visibility[0]}/${relation}/${sequence.toString().padStart(8, '0')}`,
          'application/x-ndjson',
          current.path,
          digest,
          current.byteSize,
          sharedBudget,
          processing.budget.maxBufferedBytes,
        )
      ).uri,
      byteSize: current.byteSize,
      sha256: digest,
      recordCount: current.recordCount,
      firstSortKey: current.firstSortKey,
      lastSortKey: current.lastSortKey,
    });
    const indexLine = Buffer.from(`${canonicalJson(physical)}\n`, 'utf8');
    const release = sharedBudget.acquire(1, indexLine.byteLength);
    try {
      await physicalIndexHandle.write(indexLine);
      physicalIndexHash.update(indexLine);
    } finally {
      release();
    }
    pageCount += 1;
    sequence += 1;
    page = null;
  };
  try {
    for await (const envelope of rows) {
      const sortKey = boundedServingRowSortKey(relation, envelope.row);
      if (previousSortKey !== null && compareUtf8(previousSortKey, sortKey) > 0) {
        throw new BoundedPipelineIntegrityError(`${relation} rows are not ordered`);
      }
      const line = Buffer.from(`${canonicalJson(envelope.row)}\n`);
      if (
        line.byteLength > processing.budget.maxBufferedBytes ||
        line.byteLength > processing.budget.maxBytesPerOutputChunk
      )
        throw new BoundedPipelineBudgetError(`${relation} row exceeds byte budget`);
      if (
        page !== null &&
        (page.recordCount >= processing.budget.maxRecordsPerOutputChunk ||
          page.byteSize + line.byteLength > processing.budget.maxBytesPerOutputChunk)
      )
        await closePage();
      page ??= await openPage();
      const release = sharedBudget.acquire(1, line.byteLength);
      try {
        await page.handle.write(line);
        page.hash.update(line);
        logicalHash.update(line);
      } finally {
        release();
      }
      for (const sourceId of envelope.sourceIds) sourceIds.add(sourceId);
      if (relation === 'property_query') {
        for (const [fieldName, state] of fieldCounts) {
          if (envelope.row[fieldName] !== null) state.numerator += 1;
          for (const sourceId of envelope.fieldSourceIds?.[fieldName] ?? []) {
            state.sourceIds.add(sourceId);
          }
        }
      }
      page = {
        ...page,
        byteSize: page.byteSize + line.byteLength,
        recordCount: page.recordCount + 1,
        firstSortKey: page.firstSortKey ?? sortKey,
        lastSortKey: sortKey,
      };
      recordCount += 1;
      previousSortKey = sortKey;
    }
    if (page === null && pageCount === 0) page = await openPage();
    await closePage();
    await physicalIndexHandle.sync();
    await physicalIndexHandle.close();
    const physicalStats = await hashFile(
      physicalIndexTemporary,
      sharedBudget,
      processing.budget.maxBufferedBytes,
    );
    if (physicalStats.sha256 !== physicalIndexHash.digest('hex')) {
      throw new BoundedPipelineIntegrityError('Physical mart-page inventory hash mismatch');
    }
    await adoptLocalFile(
      physicalIndexTemporary,
      physicalIndexPath,
      physicalStats.sha256,
      physicalStats.byteSize,
      sharedBudget,
      processing.budget.maxBufferedBytes,
    );
  } catch (error) {
    if (page !== null) {
      await page.handle.close();
      await rm(page.temporary, { force: true });
    }
    await physicalIndexHandle.close().catch(() => undefined);
    await rm(physicalIndexTemporary, { force: true });
    throw error;
  }
  if (relation === 'property_query') {
    const values = [...fieldCounts.entries()]
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(
        ([fieldName, state]) =>
          `(${sql(processing.generationId)}, ${sql(visibility)}, ${sql(fieldName)}, ${state.numerator}, ${recordCount}, ${sql(canonicalJson(exactSourceIds([...state.sourceIds])))})`,
      );
    await connection.run(
      `INSERT INTO property_query_coverage VALUES ${values.join(',')} ON CONFLICT DO UPDATE SET numerator=excluded.numerator, denominator=excluded.denominator, source_ids_json=excluded.source_ids_json`,
    );
  }
  const lineage = lineageForSourceIds(sources, trustedAcquisition, [...sourceIds], visibility);
  const metadata = releaseMetadata(lineage, visibility, relation);
  const sourceLineageSha256 = boundedServingLineageSha256(metadata.sourceLineage);
  const licenseIdentitySha256 = boundedServingLicenseDecisionSha256(metadata.licenseDecision);
  const descriptorPath = confinedChild(directory, 'artifact-descriptors.ndjson');
  const descriptorTemporary = `${descriptorPath}.partial`;
  const descriptorHandle = await open(descriptorTemporary, 'w');
  const descriptorHash = createHash('sha256');
  const stagedArtifactTable = `mart_stage_artifact_${partitionId}`;
  await connection.run(`DROP TABLE IF EXISTS ${stagedArtifactTable}`);
  await connection.run(
    `CREATE TEMP TABLE ${stagedArtifactTable} (generation_id VARCHAR NOT NULL, stage VARCHAR NOT NULL, dataset VARCHAR NOT NULL, partition_id INTEGER NOT NULL, sequence INTEGER NOT NULL, artifact_json VARCHAR NOT NULL)`,
  );
  const stagedArtifactAppender = await connection.createAppender(stagedArtifactTable);
  let descriptorCount = 0;
  let artifactByteSize = 0;
  let firstOrderKey: string | null = null;
  let lastOrderKey: string | null = null;
  try {
    for await (const value of readNdjsonFile(
      physicalIndexPath,
      processing.budget.maxBufferedBytes,
      sharedBudget,
    )) {
      const physical = value as Readonly<{
        path: string;
        uri: string;
        byteSize: number;
        sha256: string;
        recordCount: number;
        firstSortKey: string | null;
        lastSortKey: string | null;
      }>;
      const artifact: ImmutableBoundedArtifact = Object.freeze({
        generationId: processing.generationId,
        stage: 'build_marts',
        dataset: `${visibility}/${relation}`,
        partitionId,
        sequence: descriptorCount,
        logicalKey: `bm/${generationPath(processing.generationId)}/${visibility[0]}/${relation}/${descriptorCount.toString().padStart(8, '0')}`,
        uri: physical.uri,
        mediaType: 'application/x-ndjson',
        byteSize: physical.byteSize,
        sha256: physical.sha256,
        recordCount: physical.recordCount,
        firstSortKey: physical.firstSortKey,
        lastSortKey: physical.lastSortKey,
        schemaSha256: boundedServingSchemaSha256(relation),
        sourceLineageSha256,
        licenseIdentitySha256,
        visibility,
      });
      const line = Buffer.from(`${canonicalJson(artifact)}\n`, 'utf8');
      const release = sharedBudget.acquire(1, line.byteLength);
      try {
        await descriptorHandle.write(line);
        descriptorHash.update(line);
      } finally {
        release();
      }
      stagedArtifactAppender.appendVarchar(artifact.generationId);
      stagedArtifactAppender.appendVarchar(artifact.stage);
      stagedArtifactAppender.appendVarchar(artifact.dataset);
      stagedArtifactAppender.appendInteger(artifact.partitionId);
      stagedArtifactAppender.appendInteger(artifact.sequence);
      stagedArtifactAppender.appendVarchar(canonicalJson(artifact));
      stagedArtifactAppender.endRow();
      if ((descriptorCount + 1) % processing.budget.maxBufferedRecords === 0) {
        stagedArtifactAppender.flushSync();
      }
      const orderKey = boundedArtifactOrderKey(artifact);
      firstOrderKey ??= orderKey;
      lastOrderKey = orderKey;
      descriptorCount += 1;
      artifactByteSize += artifact.byteSize;
    }
    await descriptorHandle.sync();
  } finally {
    stagedArtifactAppender.flushSync();
    stagedArtifactAppender.closeSync();
    await descriptorHandle.close();
  }
  const conflictingArtifacts = await scalarCount(
    connection,
    `SELECT count(*)::BIGINT AS value FROM ${stagedArtifactTable} incoming JOIN stage_output_artifact durable USING (generation_id, stage, dataset, partition_id, sequence) WHERE incoming.artifact_json<>durable.artifact_json`,
  );
  if (conflictingArtifacts !== 0) {
    throw new BoundedPipelineIntegrityError(
      `Mart stage artifact identity changed: ${visibility}/${relation}`,
    );
  }
  await connection.run(
    `INSERT INTO stage_output_artifact SELECT incoming.* FROM ${stagedArtifactTable} incoming WHERE NOT EXISTS (SELECT 1 FROM stage_output_artifact durable WHERE durable.generation_id=incoming.generation_id AND durable.stage=incoming.stage AND durable.dataset=incoming.dataset AND durable.partition_id=incoming.partition_id AND durable.sequence=incoming.sequence)`,
  );
  const durableArtifactCount = await scalarCount(
    connection,
    `SELECT count(*)::BIGINT AS value FROM stage_output_artifact WHERE generation_id=${sql(processing.generationId)} AND stage='build_marts' AND dataset=${sql(`${visibility}/${relation}`)} AND partition_id=${partitionId}`,
  );
  await connection.run(`DROP TABLE ${stagedArtifactTable}`);
  if (durableArtifactCount !== descriptorCount) {
    throw new BoundedPipelineIntegrityError(
      `Mart stage artifact inventory changed: ${visibility}/${relation}`,
    );
  }
  const descriptorStats = await hashFile(
    descriptorTemporary,
    sharedBudget,
    processing.budget.maxBufferedBytes,
  );
  const descriptorRootSha256 = descriptorHash.digest('hex');
  if (descriptorStats.sha256 !== descriptorRootSha256 || descriptorCount !== pageCount) {
    throw new BoundedPipelineIntegrityError('Mart artifact descriptor inventory mismatch');
  }
  await adoptLocalFile(
    descriptorTemporary,
    descriptorPath,
    descriptorStats.sha256,
    descriptorStats.byteSize,
    sharedBudget,
    processing.budget.maxBufferedBytes,
  );
  if (firstOrderKey === null || lastOrderKey === null) {
    throw new BoundedPipelineIntegrityError('Mart artifact inventory is empty');
  }
  return Object.freeze({
    input: Object.freeze({
      visibility,
      relation,
      artifactRollup: Object.freeze({
        format: 'oracle-bounded-serving-artifact-rollup-v1' as const,
        descriptorCount,
        recordCount,
        byteSize: artifactByteSize,
        descriptorRootSha256,
        firstOrderKey,
        lastOrderKey,
      }),
      streamArtifacts: () =>
        readNdjsonFile(
          descriptorPath,
          processing.budget.maxBufferedBytes,
          sharedBudget,
        ) as AsyncIterable<ImmutableBoundedArtifact>,
      logicalSha256: logicalHash.digest('hex'),
      recordCount,
      releaseMetadata: metadata,
      rowLineageRule:
        relation === 'property_evidence'
          ? Object.freeze({ kind: 'source_ids_and_references_exact' as const })
          : relation === 'property_query' ||
              relation === 'field_coverage' ||
              relation === 'pipeline_runs'
            ? Object.freeze({ kind: 'source_ids_exact' as const })
            : relation === 'source_coverage'
              ? Object.freeze({ kind: 'source_id_exact' as const })
              : Object.freeze({
                  kind: 'trusted_relation_metadata' as const,
                  policyVersion: 'bounded-trusted-relation-lineage-v1' as const,
                  sourceLineageSha256,
                }),
    }),
    releaseBudget: () => undefined,
  });
}

async function writeDescriptor(
  request: BoundedCountyProcessingRequest,
  phase: 'reconcile' | 'derive_features' | 'build_marts',
  value: unknown,
): Promise<PhaseArtifact> {
  const body = new TextEncoder().encode(`${canonicalJson(value)}\n`);
  const digest = createHash('sha256').update(body).digest('hex');
  const logicalKey = `runs/${request.configuration.runId.replace('sc:run:', '')}/bounded/${phase}/${digest}.json`;
  const write = {
    logicalKey,
    mediaType: 'application/json',
    body: oneSegment(body),
    expectedSha256: digest,
    metadata: Object.freeze({
      processorKind: BOUNDED_PROCESSOR_KIND,
      phase,
      rowBearing: 'false',
    }),
    ifAbsent: true as const,
  };
  let stored;
  try {
    stored = await request.artifactStore.putImmutableStreaming(write);
  } catch (error) {
    const orphan = await request.artifactStore.headByLogicalKey(logicalKey);
    if (orphan === undefined) throw error;
    stored = orphan;
  }
  if (
    stored.sha256 !== digest ||
    stored.byteSize !== body.byteLength ||
    stored.logicalKey !== logicalKey
  ) {
    throw new BoundedPipelineIntegrityError(`Descriptor orphan mismatch: ${logicalKey}`);
  }
  return Object.freeze({
    phase,
    logicalKey,
    uri: stored.uri,
    mediaType: stored.mediaType,
    byteSize: stored.byteSize,
    sha256: stored.sha256,
  });
}

async function persistCanonicalObject(
  request: BoundedCountyProcessingRequest,
  logicalKey: string,
  value: unknown,
) {
  const body = Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
  const expectedSha256 = createHash('sha256').update(body).digest('hex');
  try {
    return await request.artifactStore.putImmutableStreaming({
      logicalKey,
      mediaType: 'application/json',
      body: oneSegment(body),
      expectedSha256,
      metadata: Object.freeze({ semanticSha256: canonicalObjectSha256(value) }),
      ifAbsent: true,
    });
  } catch (error) {
    const orphan = await request.artifactStore.headByLogicalKey(logicalKey);
    if (orphan?.sha256 !== expectedSha256 || orphan.byteSize !== body.byteLength) {
      throw error;
    }
    return orphan;
  }
}

async function persistLocalArtifact(
  request: BoundedCountyProcessingRequest,
  logicalKey: string,
  mediaType: string,
  path: string,
  expectedSha256: string,
  expectedBytes: number,
  sharedBudget: ProcessWideBoundedBudget,
  maximumBufferedBytes: number,
) {
  const body = async function* (): AsyncIterable<Uint8Array> {
    const highWaterMark = Math.max(1, Math.min(64 * 1024, maximumBufferedBytes));
    for await (const chunk of createReadStream(path, { highWaterMark })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const release = sharedBudget.acquire(0, bytes.byteLength);
      try {
        yield bytes;
      } finally {
        release();
      }
    }
  };
  let stored;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      stored = await request.artifactStore.putImmutableStreaming({
        logicalKey,
        mediaType,
        body: body(),
        expectedSha256,
        metadata: Object.freeze({ bounded: 'true' }),
        ifAbsent: true,
      });
      break;
    } catch (error) {
      stored = await request.artifactStore.headByLogicalKey(logicalKey);
      if (stored !== undefined) break;
      if (!isErrno(error, 'EPERM') && !isErrno(error, 'EBUSY')) throw error;
      if (attempt === 5) throw error;
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50 * (attempt + 1)));
    }
  }
  if (stored === undefined) throw new BoundedPipelineIntegrityError('Artifact write disappeared');
  if (
    stored.logicalKey !== logicalKey ||
    stored.sha256 !== expectedSha256 ||
    stored.byteSize !== expectedBytes
  ) {
    throw new BoundedPipelineIntegrityError(`Durable artifact mismatch: ${logicalKey}`);
  }
  return stored;
}

function descriptorPageResolver(
  request: BoundedCountyProcessingRequest,
  sharedBudget: ProcessWideBoundedBudget,
  maximumBytes: number,
): BoundedDescriptorPageResolver {
  const load = async (reference: Readonly<{ uri: string; sha256: string }>) => {
    const head = await request.artifactStore.head(reference.uri);
    if (head === undefined) {
      throw new BoundedPipelineIntegrityError(
        `Rooted descriptor object is missing: ${reference.uri}`,
      );
    }
    const chunks: Uint8Array[] = [];
    const releases: (() => void)[] = [];
    let byteSize = 0;
    try {
      for await (const chunk of request.artifactStore.read(reference.uri)) {
        byteSize += chunk.byteLength;
        if (byteSize > maximumBytes) {
          throw new BoundedPipelineBudgetError('Rooted descriptor object exceeds byte budget');
        }
        releases.push(sharedBudget.acquire(0, chunk.byteLength));
        chunks.push(chunk);
      }
      const value = JSON.parse(Buffer.concat(chunks, byteSize).toString('utf8')) as unknown;
      if (canonicalObjectSha256(value) !== reference.sha256) {
        throw new BoundedPipelineIntegrityError('Rooted descriptor semantic hash mismatch');
      }
      return value;
    } finally {
      while (releases.length > 0) releases.pop()?.();
    }
  };
  return Object.freeze({ loadPageIndex: load, loadPage: load });
}

const STAGE_PARENTS: Readonly<Record<BoundedProcessingStage, readonly BoundedProcessingStage[]>> =
  Object.freeze({
    partition_mutations: Object.freeze([] as BoundedProcessingStage[]),
    reduce_canonical: Object.freeze(['partition_mutations'] as BoundedProcessingStage[]),
    build_link_index: Object.freeze(['reduce_canonical'] as BoundedProcessingStage[]),
    reconcile_links: Object.freeze([
      'reduce_canonical',
      'build_link_index',
    ] as BoundedProcessingStage[]),
    derive_features: Object.freeze([
      'reduce_canonical',
      'reconcile_links',
    ] as BoundedProcessingStage[]),
    build_marts: Object.freeze([
      'reduce_canonical',
      'reconcile_links',
      'derive_features',
    ] as BoundedProcessingStage[]),
    finalize_release: Object.freeze(['build_marts'] as BoundedProcessingStage[]),
  });

async function materializeStageValueArtifact(
  request: BoundedCountyProcessingRequest,
  connection: DuckDBConnection,
  processing: BoundedProcessingInput,
  stage: BoundedProcessingStage,
  dataset: string,
  partitionId: number,
  root: string,
  value: unknown,
  sharedBudget: ProcessWideBoundedBudget,
): Promise<ImmutableBoundedArtifact> {
  const directory = confinedChild(
    confinedChild(confinedChild(root, 'stage-output'), stage),
    dataset,
  );
  await mkdir(directory, { recursive: true });
  const path = confinedChild(directory, `${partitionId.toString().padStart(8, '0')}.ndjson`);
  const temporary = `${path}.partial`;
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
  const release = sharedBudget.acquire(1, bytes.byteLength);
  try {
    const handle = await open(temporary, 'w');
    try {
      await handle.write(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } finally {
    release();
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  await rename(temporary, path).catch(async (error: unknown) => {
    if (!(await exists(path))) throw error;
    const existing = await hashFile(path, sharedBudget, processing.budget.maxBufferedBytes);
    if (existing.byteSize !== bytes.byteLength || existing.sha256 !== digest) {
      throw new BoundedPipelineIntegrityError(
        `Stage output orphan mismatch: ${stage}/${dataset}/${partitionId}`,
      );
    }
    await rm(temporary, { force: true });
  });
  const logicalKey = `bs/${generationPath(processing.generationId)}/${stage}/${dataset}/${partitionId.toString().padStart(8, '0')}`;
  const stored = await persistLocalArtifact(
    request,
    logicalKey,
    'application/x-ndjson',
    path,
    digest,
    bytes.byteLength,
    sharedBudget,
    processing.budget.maxBufferedBytes,
  );
  const artifact = Object.freeze({
    generationId: processing.generationId,
    stage,
    dataset,
    partitionId,
    sequence: 0,
    logicalKey,
    uri: stored.uri,
    mediaType: 'application/x-ndjson',
    byteSize: bytes.byteLength,
    sha256: digest,
    recordCount: 1,
    firstSortKey: partitionId.toString().padStart(8, '0'),
    lastSortKey: partitionId.toString().padStart(8, '0'),
    schemaSha256: sha256({ dataset, stage, version: processing.stageVersions[stage] }),
    sourceLineageSha256: processing.sourceManifestSha256,
    licenseIdentitySha256: sha256(mutationLicenseSnapshotRefs(processing)),
    visibility: 'mixed_internal' as const,
  });
  await recordStageArtifact(connection, artifact);
  return artifact;
}

async function materializeFinalizationArtifacts(
  request: BoundedCountyProcessingRequest,
  connection: DuckDBConnection,
  processing: BoundedProcessingInput,
  root: string,
  release: Awaited<ReturnType<typeof buildBoundedServingRelease>>,
  sharedBudget: ProcessWideBoundedBudget,
): Promise<readonly ImmutableBoundedArtifact[]> {
  const manifest = await materializeStageValueArtifact(
    request,
    connection,
    processing,
    'finalize_release',
    'release-manifest',
    0,
    root,
    release.manifest,
    sharedBudget,
  );
  const evidence = await materializeStageValueArtifact(
    request,
    connection,
    processing,
    'finalize_release',
    'release-evidence',
    0,
    root,
    release.evidence,
    sharedBudget,
  );
  return Object.freeze(
    [manifest, evidence].sort((left, right) =>
      compareUtf8(boundedArtifactOrderKey(left), boundedArtifactOrderKey(right)),
    ),
  );
}

async function recordStageArtifact(
  connection: DuckDBConnection,
  artifact: ImmutableBoundedArtifact,
): Promise<void> {
  const existing = await scalarStringOrNull(
    connection,
    `SELECT artifact_json AS value FROM stage_output_artifact WHERE generation_id=${sql(artifact.generationId)} AND stage=${sql(artifact.stage)} AND dataset=${sql(artifact.dataset)} AND partition_id=${artifact.partitionId} AND sequence=${artifact.sequence}`,
  );
  const body = canonicalJson(artifact);
  if (existing !== null) {
    if (existing !== body) {
      throw new BoundedPipelineIntegrityError(
        `Stage artifact identity changed: ${artifact.stage}/${artifact.dataset}/${artifact.partitionId}/${artifact.sequence}`,
      );
    }
    return;
  }
  await connection.run(
    `INSERT INTO stage_output_artifact VALUES (${sql(artifact.generationId)}, ${sql(artifact.stage)}, ${sql(artifact.dataset)}, ${artifact.partitionId}, ${artifact.sequence}, ${sql(body)})`,
  );
}

async function stageArtifacts(
  connection: DuckDBConnection,
  generationId: string,
  stage: BoundedProcessingStage,
  partitionId: number | undefined,
  maximumArtifacts: number,
): Promise<readonly ImmutableBoundedArtifact[]> {
  const artifacts: ImmutableBoundedArtifact[] = [];
  const partition = partitionId === undefined ? '' : ` AND partition_id=${partitionId}`;
  const base = `SELECT hex(dataset) || ':' || hex(json_extract_string(artifact_json,'$.visibility')) || ':' || lpad(CAST(partition_id AS VARCHAR),12,'0') || ':' || lpad(CAST(sequence AS VARCHAR),12,'0') || ':' || hex(json_extract_string(artifact_json,'$.logicalKey')) AS key, artifact_json AS value FROM stage_output_artifact WHERE generation_id=${sql(generationId)} AND stage=${sql(stage)}${partition}`;
  for await (const artifact of streamKeysetJson<ImmutableBoundedArtifact>(
    connection,
    base,
    'key',
  )) {
    if (artifacts.length >= maximumArtifacts) {
      throw new BoundedPackageCapabilityError(
        'BoundedStageManifest.artifacts requires a corpus-proportional array',
      );
    }
    artifacts.push(artifact);
  }
  return Object.freeze(artifacts);
}

function createStageManifest(
  processing: BoundedProcessingInput,
  stage: BoundedProcessingStage,
  artifactsInput: readonly ImmutableBoundedArtifact[],
  completedStages: readonly BoundedProcessingCheckpoint['completedStages'][number][],
): BoundedStageManifest {
  const artifacts = Object.freeze(
    [...artifactsInput].sort((left, right) =>
      compareUtf8(boundedArtifactOrderKey(left), boundedArtifactOrderKey(right)),
    ),
  );
  const grouped = new Map<string, ImmutableBoundedArtifact[]>();
  for (const artifact of artifacts) {
    const values = grouped.get(artifact.dataset) ?? [];
    values.push(artifact);
    grouped.set(artifact.dataset, values);
  }
  const datasets = Object.freeze(
    [...grouped.entries()]
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([dataset, values]) =>
        Object.freeze({
          dataset,
          schemaSha256: requiredSingleIdentity(values, 'schemaSha256'),
          sortKeyVersion: 'bounded-artifact-sort-key-v1',
          recordCount: values.reduce((total, artifact) => total + artifact.recordCount, 0),
          logicalSha256: sha256(
            values.map((artifact) =>
              Object.freeze({
                logicalKey: artifact.logicalKey,
                sha256: artifact.sha256,
                recordCount: artifact.recordCount,
                firstSortKey: artifact.firstSortKey,
                lastSortKey: artifact.lastSortKey,
              }),
            ),
          ),
        }),
      ),
  );
  const completed = new Map(completedStages.map((value) => [value.stage, value]));
  const parents = Object.freeze(
    STAGE_PARENTS[stage].map((parentStage) => {
      const parent = completed.get(parentStage);
      if (parent === undefined) {
        throw new BoundedPipelineIntegrityError(`Stage ${stage} lacks parent ${parentStage}`);
      }
      return Object.freeze({ stage: parentStage, manifestSha256: parent.outputManifestSha256 });
    }),
  );
  const inputLogicalSha256s = Object.freeze(
    [
      ...new Set(
        stage === 'partition_mutations'
          ? [processing.mutationLog.logicalSha256]
          : parents.map(({ manifestSha256 }) => manifestSha256),
      ),
    ].sort(compareUtf8),
  );
  const body = {
    contractVersion: BOUNDED_PROCESSING_CONTRACT_VERSION,
    generationId: processing.generationId,
    stage,
    stageVersion: processing.stageVersions[stage],
    inputLogicalSha256s: [...inputLogicalSha256s],
    parents: [...parents],
    datasets: datasets.map((dataset) => ({ ...dataset })),
    artifacts: artifacts.map((artifact) => ({ ...artifact })),
  };
  return boundedStageManifestSchema.parse({
    ...body,
    manifestSha256: boundedStageManifestSha256(body),
  });
}

async function createRootedStageManifest(
  request: BoundedCountyProcessingRequest,
  connection: DuckDBConnection,
  processing: BoundedProcessingInput,
  stage: BoundedProcessingStage,
  completedStages: readonly BoundedProcessingCheckpoint['completedStages'][number][],
  sharedBudget: ProcessWideBoundedBudget,
  partitionId?: number,
): Promise<BoundedStageManifest> {
  const partitionFilter = partitionId === undefined ? '' : ` AND partition_id=${partitionId}`;
  const firstText = await scalarStringOrNull(
    connection,
    `SELECT artifact_json AS value FROM stage_output_artifact WHERE generation_id=${sql(processing.generationId)} AND stage=${sql(stage)}${partitionFilter} ORDER BY dataset, json_extract_string(artifact_json,'$.visibility'), partition_id, sequence, json_extract_string(artifact_json,'$.logicalKey') LIMIT 1`,
  );
  if (firstText === null)
    throw new BoundedPipelineIntegrityError(`Stage ${stage} has no artifacts`);
  const first = JSON.parse(firstText) as ImmutableBoundedArtifact;
  const inventoryDirectory = confinedChild(
    dirname(artifactPath(request.artifactStore, first)),
    `inventory-${stage}-${partitionId === undefined ? 'complete' : partitionId.toString().padStart(8, '0')}`,
  );
  await mkdir(inventoryDirectory, { recursive: true });
  const pageReferences: {
    page: number;
    uri: string;
    sha256: string;
    descriptorCount: number;
    firstOrderKey: string;
    lastOrderKey: string;
  }[] = [];
  const rootHash = createHash('sha256');
  const datasetStates = new Map<
    string,
    {
      schemaSha256: string;
      artifactCount: number;
      recordCount: number;
      rootHash: ReturnType<typeof createHash>;
      logicalHash: ReturnType<typeof createHash>;
    }
  >();
  const pageLimit = Math.max(1, Math.min(512, processing.budget.maxBufferedRecords));
  let page: ImmutableBoundedArtifact[] = [];
  const pageReleases: (() => void)[] = [];
  let descriptorCount = 0;
  let recordCount = 0;
  let artifactBytes = 0;
  let pageCount = 0;
  let firstOrderKey: string | null = null;
  let lastOrderKey: string | null = null;
  const flushPage = async (): Promise<void> => {
    if (page.length === 0) return;
    const firstArtifact = page[0];
    const lastArtifact = page.at(-1);
    if (firstArtifact === undefined || lastArtifact === undefined) {
      throw new BoundedPipelineIntegrityError('Descriptor inventory page is unexpectedly empty');
    }
    const pageBody = {
      format: 'oracle-bounded-descriptor-page-v1' as const,
      page: pageCount,
      descriptors: page,
    };
    const pageObject = {
      ...pageBody,
      pageSha256: boundedDescriptorPageSha256(pageBody),
    };
    const pageSemanticSha256 = canonicalObjectSha256(pageObject);
    const stored = await persistCanonicalObject(
      request,
      `bi/${generationPath(processing.generationId)}/${stage}/${partitionId ?? 'c'}/p-${pageCount.toString().padStart(8, '0')}.json`,
      pageObject,
    );
    pageReferences.push({
      page: pageCount,
      uri: stored.uri,
      sha256: pageSemanticSha256,
      descriptorCount: page.length,
      firstOrderKey: boundedArtifactOrderKey(firstArtifact),
      lastOrderKey: boundedArtifactOrderKey(lastArtifact),
    });
    pageCount += 1;
    page = [];
    while (pageReleases.length > 0) pageReleases.pop()?.();
  };
  try {
    const base = `SELECT hex(dataset) || ':' || hex(json_extract_string(artifact_json,'$.visibility')) || ':' || lpad(CAST(partition_id AS VARCHAR),12,'0') || ':' || lpad(CAST(sequence AS VARCHAR),12,'0') || ':' || hex(json_extract_string(artifact_json,'$.logicalKey')) AS key, artifact_json AS value FROM stage_output_artifact WHERE generation_id=${sql(processing.generationId)} AND stage=${sql(stage)}${partitionFilter}`;
    for await (const artifact of streamKeysetJson<ImmutableBoundedArtifact>(
      connection,
      base,
      'key',
    )) {
      const line = Buffer.from(`${canonicalJson(artifact)}\n`, 'utf8');
      pageReleases.push(sharedBudget.acquire(1, line.byteLength));
      page.push(artifact);
      descriptorCount += 1;
      recordCount += artifact.recordCount;
      artifactBytes += artifact.byteSize;
      const orderKey = boundedArtifactOrderKey(artifact);
      firstOrderKey ??= orderKey;
      lastOrderKey = orderKey;
      rootHash.update(line);
      const prior = datasetStates.get(artifact.dataset);
      if (prior !== undefined && prior.schemaSha256 !== artifact.schemaSha256) {
        throw new BoundedPipelineIntegrityError(
          `Stage dataset has mixed schemaSha256: ${artifact.dataset}`,
        );
      }
      const state = prior ?? {
        schemaSha256: artifact.schemaSha256,
        artifactCount: 0,
        recordCount: 0,
        rootHash: createHash('sha256'),
        logicalHash: createHash('sha256'),
      };
      state.artifactCount += 1;
      state.recordCount += artifact.recordCount;
      state.rootHash.update(line);
      state.logicalHash.update(
        `${canonicalJson({
          logicalKey: artifact.logicalKey,
          sha256: artifact.sha256,
          recordCount: artifact.recordCount,
          firstSortKey: artifact.firstSortKey,
          lastSortKey: artifact.lastSortKey,
        })}\n`,
      );
      datasetStates.set(artifact.dataset, state);
      if (page.length >= pageLimit) await flushPage();
    }
    await flushPage();
  } finally {
    while (pageReleases.length > 0) pageReleases.pop()?.();
  }
  const indexObject = {
    format: 'oracle-bounded-descriptor-page-index-v1' as const,
    pages: pageReferences,
  };
  const indexSemanticSha256 = canonicalObjectSha256(indexObject);
  const storedIndex = await persistCanonicalObject(
    request,
    `bi/${generationPath(processing.generationId)}/${stage}/${partitionId ?? 'c'}/index.json`,
    indexObject,
  );
  const datasets = [...datasetStates.entries()]
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([dataset, state]) => ({
      dataset,
      schemaSha256: state.schemaSha256,
      sortKeyVersion: 'bounded-artifact-sort-key-v1',
      recordCount: state.recordCount,
      logicalSha256: state.logicalHash.digest('hex'),
    }));
  const inventoryDatasets = [...datasetStates.entries()]
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([dataset, state]) => ({
      dataset,
      artifactCount: state.artifactCount,
      recordCount: state.recordCount,
      rootSha256: state.rootHash.digest('hex'),
    }));
  const completed = new Map(completedStages.map((value) => [value.stage, value]));
  const parents = STAGE_PARENTS[stage].map((parentStage) => {
    const parent = completed.get(parentStage);
    if (parent === undefined)
      throw new BoundedPipelineIntegrityError(`Stage ${stage} lacks parent ${parentStage}`);
    return { stage: parentStage, manifestSha256: parent.outputManifestSha256 };
  });
  const inputLogicalSha256s = [
    ...new Set(
      stage === 'partition_mutations'
        ? [processing.mutationLog.logicalSha256]
        : parents.map(({ manifestSha256 }) => manifestSha256),
    ),
  ].sort(compareUtf8);
  const body = {
    contractVersion: BOUNDED_PROCESSING_CONTRACT_VERSION,
    generationId: processing.generationId,
    stage,
    stageVersion: processing.stageVersions[stage],
    inputLogicalSha256s,
    parents,
    datasets,
    artifacts: [],
    artifactInventory: {
      root: {
        format: 'oracle-bounded-descriptor-root-v1' as const,
        descriptorCount,
        recordCount,
        byteSize: artifactBytes,
        rootSha256: rootHash.digest('hex'),
        firstOrderKey,
        lastOrderKey,
        pageCount,
        pageIndexUri: storedIndex.uri,
        pageIndexSha256: indexSemanticSha256,
      },
      datasets: inventoryDatasets,
    },
  };
  return boundedStageManifestSchema.parse({
    ...body,
    manifestSha256: boundedStageManifestSha256(body),
  });
}

async function adoptLocalFile(
  temporary: string,
  path: string,
  expectedSha256: string,
  expectedBytes: number,
  sharedBudget: ProcessWideBoundedBudget,
  maximumBufferedBytes: number,
): Promise<void> {
  try {
    await rename(temporary, path);
  } catch (error) {
    if (!(await exists(path))) throw error;
    const existing = await hashFile(path, sharedBudget, maximumBufferedBytes);
    if (existing.sha256 !== expectedSha256 || existing.byteSize !== expectedBytes) {
      throw new BoundedPipelineIntegrityError(`Descriptor inventory orphan mismatch: ${path}`);
    }
    await rm(temporary, { force: true });
  }
}

function requiredSingleIdentity(
  artifacts: readonly ImmutableBoundedArtifact[],
  key: 'schemaSha256',
): string {
  const values = [...new Set(artifacts.map((artifact) => artifact[key]))];
  if (values.length !== 1 || values[0] === undefined) {
    throw new BoundedPipelineIntegrityError(`Stage dataset has mixed ${key}`);
  }
  return values[0];
}

async function persistStageManifest(
  request: BoundedCountyProcessingRequest,
  connection: DuckDBConnection,
  processing: BoundedProcessingInput,
  manifest: BoundedStageManifest,
  partitionId: number | null,
): Promise<void> {
  const body = canonicalJson(manifest);
  const table = partitionId === null ? 'stage_manifest' : 'stage_unit_manifest';
  const selector =
    partitionId === null
      ? `generation_id=${sql(processing.generationId)} AND stage=${sql(manifest.stage)}`
      : `generation_id=${sql(processing.generationId)} AND stage=${sql(manifest.stage)} AND partition_id=${partitionId}`;
  const existing = await scalarStringOrNull(
    connection,
    `SELECT manifest_json AS value FROM ${table} WHERE ${selector}`,
  );
  if (existing !== null && existing !== body)
    assertStageManifestExtension(
      boundedStageManifestSchema.parse(JSON.parse(existing)),
      manifest,
      partitionId,
    );
  if (existing === null) {
    const values =
      partitionId === null
        ? `${sql(processing.generationId)}, ${sql(manifest.stage)}, ${sql(body)}, ${sql(manifest.manifestSha256)}`
        : `${sql(processing.generationId)}, ${sql(manifest.stage)}, ${partitionId}, ${sql(body)}, ${sql(manifest.manifestSha256)}`;
    await connection.run(`INSERT INTO ${table} VALUES (${values})`);
  } else if (existing !== body) {
    await connection.run(
      `UPDATE ${table} SET manifest_json=${sql(body)}, manifest_sha256=${sql(manifest.manifestSha256)} WHERE ${selector}`,
    );
  }
  const bytes = new TextEncoder().encode(`${body}\n`);
  // Keep object keys short enough for local Windows stores while the signed body binds
  // generation, stage, unit, parents, and all output identities.
  const logicalKey = `bsm/${manifest.manifestSha256}.json`;
  const write = {
    logicalKey,
    mediaType: 'application/json',
    body: oneSegment(bytes),
    expectedSha256: createHash('sha256').update(bytes).digest('hex'),
    metadata: Object.freeze({
      generationId: processing.generationId,
      stage: manifest.stage,
      manifestSha256: manifest.manifestSha256,
      manifestKind: partitionId === null ? 'stage' : 'stage_unit',
    }),
    ifAbsent: true as const,
  };
  try {
    await request.artifactStore.putImmutableStreaming(write);
  } catch (error) {
    const orphan = await request.artifactStore.headByLogicalKey(logicalKey);
    if (orphan?.sha256 !== write.expectedSha256 || orphan.byteSize !== bytes.byteLength)
      throw error;
  }
}

function assertStageManifestExtension(
  previous: BoundedStageManifest,
  next: BoundedStageManifest,
  partitionId: number | null,
): void {
  const identity = `${next.stage}/${partitionId ?? 'complete'}`;
  if (
    previous.generationId !== next.generationId ||
    previous.stage !== next.stage ||
    previous.stageVersion !== next.stageVersion ||
    canonicalJson(previous.parents) !== canonicalJson(next.parents) ||
    canonicalJson(previous.inputLogicalSha256s) !== canonicalJson(next.inputLogicalSha256s)
  ) {
    throw new BoundedPipelineIntegrityError(`Stage manifest identity changed: ${identity}`);
  }
  if (previous.artifactInventory !== undefined || next.artifactInventory !== undefined) {
    throw new BoundedPipelineIntegrityError(
      `Rooted stage unit cannot be incrementally replaced: ${identity}`,
    );
  }
  if (
    previous.artifacts.length > next.artifacts.length ||
    canonicalJson(previous.artifacts) !==
      canonicalJson(next.artifacts.slice(0, previous.artifacts.length))
  ) {
    throw new BoundedPipelineIntegrityError(`Stage artifact prefix changed: ${identity}`);
  }
  const nextDatasets = new Map(next.datasets.map((dataset) => [dataset.dataset, dataset]));
  for (const priorDataset of previous.datasets) {
    const nextDataset = nextDatasets.get(priorDataset.dataset);
    if (nextDataset === undefined) {
      throw new BoundedPipelineIntegrityError(`Stage dataset prefix changed: ${identity}`);
    }
    if (
      nextDataset.schemaSha256 !== priorDataset.schemaSha256 ||
      nextDataset.sortKeyVersion !== priorDataset.sortKeyVersion ||
      nextDataset.recordCount < priorDataset.recordCount
    ) {
      throw new BoundedPipelineIntegrityError(`Stage dataset prefix changed: ${identity}`);
    }
  }
}

async function commitBoundedProgress(
  request: BoundedCountyProcessingRequest,
  connection: DuckDBConnection,
  processing: BoundedProcessingInput,
  stage: BoundedProcessingStage,
  sharedBudget: ProcessWideBoundedBudget,
): Promise<void> {
  const { scope, current, checkpoint: prior } = await loadBoundedCheckpoint(request, processing);
  const completed = prior.completedStages.find((value) => value.stage === stage);
  if (completed !== undefined) {
    const storedHash = await scalarStringOrNull(
      connection,
      `SELECT manifest_sha256 AS value FROM stage_manifest WHERE generation_id=${sql(processing.generationId)} AND stage=${sql(stage)}`,
    );
    if (storedHash !== completed.outputManifestSha256) {
      throw new BoundedPipelineIntegrityError(`Completed stage manifest drifted: ${stage}`);
    }
    await verifyCompletedStage(request, connection, processing, stage, sharedBudget);
    return;
  }
  const stageIndex = processingStageIndex(stage);
  if (prior.completedStages.length !== stageIndex) {
    throw new BoundedPipelineIntegrityError(`Bounded CAS checkpoint skipped stage ${stage}`);
  }
  if (prior.activeCursor !== null || prior.orphanCandidate !== null) {
    throw new BoundedPipelineIntegrityError(`Stage ${stage} retains an unadopted cursor/orphan`);
  }
  if (prior.durablePartitions.length === 0) {
    throw new BoundedPipelineIntegrityError(`Stage ${stage} has no durable unit ledger`);
  }
  const artifactCount = await scalarCount(
    connection,
    `SELECT count(*)::BIGINT AS value FROM stage_output_artifact WHERE generation_id=${sql(processing.generationId)} AND stage=${sql(stage)}`,
  );
  const manifest =
    artifactCount > BOUNDED_MAX_STAGE_ARTIFACTS
      ? await createRootedStageManifest(
          request,
          connection,
          processing,
          stage,
          prior.completedStages,
          sharedBudget,
        )
      : createStageManifest(
          processing,
          stage,
          await stageArtifacts(
            connection,
            processing.generationId,
            stage,
            undefined,
            BOUNDED_MAX_STAGE_ARTIFACTS,
          ),
          prior.completedStages,
        );
  await persistStageManifest(request, connection, processing, manifest, null);
  await verifyStageManifestClosure(request, manifest, processing, sharedBudget);
  const partitionLedgerManifestSha256 = sha256({
    schemaVersion: 'bounded-stage-partition-ledger-v1',
    generationId: processing.generationId,
    stage,
    entries: prior.durablePartitions,
  });
  const next = withCheckpointHash({
    ...prior,
    expectedRevision: current?.revision ?? null,
    durablePartitions: [],
    activeCursor: null,
    orphanCandidate: null,
    completedStages: [
      ...prior.completedStages,
      {
        stage,
        outputManifestSha256: manifest.manifestSha256,
        partitionLedgerManifestSha256,
        partitionCount: processing.partitionPlan.partitionCount,
      },
    ],
  });
  await commitBoundedCheckpoint(request, scope, current?.revision ?? null, next);
}

async function verifyCompletedStage(
  request: BoundedCountyProcessingRequest,
  connection: DuckDBConnection,
  processing: BoundedProcessingInput,
  stage: BoundedProcessingStage,
  sharedBudget: ProcessWideBoundedBudget,
): Promise<void> {
  const text = await scalarStringOrNull(
    connection,
    `SELECT manifest_json AS value FROM stage_manifest WHERE generation_id=${sql(processing.generationId)} AND stage=${sql(stage)}`,
  );
  if (text === null) {
    throw new BoundedPipelineIntegrityError(`Completed stage manifest is missing: ${stage}`);
  }
  await verifyStageManifestClosure(
    request,
    boundedStageManifestSchema.parse(JSON.parse(text)),
    processing,
    sharedBudget,
  );
}

async function verifyStageManifestClosure(
  request: BoundedCountyProcessingRequest,
  manifest: BoundedStageManifest,
  processing: BoundedProcessingInput,
  sharedBudget: ProcessWideBoundedBudget,
): Promise<void> {
  const persisted = await request.artifactStore.headByLogicalKey(
    `bsm/${manifest.manifestSha256}.json`,
  );
  if (persisted === undefined) {
    throw new BoundedPipelineIntegrityError(`Stage manifest object is missing: ${manifest.stage}`);
  }
  const loaded = await loadStoredJson(
    request,
    persisted.uri,
    sharedBudget,
    processing.budget.maxBufferedBytes,
  );
  if (canonicalJson(loaded) !== canonicalJson(manifest)) {
    throw new BoundedPipelineIntegrityError(`Stage manifest object changed: ${manifest.stage}`);
  }
  if (manifest.artifactInventory == null) {
    for (const artifact of manifest.artifacts) {
      await verifyDurableArtifact(request, artifact, processing, sharedBudget);
    }
    return;
  }
  const inventory = streamVerifiedBoundedDescriptorInventory({
    root: manifest.artifactInventory.root,
    resolver: descriptorPageResolver(request, sharedBudget, processing.budget.maxBufferedBytes),
    parseDescriptor: (value) => immutableBoundedArtifactSchema.parse(value),
    orderKey: boundedArtifactOrderKey,
    recordCount: (artifact) => artifact.recordCount,
    byteSize: (artifact) => artifact.byteSize,
  });
  for await (const artifact of inventory.descriptors) {
    await verifyDurableArtifact(request, artifact, processing, sharedBudget);
  }
  await inventory.completion;
}

async function loadStoredJson(
  request: BoundedCountyProcessingRequest,
  uri: string,
  sharedBudget: ProcessWideBoundedBudget,
  maximumBytes: number,
): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  const releases: (() => void)[] = [];
  let bytes = 0;
  try {
    for await (const chunk of request.artifactStore.read(uri)) {
      bytes += chunk.byteLength;
      if (bytes > maximumBytes) {
        throw new BoundedPipelineBudgetError('Stored JSON exceeds byte budget');
      }
      releases.push(sharedBudget.acquire(0, chunk.byteLength));
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown;
  } finally {
    while (releases.length > 0) releases.pop()?.();
  }
}

async function verifyDurableArtifact(
  request: BoundedCountyProcessingRequest,
  artifact: ImmutableBoundedArtifact,
  processing: BoundedProcessingInput,
  sharedBudget: ProcessWideBoundedBudget,
): Promise<void> {
  const head = await request.artifactStore.head(artifact.uri);
  if (
    head?.logicalKey !== artifact.logicalKey ||
    head.sha256 !== artifact.sha256 ||
    head.byteSize !== artifact.byteSize
  ) {
    throw new BoundedPipelineIntegrityError(
      `Durable stage artifact changed: ${artifact.logicalKey}`,
    );
  }
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of request.artifactStore.read(artifact.uri)) {
    if (chunk.byteLength > processing.budget.maxBufferedBytes) {
      throw new BoundedPipelineBudgetError('Durable artifact segment exceeds byte budget');
    }
    const release = sharedBudget.acquire(0, chunk.byteLength);
    try {
      hash.update(chunk);
      bytes += chunk.byteLength;
    } finally {
      release();
    }
  }
  if (bytes !== artifact.byteSize || hash.digest('hex') !== artifact.sha256) {
    throw new BoundedPipelineIntegrityError(
      `Durable stage artifact bytes changed: ${artifact.logicalKey}`,
    );
  }
}

async function commitBoundedUnit(
  request: BoundedCountyProcessingRequest,
  connection: DuckDBConnection,
  processing: BoundedProcessingInput,
  stage: BoundedProcessingStage,
  partitionId: number,
  ledgerEntryCount: number,
  artifacts: readonly ImmutableBoundedArtifact[] | undefined,
  sharedBudget?: ProcessWideBoundedBudget,
): Promise<void> {
  const { scope, current, checkpoint: prior } = await loadBoundedCheckpoint(request, processing);
  if (prior.completedStages.length !== processingStageIndex(stage)) {
    if (prior.completedStages.some((value) => value.stage === stage)) return;
    throw new BoundedPipelineIntegrityError(`Durable unit belongs to skipped stage ${stage}`);
  }
  const storedArtifactCount =
    artifacts === undefined
      ? await scalarCount(
          connection,
          `SELECT count(*)::BIGINT AS value FROM stage_output_artifact WHERE generation_id=${sql(processing.generationId)} AND stage=${sql(stage)} AND partition_id=${partitionId}`,
        )
      : artifacts.length;
  if (storedArtifactCount > BOUNDED_MAX_STAGE_ARTIFACTS && sharedBudget === undefined) {
    throw new BoundedPipelineIntegrityError('Rooted stage unit requires shared budget');
  }
  const manifest =
    storedArtifactCount > BOUNDED_MAX_STAGE_ARTIFACTS
      ? await createRootedStageManifest(
          request,
          connection,
          processing,
          stage,
          prior.completedStages,
          requiredSharedBudget(sharedBudget),
          partitionId,
        )
      : createStageManifest(
          processing,
          stage,
          artifacts ??
            (await stageArtifacts(
              connection,
              processing.generationId,
              stage,
              partitionId,
              BOUNDED_MAX_STAGE_ARTIFACTS,
            )),
          prior.completedStages,
        );
  await persistStageManifest(request, connection, processing, manifest, partitionId);
  const durable = {
    stage,
    partitionId,
    ledgerEntryCount,
    partitionLedgerManifestSha256: sha256({
      schemaVersion: 'bounded-stage-unit-ledger-v1',
      generationId: processing.generationId,
      stage,
      partitionId,
      ledgerEntryCount,
      outputManifestSha256: manifest.manifestSha256,
    }),
    logicalOutputIdentitySha256: processing.logicalOutputIdentitySha256,
    outputManifestSha256: manifest.manifestSha256,
  };
  const existing = prior.durablePartitions.find((value) => value.partitionId === partitionId);
  if (existing !== undefined && canonicalJson(existing) === canonicalJson(durable)) return;
  if (
    existing !== undefined &&
    (existing.stage !== durable.stage ||
      existing.logicalOutputIdentitySha256 !== durable.logicalOutputIdentitySha256 ||
      existing.ledgerEntryCount > durable.ledgerEntryCount)
  ) {
    throw new BoundedPipelineIntegrityError(
      `Durable unit identity changed: ${stage}/${partitionId}`,
    );
  }
  const durablePartitions = [
    ...prior.durablePartitions.filter((value) => value.partitionId !== partitionId),
    durable,
  ].sort((a, b) => a.partitionId - b.partitionId);
  const next = withCheckpointHash({
    ...prior,
    expectedRevision: current?.revision ?? null,
    durablePartitions,
    activeCursor: null,
    orphanCandidate: null,
  });
  await commitBoundedCheckpoint(request, scope, current?.revision ?? null, next);
}

function requiredSharedBudget(
  value: ProcessWideBoundedBudget | undefined,
): ProcessWideBoundedBudget {
  if (value === undefined) {
    throw new BoundedPipelineIntegrityError('Rooted stage unit requires shared budget');
  }
  return value;
}

async function commitFeatureOrphan(
  request: BoundedCountyProcessingRequest,
  connection: DuckDBConnection,
  processing: BoundedProcessingInput,
  artifact: ImmutableBoundedArtifact,
): Promise<void> {
  const { scope, current, checkpoint: prior } = await loadBoundedCheckpoint(request, processing);
  if (prior.completedStages.length !== processingStageIndex('derive_features')) {
    if (prior.completedStages.some(({ stage }) => stage === 'derive_features')) return;
    throw new BoundedPipelineIntegrityError('Feature orphan belongs to a stale stage');
  }
  const outputBefore = await scalarRow(
    connection,
    `SELECT coalesce(sum(CAST(json_extract(artifact_json,'$.recordCount') AS BIGINT)),0)::BIGINT AS records, coalesce(sum(CAST(json_extract(artifact_json,'$.byteSize') AS BIGINT)),0)::BIGINT AS bytes FROM feature_artifact WHERE generation_id=${sql(processing.generationId)} AND partition_id=${artifact.partitionId} AND sequence<${artifact.sequence}`,
  );
  const inputStart = numberValue(outputBefore?.records ?? 0);
  const inputEnd = inputStart + artifact.recordCount - 1;
  const first = await scalarRow(
    connection,
    `SELECT sort_key, content_sha256 FROM feature_input_cursor WHERE generation_id=${sql(processing.generationId)} AND partition_id=${artifact.partitionId} AND ordinal=${inputStart}`,
  );
  const last = await scalarRow(
    connection,
    `SELECT sort_key FROM feature_input_cursor WHERE generation_id=${sql(processing.generationId)} AND partition_id=${artifact.partitionId} AND ordinal=${inputEnd}`,
  );
  if (first === null || last === null)
    throw new BoundedPipelineIntegrityError('Feature orphan lacks exact input cursor identities');
  const previousText =
    artifact.sequence === 0
      ? null
      : await scalarStringOrNull(
          connection,
          `SELECT artifact_json AS value FROM feature_artifact WHERE generation_id=${sql(processing.generationId)} AND partition_id=${artifact.partitionId} AND sequence=${artifact.sequence - 1}`,
        );
  const previous =
    previousText === null ? null : (JSON.parse(previousText) as ImmutableBoundedArtifact);
  const priorFeatureCheckpointText = await scalarStringOrNull(
    connection,
    `SELECT summary_json AS value FROM stage_partition WHERE generation_id=${sql(processing.generationId)} AND stage='derive_features' AND partition_id=${artifact.partitionId}`,
  );
  const prefix =
    priorFeatureCheckpointText === null
      ? HASH_EMPTY
      : stringValue(
          (JSON.parse(priorFeatureCheckpointText) as Readonly<Record<string, unknown>>)
            .logicalPrefixSha256,
        );
  const activeCursor = {
    stage: 'derive_features' as const,
    partitionId: artifact.partitionId,
    inputSortKey: Buffer.from(stringValue(first.sort_key), 'hex').toString('utf8'),
    inputContentSha256: stringValue(first.content_sha256),
    inputOrdinal: inputStart,
    outputOrdinal: inputStart,
    durableChunkCount: artifact.sequence,
    outputRecordCount: inputStart,
    outputByteCount: numberValue(outputBefore?.bytes ?? 0),
    logicalPrefixSha256: prefix,
    lastDurableArtifact: previous,
  };
  const orphanCandidate = {
    artifact,
    exactInputInterval: {
      firstOrdinal: inputStart,
      lastOrdinal: inputEnd,
      firstSortKey: Buffer.from(stringValue(first.sort_key), 'hex').toString('utf8'),
      lastSortKey: Buffer.from(stringValue(last.sort_key), 'hex').toString('utf8'),
      firstContentSha256: stringValue(first.content_sha256),
      logicalPrefixSha256: prefix,
      outputRecordCount: artifact.recordCount,
      outputByteCount: artifact.byteSize,
    },
    expectedStageManifestSha256: createStageManifest(
      processing,
      'derive_features',
      await stageArtifacts(
        connection,
        processing.generationId,
        'derive_features',
        artifact.partitionId,
        BOUNDED_MAX_STAGE_ARTIFACTS,
      ),
      prior.completedStages,
    ).manifestSha256,
  };
  if (prior.orphanCandidate !== null) {
    if (
      canonicalJson(prior.orphanCandidate) !== canonicalJson(orphanCandidate) ||
      canonicalJson(prior.activeCursor) !== canonicalJson(activeCursor)
    ) {
      throw new BoundedPipelineIntegrityError('Feature orphan adoption identity changed');
    }
    return;
  }
  const next = withCheckpointHash({
    ...prior,
    expectedRevision: current?.revision ?? null,
    activeCursor,
    orphanCandidate,
  });
  await commitBoundedCheckpoint(request, scope, current?.revision ?? null, next);
}

async function commitBoundedFinalization(
  request: BoundedCountyProcessingRequest,
  processing: BoundedProcessingInput,
  release: Awaited<ReturnType<typeof buildBoundedServingRelease>>,
  finalizationExpectedRevision: string,
): Promise<void> {
  const { scope, current, checkpoint: prior } = await loadBoundedCheckpoint(request, processing);
  if (prior.finalization !== null) {
    if (
      prior.finalization.releaseManifestSha256 !== release.manifest.manifestSha256 ||
      prior.finalization.releaseEvidenceSha256 !== release.evidence.evidenceSha256
    )
      throw new BoundedPipelineIntegrityError('Finalization winner changed across resume');
    return;
  }
  if (current === undefined) {
    throw new BoundedPipelineIntegrityError(
      'Finalization requires a durable build_marts CAS winner',
    );
  }
  const finalization = {
    state: 'verified' as const,
    releaseManifestSha256: release.manifest.manifestSha256,
    releaseEvidenceSha256: release.evidence.evidenceSha256,
    destinationIdentitySha256: sha256({
      releaseId: release.manifest.releaseId,
      contractVersion: release.manifest.contractVersion,
      generationId: processing.generationId,
      releaseManifestSha256: release.manifest.manifestSha256,
      releaseEvidenceSha256: release.evidence.evidenceSha256,
      artifacts: release.manifest.artifacts.map((artifact) => ({
        visibility: artifact.visibility,
        relation: artifact.relation,
        relativePath: artifact.relativePath,
        sha256: artifact.sha256,
        rowCount: artifact.rowCount,
      })),
    }),
    winnerGenerationId: processing.generationId,
    winnerManifestSha256: release.manifest.manifestSha256,
    winnerCasRevision: finalizationExpectedRevision,
  };
  const next = withCheckpointHash({
    ...prior,
    expectedRevision: current.revision,
    finalization,
  });
  await commitBoundedCheckpoint(request, scope, current.revision, next);
}

async function promoteBoundedFinalization(
  request: BoundedCountyProcessingRequest,
  processing: BoundedProcessingInput,
  adoptedIdenticalWinner: boolean,
): Promise<void> {
  const { scope, current, checkpoint: prior } = await loadBoundedCheckpoint(request, processing);
  if (current === undefined || prior.finalization === null) {
    throw new BoundedPipelineIntegrityError('Finalization promotion lacks a verified CAS winner');
  }
  const state = adoptedIdenticalWinner
    ? ('adopted_identical_winner' as const)
    : ('promoted' as const);
  if (prior.finalization.state !== 'verified') return;
  const next = withCheckpointHash({
    ...prior,
    expectedRevision: current.revision,
    finalization: { ...prior.finalization, state },
  });
  await commitBoundedCheckpoint(request, scope, current.revision, next);
}

async function loadBoundedCheckpoint(
  request: BoundedCountyProcessingRequest,
  processing: BoundedProcessingInput,
): Promise<
  Readonly<{
    scope: string;
    current: CheckpointEnvelope | undefined;
    checkpoint: BoundedProcessingCheckpoint;
  }>
> {
  const scope = `bounded-processing:${processing.runId}:${processing.generationId}`;
  const current = await request.checkpointStore.load(scope);
  if (current !== undefined) {
    return Object.freeze({
      scope,
      current,
      checkpoint: assertCheckpointMatchesInput(current.payload, processing),
    });
  }
  const initial = withCheckpointHash({
    schemaVersion: 'oracle-bounded-processing-checkpoint-v1' as const,
    generationId: processing.generationId,
    generationSpecSha256: boundedGenerationSpecSha256(processing),
    expectedRevision: null,
    physicalInputManifestSha256: processing.mutationLog.physicalManifestSha256,
    releaseIdentitySha256: releaseIdentitySha256(processing.release),
    logicalOutputIdentitySha256: processing.logicalOutputIdentitySha256,
    partitionPlanSha256: partitionPlanSha256(processing.partitionPlan),
    budgetPolicySha256: budgetPolicySha256(processing.budget),
    stageVersionsSha256: stageVersionsSha256(processing.stageVersions),
    durablePartitions: [],
    activeCursor: null,
    orphanCandidate: null,
    completedStages: [],
    finalization: null,
  });
  return Object.freeze({ scope, current, checkpoint: initial });
}

function withCheckpointHash(
  value: Omit<BoundedProcessingCheckpoint, 'checkpointSha256'>,
): BoundedProcessingCheckpoint {
  return Object.freeze({
    ...value,
    checkpointSha256: boundedProcessingCheckpointSha256(value),
  });
}

async function commitBoundedCheckpoint(
  request: BoundedCountyProcessingRequest,
  scope: string,
  expectedRevision: string | null,
  payload: BoundedProcessingCheckpoint,
): Promise<void> {
  const envelope = createCheckpointEnvelope({
    scope,
    previousRevision: expectedRevision,
    writtenAt: request.clock.now(),
    payload,
  });
  const result = await request.checkpointStore.commit({ expectedRevision, checkpoint: envelope });
  if (result.status === 'conflict')
    throw new BoundedPipelineIntegrityError('Bounded checkpoint CAS conflict');
}

function processingStageIndex(stage: BoundedProcessingStage): number {
  const stages: readonly BoundedProcessingStage[] = [
    'partition_mutations',
    'reduce_canonical',
    'build_link_index',
    'reconcile_links',
    'derive_features',
    'build_marts',
    'finalize_release',
  ];
  return stages.indexOf(stage);
}

async function* oneSegment(value: Uint8Array): AsyncIterable<Uint8Array> {
  yield await Promise.resolve(value);
}

async function* emptyAsync<T>(): AsyncIterable<T> {
  yield* await Promise.resolve([] as T[]);
}

async function* streamKeysetJson<T>(
  connection: DuckDBConnection,
  base: string,
  _keyColumn: string,
  maximumRows = Number.MAX_SAFE_INTEGER,
): AsyncIterable<T> {
  let last: string | null = null;
  const limit = maximumRows === Number.MAX_SAFE_INTEGER ? '' : ` LIMIT ${maximumRows}`;
  for await (const row of streamRows(
    connection,
    `SELECT key, value FROM (${base}) bounded_stream ORDER BY key${limit}`,
  )) {
    const key = stringValue(row.key);
    const value = stringValue(row.value);
    if (last !== null && compareUtf8(key, last) <= 0)
      throw new BoundedPipelineIntegrityError('DuckDB keyset cursor is not strictly ordered');
    last = key;
    yield JSON.parse(value) as T;
  }
}

async function* streamRows(
  connection: DuckDBConnection,
  statement: string,
): AsyncIterable<Readonly<Record<string, unknown>>> {
  const result = await connection.stream(statement);
  for await (const batch of result.yieldRowObjectJs()) {
    for (const row of batch) yield row;
  }
}

async function scalarRow(
  connection: DuckDBConnection,
  statement: string,
): Promise<Readonly<Record<string, unknown>> | null> {
  const result = await connection.stream(statement);
  let selected: Readonly<Record<string, unknown>> | null = null;
  for await (const batch of result.yieldRowObjectJs()) {
    for (const row of batch) {
      if (selected !== null)
        throw new BoundedPipelineIntegrityError('Bounded scalar query returned more than one row');
      selected = row;
    }
  }
  return selected;
}

async function scalarStringOrNull(
  connection: DuckDBConnection,
  statement: string,
): Promise<string | null> {
  const row = await scalarRow(connection, statement);
  if (row === null) return null;
  return stringValue(row.value);
}

async function scalarCount(connection: DuckDBConnection, statement: string): Promise<number> {
  const row = await scalarRow(connection, statement);
  if (row === null) throw new BoundedPipelineIntegrityError('Count query returned no row');
  return numberValue(row.value);
}

function stringValue(value: unknown): string {
  if (typeof value !== 'string')
    throw new BoundedPipelineIntegrityError('Expected a string from bounded DuckDB query');
  return value;
}

function numberValue(value: unknown): number {
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) {
    throw new BoundedPipelineIntegrityError(
      'Expected a non-negative safe integer from bounded DuckDB query',
    );
  }
  return number;
}

function finiteNumberValue(value: unknown): number {
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) {
    throw new BoundedPipelineIntegrityError('Expected a finite number from bounded DuckDB query');
  }
  return number;
}

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function canonicalObjectSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function normalizeBoundedIndexValue(value: string): string {
  return normalizeIndexValue(value);
}

function normalizeIndexValue(value: string): string {
  return value.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

export function boundedCandidateAddressNumber(value: string): string | null {
  return candidateAddressNumber(normalizeIndexValue(value));
}

function candidateAddressNumber(normalizedAddress: string): string | null {
  return /\b\d+[a-z]?\b/u.exec(normalizedAddress)?.[0] ?? null;
}

function confinedRunRoot(root: string, runId: string): string {
  return confinedChild(root, createHash('sha256').update(runId).digest('hex'));
}

function generationPath(generationId: string): string {
  const value = generationId.slice(generationId.lastIndexOf(':') + 1);
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new BoundedPipelineIntegrityError('Generation identifier is not path-safe');
  }
  return value.slice(0, 32);
}

export function boundedDuckDbTemporaryDirectory(
  scratchRoot: string,
  runId: string,
  generationId: string,
): string {
  generationPath(generationId);
  return confinedChild(
    scratchRoot,
    `.t-${sha256({
      contractVersion: 'oracle-bounded-duckdb-temporary-directory-v1',
      generationId,
      runId,
    })}`,
  );
}

async function removeDuckDbTemporaryDirectory(path: string): Promise<void> {
  await rm(path, {
    force: true,
    // Windows holds DuckDB spill files open transiently - an on-access antivirus
    // scanner is the usual culprit - and unlink then fails EBUSY/EPERM. The prior
    // budget (5 x 50ms linear backoff, about 0.75s total) was far too short for a
    // scanner working through a multi-hundred-MB spill file. Node applies
    // retryDelay * attempt, so this is roughly 14s of patience.
    maxRetries: process.platform === 'win32' ? 10 : 0,
    recursive: true,
    retryDelay: 250,
  });
}

/**
 * Cleanup variant for the teardown path, which MUST NOT be able to fail the run.
 *
 * removeDuckDbTemporaryDirectory is invoked from a `finally` after the pipeline
 * has already produced (or failed to produce) its result. A throw there replaces
 * the real outcome: a transient EBUSY on a temp file could discard the terminal
 * manifest of a multi-hour county run, or mask the genuine error that caused the
 * failure. A leftover temp directory is enormously less costly than either, and
 * the next run removes it up front anyway.
 *
 * The pre-open call deliberately keeps the strict variant: if a stale temp
 * directory cannot be removed BEFORE work starts, that is a real problem and
 * should stop the run.
 */
async function removeDuckDbTemporaryDirectoryBestEffort(path: string): Promise<void> {
  try {
    await removeDuckDbTemporaryDirectory(path);
  } catch (error) {
    process.stderr.write(
      `warning: could not remove DuckDB temporary directory ${path}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

function confinedChild(root: string, child: string): string {
  const base = resolve(root);
  const candidate = resolve(base, child);
  const relation = relative(base, candidate);
  if (relation.startsWith('..') || candidate === base)
    throw new BoundedPipelineIntegrityError(`Path escapes bounded root: ${child}`);
  return candidate;
}

function portableRelative(root: string, child: string): string {
  const value = relative(resolve(root), resolve(child)).replaceAll('\\', '/');
  if (value.startsWith('..') || value.length === 0)
    throw new BoundedPipelineIntegrityError('Release escaped output root');
  return value;
}

function artifactPath(
  artifactStore: BoundedCountyProcessingRequest['artifactStore'],
  artifact: ImmutableBoundedArtifact,
): string {
  let uri = artifact.uri;
  const portable = new URL(uri);
  if (portable.protocol === 'file:' && portable.hostname === 'oracle-artifact') {
    const physicalUri = (artifactStore as { physicalUri?: unknown }).physicalUri;
    if (typeof physicalUri !== 'function') {
      throw new BoundedPipelineIntegrityError(
        'Portable local artifact store cannot resolve a physical artifact URI',
      );
    }
    uri = (physicalUri as (value: string) => string).call(artifactStore, uri);
  }
  const parsed = new URL(uri);
  if (parsed.protocol !== 'file:')
    throw new BoundedPipelineIntegrityError(`Expected file artifact: ${artifact.uri}`);
  if (parsed.hostname === 'oracle-artifact') {
    throw new BoundedPipelineIntegrityError(
      'Portable artifact URI did not resolve to physical storage',
    );
  }
  return fileURLToPath(parsed);
}

async function* readNdjsonFile(
  path: string,
  maximumLineBytes: number,
  sharedBudget: ProcessWideBoundedBudget,
): AsyncIterable<unknown> {
  let pending = Buffer.alloc(0);
  let releasePending = (): void => undefined;
  const highWaterMark = Math.max(1, Math.min(64 * 1024, Math.floor(maximumLineBytes / 8)));
  const releaseStream = sharedBudget.acquire(0, highWaterMark);
  try {
    for await (const chunk of createReadStream(path, { highWaterMark })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const releaseChunk = sharedBudget.acquire(0, bytes.byteLength);
      const combinedBytes = pending.byteLength + bytes.byteLength;
      const releaseCombined = sharedBudget.acquire(0, combinedBytes);
      const combined = Buffer.concat([pending, bytes], combinedBytes);
      releasePending();
      releaseChunk();
      let start = 0;
      try {
        for (let index = 0; index < combined.byteLength; index += 1) {
          if (combined[index] !== 10) continue;
          const line = combined.subarray(start, index);
          start = index + 1;
          if (line.byteLength > maximumLineBytes) {
            throw new BoundedPipelineBudgetError('NDJSON row exceeds byte budget');
          }
          if (line.byteLength > 0) {
            const releaseRow = sharedBudget.acquire(1, line.byteLength * 2);
            try {
              yield JSON.parse(line.toString('utf8')) as unknown;
            } finally {
              releaseRow();
            }
          }
        }
        const remainder = Buffer.from(combined.subarray(start));
        if (remainder.byteLength > maximumLineBytes) {
          throw new BoundedPipelineBudgetError('NDJSON row exceeds byte budget');
        }
        const nextReleasePending = sharedBudget.acquire(0, remainder.byteLength);
        pending = remainder;
        releasePending = nextReleasePending;
      } finally {
        releaseCombined();
      }
    }
    if (pending.byteLength !== 0) {
      throw new BoundedPipelineIntegrityError('NDJSON artifact lacks trailing LF');
    }
  } finally {
    releasePending();
    releaseStream();
  }
}

/** Reads one value at a time while the feature package holds the pre-acquired input lease. */
async function* readReservedNdjsonFile(
  path: string,
  maximumLineBytes: number,
): AsyncIterable<unknown> {
  let pending = Buffer.alloc(0);
  const highWaterMark = Math.max(1, Math.min(64 * 1024, maximumLineBytes));
  for await (const chunk of createReadStream(path, { highWaterMark })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const combined =
      pending.byteLength === 0
        ? bytes
        : Buffer.concat([pending, bytes], pending.byteLength + bytes.byteLength);
    let start = 0;
    for (let index = 0; index < combined.byteLength; index += 1) {
      if (combined[index] !== 10) continue;
      const line = combined.subarray(start, index);
      if (line.byteLength > maximumLineBytes) {
        throw new BoundedPipelineBudgetError('Reserved feature input row exceeds byte budget');
      }
      if (line.byteLength > 0) yield JSON.parse(line.toString('utf8')) as unknown;
      start = index + 1;
    }
    pending = Buffer.from(combined.subarray(start));
    if (pending.byteLength > maximumLineBytes) {
      throw new BoundedPipelineBudgetError('Reserved feature input row exceeds byte budget');
    }
  }
  if (pending.byteLength !== 0) {
    throw new BoundedPipelineIntegrityError('Reserved feature input spool lacks final newline');
  }
}

async function hashFile(
  path: string,
  sharedBudget: ProcessWideBoundedBudget,
  maximumBufferedBytes: number,
  alreadyLeased = false,
): Promise<Readonly<{ byteSize: number; sha256: string }>> {
  const file = await stat(path);
  const hash = createHash('sha256');
  const highWaterMark = Math.max(1, Math.min(64 * 1024, Math.floor(maximumBufferedBytes / 4)));
  for await (const chunk of createReadStream(path, { highWaterMark })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const release = alreadyLeased ? null : sharedBudget.acquire(0, bytes.byteLength);
    try {
      hash.update(bytes);
    } finally {
      release?.();
    }
  }
  return Object.freeze({ byteSize: file.size, sha256: hash.digest('hex') });
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
  );
}

export class BoundedPipelineIntegrityError extends Error {
  public readonly code = 'BOUNDED_INPUT_INTEGRITY' as const;
}

export class BoundedPipelineMixedGenerationError extends Error {
  public readonly code = 'BOUNDED_MIXED_GENERATION' as const;
  public constructor() {
    super('Bounded processing workspace belongs to a different exact generation');
    this.name = 'BoundedPipelineMixedGenerationError';
  }
}

export class BoundedPipelineBudgetError extends Error {
  public readonly code = 'BOUNDED_BUDGET_EXCEEDED' as const;
}

export class BoundedPackageCapabilityError extends Error {
  public readonly code = 'BOUNDED_PACKAGE_CAPABILITY_REQUIRED' as const;
}
