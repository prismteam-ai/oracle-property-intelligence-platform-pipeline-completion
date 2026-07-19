import { createHash } from 'node:crypto';

import { AtomicPromotionExhaustedError } from '@oracle/artifacts/artifact-store';
import type { CheckpointEnvelope } from '@oracle/artifacts/checkpoint-store';
import type { CanonicalMutation } from '@oracle/contracts/canonical/mutation';
import type { SourceId } from '@oracle/contracts/ids';
import { sourceCheckpointSchema } from '@oracle/contracts/source';
import type {
  AcquisitionPlan,
  AcquisitionRequest,
  AcquiredArtifact,
  SourceCheckpoint,
  SourceRunSummary,
  ValidationIssue,
} from '@oracle/contracts/source';
import {
  createAcquiredByteArtifact,
  durableAcquiredArtifactReference,
  LEGACY_WHOLE_COPY_MAX_BYTES,
  openDurableAcquiredArtifactReference,
  type AcquiredArtifactSource,
  type AcquiredByteArtifact,
  type DurableAcquiredArtifactReference,
} from '@oracle/source-adapters/spi/acquired-artifact';
import type {
  DiscoveryResult,
  SourceAdapter,
  SourceRunObservation,
  SourceRunObservationV2,
  StreamingSourceAdapter,
  RepeatableAcquiredArtifactSources,
} from '@oracle/source-adapters/spi/adapter';
import {
  createSharedRecordBudget,
  type RecordBudgetLease,
  type SharedRecordBudget,
} from '@oracle/source-adapters/spi/record-budget';

import { readJsonArtifact, writeJsonArtifact } from './artifacts.js';
import { canonicalJson, sha256 } from './canonical-json.js';
import { commitRunState, loadRunState } from './checkpoint.js';
import {
  CanonicalChunkWriter,
  combineChunkSequences,
  emptyChunkLedger,
  emptyChunkSequence,
  migrateLegacyChunkLedger,
  openChunkSequence,
  openChunkSequencePrefix,
  openLedgerChunkSequence,
  openLedgerChunkSequencePrefix,
  type ChunkLedger,
  type ChunkReference,
  type ChunkSequence,
} from './chunks.js';
import { acquisitionModeFor } from './profiles.js';
import {
  ORCHESTRATION_PHASES,
  type OrchestrationDependencies,
  type OrchestrationPhase,
  type NormalizationCursor,
  type PersistedRunState,
  type PersistedSourceState,
  type PhaseArtifact,
  type PhaseTiming,
  type PipelineConfiguration,
  type PipelineResult,
  type PipelineRunManifest,
  type SourceConfiguration,
  type SourceCoverage,
  type SourceExecutionManifest,
  type SourceTerminalState,
} from './types.js';

const SOURCE_PHASES = ORCHESTRATION_PHASES.slice(0, 7);
const LEGACY_OBSERVATION_MAX_VALUES = 10_000;
const BORROWED_RECORD_LEASE: RecordBudgetLease = Object.freeze({ release: () => undefined });
const NORMALIZATION_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

function normalizationRecordByteCap(): number {
  return Math.min(1024 * 1024, Math.floor(NORMALIZATION_MAX_BUFFERED_BYTES / 16));
}

function normalizationChunkByteCap(): number {
  return Math.min(4 * 1024 * 1024, Math.floor(NORMALIZATION_MAX_BUFFERED_BYTES / 4));
}

interface MutableRun {
  envelope: CheckpointEnvelope | undefined;
  state: PersistedRunState;
}

type SourceRuntime = Readonly<{
  state: PersistedSourceState;
  mutations: ChunkSequence<CanonicalMutation>;
  manifest: SourceExecutionManifest;
  acquired: readonly AcquiredArtifact[];
}>;

type NormalizationEvent =
  | Readonly<{
      schemaVersion: '2.0.0';
      kind: 'record_start';
      cursor: NormalizationCursor;
    }>
  | Readonly<{
      schemaVersion: '2.0.0';
      kind: 'validation_issue';
      cursor: NormalizationCursor;
      value: ValidationIssue;
    }>
  | Readonly<{
      schemaVersion: '2.0.0';
      kind: 'mutation';
      cursor: NormalizationCursor;
      value: CanonicalMutation;
    }>
  | Readonly<{
      schemaVersion: '2.0.0';
      kind: 'record_complete';
      cursor: NormalizationCursor;
    }>;

export const REQUIRED_COUNTY_CAPABILITIES = Object.freeze([
  'santa_clara_parcels',
  'san_jose_permits',
  'palo_alto_year_built',
  'vta_gtfs',
  'caltrain_gtfs',
  'osm_pedestrian_graph',
  'noaa_shoreline',
  'usgs_hydrography',
  'usgs_elevation',
  'overture_starbucks',
  'cslb_contractors',
  'ca_sos_businesses',
  'ownership_transfers',
  'santa_clara_fbn',
] as const);

function normalizationLogicalPrefix(runId: string, sourceId: string): string {
  return `runs/${runId.replace('sc:run:', '')}/${sourceId.replaceAll(/[^a-zA-Z0-9._~-]/gu, '-')}/normalize/events`;
}

function mutationLogicalPrefix(runId: string, sourceId: string): string {
  return `runs/${runId.replace('sc:run:', '')}/${sourceId.replaceAll(/[^a-zA-Z0-9._~-]/gu, '-')}/normalize/mutations`;
}

function validationIssueLogicalPrefix(runId: string, sourceId: string): string {
  return `runs/${runId.replace('sc:run:', '')}/${sourceId.replaceAll(/[^a-zA-Z0-9._~-]/gu, '-')}/normalize/validation-issues`;
}

function emptySource(runId: string, source: SourceConfiguration): PersistedSourceState {
  const sourceId = source.adapter.describe().sourceId;
  return Object.freeze({
    sourceId,
    snapshotId: source.snapshotId,
    completedPhase: null,
    discoveryArtifact: null,
    planArtifact: null,
    acquiredArtifact: null,
    acquisitionChunks: Object.freeze([]),
    acquisitionRecords: 0,
    acquisitionLogicalSha256: null,
    mutationArtifact: null,
    mutationLogicalSha256: null,
    validationIssueLogicalSha256: null,
    normalizationLedger: emptyChunkLedger(normalizationLogicalPrefix(runId, sourceId)),
    mutationLedger: emptyChunkLedger(mutationLogicalPrefix(runId, sourceId)),
    validationIssueLedger: emptyChunkLedger(validationIssueLogicalPrefix(runId, sourceId)),
    normalizationEventRecords: 0,
    normalizationLogicalSha256: null,
    normalizationCursor: null,
    summaryArtifact: null,
    manifestArtifact: null,
    decodedRecords: 0,
    acceptedRecords: 0,
    rejectedRecords: 0,
    mutationRecords: 0,
    validationIssueRecords: 0,
    timings: Object.freeze([]),
    terminalState: null,
    limitations: Object.freeze(source.limitations ?? []),
    errorCodes: Object.freeze([]),
  });
}

function initialState(
  configuration: PipelineConfiguration,
  configurationHash: string,
): PersistedRunState {
  return Object.freeze({
    schemaVersion: 2,
    runId: configuration.runId,
    configurationHash,
    sources: Object.freeze(
      configuration.sources.map((source) => emptySource(configuration.runId, source)),
    ),
    reconcileArtifact: null,
    featureArtifact: null,
    martArtifact: null,
    manifestArtifact: null,
    completedPhase: null,
  });
}

async function migrateLegacyNormalizationLedgers(
  state: PersistedRunState,
  configuration: PipelineConfiguration,
  expectedConfigurationHash: string,
  dependencies: OrchestrationDependencies,
): Promise<Readonly<{ state: PersistedRunState; migrated: boolean }>> {
  const format = classifyNormalizationCheckpointFormat(state);
  if (format === 'legacy') {
    assertLegacyMigrationPreconditions(state, configuration, expectedConfigurationHash);
    if (
      (await dependencies.checkpointStore.load(`bounded-processing:${configuration.runId}`)) !==
      undefined
    ) {
      throw new Error('Legacy normalization cannot migrate after bounded processing has begun');
    }
  }
  let migrated = false;
  const sources: PersistedSourceState[] = [];
  for (const source of state.sources) {
    const configuredSource = configuration.sources.find(
      ({ adapter }) => adapter.describe().sourceId === source.sourceId,
    );
    if (configuredSource === undefined) {
      throw new Error(`Checkpoint source is absent from configuration: ${source.sourceId}`);
    }
    const normalizationSkipped =
      configuration.profile.name === 'discovery' ||
      configuredSource.executionMode === 'discover_only';
    const raw = source as unknown as Record<string, unknown>;
    const eventPrefix = normalizationLogicalPrefix(state.runId, source.sourceId);
    if (format === 'current') {
      const candidate = source;
      await validateMigratedNormalizationState(
        source,
        candidate.normalizationLedger,
        eventPrefix,
        dependencies,
        normalizationSkipped,
      );
      const mutations = await openLedgerChunkSequencePrefix(
        dependencies.artifactStore,
        candidate.mutationLedger,
        mutationLogicalPrefix(state.runId, source.sourceId),
      );
      const validationIssues = await openLedgerChunkSequencePrefix(
        dependencies.artifactStore,
        candidate.validationIssueLedger,
        validationIssueLogicalPrefix(state.runId, source.sourceId),
      );
      assertSkippedProjectionLedgers(source, mutations, validationIssues, normalizationSkipped);
      sources.push(candidate);
      continue;
    }
    const legacyReferences = raw.normalizationChunks as readonly ChunkReference[];
    assertLegacyProjectionInventories(raw, legacyReferences, source);
    const verified = await openChunkSequencePrefix<NormalizationEvent>(
      dependencies.artifactStore,
      legacyReferences,
      eventPrefix,
    );
    assertNormalizationOuterIdentity(
      source,
      verified,
      legacyReferences.at(-1)?.resumeCursor ?? null,
      normalizationSkipped,
    );
    await assertNormalizationProjectionIdentity(source, verified, normalizationSkipped);
    const normalizationLedger = await migrateLegacyChunkLedger(
      dependencies.artifactStore,
      eventPrefix,
      legacyReferences,
    );
    await validateMigratedNormalizationState(
      source,
      normalizationLedger,
      eventPrefix,
      dependencies,
      normalizationSkipped,
    );
    const migratedSource = { ...raw };
    delete migratedSource.normalizationChunks;
    delete migratedSource.mutationChunks;
    delete migratedSource.validationIssueChunks;
    migratedSource.mutationLedger = emptyChunkLedger(
      mutationLogicalPrefix(state.runId, source.sourceId),
    );
    migratedSource.validationIssueLedger = emptyChunkLedger(
      validationIssueLogicalPrefix(state.runId, source.sourceId),
    );
    const candidate = Object.freeze({
      ...migratedSource,
      normalizationLedger,
    }) as PersistedSourceState;
    const mutations = await openLedgerChunkSequencePrefix(
      dependencies.artifactStore,
      candidate.mutationLedger,
      mutationLogicalPrefix(state.runId, source.sourceId),
    );
    const validationIssues = await openLedgerChunkSequencePrefix(
      dependencies.artifactStore,
      candidate.validationIssueLedger,
      validationIssueLogicalPrefix(state.runId, source.sourceId),
    );
    assertSkippedProjectionLedgers(source, mutations, validationIssues, normalizationSkipped);
    sources.push(candidate);
    migrated = true;
  }
  return Object.freeze({
    state: migrated ? Object.freeze({ ...state, sources: Object.freeze(sources) }) : state,
    migrated,
  });
}

