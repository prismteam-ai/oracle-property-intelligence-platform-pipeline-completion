export const SOURCE_ADAPTER_CONTRACT_CHECKS = [
  'checkpoint_resume',
  'pagination',
  'retry_classification',
  'abort_propagation',
  'artifact_integrity',
  'decode_validation_separation',
  'normalization_determinism',
  'source_id_uniqueness',
  'summary_accounting',
  'visibility_preservation',
] as const;

export type SourceAdapterContractCheck = (typeof SOURCE_ADAPTER_CONTRACT_CHECKS)[number];

export interface SourceAdapterContractViolation {
  readonly check: SourceAdapterContractCheck;
  readonly message: string;
}

export interface SourceAdapterContractReport {
  readonly ok: boolean;
  readonly checks: readonly SourceAdapterContractCheck[];
  readonly violations: readonly SourceAdapterContractViolation[];
}

export interface CheckpointResumeObservation {
  readonly firstRunArtifactIds: readonly string[];
  readonly firstRunLastCheckpoint: string;
  readonly resumedFromCheckpoint: string;
  readonly resumedArtifactIds: readonly string[];
}

export interface PaginationObservation {
  readonly requestedPageTokens: readonly (string | null)[];
  readonly returnedNextPageTokens: readonly (string | null)[];
  readonly artifactIds: readonly string[];
}

export interface RetryClassificationObservation {
  readonly transientAttempts: number;
  readonly permanentAttempts: number;
  readonly abortAttempts: number;
  readonly transientEventuallySucceeded: boolean;
}

export interface AbortObservation {
  readonly signalObserved: boolean;
  readonly emissionsAfterAbort: number;
}

export interface IntegrityObservation {
  readonly expectedSha256: string;
  readonly actualSha256: string;
  readonly expectedByteSize: number;
  readonly actualByteSize: number;
  readonly sha256AfterConsumerMutation: string;
}

export interface PhaseSeparationObservation {
  readonly phaseTrace: readonly ('acquire' | 'decode' | 'validate' | 'normalize' | 'summarize')[];
  readonly transportCallsAtDecodeStart: number;
  readonly transportCallsAtDecodeEnd: number;
  readonly validationInputCount: number;
  readonly decodedRecordCount: number;
}

export interface NormalizationObservation {
  readonly firstCanonicalJson: string;
  readonly secondCanonicalJson: string;
}

export interface RegistryObservation {
  readonly registeredSourceIds: readonly string[];
  readonly duplicateSourceRejected: boolean;
  readonly unsupportedContractVersionRejected: boolean;
}

export interface SummaryAccountingObservation {
  readonly observed: Readonly<{
    artifacts: number;
    decoded: number;
    accepted: number;
    rejected: number;
    mutations: number;
  }>;
  readonly summarized: Readonly<{
    artifacts: number;
    decoded: number;
    accepted: number;
    rejected: number;
    mutations: number;
  }>;
}

export interface VisibilityObservation {
  readonly input: readonly string[];
  readonly output: readonly string[];
  readonly prohibitedPublicWasPublicationEligible: boolean;
}

/**
 * A provider test supplies observations produced by real adapter phase calls.
 * Keeping this interface structural avoids a testkit -> adapter package cycle.
 */
export interface SourceAdapterContractHarness {
  checkpointResume(): Promise<CheckpointResumeObservation>;
  pagination(): Promise<PaginationObservation>;
  retryClassification(): Promise<RetryClassificationObservation>;
  abortPropagation(): Promise<AbortObservation>;
  artifactIntegrity(): Promise<IntegrityObservation>;
  decodeValidationSeparation(): Promise<PhaseSeparationObservation>;
  normalizationDeterminism(): Promise<NormalizationObservation>;
  sourceIdUniqueness(): Promise<RegistryObservation>;
  summaryAccounting(): Promise<SummaryAccountingObservation>;
  visibilityPreservation(): Promise<VisibilityObservation>;
}

function duplicates(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      repeated.add(value);
    }
    seen.add(value);
  }
  return [...repeated];
}

