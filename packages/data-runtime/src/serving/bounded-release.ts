import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DuckDBInstance, type DuckDBAppender, type DuckDBConnection } from '@duckdb/node-api';
import {
  REAL_COUNTY_CAPABILITIES,
  type CapabilityState,
  type RealCountyCapability,
  type ReleaseScope,
} from './real-county-release.js';
import {
  assertAuthoritativeCountyRegistry,
  assertCheckpointMatchesInput,
  boundedStageManifestSchema,
  boundedTrustedAcquisitionManifestSchema,
  boundedTrustedAcquisitionReferenceSchema,
  boundedTrustedCapabilityStateSha256,
  boundedProcessingBudgetSchema,
  boundedArtifactOrderKey,
  immutableBoundedArtifactSchema,
  streamVerifiedBoundedDescriptorInventory,
  type BoundedProcessingBudget,
  type BoundedProcessingCheckpoint,
  type BoundedProcessingInput,
  type BoundedTrustedAcquisitionManifest,
  type BoundedTrustedAcquisitionReference,
  type BoundedTrustedAcquisitionResolver,
  type BoundedDescriptorPageResolver,
  type BoundedStageManifest,
  type ImmutableBoundedArtifact,
} from '@oracle/contracts/bounded-processing';
import { evidenceSourceReferenceSchema } from '@oracle/contracts/evidence';

import {
  BOUNDED_SERVING_RELATIONS,
  PUBLIC_PROHIBITED_COLUMN_PATTERN,
  type ServingColumn,
  type ServingRelationDefinition,
  type ServingRelationName,
  type ServingRow,
  type ServingVisibility,
} from './schema.js';

export type BoundedServingLicenseDecision = Readonly<{
  policyVersion: string;
  contentClass: string;
  decision: 'allowed_public' | 'restricted_only';
  licenseSnapshotRefs: readonly string[];
}>;

export type BoundedServingReleaseMetadata = Readonly<{
  sourceLineage: readonly BoundedServingSourceLineage[];
  limitations: readonly string[];
  licenseDecision: BoundedServingLicenseDecision;
}>;

export type BoundedServingArtifactRollup = Readonly<{
  format: 'oracle-bounded-serving-artifact-rollup-v1';
  descriptorCount: number;
  recordCount: number;
  byteSize: number;
  descriptorRootSha256: string;
  firstOrderKey: string;
  lastOrderKey: string;
}>;

export type BoundedReleaseFinalizationWinner = Readonly<{
  destinationIdentitySha256: string;
  generationId: string;
  releaseManifestSha256: string;
  releaseEvidenceSha256: string;
  expectedRevision: string;
  attemptId: string;
}>;

export interface BoundedReleaseFinalizationCoordinator {
  inspect(destinationIdentitySha256: string): Promise<Readonly<{
    revision: string;
    winner: BoundedReleaseFinalizationWinner;
  }> | null>;
  /**
   * Performs revision-checked CAS, crash recovery, and atomic promotion. A
   * conflict may adopt only an exact winner; a non-identical winner must fail.
   */
  finalize(
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
  >;
}

export type BoundedServingReleaseGateInput = Readonly<{
  sourceManifestSha256: string;
  capabilityStateSha256: string;
  requestedScope: Extract<ReleaseScope, 'pilot' | 'partial_county' | 'full_county'>;
  runStatus: 'succeeded' | 'partial' | 'failed';
  sourceStates: readonly Readonly<{
    sourceId: string;
    snapshotId: string;
    terminalState: 'succeeded' | 'partial' | 'blocked' | 'failed';
    permissionState: 'allowed' | 'pending' | 'restricted' | 'prohibited';
    limitations: readonly string[];
  }>[];
  capabilities: readonly Readonly<{
    capability: RealCountyCapability;
    state: CapabilityState;
    sourceIds: readonly string[];
    limitations: readonly string[];
  }>[];
  permitAuthoritiesCovered: number;
}>;

export const BOUNDED_COUNTY_SERVING_RELATIONS = Object.freeze([
  'property_query',
  'property_evidence',
  'source_coverage',
  'field_coverage',
  'relation_coverage',
  'pipeline_runs',
] as const satisfies readonly ServingRelationName[]);

export const BOUNDED_COUNTY_OUTPUT_RELATIONS = Object.freeze([
  ...BOUNDED_COUNTY_SERVING_RELATIONS,
  'data_dictionary',
] as const satisfies readonly ServingRelationName[]);

type InputRelationName = (typeof BOUNDED_COUNTY_SERVING_RELATIONS)[number];

export type BoundedPropertyQuerySourceReference = Readonly<
  ReturnType<typeof evidenceSourceReferenceSchema.parse> & {
    recordSha256: string;
    lineageSha256: string;
  }
>;

export interface BoundedTrustedCanonicalLineageResolver {
  verifyPropertyQueryFieldReference(input: {
    readonly propertyId: string;
    readonly fieldName: string;
    readonly fieldValue: ServingRow[string];
    readonly reference: BoundedPropertyQuerySourceReference;
  }): Promise<boolean>;
}

export type BoundedServingRelationInput = Readonly<{
  visibility: ServingVisibility;
  relation: InputRelationName;
  /** Inline only for small inventories; never use for county-scale descriptor pages. */
  artifacts?: readonly ImmutableBoundedArtifact[];
  artifactRollup?: BoundedServingArtifactRollup;
  /** Must return a fresh ordered stream on every call. Required with `artifactRollup`. */
  streamArtifacts?: () => AsyncIterable<ImmutableBoundedArtifact>;
  logicalSha256: string;
  recordCount: number;
  releaseMetadata: BoundedServingReleaseMetadata;
  rowLineageRule:
    | Readonly<{ kind: 'source_ids_and_references_exact' }>
    | Readonly<{ kind: 'source_ids_exact' }>
    | Readonly<{ kind: 'source_id_exact' }>
    | Readonly<{
        kind: 'trusted_relation_metadata';
        policyVersion: 'bounded-trusted-relation-lineage-v1';
        sourceLineageSha256: string;
      }>;
}>;

export type BoundedServingReleaseBuildInput = Readonly<{
  processing: BoundedProcessingInput;
  outputDirectory: string;
  scratchDirectory: string;
  relations: readonly BoundedServingRelationInput[];
  completedBuildMarts: Readonly<{
    manifest: BoundedStageManifest;
    /** Required when the completed manifest uses rooted descriptor pages. */
    resolver?: BoundedDescriptorPageResolver;
  }>;
  checkpoint: BoundedProcessingCheckpoint;
  writeBatchRecords: number;
  maximumLineBytes: number;
  dictionaryReleaseMetadata: Readonly<Record<ServingVisibility, BoundedServingReleaseMetadata>>;
  releaseGate: BoundedServingReleaseGateInput;
  trustedAcquisition: Readonly<{
    reference: BoundedTrustedAcquisitionReference;
    resolver: BoundedTrustedAcquisitionResolver;
  }>;
  trustedCanonicalLineage: BoundedTrustedCanonicalLineageResolver;
  finalization: Readonly<{
    attemptId: string;
    coordinator: BoundedReleaseFinalizationCoordinator;
  }>;
  sharedBudget: ProcessWideServingBudgetCoordinator;
  rssSampler?: () => number;
}>;

export type ProcessWideServingBudgetSnapshot = Readonly<{
  bufferedRecords: number;
  bufferedBytes: number;
  peakBufferedRecords: number;
  peakBufferedBytes: number;
}>;

export interface ProcessWideServingBudgetCoordinator {
  acquire(records: number, bytes: number): () => void;
  assertPolicy(policy: BoundedProcessingBudget): void;
  snapshot(): ProcessWideServingBudgetSnapshot;
}

export class ProcessWideServingBudget implements ProcessWideServingBudgetCoordinator {
  private bufferedRecords = 0;
  private bufferedBytes = 0;
  private peakBufferedRecords = 0;
  private peakBufferedBytes = 0;
  private readonly policy: BoundedProcessingBudget;
  private readonly policySha256: string;

  public constructor(policy: BoundedProcessingBudget) {
    this.policy = boundedProcessingBudgetSchema.parse(policy);
    this.policySha256 = canonicalSha256(this.policy);
  }

  public acquire(records: number, bytes: number): () => void {
    if (
      !Number.isSafeInteger(records) ||
      records < 0 ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0
    ) {
      throw new BoundedServingBudgetError('Invalid process-wide serving budget lease');
    }
    const nextRecords = this.bufferedRecords + records;
    const nextBytes = this.bufferedBytes + bytes;
    if (nextRecords > this.policy.maxBufferedRecords || nextBytes > this.policy.maxBufferedBytes) {
      throw new BoundedServingBudgetError('Process-wide serving budget was exceeded');
    }
    this.bufferedRecords = nextRecords;
    this.bufferedBytes = nextBytes;
    this.peakBufferedRecords = Math.max(this.peakBufferedRecords, nextRecords);
    this.peakBufferedBytes = Math.max(this.peakBufferedBytes, nextBytes);
    let released = false;
    return () => {
      if (released) throw new BoundedServingBudgetError('Serving budget lease released twice');
      released = true;
      this.bufferedRecords -= records;
      this.bufferedBytes -= bytes;
    };
  }

  public assertPolicy(policy: BoundedProcessingBudget): void {
    if (canonicalSha256(boundedProcessingBudgetSchema.parse(policy)) !== this.policySha256) {
      throw new BoundedServingBudgetError('Shared serving budget policy mismatch');
    }
  }

  public snapshot(): ProcessWideServingBudgetSnapshot {
    return Object.freeze({
      bufferedRecords: this.bufferedRecords,
      bufferedBytes: this.bufferedBytes,
      peakBufferedRecords: this.peakBufferedRecords,
      peakBufferedBytes: this.peakBufferedBytes,
    });
  }
}

export type BoundedServingArtifact = Readonly<{
  visibility: ServingVisibility;
  relation: ServingRelationName;
  relativePath: string;
  mediaType: 'application/vnd.apache.parquet';
  byteSize: number;
  sha256: string;
  recordCount: number;
  schemaSha256: string;
  logicalSha256: string;
  sourceLineageSha256: string;
  licenseIdentitySha256: string;
}>;

export type BoundedServingCatalog = Readonly<{
  visibility: ServingVisibility;
  relativePath: string;
  byteSize: number;
  sha256: string;
  relationCount: 7;
  recordCount: number;
}>;

export type BoundedServingSourceLineage = Readonly<{
  sourceId: string;
  snapshotId: string;
  sourceSha256: string;
  schemaSha256: string;
  asOf: string | null;
  role: 'direct' | 'derived';
  contributors: readonly string[];
}>;

export type BoundedPortableReleaseArtifact = Readonly<{
  relation: ServingRelationName;
  relativePath: string;
  visibility: ServingVisibility;
  mediaType: 'application/vnd.apache.parquet';
  byteSize: number;
  sha256: string;
  rowCount: number;
  schemaSha256: string;
  columns: readonly ServingColumn[];
  nonNullCounts: Readonly<Record<string, number>>;
  grain: string;
  sourceLineage: readonly BoundedServingSourceLineage[];
  limitations: readonly string[];
}>;

export type BoundedServingReleaseManifest = Readonly<{
  contractVersion: '1.0.0';
  releaseId: string;
  runId: string;
  county: 'Santa Clara';
  state: 'CA';
  generatedAt: string;
  duckdbVersion: string;
  sourceIds: readonly string[];
  artifacts: readonly BoundedPortableReleaseArtifact[];
  manifestSha256: string;
}>;

export type BoundedServingReleaseEvidence = Readonly<{
  contractVersion: '1.0.0';
  releaseId: string;
  runId: string;
  county: 'Santa Clara';
  state: 'CA';
  generatedAt: string;
  runStatus: BoundedServingReleaseGateInput['runStatus'];
  releaseScope: Extract<ReleaseScope, 'pilot' | 'partial_county' | 'full_county'>;
  countyCompletionClaim: boolean;
  permitAuthorityCoverage: Readonly<{ covered: number; total: 16 }>;
  capabilities: BoundedServingReleaseGateInput['capabilities'];
  sourceStates: BoundedServingReleaseGateInput['sourceStates'];
  manifestSha256: string;
  artifacts: readonly Readonly<{
    relation: ServingRelationName;
    visibility: ServingVisibility;
    relativePath: string;
    rowCount: number;
    byteSize: number;
    sha256: string;
  }>[];
  catalogs: readonly BoundedServingCatalog[];
  gates: Readonly<{
    license: 'passed';
    manifest: 'passed';
    parquet: 'passed';
    cleanReopen: 'passed';
    publicRestrictedSegregation: 'passed';
    ownerBearingPublicValues: 0;
  }>;
  logicalOutputIdentitySha256: string;
  publicRestrictedValueOverlap: 0;
  publicRelationCount: 7;
  restrictedRelationCount: 7;
  portableReopen: 'passed';
  schemaOrder: 'passed';
  rowOrder: 'passed';
  immutableHashes: 'passed';
  budget: Readonly<{
    peakBufferedRecords: number;
    peakBufferedBytes: number;
    peakRssBytes: number;
    maxBufferedRecords: number;
    maxBufferedBytes: number;
    maxRssBytes: number;
  }>;
  evidenceSha256: string;
}>;

export type BoundedServingReleaseResult = Readonly<{
  outputDirectory: string;
  generationId: string;
  manifest: BoundedServingReleaseManifest;
  evidence: BoundedServingReleaseEvidence;
  adoptedIdenticalWinner: boolean;
}>;

type BuildCheckpointArtifact = Readonly<{
  visibility: ServingVisibility;
  relation: ServingRelationName;
  relativePath: string;
  byteSize: number;
  sha256: string;
  recordCount: number;
  schemaSha256: string;
  logicalSha256: string;
  sourceLineageSha256: string;
  licenseIdentitySha256: string;
  nonNullCounts: Readonly<Record<string, number>>;
}>;

type BuildCheckpoint = Readonly<{
  schemaVersion: 'oracle-bounded-serving-build-checkpoint-v1';
  generationId: string;
  logicalOutputIdentitySha256: string;
  artifacts: readonly BuildCheckpointArtifact[];
  checkpointSha256: string;
}>;

const MANIFEST_FILE = 'release-manifest.json';
const EVIDENCE_FILE = 'release-evidence.json';
const BUILD_CHECKPOINT_FILE = 'bounded-build-checkpoint.json';
const PARQUET_ROW_GROUP_SIZE = 122_880;
const SENSITIVE_JSON_TOKENS = new Set([
  'owner',
  'ssn',
  'taxpayer',
  'grantor',
  'grantee',
  'email',
  'phone',
  'contact',
]);

class ServingBudgetTelemetry {
  private observedRecords = 0;
  private peakRssBytes = 0;

