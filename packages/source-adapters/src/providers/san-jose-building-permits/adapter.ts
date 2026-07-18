import { createHash } from 'node:crypto';
import { once } from 'node:events';

import type { StoredArtifact } from '@oracle/artifacts/artifact-store';
import { createCheckpointEnvelope, type CheckpointValue } from '@oracle/artifacts/checkpoint-store';
import {
  canonicalMutationSchema,
  type CanonicalMutation,
} from '@oracle/contracts/canonical/mutation';
import {
  fieldLineageSchema,
  type FieldLineage,
  type SourceRecordReference,
} from '@oracle/contracts/canonical/lineage';
import { oracleErrorSchema, type OracleError } from '@oracle/contracts/errors';
import {
  artifactIdSchema,
  entityIdSchemaFor,
  mutationIdSchema,
  observationIdSchema,
  schemaFingerprintValueSchema,
} from '@oracle/contracts/ids';
import {
  acquiredArtifactSchema,
  acquisitionPlanSchema,
  sourceCheckpointSchema,
  sourceDescriptorSchema,
  sourceRunSummarySchema,
  type AcquisitionPlan,
  type AcquisitionRequest,
  type AcquiredArtifact,
  type SourceAsOf,
  type SourceCheckpoint,
  type SourceDescriptor,
  type SourceRunSummary,
  type ValidationIssue,
} from '@oracle/contracts/source';
import type { Visibility } from '@oracle/contracts/visibility';
import { parse } from 'csv-parse';

import {
  type DiscoveryContext,
  type DiscoveryResult,
  type NormalizationContext,
  type PlanningContext,
  type RecordValidation,
  type SourceRunObservationV2,
  type StreamingAcquisitionContext,
  type StreamingDecodeContext,
  type StreamingSourceAdapter,
  type SummaryContext,
  type ValidationContext,
} from '../../spi/adapter.js';
import {
  createStreamingAcquiredArtifact,
  LegacyWholeCopyLimitError,
  LEGACY_WHOLE_COPY_MAX_BYTES,
  type AcquiredArtifactSource,
} from '../../spi/acquired-artifact.js';
import { persistAcquiredBody } from '../../spi/acquisition.js';
import { sha256Hex } from '../../spi/bytes.js';
import type { HttpHeaders, HttpResponse } from '../../spi/http.js';
import {
  SAN_JOSE_BUILDING_PERMIT_LICENSE_ID,
  SAN_JOSE_BUILDING_PERMIT_SOURCE_ID,
  SAN_JOSE_CSV_HEADER,
  SAN_JOSE_FEED_CONFIG,
  SAN_JOSE_FEEDS,
  SAN_JOSE_SCHEMA_FINGERPRINT,
  isSanJosePermitFeed,
  sanJoseCsvUrl,
  sanJosePackageMetadataUrl,
  type SanJosePermitFeed,
} from './constants.js';
import type {
  PermitTextClassification,
  SanJoseBuildingPermitAdapterOptions,
  SanJoseBuildingPermitSummary,
  SanJoseDecodedPermitRecord,
  SanJoseFeedSnapshotSummary,
  SanJoseValidatedPermitRecord,
} from './types.js';

const CONTRACT_VERSION = '2.0.0';
const TRANSFORM_VERSION = '1.0.0';
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const CSV_STREAM_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAXIMUM_RECORD_BYTES = 1024 * 1024;
const ACCEPT_CSV_HASH = sha256Hex(new TextEncoder().encode('text/csv'));
const ACCEPT_JSON_HASH = sha256Hex(new TextEncoder().encode('application/json'));
const SCHEMA_FINGERPRINT_VALUE = schemaFingerprintValueSchema.parse(SAN_JOSE_SCHEMA_FINGERPRINT);
const permitIdSchema = entityIdSchemaFor('permit');

const DESCRIPTOR: SourceDescriptor = sourceDescriptorSchema.parse({
  sourceId: SAN_JOSE_BUILDING_PERMIT_SOURCE_ID,
  contractVersion: CONTRACT_VERSION,
  name: 'City of San Jose building permits (active, expired, and under inspection)',
  authority: {
    authorityType: 'official_government',
    organization: 'City of San Jose',
    jurisdiction: 'City of San Jose, California',
    canonicalUrl: 'https://data.sanjoseca.gov/',
    authorityRank: 10,
  },
  acquisitionMethod: 'bulk_download',
  encodings: ['csv'],
  entityKinds: ['permit'],
  defaultVisibility: 'public',
  license: {
    licenseSnapshotId: SAN_JOSE_BUILDING_PERMIT_LICENSE_ID,
    capturedAt: '2026-07-17T13:05:19.550Z',
    title: 'Creative Commons CCZero 1.0 Universal',
    canonicalUrl: 'https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt',
    termsSha256: 'a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499',
    redistribution: 'approved',
    containsPersonalData: true,
    attribution: ['City of San Jose Open Data'],
    limitations: [
      'Free-form applicant, owner, and contractor text can contain personal names.',
      'Permit owner text is permit evidence and is not evidence of current ownership.',
    ],
  },
  ratePolicy: {
    maxRequestsPerWindow: 1,
    windowMs: 1_000,
    maxConcurrency: 1,
    maxAttempts: 4,
    initialBackoffMs: 500,
    maxBackoffMs: 8_000,
    jitter: 'full',
    respectRetryAfter: true,
  },
  freshnessSemantics:
    'Each feed is a separately modified full CSV snapshot; source-as-of is its official CKAN resource modification time and final downloaded row count.',
});

interface PackageMetadata {
  readonly resourceUrl: string;
  readonly modifiedAt: string;
}

interface CsvRow {
  readonly header: readonly string[];
  readonly values: readonly string[];
}

function hashParts(...parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.entries(record)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  throw new TypeError('Unsupported canonical JSON value');
}

function headerValue(headers: HttpHeaders, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === wanted)?.[1];
}