type NormalizationCheckpointFormat = 'legacy' | 'current';

function classifyNormalizationCheckpointFormat(
  state: PersistedRunState,
): NormalizationCheckpointFormat {
  const formats = state.sources.map((source): NormalizationCheckpointFormat => {
    const raw = source as unknown as Record<string, unknown>;
    const legacyFields = [raw.normalizationChunks, raw.mutationChunks, raw.validationIssueChunks];
    const ledgerFields = [raw.normalizationLedger, raw.mutationLedger, raw.validationIssueLedger];
    const fullyLegacy =
      legacyFields.every((value) => Array.isArray(value)) &&
      ledgerFields.every((value) => value === undefined);
    const fullyCurrent =
      legacyFields.every((value) => value === undefined) &&
      ledgerFields.every(
        (value) =>
          typeof value === 'object' &&
          value !== null &&
          (value as { schemaVersion?: unknown }).schemaVersion === 'oracle-chunk-ledger-v1',
      );
    if (fullyLegacy === fullyCurrent) {
      throw new Error(
        `Checkpoint source has mixed or incomplete chunk formats: ${source.sourceId}`,
      );
    }
    return fullyLegacy ? 'legacy' : 'current';
  });
  const first = formats[0];
  if (first === undefined || formats.some((format) => format !== first)) {
    throw new Error('Checkpoint run mixes legacy and current chunk formats');
  }
  return first;
}

function assertLegacyProjectionInventories(
  source: Readonly<Record<string, unknown>>,
  normalizationChunks: readonly ChunkReference[],
  persisted: PersistedSourceState,
): void {
  for (const field of ['mutationChunks', 'validationIssueChunks'] as const) {
    const alias = source[field];
    const valid = phaseCompleted(persisted, 'normalize')
      ? Array.isArray(alias) && canonicalJson(alias) === canonicalJson(normalizationChunks)
      : Array.isArray(alias) && alias.length === 0;
    if (!valid) {
      throw new Error(
        `Legacy ${field} has invalid ${phaseCompleted(persisted, 'normalize') ? 'completed alias' : 'partial zero-state'} semantics for ${persisted.sourceId}`,
      );
    }
  }
}

function assertLegacyMigrationPreconditions(
  state: PersistedRunState,
  configuration: PipelineConfiguration,
  expectedConfigurationHash: string,
): void {
  if (
    state.runId !== configuration.runId ||
    state.configurationHash !== expectedConfigurationHash
  ) {
    throw new Error('Legacy checkpoint run/configuration identity changed');
  }
  if (
    state.reconcileArtifact !== null ||
    state.featureArtifact !== null ||
    state.martArtifact !== null ||
    state.manifestArtifact !== null ||
    state.completedPhase !== null
  ) {
    throw new Error('Legacy normalization cannot migrate after downstream authority has begun');
  }
  const expectedSources = configuration.sources.map((configured) => ({
    sourceId: configured.adapter.describe().sourceId,
    snapshotId: configured.snapshotId,
  }));
  if (
    state.sources.length !== expectedSources.length ||
    new Set(state.sources.map(({ sourceId }) => sourceId)).size !== state.sources.length
  ) {
    throw new Error('Legacy checkpoint source inventory is incomplete or duplicated');
  }
  for (const [index, source] of state.sources.entries()) {
    const expected = expectedSources[index];
    if (source.sourceId !== expected?.sourceId || source.snapshotId !== expected.snapshotId) {
      throw new Error('Legacy checkpoint source order or snapshot identity changed');
    }
    const configuredSource = configuration.sources[index];
    if (configuredSource === undefined) {
      throw new Error('Legacy checkpoint source configuration is incomplete');
    }
    const normalizationSkipped =
      configuration.profile.name === 'discovery' ||
      configuredSource.executionMode === 'discover_only';
    for (const key of [
      'acquisitionRecords',
      'normalizationEventRecords',
      'decodedRecords',
      'acceptedRecords',
      'rejectedRecords',
      'mutationRecords',
      'validationIssueRecords',
    ] as const) {
      if (!Number.isSafeInteger(source[key]) || source[key] < 0) {
        throw new Error(`Legacy checkpoint has an invalid ${key} counter`);
      }
    }
    if (source.acceptedRecords + source.rejectedRecords !== source.decodedRecords) {
      throw new Error(`Legacy checkpoint record balance changed for ${source.sourceId}`);
    }
    const missingNormalizationIdentity =
      source.normalizationLogicalSha256 === null &&
      source.mutationLogicalSha256 === null &&
      source.validationIssueLogicalSha256 === null;
    if (
      normalizationSkipped
        ? !missingNormalizationIdentity
        : (source.normalizationLogicalSha256 === null) !== !phaseCompleted(source, 'normalize') ||
          (source.mutationLogicalSha256 === null) !== !phaseCompleted(source, 'normalize') ||
          (source.validationIssueLogicalSha256 === null) !== !phaseCompleted(source, 'normalize')
    ) {
      throw new Error(`Legacy normalization identity state is inconsistent for ${source.sourceId}`);
    }
    if (
      (normalizationSkipped || !phaseCompleted(source, 'normalize')) &&
      (source.normalizationEventRecords !== 0 ||
        source.mutationRecords !== 0 ||
        source.validationIssueRecords !== 0)
    ) {
      throw new Error(`Legacy projection zero-state is inconsistent for ${source.sourceId}`);
    }
    const cursor = source.normalizationCursor;
    if (cursor !== null) {
      const parsed = parseNormalizationCursor(canonicalJson(cursor));
      if (
        parsed?.decodedRecords !== source.decodedRecords ||
        parsed.acceptedRecords !== source.acceptedRecords ||
        parsed.rejectedRecords !== source.rejectedRecords
      ) {
        throw new Error(`Legacy normalization cursor counters changed for ${source.sourceId}`);
      }
    } else if (
      source.decodedRecords !== 0 ||
      source.acceptedRecords !== 0 ||
      source.rejectedRecords !== 0
    ) {
      throw new Error(`Legacy normalization counters lack a cursor for ${source.sourceId}`);
    }
  }
}

async function validateMigratedNormalizationState(
  source: PersistedSourceState,
  ledger: ChunkLedger,
  logicalPrefix: string,
  dependencies: OrchestrationDependencies,
  normalizationSkipped: boolean,
): Promise<void> {
  const sequence = await openLedgerChunkSequencePrefix<NormalizationEvent>(
    dependencies.artifactStore,
    ledger,
    logicalPrefix,
  );
  assertNormalizationOuterIdentity(source, sequence, ledger.resumeCursor, normalizationSkipped);
  await assertNormalizationProjectionIdentity(source, sequence, normalizationSkipped);
}

function assertNormalizationOuterIdentity(
  source: PersistedSourceState,
  sequence: ChunkSequence<NormalizationEvent>,
  resumeCursor: string | null,
  normalizationSkipped = false,
): void {
  if (normalizationSkipped) {
    if (
      sequence.recordCount !== 0 ||
      resumeCursor !== null ||
      source.normalizationCursor !== null ||
      source.normalizationEventRecords !== 0 ||
      source.decodedRecords !== 0 ||
      source.acceptedRecords !== 0 ||
      source.rejectedRecords !== 0 ||
      source.mutationRecords !== 0 ||
      source.validationIssueRecords !== 0 ||
      source.normalizationLogicalSha256 !== null ||
      source.mutationLogicalSha256 !== null ||
      source.validationIssueLogicalSha256 !== null
    ) {
      throw new Error(`Skipped normalization identity is inconsistent for ${source.sourceId}`);
    }
    return;
  }
  if (source.normalizationLogicalSha256 === null) {
    if (source.normalizationEventRecords !== 0 || phaseCompleted(source, 'normalize')) {
      throw new Error(`Incomplete normalization identity is inconsistent for ${source.sourceId}`);
    }
  } else if (
    sequence.recordCount !== source.normalizationEventRecords ||
    sequence.logicalSha256 !== source.normalizationLogicalSha256
  ) {
    throw new Error(`Normalization outer identity changed for ${source.sourceId}`);
  }
  const cursor = parseNormalizationCursor(resumeCursor);
  if (canonicalJson(cursor) !== canonicalJson(source.normalizationCursor)) {
    throw new Error(`Normalization cursor changed for ${source.sourceId}`);
  }
  if (
    cursor !== null &&
    (cursor.decodedRecords !== source.decodedRecords ||
      cursor.acceptedRecords !== source.acceptedRecords ||
      cursor.rejectedRecords !== source.rejectedRecords)
  ) {
    throw new Error(`Normalization counters changed for ${source.sourceId}`);
  }
}

async function assertNormalizationProjectionIdentity(
  source: PersistedSourceState,
  events: ChunkSequence<NormalizationEvent>,
  normalizationSkipped = false,
): Promise<void> {
  if (normalizationSkipped) return;
  if (
    source.mutationLogicalSha256 === null &&
    source.validationIssueLogicalSha256 === null &&
    !phaseCompleted(source, 'normalize')
  ) {
    return;
  }
  const mutationHash = createHash('sha256');
  const issueHash = createHash('sha256');
  let mutationRecords = 0;
  let issueRecords = 0;
  for await (const event of events.read()) {
    if (event.kind === 'mutation') {
      mutationHash.update(`${canonicalJson(event.value)}\n`);
      mutationRecords += 1;
    } else if (event.kind === 'validation_issue') {
      issueHash.update(`${canonicalJson(event.value)}\n`);
      issueRecords += 1;
    }
  }
  if (
    mutationRecords !== source.mutationRecords ||
    issueRecords !== source.validationIssueRecords ||
    mutationHash.digest('hex') !== source.mutationLogicalSha256 ||
    issueHash.digest('hex') !== source.validationIssueLogicalSha256
  ) {
    throw new Error(`Normalization projection identity changed for ${source.sourceId}`);
  }
}

function assertSkippedProjectionLedgers(
  source: PersistedSourceState,
  mutations: ChunkSequence<unknown>,
  validationIssues: ChunkSequence<unknown>,
  normalizationSkipped: boolean,
): void {
  if (normalizationSkipped && (mutations.recordCount !== 0 || validationIssues.recordCount !== 0)) {
    throw new Error(`Skipped normalization projection is inconsistent for ${source.sourceId}`);
  }
}

