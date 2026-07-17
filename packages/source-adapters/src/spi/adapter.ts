import type { ArtifactStore } from '@oracle/artifacts/artifact-store';
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

import type { AcquiredByteArtifact } from './acquired-artifact.js';
import type { DecodedRecord } from './decode.js';
import type { HttpTransport } from './http.js';

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

export interface DecodeContext extends PhaseContext {
  readonly artifactStore: ArtifactStore;
  readonly analyticalRuntime: AnalyticalRuntime;
}

export type ValidationContext = PhaseContext;

export interface NormalizationContext extends PhaseContext {
  readonly analyticalRuntime: AnalyticalRuntime;
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
