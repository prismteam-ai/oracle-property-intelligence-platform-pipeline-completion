import type { CheckpointEnvelope } from '@oracle/artifacts/checkpoint-store';
import type { CanonicalMutation } from '@oracle/contracts/canonical/mutation';
import type { SourceId } from '@oracle/contracts/ids';
import { snapshotIdSchema } from '@oracle/contracts/ids';
import { sourceCheckpointSchema } from '@oracle/contracts/source';
import type {
  AcquisitionPlan,
  AcquisitionRequest,
  AcquiredArtifact,
  SourceCheckpoint,
  SourceRunSummary,
  ValidationIssue,
} from '@oracle/contracts/source';
import { createAcquiredByteArtifact } from '@oracle/source-adapters/spi/acquired-artifact';
import type { DiscoveryResult, SourceRunObservation } from '@oracle/source-adapters/spi/adapter';

import { readJsonArtifact, writeJsonArtifact } from './artifacts.js';
import { sha256 } from './canonical-json.js';
import { commitRunState, loadRunState } from './checkpoint.js';
import { acquisitionModeFor } from './profiles.js';
import {
  ORCHESTRATION_PHASES,
  type OrchestrationDependencies,
  type OrchestrationPhase,
  type PersistedRunState,
  type PersistedSourceState,
  type PhaseArtifact,
  type PhaseTiming,
  type PipelineConfiguration,
  type PipelineResult,
  type PipelineRunManifest,
  type ReconciliationOutput,
  type SourceConfiguration,
  type SourceCoverage,
  type SourceExecutionManifest,
  type SourceTerminalState,
} from './types.js';

const SOURCE_PHASES = ORCHESTRATION_PHASES.slice(0, 7);

interface MutableRun {
  envelope: CheckpointEnvelope | undefined;
  state: PersistedRunState;
}