function configurationHash(configuration: PipelineConfiguration): string {
  return sha256({
    runId: configuration.runId,
    pipelineVersion: configuration.pipelineVersion,
    requestedAt: configuration.requestedAt,
    profile: configuration.profile,
    maximumPhaseAttempts: configuration.maximumPhaseAttempts,
    sources: configuration.sources.map((source) => ({
      sourceId: source.adapter.describe().sourceId,
      snapshotId: source.snapshotId,
      scope: source.scope,
      capability: source.capability,
      executionMode: source.executionMode,
      supportState: source.supportState,
      acquisitionItemCap: source.acquisitionItemCap,
      discoveryDenominatorStrategy: source.discoveryDenominatorStrategy,
      requiredForCountyCompletion: source.requiredForCountyCompletion,
      expectedRecords: source.expectedRecords ?? null,
      limitations: source.limitations ?? [],
      contractVersion: source.adapter.describe().contractVersion,
    })),
  });
}

export function assertConfiguration(configuration: PipelineConfiguration): void {
  if (configuration.sources.length === 0) throw new TypeError('At least one source is required');
  if (
    !Number.isSafeInteger(configuration.maximumPhaseAttempts) ||
    configuration.maximumPhaseAttempts < 1
  ) {
    throw new RangeError('maximumPhaseAttempts must be a positive safe integer');
  }
  const sourceIds = configuration.sources.map(({ adapter }) => adapter.describe().sourceId);
  if (new Set(sourceIds).size !== sourceIds.length)
    throw new TypeError('Source IDs must be unique');
  if (configuration.profile.name === 'full' && configuration.profile.recordCap !== null) {
    throw new TypeError('Full runs must be uncapped');
  }
  if (configuration.profile.name === 'full' && configuration.sources.length < 2) {
    throw new TypeError('A full run cannot compose fewer than two source lanes');
  }
  if (
    configuration.profile.name === 'full' &&
    new Set(configuration.sources.map(({ capability }) => capability)).size < 2
  ) {
    throw new TypeError('A full run cannot claim county composition from one capability');
  }
  if (configuration.profile.name === 'full') {
    const configured = new Set(
      configuration.sources
        .filter(({ requiredForCountyCompletion }) => requiredForCountyCompletion)
        .map(({ capability }) => capability),
    );
    const missing = REQUIRED_COUNTY_CAPABILITIES.filter(
      (capability) => !configured.has(capability),
    );
    const unexpected = [...configured]
      .filter(
        (capability) => !(REQUIRED_COUNTY_CAPABILITIES as readonly string[]).includes(capability),
      )
      .sort();
    if (missing.length > 0 || unexpected.length > 0) {
      throw new TypeError(
        `A full run requires the exact production capability inventory; missing=${missing.join(',') || 'none'}; unexpected=${unexpected.join(',') || 'none'}`,
      );
    }
  }
}

class RunCheckpointCoordinator {
  #tail: Promise<void> = Promise.resolve();
  readonly #dependencies: OrchestrationDependencies;
  readonly #run: MutableRun;

  public constructor(run: MutableRun, dependencies: OrchestrationDependencies) {
    this.#run = run;
    this.#dependencies = dependencies;
  }

  public updateSource(source: PersistedSourceState): Promise<void> {
    return this.#serialize(async () => {
      this.#run.state = Object.freeze({
        ...this.#run.state,
        sources: Object.freeze(
          this.#run.state.sources.map((candidate) =>
            candidate.sourceId === source.sourceId ? source : candidate,
          ),
        ),
      });
      await this.#commit();
    });
  }

  public updateRun(patch: Partial<PersistedRunState>): Promise<void> {
    return this.#serialize(async () => {
      this.#run.state = Object.freeze({ ...this.#run.state, ...patch });
      await this.#commit();
    });
  }

  async #commit(): Promise<void> {
    this.#run.envelope = await commitRunState({
      store: this.#dependencies.checkpointStore,
      previous: this.#run.envelope,
      state: this.#run.state,
      writtenAt: this.#dependencies.clock.now(),
    });
  }

  #serialize(action: () => Promise<void>): Promise<void> {
    const result = this.#tail.then(action, action);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

function elapsedMilliseconds(startedAt: string, completedAt: string): number {
  const elapsed = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
}

function retryable(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === true
  );
}

function errorCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return error instanceof Error ? error.name : 'UNKNOWN_ERROR';
}

async function timedPhase<T>(
  phase: OrchestrationPhase,
  sourceId: SourceId | null,
  dependencies: OrchestrationDependencies,
  maximumAttempts: number,
  action: () => Promise<T>,
): Promise<Readonly<{ value: T; timing: PhaseTiming }>> {
  const startedAt = dependencies.clock.now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    dependencies.signal.throwIfAborted();
    await dependencies.beforePhase?.(phase, sourceId);
    try {
      const value = await action();
      const completedAt = dependencies.clock.now();
      return Object.freeze({
        value,
        timing: Object.freeze({
          phase,
          startedAt,
          completedAt,
          durationMs: elapsedMilliseconds(startedAt, completedAt),
          attempts,
        }),
      });
    } catch (error) {
      if (!retryable(error) || attempts >= maximumAttempts) throw error;
      await dependencies.delay.wait(0, dependencies.signal);
    }
  }
}

function phaseCompleted(state: PersistedSourceState, phase: OrchestrationPhase): boolean {
  if (state.completedPhase === null) return false;
  return SOURCE_PHASES.indexOf(state.completedPhase) >= SOURCE_PHASES.indexOf(phase);
}

async function loadRequired<T>(
  dependencies: OrchestrationDependencies,
  artifact: PhaseArtifact | null,
  label: string,
): Promise<T> {
  if (artifact === null) throw new Error(`Checkpoint omitted ${label} artifact`);
  return (await readJsonArtifact(dependencies.artifactStore, artifact)) as T;
}

async function persistSourcePhase(
  input: Readonly<{
    configuration: PipelineConfiguration;
    dependencies: OrchestrationDependencies;
    coordinator: RunCheckpointCoordinator;
    state: PersistedSourceState;
    phase: OrchestrationPhase;
    value: unknown;
    timing: PhaseTiming;
    artifactField:
      | 'discoveryArtifact'
      | 'planArtifact'
      | 'acquiredArtifact'
      | 'mutationArtifact'
      | 'summaryArtifact'
      | 'manifestArtifact';
    patch?: Partial<PersistedSourceState>;
  }>,
): Promise<PersistedSourceState> {
  const artifact = await writeJsonArtifact({
    store: input.dependencies.artifactStore,
    runId: input.configuration.runId,
    owner: input.state.sourceId,
    phase: input.phase,
    value: input.value,
  });
  const state: PersistedSourceState = Object.freeze({
    ...input.state,
    ...input.patch,
    [input.artifactField]: artifact,
    completedPhase: input.phase,
    timings: Object.freeze([...input.state.timings, input.timing]),
  });
  await input.coordinator.updateSource(state);
  return state;
}

function acquisitionRequest(
  configuration: PipelineConfiguration,
  source: SourceConfiguration,
  discovery: DiscoveryResult,
): AcquisitionRequest {
  return Object.freeze({
    sourceId: source.adapter.describe().sourceId,
    snapshotId: source.snapshotId,
    requestedAt: configuration.requestedAt,
    mode: acquisitionModeFor(configuration.profile.name),
    requestedSourceAsOf:
      discovery.resources[0]?.sourceAsOf ??
      Object.freeze({ state: 'unknown' as const, reason: 'Discovery returned no resources' }),
  });
}

function finalSourceCheckpoint(
  source: SourceConfiguration,
  plan: AcquisitionPlan,
  artifacts: readonly { readonly artifactId: string }[],
  completedAt: string,
): SourceCheckpoint {
  return sourceCheckpointSchema.parse({
    sourceId: source.adapter.describe().sourceId,
    snapshotId: source.snapshotId,
    contractVersion: source.adapter.describe().contractVersion,
    cursor: `sequence:${plan.items.length}`,
    nextSequence: plan.items.length,
    completedRequestKeys: plan.items.map(({ requestKey }) => requestKey),
    acquiredArtifactIds: [...new Set(artifacts.map(({ artifactId }) => artifactId))],
    updatedAt: completedAt,
    complete: artifacts.length === plan.items.length,
  });
}

export function selectDiscoveryDenominator(
  strategy: SourceConfiguration['discoveryDenominatorStrategy'],
  resources: readonly Readonly<{ expectedRecords: number | null }>[],
): number | null {
  if (strategy === 'unavailable') return null;
  const denominators = resources.flatMap(({ expectedRecords }) =>
    expectedRecords === null ? [] : [expectedRecords],
  );
  if (denominators.length === 0) return null;
  return strategy === 'sum_non_null'
    ? denominators.reduce((total, value) => total + value, 0)
    : (denominators[0] ?? null);
}

function coverage(
  source: SourceConfiguration,
  discovery: DiscoveryResult | undefined,
  state: PersistedSourceState,
): SourceCoverage {
  const discovered = selectDiscoveryDenominator(
    source.discoveryDenominatorStrategy,
    discovery?.resources ?? [],
  );
  const expectedRecords = source.expectedRecords ?? discovered ?? null;
  return Object.freeze({
    expectedRecords,
    observedRecords: state.decodedRecords,
    acceptedRecords: state.acceptedRecords,
    quarantinedRecords: state.rejectedRecords,
    denominatorMethod:
      source.expectedRecords !== undefined && source.expectedRecords !== null
        ? 'configured'
        : discovered !== null
          ? 'discovered'
          : 'unavailable',
    ratio:
      expectedRecords === null || expectedRecords === 0
        ? null
        : state.decodedRecords / expectedRecords,
  });
}

function terminalFromSummary(summary: SourceRunSummary): SourceTerminalState {
  if (summary.status === 'succeeded') return 'complete';
  if (summary.status === 'partial') return 'partial';
  return 'failed';
}

function terminalFromError(error: unknown, state: PersistedSourceState): SourceTerminalState {
  const code = errorCode(error);
  if (code === 'AUTHENTICATION' || code === 'TERMS_ACCESS') return 'blocked';
  return state.acceptedRecords > 0 || state.decodedRecords > 0 ? 'partial' : 'failed';
}

