import { createHash } from 'node:crypto';

import { createCheckpointEnvelope } from '@oracle/artifacts/checkpoint-store';
import {
  canonicalMutationSchema,
  type CanonicalMutation,
} from '@oracle/contracts/canonical/mutation';
import { fieldLineageSchema, type FieldLineage } from '@oracle/contracts/canonical/lineage';
import { oracleErrorSchema, type OracleErrorCode } from '@oracle/contracts/errors';
import type { JsonValue as ContractJsonValue } from '@oracle/contracts/foundation';
import type { ArtifactId, EntityId, SnapshotId } from '@oracle/contracts/ids';
import {
  acquisitionPlanSchema,
  acquiredArtifactSchema,
  sourceCheckpointSchema,
  sourceRunSummarySchema,
  type AcquisitionPlan,
  type AcquisitionRequest,
  type SourceCheckpoint,
  type SourceDescriptor,
  type SourceRunSummary,
  type ValidationIssue,
} from '@oracle/contracts/source';
import type { Visibility } from '@oracle/contracts/visibility';

import {
  ANALYTICAL_SNAPSHOT_MANIFEST_MEDIA_TYPE,
  createStreamingAcquiredArtifact,
  encodeAnalyticalSnapshotManifest,
  type AcquiredArtifactSource,
  LEGACY_WHOLE_COPY_MAX_BYTES,
  type StreamingAcquiredArtifact,
} from '../../spi/acquired-artifact.js';
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
import { persistAcquiredBody } from '../../spi/acquisition.js';
import { sha256Hex } from '../../spi/bytes.js';
import type { JsonValue } from '../../spi/decode.js';
import type { HttpResponse } from '../../spi/http.js';
import {
  OVERTURE_PLACES_FRAGMENT_BYTES,
  OVERTURE_PLACES_FRAGMENT_ETAG,
  OVERTURE_PLACES_FRAGMENT_LAST_MODIFIED,
  OVERTURE_PLACES_FRAGMENT_SHA256,
  OVERTURE_PLACES_FRAGMENT_URI,
  OVERTURE_STARBUCKS_DESCRIPTOR,
  OVERTURE_STARBUCKS_QUERY,
  OVERTURE_STARBUCKS_RELEASE,
  OVERTURE_STARBUCKS_SCHEMA_FINGERPRINT,
  OVERTURE_STARBUCKS_SCHEMA_VERSION,
  OVERTURE_STARBUCKS_SOURCE_ID,
  SANTA_CLARA_OVERTURE_BOUNDS,
  STARBUCKS_WIKIDATA_ID,
} from './constants.js';
import { classifyStarbucksMatch } from './matching.js';
import { NOT_SAMPLED_VALIDATION } from './manual-validation.js';
import type {
  OvertureAdapterOptions,
  OvertureAddress,
  OvertureArtifactConfig,
  OvertureBrand,
  OvertureCategories,
  OvertureContributor,
  OvertureDecodedPlace,
  OvertureNames,
  OvertureNameRule,
  OvertureStarbucksCandidate,
} from './types.js';

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
const MAXIMUM_ROWS = 10_000;
const MINIMUM_CONFIDENCE = 0.7;
const PERMISSIVE_LICENSES = new Set(['CC0-1.0', 'CDLA-Permissive-2.0', 'Apache-2.0']);

const DEFAULT_ARTIFACT: OvertureArtifactConfig = Object.freeze({
  url: OVERTURE_PLACES_FRAGMENT_URI,
  encoding: 'parquet',
  mediaTypes: Object.freeze(['application/octet-stream', 'application/vnd.apache.parquet']),
  expectedBytes: OVERTURE_PLACES_FRAGMENT_BYTES,
  expectedSha256: OVERTURE_PLACES_FRAGMENT_SHA256,
  expectedEtag: OVERTURE_PLACES_FRAGMENT_ETAG,
  expectedLastModified: OVERTURE_PLACES_FRAGMENT_LAST_MODIFIED,
});

function providerError(
  code: OracleErrorCode,
  message: string,
  phase: string,
  details: Readonly<Record<string, unknown>> = {},
): Error & ReturnType<typeof oracleErrorSchema.parse> {
  const parsed = oracleErrorSchema.parse({
    code,
    retryable: code === 'TRANSIENT_SOURCE',
    message,
    sourceId: OVERTURE_STARBUCKS_SOURCE_ID,
    phase,
    details,
  });
  return Object.assign(new Error(parsed.message), parsed);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot canonicalize a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  throw new TypeError(`Unsupported canonical value: ${typeof value}`);
}

function checkpointForPlan(
  value: unknown,
  plan: AcquisitionPlan,
  requestKey: string,
  artifactId: ArtifactId,
  origin: 'caller' | 'stored',
): SourceCheckpoint {
  const parsed = sourceCheckpointSchema.safeParse(value);
  if (!parsed.success) {
    throw providerError('SCHEMA_DRIFT', `Invalid ${origin} Overture checkpoint`, 'acquire');
  }
  const checkpoint = parsed.data;
  const isInitial =
    checkpoint.nextSequence === 0 &&
    checkpoint.completedRequestKeys.length === 0 &&
    checkpoint.acquiredArtifactIds.length === 0 &&
    !checkpoint.complete;
  const isComplete =
    checkpoint.nextSequence === 1 &&
    checkpoint.completedRequestKeys.length === 1 &&
    checkpoint.completedRequestKeys[0] === requestKey &&
    checkpoint.acquiredArtifactIds.length === 1 &&
    checkpoint.acquiredArtifactIds[0] === artifactId &&
    checkpoint.complete;
  if (
    checkpoint.sourceId !== plan.sourceId ||
    checkpoint.snapshotId !== plan.snapshotId ||
    checkpoint.contractVersion !== plan.contractVersion ||
    (!isInitial && !isComplete)
  ) {
    throw providerError(
      'RECONCILIATION',
      `${origin} Overture checkpoint is not an exact prefix of the frozen one-item plan`,
      'acquire',
    );
  }
  return checkpoint;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function deterministicId<T extends string>(
  prefix: T,
  ...parts: readonly unknown[]
): `${T}${string}` {
  return `${prefix}${hashText(parts.map((part) => stableJson(part)).join('\0'))}`;
}

function header(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const normalized = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === normalized)?.[1];
}

function parseHttpInstant(value: string | undefined): string | null {
  if (value === undefined) return null;
  const instant = new Date(value);
  return Number.isNaN(instant.valueOf()) ? null : instant.toISOString();
}

async function discardResponseBody(response: HttpResponse, signal: AbortSignal): Promise<void> {
  const iterator = response.body[Symbol.asyncIterator]();
  try {
    await iterator.next();
    signal.throwIfAborted();
  } finally {
    await iterator.return?.();
  }
}

