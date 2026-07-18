import { createHash } from 'node:crypto';

import type { StoredArtifact } from '@oracle/artifacts/artifact-store';
import { createCheckpointEnvelope } from '@oracle/artifacts/checkpoint-store';
import {
  canonicalMutationSchema,
  type CanonicalMutation,
} from '@oracle/contracts/canonical/mutation';
import {
  geoMultiPolygonSchema,
  type GeoMultiPolygon,
} from '@oracle/contracts/canonical/geospatial';
import { fieldLineageSchema, type FieldLineage } from '@oracle/contracts/canonical/lineage';
import { propertySchema } from '@oracle/contracts/canonical/property';
import { oracleErrorSchema, type OracleErrorCode } from '@oracle/contracts/errors';
import { jsonValueSchema, type JsonValue } from '@oracle/contracts/foundation';
import {
  acquiredArtifactSchema,
  acquisitionPlanSchema,
  sourceCheckpointSchema,
  sourceDescriptorSchema,
  sourceRunSummarySchema,
  type AcquisitionPlan,
  type AcquiredArtifact,
  type AcquisitionRequest,
  type SourceCheckpoint,
  type SourceDescriptor,
  type SourceRunSummary,
  type ValidationIssue,
} from '@oracle/contracts/source';

import {
  createStreamingAcquiredArtifact,
  LegacyWholeCopyLimitError,
  LEGACY_WHOLE_COPY_MAX_BYTES,
  type AcquiredArtifactSource,
} from '../../spi/acquired-artifact.js';
import { persistAcquiredBody } from '../../spi/acquisition.js';
import type {
  DiscoveryContext,
  DiscoveryResult,
  NormalizationContext,
  PlanningContext,
  RecordValidation,
  SourceRunObservationV2,
  StreamingAcquisitionContext,
  StreamingDecodeContext,
  StreamingSourceAdapter,
  SummaryContext,
  ValidationContext,
} from '../../spi/adapter.js';
import type { JsonValue as SpiJsonValue } from '../../spi/decode.js';
import type { HttpHeaders, HttpResponse } from '../../spi/http.js';
import { sha256Hex } from '../../spi/bytes.js';
import {
  MTC_PALO_ALTO_ARCGIS_URL,
  MTC_PALO_ALTO_CONTRACT_VERSION,
  MTC_PALO_ALTO_DATASET_ID,
  MTC_PALO_ALTO_FIELDS,
  MTC_PALO_ALTO_LICENSE_SNAPSHOT_ID,
  MTC_PALO_ALTO_METADATA_ARTIFACT_SHA256,
  MTC_PALO_ALTO_METADATA_URL,
  MTC_PALO_ALTO_RESOURCE_URL,
  MTC_PALO_ALTO_SCHEMA,
  MTC_PALO_ALTO_SCHEMA_FINGERPRINT,
  MTC_PALO_ALTO_SOURCE_ID,
  MTC_PALO_ALTO_TRANSFORM_VERSION,
  MTC_PALO_ALTO_VISIBILITY,
  PALO_ALTO_EPSG_2227_BOUNDS,
  PALO_ALTO_WGS84_BOUNDS,
  type MtcPaloAltoField,
} from './constants.js';
import type {
  MtcPaloAltoDecodedRecord,
  MtcPaloAltoRawRow,
  MtcPaloAltoValidatedRecord,
} from './types.js';
import { streamTopLevelJsonObjects } from './streaming-json.js';

const DEFAULT_PAGE_SIZE = 10_000;
const ACCEPT = 'application/json';
const COUNT_QUERY_URL = `${MTC_PALO_ALTO_RESOURCE_URL}?%24select=count(*)%20as%20count`;
const CHECKPOINT_SCOPE_PREFIX = 'source/mtc-palo-alto-year-built';
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 128 * 1024 * 1024;
const MAXIMUM_DISCOVERY_BYTES = 2 * 1024 * 1024;

const DESCRIPTOR: SourceDescriptor = sourceDescriptorSchema.parse({
  sourceId: MTC_PALO_ALTO_SOURCE_ID,
  contractVersion: MTC_PALO_ALTO_CONTRACT_VERSION,
  name: 'MTC / Bay Area Metro Palo Alto Assessor parcels',
  authority: {
    authorityType: 'official_government',
    organization: 'Metropolitan Transportation Commission / Bay Area Metro',
    jurisdiction: 'Palo Alto, Santa Clara County, California',
    canonicalUrl: MTC_PALO_ALTO_METADATA_URL,
    authorityRank: 5,
  },
  acquisitionMethod: 'api',
  encodings: ['json'],
  entityKinds: ['property'],
  defaultVisibility: MTC_PALO_ALTO_VISIBILITY,
  license: {
    licenseSnapshotId: MTC_PALO_ALTO_LICENSE_SNAPSHOT_ID,
    capturedAt: '2026-07-17T13:01:18.800Z',
    title: 'Socrata metadata with no explicit redistribution license',
    canonicalUrl: MTC_PALO_ALTO_METADATA_URL,
    termsSha256: MTC_PALO_ALTO_METADATA_ARTIFACT_SHA256,
    redistribution: 'unknown',
    containsPersonalData: false,
    attribution: [
      'Metropolitan Transportation Commission / Bay Area Metro',
      `Backing ArcGIS FeatureServer: ${MTC_PALO_ALTO_ARCGIS_URL}`,
    ],
    limitations: [
      'Palo Alto subset enrichment; never a Santa Clara County completion denominator.',
      'Redistribution rights are pending; normalized output remains prohibited_public.',
      'Building age is a roof-age proxy only.',
      'Flood zone, near-creek, and water proximity do not prove a water view.',
    ],
  },
  ratePolicy: {
    maxRequestsPerWindow: 1_000,
    windowMs: 60_000,
    maxConcurrency: 1,
    maxAttempts: 5,
    initialBackoffMs: 250,
    maxBackoffMs: 8_000,
    jitter: 'none',
    respectRetryAfter: true,
  },
  freshnessSemantics:
    'Socrata rowsUpdatedAt is the dataset source-as-of; each row also retains modifieddate.',
});