function httpDateToIso(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function metadataDateToIso(value: string): string {
  const timestamp = Date.parse(/[zZ]|[+-]\d\d:\d\d$/u.test(value) ? value : `${value}Z`);
  if (!Number.isFinite(timestamp)) {
    throw oracleError(
      'SCHEMA_DRIFT',
      `Invalid official modification timestamp: ${value}`,
      'discover',
    );
  }
  return new Date(timestamp).toISOString();
}

function oracleError(
  code: OracleError['code'],
  message: string,
  phase: string,
  details?: Readonly<Record<string, unknown>>,
): Error & OracleError {
  const common: Readonly<Record<string, unknown>> = {
    code,
    retryable: code === 'TRANSIENT_SOURCE',
    message,
    sourceId: SAN_JOSE_BUILDING_PERMIT_SOURCE_ID,
    phase,
  };
  const parsed = oracleErrorSchema.parse(details === undefined ? common : { ...common, details });
  return Object.assign(new Error(message), parsed);
}

function parseRetryAfter(headers: HttpHeaders, now: string): number | undefined {
  const raw = headerValue(headers, 'retry-after');
  if (raw === undefined) {
    return undefined;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }
  const at = Date.parse(raw);
  const current = Date.parse(now);
  return Number.isFinite(at) && Number.isFinite(current) ? Math.max(0, at - current) : undefined;
}

function deterministicBackoff(
  requestKey: string,
  attempt: number,
  policy: DiscoveryContext['ratePolicy'],
): number {
  const exponential = Math.min(
    policy.maxBackoffMs,
    policy.initialBackoffMs * 2 ** Math.max(0, attempt - 1),
  );
  if (policy.jitter === 'none') {
    return exponential;
  }
  const sample = Number.parseInt(hashParts(requestKey, String(attempt)).slice(0, 8), 16);
  return sample % (exponential + 1);
}

async function requestWithRetry(
  context: DiscoveryContext | StreamingAcquisitionContext,
  requestKey: string,
  url: string,
  accept: string,
  phase: 'acquire' | 'discover',
): Promise<Readonly<{ response: HttpResponse; attempt: number }>> {
  for (let attempt = 1; attempt <= context.ratePolicy.maxAttempts; attempt += 1) {
    context.signal.throwIfAborted();
    let response: HttpResponse;
    try {
      response = await context.http.send(
        { method: 'GET', url, headers: Object.freeze({ accept }) },
        context.signal,
      );
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      if (attempt === context.ratePolicy.maxAttempts) {
        throw oracleError('TRANSIENT_SOURCE', `Transport failed for ${requestKey}`, phase, {
          attempt,
        });
      }
      await context.delay.wait(
        deterministicBackoff(requestKey, attempt, context.ratePolicy),
        context.signal,
      );
      continue;
    }

    if (response.status >= 200 && response.status < 300) {
      return Object.freeze({ response, attempt });
    }
    if (response.status === 401) {
      throw oracleError('AUTHENTICATION', `Official source returned 401 for ${requestKey}`, phase);
    }
    if (response.status === 403) {
      throw oracleError('TERMS_ACCESS', `Official source returned 403 for ${requestKey}`, phase);
    }
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      if (attempt === context.ratePolicy.maxAttempts) {
        throw oracleError(
          'TRANSIENT_SOURCE',
          `Retry budget exhausted for ${requestKey} after HTTP ${response.status}`,
          phase,
          { attempt, status: response.status },
        );
      }
      const retryAfter = context.ratePolicy.respectRetryAfter
        ? parseRetryAfter(response.headers, context.clock.now())
        : undefined;
      await context.delay.wait(
        retryAfter ?? deterministicBackoff(requestKey, attempt, context.ratePolicy),
        context.signal,
      );
      continue;
    }
    throw oracleError(
      'RECORD_QUALITY',
      `Unexpected HTTP ${response.status} for ${requestKey}`,
      phase,
    );
  }
  throw new Error('Unreachable retry loop');
}

async function collectBody(
  response: HttpResponse,
  signal: AbortSignal,
  maximumBytes = Number.POSITIVE_INFINITY,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw oracleError('SCHEMA_DRIFT', 'Discovery response byte ceiling is invalid', 'discover');
  }
  const bytes = new Uint8Array(maximumBytes);
  let total = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    total += chunk.byteLength;
    if (total > maximumBytes) {
      throw oracleError('SCHEMA_DRIFT', `Response exceeded ${maximumBytes} bytes`, 'discover');
    }
    bytes.set(chunk, total - chunk.byteLength);
  }
  return bytes.slice(0, total);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

function parsePackageMetadata(bytes: Uint8Array, feed: SanJosePermitFeed): PackageMetadata {
  let root: unknown;
  try {
    root = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw oracleError('SCHEMA_DRIFT', `Invalid UTF-8/JSON metadata for ${feed}`, 'discover');
  }
  const config = SAN_JOSE_FEED_CONFIG[feed];
  if (!isRecord(root) || root.success !== true || !isRecord(root.result)) {
    throw oracleError('SCHEMA_DRIFT', `Unexpected CKAN envelope for ${feed}`, 'discover');
  }
  const result = root.result;
  if (result.id !== config.datasetId || result.license_id !== 'cc-zero') {
    throw oracleError(
      'SCHEMA_DRIFT',
      `Dataset identity or CC0 license changed for ${feed}`,
      'discover',
    );
  }
  if (!Array.isArray(result.resources)) {
    throw oracleError('SCHEMA_DRIFT', `Missing CKAN resources for ${feed}`, 'discover');
  }
  const resources = result.resources as unknown[];
  const resource = resources.find(
    (candidate) => isRecord(candidate) && candidate.id === config.resourceId,
  );
  if (!isRecord(resource) || typeof resource.url !== 'string') {
    throw oracleError('SCHEMA_DRIFT', `Official CSV resource is missing for ${feed}`, 'discover');
  }
  const expectedUrl = sanJoseCsvUrl(feed);
  if (resource.url !== expectedUrl) {
    throw oracleError('SCHEMA_DRIFT', `Official CSV URL changed for ${feed}`, 'discover', {
      expectedUrl,
      observedUrl: resource.url,
    });
  }
  const modified =
    typeof resource.last_modified === 'string'
      ? resource.last_modified
      : typeof result.metadata_modified === 'string'
        ? result.metadata_modified
        : undefined;
  if (modified === undefined) {
    throw oracleError('SCHEMA_DRIFT', `Missing resource modification time for ${feed}`, 'discover');
  }
  return Object.freeze({ resourceUrl: resource.url, modifiedAt: metadataDateToIso(modified) });
}

function feedForArtifact(artifact: AcquiredArtifactSource): SanJosePermitFeed {
  const requestKey = artifact.metadata.request.requestKey;
  if (!isSanJosePermitFeed(requestKey)) {
    throw oracleError('SCHEMA_DRIFT', `Unknown San Jose feed key: ${requestKey}`, 'decode');
  }
  return requestKey;
}

function assertHeader(actual: readonly string[], feed: SanJosePermitFeed): void {
  if (
    actual.length !== SAN_JOSE_CSV_HEADER.length ||
    actual.some((name, index) => name !== SAN_JOSE_CSV_HEADER[index])
  ) {
    throw oracleError('SCHEMA_DRIFT', `CSV header changed for ${feed}`, 'decode', {
      expected: SAN_JOSE_CSV_HEADER,
      observed: actual,
    });
  }
}