function sourceManifest(
  input: Readonly<{
    source: SourceConfiguration;
    state: PersistedSourceState;
    discovery?: DiscoveryResult | undefined;
    acquired?: readonly AcquiredArtifact[] | undefined;
    summary?: SourceRunSummary | undefined;
    checkpointRevision: string | null;
  }>,
): SourceExecutionManifest {
  const artifacts = [
    input.state.discoveryArtifact,
    input.state.planArtifact,
    input.state.acquiredArtifact,
    input.state.mutationArtifact,
    input.state.summaryArtifact,
  ].filter((artifact): artifact is PhaseArtifact => artifact !== null);
  const acquired = input.acquired ?? [];
  const sourceCoverage = coverage(input.source, input.discovery, input.state);
  const acquiredSnapshotIds = [...new Set(acquired.map(({ snapshotId }) => snapshotId))];
  if (acquiredSnapshotIds.length > 1) {
    throw new Error(`Acquisition mixed snapshots for ${input.state.sourceId}`);
  }
  const observedContentId = acquiredSnapshotIds[0] ?? null;
  const sourceAsOf =
    [
      ...acquired.map(({ sourceAsOf: value }) => value),
      ...(input.discovery?.resources.map(({ sourceAsOf: value }) => value) ?? []),
    ]
      .flatMap((value) =>
        value.state === 'reported' || value.state === 'derived' ? [value.at] : [],
      )
      .sort()
      .at(-1) ?? null;
  const terminalState =
    input.summary !== undefined &&
    input.state.terminalState === 'complete' &&
    sourceCoverage.expectedRecords !== null &&
    sourceCoverage.observedRecords < sourceCoverage.expectedRecords
      ? 'partial'
      : (input.state.terminalState ?? 'failed');
  return Object.freeze({
    sourceId: input.state.sourceId,
    snapshotId: input.state.snapshotId,
    snapshotIdentity: Object.freeze({
      intentId: input.state.snapshotId,
      observedContentId,
      method: 'configured_intent_plus_observed_content_v1' as const,
    }),
    scope: input.source.scope,
    capability: input.source.capability,
    executionMode: input.source.executionMode,
    supportState: input.source.supportState,
    requiredForCountyCompletion: input.source.requiredForCountyCompletion,
    terminalState,
    sourceHash: sha256({
      snapshotId: input.state.snapshotId,
      acquiredHashes: acquired.map(({ sha256: hash }) => hash),
    }),
    sourceAsOf,
    license: Object.freeze({
      redistribution: input.source.adapter.describe().license.redistribution,
      containsPersonalData: input.source.adapter.describe().license.containsPersonalData,
      defaultVisibility: input.source.adapter.describe().defaultVisibility,
    }),
    schemaHashes: Object.freeze(
      [...new Set(acquired.map(({ schemaFingerprint }) => schemaFingerprint.value))].sort(),
    ),
    checkpointRevision: input.checkpointRevision,
    coverage: sourceCoverage,
    timings: input.state.timings,
    artifacts: Object.freeze(artifacts),
    limitations: input.state.limitations,
    errorCodes: input.state.errorCodes,
    summary: input.summary ?? null,
  });
}

