import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { assertStoredArtifactIntegrity } from '@oracle/artifacts/artifact-store';
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
import { parse } from 'csv-parse';

import {
  type AcquisitionContext,
  type DecodeContext,
  type DiscoveryContext,
  type DiscoveryResult,
  type NormalizationContext,
  type PlanningContext,
  type RecordValidation,
  type SourceAdapter,
  type SourceRunObservation,
  type SummaryContext,
  type ValidationContext,
} from '../../spi/adapter.js';
import {
  createAcquiredByteArtifact,
  type AcquiredByteArtifact,
} from '../../spi/acquired-artifact.js';
import { sha256Hex } from '../../spi/bytes.js';
import type { HttpHeaders, HttpRequest, HttpResponse } from '../../spi/http.js';
import {
  CSLB_CONTRACTOR_LICENSE_ID,
  CSLB_CONTRACTOR_SOURCE_ID,
  CSLB_MASTER_DOWNLOAD_EVENT,
  CSLB_MASTER_HEADER,
  CSLB_MASTER_REQUEST_KEY,
  CSLB_MASTER_SCHEMA_FINGERPRINT,
  CSLB_MASTER_SELECT_VALUE,
  CSLB_PORTAL_SELECT_EVENT,
  CSLB_PORTAL_SELECT_FIELD,
  CSLB_PORTAL_URL,
  type CslbMasterField,
} from './constants.js';
import type {
  CslbContractorAdapterOptions,
  CslbDecodedContractorRecord,
  CslbValidatedContractorRecord,
} from './types.js';

const CONTRACT_VERSION = '1.0.0';
const TRANSFORM_VERSION = '1.0.0';
const PORTAL_MAXIMUM_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAXIMUM_ARTIFACT_BYTES = 512 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 64 * 1024;
const SCHEMA_FINGERPRINT = schemaFingerprintValueSchema.parse(CSLB_MASTER_SCHEMA_FINGERPRINT);
const contractorIdSchema = entityIdSchemaFor('contractor');