interface AdapterOptions {
  readonly pageSize?: number;
  readonly maximumResponseBytes?: number;
}

interface PageKey {
  readonly sequence: number;
  readonly offset: number;
  readonly expectedRows: number;
  readonly sourceAsOfEpochMs: number;
}

type ProviderErrorCode = OracleErrorCode;

class MtcPaloAltoProviderError extends Error {
  public readonly code: ProviderErrorCode;
  public readonly retryable: boolean;
  public readonly sourceId = MTC_PALO_ALTO_SOURCE_ID;
  public readonly phase: string;

  public constructor(code: ProviderErrorCode, message: string, phase: string) {
    super(message);
    this.name = 'MtcPaloAltoProviderError';
    this.code = code;
    this.retryable = code === 'TRANSIENT_SOURCE';
    this.phase = phase;
  }
}

function providerError(
  code: ProviderErrorCode,
  message: string,
  phase: string,
): MtcPaloAltoProviderError {
  return new MtcPaloAltoProviderError(code, message, phase);
}

async function collectDiscoveryBody(
  response: HttpResponse,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(MAXIMUM_DISCOVERY_BYTES);
  let byteLength = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    if (byteLength + chunk.byteLength > bytes.byteLength) {
      throw providerError(
        'SCHEMA_DRIFT',
        'Socrata discovery response exceeded its byte ceiling',
        'discover',
      );
    }
    bytes.set(chunk, byteLength);
    byteLength += chunk.byteLength;
  }
  return bytes.slice(0, byteLength);
}

function header(headers: HttpHeaders, name: string): string | undefined {
  const target = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === target)?.[1];
}

function parseHttpDate(value: string | undefined): string | null {
  if (value === undefined) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function artifactRead(artifact: AcquiredArtifactSource): AsyncIterable<Uint8Array> {
  if (artifact.content !== undefined) return artifact.content.read({ maxChunkBytes: 64 * 1024 });
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
  const page = parsePageRequestKey(item.requestKey);
  const metadata = stored.metadata;
  const attempt = Number(metadata.attempt);
  const httpStatus = Number(metadata.httpStatus);
  if (
    metadata.sourceId !== plan.sourceId ||
    metadata.snapshotId !== plan.snapshotId ||
    metadata.requestKey !== item.requestKey ||
    metadata.requestUrl !== item.url ||
    metadata.retrievedAt === undefined ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    !Number.isSafeInteger(httpStatus) ||
    httpStatus < 200 ||
    httpStatus >= 300 ||
    !item.expectedMediaTypes.includes(stored.mediaType)
  ) {
    throw providerError('RECONCILIATION', 'Recovered Socrata page metadata is invalid', 'acquire');
  }
  const lastModified = metadata.lastModified === '' ? null : parseHttpDate(metadata.lastModified);
  if (metadata.lastModified !== '' && lastModified === null) {
    throw providerError('RECONCILIATION', 'Recovered Last-Modified metadata is invalid', 'acquire');
  }
  return acquiredArtifactSchema.parse({
    artifactId: `sc:artifact:sha256:${stored.sha256}`,
    sourceId: plan.sourceId,
    snapshotId: plan.snapshotId,
    retrievedAt: metadata.retrievedAt,
    sourceAsOf: { state: 'reported', at: new Date(page.sourceAsOfEpochMs).toISOString() },
    request: {
      requestKey: item.requestKey,
      method: 'GET',
      url: item.url,
      headers: [{ name: 'accept', valueSha256: sha256Hex(new TextEncoder().encode(ACCEPT)) }],
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
    encoding: 'json',
    byteSize: stored.byteSize,
    sha256: stored.sha256,
    schemaFingerprint: {
      algorithm: 'sha256',
      value: MTC_PALO_ALTO_SCHEMA_FINGERPRINT,
      schemaName: 'mtc-palo-alto-c252-zdg8-v1',
      canonicalizationVersion: MTC_PALO_ALTO_CONTRACT_VERSION,
    },
    rawUri: stored.uri,
    licenseSnapshotRef: MTC_PALO_ALTO_LICENSE_SNAPSHOT_ID,
    visibility: MTC_PALO_ALTO_VISIBILITY,
  });
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

async function requestWithRetry(
  url: string,
  context: DiscoveryContext | StreamingAcquisitionContext,
  phase: 'discover' | 'acquire',
): Promise<Readonly<{ response: HttpResponse; attempt: number }>> {
  const policy = context.ratePolicy;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    context.signal.throwIfAborted();
    let response: HttpResponse;
    try {
      response = await context.http.send(
        { method: 'GET', url, headers: { accept: ACCEPT } },
        context.signal,
      );
    } catch (error) {
      if (context.signal.aborted || isAbortError(error)) {
        throw error instanceof Error
          ? error
          : new DOMException('Acquisition aborted', 'AbortError');
      }
      if (error instanceof MtcPaloAltoProviderError) throw error;
      const oracleError = oracleErrorSchema.safeParse(error);
      if (oracleError.success) {
        throw providerError(oracleError.data.code, oracleError.data.message, phase);
      }
      if (attempt === policy.maxAttempts) {
        throw providerError(
          'TRANSIENT_SOURCE',
          `Official source transport failed after ${attempt} attempts`,
          phase,
        );
      }
      const backoff = Math.min(policy.initialBackoffMs * 2 ** (attempt - 1), policy.maxBackoffMs);
      await context.delay.wait(backoff, context.signal);
      continue;
    }
    if (response.status >= 200 && response.status < 300) {
      return Object.freeze({ response, attempt });
    }
    if (!isTransientStatus(response.status)) {
      const code = response.status === 401 ? 'AUTHENTICATION' : 'TERMS_ACCESS';
      throw providerError(code, `Official source returned HTTP ${response.status}`, phase);
    }
    if (attempt === policy.maxAttempts) {
      throw providerError(
        'TRANSIENT_SOURCE',
        `Official source remained unavailable after ${attempt} attempts`,
        phase,
      );
    }
    const retryAfter = policy.respectRetryAfter
      ? parseRetryAfter(header(response.headers, 'retry-after'))
      : undefined;
    const exponential = Math.min(policy.initialBackoffMs * 2 ** (attempt - 1), policy.maxBackoffMs);
    await context.delay.wait(retryAfter ?? exponential, context.signal);
  }
  throw new Error('Unreachable retry loop');
}

function parseObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw providerError('SCHEMA_DRIFT', `${label} must be a JSON object`, 'decode');
  }
  return value as Readonly<Record<string, unknown>>;
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw providerError('SCHEMA_DRIFT', `${label} is not valid UTF-8 JSON`, 'decode');
  }
}