async function runSource(
  configuration: PipelineConfiguration,
  source: SourceConfiguration,
  restored: PersistedSourceState,
  dependencies: OrchestrationDependencies,
  coordinator: RunCheckpointCoordinator,
  recordBudget: SharedRecordBudget,
  onActiveRecordDelta: (delta: number) => void,
  onBufferedEventDelta: (delta: number) => void,
  checkpointRevision: () => string | null,
): Promise<SourceRuntime> {
  let state = restored;
  let discovery: DiscoveryResult | undefined;
  let plan: AcquisitionPlan | undefined;
  let acquiredMetadata: readonly AcquiredArtifact[] = [];
  let acquiredReferences: readonly DurableAcquiredArtifactReference[] = [];
  let mutations = emptyChunkSequence<CanonicalMutation>();
  let validationIssues = emptyChunkSequence<ValidationIssue>();
  let summary: SourceRunSummary | undefined;
  const descriptor = source.adapter.describe();
  const streamingAdapter = descriptor.contractVersion.startsWith('2.')
    ? (source.adapter as StreamingSourceAdapter)
    : undefined;
  const startedAt = configuration.requestedAt;

  try {
    if (phaseCompleted(state, 'discover')) {
      discovery = await loadRequired(dependencies, state.discoveryArtifact, 'discovery');
    } else {
      const phase = await timedPhase(
        'discover',
        descriptor.sourceId,
        dependencies,
        configuration.maximumPhaseAttempts,
        () =>
          source.adapter.discover({
            http: dependencies.http,
            ratePolicy: descriptor.ratePolicy,
            clock: dependencies.clock,
            delay: dependencies.delay,
            signal: dependencies.signal,
          }),
      );
      discovery = phase.value;
      state = await persistSourcePhase({
        configuration,
        dependencies,
        coordinator,
        state,
        phase: 'discover',
        value: discovery,
        timing: phase.timing,
        artifactField: 'discoveryArtifact',
        patch: { limitations: Object.freeze([...state.limitations, ...discovery.limitations]) },
      });
    }
    if (discovery === undefined)
      throw new Error(`Discovery state unavailable for ${descriptor.sourceId}`);

    if (configuration.profile.name === 'discovery' || source.executionMode === 'discover_only') {
      const terminalState: SourceTerminalState =
        source.supportState === 'blocked' ? 'blocked' : discovery.complete ? 'complete' : 'partial';
      state = Object.freeze({
        ...state,
        terminalState:
          source.executionMode === 'discover_only' && configuration.profile.name !== 'discovery'
            ? 'partial'
            : terminalState,
        completedPhase: 'summarize',
        limitations:
          source.executionMode === 'discover_only' && configuration.profile.name !== 'discovery'
            ? Object.freeze([
                ...state.limitations,
                'This source was discovery-only in the bounded pilot; no records were loaded.',
              ])
            : state.limitations,
      });
      await coordinator.updateSource(state);
      return Object.freeze({
        state,
        mutations,
        acquired: Object.freeze([]),
        manifest: sourceManifest({
          source,
          state,
          discovery,
          checkpointRevision: checkpointRevision(),
        }),
      });
    }

    if (phaseCompleted(state, 'plan')) {
      plan = await loadRequired(dependencies, state.planArtifact, 'plan');
    } else {
      const plannedDiscovery = discovery;
      const request = acquisitionRequest(configuration, source, discovery);
      const phase = await timedPhase(
        'plan',
        descriptor.sourceId,
        dependencies,
        configuration.maximumPhaseAttempts,
        () =>
          source.adapter.plan(request, plannedDiscovery, {
            clock: dependencies.clock,
            signal: dependencies.signal,
          }),
      );
      const planned =
        source.acquisitionItemCap === null || phase.value.items.length <= source.acquisitionItemCap
          ? phase.value
          : Object.freeze({
              ...phase.value,
              items: phase.value.items.slice(0, source.acquisitionItemCap),
            });
      plan = planned;
      state = await persistSourcePhase({
        configuration,
        dependencies,
        coordinator,
        state,
        phase: 'plan',
        value: planned,
        timing: phase.timing,
        artifactField: 'planArtifact',
        ...(planned.items.length < phase.value.items.length
          ? {
              patch: {
                limitations: Object.freeze([
                  ...state.limitations,
                  `Bounded ${configuration.profile.name} acquisition executed ${planned.items.length} of ${phase.value.items.length} planned source items.`,
                ]),
              },
            }
          : {}),
      });
    }
    if (plan === undefined)
      throw new Error(`Acquisition plan unavailable for ${descriptor.sourceId}`);
    const acquisitionPlan = plan;

    if (phaseCompleted(state, 'acquire')) {
      acquiredReferences = await loadRequired(dependencies, state.acquiredArtifact, 'acquisition');
      if (state.acquisitionLogicalSha256 === null) {
        throw new AcquisitionReplayIncompatibleError(
          descriptor.sourceId,
          'completed acquisition checkpoint omitted its logical hash',
        );
      }
      const acquiredSequence = await openChunkSequence<DurableAcquiredArtifactReference>(
        dependencies.artifactStore,
        state.acquisitionChunks,
        {
          recordCount: state.acquisitionRecords,
          logicalSha256: state.acquisitionLogicalSha256,
        },
      );
      const chunkReferences: DurableAcquiredArtifactReference[] = [];
      for await (const reference of acquiredSequence.read()) chunkReferences.push(reference);
      if (canonicalJson(chunkReferences) !== canonicalJson(acquiredReferences)) {
        throw new AcquisitionReplayIncompatibleError(
          descriptor.sourceId,
          'completed acquisition artifact disagrees with its verified chunk sequence',
        );
      }
      acquiredMetadata = Object.freeze(acquiredReferences.map(({ metadata }) => metadata));
    } else {
      const request = acquisitionRequest(configuration, source, discovery);
      const persistedPrefix = await openChunkSequencePrefix<DurableAcquiredArtifactReference>(
        dependencies.artifactStore,
        state.acquisitionChunks,
      );
      if (persistedPrefix.recordCount !== state.acquisitionRecords) {
        throw new AcquisitionReplayIncompatibleError(
          descriptor.sourceId,
          'checkpoint acquisition record count does not match its verified chunks',
        );
      }
      const logicalPrefix = `runs/${configuration.runId.replace('sc:run:', '')}/${state.sourceId.replaceAll(/[^a-zA-Z0-9._~-]/gu, '-')}`;
      const acquisitionWriter = new CanonicalChunkWriter<DurableAcquiredArtifactReference>({
        store: dependencies.artifactStore,
        logicalPrefix: `${logicalPrefix}/acquire/references`,
        visibility: descriptor.defaultVisibility,
        licenseSnapshotRef: descriptor.license.licenseSnapshotId,
        budget: recordBudget,
        signal: dependencies.signal,
        maximumRecordsPerChunk: 1,
        maximumBytesPerRecord: normalizationRecordByteCap(),
        maximumBytesPerChunk: normalizationChunkByteCap(),
        restoredChunks: state.acquisitionChunks,
        cursorFor: ({ metadata }) => metadata.artifactId,
        onChunk: async (chunks) => {
          const candidate = Object.freeze({
            ...state,
            acquisitionChunks: chunks,
            acquisitionRecords: chunks.reduce((sum, chunk) => sum + chunk.recordCount, 0),
          });
          await coordinator.updateSource(candidate);
          state = candidate;
        },
      });
      await acquisitionWriter.restore();
      const phase = await timedPhase(
        'acquire',
        descriptor.sourceId,
        dependencies,
        // Acquisition progress is durable per yield. Any failure unwinds to that durable prefix;
        // an in-process retry cannot safely assume a provider generator's checkpoint position.
        1,
        async () => {
          const committed = persistedPrefix.read()[Symbol.asyncIterator]();
          let emittedOrdinal = 0;
          try {
            for await (const artifact of source.adapter.acquire(acquisitionPlan, undefined, {
              http: dependencies.http,
              artifactStore: dependencies.artifactStore,
              checkpointStore: dependencies.checkpointStore,
              ratePolicy: descriptor.ratePolicy,
              clock: dependencies.clock,
              delay: dependencies.delay,
              signal: dependencies.signal,
            })) {
              const reference = durableAcquiredArtifactReference(artifact);
              const planItem = acquisitionPlan.items[emittedOrdinal];
              if (reference.metadata.request.requestKey !== planItem?.requestKey) {
                throw new AcquisitionReplayIncompatibleError(
                  descriptor.sourceId,
                  `provider emission ${emittedOrdinal} did not match its deterministic plan request`,
                );
              }
              emittedOrdinal += 1;
              const expected = await committed.next();
              if (!expected.done) {
                if (canonicalJson(expected.value) !== canonicalJson(reference)) {
                  throw new AcquisitionReplayIncompatibleError(
                    descriptor.sourceId,
                    'provider did not re-emit the exact committed acquisition prefix',
                  );
                }
                continue;
              }
              await acquisitionWriter.append(reference);
            }
            if (!(await committed.next()).done) {
              throw new AcquisitionReplayIncompatibleError(
                descriptor.sourceId,
                'provider omitted one or more committed acquisition artifacts on resume',
              );
            }
            return await acquisitionWriter.finish();
          } catch (error) {
            acquisitionWriter.abort();
            throw error;
          }
        },
      );
      const acquiredSequence = phase.value;
      const references: DurableAcquiredArtifactReference[] = [];
      for await (const reference of acquiredSequence.read()) references.push(reference);
      acquiredReferences = Object.freeze(references);
      acquiredMetadata = Object.freeze(acquiredReferences.map(({ metadata }) => metadata));
      state = await persistSourcePhase({
        configuration,
        dependencies,
        coordinator,
        state,
        phase: 'acquire',
        value: acquiredReferences,
        timing: phase.timing,
        artifactField: 'acquiredArtifact',
        patch: {
          acquisitionChunks: acquiredSequence.chunks,
          acquisitionRecords: acquiredSequence.recordCount,
          acquisitionLogicalSha256: acquiredSequence.logicalSha256,
        },
      });
      void request;
    }

    const eventPrefix = normalizationLogicalPrefix(configuration.runId, state.sourceId);
    const mutationPrefix = mutationLogicalPrefix(configuration.runId, state.sourceId);
    const validationPrefix = validationIssueLogicalPrefix(configuration.runId, state.sourceId);
    const licenseSnapshotRef =
      acquiredMetadata[0]?.licenseSnapshotRef ?? `descriptor:${descriptor.sourceId}`;

    if (phaseCompleted(state, 'normalize')) {
      if (
        state.normalizationLogicalSha256 === null ||
        state.mutationLogicalSha256 === null ||
        state.validationIssueLogicalSha256 === null
      ) {
        throw new Error(`Checkpoint omitted v2 chunk identities for ${state.sourceId}`);
      }
      const events = await openLedgerChunkSequence<NormalizationEvent>(
        dependencies.artifactStore,
        state.normalizationLedger,
        {
          recordCount: state.normalizationEventRecords,
          logicalSha256: state.normalizationLogicalSha256,
          logicalPrefix: eventPrefix,
        },
      );
      const projections = await materializeNormalizationProjections({
        events,
        store: dependencies.artifactStore,
        budget: recordBudget,
        signal: dependencies.signal,
        maximumRecordsPerChunk: configuration.profile.maxBufferedRecords,
        maximumBytesPerRecord: normalizationRecordByteCap(),
        maximumBytesPerChunk: normalizationChunkByteCap(),
        visibility: descriptor.defaultVisibility,
        licenseSnapshotRef,
        mutation: {
          logicalPrefix: mutationPrefix,
          restoredLedger: state.mutationLedger,
          onLedger: async (ledger) => {
            const candidate = Object.freeze({ ...state, mutationLedger: ledger });
            await coordinator.updateSource(candidate);
            state = candidate;
          },
          expected: {
            recordCount: state.mutationRecords,
            logicalSha256: state.mutationLogicalSha256,
          },
        },
        validationIssue: {
          logicalPrefix: validationPrefix,
          restoredLedger: state.validationIssueLedger,
          onLedger: async (ledger) => {
            const candidate = Object.freeze({ ...state, validationIssueLedger: ledger });
            await coordinator.updateSource(candidate);
            state = candidate;
          },
          expected: {
            recordCount: state.validationIssueRecords,
            logicalSha256: state.validationIssueLogicalSha256,
          },
        },
      });
      mutations = projections.mutations;
      validationIssues = projections.validationIssues;
    } else {
      const records = {
        decoded: state.decodedRecords,
        accepted: state.acceptedRecords,
        rejected: state.rejectedRecords,
      };
      const resume = state.normalizationCursor;
      const repeatableAcquiredArtifacts = createRepeatableAcquiredArtifacts(
        acquiredReferences,
        dependencies,
      );
      validateNormalizationResume(state.normalizationLedger, resume);
      const cap = configuration.profile.recordCap;
      const eventWriter = new CanonicalChunkWriter<NormalizationEvent>({
        store: dependencies.artifactStore,
        logicalPrefix: eventPrefix,
        visibility: descriptor.defaultVisibility,
        licenseSnapshotRef,
        budget: recordBudget,
        signal: dependencies.signal,
        maximumRecordsPerChunk: configuration.profile.maxBufferedRecords,
        maximumBytesPerRecord: normalizationRecordByteCap(),
        maximumBytesPerChunk: normalizationChunkByteCap(),
        onBufferedRecordDelta: onBufferedEventDelta,
        restoredLedger: state.normalizationLedger,
        cursorFor: ({ cursor }) => canonicalJson(cursor),
        onLedger: async (ledger) => {
          const cursor = parseNormalizationCursor(ledger.resumeCursor);
          if (cursor === null) throw new Error('Normalization chunk omitted its resume cursor');
          const candidate = Object.freeze({
            ...state,
            normalizationLedger: ledger,
            normalizationCursor: cursor,
            decodedRecords: cursor.decodedRecords,
            acceptedRecords: cursor.acceptedRecords,
            rejectedRecords: cursor.rejectedRecords,
          });
          await coordinator.updateSource(candidate);
          state = candidate;
        },
      });
      await eventWriter.restore();
      const acquireActiveRecordLease = async (): Promise<RecordBudgetLease> => {
        if (
          recordBudget.metrics().inUse >= recordBudget.capacity &&
          eventWriter.bufferedRecordCount > 0
        ) {
          await eventWriter.flush();
        }
        const lease = await recordBudget.acquire(dependencies.signal);
        onActiveRecordDelta(1);
        let released = false;
        return Object.freeze({
          release: () => {
            if (released) return;
            released = true;
            onActiveRecordDelta(-1);
            lease.release();
          },
        });
      };
      const appendNormalizationEvent = async (event: NormalizationEvent): Promise<void> => {
        let eventLease = recordBudget.tryAcquire();
        if (eventLease === undefined && eventWriter.bufferedRecordCount > 0) {
          await eventWriter.flush();
          eventLease = recordBudget.tryAcquire();
        }
        if (eventLease === undefined) {
          // Every permit is an active record (not buffered state). Spill this one event
          // immediately while borrowing the current record's already-counted slot.
          await eventWriter.append(event, BORROWED_RECORD_LEASE);
          await eventWriter.flush();
          return;
        }
        const transfer = { ownedByWriter: false };
        try {
          await eventWriter.append(event, eventLease, () => {
            transfer.ownedByWriter = true;
          });
        } catch (error) {
          if (!transfer.ownedByWriter) eventLease.release();
          throw error;
        }
      };
      const phase = await timedPhase(
        'decode',
        descriptor.sourceId,
        dependencies,
        // A failed normalization attempt must unwind to the durable chunk cursor. Reusing an
        // in-memory writer after a partial hash/write would make retry identity ambiguous.
        1,
        async () => {
          outer: for (const [artifactIndex, reference] of acquiredReferences.entries()) {
            if (resume !== null && artifactIndex < resume.artifactIndex) continue;
            const artifact = await openAcquiredReference(reference, dependencies);
            const decoded =
              streamingAdapter === undefined
                ? (source.adapter as SourceAdapter).decode(
                    requireLegacyAcquiredArtifact(artifact),
                    {
                      artifactStore: dependencies.artifactStore,
                      analyticalRuntime: dependencies.analyticalRuntime,
                      clock: dependencies.clock,
                      signal: dependencies.signal,
                    },
                  )
                : streamingAdapter.decode(artifact, {
                    artifactStore: dependencies.artifactStore,
                    analyticalRuntime: dependencies.analyticalRuntime,
                    recordBudget,
                    clock: dependencies.clock,
                    signal: dependencies.signal,
                  });
            const decodedIterator = decoded[Symbol.asyncIterator]();
            let recordOrdinal = 0;
            let decodedDone = false;
            try {
              for (;;) {
                if (cap !== null && records.decoded >= cap) break outer;
                const activeLease = await acquireActiveRecordLease();
                try {
                  const next = await decodedIterator.next();
                  if (next.done) {
                    decodedDone = true;
                    break;
                  }
                  recordOrdinal += 1;
                  const resumeThisRecord =
                    resume !== null &&
                    artifactIndex === resume.artifactIndex &&
                    recordOrdinal === resume.recordOrdinal;
                  if (
                    resume !== null &&
                    artifactIndex === resume.artifactIndex &&
                    (recordOrdinal < resume.recordOrdinal ||
                      (recordOrdinal === resume.recordOrdinal && resume.recordComplete))
                  ) {
                    continue;
                  }
                  if (!resumeThisRecord) {
                    await appendNormalizationEvent(
                      Object.freeze({
                        schemaVersion: '2.0.0',
                        kind: 'record_start',
                        cursor: normalizationCursor({
                          artifactIndex,
                          recordOrdinal,
                          issueOffset: 0,
                          mutationOffset: 0,
                          records,
                          recordComplete: false,
                        }),
                      }),
                    );
                  }
                  const result = await source.adapter.validate(next.value, {
                    clock: dependencies.clock,
                    signal: dependencies.signal,
                  });
                  let issueOffset = 0;
                  const resumeIssueOffset = resumeThisRecord ? resume.issueOffset : 0;
                  const resumeMutationOffset = resumeThisRecord ? resume.mutationOffset : 0;
                  for (const issue of result.issues) {
                    issueOffset += 1;
                    if (issueOffset <= resumeIssueOffset) continue;
                    const cursor = normalizationCursor({
                      artifactIndex,
                      recordOrdinal,
                      issueOffset,
                      mutationOffset: resumeMutationOffset,
                      records,
                      recordComplete: false,
                    });
                    await appendNormalizationEvent(
                      Object.freeze({
                        schemaVersion: '2.0.0',
                        kind: 'validation_issue',
                        cursor,
                        value: issue,
                      }),
                    );
                  }
                  let mutationOffset = 0;
                  if (result.status === 'accepted') {
                    const context = {
                      analyticalRuntime: dependencies.analyticalRuntime,
                      recordBudget,
                      clock: dependencies.clock,
                      signal: dependencies.signal,
                    };
                    for await (const mutation of source.adapter.normalize(result.record, context)) {
                      mutationOffset += 1;
                      if (mutationOffset <= resumeMutationOffset) continue;
                      const cursor = normalizationCursor({
                        artifactIndex,
                        recordOrdinal,
                        issueOffset,
                        mutationOffset,
                        records,
                        recordComplete: false,
                      });
                      await appendNormalizationEvent(
                        Object.freeze({
                          schemaVersion: '2.0.0',
                          kind: 'mutation',
                          cursor,
                          value: mutation,
                        }),
                      );
                    }
                  }
                  const completedRecords = {
                    decoded: records.decoded + 1,
                    accepted: records.accepted + (result.status === 'accepted' ? 1 : 0),
                    rejected: records.rejected + (result.status === 'rejected' ? 1 : 0),
                  };
                  const completeCursor = normalizationCursor({
                    artifactIndex,
                    recordOrdinal,
                    issueOffset,
                    mutationOffset,
                    records: completedRecords,
                    recordComplete: true,
                  });
                  await appendNormalizationEvent(
                    Object.freeze({
                      schemaVersion: '2.0.0',
                      kind: 'record_complete',
                      cursor: completeCursor,
                    }),
                  );
                  records.decoded = completedRecords.decoded;
                  records.accepted = completedRecords.accepted;
                  records.rejected = completedRecords.rejected;
                } finally {
                  activeLease.release();
                }
              }
            } finally {
              if (!decodedDone) await decodedIterator.return?.();
            }
          }

          if (
            streamingAdapter?.finalizeFromAcquiredArtifacts !== undefined &&
            !(
              resume?.artifactIndex === acquiredMetadata.length &&
              resume.recordOrdinal === 1 &&
              resume.recordComplete
            )
          ) {
            const artifactIndex = acquiredMetadata.length;
            const recordOrdinal = 1;
            const resumeFinalizeMutationOffset =
              resume?.artifactIndex === artifactIndex ? resume.mutationOffset : 0;
            let mutationOffset = 0;
            const finalization = streamingAdapter.finalizeFromAcquiredArtifacts(
              repeatableAcquiredArtifacts,
              {
                analyticalRuntime: dependencies.analyticalRuntime,
                recordBudget,
                clock: dependencies.clock,
                signal: dependencies.signal,
              },
            );
            const finalizationIterator = finalization[Symbol.asyncIterator]();
            let finalizationDone = false;
            try {
              for (;;) {
                const activeFinalizeLease = await acquireActiveRecordLease();
                try {
                  const next = await finalizationIterator.next();
                  if (next.done) {
                    finalizationDone = true;
                    break;
                  }
                  mutationOffset += 1;
                  if (mutationOffset <= resumeFinalizeMutationOffset) continue;
                  const cursor = normalizationCursor({
                    artifactIndex,
                    recordOrdinal,
                    issueOffset: 0,
                    mutationOffset,
                    records,
                    recordComplete: false,
                  });
                  await appendNormalizationEvent(
                    Object.freeze({
                      schemaVersion: '2.0.0',
                      kind: 'mutation',
                      cursor,
                      value: next.value,
                    }),
                  );
                  // Each finalizer offset is independently durable for reconstruction in a fresh process.
                  await eventWriter.flush();
                } finally {
                  activeFinalizeLease.release();
                }
              }
            } finally {
              if (!finalizationDone) await finalizationIterator.return?.();
            }
            const finalCompleteLease = await acquireActiveRecordLease();
            try {
              await appendNormalizationEvent(
                Object.freeze({
                  schemaVersion: '2.0.0',
                  kind: 'record_complete',
                  cursor: normalizationCursor({
                    artifactIndex,
                    recordOrdinal,
                    issueOffset: 0,
                    mutationOffset,
                    records,
                    recordComplete: true,
                  }),
                }),
              );
            } finally {
              finalCompleteLease.release();
            }
          }

          return eventWriter.finish();
        },
      ).catch((error: unknown) => {
        eventWriter.abort();
        throw error;
      });
      const decodeTiming: PhaseTiming = Object.freeze({ ...phase.timing, phase: 'decode' });
      const validateTiming: PhaseTiming = Object.freeze({ ...phase.timing, phase: 'validate' });
      const normalizeTiming: PhaseTiming = Object.freeze({ ...phase.timing, phase: 'normalize' });
      const events = phase.value;
      const projections = await materializeNormalizationProjections({
        events,
        store: dependencies.artifactStore,
        budget: recordBudget,
        signal: dependencies.signal,
        maximumRecordsPerChunk: configuration.profile.maxBufferedRecords,
        maximumBytesPerRecord: normalizationRecordByteCap(),
        maximumBytesPerChunk: normalizationChunkByteCap(),
        visibility: descriptor.defaultVisibility,
        licenseSnapshotRef,
        mutation: {
          logicalPrefix: mutationPrefix,
          restoredLedger: state.mutationLedger,
          onLedger: async (ledger) => {
            const candidate = Object.freeze({ ...state, mutationLedger: ledger });
            await coordinator.updateSource(candidate);
            state = candidate;
          },
        },
        validationIssue: {
          logicalPrefix: validationPrefix,
          restoredLedger: state.validationIssueLedger,
          onLedger: async (ledger) => {
            const candidate = Object.freeze({ ...state, validationIssueLedger: ledger });
            await coordinator.updateSource(candidate);
            state = candidate;
          },
        },
      });
      mutations = projections.mutations;
      validationIssues = projections.validationIssues;
      state = Object.freeze({
        ...state,
        completedPhase: 'normalize',
        decodedRecords: records.decoded,
        acceptedRecords: records.accepted,
        rejectedRecords: records.rejected,
        normalizationLedger: state.normalizationLedger,
        normalizationEventRecords: events.recordCount,
        normalizationLogicalSha256: events.logicalSha256,
        normalizationCursor: parseNormalizationCursor(state.normalizationLedger.resumeCursor),
        mutationLogicalSha256: mutations.logicalSha256,
        validationIssueLogicalSha256: validationIssues.logicalSha256,
        mutationRecords: mutations.recordCount,
        validationIssueRecords: validationIssues.recordCount,
        timings: Object.freeze([...state.timings, decodeTiming, validateTiming, normalizeTiming]),
      });
      await coordinator.updateSource(state);
    }

    if (phaseCompleted(state, 'summarize')) {
      summary = await loadRequired(dependencies, state.summaryArtifact, 'summary');
    } else {
      const completedAt = dependencies.clock.now();
      const request = acquisitionRequest(configuration, source, discovery);
      const finalCheckpoint = finalSourceCheckpoint(source, plan, acquiredMetadata, completedAt);
      const observation: SourceRunObservationV2 = Object.freeze({
        descriptor,
        runId: configuration.runId,
        request,
        plan,
        startedAt,
        completedAt,
        finalCheckpoint,
        artifacts: acquiredMetadata,
        decodedRecords: state.decodedRecords,
        acceptedRecords: state.acceptedRecords,
        rejectedRecords: state.rejectedRecords,
        mutations: Object.freeze({
          count: mutations.recordCount,
          logicalSha256: mutations.logicalSha256,
          read: mutations.read,
        }),
        validationIssues: Object.freeze({
          count: validationIssues.recordCount,
          logicalSha256: validationIssues.logicalSha256,
          read: validationIssues.read,
        }),
        aborted: false,
      });
      const phase = await timedPhase(
        'summarize',
        descriptor.sourceId,
        dependencies,
        configuration.maximumPhaseAttempts,
        async () => {
          const context = { clock: dependencies.clock, signal: dependencies.signal };
          if (streamingAdapter !== undefined) {
            return streamingAdapter.summarize(observation, context);
          }
          if (
            mutations.recordCount > LEGACY_OBSERVATION_MAX_VALUES ||
            validationIssues.recordCount > LEGACY_OBSERVATION_MAX_VALUES
          ) {
            throw new LegacyObservationLimitError(descriptor.sourceId);
          }
          const legacy: SourceRunObservation = Object.freeze({
            ...observation,
            mutations: await collectSmallSequence(mutations),
            validationIssues: await collectSmallSequence(validationIssues),
          });
          return (source.adapter as SourceAdapter).summarize(legacy, context);
        },
      );
      summary = phase.value;
      state = await persistSourcePhase({
        configuration,
        dependencies,
        coordinator,
        state,
        phase: 'summarize',
        value: summary,
        timing: phase.timing,
        artifactField: 'summaryArtifact',
        patch: { terminalState: terminalFromSummary(summary) },
      });
    }
  } catch (error) {
    if (dependencies.signal.aborted) throw error;
    if (error instanceof AtomicPromotionExhaustedError) throw error;
    state = Object.freeze({
      ...state,
      terminalState: terminalFromError(error, state),
      limitations: Object.freeze([
        ...state.limitations,
        error instanceof Error ? error.message : String(error),
      ]),
      errorCodes: Object.freeze([...state.errorCodes, errorCode(error)]),
    });
    await coordinator.updateSource(state);
  }

  const manifest = sourceManifest({
    source,
    state,
    discovery,
    acquired: acquiredMetadata,
    summary,
    checkpointRevision: checkpointRevision(),
  });
  return Object.freeze({ state, mutations, manifest, acquired: acquiredMetadata });
}