  public constructor(
    public readonly coordinator: ProcessWideServingBudgetCoordinator,
    private readonly policy: BoundedProcessingBudget,
    private readonly rssSampler: () => number,
  ) {
    coordinator.assertPolicy(policy);
    this.sample(true);
  }

  public acquire(records: number, bytes: number): () => void {
    const release = this.coordinator.acquire(records, bytes);
    this.observedRecords += records;
    try {
      this.sample(
        records === 0 || this.observedRecords % this.policy.rssSampleIntervalRecords < records,
      );
    } catch (error) {
      release();
      throw error;
    }
    return release;
  }

  public sample(force = false): void {
    if (!force && this.observedRecords % this.policy.rssSampleIntervalRecords !== 0) return;
    const rss = this.rssSampler();
    if (!Number.isSafeInteger(rss) || rss < 0) {
      throw new BoundedServingBudgetError('RSS sampler returned an invalid value');
    }
    this.peakRssBytes = Math.max(this.peakRssBytes, rss);
    const snapshot = this.coordinator.snapshot();
    if (
      snapshot.bufferedRecords > this.policy.maxBufferedRecords ||
      snapshot.bufferedBytes > this.policy.maxBufferedBytes ||
      this.peakRssBytes > this.policy.maxRssBytes
    ) {
      throw new BoundedServingBudgetError('Serving stage exceeded the process-wide budget');
    }
  }