function readMetadata(value: unknown): Readonly<{
  sourceAsOf: string;
  fieldTypes: ReadonlyMap<string, string>;
  arcgisUrl: string;
}> {
  const metadata = parseObject(value, 'Socrata metadata');
  if (metadata.id !== 'c252-zdg8' || metadata.provenance !== 'official') {
    throw providerError(
      'SCHEMA_DRIFT',
      'Unexpected Socrata dataset identity/provenance',
      'discover',
    );
  }
  if (!Array.isArray(metadata.columns)) {
    throw providerError('SCHEMA_DRIFT', 'Socrata metadata columns are missing', 'discover');
  }
  const fieldTypes = new Map<string, string>();
  for (const columnValue of metadata.columns) {
    const column = parseObject(columnValue, 'Socrata column');
    if (typeof column.fieldName === 'string' && typeof column.dataTypeName === 'string') {
      fieldTypes.set(column.fieldName, column.dataTypeName);
    }
  }
  for (const field of MTC_PALO_ALTO_FIELDS) {
    if (fieldTypes.get(field) !== MTC_PALO_ALTO_SCHEMA[field]) {
      throw providerError(
        'SCHEMA_DRIFT',
        `Socrata field ${field} changed or is missing`,
        'discover',
      );
    }
  }
  const nested = parseObject(metadata.metadata, 'Socrata provider metadata');
  const connection = parseObject(nested.arcgis_connection, 'Socrata ArcGIS connection');
  if (connection.url !== MTC_PALO_ALTO_ARCGIS_URL) {
    throw providerError('SCHEMA_DRIFT', 'Backing ArcGIS layer identity changed', 'discover');
  }
  if (typeof metadata.rowsUpdatedAt !== 'number' || !Number.isSafeInteger(metadata.rowsUpdatedAt)) {
    throw providerError('SCHEMA_DRIFT', 'Socrata rowsUpdatedAt is missing', 'discover');
  }
  return Object.freeze({
    sourceAsOf: new Date(metadata.rowsUpdatedAt * 1_000).toISOString(),
    fieldTypes,
    arcgisUrl: connection.url,
  });
}

function readCount(value: unknown): number {
  if (!Array.isArray(value) || value.length !== 1) {
    throw providerError(
      'QUERY_REGRESSION',
      'Socrata count query returned an unexpected shape',
      'discover',
    );
  }
  const row = parseObject(value[0], 'Socrata count row');
  const count = typeof row.count === 'string' ? Number(row.count) : Number.NaN;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw providerError(
      'QUERY_REGRESSION',
      'Socrata count is not a safe non-negative integer',
      'discover',
    );
  }
  return count;
}

function pageRequestKey(page: PageKey): string {
  return `page:${page.sequence}:offset:${page.offset}:expected:${page.expectedRows}:asof:${page.sourceAsOfEpochMs}`;
}

function parsePageRequestKey(value: string): PageKey {
  const match = /^page:(\d+):offset:(\d+):expected:(\d+):asof:(\d+)$/u.exec(value);
  if (match === null) {
    throw providerError('QUERY_REGRESSION', `Malformed page request key: ${value}`, 'decode');
  }
  const sequence = Number(match[1]);
  const offset = Number(match[2]);
  const expectedRows = Number(match[3]);
  const sourceAsOfEpochMs = Number(match[4]);
  if (![sequence, offset, expectedRows, sourceAsOfEpochMs].every(Number.isSafeInteger)) {
    throw providerError('QUERY_REGRESSION', 'Unsafe pagination values', 'decode');
  }
  return Object.freeze({ sequence, offset, expectedRows, sourceAsOfEpochMs });
}

function buildPageUrl(offset: number, limit: number): string {
  const url = new URL(MTC_PALO_ALTO_RESOURCE_URL);
  url.searchParams.set('$select', MTC_PALO_ALTO_FIELDS.join(','));
  url.searchParams.set('$order', 'objectid ASC');
  url.searchParams.set('$limit', String(limit));
  url.searchParams.set('$offset', String(offset));
  return url.toString();
}

