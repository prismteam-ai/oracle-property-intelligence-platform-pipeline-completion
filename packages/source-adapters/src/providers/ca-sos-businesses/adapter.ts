import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { assertStoredArtifactIntegrity } from '@oracle/artifacts/artifact-store';
import { createCheckpointEnvelope, type CheckpointValue } from '@oracle/artifacts/checkpoint-store';
import {
  fieldLineageSchema,
  type FieldLineage,
  type SourceRecordReference,
} from '@oracle/contracts/canonical/lineage';
import {
  canonicalMutationSchema,
  type CanonicalMutation,
} from '@oracle/contracts/canonical/mutation';
import { businessSchema } from '@oracle/contracts/canonical/organization';
import { oracleErrorSchema, type OracleErrorCode } from '@oracle/contracts/errors';
import {
  acquiredArtifactSchema,
  acquisitionPlanSchema,
  sourceCheckpointSchema,
  sourceRunSummarySchema,
  type AcquisitionPlan,
  type AcquisitionRequest,
  type AcquiredArtifact,
  type SourceCheckpoint,
  type SourceRunSummary,
  type ValidationIssue,
} from '@oracle/contracts/source';
import type { Visibility } from '@oracle/contracts/visibility';
import { parse } from 'csv-parse';
import { unzipSync } from 'fflate';

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
import type { JsonValue } from '../../spi/decode.js';
import type { HttpHeaders, HttpResponse } from '../../spi/http.js';
import {
  CA_SOS_BUSINESS_DESCRIPTOR,
  CA_SOS_BUSINESS_LICENSE_ID,
  CA_SOS_BUSINESS_SOURCE_ID,
  CA_SOS_CONTRACT_VERSION,
  CA_SOS_INTERCHANGE_HEADER,
  CA_SOS_TRANSFORM_VERSION,
} from './constants.js';
import type {
  CaSosBusinessAdapterOptions,
  CaSosBusinessSourceLock,
  CaSosDecodedBusinessRecord,
  CaSosEntityNumberKind,
  CaSosValidatedBusinessRecord,
} from './types.js';

const ACCEPT = 'application/zip, application/octet-stream, text/csv';
const ACCEPT_HASH = sha256Hex(new TextEncoder().encode(ACCEPT));
const DEFAULT_MAXIMUM_BYTES = 2 * 1024 * 1024 * 1024;
const CSV_CHUNK_BYTES = 64 * 1024;
const TEXT_ENCODER = new TextEncoder();

class CaSosBusinessError extends Error {
  public readonly code: OracleErrorCode;
  public readonly retryable: boolean;
  public readonly sourceId: string;
  public readonly phase: string;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    code: OracleErrorCode,
    message: string,
    phase: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    const parsed = oracleErrorSchema.parse({
      code,
      retryable: code === 'TRANSIENT_SOURCE',
      message,
      sourceId: CA_SOS_BUSINESS_SOURCE_ID,
      phase,
      details,
    });
    super(parsed.message);
    this.name = 'CaSosBusinessError';
    this.code = parsed.code;
    this.retryable = parsed.retryable;
    this.sourceId = parsed.sourceId ?? CA_SOS_BUSINESS_SOURCE_ID;
    this.phase = parsed.phase ?? phase;
    this.details = parsed.details ?? {};
  }
}