function retryAfterMs(response: HttpResponse): number | undefined {
  const value = header(response.headers, 'retry-after');
  if (value === undefined) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

async function requestWithRetry(
  request: Readonly<{ method: 'GET' | 'HEAD'; url: string; accept: string }>,
  context: Pick<StreamingAcquisitionContext, 'http' | 'delay' | 'ratePolicy' | 'signal'>,
): Promise<Readonly<{ response: HttpResponse; attempt: number }>> {
  let lastFailure: unknown;
  for (let attempt = 1; attempt <= context.ratePolicy.maxAttempts; attempt += 1) {
    context.signal.throwIfAborted();
    try {
      const response = await context.http.send(
        { method: request.method, url: request.url, headers: { accept: request.accept } },
        context.signal,
      );
      if (response.status >= 200 && response.status < 300) {
        return Object.freeze({ response, attempt });
      }
      await discardResponseBody(response, context.signal);
      if (response.status === 401 || response.status === 403) {
        throw providerError(
          response.status === 401 ? 'AUTHENTICATION' : 'TERMS_ACCESS',
          `Official Overture artifact returned HTTP ${response.status}`,
          request.method === 'HEAD' ? 'discover' : 'acquire',
        );
      }
      if (response.status !== 429 && response.status < 500) {
        throw providerError(
          'RECORD_QUALITY',
          `Official Overture artifact returned permanent HTTP ${response.status}`,
          request.method === 'HEAD' ? 'discover' : 'acquire',
        );
      }
      lastFailure = providerError(
        'TRANSIENT_SOURCE',
        `Official Overture artifact returned transient HTTP ${response.status}`,
        request.method === 'HEAD' ? 'discover' : 'acquire',
      );
      if (attempt < context.ratePolicy.maxAttempts) {
        const exponential = Math.min(
          context.ratePolicy.maxBackoffMs,
          context.ratePolicy.initialBackoffMs * 2 ** (attempt - 1),
        );
        await context.delay.wait(
          context.ratePolicy.respectRetryAfter
            ? (retryAfterMs(response) ?? exponential)
            : exponential,
          context.signal,
        );
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      if (typeof error === 'object' && error !== null && 'retryable' in error && !error.retryable) {
        throw error;
      }
      lastFailure = error;
      if (attempt < context.ratePolicy.maxAttempts) {
        await context.delay.wait(
          Math.min(
            context.ratePolicy.maxBackoffMs,
            context.ratePolicy.initialBackoffMs * 2 ** (attempt - 1),
          ),
          context.signal,
        );
      }
    }
  }
  throw providerError(
    'TRANSIENT_SOURCE',
    'Overture request exhausted its retry budget',
    'acquire',
    {
      cause: lastFailure instanceof Error ? lastFailure.message : String(lastFailure),
    },
  );
}

function assertFrozenHeaders(
  response: HttpResponse,
  config: OvertureArtifactConfig,
  phase: string,
): void {
  const length = Number(header(response.headers, 'content-length'));
  if (!Number.isSafeInteger(length) || length !== config.expectedBytes) {
    throw providerError('SCHEMA_DRIFT', 'Overture artifact content length changed', phase, {
      expected: config.expectedBytes,
      actual: Number.isFinite(length) ? length : null,
    });
  }
  const etag = header(response.headers, 'etag') ?? null;
  if (config.expectedEtag !== null && etag !== config.expectedEtag) {
    throw providerError('SCHEMA_DRIFT', 'Overture artifact ETag changed', phase, {
      expected: config.expectedEtag,
      actual: etag,
    });
  }
  const lastModified = parseHttpInstant(header(response.headers, 'last-modified'));
  if (lastModified !== config.expectedLastModified) {
    throw providerError('SCHEMA_DRIFT', 'Overture artifact Last-Modified changed', phase, {
      expected: config.expectedLastModified,
      actual: lastModified,
    });
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(
      `${label} keys changed: expected ${wanted.join(',')}, got ${actual.join(',')}`,
    );
  }
}

function stringValue(value: unknown, label: string): string;
function stringValue(value: unknown, label: string, nullable: true): string | null;
function stringValue(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new TypeError(`${label} must be a string`);
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new TypeError(`${label} must be finite`);
  return value;
}

function nullableStringMap(value: unknown, label: string): Readonly<Record<string, string>> {
  if (value === null) return Object.freeze({});
  const record = object(value, label);
  const parsed = Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, stringValue(entry, `${label}.${key}`)]),
  ) as Record<string, string>;
  return Object.freeze(parsed);
}

function names(value: unknown, label: string): OvertureNames {
  const record = object(value, label);
  exactKeys(record, ['primary', 'common', 'rules'], label);
  const rulesValue = record.rules;
  if (rulesValue !== null && !Array.isArray(rulesValue))
    throw new TypeError(`${label}.rules must be an array`);
  const rules: OvertureNameRule[] = (rulesValue ?? []).map((entry, index) => {
    const rule = object(entry, `${label}.rules[${index}]`);
    const allowed = ['variant', 'language', 'value'];
    const fullOverture = ['variant', 'language', 'perspectives', 'value', 'between', 'side'];
    const actual = Object.keys(rule).sort().join('|');
    if (actual !== allowed.sort().join('|') && actual !== fullOverture.sort().join('|')) {
      throw new TypeError(`${label}.rules[${index}] keys changed`);
    }
    return Object.freeze({
      variant: stringValue(rule.variant, `${label}.rules.variant`),
      language: stringValue(rule.language, `${label}.rules.language`, true),
      value: stringValue(rule.value, `${label}.rules.value`),
    });
  });
  return Object.freeze({
    primary: stringValue(record.primary, `${label}.primary`),
    common: nullableStringMap(record.common, `${label}.common`),
    rules: Object.freeze(rules),
  });
}

function categories(value: unknown): OvertureCategories {
  const record = object(value, 'categories');
  exactKeys(record, ['primary', 'alternate'], 'categories');
  if (record.alternate !== null && !Array.isArray(record.alternate)) {
    throw new TypeError('categories.alternate must be an array');
  }
  const alternate = (record.alternate ?? []).map((entry) => stringValue(entry, 'category'));
  return Object.freeze({
    primary: stringValue(record.primary, 'categories.primary'),
    alternate: Object.freeze(alternate),
  });
}

function brand(value: unknown): OvertureBrand | null {
  if (value === null) return null;
  const record = object(value, 'brand');
  exactKeys(record, ['wikidata', 'names'], 'brand');
  return Object.freeze({
    wikidata: stringValue(record.wikidata, 'brand.wikidata', true),
    names: record.names === null ? null : names(record.names, 'brand.names'),
  });
}