  public evidence(): BoundedServingReleaseEvidence['budget'] {
    this.sample(true);
    const snapshot = this.coordinator.snapshot();
    if (snapshot.bufferedRecords !== 0 || snapshot.bufferedBytes !== 0) {
      throw new BoundedServingBudgetError('Serving stage retained process-wide budget leases');
    }
    return Object.freeze({
      peakBufferedRecords: snapshot.peakBufferedRecords,
      peakBufferedBytes: snapshot.peakBufferedBytes,
      peakRssBytes: this.peakRssBytes,
      maxBufferedRecords: this.policy.maxBufferedRecords,
      maxBufferedBytes: this.policy.maxBufferedBytes,
      maxRssBytes: this.policy.maxRssBytes,
    });
  }
}

export async function buildBoundedServingRelease(
  input: BoundedServingReleaseBuildInput,
): Promise<BoundedServingReleaseResult> {
  assertReleaseInputBounds(input);
  const trusted = await loadTrustedAcquisition(input);
  input = canonicalizeReleaseBuildInput(input);
  validateBuildInput(input, trusted);
  const checkpoint = input.checkpoint;
  if (
    checkpoint.expectedRevision === null ||
    !checkpoint.completedStages.some(({ stage }) => stage === 'build_marts') ||
    checkpoint.completedStages.some(({ stage }) => stage === 'finalize_release')
  ) {
    throw new BoundedBuildConfigurationError('completed build_marts checkpoint');
  }
  if (input.finalization.attemptId.trim().length === 0) {
    throw new BoundedBuildConfigurationError('revision/CAS finalization coordinator');
  }
  const telemetry = new ServingBudgetTelemetry(
    input.sharedBudget,
    input.processing.budget,
    input.rssSampler ??
      (() => Math.max(process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024)),
  );
  assertCheckpointMatchesInput(checkpoint, input.processing);
  const destination = resolve(input.outputDirectory);
  const existing = await pathExists(destination);
  if (existing) {
    const adopted = await adoptExistingRelease(destination, input.processing);
    await assertFinalizationWinner(
      input.finalization.coordinator,
      checkpoint.expectedRevision,
      input.finalization.attemptId,
      adopted,
    );
    return adopted;
  }

  const generationHashStart = 'sc:generation:'.length;
  const staging = `${destination}.bounded-${input.processing.generationId.slice(generationHashStart, generationHashStart + 16)}-${canonicalSha256(input.finalization.attemptId).slice(0, 12)}`;
  const recovered = await recoverFinalizedStaging(input, destination, staging);
  if (recovered !== null) return recovered;
  await mkdir(staging, { recursive: true });
  await mkdir(resolve(input.scratchDirectory), { recursive: true });
  await mkdir(join(staging, 'public'), { recursive: true });
  await mkdir(join(staging, 'restricted'), { recursive: true });

  let buildCheckpoint = await loadBuildCheckpoint(staging, input.processing);
  let duckdbVersion: string;
  const workDatabase = join(resolve(input.scratchDirectory), `${basename(staging)}.duckdb`);
  const instance = await DuckDBInstance.create(workDatabase, {
    threads: '1',
    memory_limit: `${input.processing.budget.duckdbMemoryBytes}B`,
    temp_directory: resolve(input.scratchDirectory),
  });
  let connection: DuckDBConnection | undefined;
  try {
    connection = await instance.connect();
    duckdbVersion = await scalarString(connection, 'SELECT version() AS value');
    await connection.run('SET threads = 1');
    await connection.run('SET preserve_insertion_order = false');
    await connection.run('CREATE TABLE IF NOT EXISTS public_value_hashes(value_hash VARCHAR)');
    await connection.run(
      'CREATE TABLE IF NOT EXISTS restricted_sensitive_hashes(value_hash VARCHAR)',
    );
    const publicHashes = await connection.createAppender('public_value_hashes');
    const restrictedHashes = await connection.createAppender('restricted_sensitive_hashes');
    try {
      for (const visibility of ['public', 'restricted'] as const) {
        for (const relation of BOUNDED_COUNTY_SERVING_RELATIONS) {
          const source = requiredRelation(input.relations, visibility, relation);
          const descriptor = await buildOrAdoptRelation({
            connection,
            staging,
            source,
            completedBuildMarts: input.completedBuildMarts,
            trusted,
            trustedCanonicalLineage: input.trustedCanonicalLineage,
            processing: input.processing,
            maximumLineBytes: input.maximumLineBytes,
            writeBatchRecords: input.writeBatchRecords,
            publicHashes,
            restrictedHashes,
            telemetry,
          });
          buildCheckpoint = await checkpointArtifact(
            staging,
            buildCheckpoint,
            descriptor,
            input.processing,
          );
        }
        const dictionary = await buildOrAdoptDictionary({
          connection,
          staging,
          visibility,
          processing: input.processing,
          telemetry,
          releaseMetadata: input.dictionaryReleaseMetadata[visibility],
        });
        buildCheckpoint = await checkpointArtifact(
          staging,
          buildCheckpoint,
          dictionary,
          input.processing,
        );
      }
      publicHashes.flushSync();
      restrictedHashes.flushSync();
    } finally {
      publicHashes.closeSync();
      restrictedHashes.closeSync();
    }
    const overlap = await scalarBigInt(
      connection,
      'SELECT count(*)::BIGINT AS value FROM (SELECT DISTINCT p.value_hash FROM public_value_hashes p INNER JOIN restricted_sensitive_hashes r USING(value_hash))',
    );
    if (overlap !== 0) throw new BoundedPublicPrivacyError(overlap);
  } finally {
    connection?.closeSync();
    instance.closeSync();
  }

  const artifacts = Object.freeze(
    [...buildCheckpoint.artifacts]
      .sort(compareCheckpointArtifacts)
      .map((artifact) =>
        Object.freeze({ ...artifact, mediaType: 'application/vnd.apache.parquet' as const }),
      ),
  );
  const catalogs: BoundedServingCatalog[] = [];
  for (const visibility of ['public', 'restricted'] as const) {
    catalogs.push(await buildCatalog(staging, visibility, artifacts, input.processing));
  }
  const portableArtifacts = Object.freeze(
    artifacts.map((artifact): BoundedPortableReleaseArtifact => {
      const definition = BOUNDED_SERVING_RELATIONS[artifact.relation];
      const metadata =
        artifact.relation === 'data_dictionary'
          ? input.dictionaryReleaseMetadata[artifact.visibility]
          : requiredRelation(
              input.relations,
              artifact.visibility,
              artifact.relation as InputRelationName,
            ).releaseMetadata;
      return Object.freeze({
        relation: artifact.relation,
        relativePath: artifact.relativePath,
        visibility: artifact.visibility,
        mediaType: artifact.mediaType,
        byteSize: artifact.byteSize,
        sha256: artifact.sha256,
        rowCount: artifact.recordCount,
        schemaSha256: artifact.schemaSha256,
        columns: definition.columns,
        nonNullCounts: artifact.nonNullCounts,
        grain: definition.grain,
        sourceLineage: metadata.sourceLineage,
        limitations: metadata.limitations,
      });
    }),
  );
  const manifestPayload = {
    contractVersion: '1.0.0' as const,
    releaseId: input.processing.release.releaseId,
    runId: input.processing.runId,
    county: 'Santa Clara' as const,
    state: 'CA' as const,
    generatedAt: input.processing.release.generatedAt,
    duckdbVersion,
    sourceIds: Object.freeze(
      [
        ...new Set(
          portableArtifacts.flatMap(({ sourceLineage }) =>
            sourceLineage.map(({ sourceId }) => sourceId),
          ),
        ),
      ].sort(compareUtf8),
    ),
    artifacts: portableArtifacts,
  };
  const manifest: BoundedServingReleaseManifest = Object.freeze({
    ...manifestPayload,
    manifestSha256: portableManifestSha256(manifestPayload),
  });
  const releaseScope = releaseGateScope(input.releaseGate);
  const evidencePayload = {
    contractVersion: '1.0.0' as const,
    releaseId: manifest.releaseId,
    runId: manifest.runId,
    county: 'Santa Clara' as const,
    state: 'CA' as const,
    generatedAt: manifest.generatedAt,
    runStatus: input.releaseGate.runStatus,
    releaseScope,
    countyCompletionClaim: releaseScope === 'full_county',
    permitAuthorityCoverage: Object.freeze({
      covered: input.releaseGate.permitAuthoritiesCovered,
      total: 16 as const,
    }),
    capabilities: input.releaseGate.capabilities,
    sourceStates: input.releaseGate.sourceStates,
    manifestSha256: manifest.manifestSha256,
    artifacts: Object.freeze(
      portableArtifacts.map(({ relation, visibility, relativePath, rowCount, byteSize, sha256 }) =>
        Object.freeze({ relation, visibility, relativePath, rowCount, byteSize, sha256 }),
      ),
    ),
    catalogs: Object.freeze(catalogs),
    gates: Object.freeze({
      license: 'passed' as const,
      manifest: 'passed' as const,
      parquet: 'passed' as const,
      cleanReopen: 'passed' as const,
      publicRestrictedSegregation: 'passed' as const,
      ownerBearingPublicValues: 0 as const,
    }),
    logicalOutputIdentitySha256: input.processing.logicalOutputIdentitySha256,
    publicRestrictedValueOverlap: 0 as const,
    publicRelationCount: 7 as const,
    restrictedRelationCount: 7 as const,
    portableReopen: 'passed' as const,
    schemaOrder: 'passed' as const,
    rowOrder: 'passed' as const,
    immutableHashes: 'passed' as const,
    budget: telemetry.evidence(),
  };
  const evidence: BoundedServingReleaseEvidence = Object.freeze({
    ...evidencePayload,
    evidenceSha256: canonicalSha256(evidencePayload),
  });
  await writeCanonicalJson(join(staging, MANIFEST_FILE), manifest);
  await writeCanonicalJson(join(staging, EVIDENCE_FILE), evidence);
  await verifyBoundedServingRelease(staging);
  await rm(join(staging, BUILD_CHECKPOINT_FILE), { force: true });
  const destinationIdentitySha256 = canonicalSha256({
    releaseId: manifest.releaseId,
    contractVersion: manifest.contractVersion,
    destination,
  });
  const expectedWinner: BoundedReleaseFinalizationWinner = Object.freeze({
    destinationIdentitySha256,
    generationId: input.processing.generationId,
    releaseManifestSha256: manifest.manifestSha256,
    releaseEvidenceSha256: evidence.evidenceSha256,
    expectedRevision: checkpoint.expectedRevision,
    attemptId: input.finalization.attemptId,
  });
  const finalized = await input.finalization.coordinator.finalize({
    destination,
    staging,
    expectedRevision: checkpoint.expectedRevision,
    winner: expectedWinner,
  });
  assertExactFinalizationResult(expectedWinner, finalized.winner);
  if (
    finalized.revision.trim().length === 0 ||
    finalized.revision === checkpoint.expectedRevision
  ) {
    throw new BoundedFinalizationRaceError();
  }
  const inspectedFinalization =
    await input.finalization.coordinator.inspect(destinationIdentitySha256);
  if (inspectedFinalization?.revision !== finalized.revision) {
    throw new BoundedFinalizationRaceError();
  }
  assertExactFinalizationResult(expectedWinner, inspectedFinalization.winner);
  const winner = await verifyBoundedServingRelease(destination);
  if (
    winner.manifest.manifestSha256 !== manifest.manifestSha256 ||
    winner.evidence.evidenceSha256 !== evidence.evidenceSha256
  ) {
    throw new BoundedFinalizationRaceError();
  }
  const reinspectedFinalization =
    await input.finalization.coordinator.inspect(destinationIdentitySha256);
  if (reinspectedFinalization?.revision !== finalized.revision) {
    throw new BoundedFinalizationRaceError();
  }
  assertExactFinalizationResult(expectedWinner, reinspectedFinalization.winner);
  if (await pathExists(staging)) await rm(staging, { recursive: true, force: true });
  return Object.freeze({
    outputDirectory: destination,
    generationId: input.processing.generationId,
    manifest: winner.manifest,
    evidence: winner.evidence,
    adoptedIdenticalWinner: finalized.state === 'adopted_identical_winner',
  });
}

async function recoverFinalizedStaging(
  input: BoundedServingReleaseBuildInput,
  destination: string,
  staging: string,
): Promise<BoundedServingReleaseResult | null> {
  const expectedRevision = input.checkpoint.expectedRevision;
  if (expectedRevision === null) throw new BoundedFinalizationRaceError();
  const destinationIdentitySha256 = canonicalSha256({
    releaseId: input.processing.release.releaseId,
    contractVersion: '1.0.0',
    destination,
  });
  const inspected = await input.finalization.coordinator.inspect(destinationIdentitySha256);
  if (inspected === null) return null;
  if (
    inspected.revision.trim().length === 0 ||
    inspected.revision === expectedRevision ||
    inspected.winner.destinationIdentitySha256 !== destinationIdentitySha256 ||
    inspected.winner.generationId !== input.processing.generationId ||
    inspected.winner.expectedRevision !== expectedRevision ||
    inspected.winner.attemptId !== input.finalization.attemptId ||
    !(await pathExists(staging))
  ) {
    throw new BoundedFinalizationRaceError();
  }
  const staged = await verifyBoundedServingRelease(staging);
  if (
    staged.manifest.manifestSha256 !== inspected.winner.releaseManifestSha256 ||
    staged.evidence.evidenceSha256 !== inspected.winner.releaseEvidenceSha256
  ) {
    throw new BoundedFinalizationRaceError();
  }
  const finalized = await input.finalization.coordinator.finalize({
    destination,
    staging,
    expectedRevision,
    winner: inspected.winner,
  });
  if (finalized.revision !== inspected.revision) throw new BoundedFinalizationRaceError();
  assertExactFinalizationResult(inspected.winner, finalized.winner);
  const winner = await verifyBoundedServingRelease(destination);
  const reinspected = await input.finalization.coordinator.inspect(destinationIdentitySha256);
  if (reinspected?.revision !== inspected.revision) throw new BoundedFinalizationRaceError();
  assertExactFinalizationResult(inspected.winner, reinspected.winner);
  if (await pathExists(staging)) await rm(staging, { recursive: true, force: true });
  return Object.freeze({
    outputDirectory: destination,
    generationId: input.processing.generationId,
    manifest: winner.manifest,
    evidence: winner.evidence,
    adoptedIdenticalWinner: true,
  });
}

export async function verifyBoundedServingRelease(
  outputDirectory: string,
): Promise<
  Readonly<{ manifest: BoundedServingReleaseManifest; evidence: BoundedServingReleaseEvidence }>
> {
  const root = resolve(outputDirectory);
  const manifest = (await readBoundedJson(
    join(root, MANIFEST_FILE),
    8 * 1024 * 1024,
  )) as BoundedServingReleaseManifest;
  const evidence = (await readBoundedJson(
    join(root, EVIDENCE_FILE),
    2 * 1024 * 1024,
  )) as BoundedServingReleaseEvidence;
  assertManifestShape(manifest, evidence);
  for (const artifact of manifest.artifacts) {
    const path = confinedPath(root, artifact.relativePath);
    const file = await hashFile(path);
    if (file.byteSize !== artifact.byteSize || file.sha256 !== artifact.sha256) {
      throw new BoundedReleaseCorruptionError(artifact.relativePath);
    }
    await verifyParquetArtifact(path, artifact);
  }
  for (const catalog of evidence.catalogs) {
    const path = confinedPath(root, catalog.relativePath);
    const file = await hashFile(path);
    if (file.byteSize !== catalog.byteSize || file.sha256 !== catalog.sha256) {
      throw new BoundedReleaseCorruptionError(catalog.relativePath);
    }
    await verifyCatalog(path, catalog.visibility, manifest.artifacts);
  }
  return Object.freeze({ manifest, evidence });
}

async function buildOrAdoptRelation(
  input: Readonly<{
    connection: DuckDBConnection;
    staging: string;
    source: BoundedServingRelationInput;
    completedBuildMarts: BoundedServingReleaseBuildInput['completedBuildMarts'];
    trusted: BoundedTrustedAcquisitionManifest;
    trustedCanonicalLineage: BoundedTrustedCanonicalLineageResolver;
    processing: BoundedProcessingInput;
    maximumLineBytes: number;
    writeBatchRecords: number;
    publicHashes: DuckDBAppender;
    restrictedHashes: DuckDBAppender;
    telemetry: ServingBudgetTelemetry;
  }>,
): Promise<BuildCheckpointArtifact> {
  const definition = BOUNDED_SERVING_RELATIONS[input.source.relation];
  const relativePath = `${input.source.visibility}/${definition.fileName}`;
  const output = confinedPath(input.staging, relativePath);
  if (await pathExists(output)) {
    await verifyInputRelation(input, definition);
    const adopted = await inspectParquet(
      output,
      input.source.visibility,
      definition,
      input.source.logicalSha256,
      boundedServingLineageSha256(input.source.releaseMetadata.sourceLineage),
      boundedServingLicenseDecisionSha256(input.source.releaseMetadata.licenseDecision),
    );
    if (adopted.recordCount !== input.source.recordCount) {
      throw new BoundedReleaseCorruptionError(relativePath);
    }
    return adopted;
  }
  const table = tableName(input.source.visibility, input.source.relation);
  await input.connection.run(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`);
  await input.connection.run(createTableSql(table, definition.columns));
  const appender = await input.connection.createAppender(table);
  let records = 0;
  let sinceFlush = 0;
  let previousSortKey: string | undefined;
  const logicalHash = createHash('sha256');
  const inventory = new ArtifactInventoryVerifier(input.source);
  const contributors = new RelationContributorVerifier(
    input.source,
    input.trusted,
    input.trustedCanonicalLineage,
  );
  const batchReleases: (() => void)[] = [];
  const releaseBatch = (): void => {
    appender.flushSync();
    input.publicHashes.flushSync();
    input.restrictedHashes.flushSync();
    while (batchReleases.length > 0) batchReleases.pop()?.();
    sinceFlush = 0;
  };
  try {
    for await (const artifact of exactRelationArtifacts(input.source, input.completedBuildMarts)) {
      inventory.observe(artifact);
      assertInputArtifact(artifact, input.source, input.processing);
      for await (const { row, residentBytes } of readVerifiedRows(
        artifact,
        definition,
        input.maximumLineBytes,
        input.processing.budget,
        input.telemetry,
      )) {
        const sortKey = rowSortKey(definition, row);
        if (previousSortKey !== undefined && compareUtf8(previousSortKey, sortKey) > 0) {
          throw new BoundedRowOrderError(input.source.relation);
        }
        previousSortKey = sortKey;
        logicalHash.update(`${canonicalJson(row)}\n`);
        batchReleases.push(input.telemetry.acquire(1, residentBytes * 2));
        appendRow(appender, definition.columns, row);
        appendPrivacyHashes(
          row,
          input.source.visibility,
          input.publicHashes,
          input.restrictedHashes,
        );
        await contributors.observe(row);
        records += 1;
        sinceFlush += 1;
        if (sinceFlush >= input.writeBatchRecords) releaseBatch();
      }
    }
    inventory.finish();
    contributors.finish();
    releaseBatch();
  } finally {
    while (batchReleases.length > 0) batchReleases.pop()?.();
    appender.closeSync();
  }
  if (records !== input.source.recordCount) throw new BoundedRowCountError(input.source.relation);
  if (logicalHash.digest('hex') !== input.source.logicalSha256) {
    throw new BoundedReleaseCorruptionError(`${input.source.visibility}/${input.source.relation}`);
  }
  await verifyTable(input.connection, table, definition, records);
  await mkdir(dirname(output), { recursive: true });
  await input.connection.run(copyParquetSql(table, definition, output));
  await input.connection.run(`DROP TABLE ${quoteIdentifier(table)}`);
  return inspectParquet(
    output,
    input.source.visibility,
    definition,
    input.source.logicalSha256,
    boundedServingLineageSha256(input.source.releaseMetadata.sourceLineage),
    boundedServingLicenseDecisionSha256(input.source.releaseMetadata.licenseDecision),
  );
}

async function verifyInputRelation(
  input: Readonly<{
    source: BoundedServingRelationInput;
    completedBuildMarts: BoundedServingReleaseBuildInput['completedBuildMarts'];
    trusted: BoundedTrustedAcquisitionManifest;
    trustedCanonicalLineage: BoundedTrustedCanonicalLineageResolver;
    processing: BoundedProcessingInput;
    maximumLineBytes: number;
    publicHashes: DuckDBAppender;
    restrictedHashes: DuckDBAppender;
    telemetry: ServingBudgetTelemetry;
  }>,
  definition: ServingRelationDefinition,
): Promise<void> {
  const logicalHash = createHash('sha256');
  const inventory = new ArtifactInventoryVerifier(input.source);
  const contributors = new RelationContributorVerifier(
    input.source,
    input.trusted,
    input.trustedCanonicalLineage,
  );
  let records = 0;
  let previousSortKey: string | undefined;
  for await (const artifact of exactRelationArtifacts(input.source, input.completedBuildMarts)) {
    inventory.observe(artifact);
    assertInputArtifact(artifact, input.source, input.processing);
    for await (const { row } of readVerifiedRows(
      artifact,
      definition,
      input.maximumLineBytes,
      input.processing.budget,
      input.telemetry,
    )) {
      const sortKey = rowSortKey(definition, row);
      if (previousSortKey !== undefined && compareUtf8(previousSortKey, sortKey) > 0) {
        throw new BoundedRowOrderError(input.source.relation);
      }
      previousSortKey = sortKey;
      logicalHash.update(`${canonicalJson(row)}\n`);
      appendPrivacyHashes(row, input.source.visibility, input.publicHashes, input.restrictedHashes);
      await contributors.observe(row);
      input.publicHashes.flushSync();
      input.restrictedHashes.flushSync();
      records += 1;
    }
  }
  inventory.finish();
  contributors.finish();
  if (
    records !== input.source.recordCount ||
    logicalHash.digest('hex') !== input.source.logicalSha256
  ) {
    throw new BoundedReleaseCorruptionError(`${input.source.visibility}/${input.source.relation}`);
  }
}

async function buildOrAdoptDictionary(
  input: Readonly<{
    connection: DuckDBConnection;
    staging: string;
    visibility: ServingVisibility;
    processing: BoundedProcessingInput;
    telemetry: ServingBudgetTelemetry;
    releaseMetadata: BoundedServingReleaseMetadata;
  }>,
): Promise<BuildCheckpointArtifact> {
  const definition = BOUNDED_SERVING_RELATIONS.data_dictionary;
  const relativePath = `${input.visibility}/${definition.fileName}`;
  const output = confinedPath(input.staging, relativePath);
  const rows = dictionaryRowCount();
  const lineage = boundedServingLineageSha256(input.releaseMetadata.sourceLineage);
  const license = boundedServingLicenseDecisionSha256(input.releaseMetadata.licenseDecision);
  if (await pathExists(output)) {
    const adopted = await inspectParquet(
      output,
      input.visibility,
      definition,
      canonicalSha256({ relation: 'data_dictionary', visibility: input.visibility }),
      lineage,
      license,
    );
    if (adopted.recordCount !== rows) throw new BoundedReleaseCorruptionError(relativePath);
    return adopted;
  }
  const table = tableName(input.visibility, 'data_dictionary');
  await input.connection.run(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`);
  await input.connection.run(createTableSql(table, definition.columns));
  const appender = await input.connection.createAppender(table);
  try {
    for (const relation of BOUNDED_COUNTY_OUTPUT_RELATIONS) {
      const relationDefinition = BOUNDED_SERVING_RELATIONS[relation];
      for (const [index, column] of relationDefinition.columns.entries()) {
        const row = {
          relation_name: relation,
          ordinal: index + 1,
          column_name: column.name,
          duckdb_type: column.duckdbType,
          nullable: column.nullable,
          grain: relationDefinition.grain,
          description: column.description,
          visibility: input.visibility,
        } satisfies ServingRow;
        const reservation = Math.min(
          input.processing.budget.maxBytesPerOutputChunk,
          input.processing.budget.maxBufferedBytes,
        );
        const release = input.telemetry.acquire(1, reservation);
        try {
          const residentBytes = Buffer.byteLength(canonicalJson(row));
          if (residentBytes * 2 > reservation) {
            throw new BoundedServingBudgetError(
              'Dictionary row exceeded its preallocated canonical/appender lease',
            );
          }
          appendRow(appender, definition.columns, row);
          appender.flushSync();
        } finally {
          release();
        }
      }
    }
    appender.flushSync();
  } finally {
    appender.closeSync();
  }
  await verifyTable(input.connection, table, definition, rows);
  await input.connection.run(copyParquetSql(table, definition, output));
  await input.connection.run(`DROP TABLE ${quoteIdentifier(table)}`);
  return inspectParquet(
    output,
    input.visibility,
    definition,
    canonicalSha256({ relation: 'data_dictionary', visibility: input.visibility }),
    lineage,
    license,
  );
}

async function buildCatalog(
  staging: string,
  visibility: ServingVisibility,
  artifacts: readonly BoundedServingArtifact[],
  processing: BoundedProcessingInput,
): Promise<BoundedServingCatalog> {
  const relativePath = `${visibility}/oracle-${visibility}.duckdb`;
  const output = confinedPath(staging, relativePath);
  const recordCount = artifacts
    .filter((artifact) => artifact.visibility === visibility)
    .reduce((total, artifact) => total + artifact.recordCount, 0);
  if (await pathExists(output)) {
    await verifyCatalog(output, visibility, artifacts);
    const adopted = await hashFile(output);
    return Object.freeze({
      visibility,
      relativePath,
      byteSize: adopted.byteSize,
      sha256: adopted.sha256,
      relationCount: 7 as const,
      recordCount,
    });
  }
  const instance = await DuckDBInstance.create(output, {
    threads: '1',
    memory_limit: `${processing.budget.duckdbMemoryBytes}B`,
  });
  let connection: DuckDBConnection | undefined;
  try {
    connection = await instance.connect();
    await connection.run('SET threads = 1');
    for (const relation of BOUNDED_COUNTY_OUTPUT_RELATIONS) {
      const artifact = artifacts.find(
        (candidate) => candidate.visibility === visibility && candidate.relation === relation,
      );
      if (artifact === undefined) throw new BoundedRelationInventoryError();
      const path = confinedPath(staging, artifact.relativePath);
      await connection.run(
        `CREATE TABLE ${quoteIdentifier(relation)} AS SELECT * FROM read_parquet(${sqlLiteral(path)}) ORDER BY ${sortSql(BOUNDED_SERVING_RELATIONS[relation])}`,
      );
    }
    await connection.run('CHECKPOINT');
  } finally {
    connection?.closeSync();
    instance.closeSync();
  }
  const file = await hashFile(output);
  const catalog = Object.freeze({
    visibility,
    relativePath,
    byteSize: file.byteSize,
    sha256: file.sha256,
    relationCount: 7 as const,
    recordCount,
  });
  await verifyCatalog(output, visibility, artifacts);
  return catalog;
}

async function verifyCatalog(
  path: string,
  visibility: ServingVisibility,
  artifacts: readonly Readonly<{
    visibility: ServingVisibility;
    relation: ServingRelationName;
    recordCount?: number;
    rowCount?: number;
  }>[],
): Promise<void> {
  const instance = await DuckDBInstance.create(path, { access_mode: 'READ_ONLY', threads: '1' });
  let connection: DuckDBConnection | undefined;
  try {
    connection = await instance.connect();
    for (const relation of BOUNDED_COUNTY_OUTPUT_RELATIONS) {
      const artifact = artifacts.find(
        (candidate) => candidate.visibility === visibility && candidate.relation === relation,
      );
      if (artifact === undefined) throw new BoundedRelationInventoryError();
      await verifySchemaStream(connection, relation, BOUNDED_SERVING_RELATIONS[relation]);
      const count = await scalarBigInt(
        connection,
        `SELECT count(*)::BIGINT AS value FROM ${quoteIdentifier(relation)}`,
      );
      if (count !== (artifact.recordCount ?? artifact.rowCount)) {
        throw new BoundedRowCountError(relation);
      }
    }
    const inventory = await scalarBigInt(
      connection,
      "SELECT count(*)::BIGINT AS value FROM information_schema.tables WHERE table_schema='main' AND table_type='BASE TABLE'",
    );
    if (inventory !== 7) throw new BoundedRelationInventoryError();
  } finally {
    connection?.closeSync();
    instance.closeSync();
  }
}

async function inspectParquet(
  path: string,
  visibility: ServingVisibility,
  definition: ServingRelationDefinition,
  logicalSha256: string,
  sourceLineageSha256: string,
  licenseIdentitySha256: string,
): Promise<BuildCheckpointArtifact> {
  const file = await hashFile(path);
  const instance = await DuckDBInstance.create(':memory:', { threads: '1' });
  let connection: DuckDBConnection | undefined;
  try {
    connection = await instance.connect();
    await verifyParquetSchemaStream(connection, path, definition);
    const recordCount = await scalarBigInt(
      connection,
      `SELECT count(*)::BIGINT AS value FROM read_parquet(${sqlLiteral(path)})`,
    );
    const nonNullCounts = await readNonNullCounts(connection, path, definition);
    await verifyParquetOrderAndGrain(connection, path, definition);
    return Object.freeze({
      visibility,
      relation: definition.name,
      relativePath: `${visibility}/${definition.fileName}`,
      byteSize: file.byteSize,
      sha256: file.sha256,
      recordCount,
      schemaSha256: schemaSha256(definition),
      logicalSha256,
      sourceLineageSha256,
      licenseIdentitySha256,
      nonNullCounts,
    });
  } finally {
    connection?.closeSync();
    instance.closeSync();
  }
}

async function readNonNullCounts(
  connection: DuckDBConnection,
  path: string,
  definition: ServingRelationDefinition,
): Promise<Readonly<Record<string, number>>> {
  const selections = definition.columns
    .map(({ name }) => `count(${quoteIdentifier(name)})::BIGINT AS ${quoteIdentifier(name)}`)
    .join(',');
  const result = await connection.stream(
    `SELECT ${selections} FROM read_parquet(${sqlLiteral(path)})`,
  );
  let counts: Readonly<Record<string, number>> | undefined;
  for await (const batch of result.yieldRowObjectJs()) {
    for (const row of batch) {
      if (counts !== undefined) throw new BoundedScalarQueryError();
      counts = Object.freeze(
        Object.fromEntries(
          definition.columns.map(({ name }) => {
            const value = row[name];
            if (typeof value !== 'bigint' && typeof value !== 'number') {
              throw new BoundedScalarQueryError();
            }
            return [name, Number(value)];
          }),
        ),
      );
    }
  }
  if (counts === undefined) throw new BoundedScalarQueryError();
  return counts;
}

async function verifyParquetArtifact(
  path: string,
  artifact: BoundedPortableReleaseArtifact,
): Promise<void> {
  const definition = BOUNDED_SERVING_RELATIONS[artifact.relation];
  if (schemaSha256(definition) !== artifact.schemaSha256) {
    throw new BoundedReleaseCorruptionError(artifact.relativePath);
  }
  const inspected = await inspectParquet(
    path,
    artifact.visibility,
    definition,
    artifact.sha256,
    artifact.sha256,
    artifact.sha256,
  );
  if (
    inspected.recordCount !== artifact.rowCount ||
    canonicalJson(inspected.nonNullCounts) !== canonicalJson(artifact.nonNullCounts) ||
    canonicalJson(definition.columns) !== canonicalJson(artifact.columns) ||
    definition.grain !== artifact.grain
  ) {
    throw new BoundedReleaseCorruptionError(artifact.relativePath);
  }
}

async function verifyParquetSchemaStream(
  connection: DuckDBConnection,
  path: string,
  definition: ServingRelationDefinition,
): Promise<void> {
  const result = await connection.stream(
    `DESCRIBE SELECT * FROM read_parquet(${sqlLiteral(path)})`,
  );
  let ordinal = 0;
  for await (const batch of result.yieldRowObjectJs()) {
    for (const row of batch) {
      const expected = definition.columns[ordinal];
      if (
        expected === undefined ||
        row.column_name !== expected.name ||
        row.column_type !== expected.duckdbType
      ) {
        throw new BoundedSchemaOrderError(definition.name);
      }
      ordinal += 1;
    }
  }
  if (ordinal !== definition.columns.length) throw new BoundedSchemaOrderError(definition.name);
}

async function verifySchemaStream(
  connection: DuckDBConnection,
  relation: ServingRelationName,
  definition: ServingRelationDefinition,
): Promise<void> {
  const result = await connection.stream(`PRAGMA table_info(${sqlLiteral(relation)})`);
  let ordinal = 0;
  for await (const batch of result.yieldRowObjectJs()) {
    for (const row of batch) {
      const expected = definition.columns[ordinal];
      if (
        expected === undefined ||
        row.name !== expected.name ||
        row.type !== expected.duckdbType
      ) {
        throw new BoundedSchemaOrderError(relation);
      }
      ordinal += 1;
    }
  }
  if (ordinal !== definition.columns.length) throw new BoundedSchemaOrderError(relation);
}

async function verifyParquetOrderAndGrain(
  connection: DuckDBConnection,
  path: string,
  definition: ServingRelationDefinition,
): Promise<void> {
  const source = `read_parquet(${sqlLiteral(path)})`;
  const duplicate = await scalarBigInt(
    connection,
    `SELECT count(*)::BIGINT AS value FROM (SELECT ${definition.uniqueColumns.map(quoteIdentifier).join(',')} FROM ${source} GROUP BY ${definition.uniqueColumns.map(quoteIdentifier).join(',')} HAVING count(*) > 1)`,
  );
  if (duplicate !== 0) throw new BoundedRowGrainError(definition.name);
  const result = await connection.stream(
    `SELECT ${definition.sortColumns.map(quoteIdentifier).join(',')} FROM ${source}`,
  );
  let previous: readonly unknown[] | undefined;
  for await (const batch of result.yieldRowObjectJs()) {
    for (const row of batch) {
      const current = definition.sortColumns.map((column) => row[column]);
      if (previous !== undefined && compareSortTuple(previous, current) > 0) {
        throw new BoundedRowOrderError(definition.name);
      }
      previous = current;
    }
  }
}

function compareSortTuple(left: readonly unknown[], right: readonly unknown[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const compared = compareSortScalar(left[index], right[index]);
    if (compared !== 0) return compared;
  }
  return 0;
}

function compareSortScalar(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return 1;
  if (right === null || right === undefined) return -1;
  if (typeof left === 'bigint' || typeof right === 'bigint') {
    const leftBigInt = typeof left === 'bigint' ? left : BigInt(Number(left));
    const rightBigInt = typeof right === 'bigint' ? right : BigInt(Number(right));
    return leftBigInt < rightBigInt ? -1 : 1;
  }
  if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : 1;
  if (typeof left === 'boolean' && typeof right === 'boolean') return left ? 1 : -1;
  if (typeof left === 'string' && typeof right === 'string') return compareUtf8(left, right);
  throw new BoundedScalarQueryError();
}

async function verifyTable(
  connection: DuckDBConnection,
  table: string,
  definition: ServingRelationDefinition,
  expectedRecords: number,
): Promise<void> {
  const count = await scalarBigInt(
    connection,
    `SELECT count(*)::BIGINT AS value FROM ${quoteIdentifier(table)}`,
  );
  if (count !== expectedRecords) throw new BoundedRowCountError(definition.name);
  const duplicates = await scalarBigInt(
    connection,
    `SELECT count(*)::BIGINT AS value FROM (SELECT ${definition.uniqueColumns.map(quoteIdentifier).join(',')} FROM ${quoteIdentifier(table)} GROUP BY ${definition.uniqueColumns.map(quoteIdentifier).join(',')} HAVING count(*) > 1)`,
  );
  if (duplicates !== 0) throw new BoundedRowGrainError(definition.name);
}

async function* readVerifiedRows(
  artifact: ImmutableBoundedArtifact,
  definition: ServingRelationDefinition,
  maximumLineBytes: number,
  policy: BoundedProcessingBudget,
  telemetry: ServingBudgetTelemetry,
): AsyncIterable<Readonly<{ row: ServingRow; residentBytes: number }>> {
  const path = artifactPath(artifact);
  const hash = createHash('sha256');
  let bytes = 0;
  let records = 0;
  let pending = Buffer.alloc(0);
  let releasePending = (): void => undefined;
  let firstSortKey: string | null = null;
  let lastSortKey: string | null = null;
  const highWaterMark = Math.max(
    1,
    Math.min(64 * 1024, maximumLineBytes, Math.floor(policy.maxBufferedBytes / 8)),
  );
  const releaseStreamBuffer = telemetry.acquire(0, highWaterMark);
  try {
    for await (const chunk of createReadStream(path, { highWaterMark })) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const releaseChunk = telemetry.acquire(0, buffer.byteLength);
      hash.update(buffer);
      bytes += buffer.byteLength;
      const combinedBytes = pending.byteLength + buffer.byteLength;
      let releaseCombined: () => void;
      try {
        releaseCombined = telemetry.acquire(0, combinedBytes);
      } catch (error) {
        releaseChunk();
        throw error;
      }
      let combined: Buffer;
      try {
        combined = Buffer.concat([pending, buffer], combinedBytes);
      } catch (error) {
        releaseCombined();
        throw error;
      } finally {
        releasePending();
        releaseChunk();
      }
      releasePending = (): void => undefined;
      let start = 0;
      try {
        for (let index = 0; index < combined.byteLength; index += 1) {
          if (combined[index] !== 10) continue;
          const line = combined.subarray(start, index);
          start = index + 1;
          if (line.byteLength > maximumLineBytes) throw new BoundedLineBudgetError();
          const residentBytes = Math.max(1, line.byteLength);
          const releaseRow = telemetry.acquire(1, residentBytes * 4);
          try {
            const row = validateRow(definition, JSON.parse(line.toString('utf8')) as unknown);
            const sortKey = rowSortKey(definition, row);
            firstSortKey ??= sortKey;
            lastSortKey = sortKey;
            records += 1;
            yield Object.freeze({ row, residentBytes });
          } finally {
            releaseRow();
          }
        }
        const remainderBytes = combined.byteLength - start;
        if (remainderBytes > maximumLineBytes) throw new BoundedLineBudgetError();
        const nextReleasePending = telemetry.acquire(0, remainderBytes);
        try {
          pending = Buffer.from(combined.subarray(start));
          releasePending = nextReleasePending;
        } catch (error) {
          nextReleasePending();
          throw error;
        }
      } finally {
        releaseCombined();
      }
    }
  } finally {
    releasePending();
    releaseStreamBuffer();
  }
  if (pending.byteLength !== 0) throw new BoundedReleaseCorruptionError(artifact.logicalKey);
  if (
    bytes !== artifact.byteSize ||
    hash.digest('hex') !== artifact.sha256 ||
    records !== artifact.recordCount ||
    firstSortKey !== artifact.firstSortKey ||
    lastSortKey !== artifact.lastSortKey
  ) {
    throw new BoundedReleaseCorruptionError(artifact.logicalKey);
  }
}