function normalizationCursor(
  input: Readonly<{
    artifactIndex: number;
    recordOrdinal: number;
    issueOffset: number;
    mutationOffset: number;
    records: Readonly<{ decoded: number; accepted: number; rejected: number }>;
    recordComplete: boolean;
  }>,
): NormalizationCursor {
  return Object.freeze({
    artifactIndex: input.artifactIndex,
    recordOrdinal: input.recordOrdinal,
    issueOffset: input.issueOffset,
    mutationOffset: input.mutationOffset,
    recordComplete: input.recordComplete,
    decodedRecords: input.records.decoded,
    acceptedRecords: input.records.accepted,
    rejectedRecords: input.records.rejected,
  });
}

function parseNormalizationCursor(value: string | null): NormalizationCursor | null {
  if (value === null || value.length === 0) return null;
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('Invalid normalization resume cursor');
  }
  const cursor = parsed as Record<string, unknown>;
  for (const key of [
    'artifactIndex',
    'recordOrdinal',
    'issueOffset',
    'mutationOffset',
    'decodedRecords',
    'acceptedRecords',
    'rejectedRecords',
  ] as const) {
    if (!Number.isSafeInteger(cursor[key]) || (cursor[key] as number) < 0) {
      throw new TypeError(`Invalid normalization resume cursor ${key}`);
    }
  }
  if (typeof cursor.recordComplete !== 'boolean') {
    throw new TypeError('Invalid normalization resume cursor recordComplete');
  }
  if (
    (cursor.acceptedRecords as number) + (cursor.rejectedRecords as number) !==
    cursor.decodedRecords
  ) {
    throw new TypeError('Invalid normalization resume cursor record balance');
  }
  return Object.freeze(cursor) as NormalizationCursor;
}

function validateNormalizationResume(
  ledger: ChunkLedger,
  cursor: NormalizationCursor | null,
): void {
  const persisted = parseNormalizationCursor(ledger.resumeCursor);
  if (canonicalJson(persisted) !== canonicalJson(cursor)) {
    throw new Error('Normalization checkpoint cursor does not match its final chunk reference');
  }
}

type NormalizationProjectionConfiguration = Readonly<{
  logicalPrefix: string;
  restoredLedger: ChunkLedger;
  onLedger: (ledger: ChunkLedger) => Promise<void>;
  expected?: Readonly<{ recordCount: number; logicalSha256: string }>;
}>;

export async function materializeNormalizationProjections(
  input: Readonly<{
    events: ChunkSequence<NormalizationEvent>;
    store: OrchestrationDependencies['artifactStore'];
    budget: SharedRecordBudget;
    signal: AbortSignal;
    maximumRecordsPerChunk: number;
    maximumBytesPerRecord?: number;
    maximumBytesPerChunk?: number;
    visibility: string;
    licenseSnapshotRef: string;
    mutation: NormalizationProjectionConfiguration;
    validationIssue: NormalizationProjectionConfiguration;
  }>,
): Promise<
  Readonly<{
    mutations: ChunkSequence<CanonicalMutation>;
    validationIssues: ChunkSequence<ValidationIssue>;
  }>