function addresses(value: unknown): readonly OvertureAddress[] {
  if (!Array.isArray(value)) throw new TypeError('addresses must be an array');
  return Object.freeze(
    value.map((entry, index) => {
      const record = object(entry, `addresses[${index}]`);
      exactKeys(
        record,
        ['freeform', 'locality', 'postcode', 'region', 'country'],
        `addresses[${index}]`,
      );
      return Object.freeze({
        freeform: stringValue(record.freeform, 'address.freeform'),
        locality: stringValue(record.locality, 'address.locality', true),
        postcode: stringValue(record.postcode, 'address.postcode', true),
        region: stringValue(record.region, 'address.region', true),
        country: stringValue(record.country, 'address.country', true),
      });
    }),
  );
}

function contributors(value: unknown): readonly OvertureContributor[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new TypeError('sources must be a non-empty array');
  return Object.freeze(
    value.map((entry, index) => {
      const record = object(entry, `sources[${index}]`);
      const allowed = ['property', 'dataset', 'license', 'record_id', 'update_time', 'confidence'];
      const withBetween = [...allowed, 'between'];
      const actual = Object.keys(record).sort().join('|');
      if (actual !== allowed.sort().join('|') && actual !== withBetween.sort().join('|')) {
        throw new TypeError(`sources[${index}] keys changed`);
      }
      const updateTime = new Date(stringValue(record.update_time, 'source.update_time'));
      if (Number.isNaN(updateTime.valueOf()))
        throw new TypeError('source.update_time must be ISO-8601');
      const confidence =
        record.confidence === null ? null : finiteNumber(record.confidence, 'source.confidence');
      if (confidence !== null && (confidence < 0 || confidence > 1)) {
        throw new TypeError('source.confidence must be between zero and one');
      }
      return Object.freeze({
        property: typeof record.property === 'string' ? record.property : '',
        dataset: stringValue(record.dataset, 'source.dataset'),
        license: stringValue(record.license, 'source.license'),
        recordId: stringValue(record.record_id, 'source.record_id', true),
        updateTime: updateTime.toISOString(),
        confidence,
      });
    }),
  );
}

function point(
  value: unknown,
): Readonly<{ type: 'Point'; coordinates: readonly [number, number] }> {
  const geometry = object(value, 'geometry');
  exactKeys(geometry, ['type', 'coordinates'], 'geometry');
  if (
    geometry.type !== 'Point' ||
    !Array.isArray(geometry.coordinates) ||
    geometry.coordinates.length !== 2
  ) {
    throw new TypeError('Overture place geometry must be a two-dimensional Point');
  }
  const longitude = finiteNumber(geometry.coordinates[0], 'longitude');
  const latitude = finiteNumber(geometry.coordinates[1], 'latitude');
  if (
    longitude < SANTA_CLARA_OVERTURE_BOUNDS.west ||
    longitude > SANTA_CLARA_OVERTURE_BOUNDS.east ||
    latitude < SANTA_CLARA_OVERTURE_BOUNDS.south ||
    latitude > SANTA_CLARA_OVERTURE_BOUNDS.north
  ) {
    throw new RangeError('Overture point falls outside the frozen Santa Clara acquisition bounds');
  }
  const coordinates: readonly [number, number] = [longitude, latitude];
  return Object.freeze({
    type: 'Point',
    coordinates: Object.freeze(coordinates),
  });
}

function jsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return true;
  if (Array.isArray(value)) return value.every((entry) => jsonValue(entry));
  return typeof value === 'object' && Object.values(value).every((entry) => jsonValue(entry));
}

function decodeFeature(
  value: unknown,
  ordinal: number,
  artifact: Pick<AcquiredArtifactSource, 'metadata'>,
): OvertureDecodedPlace {
  const feature = object(value, `features[${ordinal}]`);
  exactKeys(feature, ['type', 'id', 'geometry', 'properties'], `features[${ordinal}]`);
  if (feature.type !== 'Feature') throw new TypeError('Expected GeoJSON Feature');
  const properties = object(feature.properties, 'feature.properties');
  const expectedProperties = [
    'version',
    'names',
    'categories',
    'confidence',
    'brand',
    'addresses',
    'sources',
    'operating_status',
    'basic_category',
    'taxonomy',
  ];
  exactKeys(properties, expectedProperties, 'feature.properties');
  if (!jsonValue(properties)) throw new TypeError('Feature properties contain a non-JSON value');
  const geometry = point(feature.geometry);
  const raw = stableJson(feature);
  return Object.freeze({
    artifactId: artifact.metadata.artifactId,
    ordinal,
    visibility: artifact.metadata.visibility,
    format: 'geojson',
    featureType: 'Feature',
    geometry,
    properties: Object.freeze(properties),
    release: OVERTURE_STARBUCKS_RELEASE,
    theme: 'places',
    overtureType: 'place',
    gersId: stringValue(feature.id, 'feature.id'),
    version: finiteNumber(properties.version, 'version'),
    retrievedAt: artifact.metadata.retrievedAt,
    rawFeatureSha256: hashText(raw),
  });
}

export function decodeOvertureExcerpt(
  bytes: Uint8Array,
  artifact: Pick<AcquiredArtifactSource, 'metadata'>,
): readonly OvertureDecodedPlace[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(TEXT_DECODER.decode(bytes)) as unknown;
  } catch (error) {
    throw providerError('SCHEMA_DRIFT', 'Overture excerpt is not valid UTF-8 JSON', 'decode', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const collection = object(parsed, 'FeatureCollection');
  exactKeys(collection, ['type', 'overture', 'features'], 'FeatureCollection');
  if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new TypeError('Expected an Overture FeatureCollection');
  }
  const metadata = object(collection.overture, 'FeatureCollection.overture');
  exactKeys(
    metadata,
    ['release', 'schemaVersion', 'theme', 'featureType'],
    'FeatureCollection.overture',
  );
  if (
    metadata.release !== OVERTURE_STARBUCKS_RELEASE ||
    metadata.schemaVersion !== OVERTURE_STARBUCKS_SCHEMA_VERSION ||
    metadata.theme !== 'places' ||
    metadata.featureType !== 'place'
  ) {
    throw providerError(
      'SCHEMA_DRIFT',
      'Overture excerpt release or schema identity changed',
      'decode',
    );
  }
  return Object.freeze(
    collection.features.map((feature, ordinal) => decodeFeature(feature, ordinal, artifact)),
  );
}

async function readFixtureGeoJson(
  artifact: AcquiredArtifactSource,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (artifact.metadata.byteSize > LEGACY_WHOLE_COPY_MAX_BYTES) {
    throw providerError(
      'SCHEMA_DRIFT',
      `GeoJSON compatibility artifacts are limited to ${LEGACY_WHOLE_COPY_MAX_BYTES} bytes; production Overture acquisition must use Parquet`,
      'decode',
    );
  }
  if (artifact.bytes !== undefined) return artifact.bytes.copy();
  const bytes = new Uint8Array(artifact.content.byteLength);
  let offset = 0;
  for await (const chunk of artifact.content.read({ maxChunkBytes: 64 * 1024 })) {
    signal.throwIfAborted();
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== bytes.byteLength) {
    throw providerError(
      'SCHEMA_DRIFT',
      'Overture GeoJSON compatibility read was truncated',
      'decode',
    );
  }
  return bytes;
}