function sourceError(
  code: OracleErrorCode,
  message: string,
  phase: string,
  details: Readonly<Record<string, unknown>> = {},
): CaSosBusinessError {
  return new CaSosBusinessError(code, message, phase, details);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function hashParts(...parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex');
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

function retryAfterMs(response: HttpResponse): number | undefined {
  const value = header(response.headers, 'retry-after');
  if (value === undefined) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    String(error.name) === 'AbortError'
  );
}

async function requestWithRetry(
  context: DiscoveryContext | AcquisitionContext,
  url: string,
  phase: 'discover' | 'acquire',
): Promise<Readonly<{ response: HttpResponse; attempt: number }>> {
  let lastStatus: number | null = null;
  let lastTransportError: string | null = null;
  for (let attempt = 1; attempt <= context.ratePolicy.maxAttempts; attempt += 1) {
    context.signal.throwIfAborted();
    let response: HttpResponse;
    try {
      response = await context.http.send(
        { method: 'GET', url, headers: { accept: ACCEPT } },
        context.signal,
      );
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
      context.signal.throwIfAborted();
      lastTransportError = error instanceof Error ? error.message : String(error);
      if (attempt < context.ratePolicy.maxAttempts) {
        const backoff = Math.min(
          context.ratePolicy.maxBackoffMs,
          context.ratePolicy.initialBackoffMs * 2 ** (attempt - 1),
        );
        await context.delay.wait(backoff, context.signal);
        continue;
      }
      break;
    }
    if (response.status >= 200 && response.status < 300) {
      return Object.freeze({ response, attempt });
    }
    lastStatus = response.status;
    if (response.status === 401) {
      throw sourceError('AUTHENTICATION', 'bizfile bulk download authentication failed', phase);
    }
    if (response.status === 403) {
      throw sourceError(
        'TERMS_ACCESS',
        'bizfile bulk download access was denied; no anti-bot or CAPTCHA bypass is attempted',
        phase,
      );
    }
    if (response.status !== 429 && response.status < 500) {
      throw sourceError('RECORD_QUALITY', `Permanent bulk download HTTP ${response.status}`, phase);
    }
    if (attempt < context.ratePolicy.maxAttempts) {
      const backoff = Math.min(
        context.ratePolicy.maxBackoffMs,
        context.ratePolicy.initialBackoffMs * 2 ** (attempt - 1),
      );
      await context.delay.wait(
        context.ratePolicy.respectRetryAfter ? (retryAfterMs(response) ?? backoff) : backoff,
        context.signal,
      );
    }
  }
  throw sourceError(
    'TRANSIENT_SOURCE',
    'bizfile bulk download exhausted its bounded retry budget',
    phase,
    { lastStatus, lastTransportError },
  );
}

async function collectBody(
  response: HttpResponse,
  signal: AbortSignal,
  maximumBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    size += chunk.byteLength;
    if (size > maximumBytes) {
      throw sourceError(
        'SCHEMA_DRIFT',
        'Bulk artifact exceeds the frozen byte ceiling',
        'acquire',
        {
          maximumBytes,
        },
      );
    }
    chunks.push(Uint8Array.from(chunk));
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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
  artifactId: AcquiredArtifact['artifactId'],
  updatedAt: string,
): SourceCheckpoint {
  return sourceCheckpointSchema.parse({
    sourceId: plan.sourceId,
    snapshotId: plan.snapshotId,
    contractVersion: plan.contractVersion,
    cursor: 'sequence:1',
    nextSequence: 1,
    completedRequestKeys: ['business-entities'],
    acquiredArtifactIds: [artifactId],
    updatedAt,
    complete: true,
  });
}

function parseCheckpoint(
  candidate: unknown,
  plan: AcquisitionPlan,
  origin: 'caller' | 'store',
): SourceCheckpoint {
  const parsed = sourceCheckpointSchema.safeParse(candidate);
  if (!parsed.success) {
    throw sourceError('SCHEMA_DRIFT', `Invalid ${origin} checkpoint`, 'acquire');
  }
  if (
    parsed.data.sourceId !== plan.sourceId ||
    parsed.data.snapshotId !== plan.snapshotId ||
    parsed.data.contractVersion !== plan.contractVersion ||
    parsed.data.nextSequence > 1
  ) {
    throw sourceError(
      'SCHEMA_DRIFT',
      `${origin} checkpoint does not belong to the plan`,
      'acquire',
    );
  }
  return parsed.data;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function assertHeader(actual: readonly string[], expected: readonly string[]): void {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw sourceError('SCHEMA_DRIFT', 'CA SOS raw source header changed', 'decode', {
      expected,
      actual,
    });
  }
}

async function* csvRows(bytes: Uint8Array, signal: AbortSignal, expectedHeader: readonly string[]) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw sourceError('RECORD_QUALITY', 'CA SOS bulk CSV is not valid UTF-8', 'decode');
  }
  const readable = Readable.from(
    (function* chunks(): Iterable<Uint8Array> {
      for (let offset = 0; offset < bytes.byteLength; offset += CSV_CHUNK_BYTES) {
        signal.throwIfAborted();
        yield bytes.slice(offset, Math.min(bytes.byteLength, offset + CSV_CHUNK_BYTES));
      }
    })(),
  );
  const parser = readable.pipe(
    parse({
      bom: true,
      columns: false,
      encoding: 'utf8',
      relax_column_count: false,
      skip_empty_lines: true,
    }),
  );
  let csvHeader: readonly string[] | undefined;
  try {
    for await (const candidate of parser) {
      signal.throwIfAborted();
      if (!isStringArray(candidate)) {
        throw sourceError('RECORD_QUALITY', 'CSV parser returned a non-string row', 'decode');
      }
      const values = Object.freeze([...candidate]);
      if (csvHeader === undefined) {
        assertHeader(values, expectedHeader);
        csvHeader = values;
        continue;
      }
      yield Object.freeze({ header: csvHeader, values });
    }
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = String(error.code);
      if (code.startsWith('CSV_')) {
        throw sourceError('RECORD_QUALITY', `Malformed CA SOS CSV: ${code}`, 'decode');
      }
    }
    throw error;
  }
  if (csvHeader === undefined) {
    throw sourceError('SCHEMA_DRIFT', 'CA SOS bulk CSV contains no header', 'decode');
  }
}