function validateRow(definition: ServingRelationDefinition, input: unknown): ServingRow {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new BoundedSchemaOrderError(definition.name);
  }
  const row = input as Readonly<Record<string, unknown>>;
  const keys = Object.keys(row).sort(compareUtf8);
  const expectedKeys = definition.columns.map(({ name }) => name).sort(compareUtf8);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new BoundedSchemaOrderError(definition.name);
  }
  for (const column of definition.columns) validateScalar(column, row[column.name]);
  return Object.freeze(row as ServingRow);
}

function validateScalar(column: ServingColumn, value: unknown): void {
  if (value === null) {
    if (!column.nullable) throw new BoundedSchemaOrderError(column.name);
    return;
  }
  const valid =
    column.duckdbType === 'VARCHAR'
      ? typeof value === 'string'
      : column.duckdbType === 'BOOLEAN'
        ? typeof value === 'boolean'
        : typeof value === 'number' &&
          Number.isFinite(value) &&
          (column.duckdbType !== 'BIGINT' || Number.isSafeInteger(value));
  if (!valid) throw new BoundedSchemaOrderError(column.name);
}

function appendRow(
  appender: DuckDBAppender,
  columns: readonly ServingColumn[],
  row: Readonly<Record<string, unknown>>,
): void {
  for (const column of columns) {
    const value = row[column.name];
    if (value === null || value === undefined) appender.appendNull();
    else if (column.duckdbType === 'VARCHAR' && typeof value === 'string') {
      appender.appendVarchar(value);
    } else if (column.duckdbType === 'BOOLEAN') appender.appendBoolean(Boolean(value));
    else if (column.duckdbType === 'BIGINT') appender.appendBigInt(BigInt(Number(value)));
    else appender.appendDouble(Number(value));
  }
  appender.endRow();
}

function appendPrivacyHashes(
  row: ServingRow,
  visibility: ServingVisibility,
  publicHashes: DuckDBAppender,
  restrictedHashes: DuckDBAppender,
): void {
  for (const [key, value] of Object.entries(row)) {
    if (visibility === 'public' && PUBLIC_PROHIBITED_COLUMN_PATTERN.test(key)) {
      throw new BoundedPublicPrivacyError(1);
    }
    if (key.endsWith('_json') && typeof value === 'string' && value.trim().length > 0) {
      const parsed = JSON.parse(value) as unknown;
      for (const leaf of jsonLeaves(parsed, false)) {
        if (visibility === 'public') {
          if (leaf.sensitive) throw new BoundedPublicPrivacyError(1);
          publicHashes.appendVarchar(valueHash(leaf.value));
          publicHashes.endRow();
        } else if (leaf.sensitive) {
          restrictedHashes.appendVarchar(valueHash(leaf.value));
          restrictedHashes.endRow();
        }
      }
      continue;
    }
    const semanticValue = privacySemanticValue(value);
    if (semanticValue === null) continue;
    if (visibility === 'public') {
      publicHashes.appendVarchar(valueHash(semanticValue));
      publicHashes.endRow();
    } else if (PUBLIC_PROHIBITED_COLUMN_PATTERN.test(key)) {
      restrictedHashes.appendVarchar(valueHash(semanticValue));
      restrictedHashes.endRow();
    }
  }
}