function rowToFeature(rowValue: unknown): unknown {
  const row = object(rowValue, 'DuckDB Overture row');
  exactKeys(
    row,
    [
      'id',
      'version',
      'names',
      'categories',
      'confidence',
      'brand',
      'addresses',
      'sources',
      'operating_status',
      'basic_category',
      'taxonomy',
      'longitude',
      'latitude',
      'theme',
      'type',
    ],
    'DuckDB Overture row',
  );
  if (row.theme !== 'places' || row.type !== 'place') {
    throw providerError(
      'SCHEMA_DRIFT',
      'DuckDB returned an unexpected Overture theme/type',
      'decode',
    );
  }
  return {
    type: 'Feature',
    id: row.id,
    geometry: {
      type: 'Point',
      coordinates: [row.longitude, row.latitude],
    },
    properties: {
      version: row.version,
      names: row.names,
      categories: row.categories,
      confidence: row.confidence,
      brand: row.brand,
      addresses: row.addresses,
      sources: row.sources,
      operating_status: row.operating_status,
      basic_category: row.basic_category,
      taxonomy: row.taxonomy,
    },
  };
}

function recordSnapshotId(record: OvertureDecodedPlace): SnapshotId {
  const snapshotId = (record as OvertureDecodedPlace & { readonly snapshotId?: unknown })
    .snapshotId;
  if (typeof snapshotId !== 'string') {
    throw new TypeError('Decoded Overture record is missing snapshot identity');
  }
  return snapshotId as SnapshotId;
}

function candidateLineage(
  record: OvertureDecodedPlace,
  output: Readonly<Record<string, unknown>>,
): FieldLineage {
  const snapshotId = recordSnapshotId(record);
  const sourceRecord = {
    sourceId: OVERTURE_STARBUCKS_SOURCE_ID,
    snapshotId,
    artifactId: record.artifactId,
    recordKey: record.gersId,
    recordSha256: record.rawFeatureSha256,
    rawPointer: `/features/${record.ordinal}`,
  } as const;
  const transformations = [
    {
      name: 'overture-starbucks-validate',
      version: '1.0.0',
      appliedAt: record.retrievedAt,
      inputSha256: record.rawFeatureSha256,
      outputSha256: hashText(stableJson(output)),
    },
  ] as const;
  return fieldLineageSchema.parse({
    sourceRecord,
    transformations,
    lineageSha256: hashText(stableJson({ sourceRecord, transformations })),
  });
}

function validateCandidate(
  record: OvertureDecodedPlace,
  minimumConfidence: number,
): OvertureStarbucksCandidate {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      record.gersId,
    )
  ) {
    throw new TypeError('Overture GERS ID must be a UUID');
  }
  if (!Number.isSafeInteger(record.version) || record.version < 1) {
    throw new TypeError('Overture place version must be a positive integer');
  }
  if (record.release !== OVERTURE_STARBUCKS_RELEASE || record.theme !== 'places') {
    throw new TypeError('Overture record release, theme, or type changed');
  }
  const properties = record.properties;
  const parsedNames = names(properties.names, 'names');
  const parsedCategories = categories(properties.categories);
  const parsedBrand = brand(properties.brand);
  const parsedAddresses = addresses(properties.addresses);
  const parsedContributors = contributors(properties.sources);
  const parsedGeometry = point(record.geometry);
  const confidence = finiteNumber(properties.confidence, 'confidence');
  if (confidence < 0 || confidence > 1) {
    throw new TypeError('confidence must be between zero and one');
  }
  const rawStatus = stringValue(properties.operating_status, 'operating_status', true);
  if (
    rawStatus !== null &&
    rawStatus !== 'open' &&
    rawStatus !== 'closed' &&
    rawStatus !== 'temporarily_closed' &&
    rawStatus !== 'permanently_closed'
  ) {
    throw new TypeError('operating_status is outside the frozen Overture enum');
  }
  const overtureOperatingStatus =
    rawStatus === 'closed' ||
    rawStatus === 'temporarily_closed' ||
    rawStatus === 'permanently_closed'
      ? 'closed'
      : (rawStatus ?? 'unknown');
  const sourceLicenses = Object.freeze(
    [...new Set(parsedContributors.map((contributor) => contributor.license))].sort(),
  );
  const sourceNotices = Object.freeze([
    'Overture Maps Foundation, overturemaps.org',
    ...(parsedContributors.some(
      (contributor) => contributor.dataset === 'AllThePlaces' && contributor.license === 'CC0-1.0',
    )
      ? ['AllThePlaces data is available under CC0-1.0.']
      : []),
    ...(parsedContributors.some((contributor) => contributor.license === 'CDLA-Permissive-2.0')
      ? ['Overture-derived confidence evidence is available under CDLA-Permissive-2.0.']
      : []),
    ...(parsedContributors.some(
      (contributor) => contributor.dataset === 'Foursquare' && contributor.license === 'Apache-2.0',
    )
      ? [
          'Foursquare data © 2024 Foursquare Labs, Inc.; available under Apache-2.0; transformed to the Overture schema; see Overture NOTICE.',
        ]
      : []),
  ]);
  const visibility: Visibility = sourceLicenses.every((license) => PERMISSIVE_LICENSES.has(license))
    ? record.visibility
    : 'prohibited_public';
  const updateTime = parsedContributors
    .map((contributor) => contributor.updateTime)
    .sort()
    .at(-1);
  if (updateTime === undefined) throw new TypeError('Overture candidate lacks an update time');
  const matchEvidence = classifyStarbucksMatch({
    names: parsedNames,
    categories: parsedCategories,
    brand: parsedBrand,
  });
  const candidateState =
    matchEvidence.mode === 'no_match'
      ? 'not_starbucks_candidate'
      : overtureOperatingStatus === 'closed'
        ? 'closed_candidate'
        : confidence < minimumConfidence
          ? 'low_confidence_candidate'
          : 'candidate';
  const output = {
    release: record.release,
    theme: 'places' as const,
    featureType: 'place' as const,
    gersId: record.gersId,
    version: record.version,
    geometry: parsedGeometry,
    names: parsedNames,
    categories: parsedCategories,
    brand: parsedBrand,
    confidence,
    overtureOperatingStatus,
    addresses: parsedAddresses,
    contributors: parsedContributors,
    sourceLicenses,
    sourceNotices,
    updateTime,
    matchEvidence,
    validation: NOT_SAMPLED_VALIDATION,
    candidateState,
  } as const;
  return Object.freeze({
    artifactId: record.artifactId,
    snapshotId: recordSnapshotId(record),
    ordinal: record.ordinal,
    visibility,
    ...output,
    artifactRetrievedAt: record.retrievedAt,
    rawFeatureSha256: record.rawFeatureSha256,
    lineage: candidateLineage(record, output),
  });
}

