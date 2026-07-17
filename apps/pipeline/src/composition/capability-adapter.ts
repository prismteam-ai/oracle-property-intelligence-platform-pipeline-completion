import { createHash } from 'node:crypto';

import { sourceDescriptorSchema, type SourceDescriptor } from '@oracle/contracts/source';
import type { CanonicalMutation } from '@oracle/contracts/canonical/mutation';
import type { AcquiredByteArtifact } from '@oracle/source-adapters/spi/acquired-artifact';
import type {
  DecodeContext,
  DiscoveryContext,
  DiscoveryResult,
  NormalizationContext,
  PlanningContext,
  RecordValidation,
  SourceAdapter,
  SourceRunObservation,
  SummaryContext,
  ValidationContext,
} from '@oracle/source-adapters/spi/adapter';
import type { DecodedRecord } from '@oracle/source-adapters/spi/decode';
import type {
  AcquisitionPlan,
  AcquisitionRequest,
  SourceCheckpoint,
  SourceRunSummary,
} from '@oracle/contracts/source';
import type { AcquisitionContext } from '@oracle/source-adapters/spi/adapter';

export type BlockedCapabilityDefinition = Readonly<{
  descriptor: SourceDescriptor;
  officialUrls: readonly string[];
  reason: string;
  limitations: readonly string[];
}>;

export function createBlockedCapabilityDescriptor(
  input: Omit<SourceDescriptor, 'contractVersion'>,
): SourceDescriptor {
  return sourceDescriptorSchema.parse({ ...input, contractVersion: '1.0.0' });
}

function termsAccess(reason: string, sourceId: string, phase: string): Error {
  return Object.assign(new Error(reason), {
    name: 'TermsAccessError',
    code: 'TERMS_ACCESS',
    retryable: false,
    sourceId,
    phase,
  });
}

async function probe(url: string, context: DiscoveryContext): Promise<string | null> {
  try {
    const response = await context.http.send(
      Object.freeze({ method: 'HEAD', url, headers: Object.freeze({}) }),
      context.signal,
    );
    return response.status >= 200 && response.status < 400
      ? null
      : `Official capability endpoint returned HTTP ${response.status}`;
  } catch (error) {
    if (context.signal.aborted) throw error;
    return `Official capability endpoint could not be verified: ${error instanceof Error ? error.name : 'unknown error'}`;
  }
}

/**
 * Represents a real, documented source capability whose acquisition prerequisites
 * are unavailable. It can perform read-only endpoint discovery, but every data
 * phase fails closed and it can never emit a record or mutation.
 */
export class BlockedCapabilityAdapter implements SourceAdapter {
  readonly #definition: BlockedCapabilityDefinition;

  public constructor(definition: BlockedCapabilityDefinition) {
    this.#definition = Object.freeze({
      ...definition,
      descriptor: sourceDescriptorSchema.parse(definition.descriptor),
      officialUrls: Object.freeze([...definition.officialUrls]),
      limitations: Object.freeze([...definition.limitations]),
    });
  }

  public describe(): SourceDescriptor {
    return this.#definition.descriptor;
  }

  public async discover(context: DiscoveryContext): Promise<DiscoveryResult> {
    context.signal.throwIfAborted();
    const probeLimitations = await Promise.all(
      this.#definition.officialUrls.map((url) => probe(url, context)),
    );
    return Object.freeze({
      sourceId: this.#definition.descriptor.sourceId,
      discoveredAt: context.clock.now(),
      resources: Object.freeze(
        this.#definition.officialUrls.map((url, index) =>
          Object.freeze({
            requestKey: `capability-${String(index).padStart(2, '0')}-${createHash('sha256').update(url).digest('hex').slice(0, 12)}`,
            url,
            sourceAsOf: Object.freeze({
              state: 'unknown' as const,
              reason: 'Capability endpoint does not expose an approved immutable data snapshot',
            }),
            expectedRecords: null,
            mediaTypes: Object.freeze(['text/html', 'application/pdf']),
            continuationToken: null,
          }),
        ),
      ),
      complete: false,
      limitations: Object.freeze([
        this.#definition.reason,
        ...this.#definition.limitations,
        ...probeLimitations.filter((value): value is string => value !== null),
      ]),
    });
  }

  public plan(
    _request: AcquisitionRequest,
    _discovery: DiscoveryResult,
    context: PlanningContext,
  ): Promise<AcquisitionPlan> {
    context.signal.throwIfAborted();
    return Promise.reject(
      termsAccess(this.#definition.reason, this.#definition.descriptor.sourceId, 'plan'),
    );
  }

  public acquire(
    _plan: AcquisitionPlan,
    _checkpoint: SourceCheckpoint | undefined,
    context: AcquisitionContext,
  ): AsyncIterable<AcquiredByteArtifact> {
    context.signal.throwIfAborted();
    return rejectedStream(
      termsAccess(this.#definition.reason, this.#definition.descriptor.sourceId, 'acquire'),
    );
  }

  public decode(
    _artifact: AcquiredByteArtifact,
    context: DecodeContext,
  ): AsyncIterable<DecodedRecord> {
    context.signal.throwIfAborted();
    return rejectedStream(
      termsAccess(this.#definition.reason, this.#definition.descriptor.sourceId, 'decode'),
    );
  }

  public validate(
    _record: DecodedRecord,
    context: ValidationContext,
  ): Promise<RecordValidation<DecodedRecord>> {
    context.signal.throwIfAborted();
    return Promise.reject(
      termsAccess(this.#definition.reason, this.#definition.descriptor.sourceId, 'validate'),
    );
  }

  public normalize(
    _record: DecodedRecord,
    context: NormalizationContext,
  ): AsyncIterable<CanonicalMutation> {
    context.signal.throwIfAborted();
    return rejectedStream(
      termsAccess(this.#definition.reason, this.#definition.descriptor.sourceId, 'normalize'),
    );
  }

  public summarize(_run: SourceRunObservation, context: SummaryContext): SourceRunSummary {
    context.signal.throwIfAborted();
    throw termsAccess(this.#definition.reason, this.#definition.descriptor.sourceId, 'summarize');
  }
}

async function* rejectedStream<T>(error: Error): AsyncIterable<T> {
  await Promise.reject(error);
  yield undefined as T;
}