function* jsonLeaves(
  value: unknown,
  inheritedSensitive: boolean,
): Iterable<Readonly<{ value: string; sensitive: boolean }>> {
  const semanticValue = privacySemanticValue(value);
  if (semanticValue !== null) {
    yield Object.freeze({ value: semanticValue, sensitive: inheritedSensitive });
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* jsonLeaves(item, inheritedSensitive);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Readonly<Record<string, unknown>>)) {
    yield* jsonLeaves(
      child,
      inheritedSensitive || PUBLIC_PROHIBITED_COLUMN_PATTERN.test(key) || isSensitiveJsonKey(key),
    );
  }
}

function privacySemanticValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized.length === 0 ? null : `string:${normalized}`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `number:${JSON.stringify(value)}`;
  }
  if (typeof value === 'boolean') return `boolean:${String(value)}`;
  return null;
}

function isSensitiveJsonKey(key: string): boolean {
  const separated = key
    .normalize('NFKC')
    .replace(/([a-z\d])([A-Z])/gu, '$1 $2')
    .toLowerCase()
    .split(/[^a-z\d]+/gu)
    .filter((token) => token.length > 0);
  const collapsed = separated.join('');
  return (
    separated.some((token) => SENSITIVE_JSON_TOKENS.has(token)) ||
    collapsed.includes('mailingaddress') ||
    collapsed.includes('ownername')
  );
}

function assertInputArtifact(
  artifact: ImmutableBoundedArtifact,
  source: BoundedServingRelationInput,
  processing: BoundedProcessingInput,
): void {
  const expectedVisibility = source.visibility;
  if (
    artifact.sourceLineageSha256 !==
      boundedServingLineageSha256(source.releaseMetadata.sourceLineage) ||
    artifact.licenseIdentitySha256 !==
      boundedServingLicenseDecisionSha256(source.releaseMetadata.licenseDecision)
  ) {
    throw new BoundedReleaseMetadataError('Artifact lineage/license identity mismatch');
  }
  if (
    artifact.generationId !== processing.generationId ||
    artifact.stage !== 'build_marts' ||
    artifact.dataset !== `${source.visibility}/${source.relation}` ||
    artifact.schemaSha256 !== schemaSha256(BOUNDED_SERVING_RELATIONS[source.relation]) ||
    (expectedVisibility === 'public'
      ? artifact.visibility !== 'public'
      : artifact.visibility !== 'restricted' && artifact.visibility !== 'prohibited_public')
  ) {
    throw new BoundedMixedGenerationError();
  }
}

async function loadTrustedAcquisition(
  input: BoundedServingReleaseBuildInput,
): Promise<BoundedTrustedAcquisitionManifest> {
  const reference = boundedTrustedAcquisitionReferenceSchema.parse(
    input.trustedAcquisition.reference,
  );
  const manifest = boundedTrustedAcquisitionManifestSchema.parse(
    await input.trustedAcquisition.resolver.loadVerified(reference),
  );
  const processingSnapshots = new Set(
    input.processing.mutationLog.sources.map(
      ({ sourceId, snapshotId }) => `${sourceId}\0${snapshotId}`,
    ),
  );
  const trustedSnapshots = new Set(
    manifest.sources.map(({ sourceId, snapshotId }) => `${sourceId}\0${snapshotId}`),
  );
  if (
    reference.manifestSha256 !== manifest.manifestSha256 ||
    manifest.manifestSha256 !== input.processing.sourceManifestSha256 ||
    boundedTrustedCapabilityStateSha256(manifest) !== input.processing.capabilityStateSha256 ||
    manifest.runId !== input.processing.runId ||
    processingSnapshots.size !== input.processing.mutationLog.sources.length ||
    trustedSnapshots.size !== manifest.sources.length ||
    [...processingSnapshots].some((identity) => !trustedSnapshots.has(identity))
  ) {
    throw new BoundedReleaseGateError(
      'Processing input is not bound to the verified acquisition manifest',
    );
  }
  return manifest;
}

function assertReleaseInputBounds(input: BoundedServingReleaseBuildInput): void {
  const sharedBudget = input.sharedBudget as unknown;
  const trustedCanonicalLineage = input.trustedCanonicalLineage as unknown;
  if (
    sharedBudget === null ||
    typeof sharedBudget !== 'object' ||
    typeof (sharedBudget as ProcessWideServingBudgetCoordinator).acquire !== 'function' ||
    typeof (sharedBudget as ProcessWideServingBudgetCoordinator).assertPolicy !== 'function' ||
    typeof (sharedBudget as ProcessWideServingBudgetCoordinator).snapshot !== 'function'
  ) {
    throw new BoundedBuildConfigurationError('explicit shared process budget coordinator');
  }
  if (
    trustedCanonicalLineage === null ||
    typeof trustedCanonicalLineage !== 'object' ||
    typeof (trustedCanonicalLineage as BoundedTrustedCanonicalLineageResolver)
      .verifyPropertyQueryFieldReference !== 'function'
  ) {
    throw new BoundedBuildConfigurationError('trusted canonical lineage resolver');
  }
  if (input.relations.length !== 12) throw new BoundedRelationInventoryError();
  const assertMetadata = (metadata: BoundedServingReleaseMetadata): void => {
    if (metadata.sourceLineage.length > 64) {
      throw new BoundedBuildConfigurationError('source lineage bound');
    }
    if (metadata.limitations.length > 256) {
      throw new BoundedBuildConfigurationError('release limitations bound');
    }
    if (metadata.licenseDecision.licenseSnapshotRefs.length > 256) {
      throw new BoundedBuildConfigurationError('license references bound');
    }
    for (const lineage of metadata.sourceLineage) {
      if (lineage.contributors.length > 128) {
        throw new BoundedBuildConfigurationError('lineage contributors bound');
      }
    }
  };
  for (const relation of input.relations) {
    if (relation.artifacts !== undefined && relation.artifacts.length > 2_048) {
      throw new BoundedBuildConfigurationError('inline relation artifacts bound');
    }
    assertMetadata(relation.releaseMetadata);
  }
  assertMetadata(input.dictionaryReleaseMetadata.public);
  assertMetadata(input.dictionaryReleaseMetadata.restricted);
  if (input.releaseGate.sourceStates.length > 64) {
    throw new BoundedBuildConfigurationError('release source states bound');
  }
  if (input.releaseGate.capabilities.length > 64) {
    throw new BoundedBuildConfigurationError('release capabilities bound');
  }
  for (const source of input.releaseGate.sourceStates) {
    if (source.limitations.length > 256) {
      throw new BoundedBuildConfigurationError('source-state limitations bound');
    }
  }
  for (const capability of input.releaseGate.capabilities) {
    if (capability.sourceIds.length > 64 || capability.limitations.length > 256) {
      throw new BoundedBuildConfigurationError('capability metadata bound');
    }
  }
}

function canonicalizeReleaseBuildInput(
  input: BoundedServingReleaseBuildInput,
): BoundedServingReleaseBuildInput {
  return Object.freeze({
    ...input,
    relations: Object.freeze(
      input.relations
        .map((relation) =>
          Object.freeze({
            ...relation,
            releaseMetadata: canonicalizeReleaseMetadata(relation.releaseMetadata),
          }),
        )
        .sort((left, right) =>
          compareUtf8(
            `${left.visibility}\0${left.relation}`,
            `${right.visibility}\0${right.relation}`,
          ),
        ),
    ),
    dictionaryReleaseMetadata: Object.freeze({
      public: canonicalizeReleaseMetadata(input.dictionaryReleaseMetadata.public),
      restricted: canonicalizeReleaseMetadata(input.dictionaryReleaseMetadata.restricted),
    }),
    releaseGate: canonicalizeReleaseGate(input.releaseGate),
  });
}

function canonicalizeReleaseMetadata(
  metadata: BoundedServingReleaseMetadata,
): BoundedServingReleaseMetadata {
  return Object.freeze({
    sourceLineage: Object.freeze(
      metadata.sourceLineage
        .map((source) =>
          Object.freeze({
            ...source,
            contributors: Object.freeze(sortedUnique(source.contributors)),
          }),
        )
        .sort((left, right) =>
          compareUtf8(
            `${left.sourceId}\0${left.snapshotId}\0${left.role}`,
            `${right.sourceId}\0${right.snapshotId}\0${right.role}`,
          ),
        ),
    ),
    limitations: Object.freeze(sortedUnique(metadata.limitations)),
    licenseDecision: Object.freeze({
      ...metadata.licenseDecision,
      licenseSnapshotRefs: Object.freeze(
        sortedUnique(metadata.licenseDecision.licenseSnapshotRefs),
      ),
    }),
  });
}

function canonicalizeReleaseGate(
  gate: BoundedServingReleaseGateInput,
): BoundedServingReleaseGateInput {
  return Object.freeze({
    ...gate,
    sourceStates: Object.freeze(
      gate.sourceStates
        .map((source) =>
          Object.freeze({
            ...source,
            limitations: Object.freeze(sortedUnique(source.limitations)),
          }),
        )
        .sort((left, right) =>
          compareUtf8(
            `${left.sourceId}\0${left.snapshotId}`,
            `${right.sourceId}\0${right.snapshotId}`,
          ),
        ),
    ),
    capabilities: Object.freeze(
      gate.capabilities
        .map((capability) =>
          Object.freeze({
            ...capability,
            sourceIds: Object.freeze(sortedUnique(capability.sourceIds)),
            limitations: Object.freeze(sortedUnique(capability.limitations)),
          }),
        )
        .sort((left, right) => compareUtf8(left.capability, right.capability)),
    ),
  });
}

function validateBuildInput(
  input: BoundedServingReleaseBuildInput,
  trusted: BoundedTrustedAcquisitionManifest,
): void {
  const buildMarts = parseCompletedBuildMartsManifest(input.completedBuildMarts.manifest);
  const checkpointBuildMarts = input.checkpoint.completedStages.find(
    ({ stage }) => stage === 'build_marts',
  );
  if (
    buildMarts.stage !== 'build_marts' ||
    buildMarts.generationId !== input.processing.generationId ||
    checkpointBuildMarts?.outputManifestSha256 !== buildMarts.manifestSha256 ||
    ((buildMarts.artifactInventory ?? null) === null) !==
      (input.completedBuildMarts.resolver === undefined)
  ) {
    throw new BoundedBuildConfigurationError('exact completed build_marts manifest');
  }
  if (
    !Number.isSafeInteger(input.writeBatchRecords) ||
    input.writeBatchRecords < 1 ||
    input.writeBatchRecords > input.processing.budget.maxBufferedRecords
  ) {
    throw new BoundedBuildConfigurationError('writeBatchRecords');
  }
  if (
    !Number.isSafeInteger(input.maximumLineBytes) ||
    input.maximumLineBytes < 1 ||
    input.maximumLineBytes > input.processing.budget.maxBufferedBytes
  ) {
    throw new BoundedBuildConfigurationError('maximumLineBytes');
  }
  const publicLineage = new Set<string>();
  const manifestSourceIds = new Set<string>();
  for (const visibility of ['public', 'restricted'] as const) {
    for (const relation of BOUNDED_COUNTY_SERVING_RELATIONS) {
      const metadata = requiredRelation(input.relations, visibility, relation).releaseMetadata;
      const source = requiredRelation(input.relations, visibility, relation);
      const dataset = buildMarts.datasets.find(
        (candidate) => candidate.dataset === `${visibility}/${relation}`,
      );
      const rootedDataset = buildMarts.artifactInventory?.datasets.find(
        (candidate) => candidate.dataset === `${visibility}/${relation}`,
      );
      if (
        dataset?.recordCount !== source.recordCount ||
        (rootedDataset !== undefined &&
          (rootedDataset.artifactCount !== source.artifactRollup?.descriptorCount ||
            rootedDataset.recordCount !== source.artifactRollup.recordCount ||
            rootedDataset.rootSha256 !== source.artifactRollup.descriptorRootSha256))
      ) {
        throw new BoundedBuildConfigurationError(
          `${visibility}/${relation} build_marts membership root`,
        );
      }
      validateReleaseMetadata(metadata, visibility, trusted);
      for (const { sourceId, snapshotId } of metadata.sourceLineage) {
        manifestSourceIds.add(sourceId);
        if (visibility === 'public') publicLineage.add(`${sourceId}\0${snapshotId}`);
      }
    }
    validateReleaseMetadata(input.dictionaryReleaseMetadata[visibility], visibility, trusted);
    for (const { sourceId, snapshotId } of input.dictionaryReleaseMetadata[visibility]
      .sourceLineage) {
      manifestSourceIds.add(sourceId);
      if (visibility === 'public') publicLineage.add(`${sourceId}\0${snapshotId}`);
    }
  }
  validateReleaseGate(input.releaseGate, input.processing, trusted);
  const allowedSources = new Set(
    input.releaseGate.sourceStates
      .filter(({ permissionState }) => permissionState === 'allowed')
      .map(({ sourceId, snapshotId }) => `${sourceId}\0${snapshotId}`),
  );
  if ([...publicLineage].some((identity) => !allowedSources.has(identity))) {
    throw new BoundedReleaseGateError(
      'Public lineage contains a source without allowed permission',
    );
  }
  const capabilitySourceIds = new Set(
    input.releaseGate.capabilities.flatMap(({ sourceIds }) => sourceIds),
  );
  if (
    capabilitySourceIds.size !== manifestSourceIds.size ||
    [...manifestSourceIds].some((sourceId) => !capabilitySourceIds.has(sourceId))
  ) {
    throw new BoundedReleaseGateError('Capability source IDs must exactly cover manifest lineage');
  }
}

function requiredRelation(
  relations: readonly BoundedServingRelationInput[],
  visibility: ServingVisibility,
  relation: InputRelationName,
): BoundedServingRelationInput {
  const selected = relations.filter(
    (candidate) => candidate.visibility === visibility && candidate.relation === relation,
  );
  if (selected.length !== 1) throw new BoundedRelationInventoryError();
  const value = selected[0];
  if (value === undefined) throw new BoundedRelationInventoryError();
  if (!Number.isSafeInteger(value.recordCount) || value.recordCount < 0) {
    throw new BoundedRowCountError(relation);
  }
  const inline = value.artifacts;
  const rooted = value.artifactRollup;
  if (
    (inline === undefined) === (rooted === undefined) ||
    (rooted === undefined && value.streamArtifacts !== undefined) ||
    (rooted !== undefined && value.streamArtifacts === undefined) ||
    (inline !== undefined && inline.length > 2_048)
  ) {
    throw new BoundedBuildConfigurationError(`${visibility}/${relation} artifact inventory`);
  }
  return value;
}

