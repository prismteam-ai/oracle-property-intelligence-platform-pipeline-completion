import { createHash } from 'node:crypto';

import { createCheckpointEnvelope } from '@oracle/artifacts/checkpoint-store';
import type { CanonicalMutation } from '@oracle/contracts/canonical/mutation';
import { oracleErrorSchema } from '@oracle/contracts/errors';
import { snapshotIdSchema } from '@oracle/contracts/ids';
import {
  acquiredArtifactSchema,
  sourceDescriptorSchema,
  sourceRunSummarySchema,
  type AcquisitionPlan,
  type AcquisitionRequest,
  type SourceCheckpoint,
  type SourceDescriptor,
  type SourceRunSummary,
  type ValidationIssue,
} from '@oracle/contracts/source';

import {
  createAcquiredByteArtifact,
  type AcquiredByteArtifact,
} from '../../spi/acquired-artifact.js';
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
import { sha256Hex } from '../../spi/bytes.js';
import type { HttpHeaders } from '../../spi/http.js';
import { decodeGtfsZip, validateGtfsFeed } from './gtfs.js';
import { createCanonicalTransitMutations, normalizeTransitSnapshot } from './normalize.js';
import type { GtfsDecodedFeed, TransitFeedSnapshotConfig, ValidatedGtfsFeed } from './types.js';

const GTFS_SCHEMA_FINGERPRINT = createHash('sha256')
  .update('gtfs-static-v1|agency|stops|routes|trips|calendar|calendar_dates|stop_times|transfers?')
  .digest('hex');

function oracleFailure(input: unknown): Error {
  const parsed = oracleErrorSchema.parse(input);
  return Object.assign(new Error(parsed.message), parsed);
}

function header(headers: HttpHeaders, name: string): string | undefined {
  const target = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === target)?.[1];
}