function canonicalize(value: JsonValue | SpiJsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
    .join(',')}}`;
}

function asJsonObject(value: unknown): MtcPaloAltoRawRow {
  const parsed = jsonValueSchema.safeParse(value);
  if (
    !parsed.success ||
    typeof parsed.data !== 'object' ||
    parsed.data === null ||
    Array.isArray(parsed.data)
  ) {
    throw providerError('SCHEMA_DRIFT', 'Socrata row is not a JSON object', 'decode');
  }
  return Object.freeze(parsed.data);
}

function stringField(row: MtcPaloAltoRawRow, field: MtcPaloAltoField): string | null {
  const value = row[field];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function normalizeMtcPaloAltoApn(input: string): string | null {
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/gu, '');
  if (!/^\d{8}$/u.test(compact)) return null;
  return `${compact.slice(0, 3)}-${compact.slice(3, 5)}-${compact.slice(5)}`;
}

function parseYear(value: string | null, modifiedAt: string | null): number | null | 'invalid' {
  if (value === null || value === '0') return null;
  const year = Number(value);
  const observedYear = modifiedAt === null ? 2100 : new Date(modifiedAt).getUTCFullYear() + 1;
  return Number.isInteger(year) && year >= 1700 && year <= observedYear ? year : 'invalid';
}

function validateGeometry(value: unknown): GeoMultiPolygon | null {
  const parsed = geoMultiPolygonSchema.safeParse(value);
  if (!parsed.success) return null;
  for (const polygon of parsed.data.coordinates) {
    for (const ring of polygon) {
      const first = ring[0];
      const last = ring.at(-1);
      if (first === undefined || first[0] !== last?.[0] || first[1] !== last[1]) {
        return null;
      }
      for (const [longitude, latitude] of ring) {
        if (
          longitude < PALO_ALTO_WGS84_BOUNDS.west ||
          longitude > PALO_ALTO_WGS84_BOUNDS.east ||
          latitude < PALO_ALTO_WGS84_BOUNDS.south ||
          latitude > PALO_ALTO_WGS84_BOUNDS.north
        ) {
          return null;
        }
      }
    }
  }
  return parsed.data;
}

function issue(
  code: string,
  severity: ValidationIssue['severity'],
  message: string,
  recordKey: string,
  fieldPath: string | null,
): ValidationIssue {
  return Object.freeze({ code, severity, message, recordKey, fieldPath });
}

function sourceAsOfFromArtifact(artifact: AcquiredArtifactSource): string | null {
  const value = artifact.metadata.sourceAsOf;
  return value.state === 'unknown' ? null : value.at;
}

function fieldLineage(
  record: MtcPaloAltoValidatedRecord,
  fieldPath: string,
  value: JsonValue,
): FieldLineage {
  const outputSha256 = createHash('sha256').update(canonicalize(value)).digest('hex');
  const transformation = Object.freeze({
    name: `mtc-palo-alto:${fieldPath}`,
    version: MTC_PALO_ALTO_TRANSFORM_VERSION,
    appliedAt: record.retrievedAt,
    inputSha256: record.recordSha256,
    outputSha256,
  });
  const lineageSha256 = createHash('sha256')
    .update(record.recordSha256)
    .update('\0')
    .update(fieldPath)
    .update('\0')
    .update(outputSha256)
    .digest('hex');
  return fieldLineageSchema.parse({
    sourceRecord: {
      sourceId: MTC_PALO_ALTO_SOURCE_ID,
      snapshotId: record.snapshotId,
      artifactId: record.artifactId,
      recordKey: record.recordKey,
      recordSha256: record.recordSha256,
      rawPointer: record.rawPointer,
    },
    transformations: [transformation],
    lineageSha256,
  });
}

function deterministicId(prefix: string, ...parts: readonly string[]): string {
  const hash = createHash('sha256').update(parts.join('\0')).digest('hex');
  return `${prefix}${hash}`;
}

function checkpointScope(plan: AcquisitionPlan): string {
  return `${CHECKPOINT_SCOPE_PREFIX}/${plan.snapshotId}`;
}

function createSourceCheckpoint(
  plan: AcquisitionPlan,
  previous: SourceCheckpoint | undefined,
  itemSequence: number,
  artifactId: SourceCheckpoint['acquiredArtifactIds'][number],
  updatedAt: string,
): SourceCheckpoint {
  const completedRequestKeys = [
    ...(previous?.completedRequestKeys ?? []),
    plan.items[itemSequence]?.requestKey ?? '',
  ];
  const acquiredArtifactIds = [...(previous?.acquiredArtifactIds ?? [])];
  if (!acquiredArtifactIds.includes(artifactId)) acquiredArtifactIds.push(artifactId);
  const nextSequence = itemSequence + 1;
  return sourceCheckpointSchema.parse({
    sourceId: plan.sourceId,
    snapshotId: plan.snapshotId,
    contractVersion: plan.contractVersion,
    cursor: `sequence:${nextSequence}`,
    nextSequence,
    completedRequestKeys,
    acquiredArtifactIds,
    updatedAt,
    complete: nextSequence === plan.items.length,
  });
}

export class MtcPaloAltoYearBuiltAdapter implements StreamingSourceAdapter<
  MtcPaloAltoDecodedRecord,
  MtcPaloAltoValidatedRecord
> {
  readonly #pageSize: number;
  readonly #maximumResponseBytes: number;

  public constructor(options: AdapterOptions = {}) {
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50_000) {
      throw new RangeError('pageSize must be a safe integer from 1 through 50000');
    }
    const maximumResponseBytes = options.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES;
    if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1) {
      throw new RangeError('maximumResponseBytes must be a positive safe integer');
    }
    this.#pageSize = pageSize;
    this.#maximumResponseBytes = maximumResponseBytes;
  }

  public describe(): SourceDescriptor {
    return DESCRIPTOR;
  }

  public async discover(context: DiscoveryContext): Promise<DiscoveryResult> {
    const metadataResponse = await requestWithRetry(
      MTC_PALO_ALTO_METADATA_URL,
      context,
      'discover',
    );
    const metadataBytes = await collectDiscoveryBody(metadataResponse.response, context.signal);
    const metadata = readMetadata(parseJson(metadataBytes, 'Socrata metadata'));
    const countResponse = await requestWithRetry(COUNT_QUERY_URL, context, 'discover');
    const countBytes = await collectDiscoveryBody(countResponse.response, context.signal);
    const expectedRecords = readCount(parseJson(countBytes, 'Socrata count response'));
    return Object.freeze({
      sourceId: MTC_PALO_ALTO_SOURCE_ID,
      discoveredAt: context.clock.now(),
      resources: Object.freeze([
        Object.freeze({
          requestKey: MTC_PALO_ALTO_DATASET_ID,
          url: MTC_PALO_ALTO_RESOURCE_URL,
          sourceAsOf: { state: 'reported' as const, at: metadata.sourceAsOf },
          expectedRecords,
          mediaTypes: Object.freeze(['application/json']),
          continuationToken: null,
        }),
      ]),
      complete: true,
      limitations: Object.freeze([
        'Palo Alto subset enrichment only; excluded from the Santa Clara county denominator.',
        'Redistribution rights are pending; all output remains prohibited_public.',
        `Backing ArcGIS source retained: ${metadata.arcgisUrl}`,
      ]),
    });
  }

  public async plan(
    request: AcquisitionRequest,
    discovery: DiscoveryResult,
    context: PlanningContext,
  ): Promise<AcquisitionPlan> {
    await Promise.resolve();
    context.signal.throwIfAborted();
    if (request.sourceId !== MTC_PALO_ALTO_SOURCE_ID || discovery.sourceId !== request.sourceId) {
      throw providerError('RECORD_QUALITY', 'Request/discovery source mismatch', 'plan');
    }
    const expectedRecords = discovery.resources[0]?.expectedRecords;
    if (expectedRecords === undefined || expectedRecords === null) {
      throw providerError(
        'QUERY_REGRESSION',
        'Uncapped pagination requires an exact count',
        'plan',
      );
    }
    const discoveredAsOf = discovery.resources[0]?.sourceAsOf;
    if (
      discoveredAsOf === undefined ||
      discoveredAsOf.state === 'unknown' ||
      request.requestedSourceAsOf.state === 'unknown' ||
      discoveredAsOf.at !== request.requestedSourceAsOf.at
    ) {
      throw providerError(
        'QUERY_REGRESSION',
        'Acquisition request must bind the exact discovered source-as-of',
        'plan',
      );
    }
    const sourceAsOfEpochMs = Date.parse(discoveredAsOf.at);
    if (!Number.isSafeInteger(sourceAsOfEpochMs)) {
      throw providerError('QUERY_REGRESSION', 'Invalid discovered source-as-of', 'plan');
    }
    const pages = Math.max(1, Math.ceil(expectedRecords / this.#pageSize));
    const items = Array.from({ length: pages }, (_, sequence) => {
      const offset = sequence * this.#pageSize;
      const expectedRows = Math.max(0, Math.min(this.#pageSize, expectedRecords - offset));
      return Object.freeze({
        requestKey: pageRequestKey({ sequence, offset, expectedRows, sourceAsOfEpochMs }),
        sequence,
        method: 'GET' as const,
        url: buildPageUrl(offset, this.#pageSize),
        encoding: 'json' as const,
        expectedMediaTypes: ['application/json'],
      });
    });
    return acquisitionPlanSchema.parse({
      sourceId: request.sourceId,
      snapshotId: request.snapshotId,
      contractVersion: MTC_PALO_ALTO_CONTRACT_VERSION,
      plannedAt: context.clock.now(),
      items,
    });
  }

  public async *acquire(
    plan: AcquisitionPlan,
    checkpoint: SourceCheckpoint | undefined,
    context: StreamingAcquisitionContext,
  ): AsyncIterable<AcquiredArtifactSource> {
    if (plan.sourceId !== MTC_PALO_ALTO_SOURCE_ID) {
      throw providerError(
        'RECORD_QUALITY',
        'Acquisition plan belongs to another source',
        'acquire',
      );
    }
    if (
      checkpoint !== undefined &&
      (checkpoint.sourceId !== plan.sourceId || checkpoint.snapshotId !== plan.snapshotId)
    ) {
      throw providerError(
        'RECORD_QUALITY',
        'Checkpoint belongs to another source snapshot',
        'acquire',
      );
    }
    const scope = checkpointScope(plan);
    let stored = await context.checkpointStore.load(scope);
    let persistedCheckpoint: SourceCheckpoint | undefined;
    if (stored !== undefined) {
      const parsed = sourceCheckpointSchema.safeParse(stored.payload);
      if (!parsed.success) {
        throw providerError(
          'QUERY_REGRESSION',
          'Persisted checkpoint payload is invalid',
          'acquire',
        );
      }
      persistedCheckpoint = parsed.data;
      if (
        persistedCheckpoint.sourceId !== plan.sourceId ||
        persistedCheckpoint.snapshotId !== plan.snapshotId ||
        persistedCheckpoint.contractVersion !== plan.contractVersion
      ) {
        throw providerError(
          'QUERY_REGRESSION',
          'Persisted checkpoint belongs to another acquisition plan',
          'acquire',
        );
      }
    }
    if (
      checkpoint !== undefined &&
      persistedCheckpoint !== undefined &&
      JSON.stringify(checkpoint) !== JSON.stringify(persistedCheckpoint)
    ) {
      throw providerError(
        'QUERY_REGRESSION',
        'Supplied checkpoint disagrees with persisted checkpoint',
        'acquire',
      );
    }
    let currentCheckpoint = persistedCheckpoint ?? checkpoint;
    const orderedItems = [...plan.items].sort((left, right) => left.sequence - right.sequence);
    if (currentCheckpoint !== undefined) {
      const expectedKeys = orderedItems
        .slice(0, currentCheckpoint.nextSequence)
        .map((item) => item.requestKey);
      if (
        currentCheckpoint.nextSequence > orderedItems.length ||
        currentCheckpoint.completedRequestKeys.length !== currentCheckpoint.nextSequence ||
        currentCheckpoint.acquiredArtifactIds.length > currentCheckpoint.nextSequence ||
        currentCheckpoint.completedRequestKeys.some((key, index) => key !== expectedKeys[index]) ||
        currentCheckpoint.complete !== (currentCheckpoint.nextSequence === orderedItems.length)
      ) {
        throw providerError(
          'QUERY_REGRESSION',
          'Checkpoint does not describe an exact contiguous acquisition prefix',
          'acquire',
        );
      }
    }
    const recoveredArtifactIds: SourceCheckpoint['acquiredArtifactIds'][number][] = [];
    for (const item of orderedItems) {
      context.signal.throwIfAborted();
      const wasCompleted = item.sequence < (currentCheckpoint?.nextSequence ?? 0);
      const page = parsePageRequestKey(item.requestKey);
      const logicalKey = `raw/mtc-palo-alto-year-built/${plan.snapshotId}/${String(item.sequence).padStart(6, '0')}.json`;
      let storedArtifact = await context.artifactStore.headByLogicalKey(logicalKey);
      if (wasCompleted && storedArtifact === undefined) {
        throw providerError(
          'QUERY_REGRESSION',
          `Checkpoint references a missing immutable page artifact: ${item.requestKey}`,
          'acquire',
        );
      }
      if (storedArtifact === undefined) {
        const { response, attempt } = await requestWithRetry(item.url, context, 'acquire');
        const responseMediaType = header(response.headers, 'content-type');
        const mediaType = responseMediaType?.split(';')[0]?.trim().toLowerCase();
        if (mediaType === undefined || !item.expectedMediaTypes.includes(mediaType)) {
          throw providerError(
            'SCHEMA_DRIFT',
            `Unexpected response media type: ${responseMediaType ?? 'missing'}`,
            'acquire',
          );
        }
        const retrievedAt = context.clock.now();
        storedArtifact = await persistAcquiredBody({
          store: context.artifactStore,
          logicalKey,
          mediaType,
          body: response.body,
          maximumBytes: this.#maximumResponseBytes,
          metadata: Object.freeze({
            authority: DESCRIPTOR.authority.organization,
            sourceId: plan.sourceId,
            snapshotId: plan.snapshotId,
            datasetId: MTC_PALO_ALTO_DATASET_ID,
            requestKey: item.requestKey,
            requestUrl: item.url,
            sourceAsOf: new Date(page.sourceAsOfEpochMs).toISOString(),
            retrievedAt,
            attempt: String(attempt),
            httpStatus: String(response.status),
            etag: header(response.headers, 'etag') ?? '',
            lastModified: header(response.headers, 'last-modified') ?? '',
            finalUrl: item.url,
            backingArcgisUrl: MTC_PALO_ALTO_ARCGIS_URL,
          }),
          signal: context.signal,
        });
      }
      const metadata = acquiredMetadataFromStored(plan, item, storedArtifact);
      const acquired = await createStreamingAcquiredArtifact(metadata, context.artifactStore);
      if (wasCompleted) {
        if (!currentCheckpoint?.acquiredArtifactIds.includes(acquired.metadata.artifactId)) {
          throw providerError(
            'QUERY_REGRESSION',
            `Checkpoint artifact identity mismatches recovered page: ${item.requestKey}`,
            'acquire',
          );
        }
        if (!recoveredArtifactIds.includes(acquired.metadata.artifactId)) {
          recoveredArtifactIds.push(acquired.metadata.artifactId);
        }
        if (
          item.sequence + 1 === currentCheckpoint.nextSequence &&
          (recoveredArtifactIds.length !== currentCheckpoint.acquiredArtifactIds.length ||
            recoveredArtifactIds.some(
              (candidate, index) => candidate !== currentCheckpoint?.acquiredArtifactIds[index],
            ))
        ) {
          throw providerError(
            'QUERY_REGRESSION',
            'Checkpoint artifact identities do not exactly match the recovered immutable prefix',
            'acquire',
          );
        }
        yield acquired;
        continue;
      }
      const retrievedAt = acquired.metadata.retrievedAt;
      currentCheckpoint = createSourceCheckpoint(
        plan,
        currentCheckpoint,
        item.sequence,
        acquired.metadata.artifactId,
        retrievedAt,
      );
      const envelope = createCheckpointEnvelope({
        scope,
        previousRevision: stored?.revision ?? null,
        writtenAt: retrievedAt,
        payload: currentCheckpoint,
      });
      const result = await context.checkpointStore.commit({
        expectedRevision: stored?.revision ?? null,
        checkpoint: envelope,
      });
      if (result.status === 'conflict') {
        throw providerError('QUERY_REGRESSION', 'Concurrent checkpoint update detected', 'acquire');
      }
      stored = result.checkpoint;
      yield acquired;
    }
  }

  public async *decode(
    artifact: AcquiredArtifactSource,
    context: StreamingDecodeContext,
  ): AsyncIterable<MtcPaloAltoDecodedRecord> {
    context.signal.throwIfAborted();
    if (artifact.metadata.schemaFingerprint.value !== MTC_PALO_ALTO_SCHEMA_FINGERPRINT) {
      throw providerError(
        'SCHEMA_DRIFT',
        'Artifact schema fingerprint does not match provider',
        'decode',
      );
    }
    const page = parsePageRequestKey(artifact.metadata.request.requestKey);
    let localOrdinal = 0;
    for await (const rawValue of streamTopLevelJsonObjects(
      artifactRead(artifact),
      context.signal,
    )) {
      context.signal.throwIfAborted();
      const ordinal = page.offset + localOrdinal;
      if (!Number.isSafeInteger(ordinal)) {
        throw providerError('QUERY_REGRESSION', 'Global record ordinal is unsafe', 'decode');
      }
      const raw = asJsonObject(rawValue);
      const objectId = stringField(raw, 'objectid') ?? `missing-objectid-${localOrdinal}`;
      const geometryValue = raw.the_geom;
      const geometryObject: Readonly<Record<string, SpiJsonValue>> | null =
        typeof geometryValue === 'object' && geometryValue !== null && !Array.isArray(geometryValue)
          ? (geometryValue as Readonly<Record<string, SpiJsonValue>>)
          : null;
      const geometryType = geometryObject?.type;
      const coordinates = geometryObject?.coordinates;
      const recordSha256 = createHash('sha256').update(canonicalize(raw)).digest('hex');
      yield Object.freeze({
        format: 'geojson',
        featureType: 'Feature',
        artifactId: artifact.metadata.artifactId,
        ordinal,
        visibility: MTC_PALO_ALTO_VISIBILITY,
        geometry:
          typeof geometryType === 'string' && coordinates !== undefined
            ? Object.freeze({ type: geometryType, coordinates })
            : null,
        properties: raw,
        snapshotId: artifact.metadata.snapshotId,
        retrievedAt: artifact.metadata.retrievedAt,
        sourceAsOf: sourceAsOfFromArtifact(artifact),
        recordKey: objectId,
        recordSha256,
        rawPointer: `/${localOrdinal}`,
        raw,
      });
      localOrdinal += 1;
      await Promise.resolve();
    }
    if (localOrdinal !== page.expectedRows) {
      throw providerError(
        'QUERY_REGRESSION',
        `Socrata page ${page.sequence} expected ${page.expectedRows} rows but received ${localOrdinal}`,
        'decode',
      );
    }
  }

  public async validate(
    record: MtcPaloAltoDecodedRecord,
    context: ValidationContext,
  ): Promise<RecordValidation<MtcPaloAltoValidatedRecord>> {
    context.signal.throwIfAborted();
    const issues: ValidationIssue[] = [];
    const objectId = stringField(record.raw, 'objectid');
    const apnInput = stringField(record.raw, 'apn');
    const canonicalApn = apnInput === null ? null : normalizeMtcPaloAltoApn(apnInput);
    const modifiedAt = stringField(record.raw, 'modifieddate');
    const yearBuilt = parseYear(stringField(record.raw, 'yearbuilt'), modifiedAt);
    const effectiveYearBuilt = parseYear(stringField(record.raw, 'effectiveyearbuilt'), modifiedAt);
    const x = Number(stringField(record.raw, 'x'));
    const y = Number(stringField(record.raw, 'y'));
    const geometry = validateGeometry(record.raw.the_geom);

    if (objectId === null || !/^\d+$/u.test(objectId)) {
      issues.push(
        issue(
          'INVALID_OBJECT_ID',
          'error',
          'objectid must be numeric',
          record.recordKey,
          '/objectid',
        ),
      );
    }
    if (apnInput === null || canonicalApn === null) {
      issues.push(
        issue('INVALID_APN', 'error', 'APN must normalize to 8 digits', record.recordKey, '/apn'),
      );
    }
    if (geometry === null) {
      issues.push(
        issue(
          'INVALID_GEOMETRY_OR_SUBSET',
          'error',
          'Geometry must be a closed WGS84 MultiPolygon inside Palo Alto bounds',
          record.recordKey,
          '/the_geom',
        ),
      );
    }
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < PALO_ALTO_EPSG_2227_BOUNDS.west ||
      x > PALO_ALTO_EPSG_2227_BOUNDS.east ||
      y < PALO_ALTO_EPSG_2227_BOUNDS.south ||
      y > PALO_ALTO_EPSG_2227_BOUNDS.north
    ) {
      issues.push(
        issue(
          'INVALID_SOURCE_COORDINATES',
          'error',
          'X/Y must be within the backing ArcGIS EPSG:2227 extent',
          record.recordKey,
          '/x',
        ),
      );
    }
    if (yearBuilt === 'invalid') {
      issues.push(
        issue(
          'INVALID_YEAR_BUILT',
          'error',
          'yearbuilt is outside valid bounds',
          record.recordKey,
          '/yearbuilt',
        ),
      );
    }
    if (effectiveYearBuilt === 'invalid') {
      issues.push(
        issue(
          'INVALID_EFFECTIVE_YEAR_BUILT',
          'error',
          'effectiveyearbuilt is outside valid bounds',
          record.recordKey,
          '/effectiveyearbuilt',
        ),
      );
    }
    if (yearBuilt === null) {
      issues.push(
        issue(
          'YEAR_BUILT_UNKNOWN',
          'warning',
          'yearbuilt is absent or source sentinel 0',
          record.recordKey,
          '/yearbuilt',
        ),
      );
    }
    if (effectiveYearBuilt === null) {
      issues.push(
        issue(
          'EFFECTIVE_YEAR_BUILT_UNKNOWN',
          'warning',
          'effectiveyearbuilt is absent or source sentinel 0',
          record.recordKey,
          '/effectiveyearbuilt',
        ),
      );
    }
    if (
      typeof yearBuilt === 'number' &&
      typeof effectiveYearBuilt === 'number' &&
      effectiveYearBuilt < yearBuilt
    ) {
      issues.push(
        issue(
          'YEAR_SEMANTIC_CONFLICT',
          'warning',
          'effective year precedes original year; both source semantics are preserved',
          record.recordKey,
          '/effectiveyearbuilt',
        ),
      );
    }
    const fatal = issues.some((entry) => entry.severity === 'error' || entry.severity === 'fatal');
    if (
      fatal ||
      objectId === null ||
      apnInput === null ||
      canonicalApn === null ||
      geometry === null ||
      yearBuilt === 'invalid' ||
      effectiveYearBuilt === 'invalid'
    ) {
      return Promise.resolve(Object.freeze({ status: 'rejected', issues: Object.freeze(issues) }));
    }
    return Promise.resolve(
      Object.freeze({
        status: 'accepted',
        record: Object.freeze({
          visibility: MTC_PALO_ALTO_VISIBILITY,
          artifactId: record.artifactId,
          snapshotId: record.snapshotId,
          retrievedAt: record.retrievedAt,
          sourceAsOf: record.sourceAsOf,
          ordinal: record.ordinal,
          recordKey: record.recordKey,
          recordSha256: record.recordSha256,
          rawPointer: record.rawPointer,
          raw: record.raw,
          objectId,
          gid: stringField(record.raw, 'gid'),
          apnInput,
          canonicalApn,
          yearBuilt,
          effectiveYearBuilt,
          zoning: stringField(record.raw, 'zonegis'),
          floodZone: stringField(record.raw, 'floodzone'),
          nearCreek: stringField(record.raw, 'nearcreekfeature'),
          addressDescription: stringField(record.raw, 'addressdescription'),
          modifiedAt,
          sourceCoordinates: Object.freeze({ x, y, crs: 'EPSG:2227', semantics: 'label_point' }),
          geometry,
          issues: Object.freeze(issues),
        }),
        issues: Object.freeze(issues),
      }),
    );
  }

  public async *normalize(
    record: MtcPaloAltoValidatedRecord,
    context: NormalizationContext,
  ): AsyncIterable<CanonicalMutation> {
    await Promise.resolve();
    context.signal.throwIfAborted();
    const propertyHash = createHash('sha256')
      .update(`santa-clara-ca|apn|${record.canonicalApn}`)
      .digest('hex');
    const propertyId = `sc:entity:property:${propertyHash}`;
    const apnLineage = fieldLineage(record, '/apn', record.canonicalApn);
    const geometryLineage = fieldLineage(record, '/parcelGeometry', record.geometry);
    const entity = propertySchema.parse({
      id: propertyId,
      entityKind: 'property',
      version: 1,
      validFrom: record.modifiedAt ?? record.sourceAsOf ?? record.retrievedAt,
      validTo: null,
      recordedAt: record.retrievedAt,
      visibility: MTC_PALO_ALTO_VISIBILITY,
      sourceIds: [MTC_PALO_ALTO_SOURCE_ID],
      lineage: [apnLineage, geometryLineage],
      county: 'Santa Clara',
      state: 'CA',
      apn: record.canonicalApn,
      jurisdiction: 'Palo Alto',
      primaryAddressId: null,
      unitIds: [],
      parcelGeometry: record.geometry,
      landAreaSquareMeters: null,
    });
    const values: readonly Readonly<{ path: string; value: JsonValue }>[] = Object.freeze([
      { path: '/apnInput', value: record.apnInput },
      { path: '/yearBuilt', value: record.yearBuilt },
      { path: '/effectiveYearBuilt', value: record.effectiveYearBuilt },
      { path: '/zoning', value: record.zoning },
      { path: '/floodZone', value: record.floodZone },
      { path: '/nearCreek', value: record.nearCreek },
      { path: '/sourceCoordinates', value: record.sourceCoordinates },
      { path: '/parcelGeometry', value: record.geometry as JsonValue },
      { path: '/sourceAddressDescription', value: record.addressDescription },
      { path: '/sourceObjectId', value: record.objectId },
    ]);
    const baseParts = [record.snapshotId, record.artifactId, record.recordKey];
    const entityMutation = canonicalMutationSchema.parse({
      kind: 'entity_upsert',
      mutationId: deterministicId('sc:mutation:', ...baseParts, 'entity'),
      runId: deterministicId('sc:run:', record.snapshotId, 'mtc-palo-alto-normalize'),
      sourceId: MTC_PALO_ALTO_SOURCE_ID,
      snapshotId: record.snapshotId,
      sequence: record.ordinal * (values.length + 1),
      emittedAt: record.retrievedAt,
      visibility: MTC_PALO_ALTO_VISIBILITY,
      entity,
    });
    yield entityMutation;
    for (const [index, field] of values.entries()) {
      context.signal.throwIfAborted();
      const lineage = fieldLineage(record, field.path, field.value);
      const observationId = deterministicId('sc:observation:', ...baseParts, field.path);
      yield canonicalMutationSchema.parse({
        kind: 'field_observation',
        mutationId: deterministicId('sc:mutation:', ...baseParts, field.path),
        runId: deterministicId('sc:run:', record.snapshotId, 'mtc-palo-alto-normalize'),
        sourceId: MTC_PALO_ALTO_SOURCE_ID,
        snapshotId: record.snapshotId,
        sequence: record.ordinal * (values.length + 1) + index + 1,
        emittedAt: record.retrievedAt,
        visibility: MTC_PALO_ALTO_VISIBILITY,
        observation: {
          observationId,
          entityId: propertyId,
          entityKind: 'property',
          fieldPath: field.path,
          value: field.value,
          observedAt: record.modifiedAt ?? record.sourceAsOf ?? record.retrievedAt,
          sourceAsOf: record.sourceAsOf,
          authorityRank: DESCRIPTOR.authority.authorityRank,
          confidence: field.path === '/yearBuilt' || field.path === '/effectiveYearBuilt' ? 0.8 : 1,
          visibility: MTC_PALO_ALTO_VISIBILITY,
          lineage,
        },
      });
    }
  }

  public async summarize(
    run: SourceRunObservationV2,
    context: SummaryContext,
  ): Promise<SourceRunSummary> {
    context.signal.throwIfAborted();
    const expectedRecords = run.plan.items.reduce(
      (total, item) => total + parsePageRequestKey(item.requestKey).expectedRows,
      0,
    );
    if (run.decodedRecords !== expectedRecords || run.artifacts.length !== run.plan.items.length) {
      throw providerError(
        'QUERY_REGRESSION',
        `Run count mismatch: expected ${expectedRecords}, decoded ${run.decodedRecords}`,
        'summarize',
      );
    }
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
    let errorCount = 0;
    let warningCount = 0;
    for await (const entry of run.validationIssues.read()) {
      context.signal.throwIfAborted();
      if (entry.severity === 'warning') warningCount += 1;
      else errorCount += 1;
    }
    const status = run.aborted
      ? 'aborted'
      : errorCount > 0 || run.rejectedRecords > 0
        ? 'partial'
        : 'succeeded';
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
      normalizedMutations: run.mutations.count,
      visibilityCounts,
      warningCount,
      errorCount,
      finalCheckpoint: run.finalCheckpoint,
    });
  }
}

export function createMtcPaloAltoYearBuiltAdapter(
  options: AdapterOptions = {},
): MtcPaloAltoYearBuiltAdapter {
  return new MtcPaloAltoYearBuiltAdapter(options);
}