async function* relationArtifacts(
  source: BoundedServingRelationInput,
): AsyncIterable<ImmutableBoundedArtifact> {
  if (source.artifacts !== undefined) {
    for (const artifact of source.artifacts) yield artifact;
    return;
  }
  if (source.streamArtifacts === undefined) {
    throw new BoundedBuildConfigurationError(`${source.visibility}/${source.relation} stream`);
  }
  yield* source.streamArtifacts();
}

async function* completedBuildMartsArtifacts(
  completed: BoundedServingReleaseBuildInput['completedBuildMarts'],
): AsyncIterable<ImmutableBoundedArtifact> {
  const manifest = parseCompletedBuildMartsManifest(completed.manifest);
  const rooted = manifest.artifactInventory ?? null;
  if (rooted === null) {
    for (const artifact of manifest.artifacts) yield artifact;
    return;
  }
  if (completed.resolver === undefined) {
    throw new BoundedBuildConfigurationError('build_marts descriptor page resolver');
  }
  const verified = streamVerifiedBoundedDescriptorInventory({
    root: rooted.root,
    resolver: completed.resolver,
    parseDescriptor: (value) => immutableBoundedArtifactSchema.parse(value),
    orderKey: boundedArtifactOrderKey,
    recordCount: (artifact) => artifact.recordCount,
    byteSize: (artifact) => artifact.byteSize,
  });
  try {
    for await (const artifact of verified.descriptors) yield artifact;
    await verified.completion;
  } catch (error) {
    // Consume the paired verifier rejection as well as the iterator failure so a
    // corrupt page cannot escape as an unhandled promise rejection.
    await verified.completion.catch(() => undefined);
    throw error;
  }
}

function parseCompletedBuildMartsManifest(value: unknown) {
  const parsed = boundedStageManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new BoundedBuildConfigurationError('exact completed build_marts manifest');
  }
  return parsed.data;
}

async function* exactRelationArtifacts(
  source: BoundedServingRelationInput,
  completed: BoundedServingReleaseBuildInput['completedBuildMarts'],
): AsyncIterable<ImmutableBoundedArtifact> {
  const expected = (async function* (): AsyncIterable<ImmutableBoundedArtifact> {
    for await (const artifact of completedBuildMartsArtifacts(completed)) {
      if (
        artifact.dataset === `${source.visibility}/${source.relation}` &&
        (source.visibility === 'public'
          ? artifact.visibility === 'public'
          : artifact.visibility === 'restricted' || artifact.visibility === 'prohibited_public')
      ) {
        yield artifact;
      }
    }
  })()[Symbol.asyncIterator]();
  for await (const artifact of relationArtifacts(source)) {
    const member = await expected.next();
    if (member.done || canonicalJson(member.value) !== canonicalJson(artifact)) {
      throw new BoundedReleaseCorruptionError(
        `${source.visibility}/${source.relation}/build_marts-membership`,
      );
    }
    yield artifact;
  }
  if (!(await expected.next()).done) {
    throw new BoundedReleaseCorruptionError(
      `${source.visibility}/${source.relation}/build_marts-omission`,
    );
  }
}

/** Verifies a repeatable county-scale descriptor stream without materializing it. */
export async function verifyBoundedServingArtifactInventory(
  source: BoundedServingRelationInput,
): Promise<void> {
  const verifiedSource = requiredRelation([source], source.visibility, source.relation);
  const verifier = new ArtifactInventoryVerifier(verifiedSource);
  for await (const artifact of relationArtifacts(verifiedSource)) verifier.observe(artifact);
  verifier.finish();
}

class ArtifactInventoryVerifier {
  private readonly hash = createHash('sha256');
  private descriptorCount = 0;
  private recordCount = 0;
  private byteSize = 0;
  private firstOrderKey: string | null = null;
  private lastOrderKey: string | null = null;

  public constructor(private readonly source: BoundedServingRelationInput) {}

  public observe(artifact: ImmutableBoundedArtifact): void {
    const orderKey = boundedArtifactOrderKey(artifact);
    if (this.lastOrderKey !== null && compareUtf8(this.lastOrderKey, orderKey) >= 0) {
      throw new BoundedRowOrderError(this.source.relation);
    }
    this.firstOrderKey ??= orderKey;
    this.lastOrderKey = orderKey;
    this.descriptorCount += 1;
    this.recordCount += artifact.recordCount;
    this.byteSize += artifact.byteSize;
    this.hash.update(`${canonicalJson(artifact)}\n`);
  }

  public finish(): void {
    const root = this.hash.digest('hex');
    const rollup = this.source.artifactRollup;
    if (this.recordCount !== this.source.recordCount) {
      throw new BoundedRowCountError(this.source.relation);
    }
    if (rollup === undefined) return;
    if (
      (rollup as Readonly<{ format: string }>).format !==
        'oracle-bounded-serving-artifact-rollup-v1' ||
      rollup.descriptorCount !== this.descriptorCount ||
      rollup.recordCount !== this.recordCount ||
      rollup.byteSize !== this.byteSize ||
      rollup.descriptorRootSha256 !== root ||
      rollup.firstOrderKey !== this.firstOrderKey ||
      rollup.lastOrderKey !== this.lastOrderKey
    ) {
      throw new BoundedReleaseCorruptionError(
        `${this.source.visibility}/${this.source.relation}/artifact-rollup`,
      );
    }
  }
}

class RelationContributorVerifier {
  private readonly observed = new Set<string>();
  private readonly allowed: Set<string>;
  private readonly trusted = new Map<
    string,
    BoundedTrustedAcquisitionManifest['sources'][number]
  >();
  private readonly exactRowLineage: boolean;

  public constructor(
    private readonly source: BoundedServingRelationInput,
    trusted: BoundedTrustedAcquisitionManifest,
    private readonly trustedCanonicalLineage: BoundedTrustedCanonicalLineageResolver,
  ) {
    this.allowed = new Set(source.releaseMetadata.sourceLineage.map(({ sourceId }) => sourceId));
    for (const value of trusted.sources) this.trusted.set(value.sourceId, value);
    const columns = new Set(
      BOUNDED_SERVING_RELATIONS[source.relation].columns.map(({ name }) => name),
    );
    const expectedRule = columns.has('source_references_json')
      ? 'source_ids_and_references_exact'
      : columns.has('source_ids_json')
        ? 'source_ids_exact'
        : columns.has('source_id')
          ? 'source_id_exact'
          : 'trusted_relation_metadata';
    if (source.rowLineageRule.kind !== expectedRule) {
      throw new BoundedReleaseMetadataError(
        `Relation ${source.relation} lacks its exact row-lineage rule`,
      );
    }
    if (
      source.rowLineageRule.kind === 'trusted_relation_metadata' &&
      ((source.rowLineageRule as unknown as Readonly<{ policyVersion: unknown }>).policyVersion !==
        'bounded-trusted-relation-lineage-v1' ||
        source.rowLineageRule.sourceLineageSha256 !==
          boundedServingLineageSha256(source.releaseMetadata.sourceLineage))
    ) {
      throw new BoundedReleaseMetadataError(
        `Relation ${source.relation} metadata lineage rule is stale`,
      );
    }
    this.exactRowLineage = expectedRule !== 'trusted_relation_metadata';
  }

  public async observe(row: ServingRow): Promise<void> {
    const sourceIds = row.source_ids_json;
    let parsedSourceIds: readonly string[] | null = null;
    if (typeof sourceIds === 'string') {
      const parsed = parseCanonicalStringArray(sourceIds, 'source_ids_json');
      if (parsed.length > 64) {
        throw new BoundedReleaseMetadataError('source_ids_json exceeds the source bound');
      }
      parsedSourceIds = parsed;
      if (this.source.relation === 'property_query') {
        await this.observePropertyQueryFields(row, parsed);
      }
      const references = row.source_references_json;
      if (this.source.rowLineageRule.kind === 'source_ids_and_references_exact') {
        if (typeof references !== 'string') {
          throw new BoundedReleaseMetadataError('source_references_json is required');
        }
        const rawReferences = parseCanonicalJsonArray(references, 'source_references_json');
        if (rawReferences.length > 64) {
          throw new BoundedReleaseMetadataError('source_references_json exceeds the source bound');
        }
        const referenceSourceIds: string[] = [];
        for (const rawReference of rawReferences) {
          const reference = parseEvidenceSourceReference(rawReference, 'source_references_json');
          this.observeTrustedReference(reference);
          referenceSourceIds.push(reference.sourceId);
        }
        if (
          canonicalJson(sortedUnique(referenceSourceIds)) !== canonicalJson(parsed) ||
          ((row.support_class === 'supported' || row.support_class === 'proxy') &&
            (rawReferences.length === 0 || parsed.length === 0)) ||
          ((row.support_class === 'unknown' || row.support_class === 'unsupported') &&
            rawReferences.length === 0 &&
            parsed.length !== 0)
        ) {
          throw new BoundedReleaseMetadataError(
            'source_references_json does not exactly match source_ids_json',
          );
        }
      }
      for (const sourceId of parsed) this.observeSourceId(sourceId);
    }
    if (typeof row.source_id === 'string') {
      if (parsedSourceIds !== null) {
        throw new BoundedReleaseMetadataError('Row has two competing contributor rules');
      }
      this.observeSourceId(row.source_id);
    }
  }

  public finish(): void {
    if (!this.exactRowLineage) return;
    if (
      this.observed.size !== this.allowed.size ||
      [...this.observed].some((sourceId) => !this.allowed.has(sourceId))
    ) {
      throw new BoundedReleaseMetadataError(
        `Relation ${this.source.relation} lineage differs from row contributors`,
      );
    }
  }

  private observeSourceId(sourceId: string): void {
    if (!this.allowed.has(sourceId)) {
      throw new BoundedReleaseMetadataError(
        `Row contributor ${sourceId} is absent from trusted relation lineage`,
      );
    }
    this.observed.add(sourceId);
  }

  private observeTrustedReference(
    reference: ReturnType<typeof evidenceSourceReferenceSchema.parse>,
  ): void {
    const acquired = this.trusted.get(reference.sourceId);
    if (
      acquired?.snapshotId !== reference.snapshotId ||
      !acquired.acquiredArtifacts.some(({ artifactId }) => artifactId === reference.artifactId)
    ) {
      throw new BoundedReleaseMetadataError(
        `Row reference ${reference.sourceId} is not trusted acquired evidence`,
      );
    }
    this.observeSourceId(reference.sourceId);
  }

  private async observePropertyQueryFields(
    row: ServingRow,
    rowSourceIds: readonly string[],
  ): Promise<void> {
    const encoded = row.field_source_ids_json;
    if (typeof encoded !== 'string') {
      throw new BoundedReleaseMetadataError(
        'property_query requires exact field_source_ids_json provenance',
      );
    }
    const fieldSources = parseCanonicalFieldSourceIds(encoded);
    const expectedFields = BOUNDED_SERVING_RELATIONS.property_query.columns
      .map(({ name }) => name)
      .filter((name) => name !== 'source_ids_json' && name !== 'field_source_ids_json');
    const actualFields = Object.keys(fieldSources).sort(compareUtf8);
    const canonicalExpected = [...expectedFields].sort(compareUtf8);
    if (
      actualFields.length !== canonicalExpected.length ||
      actualFields.some((name, index) => name !== canonicalExpected[index])
    ) {
      throw new BoundedReleaseMetadataError(
        'property_query field provenance does not cover the exact serving schema',
      );
    }
    const baseFields = new Set([
      'property_id',
      'parcel_identifier',
      'address_street',
      'address_city',
      'address_zip',
      'latitude',
      'longitude',
    ]);
    const propertyId = row.property_id;
    if (typeof propertyId !== 'string' || propertyId.trim().length === 0) {
      throw new BoundedReleaseMetadataError('property_query property_id is required');
    }
    const union: string[] = [];
    for (const fieldName of expectedFields) {
      const provenance = fieldSources[fieldName];
      if (provenance === undefined) {
        throw new BoundedReleaseMetadataError(
          `property_query field ${fieldName} is missing exact provenance`,
        );
      }
      const sources = provenance.sourceIds;
      const references = provenance.sourceReferences;
      if (
        baseFields.has(fieldName) &&
        ((row[fieldName] === null && sources.length !== 0) ||
          (row[fieldName] !== null && sources.length === 0))
      ) {
        throw new BoundedReleaseMetadataError(
          `property_query base field ${fieldName} has inexact provenance`,
        );
      }
      const fieldValue = row[fieldName];
      if (fieldValue === undefined) {
        throw new BoundedReleaseMetadataError(`property_query field ${fieldName} is absent`);
      }
      const referenceSourceIds: string[] = [];
      for (const reference of references) {
        this.observeTrustedReference(reference);
        if (
          !(await this.trustedCanonicalLineage.verifyPropertyQueryFieldReference({
            propertyId,
            fieldName,
            fieldValue,
            reference,
          }))
        ) {
          throw new BoundedReleaseMetadataError(
            `property_query field ${fieldName} reference is not trusted canonical lineage`,
          );
        }
        referenceSourceIds.push(reference.sourceId);
      }
      if (canonicalJson(sortedUnique(referenceSourceIds)) !== canonicalJson(sources)) {
        throw new BoundedReleaseMetadataError(
          `property_query field ${fieldName} source IDs differ from exact references`,
        );
      }
      const expectedLineageSha256 = propertyQueryFieldLineageSha256(
        fieldName,
        fieldValue,
        references,
      );
      if (provenance.fieldLineageSha256 !== expectedLineageSha256) {
        throw new BoundedReleaseMetadataError(
          `property_query field ${fieldName} lineage is not bound to its value and references`,
        );
      }
      union.push(...sources);
    }
    if (canonicalJson(sortedUnique(union)) !== canonicalJson(rowSourceIds)) {
      throw new BoundedReleaseMetadataError(
        'property_query row contributors differ from exact field provenance',
      );
    }
  }
}