async function* csvRecords(
  chunks: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  feed: SanJosePermitFeed,
  maximumRecordBytes: number,
): AsyncIterable<CsvRow> {
  const parser = parse({
    bom: true,
    columns: false,
    encoding: 'utf8',
    relax_column_count: false,
    skip_empty_lines: true,
    max_record_size: maximumRecordBytes,
  });
  const pumping = Promise.resolve().then(async () => {
    try {
      for await (const text of validatedUtf8Chunks(chunks, signal)) {
        if (!parser.write(text)) await once(parser, 'drain');
      }
      parser.end();
    } catch (error: unknown) {
      parser.destroy(error instanceof Error ? error : new Error('CSV input stream failed'));
    }
  });
  let header: readonly string[] | undefined;
  try {
    for await (const parsedCandidate of parser) {
      const candidate: unknown = parsedCandidate;
      signal.throwIfAborted();
      if (!isStringArray(candidate)) {
        throw oracleError('RECORD_QUALITY', 'CSV parser emitted a non-string row', 'decode');
      }
      const row = Object.freeze([...candidate]);
      if (header === undefined) {
        header = row;
        assertHeader(header, feed);
        continue;
      }
      yield Object.freeze({ header, values: row });
    }
  } catch (error: unknown) {
    if (!parser.destroyed) parser.destroy();
    await pumping.catch(() => undefined);
    if (isRecord(error) && typeof error.code === 'string' && error.code.startsWith('CSV_')) {
      throw oracleError('RECORD_QUALITY', `Malformed CSV: ${error.code}`, 'decode');
    }
    throw error instanceof Error
      ? error
      : new Error('Unknown CSV decoding failure', { cause: error });
  }
  await pumping;
  if (header === undefined) {
    throw oracleError('SCHEMA_DRIFT', 'CSV snapshot has no header', 'decode');
  }
}

async function countAndValidateCsv(
  chunks: AsyncIterable<Uint8Array>,
  feed: SanJosePermitFeed,
  signal: AbortSignal,
  maximumRecordBytes: number,
): Promise<number> {
  let count = 0;
  for await (const row of csvRecords(chunks, signal, feed, maximumRecordBytes)) {
    void row;
    count += 1;
  }
  return count;
}

async function* validatedUtf8Chunks(
  chunks: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for await (const chunk of chunks) {
      signal.throwIfAborted();
      for (let offset = 0; offset < chunk.byteLength; offset += CSV_STREAM_CHUNK_BYTES) {
        const text = decoder.decode(
          chunk.subarray(offset, Math.min(chunk.byteLength, offset + CSV_STREAM_CHUNK_BYTES)),
          { stream: true },
        );
        if (text.length > 0) yield text;
      }
    }
    const final = decoder.decode();
    if (final.length > 0) yield final;
  } catch (error: unknown) {
    if (signal.aborted) throw signal.reason;
    throw oracleError('RECORD_QUALITY', 'Snapshot is not valid UTF-8', 'decode', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function sourceAsOfFromArtifact(metadata: AcquiredArtifact): SourceAsOf {
  const lastModified = metadata.response.lastModified;
  return lastModified === null
    ? Object.freeze({ state: 'unknown', reason: 'Official response omitted Last-Modified' })
    : Object.freeze({ state: 'reported', at: lastModified });
}

function artifactRead(artifact: AcquiredArtifactSource): AsyncIterable<Uint8Array> {
  if (artifact.content !== undefined) {
    return artifact.content.read({ maxChunkBytes: CSV_STREAM_CHUNK_BYTES });
  }
  if (artifact.bytes.byteLength > LEGACY_WHOLE_COPY_MAX_BYTES) {
    throw new LegacyWholeCopyLimitError(artifact.bytes.byteLength, LEGACY_WHOLE_COPY_MAX_BYTES);
  }
  return (async function* legacyFixture() {
    await Promise.resolve();
    yield artifact.bytes.copy();
  })();
}

function acquiredMetadataFromStored(
  plan: AcquisitionPlan,
  item: AcquisitionPlan['items'][number],
  stored: StoredArtifact,
): AcquiredArtifact {
  const metadata = stored.metadata;
  const attempt = Number(metadata.attempt);
  const httpStatus = Number(metadata.httpStatus);
  if (
    metadata.sourceId !== plan.sourceId ||
    metadata.snapshotId !== plan.snapshotId ||
    metadata.requestKey !== item.requestKey ||
    metadata.sourceUrl !== item.url ||
    metadata.retrievedAt === undefined ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    !Number.isSafeInteger(httpStatus) ||
    httpStatus < 200 ||
    httpStatus >= 300 ||
    !item.expectedMediaTypes.includes(stored.mediaType)
  ) {
    throw oracleError(
      'RECONCILIATION',
      'Recovered permit artifact metadata is invalid',
      'acquire',
      {
        requestKey: item.requestKey,
      },
    );
  }
  const lastModified = metadata.lastModified === '' ? null : httpDateToIso(metadata.lastModified);
  if (metadata.lastModified !== '' && lastModified === null) {
    throw oracleError('RECONCILIATION', 'Recovered Last-Modified metadata is invalid', 'acquire');
  }
  return acquiredArtifactSchema.parse({
    artifactId: artifactIdSchema.parse(`sc:artifact:sha256:${stored.sha256}`),
    sourceId: SAN_JOSE_BUILDING_PERMIT_SOURCE_ID,
    snapshotId: plan.snapshotId,
    retrievedAt: metadata.retrievedAt,
    sourceAsOf:
      lastModified === null
        ? { state: 'unknown', reason: 'Official response omitted Last-Modified' }
        : { state: 'reported', at: lastModified },
    request: {
      requestKey: item.requestKey,
      method: 'GET',
      url: item.url,
      headers: [{ name: 'accept', valueSha256: ACCEPT_CSV_HASH }],
      bodySha256: null,
      attempt,
    },
    response: {
      httpStatus,
      etag: metadata.etag === '' ? null : metadata.etag,
      lastModified,
      finalUrl: metadata.finalUrl ?? item.url,
    },
    mediaType: stored.mediaType,
    encoding: 'csv',
    byteSize: stored.byteSize,
    sha256: stored.sha256,
    schemaFingerprint: {
      algorithm: 'sha256',
      value: SCHEMA_FINGERPRINT_VALUE,
      schemaName: 'city-of-san-jose-building-permits-v1',
      canonicalizationVersion: CONTRACT_VERSION,
    },
    rawUri: stored.uri,
    licenseSnapshotRef: SAN_JOSE_BUILDING_PERMIT_LICENSE_ID,
    visibility: 'public',
  });
}

function checkpointPayload(
  checkpoint: SourceCheckpoint,
): Readonly<Record<string, CheckpointValue>> {
  return Object.freeze({
    sourceId: checkpoint.sourceId,
    snapshotId: checkpoint.snapshotId,
    contractVersion: checkpoint.contractVersion,
    cursor: checkpoint.cursor,
    nextSequence: checkpoint.nextSequence,
    completedRequestKeys: checkpoint.completedRequestKeys,
    acquiredArtifactIds: checkpoint.acquiredArtifactIds,
    updatedAt: checkpoint.updatedAt,
    complete: checkpoint.complete,
  });
}

function createSourceCheckpoint(
  plan: AcquisitionPlan,
  nextSequence: number,
  completedRequestKeys: readonly string[],
  artifactIds: readonly AcquiredArtifact['artifactId'][],
  updatedAt: string,
): SourceCheckpoint {
  return sourceCheckpointSchema.parse({
    sourceId: plan.sourceId,
    snapshotId: plan.snapshotId,
    contractVersion: plan.contractVersion,
    cursor: `sequence:${nextSequence}`,
    nextSequence,
    completedRequestKeys: [...completedRequestKeys],
    acquiredArtifactIds: [...artifactIds],
    updatedAt,
    complete: nextSequence >= plan.items.length,
  });
}

function checkpointForPlan(
  plan: AcquisitionPlan,
  candidate: unknown,
  origin: 'caller' | 'store',
): SourceCheckpoint {
  const parsed = sourceCheckpointSchema.safeParse(candidate);
  if (!parsed.success) {
    throw oracleError('SCHEMA_DRIFT', `Invalid ${origin} checkpoint payload`, 'acquire', {
      issueCount: parsed.error.issues.length,
    });
  }
  const checkpoint = parsed.data;
  if (
    checkpoint.sourceId !== plan.sourceId ||
    checkpoint.snapshotId !== plan.snapshotId ||
    checkpoint.contractVersion !== plan.contractVersion
  ) {
    throw oracleError(
      'SCHEMA_DRIFT',
      `${origin} checkpoint does not belong to this plan`,
      'acquire',
    );
  }
  if (checkpoint.nextSequence > plan.items.length) {
    throw oracleError('SCHEMA_DRIFT', `${origin} checkpoint sequence exceeds the plan`, 'acquire');
  }
  return checkpoint;
}

function checkpointsEqual(left: SourceCheckpoint, right: SourceCheckpoint): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function normalizeApn(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const compact = trimmed.replace(/[\s-]/gu, '');
  return /^\d{8}$/u.test(compact) ? compact : null;
}

function parseSourceLocalDate(raw: string): string | null | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/u.exec(trimmed);
  if (match === null) {
    return undefined;
  }
  const [, monthRaw, dayRaw, yearRaw, hourRaw, minuteRaw, secondRaw, meridiem] = match;
  if (
    monthRaw === undefined ||
    dayRaw === undefined ||
    yearRaw === undefined ||
    hourRaw === undefined ||
    minuteRaw === undefined ||
    secondRaw === undefined ||
    meridiem === undefined
  ) {
    return undefined;
  }
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const year = Number(yearRaw);
  const hour12 = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour12 < 1 ||
    hour12 > 12 ||
    minute > 59 ||
    second > 59
  ) {
    return undefined;
  }
  const hour = (hour12 % 12) + (meridiem === 'PM' ? 12 : 0);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  });
  for (const offsetHours of [7, 8]) {
    const candidate = new Date(Date.UTC(year, month - 1, day, hour + offsetHours, minute, second));
    const parts = Object.fromEntries(
      formatter
        .formatToParts(candidate)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)]),
    );
    if (
      parts.year === year &&
      parts.month === month &&
      parts.day === day &&
      parts.hour === hour &&
      parts.minute === minute &&
      parts.second === second
    ) {
      return candidate.toISOString();
    }
  }
  return undefined;
}

