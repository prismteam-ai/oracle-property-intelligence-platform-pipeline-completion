import { createHash } from 'node:crypto';

import { createCheckpointEnvelope } from '@oracle/artifacts/checkpoint-store';
import {
  canonicalMutationSchema,
  type CanonicalMutation,
} from '@oracle/contracts/canonical/mutation';
import {
  oracleErrorSchema,
  type OracleError,
  type OracleErrorCode,
} from '@oracle/contracts/errors';
import { runIdSchema, snapshotIdSchema } from '@oracle/contracts/ids';
import {
  acquiredArtifactSchema,
  acquisitionPlanSchema,
  sourceCheckpointSchema,
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
  createStreamingAcquiredArtifact,
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
import type { HttpHeaders, HttpResponse } from '../../spi/http.js';
import {
  OSM_ATTRIBUTION,
  OSM_COPYRIGHT_URL,
  OSM_DECODED_SCHEMA_FINGERPRINT,
  OSM_LICENSE_SNAPSHOT_ID,
  OSM_NOTICE,
  OSM_ODBL_URL,
  OSM_PEDESTRIAN_GRAPH_CONTRACT_VERSION,
  OSM_PEDESTRIAN_GRAPH_SOURCE_ID,
} from './constants.js';
import type {
  OsmDecodedElement,
  OsmPedestrianDecodedRecord,
  OsmPbfDecoder,
  PinnedOsmExtract,
  ValidatedOsmElement,
  ValidatedOsmPedestrianRecord,
  ValidatedOsmRelationMember,
} from './types.js';

const ACCEPT = 'application/vnd.openstreetmap.data.pbf, application/octet-stream';
const CHECKPOINT_SCOPE_PREFIX = 'source/osm-pedestrian-graph';
const PBF_DECODE_LIMITS = Object.freeze({
  maximumBlobBytes: 32 * 1024 * 1024,
  maximumTagsPerElement: 4_096,
  maximumWayNodeRefs: 65_536,
  maximumRelationMembers: 65_536,
});
const OSM_ELEMENT_RANK: Readonly<Record<string, number>> = Object.freeze({
  node: 0,
  way: 1,
  relation: 2,
});

export interface OsmPedestrianGraphAdapterOptions {
  readonly extract: PinnedOsmExtract;
  readonly decoder: OsmPbfDecoder;
}

function providerError(
  code: OracleErrorCode,
  message: string,
  phase: string,
  details?: Readonly<Record<string, unknown>>,
): Error & OracleError {
  const parsed = oracleErrorSchema.parse({
    code,
    retryable: code === 'TRANSIENT_SOURCE',
    message,
    sourceId: OSM_PEDESTRIAN_GRAPH_SOURCE_ID,
    phase,
    ...(details === undefined ? {} : { details }),
  });
  return Object.assign(new Error(message), parsed);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(',')}}`;
}

function digest(...parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex');
}

function header(headers: HttpHeaders, name: string): string | undefined {
  const target = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === target)?.[1];
}

function optionalMetadata(value: string | undefined): string | null {
  return value === undefined || value.length === 0 ? null : value;
}

function parseHttpDate(value: string | undefined): string | null {
  if (value === undefined) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function retryAfterMilliseconds(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

function isTransient(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function requestWithRetry(
  method: 'GET' | 'HEAD',
  url: string,
  context: DiscoveryContext | StreamingAcquisitionContext,
): Promise<Readonly<{ response: HttpResponse; attempt: number }>> {
  const policy = context.ratePolicy;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    context.signal.throwIfAborted();
    let response: HttpResponse;
    try {
      response = await context.http.send(
        { method, url, headers: { accept: ACCEPT } },
        context.signal,
      );
    } catch (error) {
      if (
        context.signal.aborted ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        throw error;
      }
      if (attempt === policy.maxAttempts) {
        throw providerError(
          'TRANSIENT_SOURCE',
          `Pinned OSM extract transport failed after ${attempt} attempts`,
          method === 'HEAD' ? 'discover' : 'acquire',
        );
      }
      const backoff = Math.min(policy.initialBackoffMs * 2 ** (attempt - 1), policy.maxBackoffMs);
      await context.delay.wait(backoff, context.signal);
      continue;
    }
    if (response.status >= 200 && response.status < 300) {
      return Object.freeze({ response, attempt });
    }
    if (!isTransient(response.status)) {
      throw providerError(
        response.status === 401 || response.status === 403 ? 'TERMS_ACCESS' : 'RECORD_QUALITY',
        `Pinned OSM extract returned HTTP ${response.status}`,
        method === 'HEAD' ? 'discover' : 'acquire',
      );
    }
    if (attempt === policy.maxAttempts) {
      throw providerError(
        'TRANSIENT_SOURCE',
        `Pinned OSM extract remained unavailable after ${attempt} attempts`,
        method === 'HEAD' ? 'discover' : 'acquire',
        { httpStatus: response.status },
      );
    }
    const retryAfter = policy.respectRetryAfter
      ? retryAfterMilliseconds(header(response.headers, 'retry-after'))
      : undefined;
    const backoff = Math.min(policy.initialBackoffMs * 2 ** (attempt - 1), policy.maxBackoffMs);
    await context.delay.wait(retryAfter ?? backoff, context.signal);
  }
  throw new Error('Unreachable OSM retry loop');
}

function validateExtract(extract: PinnedOsmExtract): void {
  const url = new URL(extract.url);
  if (
    url.protocol !== 'https:' ||
    /latest/iu.test(url.pathname) ||
    !/\/[^/]+-\d{6}\.osm\.pbf$/u.test(url.pathname)
  ) {
    throw new TypeError('OSM extract URL must be an immutable dated HTTPS .osm.pbf artifact');
  }
  if (!Number.isSafeInteger(extract.expectedByteSize) || extract.expectedByteSize <= 0) {
    throw new TypeError('OSM extract expectedByteSize must be a positive safe integer');
  }
  if (!/^[a-f0-9]{64}$/u.test(extract.expectedSha256)) {
    throw new TypeError('OSM extract requires an exact lowercase SHA-256');
  }
  const [west, south, east, north] = extract.bounds;
  if (
    ![west, south, east, north].every(Number.isFinite) ||
    west < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    west > east ||
    south > north
  ) {
    throw new TypeError('OSM extract bounds are invalid');
  }
  if (
    extract.distributorChecksum.algorithm === 'md5' &&
    !/^[a-f0-9]{32}$/u.test(extract.distributorChecksum.value)
  ) {
    throw new TypeError('OSM distributor MD5 is malformed');
  }
}

function descriptor(extract: PinnedOsmExtract): SourceDescriptor {
  return sourceDescriptorSchema.parse({
    sourceId: OSM_PEDESTRIAN_GRAPH_SOURCE_ID,
    contractVersion: OSM_PEDESTRIAN_GRAPH_CONTRACT_VERSION,
    name: `OpenStreetMap pedestrian graph input (${extract.extractId})`,
    authority: {
      authorityType: 'recognized_distributor',
      organization: `${extract.distributor}; OpenStreetMap contributors`,
      jurisdiction: 'Northern California, including Santa Clara County',
      canonicalUrl: extract.url,
      authorityRank: 20,
    },
    acquisitionMethod: 'static_artifact',
    encodings: ['pbf'],
    entityKinds: ['pedestrian-graph-ref'],
    defaultVisibility: 'public',
    license: {
      licenseSnapshotId: OSM_LICENSE_SNAPSHOT_ID,
      capturedAt: '2026-07-17T13:01:50.000Z',
      title: 'OpenStreetMap ODbL attribution and share-alike notice',
      canonicalUrl: OSM_COPYRIGHT_URL,
      termsSha256: digest(OSM_NOTICE),
      redistribution: 'approved',
      containsPersonalData: false,
      attribution: [OSM_ATTRIBUTION, OSM_ODBL_URL],
      limitations: [
        'Derivative databases must retain attribution and satisfy ODbL share-alike obligations.',
        'Routing semantics reflect mapped tags in the pinned snapshot and are not a guarantee of real-world passability.',
        'County-scale acquisition uses the pinned regional artifact and never depends on public Overpass.',
      ],
    },
    ratePolicy: {
      maxRequestsPerWindow: 1,
      windowMs: 60_000,
      maxConcurrency: 1,
      maxAttempts: 4,
      initialBackoffMs: 1_000,
      maxBackoffMs: 30_000,
      jitter: 'none',
      respectRetryAfter: true,
    },
    freshnessSemantics: 'The dated extract timestamp is the source-as-of for all decoded elements.',
  });
}

function assertHeadIdentity(response: HttpResponse, extract: PinnedOsmExtract): void {
  const length = Number(header(response.headers, 'content-length'));
  if (length !== extract.expectedByteSize) {
    throw providerError('SCHEMA_DRIFT', 'Pinned OSM extract Content-Length changed', 'discover', {
      expected: extract.expectedByteSize,
      actual: Number.isFinite(length) ? length : null,
    });
  }
  const etag = header(response.headers, 'etag') ?? null;
  if (extract.expectedEtag !== null && etag !== extract.expectedEtag) {
    throw providerError('SCHEMA_DRIFT', 'Pinned OSM extract ETag changed', 'discover');
  }
  const lastModified = parseHttpDate(header(response.headers, 'last-modified'));
  if (extract.expectedLastModified !== null && lastModified !== extract.expectedLastModified) {
    throw providerError('SCHEMA_DRIFT', 'Pinned OSM extract Last-Modified changed', 'discover');
  }
}

function checkpointScope(plan: AcquisitionPlan): string {
  return `${CHECKPOINT_SCOPE_PREFIX}/${plan.snapshotId}`;
}

function completedCheckpoint(
  plan: AcquisitionPlan,
  previous: SourceCheckpoint | undefined,
  artifactId: string,
  updatedAt: string,
): SourceCheckpoint {
  return sourceCheckpointSchema.parse({
    sourceId: plan.sourceId,
    snapshotId: plan.snapshotId,
    contractVersion: plan.contractVersion,
    cursor: 'sequence:1',
    nextSequence: 1,
    completedRequestKeys: [plan.items[0]?.requestKey],
    acquiredArtifactIds: [...new Set([...(previous?.acquiredArtifactIds ?? []), artifactId])],
    updatedAt,
    complete: true,
  });
}

function checkpointForPlan(
  candidate: unknown,
  plan: AcquisitionPlan,
  expectedArtifactId: string,
  origin: 'caller' | 'stored',
): SourceCheckpoint {
  const parsed = sourceCheckpointSchema.safeParse(candidate);
  if (!parsed.success) {
    throw providerError('RECONCILIATION', `OSM ${origin} checkpoint is invalid`, 'acquire');
  }
  const checkpoint = parsed.data;
  const requestKey = plan.items[0]?.requestKey;
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
    checkpoint.acquiredArtifactIds[0] === expectedArtifactId &&
    checkpoint.complete;
  if (
    checkpoint.sourceId !== plan.sourceId ||
    checkpoint.snapshotId !== plan.snapshotId ||
    checkpoint.contractVersion !== plan.contractVersion ||
    (!isInitial && !isComplete)
  ) {
    throw providerError(
      'RECONCILIATION',
      `OSM ${origin} checkpoint is not an exact prefix of the frozen one-item plan`,
      'acquire',
    );
  }
  return checkpoint;
}

function parsePositiveId(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  return typeof value === 'string' && /^[1-9]\d*$/u.test(value) ? value : null;
}

function parseVersion(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function parseTags(value: unknown): Readonly<Record<string, string>> | null {
  if (value === undefined) return Object.freeze({});
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const tags: Record<string, string> = {};
  for (const [key, tagValue] of Object.entries(value)) {
    if (key.trim().length === 0 || typeof tagValue !== 'string') return null;
    tags[key] = tagValue;
  }
  return Object.freeze(
    Object.fromEntries(Object.entries(tags).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function parseMembers(value: unknown): readonly ValidatedOsmRelationMember[] | null {
  if (!Array.isArray(value)) return null;
  const members: ValidatedOsmRelationMember[] = [];
  for (const candidate of value as readonly unknown[]) {
    if (typeof candidate !== 'object' || candidate === null) return null;
    const member = candidate as Readonly<Record<string, unknown>>;
    const ref = parsePositiveId(member.ref);
    if (
      !['node', 'way', 'relation'].includes(String(member.type)) ||
      ref === null ||
      typeof member.role !== 'string'
    ) {
      return null;
    }
    members.push({
      type: member.type as ValidatedOsmRelationMember['type'],
      ref,
      role: member.role,
    });
  }
  return Object.freeze(members);
}

function validationIssue(
  code: string,
  message: string,
  recordKey: string | null,
  fieldPath: string | null,
): ValidationIssue {
  return Object.freeze({ code, severity: 'error', message, recordKey, fieldPath });
}

function validateElement(
  element: OsmDecodedElement,
  bounds: readonly [number, number, number, number],
): Readonly<{ element?: ValidatedOsmElement; issues: readonly ValidationIssue[] }> {
  const recordKey = `${element.type}/${String(element.id)}`;
  const id = parsePositiveId(element.id);
  const version = parseVersion(element.version);
  const timestamp = parseTimestamp(element.timestamp);
  const tags = parseTags(element.tags);
  const issues: ValidationIssue[] = [];
  if (id === null)
    issues.push(
      validationIssue('INVALID_OSM_ID', 'OSM ID must be positive and lossless', recordKey, '/id'),
    );
  if (version === null)
    issues.push(
      validationIssue(
        'INVALID_OSM_VERSION',
        'OSM version must be a positive integer',
        recordKey,
        '/version',
      ),
    );
  if (timestamp === null)
    issues.push(
      validationIssue(
        'INVALID_OSM_TIMESTAMP',
        'OSM timestamp must be ISO-8601',
        recordKey,
        '/timestamp',
      ),
    );
  if (tags === null)
    issues.push(
      validationIssue('MALFORMED_OSM_TAGS', 'OSM tags must be string pairs', recordKey, '/tags'),
    );

  if (id === null || version === null || timestamp === null || tags === null) {
    return Object.freeze({ issues: Object.freeze(issues) });
  }

  if (element.type === 'node') {
    const latitude = element.latitude;
    const longitude = element.longitude;
    const [west, south, east, north] = bounds;
    if (
      typeof latitude !== 'number' ||
      typeof longitude !== 'number' ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180 ||
      longitude < west ||
      longitude > east ||
      latitude < south ||
      latitude > north
    ) {
      issues.push(
        validationIssue(
          'INVALID_OSM_COORDINATE',
          'Node coordinate is invalid or outside extract bounds',
          recordKey,
          '/coordinates',
        ),
      );
    }
    if (issues.length > 0 || typeof latitude !== 'number' || typeof longitude !== 'number') {
      return Object.freeze({ issues: Object.freeze(issues) });
    }
    return Object.freeze({
      element: Object.freeze({ type: 'node', id, version, timestamp, latitude, longitude, tags }),
      issues: Object.freeze([]),
    });
  }

  if (element.type === 'way') {
    const refs = Array.isArray(element.nodeRefs) ? element.nodeRefs.map(parsePositiveId) : [];
    if (refs.length < 2 || refs.some((ref) => ref === null)) {
      issues.push(
        validationIssue(
          'INVALID_OSM_WAY_NODES',
          'OSM way requires at least two valid node references',
          recordKey,
          '/nodeRefs',
        ),
      );
    } else if (refs.some((ref, index) => index > 0 && ref === refs[index - 1])) {
      issues.push(
        validationIssue(
          'INVALID_OSM_WAY_NODES',
          'OSM way contains an adjacent duplicate node',
          recordKey,
          '/nodeRefs',
        ),
      );
    }
    if (issues.length > 0) return Object.freeze({ issues: Object.freeze(issues) });
    const nodeRefs = refs.filter((ref): ref is string => ref !== null);
    return Object.freeze({
      element: Object.freeze({
        type: 'way',
        id,
        version,
        timestamp,
        nodeRefs: Object.freeze(nodeRefs),
        tags,
      }),
      issues: Object.freeze([]),
    });
  }

  const members = parseMembers(element.members);
  if (members === null) {
    issues.push(
      validationIssue(
        'INVALID_OSM_RELATION_MEMBERS',
        'OSM relation members are malformed',
        recordKey,
        '/members',
      ),
    );
  }
  if (issues.length > 0 || members === null) {
    return Object.freeze({ issues: Object.freeze(issues) });
  }
  return Object.freeze({
    element: Object.freeze({ type: 'relation', id, version, timestamp, members, tags }),
    issues: Object.freeze([]),
  });
}

function decodedOrder(element: OsmDecodedElement): readonly [number, bigint] | null {
  const id = parsePositiveId(element.id);
  if (id === null) return null;
  const rank = OSM_ELEMENT_RANK[element.type];
  if (rank === undefined) return null;
  return [rank, BigInt(id)];
}

function assertDecodedElementLimits(element: OsmDecodedElement): void {
  if (
    typeof element.tags === 'object' &&
    element.tags !== null &&
    !Array.isArray(element.tags) &&
    Object.keys(element.tags).length > PBF_DECODE_LIMITS.maximumTagsPerElement
  ) {
    throw providerError('RECORD_QUALITY', 'OSM element exceeds the tag-count ceiling', 'decode');
  }
  if (
    element.type === 'way' &&
    Array.isArray(element.nodeRefs) &&
    element.nodeRefs.length > PBF_DECODE_LIMITS.maximumWayNodeRefs
  ) {
    throw providerError('RECORD_QUALITY', 'OSM way exceeds the node-reference ceiling', 'decode');
  }
  if (
    element.type === 'relation' &&
    Array.isArray(element.members) &&
    element.members.length > PBF_DECODE_LIMITS.maximumRelationMembers
  ) {
    throw providerError(
      'RECORD_QUALITY',
      'OSM relation exceeds the member-count ceiling',
      'decode',
    );
  }
}

export class OsmPedestrianGraphAdapter implements StreamingSourceAdapter<
  OsmPedestrianDecodedRecord,
  ValidatedOsmPedestrianRecord
> {
  readonly #extract: PinnedOsmExtract;
  readonly #decoder: OsmPbfDecoder;
  readonly #descriptor: SourceDescriptor;

  public constructor(options: OsmPedestrianGraphAdapterOptions) {
    validateExtract(options.extract);
    this.#extract = Object.freeze({ ...options.extract });
    this.#decoder = options.decoder;
    this.#descriptor = descriptor(this.#extract);
  }

  public describe(): SourceDescriptor {
    return this.#descriptor;
  }

  public async discover(context: DiscoveryContext): Promise<DiscoveryResult> {
    const { response } = await requestWithRetry('HEAD', this.#extract.url, context);
    assertHeadIdentity(response, this.#extract);
    return Object.freeze({
      sourceId: OSM_PEDESTRIAN_GRAPH_SOURCE_ID,
      discoveredAt: context.clock.now(),
      resources: Object.freeze([
        Object.freeze({
          requestKey: this.#extract.extractId,
          url: this.#extract.url,
          sourceAsOf: { state: 'reported' as const, at: this.#extract.extractTimestamp },
          expectedRecords: null,
          mediaTypes: Object.freeze([
            'application/vnd.openstreetmap.data.pbf',
            'application/octet-stream',
          ]),
          continuationToken: null,
        }),
      ]),
      complete: true,
      limitations: Object.freeze([
        'The regional extract is used offline; public Overpass is not a county-scale dependency.',
        OSM_NOTICE,
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
    const expectedSnapshot = snapshotIdSchema.parse(
      `sc:snapshot:osm-pedestrian-graph:${this.#extract.expectedSha256}`,
    );
    if (
      request.sourceId !== OSM_PEDESTRIAN_GRAPH_SOURCE_ID ||
      discovery.sourceId !== request.sourceId ||
      request.snapshotId !== expectedSnapshot ||
      discovery.resources[0]?.requestKey !== this.#extract.extractId
    ) {
      throw providerError('RECORD_QUALITY', 'OSM request/discovery/snapshot pin mismatch', 'plan');
    }
    return acquisitionPlanSchema.parse({
      sourceId: request.sourceId,
      snapshotId: request.snapshotId,
      contractVersion: OSM_PEDESTRIAN_GRAPH_CONTRACT_VERSION,
      plannedAt: context.clock.now(),
      items: [
        {
          requestKey: this.#extract.extractId,
          sequence: 0,
          method: 'GET',
          url: this.#extract.url,
          encoding: 'pbf',
          expectedMediaTypes: [
            'application/vnd.openstreetmap.data.pbf',
            'application/octet-stream',
          ],
        },
      ],
    });
  }

  public async *acquire(
    plan: AcquisitionPlan,
    checkpoint: SourceCheckpoint | undefined,
    context: StreamingAcquisitionContext,
  ): AsyncIterable<AcquiredArtifactSource> {
    context.signal.throwIfAborted();
    if (plan.sourceId !== OSM_PEDESTRIAN_GRAPH_SOURCE_ID || plan.items.length !== 1) {
      throw providerError('RECORD_QUALITY', 'Unexpected OSM acquisition plan', 'acquire');
    }
    const scope = checkpointScope(plan);
    const sha256 = this.#extract.expectedSha256;
    const expectedArtifactId = `sc:artifact:sha256:${sha256}`;
    const current = await context.checkpointStore.load(scope);
    const persistedCheckpoint =
      current === undefined
        ? undefined
        : checkpointForPlan(current.payload, plan, expectedArtifactId, 'stored');
    const callerCheckpoint =
      checkpoint === undefined
        ? undefined
        : checkpointForPlan(checkpoint, plan, expectedArtifactId, 'caller');
    if (
      callerCheckpoint !== undefined &&
      persistedCheckpoint !== undefined &&
      stableJson(callerCheckpoint) !== stableJson(persistedCheckpoint)
    ) {
      throw providerError(
        'RECONCILIATION',
        'OSM caller and stored checkpoints disagree',
        'acquire',
      );
    }
    const resume = persistedCheckpoint ?? callerCheckpoint;
    const logicalKey = `raw/osm-pedestrian-graph/${plan.snapshotId}/${sha256}.osm.pbf`;
    const existing = await context.artifactStore.headByLogicalKey(logicalKey);
    if (existing !== undefined) {
      if (
        existing.sha256 !== sha256 ||
        existing.byteSize !== this.#extract.expectedByteSize ||
        existing.mediaType !== 'application/vnd.openstreetmap.data.pbf'
      ) {
        throw providerError(
          'RECONCILIATION',
          'OSM orphan artifact does not match source lock',
          'acquire',
        );
      }
      const existingMetadata = acquiredArtifactSchema.parse({
        artifactId: `sc:artifact:sha256:${sha256}`,
        sourceId: OSM_PEDESTRIAN_GRAPH_SOURCE_ID,
        snapshotId: plan.snapshotId,
        retrievedAt: existing.metadata.retrievedAt,
        sourceAsOf: { state: 'reported', at: this.#extract.extractTimestamp },
        request: {
          requestKey: this.#extract.extractId,
          method: 'GET',
          url: this.#extract.url,
          headers: [{ name: 'accept', valueSha256: sha256Hex(new TextEncoder().encode(ACCEPT)) }],
          bodySha256: null,
          attempt: Number(existing.metadata.attempt),
        },
        response: {
          httpStatus: Number(existing.metadata.httpStatus),
          etag: optionalMetadata(existing.metadata.etag),
          lastModified: optionalMetadata(existing.metadata.lastModified),
          finalUrl: this.#extract.url,
        },
        mediaType: existing.mediaType,
        encoding: 'pbf',
        byteSize: existing.byteSize,
        sha256,
        schemaFingerprint: {
          algorithm: 'sha256',
          value: OSM_DECODED_SCHEMA_FINGERPRINT,
          schemaName: 'osm-pbf-decoded-element-v1',
          canonicalizationVersion: '1.0.0',
        },
        rawUri: existing.uri,
        licenseSnapshotRef: OSM_LICENSE_SNAPSHOT_ID,
        visibility: 'public',
      });
      const adopted = await createStreamingAcquiredArtifact(
        existingMetadata,
        context.artifactStore,
      );
      if (resume?.complete !== true) {
        const nextCheckpoint = completedCheckpoint(
          plan,
          resume,
          adopted.metadata.artifactId,
          context.clock.now(),
        );
        const envelope = createCheckpointEnvelope({
          scope,
          previousRevision: current?.revision ?? null,
          writtenAt: nextCheckpoint.updatedAt,
          payload: nextCheckpoint,
        });
        const commit = await context.checkpointStore.commit({
          expectedRevision: current?.revision ?? null,
          checkpoint: envelope,
        });
        if (commit.status !== 'committed') {
          throw providerError(
            'RECONCILIATION',
            'OSM orphan checkpoint revision conflict',
            'acquire',
          );
        }
      }
      yield adopted;
      return;
    }
    if (resume?.complete === true) {
      throw providerError('RECONCILIATION', 'OSM checkpoint artifact is missing', 'acquire');
    }
    const { response, attempt } = await requestWithRetry('GET', this.#extract.url, context);
    const responseType = header(response.headers, 'content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase();
    if (
      responseType !== 'application/vnd.openstreetmap.data.pbf' &&
      responseType !== 'application/octet-stream'
    ) {
      throw providerError('SCHEMA_DRIFT', 'Pinned OSM extract media type changed', 'acquire', {
        mediaType: responseType ?? null,
      });
    }
    const retrievedAt = context.clock.now();
    const etag = header(response.headers, 'etag') ?? null;
    const lastModified = parseHttpDate(header(response.headers, 'last-modified'));
    let stored;
    try {
      stored = await persistAcquiredBody({
        store: context.artifactStore,
        logicalKey,
        mediaType: 'application/vnd.openstreetmap.data.pbf',
        body: response.body,
        expectedSha256: sha256,
        maximumBytes: this.#extract.expectedByteSize,
        metadata: Object.freeze({
          extractId: this.#extract.extractId,
          distributor: this.#extract.distributor,
          extractTimestamp: this.#extract.extractTimestamp,
          distributorChecksumAlgorithm: this.#extract.distributorChecksum.algorithm,
          distributorChecksum: this.#extract.distributorChecksum.value,
          attribution: OSM_ATTRIBUTION,
          license: 'ODbL-1.0',
          retrievedAt,
          attempt: String(attempt),
          httpStatus: String(response.status),
          etag: etag ?? '',
          lastModified: lastModified ?? '',
        }),
        signal: context.signal,
      });
    } catch (error) {
      if (context.signal.aborted) throw error;
      throw providerError('SCHEMA_DRIFT', 'Pinned OSM PBF byte integrity mismatch', 'acquire', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (stored.byteSize !== this.#extract.expectedByteSize || stored.sha256 !== sha256) {
      throw providerError('SCHEMA_DRIFT', 'Pinned OSM PBF byte integrity mismatch', 'acquire', {
        expectedByteSize: this.#extract.expectedByteSize,
        actualByteSize: stored.byteSize,
        expectedSha256: this.#extract.expectedSha256,
        actualSha256: stored.sha256,
      });
    }
    const metadata = acquiredArtifactSchema.parse({
      artifactId: `sc:artifact:sha256:${sha256}`,
      sourceId: OSM_PEDESTRIAN_GRAPH_SOURCE_ID,
      snapshotId: plan.snapshotId,
      retrievedAt,
      sourceAsOf: { state: 'reported', at: this.#extract.extractTimestamp },
      request: {
        requestKey: this.#extract.extractId,
        method: 'GET',
        url: this.#extract.url,
        headers: [{ name: 'accept', valueSha256: sha256Hex(new TextEncoder().encode(ACCEPT)) }],
        bodySha256: null,
        attempt,
      },
      response: {
        httpStatus: response.status,
        etag,
        lastModified,
        finalUrl: this.#extract.url,
      },
      mediaType: 'application/vnd.openstreetmap.data.pbf',
      encoding: 'pbf',
      byteSize: stored.byteSize,
      sha256,
      schemaFingerprint: {
        algorithm: 'sha256',
        value: OSM_DECODED_SCHEMA_FINGERPRINT,
        schemaName: 'osm-pbf-decoded-element-v1',
        canonicalizationVersion: '1.0.0',
      },
      rawUri: stored.uri,
      licenseSnapshotRef: OSM_LICENSE_SNAPSHOT_ID,
      visibility: 'public',
    });
    const nextCheckpoint = completedCheckpoint(plan, checkpoint, metadata.artifactId, retrievedAt);
    const envelope = createCheckpointEnvelope({
      scope,
      previousRevision: current?.revision ?? null,
      writtenAt: retrievedAt,
      payload: nextCheckpoint,
    });
    const commit = await context.checkpointStore.commit({
      expectedRevision: current?.revision ?? null,
      checkpoint: envelope,
    });
    if (commit.status !== 'committed') {
      throw providerError('RECONCILIATION', 'OSM checkpoint revision conflict', 'acquire');
    }
    yield await createStreamingAcquiredArtifact(metadata, context.artifactStore);
  }

  public async *decode(
    artifact: AcquiredArtifactSource,
    context: StreamingDecodeContext,
  ): AsyncIterable<OsmPedestrianDecodedRecord> {
    context.signal.throwIfAborted();
    if (
      artifact.metadata.sourceId !== OSM_PEDESTRIAN_GRAPH_SOURCE_ID ||
      artifact.metadata.sha256 !== this.#extract.expectedSha256 ||
      artifact.metadata.byteSize !== this.#extract.expectedByteSize ||
      artifact.metadata.schemaFingerprint.value !== OSM_DECODED_SCHEMA_FINGERPRINT
    ) {
      throw providerError(
        'SCHEMA_DRIFT',
        'Decoded artifact does not match the pinned OSM source lock',
        'decode',
      );
    }
    if (artifact.content === undefined) {
      throw providerError('SCHEMA_DRIFT', 'OSM production decode requires streaming v2', 'decode');
    }
    let previousKey: string | undefined;
    let previousSha256: string | undefined;
    let previousOrder: readonly [number, bigint] | null = null;
    let ordinal = 0;
    for await (const element of this.#decoder.decode(
      artifact.content,
      context.signal,
      PBF_DECODE_LIMITS,
    )) {
      context.signal.throwIfAborted();
      const order = decodedOrder(element);
      if (order === null) {
        throw providerError(
          'SCHEMA_DRIFT',
          'OSM decoder emitted an unsupported element type or non-positive element ID',
          'decode',
        );
      }
      assertDecodedElementLimits(element);
      const recordSha256 = digest(stableJson(element));
      const key = `${element.type}/${String(element.id)}`;
      if (
        previousOrder !== null &&
        (order[0] < previousOrder[0] ||
          (order[0] === previousOrder[0] && order[1] < previousOrder[1]))
      ) {
        throw providerError(
          'SCHEMA_DRIFT',
          `OSM decoder emitted out-of-order element ${key}`,
          'decode',
        );
      }
      if (previousKey === key && previousSha256 !== undefined) {
        if (previousSha256 !== recordSha256) {
          throw providerError(
            'SCHEMA_DRIFT',
            `Conflicting duplicate decoded OSM element ${key}`,
            'decode',
          );
        }
        continue;
      }
      previousKey = key;
      previousSha256 = recordSha256;
      previousOrder = order;
      yield Object.freeze({
        format: 'pbf',
        artifactId: artifact.metadata.artifactId,
        ordinal,
        visibility: artifact.metadata.visibility,
        layer: 'openstreetmap',
        featureId:
          typeof element.id === 'number' || typeof element.id === 'string' ? element.id : null,
        geometryType:
          element.type === 'node' ? 'point' : element.type === 'way' ? 'line' : 'unknown',
        properties: Object.freeze({
          elementType: element.type,
          elementId: String(element.id),
        }),
        element,
        snapshotId: artifact.metadata.snapshotId,
        sourceId: artifact.metadata.sourceId,
        retrievedAt: artifact.metadata.retrievedAt,
        sourceAsOf: this.#extract.extractTimestamp,
        recordSha256,
      });
      ordinal += 1;
    }
  }

  public validate(
    record: OsmPedestrianDecodedRecord,
    context: ValidationContext,
  ): Promise<RecordValidation<ValidatedOsmPedestrianRecord>> {
    context.signal.throwIfAborted();
    const validated = validateElement(record.element, this.#extract.bounds);
    if (validated.element === undefined) {
      return Promise.resolve(Object.freeze({ status: 'rejected', issues: validated.issues }));
    }
    return Promise.resolve(
      Object.freeze({
        status: 'accepted',
        issues: Object.freeze([]),
        record: Object.freeze({
          artifactId: record.artifactId,
          snapshotId: record.snapshotId,
          sourceId: record.sourceId,
          retrievedAt: record.retrievedAt,
          sourceAsOf: record.sourceAsOf,
          ordinal: record.ordinal,
          recordSha256: record.recordSha256,
          visibility: record.visibility,
          element: validated.element,
        }),
      }),
    );
  }

  public async *normalize(
    record: ValidatedOsmPedestrianRecord,
    context: NormalizationContext,
  ): AsyncIterable<CanonicalMutation> {
    await Promise.resolve();
    context.signal.throwIfAborted();
    const elementKey = `${record.element.type}/${record.element.id}@${record.element.version}`;
    const runId = runIdSchema.parse(`sc:run:${digest(record.snapshotId, 'osm-graph-input')}`);
    yield canonicalMutationSchema.parse({
      kind: 'artifact_reference',
      mutationId: `sc:mutation:${digest(record.snapshotId, elementKey, record.recordSha256)}`,
      runId,
      sourceId: record.sourceId,
      snapshotId: record.snapshotId,
      sequence: record.ordinal,
      emittedAt: record.retrievedAt,
      visibility: record.visibility,
      artifact: {
        artifactId: record.artifactId,
        role: 'raw',
        entityId: null,
        description: `Validated ${elementKey} retained as deterministic pedestrian-graph input; no distance claim emitted.`,
      },
    });
  }

  public async summarize(
    run: SourceRunObservationV2,
    context: SummaryContext,
  ): Promise<SourceRunSummary> {
    context.signal.throwIfAborted();
    if (
      run.descriptor.sourceId !== OSM_PEDESTRIAN_GRAPH_SOURCE_ID ||
      run.request.snapshotId !== run.plan.snapshotId ||
      run.acceptedRecords + run.rejectedRecords !== run.decodedRecords
    ) {
      throw providerError('RECORD_QUALITY', 'OSM source-run accounting mismatch', 'summarize');
    }
    let warningCount = 0;
    let errorCount = 0;
    for await (const issue of run.validationIssues.read()) {
      if (issue.severity === 'warning') warningCount += 1;
      else errorCount += 1;
    }
    const visibilityCounts = {
      public: 0,
      authenticated: 0,
      restricted: 0,
      prohibited_public: 0,
    };
    for await (const mutation of run.mutations.read()) {
      visibilityCounts[mutation.visibility] += 1;
    }
    return sourceRunSummarySchema.parse({
      sourceId: OSM_PEDESTRIAN_GRAPH_SOURCE_ID,
      snapshotId: run.request.snapshotId,
      runId: run.runId,
      contractVersion: OSM_PEDESTRIAN_GRAPH_CONTRACT_VERSION,
      status: run.aborted
        ? 'aborted'
        : errorCount > 0 || run.rejectedRecords > 0
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

export function createOsmPedestrianGraphAdapter(
  options: OsmPedestrianGraphAdapterOptions,
): OsmPedestrianGraphAdapter {
  return new OsmPedestrianGraphAdapter(options);
}
