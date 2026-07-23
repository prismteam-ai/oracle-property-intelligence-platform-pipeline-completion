import type { ArtifactStore, RecoverableArtifactStore } from '@oracle/artifacts/artifact-store';
import type { CheckpointStore } from '@oracle/artifacts/checkpoint-store';
import type { CanonicalMutation } from '@oracle/contracts/canonical/mutation';
import type {
  AcquiredArtifact,
  AcquisitionPlan,
  AcquisitionRequest,
  RatePolicy,
  SourceCheckpoint,
  SourceDescriptor,
  SourceAsOf,
  SourceRunSummary,
  ValidationIssue,
} from '@oracle/contracts/source';
import type { RunId, SourceId } from '@oracle/contracts/ids';
import type { Visibility } from '@oracle/contracts/visibility';
import type { AnalyticalRuntime } from '@oracle/data-runtime/analytical-runtime';

import type { AcquiredArtifactSource, AcquiredByteArtifact } from './acquired-artifact.js';
import type { DecodedRecord } from './decode.js';
import type { HttpTransport } from './http.js';
import type { SharedRecordBudget } from './record-budget.js';

export interface Clock {
  /** Returns an injected ISO-8601 instant; implementations must not read wall clock implicitly. */
  now(): string;
}

export interface Delay {
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}

interface PhaseContext {
  readonly clock: Clock;
  readonly signal: AbortSignal;
}

export interface DiscoveryContext extends PhaseContext {
  readonly http: HttpTransport;
  readonly ratePolicy: RatePolicy;
  readonly delay: Delay;
}

export type PlanningContext = PhaseContext;

export interface AcquisitionContext extends PhaseContext {
  readonly http: HttpTransport;
  readonly artifactStore: ArtifactStore;
  readonly checkpointStore: CheckpointStore;
  readonly ratePolicy: RatePolicy;
  readonly delay: Delay;
}

export interface StreamingAcquisitionContext extends Omit<AcquisitionContext, 'artifactStore'> {
  readonly artifactStore: RecoverableArtifactStore;
}

export interface DecodeContext extends PhaseContext {
  readonly artifactStore: ArtifactStore;
  readonly analyticalRuntime: AnalyticalRuntime;
}

export interface StreamingDecodeContext extends Omit<DecodeContext, 'artifactStore'> {
  readonly artifactStore: RecoverableArtifactStore;
  readonly recordBudget: SharedRecordBudget;
}

export type ValidationContext = PhaseContext;

export interface NormalizationContext extends PhaseContext {
  readonly analyticalRuntime: AnalyticalRuntime;
}

export interface StreamingNormalizationContext extends NormalizationContext {
  /** Runner-supplied process-wide hard budget; optional only for direct small-fixture calls. */
  readonly recordBudget?: SharedRecordBudget;
}

export type SummaryContext = PhaseContext;

export interface DiscoveredResource {
  readonly requestKey: string;
  readonly url: string;
  readonly sourceAsOf: SourceAsOf;
  readonly expectedRecords: number | null;
  readonly mediaTypes: readonly string[];
  readonly continuationToken: string | null;
}

export interface DiscoveryResult {
  readonly sourceId: SourceId;
  readonly discoveredAt: string;
  readonly resources: readonly DiscoveredResource[];
  readonly complete: boolean;
  readonly limitations: readonly string[];
}

export type RecordValidation<TValidated> =
  | Readonly<{
      status: 'accepted';
      record: TValidated;
      issues: readonly ValidationIssue[];
    }>
  | Readonly<{
      status: 'rejected';
      issues: readonly ValidationIssue[];
    }>;

export interface VisibilityBearing {
  readonly visibility: Visibility;
}

export interface RepeatableObservationValues<T> {
  readonly count: number;
  /** Hash of the ordered canonical value sequence, independent of physical chunking. */
  readonly logicalSha256: string;
  read(): AsyncIterable<T>;
}

export interface RepeatableAcquiredArtifactSources {
  readonly count: number;
  readonly metadata: readonly AcquiredArtifact[];
  /** Opens a fresh verified source sequence in deterministic acquisition order on every call. */
  read(): AsyncIterable<AcquiredArtifactSource>;
}