const DESCRIPTOR: SourceDescriptor = sourceDescriptorSchema.parse({
  sourceId: CSLB_CONTRACTOR_SOURCE_ID,
  contractVersion: CONTRACT_VERSION,
  name: 'California Contractors State License Board statewide license master',
  authority: {
    authorityType: 'official_government',
    organization: 'California Contractors State License Board',
    jurisdiction: 'State of California',
    canonicalUrl: CSLB_PORTAL_URL,
    authorityRank: 100,
  },
  acquisitionMethod: 'bulk_download',
  encodings: ['csv'],
  entityKinds: ['contractor'],
  defaultVisibility: 'authenticated',
  license: {
    licenseSnapshotId: CSLB_CONTRACTOR_LICENSE_ID,
    capturedAt: '2026-07-17T14:48:01.014Z',
    title: 'CSLB Public Data Portal disclosure and snapshot limitations',
    canonicalUrl: CSLB_PORTAL_URL,
    termsSha256: 'f718955f4acc6e41c208b8e85f5f459767c1efc7e3dde0f95dc4b5743c750787',
    redistribution: 'unknown',
    containsPersonalData: true,
    attribution: ['California Contractors State License Board'],
    limitations: [
      'The portal does not state an open-data redistribution license.',
      'The master file covers renewed and expired-but-renewable licenses, not cancelled, revoked, or expired non-renewable licenses.',
      'License status can change after the displayed snapshot date; verify current status through CSLB Instant License Check.',
      'Business names and mailing addresses can identify natural persons and are not public-publication eligible by default.',
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
    'The portal reports a date-only Updated as of value after selecting License Master; each download is treated as an immutable full snapshot for that displayed date.',
});

interface PortalState {
  readonly html: string;
  readonly cookie: string | undefined;
  readonly attempt: number;
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
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    return `{${Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  throw new TypeError('Unsupported canonical JSON value');
}

function oracleError(
  code: OracleError['code'],
  message: string,
  phase: string,
  details?: Readonly<Record<string, unknown>>,
): Error & OracleError {
  const common = {
    code,
    retryable: code === 'TRANSIENT_SOURCE',
    message,
    sourceId: CSLB_CONTRACTOR_SOURCE_ID,
    phase,
  };
  const parsed = oracleErrorSchema.parse(details === undefined ? common : { ...common, details });
  return Object.assign(new Error(message), parsed);
}

function headerValue(headers: HttpHeaders, name: string): string | undefined {
  const expected = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === expected)?.[1];
}

function httpDateToIso(value: string | undefined): string | null {
  if (value === undefined) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function parseRetryAfter(headers: HttpHeaders, now: string): number | undefined {
  const raw = headerValue(headers, 'retry-after');
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const target = Date.parse(raw);
  const current = Date.parse(now);
  return Number.isFinite(target) && Number.isFinite(current)
    ? Math.max(0, target - current)
    : undefined;
}

function deterministicBackoff(
  requestKey: string,
  attempt: number,
  policy: DiscoveryContext['ratePolicy'],
): number {
  const maximum = Math.min(
    policy.maxBackoffMs,
    policy.initialBackoffMs * 2 ** Math.max(0, attempt - 1),
  );
  if (policy.jitter === 'none') return maximum;
  return Number.parseInt(hashParts(requestKey, String(attempt)).slice(0, 8), 16) % (maximum + 1);
}

async function sendWithRetry(
  context: DiscoveryContext | AcquisitionContext,
  requestKey: string,
  request: HttpRequest,
  phase: 'discover' | 'acquire',
): Promise<Readonly<{ response: HttpResponse; attempt: number }>> {
  for (let attempt = 1; attempt <= context.ratePolicy.maxAttempts; attempt += 1) {
    context.signal.throwIfAborted();
    let response: HttpResponse;
    try {
      response = await context.http.send(request, context.signal);
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
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
    if (response.status >= 200 && response.status < 300) return { response, attempt };
    if (response.status === 401)
      throw oracleError('AUTHENTICATION', `HTTP 401 for ${requestKey}`, phase);
    if (response.status === 403)
      throw oracleError('TERMS_ACCESS', `HTTP 403 for ${requestKey}`, phase);
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      if (attempt === context.ratePolicy.maxAttempts) {
        throw oracleError('TRANSIENT_SOURCE', `Retry budget exhausted for ${requestKey}`, phase, {
          status: response.status,
          attempt,
        });
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
  maximumBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    total += chunk.byteLength;
    if (total > maximumBytes) {
      throw oracleError('SCHEMA_DRIFT', `Response exceeded ${maximumBytes} bytes`, 'acquire');
    }
    chunks.push(Uint8Array.from(chunk));
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function hiddenFields(html: string): Readonly<Record<string, string>> {
  const fields: Record<string, string> = {};
  for (const tag of html.matchAll(/<input\b[^>]*>/giu)) {
    const markup = tag[0];
    if (!/\btype=["']hidden["']/iu.test(markup)) continue;
    const name = /\bname=["']([^"']+)["']/iu.exec(markup)?.[1];
    if (name === undefined) continue;
    const value = /\bvalue=["']([^"']*)["']/iu.exec(markup)?.[1] ?? '';
    fields[decodeHtmlAttribute(name)] = decodeHtmlAttribute(value);
  }
  if (fields.__VIEWSTATE === undefined || fields.__EVENTVALIDATION === undefined) {
    throw oracleError('SCHEMA_DRIFT', 'CSLB portal WebForms state fields changed', 'discover');
  }
  return Object.freeze(fields);
}

function formBody(fields: Readonly<Record<string, string>>): Uint8Array {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))) {
    parameters.set(key, value);
  }
  return new TextEncoder().encode(parameters.toString());
}

function eventBody(html: string, eventTarget: string): Uint8Array {
  return formBody({
    ...hiddenFields(html),
    __EVENTTARGET: eventTarget,
    __EVENTARGUMENT: '',
    [CSLB_PORTAL_SELECT_FIELD]: CSLB_MASTER_SELECT_VALUE,
  });
}

function anonymousCookie(headers: HttpHeaders): string | undefined {
  const setCookie = headerValue(headers, 'set-cookie');
  if (setCookie === undefined) return undefined;
  return setCookie
    .split(/,(?=[^;,]+=)/u)
    .map((cookie) => cookie.split(';', 1)[0]?.trim())
    .filter((cookie): cookie is string => cookie !== undefined && cookie.length > 0)
    .join('; ');
}

function requestHeaders(cookie?: string): HttpHeaders {
  return Object.freeze({
    accept: 'text/html,application/xhtml+xml',
    ...(cookie === undefined ? {} : { cookie }),
  });
}

async function openPortal(
  context: DiscoveryContext | AcquisitionContext,
  phase: 'discover' | 'acquire',
): Promise<PortalState> {
  const opened = await sendWithRetry(
    context,
    'portal-open',
    { method: 'GET', url: CSLB_PORTAL_URL, headers: requestHeaders() },
    phase,
  );
  const bytes = await collectBody(opened.response, context.signal, PORTAL_MAXIMUM_BYTES);
  let html: string;
  try {
    html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw oracleError('SCHEMA_DRIFT', 'CSLB portal HTML is not UTF-8', phase);
  }
  hiddenFields(html);
  return Object.freeze({
    html,
    cookie: anonymousCookie(opened.response.headers),
    attempt: opened.attempt,
  });
}

async function selectMaster(
  context: DiscoveryContext | AcquisitionContext,
  portal: PortalState,
  phase: 'discover' | 'acquire',
): Promise<PortalState> {
  const body = eventBody(portal.html, CSLB_PORTAL_SELECT_EVENT);
  const selected = await sendWithRetry(
    context,
    'portal-select-license-master',
    {
      method: 'POST',
      url: CSLB_PORTAL_URL,
      headers: Object.freeze({
        ...requestHeaders(portal.cookie),
        'content-type': 'application/x-www-form-urlencoded',
      }),
      body,
    },
    phase,
  );
  const bytes = await collectBody(selected.response, context.signal, PORTAL_MAXIMUM_BYTES);
  const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (
    !html.includes(CSLB_MASTER_DOWNLOAD_EVENT) ||
    !/Updated as of\s+\d{1,2}\/\d{1,2}\/\d{4}/u.test(html)
  ) {
    throw oracleError('SCHEMA_DRIFT', 'CSLB master selection response changed', phase);
  }
  return Object.freeze({
    html,
    cookie: portal.cookie ?? anonymousCookie(selected.response.headers),
    attempt: selected.attempt,
  });
}

function portalSourceAsOf(html: string): SourceAsOf {
  const match = /Updated as of\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/u.exec(html);
  if (match === null)
    throw oracleError('SCHEMA_DRIFT', 'Missing CSLB Updated as of date', 'discover');
  const [, monthRaw, dayRaw, yearRaw] = match;
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const year = Number(yearRaw);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw oracleError('SCHEMA_DRIFT', 'Invalid CSLB Updated as of date', 'discover');
  }
  return Object.freeze({
    state: 'derived',
    at: date.toISOString(),
    basis: 'Official CSLB portal date-only Updated as of value represented at 00:00:00Z',
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

function checkpointForPlan(
  plan: AcquisitionPlan,
  value: unknown,
  origin: string,
): SourceCheckpoint {
  const parsed = sourceCheckpointSchema.safeParse(value);
  if (!parsed.success) throw oracleError('SCHEMA_DRIFT', `Invalid ${origin} checkpoint`, 'acquire');
  const checkpoint = parsed.data;
  if (
    checkpoint.sourceId !== plan.sourceId ||
    checkpoint.snapshotId !== plan.snapshotId ||
    checkpoint.contractVersion !== plan.contractVersion ||
    checkpoint.nextSequence > plan.items.length
  ) {
    throw oracleError('SCHEMA_DRIFT', `${origin} checkpoint does not belong to plan`, 'acquire');
  }
  return checkpoint;
}

function createSourceCheckpoint(
  plan: AcquisitionPlan,
  artifactIds: readonly AcquiredArtifact['artifactId'][],
  updatedAt: string,
): SourceCheckpoint {
  return sourceCheckpointSchema.parse({
    sourceId: plan.sourceId,
    snapshotId: plan.snapshotId,
    contractVersion: plan.contractVersion,
    cursor: 'sequence:1',
    nextSequence: 1,
    completedRequestKeys: [CSLB_MASTER_REQUEST_KEY],
    acquiredArtifactIds: artifactIds,
    updatedAt,
    complete: true,
  });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function assertHeader(header: readonly string[]): void {
  if (
    header.length !== CSLB_MASTER_HEADER.length ||
    header.some((field, index) => field !== CSLB_MASTER_HEADER[index])
  ) {
    throw oracleError('SCHEMA_DRIFT', 'CSLB license master CSV header changed', 'decode', {
      expected: CSLB_MASTER_HEADER,
      observed: header,
    });
  }
}

async function* csvRows(bytes: Uint8Array, signal: AbortSignal): AsyncIterable<CsvRow> {
  const input = Readable.from(
    (function* chunks(): Iterable<Uint8Array> {
      for (let offset = 0; offset < bytes.byteLength; offset += STREAM_CHUNK_BYTES) {
        signal.throwIfAborted();
        yield bytes.slice(offset, Math.min(bytes.byteLength, offset + STREAM_CHUNK_BYTES));
      }
    })(),
  );
  const parser = input.pipe(
    parse({
      bom: true,
      columns: false,
      encoding: 'utf8',
      relax_column_count: false,
      skip_empty_lines: true,
    }),
  );
  let header: readonly string[] | undefined;
  try {
    for await (const candidate of parser) {
      signal.throwIfAborted();
      if (!isStringArray(candidate))
        throw oracleError('RECORD_QUALITY', 'CSV emitted a non-string row', 'decode');
      const row = Object.freeze([...candidate]);
      if (header === undefined) {
        header = row;
        assertHeader(header);
      } else {
        yield Object.freeze({ header, values: row });
      }
    }
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      String(error.code).startsWith('CSV_')
    ) {
      throw oracleError('RECORD_QUALITY', `Malformed CSLB CSV: ${String(error.code)}`, 'decode');
    }
    throw error;
  }
  if (header === undefined) throw oracleError('SCHEMA_DRIFT', 'CSLB CSV is empty', 'decode');
}

function rowObject(values: readonly string[]): Readonly<Record<CslbMasterField, string>> {
  return Object.freeze(
    Object.fromEntries(
      CSLB_MASTER_HEADER.map((field, index) => [field, values[index] ?? '']),
    ) as Record<CslbMasterField, string>,
  );
}

function parseSourceDate(raw: string): string | null | undefined {
  const value = raw.trim();
  if (value.length === 0) return null;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(value);
  if (match === null) return undefined;
  const [, monthRaw, dayRaw, yearRaw] = match;
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const year = Number(yearRaw);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date.toISOString()
    : undefined;
}

function classifications(raw: string): readonly string[] | undefined {
  const values = raw
    .split('|')
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.some((value) => !/^[A-Z0-9/-]{1,16}$/u.test(value))) return undefined;
  return Object.freeze([...new Set(values)]);
}

function issue(
  code: string,
  message: string,
  recordKey: string,
  fieldPath: string,
): ValidationIssue {
  return Object.freeze({ code, severity: 'error', message, recordKey, fieldPath });
}

function sourceRecordReference(record: CslbValidatedContractorRecord): SourceRecordReference {
  return Object.freeze({
    sourceId: CSLB_CONTRACTOR_SOURCE_ID,
    snapshotId: record.snapshotId,
    artifactId: record.artifactId,
    recordKey: record.recordKey,
    recordSha256: record.recordSha256,
    rawPointer: `csv:row:${record.ordinal}`,
  });
}

function lineage(
  record: CslbValidatedContractorRecord,
  fieldName: string,
  value: unknown,
  appliedAt: string,
): FieldLineage {
  const transformation = Object.freeze({
    name: `cslb-contractors/${fieldName}`,
    version: TRANSFORM_VERSION,
    appliedAt,
    inputSha256: record.recordSha256,
    outputSha256: sha256Hex(new TextEncoder().encode(canonicalJson(value))),
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

function sourceAsOfInstant(record: CslbValidatedContractorRecord): string | null {
  return record.sourceAsOf.state === 'unknown' ? null : record.sourceAsOf.at;
}

function createMutations(
  record: CslbValidatedContractorRecord,
  options: CslbContractorAdapterOptions,
): readonly CanonicalMutation[] {
  const contractorId = contractorIdSchema.parse(
    `sc:entity:contractor:${hashParts('cslb', record.licenseNumber)}`,
  );
  const entityLineage = lineage(
    record,
    'license-number',
    record.licenseNumber,
    options.normalizationTimestamp,
  );
  const entity = {
    id: contractorId,
    entityKind: 'contractor' as const,
    version: 1,
    validFrom: record.lastUpdatedAt,
    validTo: null,
    recordedAt: options.normalizationTimestamp,
    visibility: 'authenticated' as const,
    sourceIds: [CSLB_CONTRACTOR_SOURCE_ID],
    lineage: [entityLineage],
    licenseNumber: record.licenseNumber,
    legalName: record.legalName,
    status: record.status,
    classifications: [...record.classifications],
    businessIds: [],
    addressIds: [],
  };
  const baseSequence = record.ordinal * 100;
  const mutations: CanonicalMutation[] = [
    canonicalMutationSchema.parse({
      kind: 'entity_upsert',
      mutationId: mutationIdSchema.parse(
        `sc:mutation:${hashParts(record.recordKey, 'entity-upsert', canonicalJson(entity))}`,
      ),
      runId: options.runId,
      sourceId: CSLB_CONTRACTOR_SOURCE_ID,
      snapshotId: record.snapshotId,
      sequence: baseSequence,
      emittedAt: options.normalizationTimestamp,
      visibility: 'authenticated',
      entity,
    }),
  ];
  const observations = [
    [
      'business_identity',
      {
        legalName: record.legalName,
        businessType: record.raw.BusinessType || null,
      },
    ],
    [
      'mailing_locality',
      {
        city: record.raw.City || null,
        state: record.raw.State || null,
        county: record.raw.County || null,
        postalCode: record.raw.ZIPCode || null,
        country: record.raw.country || null,
      },
    ],
    [
      'status_history',
      {
        observedStatus: record.status,
        lastUpdatedAt: record.lastUpdatedAt,
        issueDate: record.issueDate,
        reissueDate: parseSourceDate(record.raw.ReissueDate) ?? null,
        expirationDate: record.expirationDate,
        inactivationDate: parseSourceDate(record.raw.InactivationDate) ?? null,
        reactivationDate: parseSourceDate(record.raw.ReactivationDate) ?? null,
        pendingSuspension: record.raw.PendingSuspension || null,
        pendingClassRemoval: record.raw.PendingClassRemoval || null,
        pendingClassReplace: record.raw.PendingClassReplace || null,
      },
    ],
    [
      'classification_history',
      {
        classifications: record.classifications,
        asbestosRegistration: record.raw.AsbestosReg || null,
        observedAt: record.lastUpdatedAt,
      },
    ],
    [
      'contractor_bond',
      {
        suretyCompany: record.raw.CBSuretyCompany || null,
        bondNumber: record.raw.CBNumber || null,
        effectiveDate: parseSourceDate(record.raw.CBEffectiveDate) ?? null,
        cancellationDate: parseSourceDate(record.raw.CBCancellationDate) ?? null,
        amount: record.raw.CBAmount || null,
      },
    ],
    [
      'workers_compensation',
      {
        coverageType: record.raw.WorkersCompCoverageType || null,
        insurer: record.raw.WCInsuranceCompany || null,
        policyNumber: record.raw.WCPolicyNumber || null,
        effectiveDate: parseSourceDate(record.raw.WCEffectiveDate) ?? null,
        expirationDate: parseSourceDate(record.raw.WCExpirationDate) ?? null,
        cancellationDate: parseSourceDate(record.raw.WCCancellationDate) ?? null,
        suspensionDate: parseSourceDate(record.raw.WCSuspendDate) ?? null,
      },
    ],
    [
      'workers_bond',
      {
        suretyCompany: record.raw.WBSuretyCompany || null,
        bondNumber: record.raw.WBNumber || null,
        effectiveDate: parseSourceDate(record.raw.WBEffectiveDate) ?? null,
        cancellationDate: parseSourceDate(record.raw.WBCancellationDate) ?? null,
        amount: record.raw.WBAmount || null,
      },
    ],
    [
      'disciplinary_bond',
      {
        suretyCompany: record.raw.DBSuretyCompany || null,
        bondNumber: record.raw.DBNumber || null,
        effectiveDate: parseSourceDate(record.raw.DBEffectiveDate) ?? null,
        cancellationDate: parseSourceDate(record.raw.DBCancellationDate) ?? null,
        amount: record.raw.DBAmount || null,
        dateRequired: parseSourceDate(record.raw.DateRequired) ?? null,
        caseRegion: record.raw.DiscpCaseRegion || null,
        reason: record.raw.DBBondReason || null,
        caseNumber: record.raw.DBCaseNo || null,
      },
    ],
  ] as const;
  for (const [index, [fieldName, value]] of observations.entries()) {
    const fieldLineage = lineage(record, fieldName, value, options.normalizationTimestamp);
    const observation = {
      observationId: observationIdSchema.parse(
        `sc:observation:${hashParts(contractorId, fieldName, fieldLineage.lineageSha256)}`,
      ),
      entityId: contractorId,
      entityKind: 'contractor' as const,
      fieldPath: `/source/${fieldName}`,
      value,
      observedAt: options.normalizationTimestamp,
      sourceAsOf: sourceAsOfInstant(record),
      authorityRank: DESCRIPTOR.authority.authorityRank,
      confidence: 1,
      visibility: 'authenticated' as const,
      lineage: fieldLineage,
    };
    mutations.push(
      canonicalMutationSchema.parse({
        kind: 'field_observation',
        mutationId: mutationIdSchema.parse(
          `sc:mutation:${hashParts(record.recordKey, fieldName, canonicalJson(observation))}`,
        ),
        runId: options.runId,
        sourceId: CSLB_CONTRACTOR_SOURCE_ID,
        snapshotId: record.snapshotId,
        sequence: baseSequence + index + 1,
        emittedAt: options.normalizationTimestamp,
        visibility: 'authenticated',
        observation,
      }),
    );
  }
  return Object.freeze(mutations);
}

export class CslbContractorAdapter implements SourceAdapter<
  CslbDecodedContractorRecord,
  CslbValidatedContractorRecord
> {
  readonly #options: CslbContractorAdapterOptions;

  public constructor(options: CslbContractorAdapterOptions) {
    if (
      options.expectedRecordCount !== undefined &&
      (!Number.isInteger(options.expectedRecordCount) || options.expectedRecordCount < 0)
    ) {
      throw new TypeError('expectedRecordCount must be a non-negative integer');
    }
    this.#options = Object.freeze({ ...options });
  }

  public describe(): SourceDescriptor {
    return DESCRIPTOR;
  }

  public async discover(context: DiscoveryContext): Promise<DiscoveryResult> {
    const portal = await openPortal(context, 'discover');
    const selected = await selectMaster(context, portal, 'discover');
    const sourceAsOf = portalSourceAsOf(selected.html);
    return Object.freeze({
      sourceId: CSLB_CONTRACTOR_SOURCE_ID,
      discoveredAt: context.clock.now(),
      resources: [
        Object.freeze({
          requestKey: CSLB_MASTER_REQUEST_KEY,
          url: CSLB_PORTAL_URL,
          sourceAsOf,
          expectedRecords: this.#options.expectedRecordCount ?? null,
          mediaTypes: ['text/csv'],
          continuationToken: null,
        }),
      ],
      complete: true,
      limitations: Object.freeze([
        'The official no-cost master is one full snapshot, so pagination terminates after one resource.',
        'The portal does not publish a record-count denominator; expected count is null unless source-lock configuration supplies one.',
        ...DESCRIPTOR.license.limitations,
      ]),
    });
  }

  public plan(
    request: AcquisitionRequest,
    discovery: DiscoveryResult,
    context: PlanningContext,
  ): Promise<AcquisitionPlan> {
    context.signal.throwIfAborted();
    if (request.sourceId !== CSLB_CONTRACTOR_SOURCE_ID || discovery.sourceId !== request.sourceId) {
      throw oracleError('SCHEMA_DRIFT', 'CSLB request/discovery source mismatch', 'plan');
    }
    const resource = discovery.resources.find(
      (candidate) => candidate.requestKey === CSLB_MASTER_REQUEST_KEY,
    );
    if (resource === undefined || !discovery.complete || resource.continuationToken !== null) {
      throw oracleError(
        'SCHEMA_DRIFT',
        'CSLB discovery is incomplete or paginated unexpectedly',
        'plan',
      );
    }
    return Promise.resolve(
      acquisitionPlanSchema.parse({
        sourceId: request.sourceId,
        snapshotId: request.snapshotId,
        contractVersion: CONTRACT_VERSION,
        plannedAt: context.clock.now(),
        items: [
          {
            requestKey: CSLB_MASTER_REQUEST_KEY,
            sequence: 0,
            method: 'POST',
            url: resource.url,
            encoding: 'csv',
            expectedMediaTypes: ['text/csv'],
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
    if (plan.sourceId !== CSLB_CONTRACTOR_SOURCE_ID || plan.items.length !== 1) {
      throw oracleError('SCHEMA_DRIFT', 'CSLB acquisition plan mismatch', 'acquire');
    }
    const scope = `${plan.sourceId}/${plan.snapshotId}`;
    const storedEnvelope = await context.checkpointStore.load(scope);
    const callerCheckpoint =
      checkpoint === undefined ? undefined : checkpointForPlan(plan, checkpoint, 'caller');
    const storedCheckpoint =
      storedEnvelope === undefined
        ? undefined
        : checkpointForPlan(plan, storedEnvelope.payload, 'stored');
    if (
      callerCheckpoint !== undefined &&
      storedCheckpoint !== undefined &&
      canonicalJson(callerCheckpoint) !== canonicalJson(storedCheckpoint)
    ) {
      throw oracleError('RECONCILIATION', 'Caller and stored checkpoints disagree', 'acquire');
    }
    const resume = storedCheckpoint ?? callerCheckpoint;
    if (
      resume?.complete === true ||
      resume?.completedRequestKeys.includes(CSLB_MASTER_REQUEST_KEY) === true
    )
      return;

    const portal = await openPortal(context, 'acquire');
    const selected = await selectMaster(context, portal, 'acquire');
    const body = eventBody(selected.html, CSLB_MASTER_DOWNLOAD_EVENT);
    const requestHeadersValue = Object.freeze({
      accept: 'text/csv',
      'content-type': 'application/x-www-form-urlencoded',
      ...(selected.cookie === undefined ? {} : { cookie: selected.cookie }),
    });
    const downloaded = await sendWithRetry(
      context,
      CSLB_MASTER_REQUEST_KEY,
      { method: 'POST', url: CSLB_PORTAL_URL, headers: requestHeadersValue, body },
      'acquire',
    );
    const mediaType = headerValue(downloaded.response.headers, 'content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase();
    if (mediaType !== 'text/csv') {
      throw oracleError(
        'SCHEMA_DRIFT',
        `Expected text/csv, received ${mediaType ?? 'missing'}`,
        'acquire',
      );
    }
    const bytes = await collectBody(
      downloaded.response,
      context.signal,
      this.#options.maximumArtifactBytes ?? DEFAULT_MAXIMUM_ARTIFACT_BYTES,
    );
    const sha256 = sha256Hex(bytes);
    const logicalKey = `raw/cslb-contractors/${plan.snapshotId}/${sha256}.csv`;
    const stored = await context.artifactStore.putImmutable({
      logicalKey,
      mediaType,
      body: bytes,
      expectedSha256: sha256,
      metadata: Object.freeze({
        authority: DESCRIPTOR.authority.organization,
        sourceUrl: CSLB_PORTAL_URL,
        snapshotId: plan.snapshotId,
        sourceAsOf: canonicalJson(portalSourceAsOf(selected.html)),
        visibility: 'authenticated',
      }),
      ifAbsent: true,
    });
    assertStoredArtifactIntegrity(
      { logicalKey, mediaType, byteSize: bytes.byteLength, sha256 },
      stored,
    );
    const retrievedAt = context.clock.now();
    const metadata: AcquiredArtifact = {
      artifactId: artifactIdSchema.parse(`sc:artifact:sha256:${sha256}`),
      sourceId: CSLB_CONTRACTOR_SOURCE_ID,
      snapshotId: plan.snapshotId,
      retrievedAt,
      sourceAsOf: portalSourceAsOf(selected.html),
      request: {
        requestKey: CSLB_MASTER_REQUEST_KEY,
        method: 'POST',
        url: CSLB_PORTAL_URL,
        headers: [
          { name: 'accept', valueSha256: sha256Hex(new TextEncoder().encode('text/csv')) },
          {
            name: 'content-type',
            valueSha256: sha256Hex(new TextEncoder().encode('application/x-www-form-urlencoded')),
          },
        ],
        bodySha256: sha256Hex(body),
        attempt: downloaded.attempt,
      },
      response: {
        httpStatus: downloaded.response.status,
        etag: headerValue(downloaded.response.headers, 'etag') ?? null,
        lastModified: httpDateToIso(headerValue(downloaded.response.headers, 'last-modified')),
        finalUrl: CSLB_PORTAL_URL,
      },
      mediaType,
      encoding: 'csv',
      byteSize: bytes.byteLength,
      sha256,
      schemaFingerprint: {
        algorithm: 'sha256',
        value: SCHEMA_FINGERPRINT,
        schemaName: 'cslb-license-master-csv-2026-07',
        canonicalizationVersion: CONTRACT_VERSION,
      },
      rawUri: stored.uri,
      licenseSnapshotRef: CSLB_CONTRACTOR_LICENSE_ID,
      visibility: 'authenticated',
    };
    const artifact = createAcquiredByteArtifact(metadata, bytes);
    const nextCheckpoint = createSourceCheckpoint(
      plan,
      [artifact.metadata.artifactId],
      context.clock.now(),
    );
    const envelope = createCheckpointEnvelope({
      scope,
      previousRevision: storedEnvelope?.revision ?? null,
      writtenAt: nextCheckpoint.updatedAt,
      payload: checkpointPayload(nextCheckpoint),
    });
    const committed = await context.checkpointStore.commit({
      expectedRevision: storedEnvelope?.revision ?? null,
      checkpoint: envelope,
    });
    if (committed.status === 'conflict') {
      throw oracleError('RECONCILIATION', 'CSLB checkpoint conflict', 'acquire');
    }
    yield artifact;
  }

  public async *decode(
    artifact: AcquiredByteArtifact,
    context: DecodeContext,
  ): AsyncIterable<CslbDecodedContractorRecord> {
    context.signal.throwIfAborted();
    if (
      artifact.metadata.sourceId !== CSLB_CONTRACTOR_SOURCE_ID ||
      artifact.metadata.encoding !== 'csv'
    ) {
      throw oracleError('SCHEMA_DRIFT', 'Not a CSLB master CSV artifact', 'decode');
    }
    const bytes = artifact.bytes.copy();
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw oracleError('RECORD_QUALITY', 'CSLB master is not valid UTF-8', 'decode');
    }
    if (this.#options.expectedRecordCount !== undefined) {
      let observed = 0;
      for await (const row of csvRows(bytes, context.signal)) {
        void row;
        observed += 1;
      }
      if (observed !== this.#options.expectedRecordCount) {
        throw oracleError(
          'SCHEMA_DRIFT',
          `CSLB row count drift: expected ${this.#options.expectedRecordCount}, observed ${observed}`,
          'decode',
        );
      }
    }
    let ordinal = 0;
    for await (const row of csvRows(bytes, context.signal)) {
      ordinal += 1;
      const raw = rowObject(row.values);
      const license = raw.LicenseNo.trim();
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
        recordKey:
          license.length > 0
            ? `license:${license}:row:${ordinal}`
            : `missing-license:row:${ordinal}`,
        recordSha256: sha256Hex(new TextEncoder().encode(canonicalJson(row.values))),
      });
    }
  }

  public validate(
    record: CslbDecodedContractorRecord,
    context: ValidationContext,
  ): Promise<RecordValidation<CslbValidatedContractorRecord>> {
    context.signal.throwIfAborted();
    const raw = rowObject(record.values);
    const issues: ValidationIssue[] = [];
    const licenseNumber = raw.LicenseNo.trim();
    if (!/^\d{1,8}$/u.test(licenseNumber)) {
      issues.push(
        issue(
          'MALFORMED_LICENSE_NUMBER',
          'LicenseNo must contain 1-8 digits',
          record.recordKey,
          '/LicenseNo',
        ),
      );
    }
    const legalName =
      raw.FullBusinessName.trim() ||
      [raw.BusinessName, raw['BUS-NAME-2']]
        .map((part) => part.trim())
        .filter(Boolean)
        .join(' ');
    if (legalName.length === 0)
      issues.push(
        issue(
          'MISSING_LEGAL_NAME',
          'Business name is required',
          record.recordKey,
          '/FullBusinessName',
        ),
      );
    const parsedClassifications = classifications(raw['Classifications(s)']);
    if (parsedClassifications === undefined)
      issues.push(
        issue(
          'MALFORMED_CLASSIFICATION',
          'Classification tokens contain unsupported characters',
          record.recordKey,
          '/Classifications(s)',
        ),
      );
    const primaryStatus = raw.PrimaryStatus.trim();
    const secondaryStatus = raw.SecondaryStatus.trim();
    const status = [primaryStatus, secondaryStatus].filter(Boolean).join(' / ');
    if (status.length === 0)
      issues.push(
        issue('MISSING_STATUS', 'License status is required', record.recordKey, '/PrimaryStatus'),
      );
    const lastUpdatedAt = parseSourceDate(raw.LastUpdate);
    const issueDate = parseSourceDate(raw.IssueDate);
    const expirationDate = parseSourceDate(raw.ExpirationDate);
    if (lastUpdatedAt === undefined || lastUpdatedAt === null)
      issues.push(
        issue(
          'MALFORMED_LAST_UPDATE',
          'LastUpdate must be a valid date',
          record.recordKey,
          '/LastUpdate',
        ),
      );
    if (issueDate === undefined || issueDate === null)
      issues.push(
        issue(
          'MALFORMED_ISSUE_DATE',
          'IssueDate must be a valid date',
          record.recordKey,
          '/IssueDate',
        ),
      );
    if (expirationDate === undefined || expirationDate === null)
      issues.push(
        issue(
          'MALFORMED_EXPIRATION_DATE',
          'ExpirationDate must be a valid date',
          record.recordKey,
          '/ExpirationDate',
        ),
      );
    const optionalDateFields = [
      'ReissueDate',
      'InactivationDate',
      'ReactivationDate',
      'WCEffectiveDate',
      'WCExpirationDate',
      'WCCancellationDate',
      'WCSuspendDate',
      'CBEffectiveDate',
      'CBCancellationDate',
      'WBEffectiveDate',
      'WBCancellationDate',
      'DBEffectiveDate',
      'DBCancellationDate',
      'DateRequired',
    ] as const;
    for (const field of optionalDateFields) {
      if (parseSourceDate(raw[field]) === undefined)
        issues.push(
          issue(
            'MALFORMED_OPTIONAL_DATE',
            `${field} is not a valid date`,
            record.recordKey,
            `/${field}`,
          ),
        );
    }
    if (
      issues.length > 0 ||
      parsedClassifications === undefined ||
      lastUpdatedAt === undefined ||
      lastUpdatedAt === null ||
      issueDate === undefined ||
      issueDate === null ||
      expirationDate === undefined ||
      expirationDate === null
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
          licenseNumber,
          legalName,
          classifications: parsedClassifications,
          status,
          lastUpdatedAt,
          issueDate,
          expirationDate,
        }),
      }),
    );
  }

  public async *normalize(
    record: CslbValidatedContractorRecord,
    context: NormalizationContext,
  ): AsyncIterable<CanonicalMutation> {
    context.signal.throwIfAborted();
    await Promise.resolve();
    for (const mutation of createMutations(record, this.#options)) {
      context.signal.throwIfAborted();
      yield mutation;
    }
  }

  public summarize(run: SourceRunObservation, context: SummaryContext): SourceRunSummary {
    context.signal.throwIfAborted();
    if (run.decodedRecords !== run.acceptedRecords + run.rejectedRecords) {
      throw oracleError('RECORD_QUALITY', 'CSLB summary accounting does not balance', 'summarize');
    }
    const visibilityCounts = { public: 0, authenticated: 0, restricted: 0, prohibited_public: 0 };
    for (const mutation of run.mutations) visibilityCounts[mutation.visibility] += 1;
    const complete =
      run.artifacts.length === 1 &&
      run.artifacts[0]?.request.requestKey === CSLB_MASTER_REQUEST_KEY &&
      run.finalCheckpoint.complete &&
      run.finalCheckpoint.completedRequestKeys.includes(CSLB_MASTER_REQUEST_KEY);
    return sourceRunSummarySchema.parse({
      sourceId: run.descriptor.sourceId,
      snapshotId: run.plan.snapshotId,
      runId: run.runId,
      contractVersion: run.descriptor.contractVersion,
      status: run.aborted
        ? 'aborted'
        : run.rejectedRecords > 0 || !complete
          ? 'partial'
          : 'succeeded',
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      artifactsAcquired: run.artifacts.length,
      bytesAcquired: run.artifacts.reduce((total, artifact) => total + artifact.byteSize, 0),
      decodedRecords: run.decodedRecords,
      acceptedRecords: run.acceptedRecords,
      rejectedRecords: run.rejectedRecords,
      normalizedMutations: run.mutations.length,
      visibilityCounts,
      warningCount: run.validationIssues.filter((item) => item.severity === 'warning').length,
      errorCount: run.validationIssues.filter((item) => item.severity !== 'warning').length,
      finalCheckpoint: run.finalCheckpoint,
    });
  }
}

export function createCslbContractorAdapter(
  options: CslbContractorAdapterOptions,
): SourceAdapter<CslbDecodedContractorRecord, CslbValidatedContractorRecord> {
  return new CslbContractorAdapter(options);
}

export const CSLB_CONTRACTOR_DESCRIPTOR = DESCRIPTOR;