function csvBytes(
  artifact: AcquiredByteArtifact,
  encoding: CaSosBusinessAdapterOptions['encoding'],
  sourceLock: CaSosBusinessSourceLock,
  maximumBytes: number,
): Uint8Array {
  const bytes = artifact.bytes.copy();
  if (encoding === 'csv') return bytes;
  const files: Readonly<{ name: string; originalSize: number }>[] = [];
  try {
    unzipSync(bytes, {
      filter: (file) => {
        files.push(Object.freeze({ name: file.name, originalSize: file.originalSize }));
        return false;
      },
    });
  } catch (error) {
    throw sourceError('RECORD_QUALITY', 'CA SOS bulk ZIP is malformed', 'decode', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  let declaredBytes = 0;
  const csvEntries: string[] = [];
  for (const file of files) {
    const normalized = file.name.replaceAll('\\', '/');
    const segments = normalized.split('/');
    const isDirectory = normalized.endsWith('/');
    const pathSegments = isDirectory ? segments.slice(0, -1) : segments;
    if (
      normalized.startsWith('/') ||
      /^[a-z]:/iu.test(normalized) ||
      file.name.includes('\\') ||
      pathSegments.length === 0 ||
      pathSegments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    ) {
      throw sourceError('SCHEMA_DRIFT', 'CA SOS ZIP contains an unsafe entry path', 'decode', {
        path: file.name,
      });
    }
    if (isDirectory) continue;
    if (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0) {
      throw sourceError('SCHEMA_DRIFT', 'CA SOS ZIP contains an invalid declared size', 'decode');
    }
    declaredBytes += file.originalSize;
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maximumBytes) {
      throw sourceError(
        'SCHEMA_DRIFT',
        'CA SOS ZIP aggregate declared bytes exceed the frozen byte ceiling',
        'decode',
        { maximumBytes },
      );
    }
    if (normalized.toLowerCase().endsWith('.csv')) csvEntries.push(file.name);
  }
  const candidates = csvEntries.filter((path) => path === sourceLock.csvEntryPath);
  if (candidates.length !== 1) {
    throw sourceError(
      'SCHEMA_DRIFT',
      'CA SOS ZIP source-locked CSV entry is missing or duplicate',
      'decode',
      {
        expectedCsvEntry: sourceLock.csvEntryPath,
        csvEntries,
      },
    );
  }
  const selectedPath = candidates[0];
  if (selectedPath === undefined) {
    throw sourceError('SCHEMA_DRIFT', 'CA SOS ZIP CSV selection failed', 'decode');
  }
  let entries: Readonly<Record<string, Uint8Array>>;
  try {
    entries = unzipSync(bytes, { filter: (file) => file.name === selectedPath });
  } catch (error) {
    throw sourceError('RECORD_QUALITY', 'CA SOS bulk ZIP is malformed', 'decode', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const csv = entries[selectedPath];
  if (csv === undefined) {
    throw sourceError('RECORD_QUALITY', 'CA SOS ZIP selected CSV could not be decoded', 'decode');
  }
  if (csv.byteLength > maximumBytes) {
    throw sourceError(
      'SCHEMA_DRIFT',
      'CA SOS ZIP decoded CSV exceeds the frozen byte ceiling',
      'decode',
      { maximumBytes },
    );
  }
  return csv;
}

function rawSourceRow(
  header: readonly string[],
  values: readonly string[],
): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(header.map((column, index) => [column, values[index] ?? ''])),
  );
}

function mappedRow(
  header: readonly string[],
  values: readonly string[],
  sourceLock: CaSosBusinessSourceLock,
): CaSosValidatedBusinessRecord['raw'] {
  const source = rawSourceRow(header, values);
  return Object.freeze(
    Object.fromEntries(
      CA_SOS_INTERCHANGE_HEADER.map((column) => [column, source[sourceLock.fieldMapping[column]]]),
    ),
  ) as CaSosValidatedBusinessRecord['raw'];
}

function parseEntityNumber(value: string): CaSosEntityNumberKind | undefined {
  if (/^\d{7,12}$/u.test(value)) return 'legacy_numeric';
  if (/^B[A-Z0-9]{11}$/u.test(value)) return 'new_b_prefixed';
  return undefined;
}

function parseDate(value: string): string | null | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(trimmed);
  if (match === null) return undefined;
  const instant = Date.parse(`${trimmed}T00:00:00.000Z`);
  if (!Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 10) !== trimmed) {
    return undefined;
  }
  return new Date(instant).toISOString();
}