function asJson(value: unknown): ContractJsonValue {
  if (!jsonValue(value)) throw new TypeError('Canonical observation value is not JSON-safe');
  return value as ContractJsonValue;
}

function canonicalLineage(
  record: OvertureStarbucksCandidate,
  fieldPath: string,
  value: ContractJsonValue,
): FieldLineage {
  const sourceRecord = record.lineage.sourceRecord;
  const transformations = [
    {
      name: `overture-starbucks-normalize:${fieldPath}`,
      version: '1.0.0',
      appliedAt: record.updateTime,
      inputSha256: record.rawFeatureSha256,
      outputSha256: hashText(stableJson(value)),
    },
  ] as const;
  return fieldLineageSchema.parse({
    sourceRecord,
    transformations,
    lineageSha256: hashText(stableJson({ sourceRecord, transformations })),
  });
}

function contentType(response: HttpResponse): string {
  return (
    (header(response.headers, 'content-type') ?? 'application/octet-stream')
      .split(';', 1)[0]
      ?.trim()
      .toLowerCase() ?? 'application/octet-stream'
  );
}

async function visibilityCounts(
  mutations: AsyncIterable<CanonicalMutation>,
): Promise<Record<Visibility, number>> {
  const counts: Record<Visibility, number> = {
    public: 0,
    authenticated: 0,
    restricted: 0,
    prohibited_public: 0,
  };
  for await (const mutation of mutations) counts[mutation.visibility] += 1;
  return counts;
}

export class OvertureStarbucksAdapter implements StreamingSourceAdapter<
  OvertureDecodedPlace,
  OvertureStarbucksCandidate
