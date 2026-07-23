import { createHash } from 'node:crypto';

import {
  sourceRunSummarySchema,
  type AcquisitionPlan,
  type SourceDescriptor,
  type SourceRunSummary,
} from '@oracle/contracts/source';
import {
  oracleErrorSchema,
  type OracleError,
  type OracleErrorCode,
} from '@oracle/contracts/errors';
import { sourceDescriptorSchema } from '@oracle/contracts/source';

import type { AcquiredByteArtifact } from '../../spi/acquired-artifact.js';
import type {
  AcquisitionContext,
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
} from '../../spi/adapter.js';
import type { CanonicalMutation } from '@oracle/contracts/canonical/mutation';
import type {
  AcquisitionRequest,
  SourceCheckpoint,
  ValidationIssue,
} from '@oracle/contracts/source';
import type { HttpResponse } from '../../spi/http.js';

import { createOwnershipTransferCapability } from './capability.js';
import {
  OWNERSHIP_CAPABILITY_CAPTURED_AT,
  OWNERSHIP_CAPABILITY_PAGE_SPECS,
  OWNERSHIP_CAPABILITY_SCHEMA_FINGERPRINT,
  OWNERSHIP_DATA_SALES_URL,
  OWNERSHIP_TRANSFER_LICENSE_SNAPSHOT_ID,
  OWNERSHIP_TRANSFER_SOURCE_ID,
} from './constants.js';
import type {
  OwnershipCapabilityDecodedRecord,
  OwnershipCapabilityPageEvidence,
  OwnershipCapabilityValidatedRecord,
  OwnershipTransferCapability,
} from './types.js';

const CONTRACT_VERSION = '1.0.0';
const MAX_PAGE_BYTES = 1024 * 1024;
const ACCEPT_HEADER_HASH = createHash('sha256').update('text/html').digest('hex');

const DESCRIPTOR: SourceDescriptor = sourceDescriptorSchema.parse({
  sourceId: OWNERSHIP_TRANSFER_SOURCE_ID,
  contractVersion: CONTRACT_VERSION,
  name: 'Santa Clara County ownership and recorded-transfer capability',
  authority: {
    authorityType: 'official_government',
    organization: 'County of Santa Clara Office of the Clerk-Recorder',
    jurisdiction: 'Santa Clara County, California',
    canonicalUrl: OWNERSHIP_DATA_SALES_URL,
    authorityRank: 100,
  },
  acquisitionMethod: 'manual_snapshot',
  encodings: ['other'],
  entityKinds: ['ownership-event', 'ownership-capability'],
  defaultVisibility: 'restricted',
  license: {
    licenseSnapshotId: OWNERSHIP_TRANSFER_LICENSE_SNAPSHOT_ID,
    capturedAt: OWNERSHIP_CAPABILITY_CAPTURED_AT,
    title: 'Santa Clara Clerk-Recorder official index access and rights capability snapshot',
    canonicalUrl: OWNERSHIP_DATA_SALES_URL,
    termsSha256: OWNERSHIP_TRANSFER_LICENSE_SNAPSHOT_ID.split(':').at(-1),
    redistribution: 'unknown',
    containsPersonalData: true,
    attribution: ['County of Santa Clara Office of the Clerk-Recorder'],
    limitations: [
      'The official grantor/grantee index is a paid subscription product, not an anonymous bulk/API download.',
      'The standard index contains party names but omits property address and APN.',
      'No source grant of public redistribution or irreversible publication rights is recorded.',
      'A locator index is not a complete current ownership chain or title opinion.',
    ],
  },
  ratePolicy: {
    maxRequestsPerWindow: 3,
    windowMs: 1_000,
    maxConcurrency: 3,
    maxAttempts: 4,
    initialBackoffMs: 250,
    maxBackoffMs: 2_000,
    jitter: 'none',
    respectRetryAfter: true,
  },
  freshnessSemantics:
    'Capability metadata is measured from official county pages; owner-bearing index coverage remains unknown until an approved subscribed snapshot is acquired.',
});

function oracleError(
  code: OracleErrorCode,
  message: string,
  phase: string,
  details?: Readonly<Record<string, unknown>>,
): Error & OracleError {
  const parsed = oracleErrorSchema.parse({
    code,
    retryable: code === 'TRANSIENT_SOURCE',
    message,
    sourceId: OWNERSHIP_TRANSFER_SOURCE_ID,
    phase,
    ...(details === undefined ? {} : { details }),
  });
  return Object.assign(new Error(parsed.message), parsed);
}

function rejectedAsyncIterable<T>(signal: AbortSignal, failure: () => Error): AsyncIterable<T> {
  return Object.freeze({
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return Object.freeze({
        next: async (): Promise<IteratorResult<T>> => {
          signal.throwIfAborted();
          await Promise.resolve();
          throw failure();
        },
      });
    },
  });
}