async function checkpointArtifact(
  staging: string,
  checkpoint: BuildCheckpoint,
  artifact: BuildCheckpointArtifact,
  processing: BoundedProcessingInput,
): Promise<BuildCheckpoint> {
  const retained = checkpoint.artifacts.filter(
    (candidate) =>
      candidate.visibility !== artifact.visibility || candidate.relation !== artifact.relation,
  );
  const payload = {
    schemaVersion: 'oracle-bounded-serving-build-checkpoint-v1' as const,
    generationId: processing.generationId,
    logicalOutputIdentitySha256: processing.logicalOutputIdentitySha256,
    artifacts: Object.freeze([...retained, artifact].sort(compareCheckpointArtifacts)),
  };
  const next = Object.freeze({ ...payload, checkpointSha256: canonicalSha256(payload) });
  await writeMutableCanonicalJson(join(staging, BUILD_CHECKPOINT_FILE), next);
  return next;
}

async function loadBuildCheckpoint(
  staging: string,
  processing: BoundedProcessingInput,
): Promise<BuildCheckpoint> {
  const path = join(staging, BUILD_CHECKPOINT_FILE);
  if (!(await pathExists(path))) {
    const payload = {
      schemaVersion: 'oracle-bounded-serving-build-checkpoint-v1',
      generationId: processing.generationId,
      logicalOutputIdentitySha256: processing.logicalOutputIdentitySha256,
      artifacts: Object.freeze([]),
    } as const;
    return Object.freeze({ ...payload, checkpointSha256: canonicalSha256(payload) });
  }
  const parsed = (await readBoundedJson(path, 4 * 1024 * 1024)) as Readonly<
    Record<string, unknown>
  >;
  if (
    parsed.schemaVersion !== 'oracle-bounded-serving-build-checkpoint-v1' ||
    parsed.generationId !== processing.generationId ||
    parsed.logicalOutputIdentitySha256 !== processing.logicalOutputIdentitySha256 ||
    !Array.isArray(parsed.artifacts) ||
    parsed.artifacts.length > 14 ||
    parsed.checkpointSha256 !== canonicalSha256(withoutKey(parsed, 'checkpointSha256'))
  ) {
    throw new BoundedMixedGenerationError();
  }
  return parsed as BuildCheckpoint;
}

async function adoptExistingRelease(
  destination: string,
  processing: BoundedProcessingInput,
): Promise<BoundedServingReleaseResult> {
  const verified = await verifyBoundedServingRelease(destination);
  if (
    verified.manifest.releaseId !== processing.release.releaseId ||
    verified.manifest.runId !== processing.runId ||
    verified.evidence.logicalOutputIdentitySha256 !== processing.logicalOutputIdentitySha256
  ) {
    throw new BoundedFinalizationRaceError();
  }
  return Object.freeze({
    outputDirectory: destination,
    generationId: processing.generationId,
    manifest: verified.manifest,
    evidence: verified.evidence,
    adoptedIdenticalWinner: true,
  });
}

function assertManifestShape(
  manifest: BoundedServingReleaseManifest,
  evidence: BoundedServingReleaseEvidence,
): void {
  const manifestRecord = manifest as Readonly<Record<string, unknown>>;
  const evidenceRecord = evidence as Readonly<Record<string, unknown>>;
  const manifestSourceIds = new Set(
    manifest.artifacts.flatMap(({ sourceLineage }) =>
      sourceLineage.map(({ sourceId }) => sourceId),
    ),
  );
  const fullGateIncomplete =
    evidence.releaseScope === 'full_county' &&
    (evidence.permitAuthorityCoverage.covered !== 16 ||
      evidence.sourceStates.some(
        ({ terminalState, permissionState }) =>
          terminalState !== 'succeeded' || permissionState !== 'allowed',
      ) ||
      evidence.capabilities.some(
        ({ capability, state }) =>
          state !== 'succeeded' &&
          !(capability === 'transit_511_fallback' && state === 'not_configured'),
      ));
  const failedGate =
    (evidenceRecord.runStatus !== 'succeeded' && evidenceRecord.runStatus !== 'partial') ||
    evidence.sourceStates.some(({ terminalState }) => terminalState === 'failed') ||
    evidence.capabilities.some(({ state }) => state === 'failed');
  if (
    manifestRecord.contractVersion !== '1.0.0' ||
    manifest.manifestSha256 !== portableManifestSha256(withoutKey(manifest, 'manifestSha256')) ||
    manifest.artifacts.length !== 14 ||
    evidence.catalogs.length !== 2 ||
    evidenceRecord.contractVersion !== '1.0.0' ||
    evidence.evidenceSha256 !== canonicalSha256(withoutKey(evidence, 'evidenceSha256')) ||
    evidence.releaseId !== manifest.releaseId ||
    evidence.runId !== manifest.runId ||
    evidence.manifestSha256 !== manifest.manifestSha256 ||
    evidenceRecord.publicRestrictedValueOverlap !== 0 ||
    failedGate ||
    evidence.countyCompletionClaim !== (evidence.releaseScope === 'full_county') ||
    fullGateIncomplete ||
    manifestSourceIds.size !== manifest.sourceIds.length ||
    manifest.sourceIds.some((sourceId) => !manifestSourceIds.has(sourceId)) ||
    manifest.artifacts.some((artifact) => {
      const definition = BOUNDED_SERVING_RELATIONS[artifact.relation];
      return (
        artifact.grain !== definition.grain ||
        canonicalJson(artifact.columns) !== canonicalJson(definition.columns) ||
        Object.keys(artifact.nonNullCounts).length !== definition.columns.length
      );
    })
  ) {
    throw new BoundedReleaseCorruptionError('release metadata');
  }
}

async function scalarBigInt(connection: DuckDBConnection, statement: string): Promise<number> {
  const result = await connection.stream(statement);
  let found = false;
  let value = 0;
  for await (const batch of result.yieldRowObjectJs()) {
    for (const row of batch) {
      if (found || (typeof row.value !== 'bigint' && typeof row.value !== 'number')) {
        throw new BoundedScalarQueryError();
      }
      found = true;
      value = Number(row.value);
    }
  }
  if (!found || !Number.isSafeInteger(value) || value < 0) throw new BoundedScalarQueryError();
  return value;
}

async function scalarString(connection: DuckDBConnection, statement: string): Promise<string> {
  const result = await connection.stream(statement);
  let value: string | undefined;
  for await (const batch of result.yieldRowObjectJs()) {
    for (const row of batch) {
      if (value !== undefined || typeof row.value !== 'string' || row.value.length === 0) {
        throw new BoundedScalarQueryError();
      }
      value = row.value;
    }
  }
  if (value === undefined) throw new BoundedScalarQueryError();
  return value;
}

async function hashFile(path: string): Promise<Readonly<{ byteSize: number; sha256: string }>> {
  const hash = createHash('sha256');
  let byteSize = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(bytes);
    byteSize += bytes.byteLength;
  }
  return Object.freeze({ byteSize, sha256: hash.digest('hex') });
}

async function readBoundedJson(path: string, maximumBytes: number): Promise<unknown> {
  let bytes = 0;
  let text = '';
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maximumBytes) throw new BoundedLineBudgetError();
    text += buffer.toString('utf8');
  }
  return JSON.parse(text) as unknown;
}

async function writeCanonicalJson(path: string, value: unknown): Promise<void> {
  const body = `${canonicalJson(value)}\n`;
  const temporary = `${path}.tmp`;
  await writeFile(temporary, body, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, path).catch(async (error: unknown) => {
    if (!(await pathExists(path))) throw error;
    const existing = await readBoundedJson(path, Buffer.byteLength(body) + 1);
    if (canonicalJson(existing) !== canonicalJson(value))
      throw new BoundedOrphanMismatchError(path);
    await rm(temporary, { force: true });
  });
}

async function writeMutableCanonicalJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.next`;
  await writeFile(temporary, `${canonicalJson(value)}\n`, { encoding: 'utf8', flag: 'w' });
  await rename(temporary, path);
}

function createTableSql(table: string, columns: readonly ServingColumn[]): string {
  return `CREATE TABLE ${quoteIdentifier(table)} (${columns
    .map(
      (column) =>
        `${quoteIdentifier(column.name)} ${column.duckdbType}${column.nullable ? '' : ' NOT NULL'}`,
    )
    .join(',')})`;
}

function copyParquetSql(
  table: string,
  definition: ServingRelationDefinition,
  path: string,
): string {
  return `COPY (SELECT ${definition.columns.map(({ name }) => quoteIdentifier(name)).join(',')} FROM ${quoteIdentifier(table)} ORDER BY ${sortSql(definition)}) TO ${sqlLiteral(path)} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE ${PARQUET_ROW_GROUP_SIZE})`;
}

function sortSql(definition: ServingRelationDefinition): string {
  return definition.sortColumns.map(quoteIdentifier).join(',');
}

function tableName(visibility: ServingVisibility, relation: ServingRelationName): string {
  return `bounded_${visibility}_${relation}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function confinedPath(root: string, portablePath: string): string {
  const base = resolve(root);
  const candidate = resolve(base, portablePath);
  const relation = relative(base, candidate);
  if (relation.startsWith('..') || resolve(candidate) === base) {
    throw new BoundedPathConfinementError(portablePath);
  }
  return candidate;
}

function artifactPath(artifact: ImmutableBoundedArtifact): string {
  const url = new URL(artifact.uri);
  if (url.protocol !== 'file:') throw new BoundedPathConfinementError(artifact.uri);
  return fileURLToPath(url);
}

export function boundedServingSchemaSha256(relation: InputRelationName): string {
  return schemaSha256(BOUNDED_SERVING_RELATIONS[relation]);
}

export function boundedServingRowSortKey(relation: InputRelationName, row: ServingRow): string {
  return rowSortKey(BOUNDED_SERVING_RELATIONS[relation], row);
}

function schemaSha256(definition: ServingRelationDefinition): string {
  return canonicalSha256(definition.columns);
}

function rowSortKey(definition: ServingRelationDefinition, row: ServingRow): string {
  return canonicalJson(definition.sortColumns.map((column) => row[column] ?? null));
}

function valueHash(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

function dictionaryRowCount(): number {
  return BOUNDED_COUNTY_OUTPUT_RELATIONS.reduce(
    (total, relation) => total + BOUNDED_SERVING_RELATIONS[relation].columns.length,
    0,
  );
}

function compareCheckpointArtifacts(
  left: Pick<BuildCheckpointArtifact, 'visibility' | 'relation'>,
  right: Pick<BuildCheckpointArtifact, 'visibility' | 'relation'>,
): number {
  return compareUtf8(
    `${left.visibility}\0${left.relation}`,
    `${right.visibility}\0${right.relation}`,
  );
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function portableManifestSha256(value: unknown): string {
  return createHash('sha256')
    .update(`${canonicalJson(value)}\n`)
    .digest('hex');
}

export function boundedServingLineageSha256(
  lineage: readonly BoundedServingSourceLineage[],
): string {
  return canonicalSha256(
    canonicalizeReleaseMetadata({
      sourceLineage: lineage,
      limitations: [],
      licenseDecision: {
        policyVersion: '_hash_only_',
        contentClass: '_hash_only_',
        decision: 'restricted_only',
        licenseSnapshotRefs: ['_hash_only_'],
      },
    }).sourceLineage,
  );
}

export function boundedServingLicenseDecisionSha256(
  decision: BoundedServingLicenseDecision,
): string {
  return canonicalSha256({
    ...decision,
    licenseSnapshotRefs: sortedUnique(decision.licenseSnapshotRefs),
  });
}

function validateReleaseMetadata(
  metadata: BoundedServingReleaseMetadata,
  visibility: ServingVisibility,
  trusted: BoundedTrustedAcquisitionManifest,
): void {
  const identities = new Set<string>();
  const trustedSources = new Map<string, BoundedTrustedAcquisitionManifest['sources'][number]>(
    trusted.sources.map((source) => [source.sourceId, source]),
  );
  for (const source of metadata.sourceLineage) {
    const identity = `${source.sourceId}\0${source.snapshotId}`;
    if (identities.has(identity) || !trustedSources.has(source.sourceId)) {
      throw new BoundedReleaseMetadataError('lineage source/snapshot mismatch');
    }
    identities.add(identity);
    const acquired = trustedSources.get(source.sourceId);
    if (
      acquired?.snapshotId !== source.snapshotId ||
      acquired.sourceSha256 !== source.sourceSha256 ||
      acquired.schemaSha256 !== source.schemaSha256 ||
      acquired.asOf !== source.asOf ||
      canonicalJson(acquired.contributors) !== canonicalJson(source.contributors)
    ) {
      throw new BoundedReleaseMetadataError(
        'lineage source/schema/contributors differ from trusted acquisition evidence',
      );
    }
  }
  if (
    metadata.limitations.some((value) => value.trim().length === 0) ||
    new Set(metadata.limitations).size !== metadata.limitations.length ||
    metadata.licenseDecision.policyVersion.trim().length === 0 ||
    metadata.licenseDecision.contentClass.trim().length === 0 ||
    metadata.licenseDecision.licenseSnapshotRefs.length === 0 ||
    metadata.licenseDecision.licenseSnapshotRefs.some(
      (reference) => reference.trim().length === 0,
    ) ||
    new Set(metadata.licenseDecision.licenseSnapshotRefs).size !==
      metadata.licenseDecision.licenseSnapshotRefs.length ||
    (visibility === 'public' && metadata.licenseDecision.decision !== 'allowed_public')
  ) {
    throw new BoundedReleaseMetadataError('release metadata or license decision invalid');
  }
}

function validateReleaseGate(
  gate: BoundedServingReleaseGateInput,
  processing: BoundedProcessingInput,
  trusted: BoundedTrustedAcquisitionManifest,
): void {
  assertNoFailedReleaseState(gate);
  if (gate.requestedScope === 'full_county') {
    try {
      assertAuthoritativeCountyRegistry(trusted);
    } catch (error) {
      throw new BoundedReleaseGateError(
        error instanceof Error ? error.message : 'authoritative county registry rejected',
      );
    }
  }
  const trustedSourceStates = trusted.sources.map((source) => ({
    sourceId: source.sourceId,
    snapshotId: source.snapshotId,
    terminalState: source.terminalState,
    permissionState: source.permissionState,
    limitations: source.limitations,
  }));
  const trustedCapabilities = trusted.capabilities.map(
    ({ capability, state, sourceIds, limitations }) => ({
      capability,
      state,
      sourceIds,
      limitations,
    }),
  );
  const trustedPermitAuthorities = new Set(
    trusted.sources.flatMap(({ permitAuthorityIds }) => permitAuthorityIds),
  ).size;
  if (
    gate.sourceManifestSha256 !== trusted.manifestSha256 ||
    gate.sourceManifestSha256 !== processing.sourceManifestSha256 ||
    gate.capabilityStateSha256 !== boundedTrustedCapabilityStateSha256(trusted) ||
    gate.capabilityStateSha256 !== processing.capabilityStateSha256 ||
    gate.runStatus !== trusted.runStatus ||
    canonicalJson(gate.sourceStates) !== canonicalJson(trustedSourceStates) ||
    canonicalJson(gate.capabilities) !== canonicalJson(trustedCapabilities) ||
    gate.permitAuthoritiesCovered !== trustedPermitAuthorities ||
    !Number.isSafeInteger(gate.permitAuthoritiesCovered) ||
    gate.permitAuthoritiesCovered < 0 ||
    gate.permitAuthoritiesCovered > 16
  ) {
    throw new BoundedReleaseGateError('Release gate is not bound to the processing input');
  }
  const capabilities = new Set(gate.capabilities.map(({ capability }) => capability));
  if (
    gate.capabilities.length !== REAL_COUNTY_CAPABILITIES.length ||
    capabilities.size !== REAL_COUNTY_CAPABILITIES.length ||
    REAL_COUNTY_CAPABILITIES.some((capability) => !capabilities.has(capability))
  ) {
    throw new BoundedReleaseGateError('Every real-county capability requires an exact state');
  }
  const processingSnapshots = new Set(
    processing.mutationLog.sources.map(({ sourceId, snapshotId }) => `${sourceId}\0${snapshotId}`),
  );
  const gateSnapshots = new Set(
    gate.sourceStates.map(({ sourceId, snapshotId }) => `${sourceId}\0${snapshotId}`),
  );
  if (
    gateSnapshots.size !== gate.sourceStates.length ||
    [...processingSnapshots].some((identity) => !gateSnapshots.has(identity)) ||
    gate.sourceStates.some(
      ({ terminalState, permissionState, limitations }) =>
        (terminalState !== 'succeeded' || permissionState !== 'allowed') &&
        limitations.length === 0,
    ) ||
    gate.capabilities.some(
      ({ state, limitations, sourceIds }) =>
        (state !== 'succeeded' && limitations.length === 0) ||
        (state === 'not_configured' && sourceIds.length !== 0),
    )
  ) {
    throw new BoundedReleaseGateError('Release source/capability gates are incomplete');
  }
  releaseGateScope(gate);
}

function releaseGateScope(
  gate: BoundedServingReleaseGateInput,
): Extract<ReleaseScope, 'pilot' | 'partial_county' | 'full_county'> {
  assertNoFailedReleaseState(gate);
  if (gate.requestedScope !== 'full_county') return gate.requestedScope;
  const incompleteCapability = gate.capabilities.some(
    ({ capability, state }) =>
      state !== 'succeeded' &&
      !(capability === 'transit_511_fallback' && state === 'not_configured'),
  );
  const incompleteSource = gate.sourceStates.some(
    ({ terminalState, permissionState }) =>
      terminalState !== 'succeeded' || permissionState !== 'allowed',
  );
  if (
    gate.runStatus !== 'succeeded' ||
    incompleteCapability ||
    incompleteSource ||
    gate.permitAuthoritiesCovered !== 16
  ) {
    throw new BoundedReleaseGateError(
      'full_county requires a succeeded run, every required source/capability, and 16 authorities',
    );
  }
  return 'full_county';
}

function assertNoFailedReleaseState(gate: BoundedServingReleaseGateInput): void {
  if (
    gate.runStatus === 'failed' ||
    gate.sourceStates.some(({ terminalState }) => terminalState === 'failed') ||
    gate.capabilities.some(({ state }) => state === 'failed')
  ) {
    throw new BoundedReleaseGateError(
      'No release scope may finalize a failed run, acquisition, or capability',
    );
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Readonly<Record<string, unknown>>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  throw new TypeError(`Unsupported canonical value: ${typeof value}`);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareUtf8);
}

function parseCanonicalJsonArray(value: string, label: string): readonly unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new BoundedReleaseMetadataError(`${label} is not valid JSON`);
  }
  if (!Array.isArray(parsed) || canonicalJson(parsed) !== value) {
    throw new BoundedReleaseMetadataError(`${label} is not a canonical JSON array`);
  }
  return parsed;
}