type SourceRuntime = Readonly<{
  state: PersistedSourceState;
  mutations: readonly CanonicalMutation[];
  manifest: SourceExecutionManifest;
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

function emptySource(source: SourceConfiguration): PersistedSourceState {
  return Object.freeze({
    sourceId: source.adapter.describe().sourceId,
    snapshotId: source.snapshotId,
    completedPhase: null,
    discoveryArtifact: null,
    planArtifact: null,
    acquiredArtifact: null,
    mutationArtifact: null,
    summaryArtifact: null,
    manifestArtifact: null,
    decodedRecords: 0,
    acceptedRecords: 0,
    rejectedRecords: 0,
    validationIssues: Object.freeze([]),
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
    schemaVersion: 1,
    runId: configuration.runId,
    configurationHash,
    sources: Object.freeze(configuration.sources.map((source) => emptySource(source))),
    reconcileArtifact: null,
    featureArtifact: null,
    martArtifact: null,
    manifestArtifact: null,
    completedPhase: null,
  });
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
    acquiredArtifactIds: artifacts.map(({ artifactId }) => artifactId),
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
  const observedContentId =
    acquired.length === 0
      ? null
      : snapshotIdSchema.parse(
          `sc:snapshot:${input.state.sourceId.replace('sc:source:', '')}:${sha256(
            acquired.map((artifact) => ({
              sha256: artifact.sha256,
              schemaFingerprint: artifact.schemaFingerprint.value,
              sourceAsOf: artifact.sourceAsOf,
            })),
          )}`,
        );
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
  checkpointRevision: () => string | null,
): Promise<SourceRuntime> {
  let state = restored;
  let discovery: DiscoveryResult | undefined;
  let plan: AcquisitionPlan | undefined;
  let acquiredMetadata: readonly AcquiredArtifact[] = [];
  let mutations: readonly CanonicalMutation[] = [];
  let summary: SourceRunSummary | undefined;
  const descriptor = source.adapter.describe();
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
      acquiredMetadata = await loadRequired(dependencies, state.acquiredArtifact, 'acquisition');
    } else {
      const request = acquisitionRequest(configuration, source, discovery);
      const phase = await timedPhase(
        'acquire',
        descriptor.sourceId,
        dependencies,
        configuration.maximumPhaseAttempts,
        async () => {
          const output = [];
          for await (const artifact of source.adapter.acquire(acquisitionPlan, undefined, {
            http: dependencies.http,
            artifactStore: dependencies.artifactStore,
            checkpointStore: dependencies.checkpointStore,
            ratePolicy: descriptor.ratePolicy,
            clock: dependencies.clock,
            delay: dependencies.delay,
            signal: dependencies.signal,
          }))
            output.push(artifact.metadata);
          return Object.freeze(output);
        },
      );
      acquiredMetadata = phase.value;
      state = await persistSourcePhase({
        configuration,
        dependencies,
        coordinator,
        state,
        phase: 'acquire',
        value: acquiredMetadata,
        timing: phase.timing,
        artifactField: 'acquiredArtifact',
      });
      void request;
    }

    if (phaseCompleted(state, 'normalize')) {
      mutations = await loadRequired(dependencies, state.mutationArtifact, 'mutations');
    } else {
      const records = { decoded: 0, accepted: 0, rejected: 0 };
      const issues: ValidationIssue[] = [];
      const normalized: CanonicalMutation[] = [];
      const cap = configuration.profile.recordCap;
      const phase = await timedPhase(
        'decode',
        descriptor.sourceId,
        dependencies,
        configuration.maximumPhaseAttempts,
        async () => {
          outer: for (const metadata of acquiredMetadata) {
            const raw = await collectStoreBytes(dependencies, metadata.rawUri);
            const artifact = createAcquiredByteArtifact(metadata, raw);
            for await (const decoded of source.adapter.decode(artifact, {
              artifactStore: dependencies.artifactStore,
              analyticalRuntime: dependencies.analyticalRuntime,
              clock: dependencies.clock,
              signal: dependencies.signal,
            })) {
              if (cap !== null && records.decoded >= cap) break outer;
              records.decoded += 1;
              const result = await source.adapter.validate(decoded, {
                clock: dependencies.clock,
                signal: dependencies.signal,
              });
              issues.push(...result.issues);
              if (result.status === 'rejected') {
                records.rejected += 1;
                continue;
              }
              records.accepted += 1;
              for await (const mutation of source.adapter.normalize(result.record, {
                analyticalRuntime: dependencies.analyticalRuntime,
                clock: dependencies.clock,
                signal: dependencies.signal,
              }))
                normalized.push(mutation);
            }
          }
          return Object.freeze(normalized);
        },
      );
      const decodeTiming: PhaseTiming = Object.freeze({ ...phase.timing, phase: 'decode' });
      const validateTiming: PhaseTiming = Object.freeze({ ...phase.timing, phase: 'validate' });
      const normalizeTiming: PhaseTiming = Object.freeze({ ...phase.timing, phase: 'normalize' });
      mutations = phase.value;
      const artifact = await writeJsonArtifact({
        store: dependencies.artifactStore,
        runId: configuration.runId,
        owner: state.sourceId,
        phase: 'normalize',
        value: mutations,
      });
      state = Object.freeze({
        ...state,
        mutationArtifact: artifact,
        completedPhase: 'normalize',
        decodedRecords: records.decoded,
        acceptedRecords: records.accepted,
        rejectedRecords: records.rejected,
        validationIssues: Object.freeze(issues),
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
      const observation: SourceRunObservation = Object.freeze({
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
        mutations,
        validationIssues: state.validationIssues as readonly ValidationIssue[],
        aborted: false,
      });
      const phase = await timedPhase(
        'summarize',
        descriptor.sourceId,
        dependencies,
        configuration.maximumPhaseAttempts,
        () =>
          Promise.resolve(
            source.adapter.summarize(observation, {
              clock: dependencies.clock,
              signal: dependencies.signal,
            }),
          ),
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
  return Object.freeze({ state, mutations, manifest });
}

async function collectStoreBytes(
  dependencies: OrchestrationDependencies,
  uri: string,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of dependencies.artifactStore.read(uri)) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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
  const run: MutableRun = {
    envelope: loaded.envelope,
    state: loaded.state ?? initialState(configuration, hash),
  };
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
  const coordinator = new RunCheckpointCoordinator(run, dependencies);
  if (loaded.state === undefined) await coordinator.updateRun({});

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
        () => run.envelope?.revision ?? null,
      );
    },
  );

  let reconcileArtifact = run.state.reconcileArtifact;
  let featureArtifact = run.state.featureArtifact;
  let martArtifact = run.state.martArtifact;
  const allMutations = Object.freeze(sourceResults.flatMap(({ mutations }) => mutations));
  const processorSourceManifests = Object.freeze(sourceResults.map(({ manifest }) => manifest));
  if (
    configuration.profile.name !== 'discovery' &&
    sourceResults.some(({ state }) => state.terminalState !== 'failed')
  ) {
    let reconciled: ReconciliationOutput;
    if (reconcileArtifact === null) {
      const phase = await timedPhase(
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
        value: phase.value,
      });
      await coordinator.updateRun({ reconcileArtifact, completedPhase: 'reconcile' });
      reconciled = phase.value;
    } else reconciled = await loadRequired(dependencies, reconcileArtifact, 'reconciliation');

    let features: unknown;
    if (featureArtifact === null) {
      const phase = await timedPhase(
        'derive_features',
        null,
        dependencies,
        configuration.maximumPhaseAttempts,
        () => dependencies.processors.deriveFeatures(reconciled, dependencies.signal),
      );
      featureArtifact = await writeJsonArtifact({
        store: dependencies.artifactStore,
        runId: configuration.runId,
        owner: 'pipeline',
        phase: 'derive_features',
        value: phase.value,
      });
      await coordinator.updateRun({ featureArtifact, completedPhase: 'derive_features' });
      features = phase.value;
    } else features = await loadRequired(dependencies, featureArtifact, 'features');

    if (martArtifact === null) {
      const phase = await timedPhase(
        'build_marts',
        null,
        dependencies,
        configuration.maximumPhaseAttempts,
        () =>
          dependencies.processors.buildMarts(
            {
              reconciled,
              features,
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
        value: phase.value,
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
  const completion = countyCompletion(configuration.profile, sourceManifests);
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
