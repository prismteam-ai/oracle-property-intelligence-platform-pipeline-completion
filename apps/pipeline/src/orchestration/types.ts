import type { RecoverableArtifactStore, StoredArtifact } from '@oracle/artifacts/artifact-store';
import type { CheckpointStore } from '@oracle/artifacts/checkpoint-store';
import type { CanonicalMutation } from '@oracle/contracts/canonical/mutation';
import type { RunId, SnapshotId, SourceId } from '@oracle/contracts/ids';
import type { AcquiredArtifact, SourceRunSummary } from '@oracle/contracts/source';
import type { AnalyticalRuntime } from '@oracle/data-runtime/analytical-runtime';
import type {
  Clock,
  Delay,
  DiscoveryResult,
  AnySourceAdapter,
} from '@oracle/source-adapters/spi/adapter';
import type { HttpTransport } from '@oracle/source-adapters/spi/http';

import type { ChunkReference, ChunkSequence } from './chunks.js';

export const ORCHESTRATION_PHASES = Object.freeze([
  'discover',
  'plan',
  'acquire',
  'decode',
  'validate',
  'normalize',
  'summarize',
  'reconcile',
  'derive_features',
  'build_marts',
  'finalize',
] as const);

export type OrchestrationPhase = (typeof ORCHESTRATION_PHASES)[number];
export type RunProfileName = 'discovery' | 'pilot' | 'full' | 'incremental';
export type SourceTerminalState = 'complete' | 'partial' | 'blocked' | 'failed';
export type SourceExecutionMode = 'execute' | 'discover_only';
export type SourceSupportState = 'available' | 'blocked';
export type DiscoveryDenominatorStrategy = 'first_non_null' | 'sum_non_null' | 'unavailable';

export type RunProfile = Readonly<{
  name: RunProfileName;
  recordCap: number | null;
  maxConcurrentSources: number;
  maxBufferedRecords: number;
}>;

export type SourceConfiguration = Readonly<{
  adapter: AnySourceAdapter;
  snapshotId: SnapshotId;
  scope: string;
  capability: string;
  executionMode: SourceExecutionMode;
  supportState: SourceSupportState;
  acquisitionItemCap: number | null;
  discoveryDenominatorStrategy: DiscoveryDenominatorStrategy;
  requiredForCountyCompletion: boolean;
  expectedRecords?: number | null;
  limitations?: readonly string[];
}>;

export type PipelineConfiguration = Readonly<{
  runId: RunId;
  pipelineVersion: string;
  requestedAt: string;
  profile: RunProfile;
  sources: readonly SourceConfiguration[];
  maximumPhaseAttempts: number;
}>;

export type PhaseTiming = Readonly<{
  phase: OrchestrationPhase;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  attempts: number;
}>;

export type SourceCoverage = Readonly<{
  expectedRecords: number | null;
  observedRecords: number;
  acceptedRecords: number;
  quarantinedRecords: number;
  denominatorMethod: 'configured' | 'discovered' | 'unavailable';
  ratio: number | null;
}>;

export type PhaseArtifact = Readonly<{
  phase: OrchestrationPhase;
  logicalKey: string;
  uri: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
}>;

export type SourceExecutionManifest = Readonly<{
  sourceId: SourceId;
  snapshotId: SnapshotId;
  snapshotIdentity: Readonly<{
    intentId: SnapshotId;
    observedContentId: SnapshotId | null;
    method: 'configured_intent_plus_observed_content_v1';
  }>;
  scope: string;
  capability: string;
  executionMode: SourceExecutionMode;
  supportState: SourceSupportState;
  requiredForCountyCompletion: boolean;
  terminalState: SourceTerminalState;
  sourceHash: string;
  sourceAsOf: string | null;
  license: Readonly<{
    redistribution: 'approved' | 'restricted' | 'prohibited' | 'unknown';
    containsPersonalData: boolean;
    defaultVisibility: 'public' | 'restricted' | 'prohibited_public' | 'authenticated';
  }>;
  schemaHashes: readonly string[];
  checkpointRevision: string | null;
  coverage: SourceCoverage;
  timings: readonly PhaseTiming[];
  artifacts: readonly PhaseArtifact[];
  limitations: readonly string[];
  errorCodes: readonly string[];
  summary: SourceRunSummary | null;
}>;