export interface SourceRunObservationV2 {
  readonly descriptor: SourceDescriptor;
  readonly runId: RunId;
  readonly request: AcquisitionRequest;
  readonly plan: AcquisitionPlan;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly finalCheckpoint: SourceCheckpoint;
  readonly artifacts: readonly AcquiredArtifact[];
  readonly decodedRecords: number;
  readonly acceptedRecords: number;
  readonly rejectedRecords: number;
  readonly mutations: RepeatableObservationValues<CanonicalMutation>;
  readonly validationIssues: RepeatableObservationValues<ValidationIssue>;
  readonly aborted: boolean;
}

/** Explicit small/blocked v1 compatibility. Orchestration rejects large legacy artifacts. */
export interface SourceRunObservation {
  readonly descriptor: SourceDescriptor;
  readonly runId: RunId;
  readonly request: AcquisitionRequest;
  readonly plan: AcquisitionPlan;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly finalCheckpoint: SourceCheckpoint;
  readonly artifacts: readonly AcquiredArtifact[];
  readonly decodedRecords: number;
  readonly acceptedRecords: number;
  readonly rejectedRecords: number;
  readonly mutations: readonly CanonicalMutation[];
  readonly validationIssues: readonly ValidationIssue[];
  readonly aborted: boolean;
}

/**
 * Provider implementations own parsing details but may not collapse phases.
 * Transport exists only in discovery/acquisition contexts; decoders receive
 * already acquired immutable bytes.
 */
export interface SourceAdapter<
  TDecoded extends DecodedRecord = DecodedRecord,
  TValidated extends VisibilityBearing = TDecoded,
> {
  describe(): SourceDescriptor;
  discover(context: DiscoveryContext): Promise<DiscoveryResult>;
  plan(
    request: AcquisitionRequest,
    discovery: DiscoveryResult,
    context: PlanningContext,
  ): Promise<AcquisitionPlan>;
  acquire(
    plan: AcquisitionPlan,
    checkpoint: SourceCheckpoint | undefined,
    context: AcquisitionContext,
  ): AsyncIterable<AcquiredByteArtifact>;
  decode(artifact: AcquiredByteArtifact, context: DecodeContext): AsyncIterable<TDecoded>;
  validate(record: TDecoded, context: ValidationContext): Promise<RecordValidation<TValidated>>;
  normalize(record: TValidated, context: NormalizationContext): AsyncIterable<CanonicalMutation>;
  summarize(run: SourceRunObservation, context: SummaryContext): SourceRunSummary;
}

export interface StreamingSourceAdapter<
  TDecoded extends DecodedRecord = DecodedRecord,
  TValidated extends VisibilityBearing = TDecoded,
> {
  describe(): SourceDescriptor;
  discover(context: DiscoveryContext): Promise<DiscoveryResult>;
  plan(
    request: AcquisitionRequest,
    discovery: DiscoveryResult,
    context: PlanningContext,
  ): Promise<AcquisitionPlan>;
  acquire(
    plan: AcquisitionPlan,
    checkpoint: SourceCheckpoint | undefined,
    context: StreamingAcquisitionContext,
  ): AsyncIterable<AcquiredArtifactSource>;
  decode(
    artifact: AcquiredArtifactSource,
    context: StreamingDecodeContext,
  ): AsyncIterable<TDecoded>;
  validate(record: TDecoded, context: ValidationContext): Promise<RecordValidation<TValidated>>;
  normalize(
    record: TValidated,
    context: StreamingNormalizationContext,
  ): AsyncIterable<CanonicalMutation>;
  /**
   * Restart-safe end-of-source emission for disk/DuckDB-backed joins. Implementations must rebuild
   * all derived state solely from this repeatable acquired-artifact sequence and durable stores;
   * orchestration may restart this iterator at output offset zero in a fresh process.
   */
  finalizeFromAcquiredArtifacts?(
    artifacts: RepeatableAcquiredArtifactSources,
    context: StreamingNormalizationContext,
  ): AsyncIterable<CanonicalMutation>;
  summarize(run: SourceRunObservationV2, context: SummaryContext): Promise<SourceRunSummary>;
}

export type AnySourceAdapter = SourceAdapter | StreamingSourceAdapter;
