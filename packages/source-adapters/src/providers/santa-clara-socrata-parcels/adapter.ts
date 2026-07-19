import { createCheckpointEnvelope } from '@oracle/artifacts/checkpoint-store';
import type { StoredArtifact } from '@oracle/artifacts/artifact-store';
import {
  canonicalMutationSchema,
  type CanonicalMutation,
} from '@oracle/contracts/canonical/mutation';
import type { FieldLineage } from '@oracle/contracts/canonical/lineage';
import { oracleErrorSchema, type OracleErrorCode } from '@oracle/contracts/errors';
import type { ArtifactId } from '@oracle/contracts/ids';
import {
  acquisitionPlanSchema,
  acquiredArtifactSchema,
  sourceCheckpointSchema,
  sourceRunSummarySchema,
  type AcquiredArtifact,
  type AcquisitionPlan,
  type AcquisitionRequest,
  type SourceAsOf,
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
import { sha256Hex } from '../../spi/bytes.js';
import type { JsonValue } from '../../spi/decode.js';
import type { HttpResponse } from '../../spi/http.js';
import {
  SANTA_CLARA_PARCELS_API_ROOT,
  SANTA_CLARA_PARCELS_COUNT_URLS,
  SANTA_CLARA_PARCELS_CRS,
  SANTA_CLARA_PARCELS_DESCRIPTOR,
  SANTA_CLARA_PARCELS_METADATA_URL,
  SANTA_CLARA_PARCELS_SCHEMA_COLUMNS,
  SANTA_CLARA_PARCELS_SCHEMA_FINGERPRINT,
  SANTA_CLARA_PARCELS_SOURCE_ID,
} from './constants.js';
import {
  normalizeSantaClaraParcelApn,
  parseCrs84MultiPolygon,
  sha256Text,
  stableJson,
  type SantaClaraParcelDecodedRecord,
  type SantaClaraParcelValidatedRecord,
} from './records.js';
import { inspectGeoJsonEnvelope, streamJsonObjectArrayProperty } from './streaming-json.js';

const ACCEPT_GEOJSON = 'application/geo+json, application/vnd.geo+json, application/json';
const ACCEPT_JSON = 'application/json';
const DEFAULT_PAGE_SIZE = 5_000;
const MAX_PAGE_SIZE = 50_000;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 128 * 1024 * 1024;
const MAXIMUM_DISCOVERY_BYTES = 2 * 1024 * 1024;
const TEXT_ENCODER = new TextEncoder();

interface AdapterOptions {
  readonly pageSize?: number;
  readonly maximumResponseBytes?: number;
}

interface RequestContext {
  readonly http: DiscoveryContext['http'];
  readonly delay: DiscoveryContext['delay'];
  readonly ratePolicy: DiscoveryContext['ratePolicy'];
  readonly signal: AbortSignal;
}

interface ResponseWithAttempt {
  readonly response: HttpResponse;
  readonly attempt: number;
}

interface MetadataColumn {
  readonly position: number;
  readonly fieldName: string;
  readonly dataTypeName: string;
}

interface ParsedMetadata {
  readonly columns: readonly MetadataColumn[];
  readonly sourceAsOf: SourceAsOf;
}

class SantaClaraParcelsError extends Error {
  public readonly code: OracleErrorCode;
  public readonly retryable: boolean;
  public readonly sourceId: string;
  public readonly phase: string;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(input: {
    readonly code: OracleErrorCode;
    readonly message: string;
    readonly phase: string;
    readonly details: Readonly<Record<string, unknown>>;
  }) {
    const parsed = oracleErrorSchema.parse({
      code: input.code,
      retryable: input.code === 'TRANSIENT_SOURCE',
      message: input.message,
      sourceId: SANTA_CLARA_PARCELS_SOURCE_ID,
      phase: input.phase,
      details: input.details,
    });
    super(parsed.message);
    this.name = 'SantaClaraParcelsError';
    this.code = parsed.code;
    this.retryable = parsed.retryable;
    this.sourceId = parsed.sourceId ?? SANTA_CLARA_PARCELS_SOURCE_ID;
    this.phase = parsed.phase ?? input.phase;
    this.details = parsed.details ?? {};
  }
}

function sourceError(
  code: OracleErrorCode,
  message: string,
  phase: string,
  details: Readonly<Record<string, unknown>> = {},
): SantaClaraParcelsError {
  return new SantaClaraParcelsError({ code, message, phase, details });
}

function header(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const target = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === target)?.[1];
}