function parseValuation(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const normalized = trimmed.replace(/[$,]/gu, '');
  if (!/^\d+(?:\.\d{1,2})?$/u.test(normalized)) {
    return undefined;
  }
  const value = Number(normalized);
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    ? value
    : undefined;
}

function classifyText(
  field: 'applicant' | 'contractor' | 'owner',
  raw: string,
): PermitTextClassification {
  const text = raw.trim();
  if (text.length === 0 || ['NONE', 'N/A', 'UNKNOWN'].includes(text.toUpperCase())) {
    return Object.freeze({ classification: 'missing_or_placeholder', text: null });
  }
  const limitations = {
    applicant: 'Free-form permit applicant evidence; not a verified party identity.',
    contractor: 'Free-form permit contractor evidence; requires later CSLB reconciliation.',
    owner: 'Permit owner text only; never evidence of current ownership.',
  } as const;
  return Object.freeze({
    classification: `permit_${field}_text`,
    text,
    limitation: limitations[field],
  });
}

function rowObject(values: readonly string[]): SanJoseValidatedPermitRecord['raw'] {
  return Object.freeze(
    Object.fromEntries(SAN_JOSE_CSV_HEADER.map((name, index) => [name, values[index] ?? ''])),
  ) as SanJoseValidatedPermitRecord['raw'];
}

function issue(
  code: string,
  message: string,
  recordKey: string,
  fieldPath: string | null,
): ValidationIssue {
  return Object.freeze({ code, severity: 'error', message, recordKey, fieldPath });
}

function sourceRecordReference(record: SanJoseValidatedPermitRecord): SourceRecordReference {
  return Object.freeze({
    sourceId: SAN_JOSE_BUILDING_PERMIT_SOURCE_ID,
    snapshotId: record.snapshotId,
    artifactId: record.artifactId,
    recordKey: record.recordKey,
    recordSha256: record.recordSha256,
    rawPointer: `csv:row:${record.ordinal}`,
  });
}

function lineage(
  record: SanJoseValidatedPermitRecord,
  fieldName: string,
  value: unknown,
  timestamp: string,
): FieldLineage {
  const outputSha256 = sha256Hex(new TextEncoder().encode(canonicalJson(value)));
  const transformation = Object.freeze({
    name: `san-jose-building-permits/${fieldName}`,
    version: TRANSFORM_VERSION,
    appliedAt: timestamp,
    inputSha256: record.recordSha256,
    outputSha256,
  });
  return fieldLineageSchema.parse({
    sourceRecord: sourceRecordReference(record),
    transformations: [transformation],
    lineageSha256: hashParts(
      canonicalJson(sourceRecordReference(record)),
      canonicalJson(transformation),
    ),
  });
}

function sourceAsOfInstant(record: SanJoseValidatedPermitRecord): string | null {
  return record.sourceAsOf.state === 'unknown' ? null : record.sourceAsOf.at;
}

function textVisibility(classification: PermitTextClassification): Visibility {
  if (classification.classification === 'missing_or_placeholder') {
    return 'public';
  }
  return classification.classification === 'permit_contractor_text'
    ? 'authenticated'
    : 'restricted';
}