export type PipelineRunManifest = Readonly<{
  schemaVersion: '2.0.0';
  runId: RunId;
  pipelineVersion: string;
  profile: RunProfileName;
  status: 'succeeded' | 'partial' | 'failed' | 'aborted';
  requestedAt: string;
  completedAt: string;
  configurationHash: string;
  coverageDenominators: Readonly<{
    expectedRecords: number | null;
    observedRecords: number;
    acceptedRecords: number;
    quarantinedRecords: number;
  }>;
  backpressure: Readonly<{
    maxConcurrentSources: number;
    maxBufferedRecords: number;
    observedHighWaterRecords: number;
    observedHighWaterActiveRecords: number;
    observedHighWaterBufferedEvents: number;
    observedHighWaterCombinedRecordsAndEvents: number;
    activeRecordsAtCompletion: number;
    bufferedEventsAtCompletion: number;
    totalBudgetAcquisitions: number;
  }>;
  sources: readonly SourceExecutionManifest[];
  artifacts: readonly PhaseArtifact[];
  countyCompletion: Readonly<{
    state: 'not_applicable' | 'complete' | 'partial' | 'blocked';
    requiredSourceCount: number;
    completeRequiredSourceCount: number;
    blockingSourceIds: readonly SourceId[];
    missingRequiredCapabilities: readonly string[];
    unexpectedRequiredCapabilities: readonly string[];
    claim: string;
  }>;
  limitations: readonly string[];
}>;

export type PipelineResult = Readonly<{
  manifest: PipelineRunManifest;
  manifestArtifact: StoredArtifact;
}>;

export type ReconciliationOutput = Readonly<{
  canonical: unknown;
  links: unknown;
}>;

export interface PipelineProcessors {
  /** Default v1 reducers are small-run-only; full runs fail before invoking them. */
  readonly memoryProfile: 'bounded_streaming_v2' | 'small_run_only_v1';
  reconcile(
    mutations: ChunkSequence<CanonicalMutation>,
    signal: AbortSignal,
  ): Promise<ReconciliationOutput>;
  deriveFeatures(reconciled: ReconciliationOutput, signal: AbortSignal): Promise<unknown>;
  buildMarts(
    input: Readonly<{
      reconciled: ReconciliationOutput;
      features: unknown;
      run: Readonly<{
        runId: RunId;
        pipelineVersion: string;
        profile: RunProfileName;
        requestedAt: string;
        completedAt: string;
      }>;
      sources: readonly SourceExecutionManifest[];
    }>,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export type OrchestrationDependencies = Readonly<{
  artifactStore: RecoverableArtifactStore;
  checkpointStore: CheckpointStore;
  analyticalRuntime: AnalyticalRuntime;
  http: HttpTransport;
  clock: Clock;
  delay: Delay;
  processors: PipelineProcessors;
  signal: AbortSignal;
  beforePhase?: (phase: OrchestrationPhase, sourceId: SourceId | null) => void | Promise<void>;
}>;

export type PersistedSourceState = Readonly<{
  sourceId: SourceId;
  snapshotId: SnapshotId;
  completedPhase: OrchestrationPhase | null;
  discoveryArtifact: PhaseArtifact | null;
  planArtifact: PhaseArtifact | null;
  acquiredArtifact: PhaseArtifact | null;
  acquisitionChunks: readonly ChunkReference[];
  acquisitionRecords: number;
  acquisitionLogicalSha256: string | null;
  mutationArtifact: PhaseArtifact | null;
  mutationChunks: readonly ChunkReference[];
  validationIssueChunks: readonly ChunkReference[];
  mutationLogicalSha256: string | null;
  validationIssueLogicalSha256: string | null;
  normalizationChunks: readonly ChunkReference[];
  normalizationEventRecords: number;
  normalizationLogicalSha256: string | null;
  normalizationCursor: NormalizationCursor | null;
  summaryArtifact: PhaseArtifact | null;
  manifestArtifact: PhaseArtifact | null;
  decodedRecords: number;
  acceptedRecords: number;
  rejectedRecords: number;
  mutationRecords: number;
  validationIssueRecords: number;
  timings: readonly PhaseTiming[];
  terminalState: SourceTerminalState | null;
  limitations: readonly string[];
  errorCodes: readonly string[];
}>;

export type NormalizationCursor = Readonly<{
  artifactIndex: number;
  recordOrdinal: number;
  issueOffset: number;
  mutationOffset: number;
  recordComplete: boolean;
  decodedRecords: number;
  acceptedRecords: number;
  rejectedRecords: number;
}>;

export type PersistedRunState = Readonly<{
  schemaVersion: 2;
  runId: RunId;
  configurationHash: string;
  sources: readonly PersistedSourceState[];
  reconcileArtifact: PhaseArtifact | null;
  featureArtifact: PhaseArtifact | null;
  martArtifact: PhaseArtifact | null;
  manifestArtifact: PhaseArtifact | null;
  completedPhase: OrchestrationPhase | null;
}>;

export type SourceRuntimeData = Readonly<{
  discovery: DiscoveryResult;
  acquired: readonly AcquiredArtifact[];
  mutations: ChunkSequence<CanonicalMutation>;
  summary: SourceRunSummary;
}>;