function isoHttpDate(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

async function collectBody(body: AsyncIterable<Uint8Array>, signal: AbortSignal) {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of body) {
    signal.throwIfAborted();
    const copy = Uint8Array.from(chunk);
    chunks.push(copy);
    length += copy.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function checkpointFor(
  config: TransitFeedSnapshotConfig,
  snapshotId: string,
  requestKey: string,
  artifactId: string,
  updatedAt: string,
): SourceCheckpoint {
  return {
    sourceId: config.sourceId,
    snapshotId: snapshotId as SourceCheckpoint['snapshotId'],
    contractVersion: '1.0.0',
    cursor: 'complete',
    nextSequence: 1,
    completedRequestKeys: [requestKey],
    acquiredArtifactIds: [artifactId as SourceCheckpoint['acquiredArtifactIds'][number]],
    updatedAt,
    complete: true,
  };
}

function assertConfig(config: TransitFeedSnapshotConfig): void {
  if (!/^[a-f0-9]{64}$/u.test(config.expectedZipSha256)) {
    throw new TypeError('Expected ZIP SHA-256 must be lowercase hexadecimal');
  }
  if (config.expectedZipBytes !== null && config.expectedZipBytes < 1) {
    throw new TypeError('Expected ZIP byte count must be positive');
  }
  if (config.role === 'operator_primary' && config.requiresInjectedAuthorization) {
    throw new TypeError('A direct operator feed cannot require injected 511 authorization');
  }
  if (config.role === '511_fallback' && !config.requiresInjectedAuthorization) {
    throw new TypeError(
      'A 511 fallback must receive authorization only through injected transport',
    );
  }
  const url = new URL(config.url);
  const sensitiveParameters = ['api_key', 'key', 'token', 'access_token'];
  if (
    url.username !== '' ||
    url.password !== '' ||
    sensitiveParameters.some((name) => url.searchParams.has(name))
  ) {
    throw new TypeError('GTFS URLs must not embed credentials; inject authorization in transport');
  }
}

export class StaticGtfsAdapter implements SourceAdapter<GtfsDecodedFeed, ValidatedGtfsFeed> {
  readonly #config: TransitFeedSnapshotConfig;
  readonly #descriptor: SourceDescriptor;
  readonly #snapshotId: AcquisitionRequest['snapshotId'];

  public constructor(config: TransitFeedSnapshotConfig) {
    assertConfig(config);
    this.#config = Object.freeze({ ...config });
    this.#snapshotId = snapshotIdSchema.parse(
      `sc:snapshot:${config.sourceId.replace('sc:source:', '')}:${config.expectedZipSha256}`,
    );
    this.#descriptor = sourceDescriptorSchema.parse({
      sourceId: config.sourceId,
      contractVersion: '1.0.0',
      name: config.sourceName,
      authority: {
        authorityType: 'official_government',
        organization:
          config.role === 'operator_primary'
            ? config.agencyName
            : 'Metropolitan Transportation Commission',
        jurisdiction: 'San Francisco Bay Area, California',
        canonicalUrl:
          config.role === 'operator_primary' ? config.url : 'https://511.org/open-data/transit',
        authorityRank: config.role === 'operator_primary' ? 1 : 20,
      },
      acquisitionMethod: 'static_artifact',
      encodings: ['zip', 'csv'],
      entityKinds: ['transit-stop', 'transit-service'],
      defaultVisibility: config.visibility,
      license: config.license,
      ratePolicy: config.ratePolicy,
      freshnessSemantics: `Pinned static GTFS feed ${config.feedStartDate} through ${config.feedEndDate}; selected service date ${config.selectedServiceDate}.`,
    });
  }

  public describe(): SourceDescriptor {
    return this.#descriptor;
  }

  public async discover(context: DiscoveryContext): Promise<DiscoveryResult> {
    context.signal.throwIfAborted();
    return Promise.resolve(
      Object.freeze({
        sourceId: this.#config.sourceId,
        discoveredAt: context.clock.now(),
        resources: Object.freeze([
          Object.freeze({
            requestKey: `${this.#config.operator}-${this.#config.role}-gtfs`,
            url: this.#config.url,
            sourceAsOf: this.#config.sourceAsOf,
            expectedRecords: null,
            mediaTypes: Object.freeze(['application/zip', 'application/octet-stream']),
            continuationToken: null,
          }),
        ]),
        complete: true,
        limitations: Object.freeze(
          this.#config.role === '511_fallback'
            ? [
                '511 requires authorization injected by the operator transport and is never the sole dependency.',
              ]
            : [],
        ),
      }),
    );
  }

  public async plan(
    request: AcquisitionRequest,
    discovery: DiscoveryResult,
    context: PlanningContext,
  ): Promise<AcquisitionPlan> {
    context.signal.throwIfAborted();
    if (request.sourceId !== this.#config.sourceId || discovery.sourceId !== request.sourceId) {
      throw new TypeError('GTFS request/discovery source mismatch');
    }
    if (request.snapshotId !== this.#snapshotId) {
      throw new TypeError('GTFS request snapshot ID must bind the frozen ZIP SHA-256');
    }
    const resource = discovery.resources[0];
    if (resource === undefined) throw new Error('GTFS discovery did not produce a resource');
    return Promise.resolve({
      sourceId: request.sourceId,
      snapshotId: request.snapshotId,
      contractVersion: '1.0.0',
      plannedAt: context.clock.now(),
      items: [
        {
          requestKey: resource.requestKey,
          sequence: 0,
          method: 'GET',
          url: resource.url,
          encoding: 'zip',
          expectedMediaTypes: [...resource.mediaTypes],
        },
      ],
    });
  }

  public async *acquire(
    plan: AcquisitionPlan,
    checkpoint: SourceCheckpoint | undefined,
    context: AcquisitionContext,
  ): AsyncIterable<AcquiredByteArtifact> {
    context.signal.throwIfAborted();
    if (plan.sourceId !== this.#config.sourceId || plan.snapshotId !== this.#snapshotId) {
      throw new TypeError('GTFS acquisition source/snapshot mismatch');
    }
    const onlyItem = plan.items[0];
    if (
      onlyItem === undefined ||
      plan.items.length !== 1 ||
      onlyItem.url !== this.#config.url ||
      onlyItem.method !== 'GET' ||
      onlyItem.encoding !== 'zip'
    ) {
      throw new TypeError('GTFS acquisition plan does not match the frozen source resource');
    }
    if (
      checkpoint !== undefined &&
      (checkpoint.sourceId !== plan.sourceId || checkpoint.snapshotId !== plan.snapshotId)
    ) {
      throw new TypeError('GTFS checkpoint does not belong to the acquisition plan');
    }
    for (const item of [...plan.items].sort((left, right) => left.sequence - right.sequence)) {
      if (
        (checkpoint?.completedRequestKeys.includes(item.requestKey) ?? false) ||
        item.sequence < (checkpoint?.nextSequence ?? 0)
      ) {
        continue;
      }
      context.signal.throwIfAborted();
      const response = await context.http.send(
        { method: item.method, url: item.url, headers: Object.freeze({}) },
        context.signal,
      );
      if (response.status === 429) {
        const rawRetryAfter = header(response.headers, 'retry-after');
        const retryAfterSeconds = rawRetryAfter === undefined ? undefined : Number(rawRetryAfter);
        throw oracleFailure({
          code: 'TRANSIENT_SOURCE',
          retryable: true,
          message: 'GTFS source rate limit exceeded',
          sourceId: this.#config.sourceId,
          phase: 'acquire',
          details: {
            httpStatus: 429,
            retryAfterMs:
              retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)
                ? retryAfterSeconds * 1000
                : null,
          },
        });
      }
      if (response.status === 401 || response.status === 403) {
        throw oracleFailure({
          code: response.status === 401 ? 'AUTHENTICATION' : 'TERMS_ACCESS',
          retryable: false,
          message: `GTFS source returned HTTP ${response.status}`,
          sourceId: this.#config.sourceId,
          phase: 'acquire',
        });
      }
      if (response.status < 200 || response.status >= 300) {
        throw oracleFailure({
          code: response.status >= 500 ? 'TRANSIENT_SOURCE' : 'RECORD_QUALITY',
          retryable: response.status >= 500,
          message: `GTFS source returned HTTP ${response.status}`,
          sourceId: this.#config.sourceId,
          phase: 'acquire',
          details: { httpStatus: response.status },
        });
      }

      const bytes = await collectBody(response.body, context.signal);
      const sha256 = sha256Hex(bytes);
      if (
        sha256 !== this.#config.expectedZipSha256 ||
        (this.#config.expectedZipBytes !== null &&
          bytes.byteLength !== this.#config.expectedZipBytes)
      ) {
        throw oracleFailure({
          code: 'SCHEMA_DRIFT',
          retryable: false,
          message: 'Downloaded GTFS ZIP does not match the frozen snapshot bytes',
          sourceId: this.#config.sourceId,
          phase: 'acquire',
          details: { expectedSha256: this.#config.expectedZipSha256, actualSha256: sha256 },
        });
      }
      const artifactId = `sc:artifact:sha256:${sha256}`;
      const stored = await context.artifactStore.putImmutable({
        logicalKey: `raw/${this.#config.sourceId}/${sha256}.zip`,
        mediaType: 'application/zip',
        body: bytes,
        expectedSha256: sha256,
        metadata: Object.freeze({ sourceId: this.#config.sourceId, requestKey: item.requestKey }),
        ifAbsent: true,
      });
      const retrievedAt = context.clock.now();
      const metadata = acquiredArtifactSchema.parse({
        artifactId,
        sourceId: this.#config.sourceId,
        snapshotId: plan.snapshotId,
        retrievedAt,
        sourceAsOf: this.#config.sourceAsOf,
        request: {
          requestKey: item.requestKey,
          method: item.method,
          url: item.url,
          headers: [],
          bodySha256: null,
          attempt: 1,
        },
        response: {
          httpStatus: response.status,
          etag: header(response.headers, 'etag') ?? null,
          lastModified: isoHttpDate(header(response.headers, 'last-modified')),
          finalUrl: item.url,
        },
        mediaType: header(response.headers, 'content-type')?.split(';')[0] ?? 'application/zip',
        encoding: 'zip',
        byteSize: bytes.byteLength,
        sha256,
        schemaFingerprint: {
          algorithm: 'sha256',
          value: GTFS_SCHEMA_FINGERPRINT,
          schemaName: 'gtfs-static-v1',
          canonicalizationVersion: '1.0.0',
        },
        rawUri: stored.uri,
        licenseSnapshotRef: this.#config.license.licenseSnapshotId,
        visibility: this.#config.visibility,
      });
      const nextCheckpoint = checkpointFor(
        this.#config,
        plan.snapshotId,
        item.requestKey,
        artifactId,
        retrievedAt,
      );
      const scope = `${this.#config.sourceId}|${plan.snapshotId}`;
      const current = await context.checkpointStore.load(scope);
      const envelope = createCheckpointEnvelope({
        scope,
        previousRevision: current?.revision ?? null,
        writtenAt: retrievedAt,
        payload: nextCheckpoint,
      });
      const committed = await context.checkpointStore.commit({
        expectedRevision: current?.revision ?? null,
        checkpoint: envelope,
      });
      if (committed.status === 'conflict') throw new Error(`Checkpoint conflict for ${scope}`);
      yield createAcquiredByteArtifact(metadata, bytes);
    }
  }

  public async *decode(
    artifact: AcquiredByteArtifact,
    context: DecodeContext,
  ): AsyncIterable<GtfsDecodedFeed> {
    context.signal.throwIfAborted();
    await Promise.resolve();
    yield decodeGtfsZip(artifact);
  }

  public async validate(
    record: GtfsDecodedFeed,
    context: ValidationContext,
  ): Promise<RecordValidation<ValidatedGtfsFeed>> {
    context.signal.throwIfAborted();
    const result = validateGtfsFeed(record);
    const issues: ValidationIssue[] = [...result.issues];
    const agency = result.validated?.agency.find(
      (row) => (row.agency_id ?? '') === this.#config.agencyId,
    );
    if (result.validated !== undefined && agency === undefined) {
      issues.push({
        code: 'gtfs.agency_identity_mismatch',
        severity: 'fatal',
        message: `Expected agency ${this.#config.agencyId} is absent`,
        recordKey: this.#config.agencyId,
        fieldPath: 'agency_id',
      });
    }
    if (result.validated === undefined || issues.some((issue) => issue.severity !== 'warning')) {
      return Promise.resolve(Object.freeze({ status: 'rejected', issues: Object.freeze(issues) }));
    }
    return Promise.resolve(
      Object.freeze({
        status: 'accepted',
        record: result.validated,
        issues: Object.freeze(issues),
      }),
    );
  }

  public async *normalize(
    record: ValidatedGtfsFeed,
    context: NormalizationContext,
  ): AsyncIterable<CanonicalMutation> {
    context.signal.throwIfAborted();
    await Promise.resolve();
    const snapshot = normalizeTransitSnapshot(record, this.#config);
    for (const mutation of createCanonicalTransitMutations(record, snapshot, this.#config)) {
      context.signal.throwIfAborted();
      yield mutation;
    }
  }

  public summarize(run: SourceRunObservation, context: SummaryContext): SourceRunSummary {
    context.signal.throwIfAborted();
    const status = run.aborted
      ? 'aborted'
      : run.rejectedRecords > 0
        ? run.acceptedRecords > 0
          ? 'partial'
          : 'failed'
        : 'succeeded';
    const visibilityCounts = {
      public: 0,
      authenticated: 0,
      restricted: 0,
      prohibited_public: 0,
    };
    for (const mutation of run.mutations) visibilityCounts[mutation.visibility] += 1;
    return sourceRunSummarySchema.parse({
      sourceId: run.descriptor.sourceId,
      snapshotId: run.request.snapshotId,
      runId: run.runId,
      contractVersion: run.descriptor.contractVersion,
      status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      artifactsAcquired: run.artifacts.length,
      bytesAcquired: run.artifacts.reduce((total, artifact) => total + artifact.byteSize, 0),
      decodedRecords: run.decodedRecords,
      acceptedRecords: run.acceptedRecords,
      rejectedRecords: run.rejectedRecords,
      normalizedMutations: run.mutations.length,
      visibilityCounts,
      warningCount: run.validationIssues.filter((issue) => issue.severity === 'warning').length,
      errorCount: run.validationIssues.filter((issue) => issue.severity !== 'warning').length,
      finalCheckpoint: run.finalCheckpoint,
    });
  }
}

export function createStaticGtfsAdapter(config: TransitFeedSnapshotConfig): StaticGtfsAdapter {
  return new StaticGtfsAdapter(config);
}