function createMutations(
  record: SanJoseValidatedPermitRecord,
  options: SanJoseBuildingPermitAdapterOptions,
): readonly CanonicalMutation[] {
  const permitKey = hashParts(
    SAN_JOSE_BUILDING_PERMIT_SOURCE_ID,
    record.permitNumber,
    'city-of-san-jose',
  );
  const permitId = permitIdSchema.parse(`sc:entity:permit:${permitKey}`);
  const statusAsOf = sourceAsOfInstant(record) ?? record.retrievedAt;
  const permitLineage = lineage(
    record,
    'permit-number',
    record.permitNumber,
    options.normalizationTimestamp,
  );
  const entity = {
    id: permitId,
    entityKind: 'permit' as const,
    version: 1,
    validFrom: statusAsOf,
    validTo: null,
    recordedAt: options.normalizationTimestamp,
    visibility: 'public' as const,
    sourceIds: [SAN_JOSE_BUILDING_PERMIT_SOURCE_ID],
    lineage: [permitLineage],
    permitNumber: record.permitNumber,
    jurisdiction: 'City of San Jose, California',
    permitType: record.raw.FOLDERDESC.trim() || record.raw.SUBTYPEDESCRIPTION.trim(),
    status: record.raw.Status,
    statusAsOf,
    description: record.raw.WORKDESCRIPTION.trim() || null,
    issuedAt: record.issuedAt,
    completedAt: record.finaledAt,
    propertyLinks: [],
    contractorIds: [],
  };
  const mutations: CanonicalMutation[] = [];
  const baseSequence = SAN_JOSE_FEEDS.indexOf(record.feed) * 1_000_000_000 + record.ordinal * 100;
  mutations.push(
    canonicalMutationSchema.parse({
      kind: 'entity_upsert',
      mutationId: mutationIdSchema.parse(
        `sc:mutation:${hashParts(record.recordKey, 'entity_upsert', canonicalJson(entity))}`,
      ),
      runId: options.runId,
      sourceId: SAN_JOSE_BUILDING_PERMIT_SOURCE_ID,
      snapshotId: record.snapshotId,
      sequence: baseSequence,
      emittedAt: options.normalizationTimestamp,
      visibility: 'public',
      entity,
    }),
  );

  const observations = [
    ['feed_identity', record.feed, 'public' as const],
    ['feed_status', record.raw.Status, 'public' as const],
    ['source_row_id', record.sourceRowId, 'public' as const],
    ['source_apn', record.sourceApn, 'public' as const],
    ['normalized_apn', record.normalizedApn, 'public' as const],
    ['source_location', record.raw.gx_location, 'public' as const],
    ['folder_description', record.raw.FOLDERDESC, 'public' as const],
    ['folder_name', record.raw.FOLDERNAME, 'public' as const],
    ['subtype_description', record.raw.SUBTYPEDESCRIPTION, 'public' as const],
    ['work_description', record.raw.WORKDESCRIPTION, 'public' as const],
    ['permit_approvals', record.raw.PERMITAPPROVALS, 'public' as const],
    ['issued_at', record.issuedAt, 'public' as const],
    ['finaled_at', record.finaledAt, 'public' as const],
    ['valuation', record.valuation, 'public' as const],
    ['applicant_text', record.applicant, textVisibility(record.applicant)],
    ['owner_text', record.owner, textVisibility(record.owner)],
    ['contractor_text', record.contractor, textVisibility(record.contractor)],
  ] as const;
  for (const [index, [fieldName, value, visibility]] of observations.entries()) {
    const fieldLineage = lineage(record, fieldName, value, options.normalizationTimestamp);
    const observationId = observationIdSchema.parse(
      `sc:observation:${hashParts(permitId, fieldName, fieldLineage.lineageSha256)}`,
    );
    const observation = {
      observationId,
      entityId: permitId,
      entityKind: 'permit' as const,
      fieldPath: `/source/${fieldName}`,
      value,
      observedAt: options.normalizationTimestamp,
      sourceAsOf: sourceAsOfInstant(record),
      authorityRank: DESCRIPTOR.authority.authorityRank,
      confidence: 1,
      visibility,
      lineage: fieldLineage,
    };
    mutations.push(
      canonicalMutationSchema.parse({
        kind: 'field_observation',
        mutationId: mutationIdSchema.parse(
          `sc:mutation:${hashParts(record.recordKey, fieldName, canonicalJson(observation))}`,
        ),
        runId: options.runId,
        sourceId: SAN_JOSE_BUILDING_PERMIT_SOURCE_ID,
        snapshotId: record.snapshotId,
        sequence: baseSequence + index + 1,
        emittedAt: options.normalizationTimestamp,
        visibility,
        observation,
      }),
    );
  }
  return Object.freeze(mutations);
}

function feedFromRecordKey(recordKey: string | null): SanJosePermitFeed | undefined {
  if (recordKey === null) {
    return undefined;
  }
  return SAN_JOSE_FEEDS.find((feed) => recordKey.startsWith(`${feed}:`));
}

function acceptedFeedFromMutation(mutation: CanonicalMutation): SanJosePermitFeed | undefined {
  if (
    mutation.kind !== 'field_observation' ||
    mutation.observation.fieldPath !== '/source/feed_identity' ||
    typeof mutation.observation.value !== 'string'
  ) {
    return undefined;
  }
  return isSanJosePermitFeed(mutation.observation.value) ? mutation.observation.value : undefined;
}

export async function summarizeSanJoseBuildingPermits(
  run: SourceRunObservationV2,
  source: SourceRunSummary,
): Promise<SanJoseBuildingPermitSummary> {
  const acceptedByFeed = new Map<SanJosePermitFeed, number>();
  for await (const mutation of run.mutations.read()) {
    const feed = acceptedFeedFromMutation(mutation);
    if (feed !== undefined) acceptedByFeed.set(feed, (acceptedByFeed.get(feed) ?? 0) + 1);
  }
  const rejectedByFeed = new Map<SanJosePermitFeed, number>();
  const lastRejectedKey = new Map<SanJosePermitFeed, string>();
  for await (const validationIssue of run.validationIssues.read()) {
    const feed = feedFromRecordKey(validationIssue.recordKey);
    const recordKey = validationIssue.recordKey;
    if (feed !== undefined && recordKey !== null && lastRejectedKey.get(feed) !== recordKey) {
      rejectedByFeed.set(feed, (rejectedByFeed.get(feed) ?? 0) + 1);
      lastRejectedKey.set(feed, recordKey);
    }
  }
  const feedSnapshots: SanJoseFeedSnapshotSummary[] = SAN_JOSE_FEEDS.map((feed) => {
    const artifacts = run.artifacts.filter((artifact) => artifact.request.requestKey === feed);
    const accepted = acceptedByFeed.get(feed) ?? 0;
    const rejected = rejectedByFeed.get(feed) ?? 0;
    const artifact = artifacts[0];
    return Object.freeze({
      feed,
      artifactCount: artifacts.length,
      acceptedRecords: accepted,
      rejectedRecords: rejected,
      decodedRecords: accepted + rejected,
      byteSize: artifacts.reduce((total, item) => total + item.byteSize, 0),
      sha256: artifacts.length === 1 && artifact !== undefined ? artifact.sha256 : null,
      sourceAsOf: artifacts.length === 1 && artifact !== undefined ? artifact.sourceAsOf : null,
      lastModified:
        artifacts.length === 1 && artifact !== undefined ? artifact.response.lastModified : null,
    });
  });
  return Object.freeze({
    source,
    scope: 'city_of_san_jose_jurisdiction_only',
    feedSnapshots: Object.freeze(feedSnapshots),
    limitations: Object.freeze([
      'This source covers City of San Jose jurisdiction only, not Santa Clara County.',
      'Feed identity is preserved; rows are not synthesized into a permit lifecycle.',
      'Permit owner text is not current ownership evidence.',
      'Status and approval labels alone do not prove completed roof work.',
    ]),
  });
}