> {
  const mutationWriter = new CanonicalChunkWriter<CanonicalMutation>({
    store: input.store,
    logicalPrefix: input.mutation.logicalPrefix,
    visibility: input.visibility,
    licenseSnapshotRef: input.licenseSnapshotRef,
    budget: input.budget,
    signal: input.signal,
    maximumRecordsPerChunk: input.maximumRecordsPerChunk,
    ...(input.maximumBytesPerRecord === undefined
      ? {}
      : { maximumBytesPerRecord: input.maximumBytesPerRecord }),
    ...(input.maximumBytesPerChunk === undefined
      ? {}
      : { maximumBytesPerChunk: input.maximumBytesPerChunk }),
    restoredLedger: input.mutation.restoredLedger,
    onLedger: input.mutation.onLedger,
  });
  const validationIssueWriter = new CanonicalChunkWriter<ValidationIssue>({
    store: input.store,
    logicalPrefix: input.validationIssue.logicalPrefix,
    visibility: input.visibility,
    licenseSnapshotRef: input.licenseSnapshotRef,
    budget: input.budget,
    signal: input.signal,
    maximumRecordsPerChunk: input.maximumRecordsPerChunk,
    ...(input.maximumBytesPerRecord === undefined
      ? {}
      : { maximumBytesPerRecord: input.maximumBytesPerRecord }),
    ...(input.maximumBytesPerChunk === undefined
      ? {}
      : { maximumBytesPerChunk: input.maximumBytesPerChunk }),
    restoredLedger: input.validationIssue.restoredLedger,
    onLedger: input.validationIssue.onLedger,
  });
  const committedMutations = mutationWriter.restoreAndRead()[Symbol.asyncIterator]();
  const committedValidationIssues = validationIssueWriter.restoreAndRead()[Symbol.asyncIterator]();

  const appendAfterCoordinatedFlush = async <T>(
    writer: CanonicalChunkWriter<T>,
    otherWriter: Readonly<{ bufferedRecordCount: number; flush(): Promise<void> }>,
    value: T,
  ): Promise<void> => {
    if (
      input.budget.metrics().inUse >= input.budget.capacity &&
      otherWriter.bufferedRecordCount > 0
    ) {
      // append() can flush only its own buffer; release the opposite projection's blocking lease.
      await otherWriter.flush();
    }
    await writer.append(value);
  };

  try {
    for await (const event of input.events.read()) {
      if (event.kind === 'mutation') {
        const prior = await committedMutations.next();
        if (!prior.done) {
          if (canonicalJson(prior.value) !== canonicalJson(event.value)) {
            throw new Error('Persisted mutation projection is not an exact event prefix');
          }
        } else {
          await appendAfterCoordinatedFlush(mutationWriter, validationIssueWriter, event.value);
        }
      } else if (event.kind === 'validation_issue') {
        const prior = await committedValidationIssues.next();
        if (!prior.done) {
          if (canonicalJson(prior.value) !== canonicalJson(event.value)) {
            throw new Error('Persisted validation_issue projection is not an exact event prefix');
          }
        } else {
          await appendAfterCoordinatedFlush(validationIssueWriter, mutationWriter, event.value);
        }
      }
    }
    if (!(await committedMutations.next()).done) {
      throw new Error('Persisted mutation projection exceeds its event source');
    }
    if (!(await committedValidationIssues.next()).done) {
      throw new Error('Persisted validation_issue projection exceeds its event source');
    }
    const mutations = await mutationWriter.finish();
    const validationIssues = await validationIssueWriter.finish();
    if (
      input.mutation.expected !== undefined &&
      (input.mutation.expected.recordCount !== mutations.recordCount ||
        input.mutation.expected.logicalSha256 !== mutations.logicalSha256)
    ) {
      throw new Error('Projected mutation logical identity mismatch');
    }
    if (
      input.validationIssue.expected !== undefined &&
      (input.validationIssue.expected.recordCount !== validationIssues.recordCount ||
        input.validationIssue.expected.logicalSha256 !== validationIssues.logicalSha256)
    ) {
      throw new Error('Projected validation_issue logical identity mismatch');
    }
    return Object.freeze({ mutations, validationIssues });
  } catch (error) {
    mutationWriter.abort();
    validationIssueWriter.abort();
    await Promise.allSettled([committedMutations.return?.(), committedValidationIssues.return?.()]);
    throw error;
  }
}