function parseCanonicalStringArray(value: string, label: string): readonly string[] {
  const parsed = parseCanonicalJsonArray(value, label);
  if (parsed.length > 64) {
    throw new BoundedReleaseMetadataError(`${label} exceeds the source bound`);
  }
  if (
    parsed.some((item) => typeof item !== 'string' || item.trim().length === 0) ||
    canonicalJson(sortedUnique(parsed as string[])) !== value
  ) {
    throw new BoundedReleaseMetadataError(`${label} must be a canonical string set`);
  }
  return parsed as string[];
}

type PropertyQueryFieldProvenance = Readonly<{
  sourceIds: readonly string[];
  sourceReferences: readonly BoundedPropertyQuerySourceReference[];
  fieldLineageSha256: string;
}>;

function parseCanonicalFieldSourceIds(
  value: string,
): Readonly<Record<string, PropertyQueryFieldProvenance>> {
  const parsed = parseCanonicalJsonArray(value, 'field_source_ids_json');
  const entries: [string, PropertyQueryFieldProvenance][] = [];
  let previous: string | null = null;
  for (const item of parsed) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new BoundedReleaseMetadataError('field_source_ids_json entry is not an object');
    }
    const record = item as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).sort(compareUtf8);
    const expectedKeys = [
      'field_lineage_sha256',
      'field_name',
      'source_ids',
      'source_references',
    ].sort(compareUtf8);
    if (
      canonicalJson(keys) !== canonicalJson(expectedKeys) ||
      typeof record.field_name !== 'string' ||
      record.field_name.trim().length === 0 ||
      typeof record.field_lineage_sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(record.field_lineage_sha256) ||
      (previous !== null && compareUtf8(previous, record.field_name) >= 0)
    ) {
      throw new BoundedReleaseMetadataError(
        'field_source_ids_json entries must be exact, ordered, and unique',
      );
    }
    const sourceIds = parseCanonicalStringArray(
      canonicalJson(record.source_ids),
      `field_source_ids_json.${record.field_name}`,
    );
    if (!Array.isArray(record.source_references) || record.source_references.length > 64) {
      throw new BoundedReleaseMetadataError(
        `field_source_ids_json.${record.field_name} references exceed the exact bound`,
      );
    }
    const sourceReferences = record.source_references.map((reference) =>
      parsePropertyQuerySourceReference(
        reference,
        `field_source_ids_json.${record.field_name}.source_references`,
      ),
    );
    const canonicalReferences = [...sourceReferences].sort((left, right) =>
      compareUtf8(canonicalJson(left), canonicalJson(right)),
    );
    if (
      canonicalJson(canonicalReferences) !== canonicalJson(record.source_references) ||
      new Set(canonicalReferences.map((reference) => canonicalJson(reference))).size !==
        canonicalReferences.length
    ) {
      throw new BoundedReleaseMetadataError(
        `field_source_ids_json.${record.field_name} references must be canonical and unique`,
      );
    }
    previous = record.field_name;
    entries.push([
      record.field_name,
      Object.freeze({
        sourceIds,
        sourceReferences: Object.freeze(sourceReferences),
        fieldLineageSha256: record.field_lineage_sha256,
      }),
    ]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function parseEvidenceSourceReference(
  value: unknown,
  label: string,
): ReturnType<typeof evidenceSourceReferenceSchema.parse> {
  let reference: ReturnType<typeof evidenceSourceReferenceSchema.parse>;
  try {
    reference = evidenceSourceReferenceSchema.parse(value);
  } catch {
    throw new BoundedReleaseMetadataError(`${label} contains an invalid source reference`);
  }
  if (canonicalJson(reference.fieldPaths) !== canonicalJson(sortedUnique(reference.fieldPaths))) {
    throw new BoundedReleaseMetadataError(`${label} field paths must be canonical and unique`);
  }
  return reference;
}

function parsePropertyQuerySourceReference(
  value: unknown,
  label: string,
): BoundedPropertyQuerySourceReference {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BoundedReleaseMetadataError(`${label} contains an invalid source reference`);
  }
  const record = value as Readonly<Record<string, unknown>>;
  const expectedKeys = [
    'artifactId',
    'fieldPaths',
    'lineageSha256',
    'recordKey',
    'recordSha256',
    'snapshotId',
    'sourceId',
  ].sort(compareUtf8);
  if (
    canonicalJson(Object.keys(record).sort(compareUtf8)) !== canonicalJson(expectedKeys) ||
    typeof record.recordSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(record.recordSha256) ||
    typeof record.lineageSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(record.lineageSha256)
  ) {
    throw new BoundedReleaseMetadataError(`${label} omits trusted canonical lineage identity`);
  }
  const reference = parseEvidenceSourceReference(
    {
      sourceId: record.sourceId,
      snapshotId: record.snapshotId,
      artifactId: record.artifactId,
      recordKey: record.recordKey,
      fieldPaths: record.fieldPaths,
    },
    label,
  );
  return Object.freeze({
    ...reference,
    recordSha256: record.recordSha256,
    lineageSha256: record.lineageSha256,
  });
}

function propertyQueryFieldLineageSha256(
  fieldName: string,
  value: ServingRow[string] | undefined,
  sourceReferences: readonly BoundedPropertyQuerySourceReference[],
): string {
  if (value === undefined) {
    throw new BoundedReleaseMetadataError(`property_query field ${fieldName} is absent`);
  }
  return createHash('sha256')
    .update(
      `${canonicalJson({
        contract: 'oracle-property-query-field-lineage-v1',
        fieldName,
        value,
        sourceReferences,
      })}\n`,
    )
    .digest('hex');
}

function assertExactFinalizationResult(
  expected: BoundedReleaseFinalizationWinner,
  observed: BoundedReleaseFinalizationWinner,
): void {
  if (
    expected.destinationIdentitySha256 !== observed.destinationIdentitySha256 ||
    expected.generationId !== observed.generationId ||
    expected.releaseManifestSha256 !== observed.releaseManifestSha256 ||
    expected.releaseEvidenceSha256 !== observed.releaseEvidenceSha256 ||
    expected.expectedRevision !== observed.expectedRevision ||
    expected.attemptId !== observed.attemptId
  ) {
    throw new BoundedFinalizationRaceError();
  }
}

async function assertFinalizationWinner(
  coordinator: BoundedReleaseFinalizationCoordinator,
  expectedRevision: string,
  attemptId: string,
  release: BoundedServingReleaseResult,
): Promise<void> {
  const destinationIdentitySha256 = canonicalSha256({
    releaseId: release.manifest.releaseId,
    contractVersion: release.manifest.contractVersion,
    destination: resolve(release.outputDirectory),
  });
  const winner = await coordinator.inspect(destinationIdentitySha256);
  if (
    winner === null ||
    winner.revision.trim().length === 0 ||
    winner.revision === expectedRevision
  ) {
    throw new BoundedFinalizationRaceError();
  }
  assertExactFinalizationResult(
    {
      destinationIdentitySha256,
      generationId: release.generationId,
      releaseManifestSha256: release.manifest.manifestSha256,
      releaseEvidenceSha256: release.evidence.evidenceSha256,
      expectedRevision,
      attemptId,
    },
    winner.winner,
  );
}

function withoutKey(value: object, key: string): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== key));
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

export class BoundedReleaseCorruptionError extends Error {
  public constructor(public readonly target: string) {
    super(`Bounded release artifact is missing or corrupt: ${target}`);
    this.name = 'BoundedReleaseCorruptionError';
  }
}

export class BoundedPublicPrivacyError extends Error {
  public constructor(public readonly findingCount: number) {
    super(`Bounded public release privacy gate failed with ${findingCount} finding(s)`);
    this.name = 'BoundedPublicPrivacyError';
  }
}

export class BoundedFinalizationRaceError extends Error {
  public constructor() {
    super('Bounded release destination has a nonidentical finalization winner');
    this.name = 'BoundedFinalizationRaceError';
  }
}

export class BoundedMixedGenerationError extends Error {
  public constructor() {
    super('Bounded release input or checkpoint mixed processing generations');
    this.name = 'BoundedMixedGenerationError';
  }
}

export class BoundedOrphanMismatchError extends Error {
  public constructor(public readonly target: string) {
    super(`Bounded release orphan differs from the deterministic write: ${target}`);
    this.name = 'BoundedOrphanMismatchError';
  }
}

export class BoundedRelationInventoryError extends Error {
  public constructor() {
    super('Bounded release requires exactly seven relations per visibility profile');
    this.name = 'BoundedRelationInventoryError';
  }
}

export class BoundedRowCountError extends Error {
  public constructor(public readonly relation: string) {
    super(`Bounded relation row count changed: ${relation}`);
    this.name = 'BoundedRowCountError';
  }
}

export class BoundedRowOrderError extends Error {
  public constructor(public readonly relation: string) {
    super(`Bounded relation order changed: ${relation}`);
    this.name = 'BoundedRowOrderError';
  }
}

export class BoundedRowGrainError extends Error {
  public constructor(public readonly relation: string) {
    super(`Bounded relation unique grain changed: ${relation}`);
    this.name = 'BoundedRowGrainError';
  }
}

export class BoundedSchemaOrderError extends Error {
  public constructor(public readonly relation: string) {
    super(`Bounded relation schema/order changed: ${relation}`);
    this.name = 'BoundedSchemaOrderError';
  }
}

export class BoundedLineBudgetError extends Error {
  public constructor() {
    super('Bounded release input line exceeded the shared byte budget');
    this.name = 'BoundedLineBudgetError';
  }
}

export class BoundedServingBudgetError extends Error {
  public readonly code = 'BOUNDED_BUDGET_EXCEEDED' as const;

  public constructor(message: string) {
    super(message);
    this.name = 'BoundedServingBudgetError';
  }
}

export class BoundedReleaseMetadataError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'BoundedReleaseMetadataError';
  }
}

export class BoundedReleaseGateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'BoundedReleaseGateError';
  }
}

export class BoundedBuildConfigurationError extends Error {
  public constructor(public readonly field: string) {
    super(`Invalid bounded release build setting: ${field}`);
    this.name = 'BoundedBuildConfigurationError';
  }
}

export class BoundedScalarQueryError extends Error {
  public constructor() {
    super('Bounded scalar verification query returned an invalid shape');
    this.name = 'BoundedScalarQueryError';
  }
}

export class BoundedPathConfinementError extends Error {
  public constructor(public readonly target: string) {
    super(`Bounded release path escaped its owned root: ${target}`);
    this.name = 'BoundedPathConfinementError';
  }
}