class SanJoseBuildingPermitAdapter implements StreamingSourceAdapter<
  SanJoseDecodedPermitRecord,
  SanJoseValidatedPermitRecord
> {
  readonly #options: SanJoseBuildingPermitAdapterOptions;
  readonly #maximumResponseBytes: number;
  readonly #maximumRecordBytes: number;

  public constructor(options: SanJoseBuildingPermitAdapterOptions) {
    const maximumResponseBytes = options.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES;
    if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1) {
      throw new RangeError('maximumResponseBytes must be a positive safe integer');
    }
    const maximumRecordBytes = options.maximumRecordBytes ?? DEFAULT_MAXIMUM_RECORD_BYTES;
    if (!Number.isSafeInteger(maximumRecordBytes) || maximumRecordBytes < 1) {
      throw new RangeError('maximumRecordBytes must be a positive safe integer');
    }
    this.#options = options;
    this.#maximumResponseBytes = maximumResponseBytes;
    this.#maximumRecordBytes = maximumRecordBytes;
  }

  public describe(): SourceDescriptor {
    return DESCRIPTOR;
  }

  public async discover(context: DiscoveryContext): Promise<DiscoveryResult> {
    const resources = [];
    for (const [index, feed] of SAN_JOSE_FEEDS.entries()) {
      const { response } = await requestWithRetry(
        context,
        `metadata:${feed}`,
        sanJosePackageMetadataUrl(feed),
        'application/json',
        'discover',
      );
      const metadata = parsePackageMetadata(
        await collectBody(response, context.signal, MAX_METADATA_BYTES),
        feed,
      );
      resources.push(
        Object.freeze({
          requestKey: feed,
          url: metadata.resourceUrl,
          sourceAsOf: Object.freeze({ state: 'reported' as const, at: metadata.modifiedAt }),
          expectedRecords: this.#options.expectedRecordCounts?.[feed] ?? null,
          mediaTypes: Object.freeze(['text/csv']),
          continuationToken: null,
        }),
      );
      if (index + 1 < SAN_JOSE_FEEDS.length) {
        const interval = Math.ceil(
          context.ratePolicy.windowMs / context.ratePolicy.maxRequestsPerWindow,
        );
        await context.delay.wait(interval, context.signal);
      }
    }
    return Object.freeze({
      sourceId: SAN_JOSE_BUILDING_PERMIT_SOURCE_ID,
      discoveredAt: context.clock.now(),
      resources: Object.freeze(resources),
      complete: true,
      limitations: Object.freeze([
        'Three independently modified full CSV snapshots; no lifecycle is synthesized.',
        'The publisher exposes no independent row-count endpoint; locked counts are optional and final snapshot counts are computed after decoding.',
        'Jurisdiction is City of San Jose, not Santa Clara County.',
      ]),
    });
  }

  public plan(
    request: AcquisitionRequest,
    discovery: DiscoveryResult,
    context: PlanningContext,
  ): Promise<AcquisitionPlan> {
    context.signal.throwIfAborted();
    if (
      request.sourceId !== SAN_JOSE_BUILDING_PERMIT_SOURCE_ID ||
      discovery.sourceId !== SAN_JOSE_BUILDING_PERMIT_SOURCE_ID ||
      !discovery.complete
    ) {
      throw oracleError('SCHEMA_DRIFT', 'Incomplete or mismatched discovery result', 'plan');
    }
    const items = SAN_JOSE_FEEDS.map((feed, sequence) => {
      const resource = discovery.resources.find((candidate) => candidate.requestKey === feed);
      if (resource?.url !== sanJoseCsvUrl(feed)) {
        throw oracleError('SCHEMA_DRIFT', `Discovery resource mismatch for ${feed}`, 'plan');
      }
      return {
        requestKey: feed,
        sequence,
        method: 'GET' as const,
        url: resource.url,
        encoding: 'csv' as const,
        expectedMediaTypes: ['text/csv'],
      };
    });
    return Promise.resolve(
      acquisitionPlanSchema.parse({
        sourceId: request.sourceId,
        snapshotId: request.snapshotId,
        contractVersion: CONTRACT_VERSION,
        plannedAt: context.clock.now(),
        items,
      }),
    );
  }

  public async *acquire(
    plan: AcquisitionPlan,
    checkpoint: SourceCheckpoint | undefined,
    context: StreamingAcquisitionContext,
  ): AsyncIterable<AcquiredArtifactSource> {
    if (plan.sourceId !== SAN_JOSE_BUILDING_PERMIT_SOURCE_ID) {
      throw oracleError('SCHEMA_DRIFT', 'Acquisition plan source mismatch', 'acquire');
    }
    const sorted = [...plan.items].sort((left, right) => left.sequence - right.sequence);
    const scope = `${plan.sourceId}/${plan.snapshotId}`;
    let storedCheckpoint = await context.checkpointStore.load(scope);
    const suppliedSourceCheckpoint =
      checkpoint === undefined ? undefined : checkpointForPlan(plan, checkpoint, 'caller');
    const persistedSourceCheckpoint =
      storedCheckpoint === undefined
        ? undefined
        : checkpointForPlan(plan, storedCheckpoint.payload, 'store');
    if (
      suppliedSourceCheckpoint !== undefined &&
      persistedSourceCheckpoint !== undefined &&
      !checkpointsEqual(suppliedSourceCheckpoint, persistedSourceCheckpoint)
    ) {
      throw oracleError('RECONCILIATION', 'Caller and persisted checkpoints disagree', 'acquire');
    }
    const resumeCheckpoint = persistedSourceCheckpoint ?? suppliedSourceCheckpoint;
    if (resumeCheckpoint !== undefined) {
      const expectedKeys = sorted
        .slice(0, resumeCheckpoint.nextSequence)
        .map((item) => item.requestKey);
      if (
        resumeCheckpoint.completedRequestKeys.length !== resumeCheckpoint.nextSequence ||
        resumeCheckpoint.acquiredArtifactIds.length > resumeCheckpoint.nextSequence ||
        resumeCheckpoint.completedRequestKeys.some((key, index) => key !== expectedKeys[index]) ||
        resumeCheckpoint.complete !== (resumeCheckpoint.nextSequence === sorted.length)
      ) {
        throw oracleError(
          'RECONCILIATION',
          'Checkpoint does not describe an exact contiguous acquisition prefix',
          'acquire',
        );
      }
    }
    const completed = [...(resumeCheckpoint?.completedRequestKeys ?? [])];
    const artifactIds = [...(resumeCheckpoint?.acquiredArtifactIds ?? [])];
    const startSequence = resumeCheckpoint?.nextSequence ?? 0;
    const recoveredArtifactIds: SourceCheckpoint['acquiredArtifactIds'][number][] = [];

    for (const item of sorted) {
      context.signal.throwIfAborted();
      const wasCompleted = item.sequence < startSequence;
      const logicalKey = `raw/san-jose-building-permits/${plan.snapshotId}/${item.requestKey}.csv`;
      let stored = await context.artifactStore.headByLogicalKey(logicalKey);
      if (wasCompleted && stored === undefined) {
        throw oracleError(
          'RECONCILIATION',
          `Checkpoint references a missing immutable feed artifact: ${item.requestKey}`,
          'acquire',
        );
      }
      if (stored === undefined) {
        const { response, attempt } = await requestWithRetry(
          context,
          item.requestKey,
          item.url,
          'text/csv',
          'acquire',
        );
        const contentType = headerValue(response.headers, 'content-type');
        if (contentType === undefined) {
          throw oracleError(
            'SCHEMA_DRIFT',
            `Missing Content-Type for ${item.requestKey}`,
            'acquire',
          );
        }
        const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
        if (mediaType === undefined || !item.expectedMediaTypes.includes(mediaType)) {
          throw oracleError(
            'SCHEMA_DRIFT',
            `Unexpected media type for ${item.requestKey}`,
            'acquire',
            {
              mediaType,
            },
          );
        }
        const retrievedAt = context.clock.now();
        const lastModified = httpDateToIso(headerValue(response.headers, 'last-modified'));
        stored = await persistAcquiredBody({
          store: context.artifactStore,
          logicalKey,
          mediaType,
          body: response.body,
          maximumBytes: this.#maximumResponseBytes,
          metadata: Object.freeze({
            authority: 'City of San Jose',
            sourceId: plan.sourceId,
            sourceUrl: item.url,
            requestKey: item.requestKey,
            feed: item.requestKey,
            snapshotId: plan.snapshotId,
            license: 'CC0-1.0',
            retrievedAt,
            attempt: String(attempt),
            httpStatus: String(response.status),
            etag: headerValue(response.headers, 'etag') ?? '',
            lastModified: lastModified ?? '',
            finalUrl: item.url,
          }),
          signal: context.signal,
        });
      }
      const metadata = acquiredMetadataFromStored(plan, item, stored);
      const artifact = await createStreamingAcquiredArtifact(metadata, context.artifactStore);
      if (wasCompleted) {
        if (!artifactIds.includes(artifact.metadata.artifactId)) {
          throw oracleError(
            'RECONCILIATION',
            `Checkpoint artifact identity mismatches recovered feed: ${item.requestKey}`,
            'acquire',
          );
        }
        if (!recoveredArtifactIds.includes(artifact.metadata.artifactId)) {
          recoveredArtifactIds.push(artifact.metadata.artifactId);
        }
        if (
          item.sequence + 1 === startSequence &&
          (recoveredArtifactIds.length !== artifactIds.length ||
            recoveredArtifactIds.some((candidate, index) => candidate !== artifactIds[index]))
        ) {
          throw oracleError(
            'RECONCILIATION',
            'Checkpoint artifact identities do not exactly match the recovered immutable prefix',
            'acquire',
          );
        }
        yield artifact;
        continue;
      }
      completed.push(item.requestKey);
      if (!artifactIds.includes(artifact.metadata.artifactId)) {
        artifactIds.push(artifact.metadata.artifactId);
      }
      const sourceCheckpoint = createSourceCheckpoint(
        plan,
        item.sequence + 1,
        completed,
        artifactIds,
        artifact.metadata.retrievedAt,
      );
      const envelope = createCheckpointEnvelope({
        scope,
        previousRevision: storedCheckpoint?.revision ?? null,
        writtenAt: sourceCheckpoint.updatedAt,
        payload: checkpointPayload(sourceCheckpoint),
      });
      const committed = await context.checkpointStore.commit({
        expectedRevision: storedCheckpoint?.revision ?? null,
        checkpoint: envelope,
      });
      if (committed.status === 'conflict') {
        throw oracleError(
          'RECONCILIATION',
          `Checkpoint conflict after ${item.requestKey}`,
          'acquire',
        );
      }
      storedCheckpoint = committed.checkpoint;
      yield artifact;
      if (item.sequence + 1 < sorted.length) {
        const interval = Math.ceil(
          context.ratePolicy.windowMs / context.ratePolicy.maxRequestsPerWindow,
        );
        await context.delay.wait(interval, context.signal);
      }
    }
  }

  public async *decode(
    artifact: AcquiredArtifactSource,
    context: StreamingDecodeContext,
  ): AsyncIterable<SanJoseDecodedPermitRecord> {
    context.signal.throwIfAborted();
    if (artifact.metadata.encoding !== 'csv') {
      throw oracleError('SCHEMA_DRIFT', 'San Jose permit artifact is not CSV', 'decode');
    }
    const feed = feedForArtifact(artifact);
    const expectedCount = this.#options.expectedRecordCounts?.[feed];
    if (expectedCount !== undefined) {
      const observedCount = await countAndValidateCsv(
        artifactRead(artifact),
        feed,
        context.signal,
        this.#maximumRecordBytes,
      );
      if (observedCount !== expectedCount) {
        throw oracleError(
          'SCHEMA_DRIFT',
          `Snapshot count mismatch for ${feed}: expected ${expectedCount}, observed ${observedCount}`,
          'decode',
          { expectedCount, observedCount },
        );
      }
    }
    let ordinal = 0;
    for await (const row of csvRecords(
      artifactRead(artifact),
      context.signal,
      feed,
      this.#maximumRecordBytes,
    )) {
      ordinal += 1;
      const raw = rowObject(row.values);
      const sourceRowId = raw.FOLDERRSN.trim() || `ordinal-${ordinal}`;
      const recordKey = `${feed}:${sourceRowId}:${ordinal}`;
      yield Object.freeze({
        format: 'csv',
        artifactId: artifact.metadata.artifactId,
        ordinal,
        visibility: artifact.metadata.visibility,
        header: row.header,
        values: row.values,
        feed,
        snapshotId: artifact.metadata.snapshotId,
        sourceAsOf: sourceAsOfFromArtifact(artifact.metadata),
        retrievedAt: artifact.metadata.retrievedAt,
        recordKey,
        recordSha256: sha256Hex(new TextEncoder().encode(canonicalJson(row.values))),
      });
    }
  }

  public validate(
    record: SanJoseDecodedPermitRecord,
    context: ValidationContext,
  ): Promise<RecordValidation<SanJoseValidatedPermitRecord>> {
    context.signal.throwIfAborted();
    const raw = rowObject(record.values);
    const issues: ValidationIssue[] = [];
    const expectedStatus = SAN_JOSE_FEED_CONFIG[record.feed].status;
    if (raw.Status !== expectedStatus) {
      issues.push(
        issue(
          'STATUS_FEED_MISMATCH',
          `Expected ${expectedStatus} for ${record.feed}`,
          record.recordKey,
          '/Status',
        ),
      );
    }
    const permitNumber = raw.FOLDERNUMBER.trim();
    const sourceRowId = raw.FOLDERRSN.trim();
    if (permitNumber.length === 0) {
      issues.push(
        issue(
          'MISSING_PERMIT_NUMBER',
          'FOLDERNUMBER is required',
          record.recordKey,
          '/FOLDERNUMBER',
        ),
      );
    }
    if (sourceRowId.length === 0) {
      issues.push(
        issue('MISSING_SOURCE_ROW_ID', 'FOLDERRSN is required', record.recordKey, '/FOLDERRSN'),
      );
    }
    if (raw.FOLDERDESC.trim().length === 0 && raw.SUBTYPEDESCRIPTION.trim().length === 0) {
      issues.push(
        issue(
          'MISSING_PERMIT_TYPE',
          'Permit type fields are empty',
          record.recordKey,
          '/FOLDERDESC',
        ),
      );
    }
    const sourceApn = raw.ASSESSORS_PARCEL_NUMBER.trim() || null;
    const normalizedApn = normalizeApn(raw.ASSESSORS_PARCEL_NUMBER);
    if (sourceApn !== null && normalizedApn === null) {
      issues.push(
        issue(
          'MALFORMED_APN',
          'APN must normalize to exactly eight digits',
          record.recordKey,
          '/ASSESSORS_PARCEL_NUMBER',
        ),
      );
    }
    const issuedAt = parseSourceLocalDate(raw.ISSUEDATE);
    const finaledAt = parseSourceLocalDate(raw.FINALDATE);
    if (issuedAt === undefined) {
      issues.push(
        issue(
          'INVALID_ISSUE_DATE',
          'ISSUEDATE is not a valid San Jose local timestamp',
          record.recordKey,
          '/ISSUEDATE',
        ),
      );
    }
    if (finaledAt === undefined) {
      issues.push(
        issue(
          'INVALID_FINAL_DATE',
          'FINALDATE is not a valid San Jose local timestamp',
          record.recordKey,
          '/FINALDATE',
        ),
      );
    }
    const valuation = parseValuation(raw.PERMITVALUATION);
    if (valuation === undefined) {
      issues.push(
        issue(
          'INVALID_VALUATION',
          'PERMITVALUATION is not a non-negative number',
          record.recordKey,
          '/PERMITVALUATION',
        ),
      );
    }
    if (
      issues.length > 0 ||
      issuedAt === undefined ||
      finaledAt === undefined ||
      valuation === undefined
    ) {
      return Promise.resolve(Object.freeze({ status: 'rejected', issues: Object.freeze(issues) }));
    }
    return Promise.resolve(
      Object.freeze({
        status: 'accepted',
        issues: Object.freeze([]),
        record: Object.freeze({
          ...record,
          raw,
          permitNumber,
          sourceRowId,
          sourceApn,
          normalizedApn,
          issuedAt,
          finaledAt,
          valuation,
          applicant: classifyText('applicant', raw.APPLICANT),
          owner: classifyText('owner', raw.OWNERNAME),
          contractor: classifyText('contractor', raw.CONTRACTOR),
        }),
      }),
    );
  }

  public async *normalize(
    record: SanJoseValidatedPermitRecord,
    context: NormalizationContext,
  ): AsyncIterable<CanonicalMutation> {
    context.signal.throwIfAborted();
    await Promise.resolve();
    for (const mutation of createMutations(record, this.#options)) {
      context.signal.throwIfAborted();
      yield mutation;
    }
  }

  public async summarize(
    run: SourceRunObservationV2,
    context: SummaryContext,
  ): Promise<SourceRunSummary> {
    context.signal.throwIfAborted();
    if (run.decodedRecords !== run.acceptedRecords + run.rejectedRecords) {
      throw oracleError(
        'RECORD_QUALITY',
        'Source summary decoded count does not equal accepted plus rejected',
        'summarize',
        {
          decodedRecords: run.decodedRecords,
          acceptedRecords: run.acceptedRecords,
          rejectedRecords: run.rejectedRecords,
        },
      );
    }
    const observedFeedCounts = new Map<string, number>();
    for (const artifact of run.artifacts) {
      const feed = artifact.request.requestKey;
      observedFeedCounts.set(feed, (observedFeedCounts.get(feed) ?? 0) + 1);
    }
    const completeArtifacts =
      observedFeedCounts.size === SAN_JOSE_FEEDS.length &&
      SAN_JOSE_FEEDS.every((feed) => observedFeedCounts.get(feed) === 1);
    const completeCheckpoint =
      run.finalCheckpoint.complete &&
      run.finalCheckpoint.nextSequence === run.plan.items.length &&
      SAN_JOSE_FEEDS.every((feed) => run.finalCheckpoint.completedRequestKeys.includes(feed));
    const visibilityCounts = {
      public: 0,
      authenticated: 0,
      restricted: 0,
      prohibited_public: 0,
    };
    for await (const mutation of run.mutations.read()) {
      context.signal.throwIfAborted();
      visibilityCounts[mutation.visibility] += 1;
    }
    let warningCount = 0;
    let errorCount = 0;
    for await (const validationIssue of run.validationIssues.read()) {
      context.signal.throwIfAborted();
      if (validationIssue.severity === 'warning') warningCount += 1;
      else errorCount += 1;
    }
    return sourceRunSummarySchema.parse({
      sourceId: run.descriptor.sourceId,
      snapshotId: run.plan.snapshotId,
      runId: run.runId,
      contractVersion: run.descriptor.contractVersion,
      status: run.aborted
        ? 'aborted'
        : run.rejectedRecords > 0 || !completeArtifacts || !completeCheckpoint
          ? 'partial'
          : 'succeeded',
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      artifactsAcquired: run.artifacts.length,
      bytesAcquired: run.artifacts.reduce((total, artifact) => total + artifact.byteSize, 0),
      decodedRecords: run.decodedRecords,
      acceptedRecords: run.acceptedRecords,
      rejectedRecords: run.rejectedRecords,
      normalizedMutations: run.mutations.count,
      visibilityCounts,
      warningCount,
      errorCount,
      finalCheckpoint: run.finalCheckpoint,
    });
  }
}

export function createSanJoseBuildingPermitAdapter(
  options: SanJoseBuildingPermitAdapterOptions,
): StreamingSourceAdapter<SanJoseDecodedPermitRecord, SanJoseValidatedPermitRecord> {
  return new SanJoseBuildingPermitAdapter(options);
}

export const SAN_JOSE_BUILDING_PERMIT_DESCRIPTOR = DESCRIPTOR;
export const SAN_JOSE_METADATA_ACCEPT_HEADER_SHA256 = ACCEPT_JSON_HASH;