export async function runSourceAdapterContractSuite(
  harness: SourceAdapterContractHarness,
): Promise<SourceAdapterContractReport> {
  const violations: SourceAdapterContractViolation[] = [];
  const fail = (check: SourceAdapterContractCheck, message: string): void => {
    violations.push(Object.freeze({ check, message }));
  };

  const checkpoint = await harness.checkpointResume();
  if (checkpoint.resumedFromCheckpoint !== checkpoint.firstRunLastCheckpoint) {
    fail('checkpoint_resume', 'resume did not start from the last committed checkpoint');
  }
  if (checkpoint.resumedArtifactIds.some((id) => checkpoint.firstRunArtifactIds.includes(id))) {
    fail('checkpoint_resume', 'resume emitted an artifact committed by the first run');
  }

  const pagination = await harness.pagination();
  if (pagination.requestedPageTokens[0] !== null) {
    fail('pagination', 'pagination did not begin with the initial null token');
  }
  if (duplicates(pagination.artifactIds).length > 0) {
    fail('pagination', 'pagination emitted duplicate artifacts');
  }
  const expectedRequests = pagination.returnedNextPageTokens.slice(0, -1);
  if (
    pagination.returnedNextPageTokens.at(-1) !== null ||
    JSON.stringify(pagination.requestedPageTokens.slice(1)) !== JSON.stringify(expectedRequests)
  ) {
    fail('pagination', 'page tokens were skipped, repeated, or followed after termination');
  }

  const retry = await harness.retryClassification();
  if (retry.transientAttempts < 2 || !retry.transientEventuallySucceeded) {
    fail('retry_classification', 'transient failure did not retry to success');
  }
  if (retry.permanentAttempts !== 1 || retry.abortAttempts !== 1) {
    fail('retry_classification', 'permanent or aborted work was retried');
  }

  const abort = await harness.abortPropagation();
  if (!abort.signalObserved || abort.emissionsAfterAbort !== 0) {
    fail('abort_propagation', 'abort was not observed before subsequent emission');
  }

  const integrity = await harness.artifactIntegrity();
  if (
    integrity.expectedSha256 !== integrity.actualSha256 ||
    integrity.expectedSha256 !== integrity.sha256AfterConsumerMutation ||
    integrity.expectedByteSize !== integrity.actualByteSize
  ) {
    fail('artifact_integrity', 'artifact bytes, size, or SHA-256 changed');
  }

  const phases = await harness.decodeValidationSeparation();
  if (
    phases.transportCallsAtDecodeStart !== phases.transportCallsAtDecodeEnd ||
    phases.validationInputCount !== phases.decodedRecordCount ||
    JSON.stringify(phases.phaseTrace) !==
      JSON.stringify(['acquire', 'decode', 'validate', 'normalize', 'summarize'])
  ) {
    fail(
      'decode_validation_separation',
      'transport, decoding, validation, normalization, and summary phases were conflated',
    );
  }

  const normalization = await harness.normalizationDeterminism();
  if (normalization.firstCanonicalJson !== normalization.secondCanonicalJson) {
    fail('normalization_determinism', 'identical input produced different mutations');
  }

  const registry = await harness.sourceIdUniqueness();
  if (
    duplicates(registry.registeredSourceIds).length > 0 ||
    !registry.duplicateSourceRejected ||
    !registry.unsupportedContractVersionRejected
  ) {
    fail('source_id_uniqueness', 'registry accepted a source collision or version mismatch');
  }

  const summary = await harness.summaryAccounting();
  if (
    summary.observed.artifacts !== summary.summarized.artifacts ||
    summary.observed.decoded !== summary.summarized.decoded ||
    summary.observed.accepted !== summary.summarized.accepted ||
    summary.observed.rejected !== summary.summarized.rejected ||
    summary.observed.mutations !== summary.summarized.mutations ||
    summary.observed.accepted + summary.observed.rejected !== summary.observed.decoded
  ) {
    fail('summary_accounting', 'summary counters do not reconcile to phase observations');
  }

  const visibility = await harness.visibilityPreservation();
  if (
    JSON.stringify(visibility.input) !== JSON.stringify(visibility.output) ||
    visibility.prohibitedPublicWasPublicationEligible
  ) {
    fail('visibility_preservation', 'visibility changed or prohibited data became eligible');
  }

  return Object.freeze({
    ok: violations.length === 0,
    checks: SOURCE_ADAPTER_CONTRACT_CHECKS,
    violations: Object.freeze(violations),
  });
}