function retryAfterMilliseconds(response: HttpResponse): number | undefined {
  const value = header(response.headers, 'retry-after');
  if (value === undefined) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

function backoffMilliseconds(context: RequestContext, attempt: number): number {
  return Math.min(
    context.ratePolicy.maxBackoffMs,
    context.ratePolicy.initialBackoffMs * 2 ** Math.max(0, attempt - 1),
  );
}

async function requestWithRetry(
  url: string,
  accept: string,
  context: RequestContext,
): Promise<ResponseWithAttempt> {
  let lastFailure: unknown;
  for (let attempt = 1; attempt <= context.ratePolicy.maxAttempts; attempt += 1) {
    context.signal.throwIfAborted();
    try {
      const response = await context.http.send(
        { method: 'GET', url, headers: { accept } },
        context.signal,
      );
      if (response.status >= 200 && response.status < 300) {
        return Object.freeze({ response, attempt });
      }
      if (response.status === 401) {
        throw sourceError(
          'AUTHENTICATION',
          'Official Socrata endpoint required authentication',
          'acquire',
          {
            status: response.status,
            url,
          },
        );
      }
      if (response.status === 403) {
        throw sourceError(
          'TERMS_ACCESS',
          'Official Socrata endpoint denied public access',
          'acquire',
          {
            status: response.status,
            url,
          },
        );
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) {
        throw sourceError(
          'RECORD_QUALITY',
          'Official Socrata endpoint returned a permanent HTTP failure',
          'acquire',
          {
            status: response.status,
            url,
          },
        );
      }
      lastFailure = sourceError(
        'TRANSIENT_SOURCE',
        'Official Socrata endpoint returned a transient HTTP failure',
        'acquire',
        {
          status: response.status,
          url,
          attempt,
        },
      );
      if (attempt < context.ratePolicy.maxAttempts) {
        const retryAfter = context.ratePolicy.respectRetryAfter
          ? retryAfterMilliseconds(response)
          : undefined;
        await context.delay.wait(
          retryAfter ?? backoffMilliseconds(context, attempt),
          context.signal,
        );
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      if (
        typeof error === 'object' &&
        error !== null &&
        'retryable' in error &&
        error.retryable === false
      ) {
        throw error;
      }
      lastFailure = error;
      if (attempt < context.ratePolicy.maxAttempts) {
        await context.delay.wait(backoffMilliseconds(context, attempt), context.signal);
      }
    }
  }
  throw sourceError(
    'TRANSIENT_SOURCE',
    'Official Socrata request exhausted its bounded retry budget',
    'acquire',
    {
      url,
      cause: lastFailure instanceof Error ? lastFailure.message : String(lastFailure),
    },
  );
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
      throw sourceError(
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

function parseJson(bytes: Uint8Array, phase: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw sourceError('SCHEMA_DRIFT', 'Official Socrata response is not valid UTF-8 JSON', phase, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }
  return isObject(value) && Object.values(value).every((item) => isJsonValue(item));
}

function parseMetadata(value: unknown): ParsedMetadata {
  if (!isObject(value) || !Array.isArray(value.columns)) {
    throw sourceError('SCHEMA_DRIFT', 'Socrata metadata omitted its columns array', 'discover');
  }
  const columns = value.columns.map((column) => {
    if (
      !isObject(column) ||
      typeof column.position !== 'number' ||
      !Number.isInteger(column.position) ||
      typeof column.fieldName !== 'string' ||
      typeof column.dataTypeName !== 'string'
    ) {
      throw sourceError(
        'SCHEMA_DRIFT',
        'Socrata metadata contains an invalid column declaration',
        'discover',
      );
    }
    return Object.freeze({
      position: column.position,
      fieldName: column.fieldName,
      dataTypeName: column.dataTypeName,
    });
  });
  const ordered = Object.freeze([...columns].sort((left, right) => left.position - right.position));
  const actualFingerprint = sha256Text(JSON.stringify(ordered));
  if (actualFingerprint !== SANTA_CLARA_PARCELS_SCHEMA_FINGERPRINT) {
    throw sourceError('SCHEMA_DRIFT', 'Socrata parcel schema fingerprint changed', 'discover', {
      expected: SANTA_CLARA_PARCELS_SCHEMA_FINGERPRINT,
      actual: actualFingerprint,
      expectedColumns: SANTA_CLARA_PARCELS_SCHEMA_COLUMNS,
      actualColumns: ordered,
    });
  }
  const rowsUpdatedAt = value.rowsUpdatedAt;
  const sourceAsOf: SourceAsOf =
    typeof rowsUpdatedAt === 'number' && Number.isSafeInteger(rowsUpdatedAt) && rowsUpdatedAt > 0
      ? { state: 'reported', at: new Date(rowsUpdatedAt * 1_000).toISOString() }
      : {
          state: 'unknown',
          reason: 'Socrata metadata did not report a valid rowsUpdatedAt instant',
        };
  return Object.freeze({ columns: ordered, sourceAsOf });
}

function parseCount(value: unknown, label: string): number {
  const row = isUnknownArray(value) ? value[0] : undefined;
  const raw = isObject(row) ? row.count : undefined;
  const count = typeof raw === 'string' && /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw sourceError('SCHEMA_DRIFT', `Socrata ${label} count response changed shape`, 'discover', {
      value,
    });
  }
  return count;
}

function pageUrl(limit: number, offset: number): string {
  const url = new URL(SANTA_CLARA_PARCELS_API_ROOT);
  url.searchParams.set('$limit', String(limit));
  url.searchParams.set('$offset', String(offset));
  url.searchParams.set('$order', 'objectid ASC');
  return url.toString();
}

function isoHttpDate(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
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
  const metadata = stored.metadata;
  if (
    metadata.sourceId !== plan.sourceId ||
    metadata.snapshotId !== plan.snapshotId ||
    metadata.requestKey !== item.requestKey ||
    metadata.sourceUrl !== item.url
  ) {
    throw sourceError(
      'RECONCILIATION',
      'Recovered Socrata page metadata does not match the immutable plan',
      'acquire',
      { requestKey: item.requestKey },
    );
  }
  const retrievedAt = metadata.retrievedAt;
  const attempt = Number(metadata.attempt);
  const httpStatus = Number(metadata.httpStatus);
  if (
    retrievedAt === undefined ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    !Number.isSafeInteger(httpStatus) ||
    httpStatus < 200 ||
    httpStatus >= 300 ||
    !item.expectedMediaTypes.includes(stored.mediaType)
  ) {
    throw sourceError('RECONCILIATION', 'Recovered Socrata page metadata is invalid', 'acquire', {
      requestKey: item.requestKey,
    });
  }
  const lastModified = metadata.lastModified === '' ? null : isoHttpDate(metadata.lastModified);
  if (metadata.lastModified !== '' && lastModified === null) {
    throw sourceError('RECONCILIATION', 'Recovered Last-Modified metadata is invalid', 'acquire');
  }
  return acquiredArtifactSchema.parse({
    artifactId: `sc:artifact:sha256:${stored.sha256}` as ArtifactId,
    sourceId: plan.sourceId,
    snapshotId: plan.snapshotId,
    retrievedAt,
    sourceAsOf:
      lastModified === null
        ? {
            state: 'unknown',
            reason: 'The page response did not include a valid Last-Modified header',
          }
        : { state: 'reported', at: lastModified },
    request: {
      requestKey: item.requestKey,
      method: item.method,
      url: item.url,
      headers: [{ name: 'accept', valueSha256: sha256Hex(TEXT_ENCODER.encode(ACCEPT_GEOJSON)) }],
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
    encoding: 'geojson',
    byteSize: stored.byteSize,
    sha256: stored.sha256,
    schemaFingerprint: {
      algorithm: 'sha256',
      value: SANTA_CLARA_PARCELS_SCHEMA_FINGERPRINT,
      schemaName: 'santa-clara-socrata-parcels-ubcd-cewv',
      canonicalizationVersion: '2.0.0',
    },
    rawUri: stored.uri,
    licenseSnapshotRef: SANTA_CLARA_PARCELS_DESCRIPTOR.license.licenseSnapshotId,
    visibility: SANTA_CLARA_PARCELS_DESCRIPTOR.defaultVisibility,
  });
}

async function visibilityCounts(mutations: SourceRunObservationV2['mutations']) {
  const counts = { public: 0, authenticated: 0, restricted: 0, prohibited_public: 0 };
  for await (const mutation of mutations.read()) {
    counts[mutation.visibility] += 1;
  }
  return counts;
}

function parsePlanInteger(value: string | null, name: string): number {
  const parsed = value !== null && /^\d+$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw sourceError(
      'SCHEMA_DRIFT',
      `Immutable acquisition plan has an invalid ${name}`,
      'summarize',
      {
        value,
      },
    );
  }
  return parsed;
}

/**
 * Reconstructs the discovery denominator from plan bytes alone. This survives
 * process restarts and rejects gaps, overlaps, caps, or mutated page requests.
 */
function expectedRecordsFromPlan(plan: AcquisitionPlan): number {
  const ordered = [...plan.items].sort((left, right) => left.sequence - right.sequence);
  const apiRoot = new URL(SANTA_CLARA_PARCELS_API_ROOT);
  let expectedOffset = 0;
  let fullPageSize: number | undefined;

  for (const [index, item] of ordered.entries()) {
    const url = new URL(item.url);
    const limit = parsePlanInteger(url.searchParams.get('$limit'), '$limit');
    const offset = parsePlanInteger(url.searchParams.get('$offset'), '$offset');
    const expectedRequestKey = `page-${String(index).padStart(6, '0')}`;
    const queryNames = [...url.searchParams.keys()].sort();
    if (
      item.sequence !== index ||
      item.requestKey !== expectedRequestKey ||
      item.method !== 'GET' ||
      item.encoding !== 'geojson' ||
      url.origin !== apiRoot.origin ||
      url.pathname !== apiRoot.pathname ||
      JSON.stringify(queryNames) !== JSON.stringify(['$limit', '$offset', '$order'].sort()) ||
      url.searchParams.get('$order') !== 'objectid ASC' ||
      limit < 1 ||
      limit > MAX_PAGE_SIZE ||
      offset !== expectedOffset
    ) {
      throw sourceError(
        'SCHEMA_DRIFT',
        'Immutable acquisition plan no longer represents contiguous objectid-ordered pages',
        'summarize',
        { index, requestKey: item.requestKey, url: item.url },
      );
    }
    fullPageSize ??= limit;
    const isLast = index === ordered.length - 1;
    if ((!isLast && limit !== fullPageSize) || (isLast && limit > fullPageSize)) {
      throw sourceError(
        'SCHEMA_DRIFT',
        'Immutable acquisition plan has a partial page before its final page',
        'summarize',
        { index, limit, fullPageSize },
      );
    }
    expectedOffset += limit;
    if (!Number.isSafeInteger(expectedOffset)) {
      throw sourceError(
        'SCHEMA_DRIFT',
        'Immutable acquisition plan count exceeds safe range',
        'summarize',
      );
    }
  }

  return expectedOffset;
}

export class SantaClaraSocrataParcelsAdapter implements StreamingSourceAdapter<
  SantaClaraParcelDecodedRecord,
  SantaClaraParcelValidatedRecord
> {
  readonly #pageSize: number;
  readonly #maximumResponseBytes: number;
  public constructor(options: AdapterOptions = {}) {
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
      throw new RangeError(`pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}`);
    }
    const maximumResponseBytes = options.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES;
    if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1) {
      throw new RangeError('maximumResponseBytes must be a positive safe integer');
    }
    this.#pageSize = pageSize;
    this.#maximumResponseBytes = maximumResponseBytes;
  }

  public describe(): SourceDescriptor {
    return SANTA_CLARA_PARCELS_DESCRIPTOR;
  }

  public async discover(context: DiscoveryContext): Promise<DiscoveryResult> {
    const metadataResponse = await requestWithRetry(
      SANTA_CLARA_PARCELS_METADATA_URL,
      ACCEPT_JSON,
      context,
    );
    const metadata = parseMetadata(
      parseJson(await collectDiscoveryBody(metadataResponse.response, context.signal), 'discover'),
    );
    const countEntries = await Promise.all(
      Object.entries(SANTA_CLARA_PARCELS_COUNT_URLS).map(async ([key, url]) => {
        const result = await requestWithRetry(url, ACCEPT_JSON, context);
        const count = parseCount(
          parseJson(await collectDiscoveryBody(result.response, context.signal), 'discover'),
          key,
        );
        return [key, count] as const;
      }),
    );
    const counts = Object.fromEntries(countEntries) as Record<
      keyof typeof SANTA_CLARA_PARCELS_COUNT_URLS,
      number
    >;
    return Object.freeze({
      sourceId: SANTA_CLARA_PARCELS_DESCRIPTOR.sourceId,
      discoveredAt: context.clock.now(),
      resources: Object.freeze([
        {
          requestKey: 'county-rows',
          url: SANTA_CLARA_PARCELS_API_ROOT,
          sourceAsOf: metadata.sourceAsOf,
          expectedRecords: counts.countyRows,
          mediaTypes: ['application/vnd.geo+json', 'application/geo+json'],
          continuationToken: null,
        },
        {
          requestKey: 'county-distinct-apns',
          url: SANTA_CLARA_PARCELS_COUNT_URLS.countyDistinctApns,
          sourceAsOf: metadata.sourceAsOf,
          expectedRecords: counts.countyDistinctApns,
          mediaTypes: ['application/json'],
          continuationToken: null,
        },
        {
          requestKey: 'palo-alto-rows',
          url: SANTA_CLARA_PARCELS_COUNT_URLS.paloAltoRows,
          sourceAsOf: metadata.sourceAsOf,
          expectedRecords: counts.paloAltoRows,
          mediaTypes: ['application/json'],
          continuationToken: null,
        },
        {
          requestKey: 'palo-alto-distinct-apns',
          url: SANTA_CLARA_PARCELS_COUNT_URLS.paloAltoDistinctApns,
          sourceAsOf: metadata.sourceAsOf,
          expectedRecords: counts.paloAltoDistinctApns,
          mediaTypes: ['application/json'],
          continuationToken: null,
        },
      ]),
      complete: true,
      limitations: Object.freeze([
        'County rows and distinct APNs are separate denominators.',
        'Palo Alto rows and distinct APNs are subset denominators and never county completion denominators.',
        'APN is not a raw-row key; objectid supplies stable source ordering while duplicate APNs remain intact.',
        'Parcel geometry is a cadastral boundary, not a rooftop or entrance coordinate.',
      ]),
    });
  }

  public async plan(
    request: AcquisitionRequest,
    discovery: DiscoveryResult,
    context: PlanningContext,
  ): Promise<AcquisitionPlan> {
    context.signal.throwIfAborted();
    await Promise.resolve();
    if (
      request.sourceId !== SANTA_CLARA_PARCELS_SOURCE_ID ||
      discovery.sourceId !== request.sourceId
    ) {
      throw sourceError(
        'RECORD_QUALITY',
        'Acquisition request or discovery belongs to another source',
        'plan',
      );
    }
    const county = discovery.resources.find((resource) => resource.requestKey === 'county-rows');
    if (
      county?.expectedRecords === null ||
      county?.expectedRecords === undefined ||
      county.expectedRecords < 1
    ) {
      throw sourceError(
        'SCHEMA_DRIFT',
        'Discovery did not provide a positive county row denominator',
        'plan',
      );
    }
    const expectedRecords = county.expectedRecords;
    const pageCount = Math.ceil(expectedRecords / this.#pageSize);
    const plan = acquisitionPlanSchema.parse({
      sourceId: request.sourceId,
      snapshotId: request.snapshotId,
      contractVersion: SANTA_CLARA_PARCELS_DESCRIPTOR.contractVersion,
      plannedAt: context.clock.now(),
      items: Array.from({ length: pageCount }, (_, sequence) => ({
        requestKey: `page-${String(sequence).padStart(6, '0')}`,
        sequence,
        method: 'GET',
        url: pageUrl(
          Math.min(this.#pageSize, expectedRecords - sequence * this.#pageSize),
          sequence * this.#pageSize,
        ),
        encoding: 'geojson',
        expectedMediaTypes: ['application/vnd.geo+json', 'application/geo+json'],
      })),
    });
    return plan;
  }

  public async *acquire(
    plan: AcquisitionPlan,
    checkpoint: SourceCheckpoint | undefined,
    context: StreamingAcquisitionContext,
  ): AsyncIterable<AcquiredArtifactSource> {
    if (plan.sourceId !== SANTA_CLARA_PARCELS_SOURCE_ID) {
      throw sourceError('RECORD_QUALITY', 'Acquisition plan belongs to another source', 'acquire');
    }
    const orderedItems = [...plan.items].sort((left, right) => left.sequence - right.sequence);
    const scope = `source-adapter:${plan.snapshotId}`;
    let envelope = await context.checkpointStore.load(scope);
    const storedCheckpoint =
      envelope === undefined ? undefined : sourceCheckpointSchema.parse(envelope.payload);
    if (
      checkpoint !== undefined &&
      storedCheckpoint !== undefined &&
      JSON.stringify(checkpoint) !== JSON.stringify(storedCheckpoint)
    ) {
      throw sourceError(
        'RECONCILIATION',
        'Passed checkpoint differs from the persisted checkpoint',
        'acquire',
      );
    }
    let current = checkpoint ?? storedCheckpoint;
    if (
      current !== undefined &&
      (current.sourceId !== plan.sourceId ||
        current.snapshotId !== plan.snapshotId ||
        current.contractVersion !== plan.contractVersion)
    ) {
      throw sourceError('RECORD_QUALITY', 'Checkpoint does not belong to this plan', 'acquire');
    }
    if (current !== undefined) {
      const expectedKeys = orderedItems
        .slice(0, current.nextSequence)
        .map((item) => item.requestKey);
      if (
        current.nextSequence > orderedItems.length ||
        current.completedRequestKeys.length !== current.nextSequence ||
        current.acquiredArtifactIds.length > current.nextSequence ||
        current.completedRequestKeys.some((key, index) => key !== expectedKeys[index]) ||
        current.complete !== (current.nextSequence === orderedItems.length)
      ) {
        throw sourceError(
          'RECONCILIATION',
          'Checkpoint does not describe an exact contiguous acquisition prefix',
          'acquire',
          { nextSequence: current.nextSequence },
        );
      }
    }
    const completed = new Set(current?.completedRequestKeys ?? []);
    const artifactIds = [...(current?.acquiredArtifactIds ?? [])];
    const recoveredArtifactIds: SourceCheckpoint['acquiredArtifactIds'][number][] = [];
    for (const item of orderedItems) {
      context.signal.throwIfAborted();
      const wasCompleted = completed.has(item.requestKey);
      const logicalKey = `raw/santa-clara-socrata-parcels/${plan.snapshotId}/${String(item.sequence).padStart(6, '0')}.geojson`;
      let stored = await context.artifactStore.headByLogicalKey(logicalKey);
      if (wasCompleted && stored === undefined) {
        throw sourceError(
          'RECONCILIATION',
          'Checkpoint references a missing immutable page artifact',
          'acquire',
          { requestKey: item.requestKey, logicalKey },
        );
      }
      if (stored === undefined) {
        const { response, attempt } = await requestWithRetry(item.url, ACCEPT_GEOJSON, context);
        const mediaType = header(response.headers, 'content-type')?.split(';', 1)[0]?.trim() ?? '';
        if (!item.expectedMediaTypes.includes(mediaType)) {
          throw sourceError('SCHEMA_DRIFT', 'Socrata page media type changed', 'acquire', {
            requestKey: item.requestKey,
            mediaType,
          });
        }
        const retrievedAt = context.clock.now();
        const lastModified = isoHttpDate(header(response.headers, 'last-modified'));
        stored = await persistAcquiredBody({
          store: context.artifactStore,
          logicalKey,
          mediaType,
          body: response.body,
          maximumBytes: this.#maximumResponseBytes,
          metadata: Object.freeze({
            sourceId: plan.sourceId,
            snapshotId: plan.snapshotId,
            requestKey: item.requestKey,
            sourceUrl: item.url,
            retrievedAt,
            attempt: String(attempt),
            httpStatus: String(response.status),
            etag: header(response.headers, 'etag') ?? '',
            lastModified: lastModified ?? '',
            finalUrl: item.url,
          }),
          signal: context.signal,
        });
      }
      const metadata = acquiredMetadataFromStored(plan, item, stored);
      const artifact = await createStreamingAcquiredArtifact(metadata, context.artifactStore);
      const artifactId = artifact.metadata.artifactId;
      if (wasCompleted) {
        if (!artifactIds.includes(artifactId)) {
          throw sourceError(
            'RECONCILIATION',
            'Checkpoint artifact identity does not match the recovered immutable page',
            'acquire',
            { requestKey: item.requestKey, logicalKey },
          );
        }
        if (!recoveredArtifactIds.includes(artifactId)) recoveredArtifactIds.push(artifactId);
        if (
          item.sequence + 1 === current?.nextSequence &&
          (recoveredArtifactIds.length !== artifactIds.length ||
            recoveredArtifactIds.some((candidate, index) => candidate !== artifactIds[index]))
        ) {
          throw sourceError(
            'RECONCILIATION',
            'Checkpoint artifact identities do not exactly match the recovered immutable prefix',
            'acquire',
          );
        }
        yield artifact;
        continue;
      }
      completed.add(item.requestKey);
      if (!artifactIds.includes(artifactId)) artifactIds.push(artifactId);
      const nextSequence = item.sequence + 1;
      const nextCheckpoint = sourceCheckpointSchema.parse({
        sourceId: plan.sourceId,
        snapshotId: plan.snapshotId,
        contractVersion: plan.contractVersion,
        cursor:
          nextSequence >= orderedItems.length
            ? 'complete'
            : (orderedItems.find((candidate) => candidate.sequence === nextSequence)?.requestKey ??
              `sequence-${nextSequence}`),
        nextSequence,
        completedRequestKeys: [...completed],
        acquiredArtifactIds: artifactIds,
        updatedAt: artifact.metadata.retrievedAt,
        complete: nextSequence >= orderedItems.length,
      });
      const nextEnvelope = createCheckpointEnvelope({
        scope,
        previousRevision: envelope?.revision ?? null,
        writtenAt: nextCheckpoint.updatedAt,
        payload: nextCheckpoint,
      });
      const commit = await context.checkpointStore.commit({
        expectedRevision: envelope?.revision ?? null,
        checkpoint: nextEnvelope,
      });
      if (commit.status === 'conflict') {
        throw sourceError(
          'RECONCILIATION',
          'Checkpoint commit conflicted with another writer',
          'acquire',
          {
            requestKey: item.requestKey,
          },
        );
      }
      envelope = commit.checkpoint;
      current = nextCheckpoint;
      yield artifact;
    }
  }

  public async *decode(
    artifact: AcquiredArtifactSource,
    context: StreamingDecodeContext,
  ): AsyncIterable<SantaClaraParcelDecodedRecord> {
    context.signal.throwIfAborted();
    const envelope = await inspectGeoJsonEnvelope(artifactRead(artifact), context.signal);
    if (envelope.type !== 'FeatureCollection' || envelope.crs !== SANTA_CLARA_PARCELS_CRS) {
      throw sourceError('SCHEMA_DRIFT', 'Socrata GeoJSON envelope or CRS changed', 'decode', {
        type: envelope.type,
        crs: envelope.crs,
      });
    }
    let ordinal = 0;
    for await (const feature of streamJsonObjectArrayProperty(
      artifactRead(artifact),
      'features',
      context.signal,
    )) {
      context.signal.throwIfAborted();
      if (
        !isObject(feature) ||
        !isJsonValue(feature) ||
        feature.type !== 'Feature' ||
        !isObject(feature.properties) ||
        !isJsonValue(feature.properties) ||
        !isJsonValue(feature.geometry)
      ) {
        throw sourceError(
          'SCHEMA_DRIFT',
          'Socrata GeoJSON page contains a malformed feature envelope',
          'decode',
          {
            ordinal,
          },
        );
      }
      const geometry =
        isObject(feature.geometry) &&
        typeof feature.geometry.type === 'string' &&
        isJsonValue(feature.geometry.coordinates)
          ? { type: feature.geometry.type, coordinates: feature.geometry.coordinates }
          : null;
      const objectId = feature.properties.objectid;
      const sourceAsOf = artifact.metadata.sourceAsOf;
      const rawFeatureSha256 = sha256Text(stableJson(feature));
      yield Object.freeze({
        format: 'geojson' as const,
        artifactId: artifact.metadata.artifactId,
        ordinal,
        visibility: artifact.metadata.visibility,
        featureType: 'Feature' as const,
        geometry,
        properties: Object.freeze({ ...feature.properties }),
        sourceId: artifact.metadata.sourceId,
        snapshotId: artifact.metadata.snapshotId,
        retrievedAt: artifact.metadata.retrievedAt,
        sourceAsOfAt: sourceAsOf.state === 'unknown' ? null : sourceAsOf.at,
        rowKey:
          typeof objectId === 'string'
            ? objectId
            : typeof objectId === 'number'
              ? String(objectId)
              : '',
        crs: envelope.crs,
        rawFeatureSha256,
      });
      ordinal += 1;
    }
  }

  public async validate(
    record: SantaClaraParcelDecodedRecord,
    context: ValidationContext,
  ): Promise<RecordValidation<SantaClaraParcelValidatedRecord>> {
    context.signal.throwIfAborted();
    const issues: ValidationIssue[] = [];
    const objectId = /^\d+$/u.test(record.rowKey) ? Number(record.rowKey) : Number.NaN;
    if (
      !Number.isSafeInteger(objectId) ||
      objectId < 1 ||
      objectId > Math.floor((Number.MAX_SAFE_INTEGER - 999) / 1_000)
    ) {
      issues.push({
        code: 'SCC_PARCELS_OBJECTID_INVALID',
        severity: 'error',
        message:
          'objectid must be a positive safe integer that can safely derive deterministic mutation sequences',
        recordKey: record.rowKey || null,
        fieldPath: '/properties/objectid',
      });
    }
    const rawApn = record.properties.apn;
    const apn = typeof rawApn === 'string' ? normalizeSantaClaraParcelApn(rawApn) : null;
    if (apn === null) {
      issues.push({
        code: 'SCC_PARCELS_APN_INVALID',
        severity: 'error',
        message: 'APN must normalize to exactly eight digits',
        recordKey: record.rowKey || null,
        fieldPath: '/properties/apn',
      });
    }
    const rawJurisdiction = record.properties.jurisdiction;
    const jurisdiction = typeof rawJurisdiction === 'string' ? rawJurisdiction.trim() : '';
    if (jurisdiction.length === 0) {
      issues.push({
        code: 'SCC_PARCELS_JURISDICTION_INVALID',
        severity: 'error',
        message: 'jurisdiction must be a non-empty source value',
        recordKey: record.rowKey || null,
        fieldPath: '/properties/jurisdiction',
      });
    }
    const geometry = parseCrs84MultiPolygon(record.geometry, record.crs);
    if (geometry === null) {
      issues.push({
        code: 'SCC_PARCELS_GEOMETRY_INVALID',
        severity: 'error',
        message: `Parcel geometry must be a closed, bounded MultiPolygon in ${SANTA_CLARA_PARCELS_CRS}`,
        recordKey: record.rowKey || null,
        fieldPath: '/geometry',
      });
    }
    if (
      issues.length > 0 ||
      !Number.isSafeInteger(objectId) ||
      apn === null ||
      geometry === null ||
      jurisdiction.length === 0
    ) {
      return Promise.resolve(
        Object.freeze({ status: 'rejected' as const, issues: Object.freeze(issues) }),
      );
    }
    return Promise.resolve(
      Object.freeze({
        status: 'accepted' as const,
        issues: Object.freeze(issues),
        record: Object.freeze({
          sourceId: record.sourceId,
          snapshotId: record.snapshotId,
          artifactId: record.artifactId,
          retrievedAt: record.retrievedAt,
          sourceAsOfAt: record.sourceAsOfAt,
          ordinal: record.ordinal,
          rowKey: record.rowKey,
          objectId,
          rawFeatureSha256: record.rawFeatureSha256,
          visibility: record.visibility,
          apn,
          jurisdiction,
          geometry,
          properties: record.properties,
        }),
      }),
    );
  }

  public async *normalize(
    record: SantaClaraParcelValidatedRecord,
    context: NormalizationContext,
  ): AsyncIterable<CanonicalMutation> {
    context.signal.throwIfAborted();
    await Promise.resolve();
    const propertyId = `sc:entity:property:${sha256Text(`santa-clara-ca|apn|${record.apn}`)}`;
    const runId = `sc:run:${sha256Text(`run|${record.snapshotId}`)}`;
    const sourceRecord = {
      sourceId: record.sourceId,
      snapshotId: record.snapshotId,
      artifactId: record.artifactId,
      recordKey: record.rowKey,
      recordSha256: record.rawFeatureSha256,
      rawPointer: `/features/${record.ordinal}`,
    } as const;
    const lineageFor = (value: JsonValue): FieldLineage => {
      const transformation = {
        name: 'santa-clara-socrata-parcels-normalize',
        version: '1.1.0',
        appliedAt: record.retrievedAt,
        inputSha256: record.rawFeatureSha256,
        outputSha256: sha256Text(stableJson(value)),
      } as const;
      return {
        sourceRecord,
        transformations: [transformation],
        lineageSha256: sha256Text(stableJson({ sourceRecord, transformations: [transformation] })),
      };
    };
    const propertyCore = {
      county: 'Santa Clara',
      state: 'CA',
      apn: record.apn,
      jurisdiction: record.jurisdiction,
      primaryAddressId: null,
      unitIds: [],
      parcelGeometry: record.geometry,
      landAreaSquareMeters: null,
    } as const;
    const entityLineage = lineageFor(propertyCore);
    const entity = {
      id: propertyId,
      entityKind: 'property' as const,
      version: 1,
      validFrom: record.sourceAsOfAt ?? record.retrievedAt,
      validTo: null,
      recordedAt: record.retrievedAt,
      visibility: record.visibility,
      sourceIds: [record.sourceId],
      lineage: [entityLineage],
      ...propertyCore,
    };
    const sequenceBase = record.objectId * 1_000;
    const entityMutation = canonicalMutationSchema.parse({
      kind: 'entity_upsert',
      mutationId: `sc:mutation:${sha256Text(`entity|${record.snapshotId}|${record.rowKey}|${stableJson(propertyCore)}`)}`,
      runId,
      sourceId: record.sourceId,
      snapshotId: record.snapshotId,
      sequence: sequenceBase,
      emittedAt: record.retrievedAt,
      visibility: record.visibility,
      entity,
    });
    yield entityMutation;

    const observations: readonly Readonly<{ fieldPath: string; value: JsonValue }>[] = [
      { fieldPath: '/county', value: propertyCore.county },
      { fieldPath: '/state', value: propertyCore.state },
      { fieldPath: '/apn', value: record.apn },
      { fieldPath: '/jurisdiction', value: record.jurisdiction },
      { fieldPath: '/primaryAddressId', value: propertyCore.primaryAddressId },
      { fieldPath: '/unitIds', value: propertyCore.unitIds },
      { fieldPath: '/parcelGeometry', value: record.geometry },
      { fieldPath: '/landAreaSquareMeters', value: propertyCore.landAreaSquareMeters },
      { fieldPath: '/sourceObjectId', value: record.rowKey },
      ...Object.entries(record.properties)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => ({ fieldPath: `/source/${key}`, value })),
    ];
    for (const [index, observationInput] of observations.entries()) {
      context.signal.throwIfAborted();
      const valueHash = sha256Text(stableJson(observationInput.value));
      const observationId = `sc:observation:${sha256Text(
        `${record.sourceId}|${record.snapshotId}|${record.rowKey}|${observationInput.fieldPath}|${valueHash}`,
      )}`;
      const observation = {
        observationId,
        entityId: propertyId,
        entityKind: 'property' as const,
        fieldPath: observationInput.fieldPath,
        value: observationInput.value,
        observedAt: record.retrievedAt,
        sourceAsOf: record.sourceAsOfAt,
        authorityRank: SANTA_CLARA_PARCELS_DESCRIPTOR.authority.authorityRank,
        confidence: 1,
        visibility: record.visibility,
        lineage: lineageFor(observationInput.value),
      };
      yield canonicalMutationSchema.parse({
        kind: 'field_observation',
        mutationId: `sc:mutation:${sha256Text(`observation|${observationId}`)}`,
        runId,
        sourceId: record.sourceId,
        snapshotId: record.snapshotId,
        sequence: sequenceBase + index + 1,
        emittedAt: record.retrievedAt,
        visibility: record.visibility,
        observation,
      });
    }
  }

  public async summarize(
    run: SourceRunObservationV2,
    context: SummaryContext,
  ): Promise<SourceRunSummary> {
    context.signal.throwIfAborted();
    const expectedCount = expectedRecordsFromPlan(run.plan);
    const countMismatch = run.decodedRecords !== expectedCount;
    let warningCount = 0;
    let validationErrorCount = 0;
    let hasFatal = false;
    for await (const issue of run.validationIssues.read()) {
      context.signal.throwIfAborted();
      if (issue.severity === 'warning') warningCount += 1;
      else if (issue.severity === 'error') validationErrorCount += 1;
      else {
        validationErrorCount += 1;
        hasFatal = true;
      }
    }
    const errorCount = validationErrorCount + (countMismatch ? 1 : 0);
    const status = run.aborted
      ? 'aborted'
      : countMismatch || hasFatal
        ? 'failed'
        : run.rejectedRecords > 0 || validationErrorCount > 0 || !run.finalCheckpoint.complete
          ? 'partial'
          : 'succeeded';
    return sourceRunSummarySchema.parse({
      sourceId: run.descriptor.sourceId,
      snapshotId: run.plan.snapshotId,
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
      visibilityCounts: await visibilityCounts(run.mutations),
      warningCount,
      errorCount,
      finalCheckpoint: run.finalCheckpoint,
    });
  }
}

export function createSantaClaraSocrataParcelsAdapter(
  options: AdapterOptions = {},
): SantaClaraSocrataParcelsAdapter {
  return new SantaClaraSocrataParcelsAdapter(options);
}