function nullableText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function validateSourceLock(
  sourceLock: CaSosBusinessSourceLock,
  encoding: CaSosBusinessAdapterOptions['encoding'],
): CaSosBusinessSourceLock {
  const orderedHeader = [...sourceLock.orderedHeader];
  if (
    orderedHeader.length === 0 ||
    orderedHeader.some((column) => column.length === 0) ||
    new Set(orderedHeader).size !== orderedHeader.length
  ) {
    throw new TypeError('CA SOS source lock orderedHeader must be non-empty and unique');
  }
  const actualFingerprint = sha256Hex(TEXT_ENCODER.encode(orderedHeader.join('\u001f')));
  if (
    !/^[a-f0-9]{64}$/u.test(sourceLock.schemaFingerprint) ||
    sourceLock.schemaFingerprint !== actualFingerprint
  ) {
    throw new TypeError('CA SOS source lock schemaFingerprint does not bind orderedHeader');
  }
  const mappingKeys = Object.keys(sourceLock.fieldMapping);
  if (
    mappingKeys.length !== CA_SOS_INTERCHANGE_HEADER.length ||
    mappingKeys.some(
      (column) => !(CA_SOS_INTERCHANGE_HEADER as readonly string[]).includes(column),
    ) ||
    CA_SOS_INTERCHANGE_HEADER.some((column) => !(column in sourceLock.fieldMapping))
  ) {
    throw new TypeError(
      'CA SOS source lock fieldMapping must contain every interchange field only',
    );
  }
  const mappedColumns = CA_SOS_INTERCHANGE_HEADER.map((column) => sourceLock.fieldMapping[column]);
  if (
    new Set(mappedColumns).size !== mappedColumns.length ||
    mappedColumns.some((column) => !orderedHeader.includes(column))
  ) {
    throw new TypeError(
      'CA SOS source lock fieldMapping must reference unique columns in orderedHeader',
    );
  }
  if (encoding === 'csv' && sourceLock.csvEntryPath !== null) {
    throw new TypeError('CA SOS direct CSV source lock must use a null csvEntryPath');
  }
  if (
    encoding === 'zip' &&
    (sourceLock.csvEntryPath === null ||
      !sourceLock.csvEntryPath.toLowerCase().endsWith('.csv') ||
      sourceLock.csvEntryPath.includes('\\') ||
      sourceLock.csvEntryPath.startsWith('/') ||
      /^[a-z]:/iu.test(sourceLock.csvEntryPath) ||
      sourceLock.csvEntryPath
        .split('/')
        .some((segment) => segment.length === 0 || segment === '.' || segment === '..'))
  ) {
    throw new TypeError('CA SOS ZIP source lock must bind one safe CSV entry path');
  }
  return Object.freeze({
    csvEntryPath: sourceLock.csvEntryPath,
    orderedHeader: Object.freeze(orderedHeader),
    schemaFingerprint: sourceLock.schemaFingerprint,
    fieldMapping: Object.freeze({ ...sourceLock.fieldMapping }),
  });
}

function issue(
  code: string,
  message: string,
  recordKey: string,
  fieldPath: string | null,
): ValidationIssue {
  return Object.freeze({ code, severity: 'error', message, recordKey, fieldPath });
}

function sourceReference(record: CaSosValidatedBusinessRecord): SourceRecordReference {
  return Object.freeze({
    sourceId: CA_SOS_BUSINESS_SOURCE_ID,
    snapshotId: record.snapshotId,
    artifactId: record.artifactId,
    recordKey: record.recordKey,
    recordSha256: record.recordSha256,
    rawPointer: `/rows/${record.ordinal}`,
  });
}

function fieldLineage(
  record: CaSosValidatedBusinessRecord,
  path: string,
  value: JsonValue,
): FieldLineage {
  const outputSha256 = sha256Hex(TEXT_ENCODER.encode(canonicalJson(value)));
  const transformations = [
    {
      name: `ca-sos-businesses${path}`,
      version: CA_SOS_TRANSFORM_VERSION,
      appliedAt: record.retrievedAt,
      inputSha256: record.recordSha256,
      outputSha256,
    },
  ];
  return fieldLineageSchema.parse({
    sourceRecord: sourceReference(record),
    transformations,
    lineageSha256: sha256Hex(
      TEXT_ENCODER.encode(
        canonicalJson({ sourceRecord: sourceReference(record), transformations }),
      ),
    ),
  });
}

function visibilityCounts(mutations: readonly CanonicalMutation[]) {
  const counts: Record<Visibility, number> = {
    public: 0,
    authenticated: 0,
    restricted: 0,
    prohibited_public: 0,
  };
  for (const mutation of mutations) counts[mutation.visibility] += 1;
  return counts;
}

class CaSosBusinessAdapter implements SourceAdapter<
  CaSosDecodedBusinessRecord,
  CaSosValidatedBusinessRecord