async function collectLegacyArtifact(
  dependencies: OrchestrationDependencies,
  uri: string,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of dependencies.artifactStore.read(uri)) {
    total += chunk.byteLength;
    if (total > LEGACY_WHOLE_COPY_MAX_BYTES) {
      throw new Error(
        `Legacy artifact ${uri} exceeds ${LEGACY_WHOLE_COPY_MAX_BYTES} bytes; v2 streaming is required`,
      );
    }
    chunks.push(Uint8Array.from(chunk));
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function openAcquiredReference(
  reference: DurableAcquiredArtifactReference,
  dependencies: OrchestrationDependencies,
): Promise<AcquiredArtifactSource> {
  if (reference.formatVersion === '2.0.0') {
    return openDurableAcquiredArtifactReference(reference, dependencies.artifactStore);
  }
  return createAcquiredByteArtifact(
    reference.metadata,
    await collectLegacyArtifact(dependencies, reference.metadata.rawUri),
  );
}

function requireLegacyAcquiredArtifact(artifact: AcquiredArtifactSource): AcquiredByteArtifact {
  if (artifact.bytes === undefined) {
    throw new TypeError('Legacy adapter received a streaming acquired-artifact reference');
  }
  return artifact;
}

function createRepeatableAcquiredArtifacts(
  references: readonly DurableAcquiredArtifactReference[],
  dependencies: OrchestrationDependencies,
): RepeatableAcquiredArtifactSources {
  const frozen = Object.freeze([...references]);
  return Object.freeze({
    count: frozen.length,
    metadata: Object.freeze(frozen.map(({ metadata }) => metadata)),
    read: async function* () {
      for (const reference of frozen) yield await openAcquiredReference(reference, dependencies);
    },
  });
}

export class AcquisitionReplayIncompatibleError extends Error {
  public readonly code = 'ACQUISITION_REPLAY_INCOMPATIBLE';

  public constructor(sourceId: SourceId, detail: string) {
    super(
      `Source ${sourceId} cannot resume its durable acquisition prefix: ${detail}. Streaming v2 acquire() must re-emit every committed artifact in exact deterministic order before new artifacts.`,
    );
    this.name = 'AcquisitionReplayIncompatibleError';
  }
}

class LegacyObservationLimitError extends Error {
  public readonly code = 'LEGACY_OBSERVATION_LIMIT';

  public constructor(sourceId: SourceId) {
    super(
      `Legacy v1 summary for ${sourceId} exceeded the reviewed small-run bound; implement StreamingSourceAdapter v2.`,
    );
    this.name = 'LegacyObservationLimitError';
  }
}

async function collectSmallSequence<T>(sequence: ChunkSequence<T>): Promise<readonly T[]> {
  const values: T[] = [];
  for await (const value of sequence.read()) values.push(value);
  return Object.freeze(values);
}

async function concurrentMap<T, U>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<U>,
): Promise<readonly U[]> {
  const results = new Array<U>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await mapper(item, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return Object.freeze(results);
}

function manifestStatus(
  profile: PipelineConfiguration['profile'],
  sources: readonly SourceExecutionManifest[],
): PipelineRunManifest['status'] {
  if (
    profile.name === 'full' &&
    sources.some(({ terminalState }) => terminalState !== 'complete')
  ) {
    return sources.every(({ terminalState }) => terminalState === 'failed') ? 'failed' : 'partial';
  }
  if (sources.every(({ terminalState }) => terminalState === 'complete')) return 'succeeded';
  if (sources.every(({ terminalState }) => terminalState === 'failed')) return 'failed';
  return 'partial';
}

export function countyCompletion(
  profile: PipelineConfiguration['profile'],
  sources: readonly SourceExecutionManifest[],
): PipelineRunManifest['countyCompletion'] {
  const required = sources.filter(({ requiredForCountyCompletion }) => requiredForCountyCompletion);
  const complete = required.filter(({ terminalState }) => terminalState === 'complete');
  const blocking = required
    .filter(({ terminalState }) => terminalState !== 'complete')
    .map(({ sourceId }) => sourceId)
    .sort();
  const capabilityInventory = new Set(required.map(({ capability }) => capability));
  const missingRequiredCapabilities = REQUIRED_COUNTY_CAPABILITIES.filter(
    (capability) => !capabilityInventory.has(capability),
  );
  const unexpectedRequiredCapabilities = [...capabilityInventory]
    .filter(
      (capability) => !(REQUIRED_COUNTY_CAPABILITIES as readonly string[]).includes(capability),
    )
    .sort();
  const inventoryComplete =
    missingRequiredCapabilities.length === 0 && unexpectedRequiredCapabilities.length === 0;
  if (profile.name !== 'full') {
    return Object.freeze({
      state: 'not_applicable' as const,
      requiredSourceCount: required.length,
      completeRequiredSourceCount: complete.length,
      blockingSourceIds: Object.freeze(blocking),
      missingRequiredCapabilities: Object.freeze(missingRequiredCapabilities),
      unexpectedRequiredCapabilities: Object.freeze(unexpectedRequiredCapabilities),
      claim: `${profile.name} is not a county-completion profile.`,
    });
  }
  if (blocking.length === 0 && inventoryComplete) {
    return Object.freeze({
      state: 'complete' as const,
      requiredSourceCount: required.length,
      completeRequiredSourceCount: complete.length,
      blockingSourceIds: Object.freeze([]),
      missingRequiredCapabilities: Object.freeze([]),
      unexpectedRequiredCapabilities: Object.freeze([]),
      claim: 'Every required configured source lane reached complete in an uncapped full run.',
    });
  }
  const blocked = required.some(({ terminalState }) => terminalState === 'blocked');
  return Object.freeze({
    state: blocked ? ('blocked' as const) : ('partial' as const),
    requiredSourceCount: required.length,
    completeRequiredSourceCount: complete.length,
    blockingSourceIds: Object.freeze(blocking),
    missingRequiredCapabilities: Object.freeze(missingRequiredCapabilities),
    unexpectedRequiredCapabilities: Object.freeze(unexpectedRequiredCapabilities),
    claim:
      'County completion is not claimed because one or more required source lanes are incomplete or blocked.',
  });
}

export async function runPipeline(
  configuration: PipelineConfiguration,
  dependencies: OrchestrationDependencies,
): Promise<PipelineResult> {
  assertConfiguration(configuration);
  dependencies.signal.throwIfAborted();
  const hash = configurationHash(configuration);
  const loaded = await loadRunState(dependencies.checkpointStore, configuration.runId);
  if (loaded.state !== undefined && loaded.state.configurationHash !== hash) {
    throw new Error(`Run ${configuration.runId} cannot resume with changed configuration`);
  }
  const migrated =
    loaded.state === undefined
      ? Object.freeze({ state: initialState(configuration, hash), migrated: false })
      : await migrateLegacyNormalizationLedgers(loaded.state, configuration, hash, dependencies);
  const run: MutableRun = {
    envelope: loaded.envelope,
    state: migrated.state,
  };
  const coordinator = new RunCheckpointCoordinator(run, dependencies);
  if (loaded.state === undefined || migrated.migrated) await coordinator.updateRun({});
  if (run.state.manifestArtifact !== null) {
    const manifest = await loadRequired<PipelineRunManifest>(
      dependencies,
      run.state.manifestArtifact,
      'final manifest',
    );
    const manifestArtifact = await dependencies.artifactStore.head(run.state.manifestArtifact.uri);
    if (manifestArtifact === undefined) throw new Error('Completed run manifest is missing');
    return Object.freeze({ manifest, manifestArtifact });
  }
  const recordBudget = createSharedRecordBudget(configuration.profile.maxBufferedRecords);
  let activeRecords = 0;
  let highWaterActiveRecords = 0;
  const onActiveRecordDelta = (delta: number): void => {
    activeRecords += delta;
    highWaterActiveRecords = Math.max(highWaterActiveRecords, activeRecords);
  };
  let bufferedEvents = 0;
  let highWaterBufferedEvents = 0;
  const onBufferedEventDelta = (delta: number): void => {
    bufferedEvents += delta;
    highWaterBufferedEvents = Math.max(highWaterBufferedEvents, bufferedEvents);
  };

  const sourceResults = await concurrentMap(
    configuration.sources,
    configuration.profile.maxConcurrentSources,
    async (source) => {
      const restored = run.state.sources.find(
        ({ sourceId }) => sourceId === source.adapter.describe().sourceId,
      );
      if (restored === undefined)
        throw new Error(`Checkpoint omitted source ${source.adapter.describe().sourceId}`);
      return runSource(
        configuration,
        source,
        restored,
        dependencies,
        coordinator,
        recordBudget,
        onActiveRecordDelta,
        onBufferedEventDelta,
        () => run.envelope?.revision ?? null,
      );
    },
  );

  let reconcileArtifact = run.state.reconcileArtifact;
  let featureArtifact = run.state.featureArtifact;
  let martArtifact = run.state.martArtifact;
  if (reconcileArtifact !== null || featureArtifact !== null || martArtifact !== null) {
    // Outer downstream descriptors predate a persisted source-input binding. Until a final
    // manifest closes the run, retaining any of them can combine newly resumed source ledgers
    // with stale reconcile/feature state. Content-addressed bounded stages still resume through
    // their generation-scoped internal checkpoints after these unbound outer pointers are reset.
    reconcileArtifact = null;
    featureArtifact = null;
    martArtifact = null;
    await coordinator.updateRun({
      reconcileArtifact,
      featureArtifact,
      martArtifact,
      completedPhase: null,
    });
  }
  let boundedCountyCompletionClaim: boolean | null = null;
  const processorSourceManifests = Object.freeze(sourceResults.map(({ manifest }) => manifest));
  if (
    configuration.profile.name !== 'discovery' &&
    sourceResults.some(({ state }) => state.terminalState !== 'failed')
  ) {
    assertCountyProcessorProfile(configuration.profile.name, dependencies.processors.memoryProfile);
    if (
      (configuration.profile.name === 'full' || configuration.profile.name === 'incremental') &&
      dependencies.processors.memoryProfile === 'bounded_streaming_v2'
    ) {
      if (dependencies.processors.processBoundedCounty === undefined) {
        throw new UnboundedCountyPhaseError('reconcile');
      }
      const acquiredSourceResults = sourceResults.filter(({ acquired }) => acquired.length > 0);
      if (acquiredSourceResults.length === 0) {
        throw new UnboundedCountyPhaseError('reconcile');
      }
      const result = await dependencies.processors.processBoundedCounty({
        configuration,
        mutationSources: Object.freeze(
          acquiredSourceResults.map(({ manifest, mutations }) =>
            Object.freeze({
              sourceId: manifest.sourceId,
              snapshotId:
                manifest.snapshotIdentity.observedContentId ?? manifest.snapshotIdentity.intentId,
              sequence: mutations,
            }),
          ),
        ),
        acquiredSources: Object.freeze(
          acquiredSourceResults.map(({ manifest, acquired }) =>
            Object.freeze({
              sourceId: manifest.sourceId,
              artifacts: acquired,
            }),
          ),
        ),
        // Preserve every configured lane, including failed/blocked/no-artifact sources.
        // The bounded processor uses acquiredSources only as the byte-bearing closure and
        // this complete inventory for fail-closed county eligibility and coverage rows.
        sources: processorSourceManifests,
        existing: Object.freeze({ reconcileArtifact, featureArtifact, martArtifact }),
        artifactStore: dependencies.artifactStore,
        checkpointStore: dependencies.checkpointStore,
        clock: dependencies.clock,
        signal: dependencies.signal,
        ...(dependencies.beforePhase === undefined
          ? {}
          : { beforePhase: (phase) => dependencies.beforePhase?.(phase, null) }),
      });
      reconcileArtifact = result.reconcileArtifact;
      featureArtifact = result.featureArtifact;
      martArtifact = result.martArtifact;
      boundedCountyCompletionClaim = result.countyCompletionClaim;
      await coordinator.updateRun({
        reconcileArtifact,
        featureArtifact,
        martArtifact,
        completedPhase: 'build_marts',
      });
    } else {
      const allMutations = await combineChunkSequences(
        sourceResults.map(({ mutations }) => mutations),
      );
      const reconcilePhase = await timedPhase(
        'reconcile',
        null,
        dependencies,
        configuration.maximumPhaseAttempts,
        () => dependencies.processors.reconcile(allMutations, dependencies.signal),
      );
      reconcileArtifact = await writeJsonArtifact({
        store: dependencies.artifactStore,
        runId: configuration.runId,
        owner: 'pipeline',
        phase: 'reconcile',
        value: reconcilePhase.value,
      });
      await coordinator.updateRun({ reconcileArtifact, completedPhase: 'reconcile' });

      const featurePhase = await timedPhase(
        'derive_features',
        null,
        dependencies,
        configuration.maximumPhaseAttempts,
        () => dependencies.processors.deriveFeatures(reconcilePhase.value, dependencies.signal),
      );
      featureArtifact = await writeJsonArtifact({
        store: dependencies.artifactStore,
        runId: configuration.runId,
        owner: 'pipeline',
        phase: 'derive_features',
        value: featurePhase.value,
      });
      await coordinator.updateRun({ featureArtifact, completedPhase: 'derive_features' });

      const martPhase = await timedPhase(
        'build_marts',
        null,
        dependencies,
        configuration.maximumPhaseAttempts,
        () =>
          dependencies.processors.buildMarts(
            {
              reconciled: reconcilePhase.value,
              features: featurePhase.value,
              run: Object.freeze({
                runId: configuration.runId,
                pipelineVersion: configuration.pipelineVersion,
                profile: configuration.profile.name,
                requestedAt: configuration.requestedAt,
                completedAt: dependencies.clock.now(),
              }),
              sources: processorSourceManifests,
            },
            dependencies.signal,
          ),
      );
      martArtifact = await writeJsonArtifact({
        store: dependencies.artifactStore,
        runId: configuration.runId,
        owner: 'pipeline',
        phase: 'build_marts',
        value: martPhase.value,
      });
      await coordinator.updateRun({ martArtifact, completedPhase: 'build_marts' });
    }
  }

  const sourceManifests = sourceResults.map(({ manifest }) => manifest);
  const completedAt = dependencies.clock.now();
  const denominator = sourceManifests.reduce<{
    expectedRecords: number | null;
    observedRecords: number;
    acceptedRecords: number;
    quarantinedRecords: number;
  }>(
    (total, source) => ({
      expectedRecords:
        total.expectedRecords === null || source.coverage.expectedRecords === null
          ? null
          : total.expectedRecords + source.coverage.expectedRecords,
      observedRecords: total.observedRecords + source.coverage.observedRecords,
      acceptedRecords: total.acceptedRecords + source.coverage.acceptedRecords,
      quarantinedRecords: total.quarantinedRecords + source.coverage.quarantinedRecords,
    }),
    {
      expectedRecords: 0,
      observedRecords: 0,
      acceptedRecords: 0,
      quarantinedRecords: 0,
    },
  );
  const globalArtifacts = [reconcileArtifact, featureArtifact, martArtifact].filter(
    (artifact): artifact is PhaseArtifact => artifact !== null,
  );
  const sourceCompletion = countyCompletion(configuration.profile, sourceManifests);
  const completion =
    boundedCountyCompletionClaim === false && sourceCompletion.state === 'complete'
      ? Object.freeze({
          ...sourceCompletion,
          state: 'partial' as const,
          claim:
            'County completion is not claimed because bounded downstream semantic readiness or release gates remain incomplete.',
        })
      : sourceCompletion;
  const manifest: PipelineRunManifest = Object.freeze({
    schemaVersion: '2.0.0',
    runId: configuration.runId,
    pipelineVersion: configuration.pipelineVersion,
    profile: configuration.profile.name,
    status: manifestStatus(configuration.profile, sourceManifests),
    requestedAt: configuration.requestedAt,
    completedAt,
    configurationHash: hash,
    coverageDenominators: Object.freeze(denominator),
    backpressure: Object.freeze({
      maxConcurrentSources: configuration.profile.maxConcurrentSources,
      maxBufferedRecords: configuration.profile.maxBufferedRecords,
      observedHighWaterRecords: recordBudget.metrics().highWaterRecords,
      observedHighWaterActiveRecords: highWaterActiveRecords,
      observedHighWaterBufferedEvents: highWaterBufferedEvents,
      observedHighWaterCombinedRecordsAndEvents: recordBudget.metrics().highWaterRecords,
      activeRecordsAtCompletion: activeRecords,
      bufferedEventsAtCompletion: bufferedEvents,
      totalBudgetAcquisitions: recordBudget.metrics().totalAcquired,
    }),
    sources: Object.freeze(sourceManifests),
    artifacts: Object.freeze(globalArtifacts),
    countyCompletion: completion,
    limitations: Object.freeze(sourceManifests.flatMap(({ limitations }) => limitations)),
  });
  const manifestPhase = await writeJsonArtifact({
    store: dependencies.artifactStore,
    runId: configuration.runId,
    owner: 'pipeline',
    phase: 'finalize',
    value: manifest,
  });
  const manifestArtifact = await dependencies.artifactStore.head(manifestPhase.uri);
  if (manifestArtifact === undefined)
    throw new Error('Final manifest disappeared after immutable write');
  await coordinator.updateRun({ manifestArtifact: manifestPhase, completedPhase: 'finalize' });
  return Object.freeze({ manifest, manifestArtifact });
}

export class UnboundedCountyPhaseError extends Error {
  public readonly code = 'UNBOUNDED_COUNTY_PHASE';

  public constructor(public readonly phase: 'reconcile' | 'derive_features' | 'build_marts') {
    super(
      `County profile stopped before ${phase}: configured processor is not a complete bounded_streaming_v2 implementation and no county-completion claim was written.`,
    );
    this.name = 'UnboundedCountyPhaseError';
  }
}

export function assertCountyProcessorProfile(
  profile: PipelineConfiguration['profile']['name'],
  memoryProfile: OrchestrationDependencies['processors']['memoryProfile'],
): void {
  if (
    (profile === 'full' || profile === 'incremental') &&
    memoryProfile !== 'bounded_streaming_v2'
  ) {
    throw new UnboundedCountyPhaseError('reconcile');
  }
}