function header(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const target = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === target)?.[1];
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value.trim())) return undefined;
  const milliseconds = Number(value.trim()) * 1_000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function httpDateToIso(value: string | undefined): string | null {
  if (value === undefined) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

async function collectBody(response: HttpResponse, signal: AbortSignal): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    length += chunk.byteLength;
    if (length > MAX_PAGE_BYTES) {
      throw oracleError(
        'SCHEMA_DRIFT',
        'Official capability page exceeded the 1 MiB discovery limit',
        'discover',
        { length },
      );
    }
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function normalizedPageText(bytes: Uint8Array): string {
  let html: string;
  try {
    html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw oracleError('SCHEMA_DRIFT', 'Official capability page is not valid UTF-8', 'discover');
  }
  return html
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&(?:nbsp|#160);/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

async function fetchOfficialPage(
  spec: (typeof OWNERSHIP_CAPABILITY_PAGE_SPECS)[number],
  context: DiscoveryContext,
): Promise<OwnershipCapabilityPageEvidence> {
  for (let attempt = 1; attempt <= context.ratePolicy.maxAttempts; attempt += 1) {
    context.signal.throwIfAborted();
    try {
      const response = await context.http.send(
        { method: 'GET', url: spec.url, headers: Object.freeze({ accept: 'text/html' }) },
        context.signal,
      );
      if (response.status === 429 || response.status >= 500) {
        if (attempt === context.ratePolicy.maxAttempts) {
          throw oracleError(
            'TRANSIENT_SOURCE',
            `Official capability page remained unavailable (${response.status})`,
            'discover',
            { url: spec.url, attempt },
          );
        }
        const retryAfter = context.ratePolicy.respectRetryAfter
          ? parseRetryAfter(header(response.headers, 'retry-after'))
          : undefined;
        const backoff = Math.min(
          context.ratePolicy.maxBackoffMs,
          context.ratePolicy.initialBackoffMs * 2 ** (attempt - 1),
        );
        await context.delay.wait(retryAfter ?? backoff, context.signal);
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw oracleError(
          response.status === 401 || response.status === 403 ? 'TERMS_ACCESS' : 'SCHEMA_DRIFT',
          `Official capability page returned HTTP ${response.status}`,
          'discover',
          { url: spec.url },
        );
      }
      const mediaType = header(response.headers, 'content-type')
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase();
      if (mediaType !== 'text/html') {
        throw oracleError('SCHEMA_DRIFT', 'Official capability page is not text/html', 'discover', {
          url: spec.url,
          mediaType,
        });
      }
      const bytes = await collectBody(response, context.signal);
      const pageText = normalizedPageText(bytes);
      const missingMarkers = spec.requiredMarkers.filter((marker) => !pageText.includes(marker));
      if (missingMarkers.length > 0) {
        throw oracleError(
          'SCHEMA_DRIFT',
          'Official ownership capability facts changed',
          'discover',
          { url: spec.url, missingMarkers },
        );
      }
      return Object.freeze({
        key: spec.key,
        url: spec.url,
        retrievedAt: context.clock.now(),
        lastModified: httpDateToIso(header(response.headers, 'last-modified')),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteSize: bytes.byteLength,
      });
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      const typed = oracleErrorSchema.safeParse(error);
      if (typed.success) {
        if (error instanceof Error) throw error;
        throw oracleError(
          typed.data.code,
          typed.data.message,
          typed.data.phase ?? 'discover',
          typed.data.details,
        );
      }
      if (attempt === context.ratePolicy.maxAttempts) {
        throw oracleError(
          'TRANSIENT_SOURCE',
          'Official capability discovery exhausted bounded retries',
          'discover',
          { url: spec.url, attempt },
        );
      }
      const backoff = Math.min(
        context.ratePolicy.maxBackoffMs,
        context.ratePolicy.initialBackoffMs * 2 ** (attempt - 1),
      );
      await context.delay.wait(backoff, context.signal);
    }
  }
  throw oracleError(
    'TRANSIENT_SOURCE',
    'Official capability discovery exhausted bounded retries',
    'discover',
  );
}

export class SantaClaraOwnershipTransferCapabilityAdapter implements SourceAdapter<
  OwnershipCapabilityDecodedRecord,
  OwnershipCapabilityValidatedRecord
> {
  public describe(): SourceDescriptor {
    return DESCRIPTOR;
  }

  public async inspectCapability(context: DiscoveryContext): Promise<OwnershipTransferCapability> {
    const lineage = await Promise.all(
      OWNERSHIP_CAPABILITY_PAGE_SPECS.map((spec) => fetchOfficialPage(spec, context)),
    );
    return createOwnershipTransferCapability({
      supportState: 'blocked',
      measuredAt: context.clock.now(),
      lineage,
    });
  }

  public async discover(context: DiscoveryContext): Promise<DiscoveryResult> {
    const capability = await this.inspectCapability(context);
    return Object.freeze({
      sourceId: OWNERSHIP_TRANSFER_SOURCE_ID,
      discoveredAt: context.clock.now(),
      resources: Object.freeze(
        capability.lineage.map((page) =>
          Object.freeze({
            requestKey: page.key,
            url: page.url,
            sourceAsOf:
              page.lastModified === null
                ? Object.freeze({
                    state: 'unknown' as const,
                    reason: 'Official page omitted Last-Modified',
                  })
                : Object.freeze({ state: 'reported' as const, at: page.lastModified }),
            expectedRecords: null,
            mediaTypes: Object.freeze(['text/html']),
            continuationToken: null,
          }),
        ),
      ),
      complete: false,
      limitations: capability.restrictions,
    });
  }

  public plan(
    request: AcquisitionRequest,
    discovery: DiscoveryResult,
    context: PlanningContext,
  ): Promise<AcquisitionPlan> {
    context.signal.throwIfAborted();
    if (
      request.sourceId !== OWNERSHIP_TRANSFER_SOURCE_ID ||
      discovery.sourceId !== request.sourceId
    ) {
      return Promise.reject(
        oracleError('RECONCILIATION', 'Ownership request/discovery source mismatch', 'plan'),
      );
    }
    return Promise.reject(
      oracleError(
        'TERMS_ACCESS',
        'Ownership index acquisition is blocked until an approved paid snapshot and explicit private-use rights are supplied',
        'plan',
        {
          supportState: 'blocked',
          capabilitySchemaFingerprint: OWNERSHIP_CAPABILITY_SCHEMA_FINGERPRINT,
        },
      ),
    );
  }

  public acquire(
    plan: AcquisitionPlan,
    checkpoint: SourceCheckpoint | undefined,
    context: AcquisitionContext,
  ): AsyncIterable<AcquiredByteArtifact> {
    void plan;
    void checkpoint;
    return rejectedAsyncIterable(context.signal, () =>
      oracleError(
        'TERMS_ACCESS',
        'A checkpoint cannot bypass the blocked ownership-source access and rights gate',
        'acquire',
      ),
    );
  }

  public decode(
    artifact: AcquiredByteArtifact,
    context: DecodeContext,
  ): AsyncIterable<OwnershipCapabilityDecodedRecord> {
    void artifact;
    return rejectedAsyncIterable(context.signal, () =>
      oracleError(
        'TERMS_ACCESS',
        'No approved owner-bearing snapshot is available to decode',
        'decode',
      ),
    );
  }

  public validate(
    record: OwnershipCapabilityDecodedRecord,
    context: ValidationContext,
  ): Promise<RecordValidation<OwnershipCapabilityValidatedRecord>> {
    context.signal.throwIfAborted();
    const issue: ValidationIssue = Object.freeze({
      code: 'BLOCKED_OWNERSHIP_CAPABILITY',
      severity: 'fatal',
      message: 'No owner-bearing record may enter validation before source approval',
      recordKey: record.recordKey,
      fieldPath: null,
    });
    return Promise.resolve(Object.freeze({ status: 'rejected', issues: Object.freeze([issue]) }));
  }

  public normalize(
    record: OwnershipCapabilityValidatedRecord,
    context: NormalizationContext,
  ): AsyncIterable<CanonicalMutation> {
    void record;
    return rejectedAsyncIterable(context.signal, () =>
      oracleError(
        'RESTRICTED_DATA_LEAK',
        'Blocked owner-bearing records cannot be normalized',
        'normalize',
      ),
    );
  }

  public summarize(run: SourceRunObservation, context: SummaryContext): SourceRunSummary {
    context.signal.throwIfAborted();
    if (run.mutations.length > 0 || run.acceptedRecords > 0) {
      throw oracleError(
        'RESTRICTED_DATA_LEAK',
        'Blocked ownership run unexpectedly produced accepted data',
        'summarize',
      );
    }
    return sourceRunSummarySchema.parse({
      sourceId: run.descriptor.sourceId,
      snapshotId: run.plan.snapshotId,
      runId: run.runId,
      contractVersion: run.descriptor.contractVersion,
      status: run.aborted ? 'aborted' : 'failed',
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      artifactsAcquired: run.artifacts.length,
      bytesAcquired: run.artifacts.reduce((total, artifact) => total + artifact.byteSize, 0),
      decodedRecords: run.decodedRecords,
      acceptedRecords: run.acceptedRecords,
      rejectedRecords: run.rejectedRecords,
      normalizedMutations: 0,
      visibilityCounts: { public: 0, authenticated: 0, restricted: 0, prohibited_public: 0 },
      warningCount: run.validationIssues.filter((issue) => issue.severity === 'warning').length,
      errorCount: run.validationIssues.filter((issue) => issue.severity !== 'warning').length,
      finalCheckpoint: run.finalCheckpoint,
    });
  }
}

export function createSantaClaraOwnershipTransferCapabilityAdapter(): SantaClaraOwnershipTransferCapabilityAdapter {
  return new SantaClaraOwnershipTransferCapabilityAdapter();
}

export const SANTA_CLARA_OWNERSHIP_TRANSFER_DESCRIPTOR = DESCRIPTOR;
export const OWNERSHIP_CAPABILITY_ACCEPT_HEADER_SHA256 = ACCEPT_HEADER_HASH;