> {
  readonly #options: CaSosBusinessAdapterOptions;
  readonly #maximumBytes: number;
  readonly #sourceLock: CaSosBusinessSourceLock;

  public constructor(options: CaSosBusinessAdapterOptions) {
    const parsedUrl = new URL(options.bulkArtifactUrl);
    if (
      parsedUrl.protocol !== 'https:' ||
      parsedUrl.hostname.toLowerCase() !== 'bizfileonline.sos.ca.gov'
    ) {
      throw new TypeError('CA SOS bulkArtifactUrl must use the official bizfile HTTPS host');
    }
    if (!/^[a-f0-9]{64}$/u.test(options.expectedSha256)) {
      throw new TypeError('CA SOS expectedSha256 must be a lowercase SHA-256');
    }
    if (!Number.isSafeInteger(options.expectedRecordCount) || options.expectedRecordCount < 0) {
      throw new TypeError('CA SOS expectedRecordCount must be a non-negative safe integer');
    }
    if (!Number.isFinite(Date.parse(options.sourceAsOf))) {
      throw new TypeError('CA SOS sourceAsOf must be an ISO date-time');
    }
    if (!Number.isFinite(Date.parse(options.normalizationTimestamp))) {
      throw new TypeError('CA SOS normalizationTimestamp must be an ISO date-time');
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(options.sourceVersion)) {
      throw new TypeError('CA SOS sourceVersion must be a safe stable key');
    }
    if (
      options.maximumBytes !== undefined &&
      (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes <= 0)
    ) {
      throw new TypeError('CA SOS maximumBytes must be a positive safe integer');
    }
    this.#sourceLock = validateSourceLock(options.sourceLock, options.encoding);
    this.#options = Object.freeze({ ...options });
    this.#maximumBytes = options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES;
  }

  public describe() {
    return CA_SOS_BUSINESS_DESCRIPTOR;
  }

  public discover(context: DiscoveryContext): Promise<DiscoveryResult> {
    context.signal.throwIfAborted();
    return Promise.resolve(
      Object.freeze({
        sourceId: CA_SOS_BUSINESS_SOURCE_ID,
        discoveredAt: context.clock.now(),
        resources: Object.freeze([
          Object.freeze({
            requestKey: 'business-entities',
            url: this.#options.bulkArtifactUrl,
            sourceAsOf: Object.freeze({ state: 'reported' as const, at: this.#options.sourceAsOf }),
            expectedRecords: this.#options.expectedRecordCount,
            mediaTypes: Object.freeze(
              this.#options.encoding === 'zip'
                ? ['application/zip', 'application/octet-stream']
                : ['text/csv'],
            ),
            continuationToken: null,
          }),
        ]),
        complete: true,
        limitations: Object.freeze([
          `Ordered bizfile export version: ${this.#options.sourceVersion}`,
          `Raw source schema fingerprint: ${this.#sourceLock.schemaFingerprint}`,
          `Source-locked CSV entry: ${this.#sourceLock.csvEntryPath ?? 'direct CSV'}`,
          'The ordered artifact URL, count, SHA-256, and source-as-of must be frozen before acquisition.',
          'The adapter does not search the CAPTCHA/anti-bot protected public portal.',
          'SOS business records are legal-entity evidence and contain no beneficial-ownership claim.',
        ]),
      }),
    );
  }

  public plan(
    request: AcquisitionRequest,
    discovery: DiscoveryResult,
    context: PlanningContext,
  ): Promise<AcquisitionPlan> {
    context.signal.throwIfAborted();
    const resource = discovery.resources[0];
    if (
      request.sourceId !== CA_SOS_BUSINESS_SOURCE_ID ||
      discovery.sourceId !== request.sourceId ||
      !discovery.complete ||
      resource?.url !== this.#options.bulkArtifactUrl ||
      resource.expectedRecords !== this.#options.expectedRecordCount ||
      request.requestedSourceAsOf.state === 'unknown' ||
      request.requestedSourceAsOf.at !== this.#options.sourceAsOf
    ) {
      throw sourceError('SCHEMA_DRIFT', 'CA SOS discovery/request binding mismatch', 'plan');
    }
    return Promise.resolve(
      acquisitionPlanSchema.parse({
        sourceId: request.sourceId,
        snapshotId: request.snapshotId,
        contractVersion: CA_SOS_CONTRACT_VERSION,
        plannedAt: context.clock.now(),
        items: [
          {
            requestKey: 'business-entities',
            sequence: 0,
            method: 'GET',
            url: resource.url,
            encoding: this.#options.encoding,
            expectedMediaTypes: [...resource.mediaTypes],
          },
        ],
      }),
    );
  }

  public async *acquire(
    plan: AcquisitionPlan,
    checkpoint: SourceCheckpoint | undefined,
    context: AcquisitionContext,
  ): AsyncIterable<AcquiredByteArtifact> {
    if (plan.sourceId !== CA_SOS_BUSINESS_SOURCE_ID || plan.items.length !== 1) {
      throw sourceError('SCHEMA_DRIFT', 'CA SOS acquisition plan mismatch', 'acquire');
    }
    const scope = `${plan.sourceId}/${plan.snapshotId}`;
    let stored = await context.checkpointStore.load(scope);
    const callerCheckpoint =
      checkpoint === undefined ? undefined : parseCheckpoint(checkpoint, plan, 'caller');
    const persistedCheckpoint =
      stored === undefined ? undefined : parseCheckpoint(stored.payload, plan, 'store');
    if (
      callerCheckpoint !== undefined &&
      persistedCheckpoint !== undefined &&
      canonicalJson(callerCheckpoint) !== canonicalJson(persistedCheckpoint)
    ) {
      throw sourceError(
        'RECONCILIATION',
        'Caller and stored CA SOS checkpoints disagree',
        'acquire',
      );
    }
    if ((persistedCheckpoint ?? callerCheckpoint)?.complete === true) return;
    const item = plan.items[0];
    if (item === undefined) return;
    context.signal.throwIfAborted();
    const { response, attempt } = await requestWithRetry(context, item.url, 'acquire');
    const bytes = await collectBody(response, context.signal, this.#maximumBytes);
    const sha256 = sha256Hex(bytes);
    if (sha256 !== this.#options.expectedSha256) {
      throw sourceError('SCHEMA_DRIFT', 'CA SOS bulk artifact SHA-256 mismatch', 'acquire', {
        expectedSha256: this.#options.expectedSha256,
        actualSha256: sha256,
      });
    }
    const responseType = header(response.headers, 'content-type');
    const mediaType = responseType?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType === undefined || !item.expectedMediaTypes.includes(mediaType)) {
      throw sourceError('SCHEMA_DRIFT', 'Unexpected CA SOS bulk media type', 'acquire', {
        mediaType: responseType ?? null,
      });
    }
    const extension = this.#options.encoding === 'zip' ? 'zip' : 'csv';
    const logicalKey = `raw/ca-sos-businesses/${plan.snapshotId}/${this.#options.sourceVersion}/${sha256}.${extension}`;
    const storedArtifact = await context.artifactStore.putImmutable({
      logicalKey,
      mediaType,
      body: bytes,
      expectedSha256: sha256,
      metadata: Object.freeze({
        authority: CA_SOS_BUSINESS_DESCRIPTOR.authority.organization,
        sourceUrl: item.url,
        sourceVersion: this.#options.sourceVersion,
        sourceAsOf: this.#options.sourceAsOf,
        expectedRecordCount: String(this.#options.expectedRecordCount),
        visibility: 'prohibited_public',
      }),
      ifAbsent: true,
    });
    assertStoredArtifactIntegrity(
      { logicalKey, mediaType, byteSize: bytes.byteLength, sha256 },
      storedArtifact,
    );
    const retrievedAt = context.clock.now();
    const metadata = acquiredArtifactSchema.parse({
      artifactId: `sc:artifact:sha256:${sha256}`,
      sourceId: plan.sourceId,
      snapshotId: plan.snapshotId,
      retrievedAt,
      sourceAsOf: { state: 'reported', at: this.#options.sourceAsOf },
      request: {
        requestKey: item.requestKey,
        method: 'GET',
        url: item.url,
        headers: [{ name: 'accept', valueSha256: ACCEPT_HASH }],
        bodySha256: null,
        attempt,
      },
      response: {
        httpStatus: response.status,
        etag: header(response.headers, 'etag') ?? null,
        lastModified: parseHttpDate(header(response.headers, 'last-modified')),
        finalUrl: item.url,
      },
      mediaType,
      encoding: this.#options.encoding,
      byteSize: bytes.byteLength,
      sha256,
      schemaFingerprint: {
        algorithm: 'sha256',
        value: this.#sourceLock.schemaFingerprint,
        schemaName: 'ca-sos-business-entity-raw-source-lock-v1',
        canonicalizationVersion: CA_SOS_CONTRACT_VERSION,
      },
      rawUri: storedArtifact.uri,
      licenseSnapshotRef: CA_SOS_BUSINESS_LICENSE_ID,
      visibility: 'prohibited_public',
    });
    const artifact = createAcquiredByteArtifact(metadata, bytes);
    const sourceCheckpoint = createSourceCheckpoint(
      plan,
      artifact.metadata.artifactId,
      context.clock.now(),
    );
    const envelope = createCheckpointEnvelope({
      scope,
      previousRevision: stored?.revision ?? null,
      writtenAt: sourceCheckpoint.updatedAt,
      payload: checkpointPayload(sourceCheckpoint),
    });
    const commit = await context.checkpointStore.commit({
      expectedRevision: stored?.revision ?? null,
      checkpoint: envelope,
    });
    if (commit.status === 'conflict') {
      throw sourceError('RECONCILIATION', 'CA SOS checkpoint commit conflicted', 'acquire');
    }
    stored = commit.checkpoint;
    void stored;
    yield artifact;
  }

  public async *decode(
    artifact: AcquiredByteArtifact,
    context: DecodeContext,
  ): AsyncIterable<CaSosDecodedBusinessRecord> {
    context.signal.throwIfAborted();
    if (
      artifact.metadata.sourceId !== CA_SOS_BUSINESS_SOURCE_ID ||
      artifact.metadata.encoding !== this.#options.encoding ||
      artifact.metadata.sha256 !== this.#options.expectedSha256
    ) {
      throw sourceError('SCHEMA_DRIFT', 'CA SOS artifact is not bound to this adapter', 'decode');
    }
    const bytes = csvBytes(artifact, this.#options.encoding, this.#sourceLock, this.#maximumBytes);
    let ordinal = 0;
    for await (const row of csvRows(bytes, context.signal, this.#sourceLock.orderedHeader)) {
      ordinal += 1;
      const raw = mappedRow(row.header, row.values, this.#sourceLock);
      const entityNumber = raw.ENTITY_NUMBER.trim().toUpperCase();
      const sourceUpdated = raw.SOURCE_UPDATED_DATE.trim() || raw.INITIAL_FILING_DATE.trim();
      const recordSha256 = sha256Hex(
        TEXT_ENCODER.encode(canonicalJson(rawSourceRow(row.header, row.values))),
      );
      yield Object.freeze({
        format: 'csv',
        artifactId: artifact.metadata.artifactId,
        ordinal,
        visibility: artifact.metadata.visibility,
        header: row.header,
        values: row.values,
        snapshotId: artifact.metadata.snapshotId,
        sourceAsOf: artifact.metadata.sourceAsOf,
        retrievedAt: artifact.metadata.retrievedAt,
        sourceVersion: this.#options.sourceVersion,
        recordKey: `${entityNumber || 'missing'}:${sourceUpdated || 'unknown'}:${recordSha256}`,
        recordSha256,
      });
    }
    if (ordinal !== this.#options.expectedRecordCount) {
      throw sourceError(
        'SCHEMA_DRIFT',
        'CA SOS bulk record count does not match source lock',
        'decode',
        {
          expected: this.#options.expectedRecordCount,
          actual: ordinal,
        },
      );
    }
  }

  public validate(
    record: CaSosDecodedBusinessRecord,
    context: ValidationContext,
  ): Promise<RecordValidation<CaSosValidatedBusinessRecord>> {
    context.signal.throwIfAborted();
    const raw = mappedRow(record.header, record.values, this.#sourceLock);
    const issues: ValidationIssue[] = [];
    const entityNumber = raw.ENTITY_NUMBER.trim().toUpperCase();
    const entityNumberKind = parseEntityNumber(entityNumber);
    if (entityNumberKind === undefined) {
      issues.push(
        issue(
          'invalid_entity_number',
          'Malformed CA SOS entity number',
          record.recordKey,
          '/ENTITY_NUMBER',
        ),
      );
    }
    const previousEntityNumber = nullableText(raw.PREVIOUS_ENTITY_NUMBER)?.toUpperCase() ?? null;
    if (
      previousEntityNumber !== null &&
      (parseEntityNumber(previousEntityNumber) === undefined ||
        previousEntityNumber === entityNumber)
    ) {
      issues.push(
        issue(
          'invalid_previous_entity_number',
          'Malformed or self-referential previous entity number',
          record.recordKey,
          '/PREVIOUS_ENTITY_NUMBER',
        ),
      );
    }
    const legalName = raw.ENTITY_NAME.trim();
    const businessType = raw.ENTITY_TYPE.trim();
    const status = raw.STATUS.trim();
    const jurisdiction = raw.JURISDICTION.trim();
    for (const [path, value] of [
      ['/ENTITY_NAME', legalName],
      ['/ENTITY_TYPE', businessType],
      ['/STATUS', status],
      ['/JURISDICTION', jurisdiction],
    ] as const) {
      if (value.length === 0)
        issues.push(issue('missing_required_field', `Missing ${path}`, record.recordKey, path));
    }
    const initialFilingAt = parseDate(raw.INITIAL_FILING_DATE);
    if (initialFilingAt === null || initialFilingAt === undefined) {
      issues.push(
        issue(
          'invalid_initial_filing_date',
          'Initial filing date must be YYYY-MM-DD',
          record.recordKey,
          '/INITIAL_FILING_DATE',
        ),
      );
    }
    const sourceUpdatedAt = parseDate(raw.SOURCE_UPDATED_DATE);
    if (sourceUpdatedAt === undefined) {
      issues.push(
        issue(
          'invalid_source_updated_date',
          'Source update date must be blank or YYYY-MM-DD',
          record.recordKey,
          '/SOURCE_UPDATED_DATE',
        ),
      );
    }
    if (
      issues.length > 0 ||
      entityNumberKind === undefined ||
      initialFilingAt == null ||
      sourceUpdatedAt === undefined
    ) {
      return Promise.resolve(Object.freeze({ status: 'rejected', issues: Object.freeze(issues) }));
    }
    return Promise.resolve(
      Object.freeze({
        status: 'accepted',
        record: Object.freeze({
          ...record,
          raw,
          entityNumber,
          previousEntityNumber,
          entityNumberKind,
          legalName,
          businessType,
          status,
          initialFilingAt,
          jurisdiction,
          streetAddress: nullableText(raw.STREET_ADDRESS),
          mailingAddress: nullableText(raw.MAILING_ADDRESS),
          agentName: nullableText(raw.AGENT_NAME),
          agentAddress: nullableText(raw.AGENT_ADDRESS),
          sourceUpdatedAt,
          visibility: 'prohibited_public',
        }),
        issues: Object.freeze([]),
      }),
    );
  }

  public async *normalize(
    record: CaSosValidatedBusinessRecord,
    context: NormalizationContext,
  ): AsyncIterable<CanonicalMutation> {
    await Promise.resolve();
    context.signal.throwIfAborted();
    const stableEntityKey = hashParts('california-sos', record.entityNumber);
    const entityId = `sc:entity:business:${stableEntityKey}`;
    const runId = this.#options.runId;
    const observedAt = record.sourceUpdatedAt ?? record.initialFilingAt;
    const entityLineage = [
      fieldLineage(record, '/entityNumber', record.entityNumber),
      fieldLineage(record, '/legalName', record.legalName),
    ];
    const entity = businessSchema.parse({
      id: entityId,
      entityKind: 'business',
      version: 1,
      validFrom: record.initialFilingAt,
      validTo: null,
      recordedAt: record.retrievedAt,
      visibility: record.visibility,
      sourceIds: [CA_SOS_BUSINESS_SOURCE_ID],
      lineage: entityLineage,
      jurisdiction: record.jurisdiction,
      entityNumber: record.entityNumber,
      legalName: record.legalName,
      status: record.status,
      businessType: record.businessType,
      addressIds: [],
    });
    const base = [record.snapshotId, record.recordKey, record.recordSha256];
    yield canonicalMutationSchema.parse({
      kind: 'entity_upsert',
      mutationId: `sc:mutation:${hashParts(...base, 'entity')}`,
      runId,
      sourceId: CA_SOS_BUSINESS_SOURCE_ID,
      snapshotId: record.snapshotId,
      sequence: record.ordinal * 20,
      emittedAt: this.#options.normalizationTimestamp,
      visibility: record.visibility,
      entity,
    });
    const fields: readonly Readonly<{ path: string; value: JsonValue; confidence: number }>[] = [
      { path: '/sourceCapabilityType', value: 'sos_entity', confidence: 1 },
      { path: '/entityNumberKind', value: record.entityNumberKind, confidence: 1 },
      { path: '/previousEntityNumber', value: record.previousEntityNumber, confidence: 1 },
      { path: '/formationOrRegistrationDate', value: record.initialFilingAt, confidence: 1 },
      { path: '/sourceStatus', value: record.status, confidence: 1 },
      { path: '/sourceJurisdiction', value: record.jurisdiction, confidence: 1 },
      { path: '/streetAddress', value: record.streetAddress, confidence: 1 },
      { path: '/mailingAddress', value: record.mailingAddress, confidence: 1 },
      { path: '/agentName', value: record.agentName, confidence: 1 },
      { path: '/agentAddress', value: record.agentAddress, confidence: 1 },
      { path: '/sourceUpdatedAt', value: record.sourceUpdatedAt, confidence: 1 },
      { path: '/sourceVersion', value: record.sourceVersion, confidence: 1 },
      {
        path: '/beneficialOwnership',
        value: null,
        confidence: 1,
      },
    ];
    for (const [index, field] of fields.entries()) {
      context.signal.throwIfAborted();
      const lineage = fieldLineage(record, field.path, field.value);
      yield canonicalMutationSchema.parse({
        kind: 'field_observation',
        mutationId: `sc:mutation:${hashParts(...base, field.path)}`,
        runId,
        sourceId: CA_SOS_BUSINESS_SOURCE_ID,
        snapshotId: record.snapshotId,
        sequence: record.ordinal * 20 + index + 1,
        emittedAt: this.#options.normalizationTimestamp,
        visibility: record.visibility,
        observation: {
          observationId: `sc:observation:${hashParts(...base, field.path)}`,
          entityId,
          entityKind: 'business',
          fieldPath: field.path,
          value: field.value,
          observedAt,
          sourceAsOf: record.sourceAsOf.state === 'unknown' ? null : record.sourceAsOf.at,
          authorityRank: CA_SOS_BUSINESS_DESCRIPTOR.authority.authorityRank,
          confidence: field.confidence,
          visibility: record.visibility,
          lineage,
        },
      });
    }
  }

  public summarize(run: SourceRunObservation, context: SummaryContext): SourceRunSummary {
    context.signal.throwIfAborted();
    if (run.decodedRecords !== this.#options.expectedRecordCount) {
      throw sourceError('SCHEMA_DRIFT', 'CA SOS summary count drift', 'summarize');
    }
    const errors = run.validationIssues.filter((item) => item.severity !== 'warning').length;
    const warnings = run.validationIssues.filter((item) => item.severity === 'warning').length;
    return sourceRunSummarySchema.parse({
      sourceId: run.descriptor.sourceId,
      snapshotId: run.request.snapshotId,
      runId: run.runId,
      contractVersion: run.descriptor.contractVersion,
      status: run.aborted
        ? 'aborted'
        : errors > 0 || run.rejectedRecords > 0
          ? 'partial'
          : 'succeeded',
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      artifactsAcquired: run.artifacts.length,
      bytesAcquired: run.artifacts.reduce((sum, artifact) => sum + artifact.byteSize, 0),
      decodedRecords: run.decodedRecords,
      acceptedRecords: run.acceptedRecords,
      rejectedRecords: run.rejectedRecords,
      normalizedMutations: run.mutations.length,
      visibilityCounts: visibilityCounts(run.mutations),
      warningCount: warnings,
      errorCount: errors,
      finalCheckpoint: run.finalCheckpoint,
    });
  }
}

export function createCaSosBusinessAdapter(
  options: CaSosBusinessAdapterOptions,
): SourceAdapter<CaSosDecodedBusinessRecord, CaSosValidatedBusinessRecord> {
  return new CaSosBusinessAdapter(options);
}