> {
  readonly #artifact: OvertureArtifactConfig;
  readonly #maximumRows: number;
  readonly #minimumConfidence: number;

  public constructor(options: OvertureAdapterOptions = {}) {
    this.#artifact = options.artifact ?? DEFAULT_ARTIFACT;
    this.#maximumRows = options.maximumRows ?? MAXIMUM_ROWS;
    this.#minimumConfidence = options.minimumCandidateConfidence ?? MINIMUM_CONFIDENCE;
    if (!this.#artifact.url.startsWith('https://'))
      throw new TypeError('Overture artifact URL must use HTTPS');
    if (!/^[a-f0-9]{64}$/u.test(this.#artifact.expectedSha256)) {
      throw new TypeError('Overture artifact must pin a lowercase SHA-256');
    }
    if (!Number.isSafeInteger(this.#artifact.expectedBytes) || this.#artifact.expectedBytes < 1) {
      throw new TypeError('Overture artifact byte size must be positive');
    }
    if (
      !Number.isSafeInteger(this.#maximumRows) ||
      this.#maximumRows < 1 ||
      this.#maximumRows > MAXIMUM_ROWS
    ) {
      throw new RangeError(`maximumRows must be between 1 and ${MAXIMUM_ROWS}`);
    }
    if (
      !Number.isFinite(this.#minimumConfidence) ||
      this.#minimumConfidence < 0 ||
      this.#minimumConfidence > 1
    ) {
      throw new RangeError('minimumCandidateConfidence must be between zero and one');
    }
  }

  public describe(): SourceDescriptor {
    return OVERTURE_STARBUCKS_DESCRIPTOR;
  }

  public async discover(context: DiscoveryContext): Promise<DiscoveryResult> {
    const result = await requestWithRetry(
      { method: 'HEAD', url: this.#artifact.url, accept: this.#artifact.mediaTypes.join(', ') },
      context,
    );
    try {
      assertFrozenHeaders(result.response, this.#artifact, 'discover');
    } catch (error) {
      await discardResponseBody(result.response, context.signal);
      throw error;
    }
    return Object.freeze({
      sourceId: OVERTURE_STARBUCKS_DESCRIPTOR.sourceId,
      discoveredAt: context.clock.now(),
      resources: Object.freeze([
        Object.freeze({
          requestKey: `overture-${OVERTURE_STARBUCKS_RELEASE}-santa-clara-fragment`,
          url: this.#artifact.url,
          sourceAsOf: { state: 'reported' as const, at: this.#artifact.expectedLastModified },
          expectedRecords: null,
          mediaTypes: this.#artifact.mediaTypes,
          continuationToken: null,
        }),
      ]),
      complete: true,
      limitations: Object.freeze([
        'Rows are Starbucks candidates from a pinned Overture release, not silently confirmed current stores.',
        'Official Starbucks-locator evidence is sampled manually and never scraped or republished.',
        'Google Places is outside this adapter and no Google content or identifier is persisted.',
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
      request.sourceId !== OVERTURE_STARBUCKS_SOURCE_ID ||
      discovery.sourceId !== request.sourceId
    ) {
      throw providerError(
        'RECORD_QUALITY',
        'Overture acquisition request/discovery source mismatch',
        'plan',
      );
    }
    const resource = discovery.resources[0];
    if (resource?.url !== this.#artifact.url || discovery.resources.length !== 1) {
      throw providerError('SCHEMA_DRIFT', 'Overture discovery resource changed', 'plan');
    }
    return Promise.resolve(
      acquisitionPlanSchema.parse({
        sourceId: request.sourceId,
        snapshotId: request.snapshotId,
        contractVersion: OVERTURE_STARBUCKS_DESCRIPTOR.contractVersion,
        plannedAt: context.clock.now(),
        items: [
          {
            requestKey: resource.requestKey,
            sequence: 0,
            method: 'GET',
            url: resource.url,
            encoding: this.#artifact.encoding,
            expectedMediaTypes: this.#artifact.mediaTypes,
          },
        ],
      }),
    );
  }

  public async *acquire(
    plan: AcquisitionPlan,
    checkpoint: SourceCheckpoint | undefined,
    context: StreamingAcquisitionContext,
  ): AsyncIterable<StreamingAcquiredArtifact> {
    context.signal.throwIfAborted();
    if (plan.sourceId !== OVERTURE_STARBUCKS_SOURCE_ID || plan.items.length !== 1) {
      throw providerError('RECORD_QUALITY', 'Overture plan identity changed', 'acquire');
    }
    const item = plan.items[0];
    if (item === undefined) throw new Error('Overture plan lost its only item');
    const expectedArtifactId = `sc:artifact:sha256:${this.#artifact.expectedSha256}` as ArtifactId;
    const scope = `${OVERTURE_STARBUCKS_SOURCE_ID}|${plan.snapshotId}`;
    const persisted = await context.checkpointStore.load(scope);
    const persistedCheckpoint =
      persisted === undefined
        ? undefined
        : checkpointForPlan(persisted.payload, plan, item.requestKey, expectedArtifactId, 'stored');
    const callerCheckpoint =
      checkpoint === undefined
        ? undefined
        : checkpointForPlan(checkpoint, plan, item.requestKey, expectedArtifactId, 'caller');
    if (
      callerCheckpoint !== undefined &&
      persistedCheckpoint !== undefined &&
      stableJson(callerCheckpoint) !== stableJson(persistedCheckpoint)
    ) {
      throw providerError(
        'RECONCILIATION',
        'Passed checkpoint conflicts with persisted checkpoint',
        'acquire',
      );
    }
    const current = callerCheckpoint ?? persistedCheckpoint;
    const replayingCommittedArtifact =
      current?.complete === true ||
      current?.completedRequestKeys.includes(item.requestKey) === true;
    const extension = this.#artifact.encoding === 'parquet' ? 'parquet' : 'geojson';
    const logicalKey = `raw/overture-starbucks/${OVERTURE_STARBUCKS_RELEASE}/${item.requestKey}.${extension}`;
    let stored = await context.artifactStore.headByLogicalKey(logicalKey);
    let mediaType: string;
    let retrievedAt: string;
    let responseEtag: string | null;
    let responseLastModified: string | null;
    let attempt: number;
    if (stored === undefined && replayingCommittedArtifact) {
      throw providerError(
        'RECONCILIATION',
        'Committed Overture checkpoint is missing its immutable raw artifact; no network replay was attempted',
        'acquire',
      );
    }
    if (stored === undefined) {
      const result = await requestWithRetry(
        { method: 'GET', url: item.url, accept: item.expectedMediaTypes.join(', ') },
        context,
      );
      try {
        assertFrozenHeaders(result.response, this.#artifact, 'acquire');
        mediaType = contentType(result.response);
        if (!item.expectedMediaTypes.includes(mediaType)) {
          throw providerError('SCHEMA_DRIFT', 'Overture artifact media type changed', 'acquire', {
            mediaType,
          });
        }
      } catch (error) {
        await discardResponseBody(result.response, context.signal);
        throw error;
      }
      retrievedAt = context.clock.now();
      responseEtag = header(result.response.headers, 'etag') ?? null;
      responseLastModified = parseHttpInstant(header(result.response.headers, 'last-modified'));
      attempt = result.attempt;
      stored = await persistAcquiredBody({
        store: context.artifactStore,
        logicalKey,
        mediaType,
        body: result.response.body,
        maximumBytes: this.#artifact.expectedBytes,
        expectedSha256: this.#artifact.expectedSha256,
        metadata: Object.freeze({
          sourceId: OVERTURE_STARBUCKS_SOURCE_ID,
          release: OVERTURE_STARBUCKS_RELEASE,
          theme: 'places',
          type: 'place',
          sourceUrl: item.url,
          retrievedAt,
          responseEtag: responseEtag ?? '',
          responseLastModified: responseLastModified ?? '',
          attempt: String(attempt),
        }),
        signal: context.signal,
      });
    } else {
      mediaType = stored.mediaType;
      retrievedAt = stored.metadata.retrievedAt ?? context.clock.now();
      responseEtag =
        stored.metadata.responseEtag === '' ? null : (stored.metadata.responseEtag ?? null);
      responseLastModified =
        stored.metadata.responseLastModified === ''
          ? null
          : (stored.metadata.responseLastModified ?? null);
      attempt = Number(stored.metadata.attempt ?? '1');
    }
    if (
      stored.byteSize !== this.#artifact.expectedBytes ||
      stored.sha256 !== this.#artifact.expectedSha256 ||
      !item.expectedMediaTypes.includes(stored.mediaType)
    ) {
      throw providerError(
        'SCHEMA_DRIFT',
        'Overture artifact bytes do not match the frozen release',
        'acquire',
        {
          expectedBytes: this.#artifact.expectedBytes,
          actualBytes: stored.byteSize,
          expectedSha256: this.#artifact.expectedSha256,
          actualSha256: stored.sha256,
        },
      );
    }
    const sha256 = stored.sha256;
    const artifactId = `sc:artifact:sha256:${sha256}` as ArtifactId;
    const metadata = acquiredArtifactSchema.parse({
      artifactId,
      sourceId: OVERTURE_STARBUCKS_SOURCE_ID,
      snapshotId: plan.snapshotId,
      retrievedAt,
      sourceAsOf: { state: 'reported', at: this.#artifact.expectedLastModified },
      request: {
        requestKey: item.requestKey,
        method: 'GET',
        url: item.url,
        headers: [
          {
            name: 'accept',
            valueSha256: sha256Hex(TEXT_ENCODER.encode(item.expectedMediaTypes.join(', '))),
          },
        ],
        bodySha256: null,
        attempt,
      },
      response: {
        httpStatus: 200,
        etag: responseEtag,
        lastModified: responseLastModified,
        finalUrl: item.url,
      },
      mediaType,
      encoding: this.#artifact.encoding,
      byteSize: stored.byteSize,
      sha256,
      schemaFingerprint: {
        algorithm: 'sha256',
        value: OVERTURE_STARBUCKS_SCHEMA_FINGERPRINT,
        schemaName: `overture-places-v${OVERTURE_STARBUCKS_SCHEMA_VERSION}`,
        canonicalizationVersion: '1.0.0',
      },
      rawUri: stored.uri,
      licenseSnapshotRef: OVERTURE_STARBUCKS_DESCRIPTOR.license.licenseSnapshotId,
      visibility: OVERTURE_STARBUCKS_DESCRIPTOR.defaultVisibility,
    });
    let analyticalManifestLogicalKey: string | undefined;
    if (metadata.encoding === 'parquet') {
      analyticalManifestLogicalKey = `${logicalKey}.analytical-manifest.json`;
      const manifestBytes = encodeAnalyticalSnapshotManifest({
        formatVersion: '1.0.0',
        dataArtifacts: Object.freeze([
          Object.freeze({
            uri: stored.uri,
            byteLength: stored.byteSize,
            sha256: stored.sha256,
          }),
        ]),
        scanBytesByOperation: Object.freeze({
          decode_overture_santa_clara_starbucks_candidates: stored.byteSize,
        }),
      });
      const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
      const orphan = await context.artifactStore.headByLogicalKey(analyticalManifestLogicalKey);
      if (orphan === undefined && replayingCommittedArtifact) {
        throw providerError(
          'RECONCILIATION',
          'Committed Overture checkpoint is missing its analytical manifest',
          'acquire',
        );
      }
      const manifest =
        orphan ??
        (await persistAcquiredBody({
          store: context.artifactStore,
          logicalKey: analyticalManifestLogicalKey,
          mediaType: ANALYTICAL_SNAPSHOT_MANIFEST_MEDIA_TYPE,
          body: (async function* () {
            await Promise.resolve();
            yield manifestBytes;
          })(),
          maximumBytes: 1024 * 1024,
          expectedSha256: manifestSha256,
          metadata: Object.freeze({
            sourceId: metadata.sourceId,
            snapshotId: metadata.snapshotId,
            parentArtifactId: metadata.artifactId,
            formatVersion: '1.0.0',
          }),
          signal: context.signal,
        }));
      if (
        manifest.mediaType !== ANALYTICAL_SNAPSHOT_MANIFEST_MEDIA_TYPE ||
        manifest.byteSize !== manifestBytes.byteLength ||
        manifest.sha256 !== manifestSha256 ||
        manifest.metadata.parentArtifactId !== metadata.artifactId ||
        manifest.metadata.formatVersion !== '1.0.0'
      ) {
        throw providerError(
          'SCHEMA_DRIFT',
          'Overture analytical manifest orphan does not match the frozen artifact',
          'acquire',
        );
      }
    }
    if (!replayingCommittedArtifact) {
      const nextCheckpoint = sourceCheckpointSchema.parse({
        sourceId: plan.sourceId,
        snapshotId: plan.snapshotId,
        contractVersion: plan.contractVersion,
        cursor: 'complete',
        nextSequence: 1,
        completedRequestKeys: [item.requestKey],
        acquiredArtifactIds: [artifactId],
        updatedAt: retrievedAt,
        complete: true,
      });
      const envelope = createCheckpointEnvelope({
        scope,
        previousRevision: persisted?.revision ?? null,
        writtenAt: retrievedAt,
        payload: nextCheckpoint,
      });
      const committed = await context.checkpointStore.commit({
        expectedRevision: persisted?.revision ?? null,
        checkpoint: envelope,
      });
      if (committed.status === 'conflict') {
        throw providerError('RECONCILIATION', 'Optimistic Overture checkpoint conflict', 'acquire');
      }
    }
    yield await createStreamingAcquiredArtifact(metadata, context.artifactStore, {
      ...(analyticalManifestLogicalKey === undefined ? {} : { analyticalManifestLogicalKey }),
    });
  }

  public async *decode(
    artifact: AcquiredArtifactSource,
    context: StreamingDecodeContext,
  ): AsyncIterable<OvertureDecodedPlace> {
    context.signal.throwIfAborted();
    if (artifact.metadata.sourceId !== OVERTURE_STARBUCKS_SOURCE_ID) {
      throw providerError('RECORD_QUALITY', 'Artifact belongs to another source', 'decode');
    }
    const attachSnapshot = (record: OvertureDecodedPlace): OvertureDecodedPlace =>
      Object.freeze({ ...record, snapshotId: artifact.metadata.snapshotId });
    if (artifact.metadata.encoding === 'geojson') {
      const bytes = await readFixtureGeoJson(artifact, context.signal);
      for (const record of decodeOvertureExcerpt(bytes, artifact)) {
        context.signal.throwIfAborted();
        yield attachSnapshot(record);
      }
      return;
    }
    if (artifact.metadata.encoding !== 'parquet') {
      throw providerError(
        'SCHEMA_DRIFT',
        'Overture decoder received a non-Parquet artifact',
        'decode',
      );
    }
    const analyticalSnapshot = artifact.content?.analyticalSnapshot;
    if (artifact.content !== undefined && analyticalSnapshot === undefined) {
      throw providerError(
        'SCHEMA_DRIFT',
        'Overture Parquet artifact is missing its bounded analytical manifest',
        'decode',
      );
    }
    const session = await context.analyticalRuntime.open(
      {
        releaseId: OVERTURE_STARBUCKS_RELEASE,
        manifestUri: analyticalSnapshot?.manifestUri ?? artifact.metadata.rawUri,
        manifestSha256: analyticalSnapshot?.manifestSha256 ?? artifact.metadata.sha256,
      },
      context.signal,
    );
    try {
      let lastGersId = '';
      let ordinal = 0;
      for (;;) {
        context.signal.throwIfAborted();
        const result = await session.execute({
          operation: 'decode_overture_santa_clara_starbucks_candidates',
          statement: OVERTURE_STARBUCKS_QUERY,
          parameters: [
            artifact.metadata.rawUri,
            SANTA_CLARA_OVERTURE_BOUNDS.west,
            SANTA_CLARA_OVERTURE_BOUNDS.east,
            SANTA_CLARA_OVERTURE_BOUNDS.south,
            SANTA_CLARA_OVERTURE_BOUNDS.north,
            STARBUCKS_WIKIDATA_ID,
            '%starbucks%',
            '%starbucks%',
            lastGersId,
          ],
          timeoutMs: 120_000,
          maximumScanBytes: this.#artifact.expectedBytes,
          maximumRows: 1,
          signal: context.signal,
        });
        const row = result.rows[0];
        if (row === undefined) break;
        const record = attachSnapshot(decodeFeature(rowToFeature(row), ordinal, artifact));
        if (record.gersId <= lastGersId) {
          throw providerError(
            'QUERY_REGRESSION',
            'Overture keyset page did not advance in GERS ID order',
            'decode',
          );
        }
        yield record;
        ordinal += 1;
        lastGersId = record.gersId;
        if (!result.truncated) break;
        if (ordinal >= this.#maximumRows) {
          throw providerError(
            'QUERY_REGRESSION',
            'Overture candidate query exceeded its frozen row bound',
            'decode',
          );
        }
      }
    } finally {
      await session[Symbol.asyncDispose]();
    }
  }

  public async validate(
    record: OvertureDecodedPlace,
    context: ValidationContext,
  ): Promise<RecordValidation<OvertureStarbucksCandidate>> {
    await Promise.resolve();
    context.signal.throwIfAborted();
    try {
      const candidate = validateCandidate(record, this.#minimumConfidence);
      if (candidate.candidateState === 'not_starbucks_candidate') {
        const noMatchIssue: ValidationIssue = {
          code: 'overture.starbucks.no_match_evidence',
          severity: 'error',
          message: 'Place lacks Starbucks Wikidata, brand-name, or primary-name evidence',
          recordKey: record.gersId,
          fieldPath: '/brand',
        };
        return Object.freeze({ status: 'rejected', issues: Object.freeze([noMatchIssue]) });
      }
      const issues: ValidationIssue[] = [];
      if (candidate.candidateState === 'low_confidence_candidate') {
        issues.push({
          code: 'overture.starbucks.low_confidence',
          severity: 'warning',
          message: 'Candidate remains visible but is below the configured confidence threshold',
          recordKey: candidate.gersId,
          fieldPath: '/confidence',
        });
      }
      if (candidate.candidateState === 'closed_candidate') {
        issues.push({
          code: 'overture.starbucks.closed_candidate',
          severity: 'warning',
          message: 'Overture reports a closed state; retain as evidence and do not treat as open',
          recordKey: candidate.gersId,
          fieldPath: '/operating_status',
        });
      }
      if (candidate.visibility === 'prohibited_public') {
        issues.push({
          code: 'overture.starbucks.unknown_contributor_license',
          severity: 'warning',
          message: 'Unknown contributor license prevents public projection',
          recordKey: candidate.gersId,
          fieldPath: '/sources',
        });
      }
      return Object.freeze({
        status: 'accepted',
        record: candidate,
        issues: Object.freeze(issues),
      });
    } catch (error) {
      const rejectionIssue: ValidationIssue = {
        code: 'overture.starbucks.schema_or_record_quality',
        severity: 'error',
        message: error instanceof Error ? error.message : String(error),
        recordKey: record.gersId || null,
        fieldPath: null,
      };
      return Object.freeze({ status: 'rejected', issues: Object.freeze([rejectionIssue]) });
    }
  }

  public async *normalize(
    record: OvertureStarbucksCandidate,
    context: NormalizationContext,
  ): AsyncIterable<CanonicalMutation> {
    await Promise.resolve();
    context.signal.throwIfAborted();
    const entityId = `sc:entity:place:overture-${record.gersId}` as EntityId;
    const runId = deterministicId('sc:run:', record.snapshotId, 'overture-starbucks-normalize');
    const operatingState =
      record.validation.state === 'sampled_open'
        ? 'verified_open'
        : record.overtureOperatingStatus === 'closed' ||
            record.validation.state === 'sampled_closed'
          ? 'unknown'
          : 'candidate';
    const brandIdentifiers = [
      ...(record.brand?.wikidata === null || record.brand?.wikidata === undefined
        ? []
        : [`wikidata:${record.brand.wikidata}`]),
      `overture-gers:${record.gersId}`,
    ];
    const entity = {
      id: entityId,
      entityKind: 'place' as const,
      version: record.version,
      validFrom: record.updateTime,
      validTo: null,
      recordedAt: record.updateTime,
      visibility: record.visibility,
      sourceIds: [OVERTURE_STARBUCKS_SOURCE_ID],
      lineage: [record.lineage],
      name: record.names.primary,
      categories: [record.categories.primary, ...record.categories.alternate],
      brandIdentifiers,
      location: record.geometry,
      confidence: record.confidence,
      operatingState,
    };
    const fields: readonly Readonly<{ path: string; value: ContractJsonValue }>[] = [
      { path: '/name', value: entity.name },
      { path: '/categories', value: asJson(entity.categories) },
      { path: '/brandIdentifiers', value: asJson(entity.brandIdentifiers) },
      { path: '/location', value: asJson(entity.location) },
      { path: '/confidence', value: entity.confidence },
      { path: '/operatingState', value: entity.operatingState },
      { path: '/overture/release', value: record.release },
      { path: '/overture/theme', value: record.theme },
      { path: '/overture/type', value: record.featureType },
      { path: '/overture/gersId', value: record.gersId },
      { path: '/overture/geometry', value: asJson(record.geometry) },
      { path: '/overture/names', value: asJson(record.names) },
      { path: '/overture/categories', value: asJson(record.categories) },
      { path: '/overture/brandEvidence', value: asJson(record.matchEvidence) },
      { path: '/overture/contributors', value: asJson(record.contributors) },
      { path: '/overture/sourceLicenses', value: asJson(record.sourceLicenses) },
      { path: '/overture/sourceNotices', value: asJson(record.sourceNotices) },
      { path: '/overture/updateTime', value: record.updateTime },
      { path: '/overture/operatingStatus', value: record.overtureOperatingStatus },
      { path: '/overture/manualLocatorValidation', value: asJson(record.validation) },
      { path: '/overture/candidateState', value: record.candidateState },
    ];
    yield canonicalMutationSchema.parse({
      kind: 'entity_upsert',
      mutationId: deterministicId('sc:mutation:', record.snapshotId, record.gersId, 'entity'),
      runId,
      sourceId: OVERTURE_STARBUCKS_SOURCE_ID,
      snapshotId: record.snapshotId,
      sequence: record.ordinal * 100,
      emittedAt: record.updateTime,
      visibility: record.visibility,
      entity,
    });
    for (const [index, field] of fields.entries()) {
      context.signal.throwIfAborted();
      yield canonicalMutationSchema.parse({
        kind: 'field_observation',
        mutationId: deterministicId('sc:mutation:', record.snapshotId, record.gersId, field.path),
        runId,
        sourceId: OVERTURE_STARBUCKS_SOURCE_ID,
        snapshotId: record.snapshotId,
        sequence: record.ordinal * 100 + index + 1,
        emittedAt: record.updateTime,
        visibility: record.visibility,
        observation: {
          observationId: deterministicId(
            'sc:observation:',
            record.snapshotId,
            record.gersId,
            field.path,
          ),
          entityId,
          entityKind: 'place',
          fieldPath: field.path,
          value: field.value,
          observedAt: record.updateTime,
          sourceAsOf: record.updateTime,
          authorityRank: OVERTURE_STARBUCKS_DESCRIPTOR.authority.authorityRank,
          confidence: record.confidence,
          visibility: record.visibility,
          lineage: canonicalLineage(record, field.path, field.value),
        },
      });
    }
    yield canonicalMutationSchema.parse({
      kind: 'artifact_reference',
      mutationId: deterministicId('sc:mutation:', record.snapshotId, record.gersId, 'artifact'),
      runId,
      sourceId: OVERTURE_STARBUCKS_SOURCE_ID,
      snapshotId: record.snapshotId,
      sequence: record.ordinal * 100 + fields.length + 1,
      emittedAt: record.updateTime,
      visibility: record.visibility,
      artifact: {
        artifactId: record.artifactId,
        role: 'raw',
        entityId,
        description: `Pinned Overture Places ${record.release} source fragment for GERS ${record.gersId}`,
      },
    });
  }

  public async summarize(
    run: SourceRunObservationV2,
    context: SummaryContext,
  ): Promise<SourceRunSummary> {
    context.signal.throwIfAborted();
    let warnings = 0;
    let errors = 0;
    for await (const issue of run.validationIssues.read()) {
      context.signal.throwIfAborted();
      if (issue.severity === 'warning') warnings += 1;
      else errors += 1;
    }
    const status = run.aborted
      ? 'aborted'
      : errors > 0 || run.rejectedRecords > 0
        ? run.acceptedRecords > 0
          ? 'partial'
          : 'failed'
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
      visibilityCounts: await visibilityCounts(run.mutations.read()),
      warningCount: warnings,
      errorCount: errors,
      finalCheckpoint: run.finalCheckpoint,
    });
  }
}

export function createOvertureStarbucksAdapter(
  options: OvertureAdapterOptions = {},
): OvertureStarbucksAdapter {
  return new OvertureStarbucksAdapter(options);
}
