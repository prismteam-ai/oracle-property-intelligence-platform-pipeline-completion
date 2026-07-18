import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ArtifactByteRange,
  ImmutableArtifactWrite,
  RecoverableArtifactStore,
  StoredArtifact,
  StreamingImmutableArtifactWrite,
} from '@oracle/artifacts/artifact-store';
import { createCheckpointEnvelope } from '@oracle/artifacts/checkpoint-store';
import type { CanonicalMutation } from '@oracle/contracts/canonical/mutation';
import { oracleErrorSchema } from '@oracle/contracts/errors';
import { snapshotIdSchema } from '@oracle/contracts/ids';
import {
  acquiredArtifactSchema,
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
import type {
  AnalyticalRuntime,
  AnalyticalSnapshot,
} from '@oracle/data-runtime/analytical-runtime';

import {
  createStreamingAcquiredArtifact,
  MAX_ANALYTICAL_SNAPSHOT_MANIFEST_BYTES,
  parseAnalyticalSnapshotManifest,
  type AcquiredArtifactSource,
  type StreamingAcquiredArtifact,
} from '../../spi/acquired-artifact.js';
import type {
  DiscoveryContext,
  DiscoveryResult,
  PlanningContext,
  RecordValidation,
  RepeatableAcquiredArtifactSources,
  SourceRunObservationV2,
  StreamingAcquisitionContext,
  StreamingDecodeContext,
  StreamingNormalizationContext,
  StreamingSourceAdapter,
  SummaryContext,
  ValidationContext,
} from '../../spi/adapter.js';
import { persistAcquiredBody } from '../../spi/acquisition.js';
import type { HttpHeaders } from '../../spi/http.js';
import { decodeGtfsZipStream, gtfsDerivedManifestLogicalKey, validateGtfsFeed } from './gtfs.js';
import {
  createCanonicalTransitMutations,
  createStreamingCanonicalTransitMutations,
  normalizeTransitSnapshot,
} from './normalize.js';
import type { GtfsDecodedFeed, TransitFeedSnapshotConfig, ValidatedGtfsFeed } from './types.js';

const GTFS_SCHEMA_FINGERPRINT = createHash('sha256')
  .update('gtfs-static-v1|agency|stops|routes|trips|calendar|calendar_dates|stop_times|transfers?')
  .digest('hex');

type DuckDBRuntimeModule = Readonly<{
  DuckDBAnalyticalRuntime: new (
    options: Readonly<{
      loadSnapshot: (
        snapshot: AnalyticalSnapshot,
        signal?: AbortSignal,
      ) => Promise<
        Readonly<{
          manifestBytes: Uint8Array;
          scanBytesByOperation: Readonly<Record<string, number>>;
        }>
      >;
      nowMilliseconds: () => number;
    }>,
  ) => AnalyticalRuntime;
}>;

class ConfinedGtfsArtifactStore implements RecoverableArtifactStore, AsyncDisposable {
  readonly #byLogicalKey = new Map<string, StoredArtifact>();
  readonly #byUri = new Map<string, StoredArtifact>();

  private constructor(readonly root: string) {}

  public static async create(): Promise<ConfinedGtfsArtifactStore> {
    return new ConfinedGtfsArtifactStore(await mkdtemp(join(tmpdir(), 'oracle-gtfs-finalize-')));
  }

  public putImmutable(request: ImmutableArtifactWrite): Promise<StoredArtifact> {
    return this.putImmutableStreaming(request);
  }

  public async putImmutableStreaming(
    request: StreamingImmutableArtifactWrite,
  ): Promise<StoredArtifact> {
    const existing = this.#byLogicalKey.get(request.logicalKey);
    if (existing !== undefined)
      throw new Error(`Temporary immutable conflict: ${request.logicalKey}`);
    await mkdir(this.root, { recursive: true });
    const uri = join(this.root, createHash('sha256').update(request.logicalKey).digest('hex'));
    const output = await open(uri, 'wx');
    const hash = createHash('sha256');
    let byteSize = 0;
    try {
      const body =
        request.body instanceof Uint8Array
          ? (async function* () {
              await Promise.resolve();
              yield request.body as Uint8Array;
            })()
          : request.body;
      for await (const chunk of body) {
        hash.update(chunk);
        byteSize += chunk.byteLength;
        await output.write(chunk);
      }
    } finally {
      await output.close();
    }
    const sha256 = hash.digest('hex');
    if (request.expectedSha256 !== undefined && request.expectedSha256 !== sha256) {
      throw new Error(`Temporary GTFS artifact hash mismatch: ${request.logicalKey}`);
    }
    const stored = Object.freeze({
      logicalKey: request.logicalKey,
      uri,
      mediaType: request.mediaType,
      byteSize,
      sha256,
      storedAt: new Date(0).toISOString(),
      metadata: Object.freeze({ ...request.metadata }),
    });
    this.#byLogicalKey.set(request.logicalKey, stored);
    this.#byUri.set(uri, stored);
    return stored;
  }

  public async head(uri: string): Promise<StoredArtifact | undefined> {
    const stored = this.#byUri.get(uri);
    if (stored === undefined) return undefined;
    if ((await stat(uri)).size !== stored.byteSize) throw new Error('Temporary GTFS size mismatch');
    return stored;
  }

  public async headByLogicalKey(logicalKey: string): Promise<StoredArtifact | undefined> {
    const stored = this.#byLogicalKey.get(logicalKey);
    if (stored === undefined) return undefined;
    for await (const chunk of this.read(stored.uri)) void chunk;
    return stored;
  }

  public async *read(uri: string, range?: ArtifactByteRange): AsyncIterable<Uint8Array> {
    const stored = this.#byUri.get(uri);
    if (stored === undefined) throw new Error(`Temporary GTFS artifact missing: ${uri}`);
    const hash = createHash('sha256');
    let byteSize = 0;
    const stream = createReadStream(
      uri,
      range === undefined ? undefined : { start: range.start, end: range.endInclusive },
    );
    for await (const chunk of stream) {
      const bytes = new Uint8Array(chunk);
      if (range === undefined) hash.update(bytes);
      byteSize += bytes.byteLength;
      yield bytes;
    }
    const expected = range === undefined ? stored.byteSize : range.endInclusive - range.start + 1;
    if (byteSize !== expected) throw new Error(`Temporary GTFS short read: ${uri}`);
    if (range === undefined && hash.digest('hex') !== stored.sha256) {
      throw new Error(`Temporary GTFS read hash mismatch: ${uri}`);
    }
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

async function confinedGtfsRuntime(store: ConfinedGtfsArtifactStore): Promise<AnalyticalRuntime> {
  const moduleSpecifier = ['@oracle/data-runtime/duckdb', 'duckdb-analytical-runtime'].join('/');
  const { DuckDBAnalyticalRuntime } = (await import(moduleSpecifier)) as DuckDBRuntimeModule;
  if (typeof DuckDBAnalyticalRuntime !== 'function') {
    throw new TypeError('DuckDB analytical runtime module is invalid');
  }
  return new DuckDBAnalyticalRuntime({
    loadSnapshot: async (snapshot, signal) => {
      signal?.throwIfAborted();
      const stored = await store.head(snapshot.manifestUri);
      if (
        stored?.sha256 !== snapshot.manifestSha256 ||
        stored.byteSize < 1 ||
        stored.byteSize > MAX_ANALYTICAL_SNAPSHOT_MANIFEST_BYTES
      ) {
        throw new Error('Temporary GTFS analytical manifest failed immutable verification');
      }
      const manifestBytes = new Uint8Array(stored.byteSize);
      let offset = 0;
      for await (const chunk of store.read(stored.uri)) {
        signal?.throwIfAborted();
        if (offset + chunk.byteLength > manifestBytes.byteLength) {
          throw new Error('Temporary GTFS analytical manifest exceeded its verified byte length');
        }
        manifestBytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (offset !== manifestBytes.byteLength) {
        throw new Error('Temporary GTFS analytical manifest ended early');
      }
      const manifest = parseAnalyticalSnapshotManifest(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)),
      );
      return Object.freeze({
        manifestBytes,
        scanBytesByOperation: manifest.scanBytesByOperation,
      });
    },
    nowMilliseconds: () => Date.now(),
  });
}

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
    contractVersion: '2.0.0',
    cursor: 'complete',
    nextSequence: 1,
    completedRequestKeys: [requestKey],
    acquiredArtifactIds: [artifactId as SourceCheckpoint['acquiredArtifactIds'][number]],
    updatedAt,
    complete: true,
  };
}

function checkpointForPlan(
  value: unknown,
  plan: AcquisitionPlan,
  expectedArtifactId: string,
  label: 'caller' | 'persisted',
): SourceCheckpoint {
  const parsed = sourceCheckpointSchema.safeParse(value);
  const item = plan.items[0];
  if (
    !parsed.success ||
    item === undefined ||
    plan.items.length !== 1 ||
    item.sequence !== 0 ||
    parsed.data.sourceId !== plan.sourceId ||
    parsed.data.snapshotId !== plan.snapshotId ||
    parsed.data.contractVersion !== plan.contractVersion ||
    parsed.data.cursor !== 'complete' ||
    parsed.data.nextSequence !== 1 ||
    parsed.data.completedRequestKeys.length !== 1 ||
    parsed.data.completedRequestKeys[0] !== item.requestKey ||
    parsed.data.acquiredArtifactIds.length !== 1 ||
    parsed.data.acquiredArtifactIds[0] !== expectedArtifactId ||
    !parsed.data.complete
  ) {
    throw new Error(`${label} GTFS checkpoint is not the exact committed acquisition prefix`);
  }
  return parsed.data;
}

function assertGtfsStoredArtifact(
  stored: StoredArtifact,
  plan: AcquisitionPlan,
  item: AcquisitionPlan['items'][number],
  config: TransitFeedSnapshotConfig,
): void {
  if (
    stored.sha256 !== config.expectedZipSha256 ||
    (config.expectedZipBytes !== null && stored.byteSize !== config.expectedZipBytes) ||
    !item.expectedMediaTypes.includes(stored.mediaType) ||
    stored.metadata.sourceId !== plan.sourceId ||
    stored.metadata.snapshotId !== plan.snapshotId ||
    stored.metadata.requestKey !== item.requestKey ||
    typeof stored.metadata.retrievedAt !== 'string' ||
    !/^2\d\d$/u.test(stored.metadata.responseStatus ?? '')
  ) {
    throw new Error('GTFS immutable raw artifact does not match its committed checkpoint');
  }
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

async function* artifactChunks(artifact: AcquiredArtifactSource): AsyncIterable<Uint8Array> {
  if (artifact.bytes !== undefined) {
    yield artifact.bytes.copy();
    return;
  }
  yield* artifact.content.read({ maxChunkBytes: 64 * 1024 });
}

export class StaticGtfsAdapter implements StreamingSourceAdapter<
  GtfsDecodedFeed,
  ValidatedGtfsFeed
> {
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
      contractVersion: '2.0.0',
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
      contractVersion: '2.0.0',
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
    context: StreamingAcquisitionContext,
  ): AsyncIterable<StreamingAcquiredArtifact> {
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
    const expectedArtifactId = `sc:artifact:sha256:${this.#config.expectedZipSha256}`;
    const scope = `${this.#config.sourceId}|${plan.snapshotId}`;
    const storedCheckpointEnvelope = await context.checkpointStore.load(scope);
    const callerCheckpoint =
      checkpoint === undefined
        ? undefined
        : checkpointForPlan(checkpoint, plan, expectedArtifactId, 'caller');
    const persistedCheckpoint =
      storedCheckpointEnvelope === undefined
        ? undefined
        : checkpointForPlan(
            storedCheckpointEnvelope.payload,
            plan,
            expectedArtifactId,
            'persisted',
          );
    if (
      callerCheckpoint !== undefined &&
      persistedCheckpoint !== undefined &&
      JSON.stringify(callerCheckpoint) !== JSON.stringify(persistedCheckpoint)
    ) {
      throw new Error('Caller and persisted GTFS checkpoints disagree');
    }
    const resume = persistedCheckpoint ?? callerCheckpoint;
    for (const item of [...plan.items].sort((left, right) => left.sequence - right.sequence)) {
      const replayingCommittedArtifact = resume !== undefined;
      context.signal.throwIfAborted();
      const logicalKey = `raw/${this.#config.sourceId}/${plan.snapshotId}/${item.requestKey}.zip`;
      let stored = await context.artifactStore.headByLogicalKey(logicalKey);
      let responseStatus: number;
      let responseEtag: string | null;
      let responseLastModified: string | null;
      let mediaType: string;
      let retrievedAt: string;
      if (stored === undefined && replayingCommittedArtifact) {
        throw new Error('Committed GTFS checkpoint is missing its immutable raw artifact');
      }
      if (stored === undefined) {
        const response = await context.http.send(
          { method: item.method, url: item.url, headers: Object.freeze({}) },
          context.signal,
        );
        responseStatus = response.status;
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
        mediaType =
          header(response.headers, 'content-type')?.split(';', 1)[0]?.trim() ?? 'application/zip';
        if (!item.expectedMediaTypes.includes(mediaType)) {
          throw oracleFailure({
            code: 'SCHEMA_DRIFT',
            retryable: false,
            message: `GTFS source returned unexpected media type ${mediaType}`,
            sourceId: this.#config.sourceId,
            phase: 'acquire',
          });
        }
        responseEtag = header(response.headers, 'etag') ?? null;
        responseLastModified = isoHttpDate(header(response.headers, 'last-modified'));
        retrievedAt = context.clock.now();
        stored = await persistAcquiredBody({
          store: context.artifactStore,
          logicalKey,
          mediaType,
          body: response.body,
          maximumBytes: this.#config.expectedZipBytes ?? 64 * 1024 * 1024,
          expectedSha256: this.#config.expectedZipSha256,
          metadata: Object.freeze({
            sourceId: this.#config.sourceId,
            snapshotId: plan.snapshotId,
            requestKey: item.requestKey,
            retrievedAt,
            responseStatus: String(response.status),
            responseEtag: responseEtag ?? '',
            responseLastModified: responseLastModified ?? '',
          }),
          signal: context.signal,
        });
      } else {
        mediaType = stored.mediaType;
        responseStatus = Number(stored.metadata.responseStatus);
        responseEtag =
          stored.metadata.responseEtag === '' ? null : (stored.metadata.responseEtag ?? null);
        responseLastModified =
          stored.metadata.responseLastModified === ''
            ? null
            : (stored.metadata.responseLastModified ?? null);
        retrievedAt = stored.metadata.retrievedAt ?? context.clock.now();
      }
      assertGtfsStoredArtifact(stored, plan, item, this.#config);
      const sha256 = stored.sha256;
      if (
        sha256 !== this.#config.expectedZipSha256 ||
        (this.#config.expectedZipBytes !== null &&
          stored.byteSize !== this.#config.expectedZipBytes)
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
          httpStatus: responseStatus,
          etag: responseEtag,
          lastModified: responseLastModified,
          finalUrl: item.url,
        },
        mediaType,
        encoding: 'zip',
        byteSize: stored.byteSize,
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
      const rawArtifact = await createStreamingAcquiredArtifact(metadata, context.artifactStore);
      const analyticalManifestLogicalKey = gtfsDerivedManifestLogicalKey(
        metadata.sourceId,
        metadata.snapshotId,
      );
      if (
        replayingCommittedArtifact &&
        (await context.artifactStore.headByLogicalKey(analyticalManifestLogicalKey)) === undefined
      ) {
        throw new Error('Committed GTFS checkpoint is missing its analytical manifest');
      }
      const persistedManifest = replayingCommittedArtifact
        ? await context.artifactStore.headByLogicalKey(analyticalManifestLogicalKey)
        : undefined;
      if (
        persistedManifest !== undefined &&
        (persistedManifest.metadata.sourceId !== plan.sourceId ||
          persistedManifest.metadata.snapshotId !== plan.snapshotId ||
          persistedManifest.metadata.parentArtifactId !== rawArtifact.metadata.artifactId ||
          persistedManifest.metadata.formatVersion !== '1.0.0')
      ) {
        throw new Error('Committed GTFS analytical manifest does not match its raw artifact');
      }
      if (!replayingCommittedArtifact) {
        await decodeGtfsZipStream(
          rawArtifact,
          artifactChunks(rawArtifact),
          context.artifactStore,
          this.#config.agencyId,
          context.signal,
        );
      }
      if (!replayingCommittedArtifact) {
        const nextCheckpoint = checkpointFor(
          this.#config,
          plan.snapshotId,
          item.requestKey,
          artifactId,
          retrievedAt,
        );
        const envelope = createCheckpointEnvelope({
          scope,
          previousRevision: storedCheckpointEnvelope?.revision ?? null,
          writtenAt: retrievedAt,
          payload: nextCheckpoint,
        });
        const committed = await context.checkpointStore.commit({
          expectedRevision: storedCheckpointEnvelope?.revision ?? null,
          checkpoint: envelope,
        });
        if (committed.status === 'conflict') throw new Error(`Checkpoint conflict for ${scope}`);
      }
      yield await createStreamingAcquiredArtifact(metadata, context.artifactStore, {
        analyticalManifestLogicalKey,
      });
    }
  }

  public async *decode(
    artifact: AcquiredArtifactSource,
    context: StreamingDecodeContext,
  ): AsyncIterable<GtfsDecodedFeed> {
    context.signal.throwIfAborted();
    yield await decodeGtfsZipStream(
      artifact,
      artifactChunks(artifact),
      context.artifactStore,
      this.#config.agencyId,
      context.signal,
    );
  }

  public async validate(
    record: GtfsDecodedFeed,
    context: ValidationContext,
  ): Promise<RecordValidation<ValidatedGtfsFeed>> {
    context.signal.throwIfAborted();
    if (record.streamingManifest !== undefined) {
      const issues = Object.freeze([...(record.streamingValidationIssues ?? [])]);
      if (issues.some((issue) => issue.severity !== 'warning')) {
        return Promise.resolve(Object.freeze({ status: 'rejected', issues }));
      }
      return Promise.resolve(
        Object.freeze({
          status: 'accepted',
          record: Object.freeze({
            ...record,
            agency: Object.freeze([]),
            stops: Object.freeze([]),
            routes: Object.freeze([]),
            trips: Object.freeze([]),
            calendars: Object.freeze([]),
            calendarDates: Object.freeze([]),
            stopTimes: Object.freeze([]),
            transfers: Object.freeze([]),
          }),
          issues,
        }),
      );
    }
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
    context: StreamingNormalizationContext,
  ): AsyncIterable<CanonicalMutation> {
    context.signal.throwIfAborted();
    await Promise.resolve();
    if (record.streamingManifest !== undefined) {
      return;
    }
    const snapshot = normalizeTransitSnapshot(record, this.#config);
    for (const mutation of createCanonicalTransitMutations(record, snapshot, this.#config)) {
      context.signal.throwIfAborted();
      yield mutation;
    }
  }

  public async *finalizeFromAcquiredArtifacts(
    artifacts: RepeatableAcquiredArtifactSources,
    context: StreamingNormalizationContext,
  ): AsyncIterable<CanonicalMutation> {
    context.signal.throwIfAborted();
    if (artifacts.count !== 1 || artifacts.metadata.length !== 1) {
      throw new Error('GTFS durable finalization requires exactly one acquired ZIP');
    }
    let observed = 0;
    for await (const artifact of artifacts.read()) {
      observed += 1;
      if (observed > 1 || artifact.metadata.sourceId !== this.#config.sourceId) {
        throw new Error('GTFS durable finalization artifact sequence changed');
      }
      const analyticalSnapshot = artifact.content?.analyticalSnapshot;
      if (analyticalSnapshot === undefined) {
        throw new Error('GTFS acquired ZIP is missing its durable analytical manifest');
      }
      const temporaryStore = await ConfinedGtfsArtifactStore.create();
      try {
        const decoded = await decodeGtfsZipStream(
          artifact,
          artifactChunks(artifact),
          temporaryStore,
          this.#config.agencyId,
          context.signal,
        );
        if (decoded.streamingManifest === undefined) {
          throw new Error('GTFS temporary manifest was not created');
        }
        const validation = await this.validate(decoded, {
          clock: context.clock,
          signal: context.signal,
        });
        if (validation.status !== 'accepted') {
          throw new Error(
            `GTFS durable finalization rejected: ${JSON.stringify(validation.issues)}`,
          );
        }
        yield* createStreamingCanonicalTransitMutations(validation.record, this.#config, {
          ...context,
          analyticalRuntime: await confinedGtfsRuntime(temporaryStore),
        });
      } finally {
        await temporaryStore[Symbol.asyncDispose]();
      }
    }
    if (observed !== artifacts.count) {
      throw new Error('GTFS durable finalization artifact sequence was truncated');
    }
  }

  public async summarize(
    run: SourceRunObservationV2,
    context: SummaryContext,
  ): Promise<SourceRunSummary> {
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
    for await (const mutation of run.mutations.read()) {
      context.signal.throwIfAborted();
      visibilityCounts[mutation.visibility] += 1;
    }
    let warningCount = 0;
    let errorCount = 0;
    for await (const issue of run.validationIssues.read()) {
      context.signal.throwIfAborted();
      if (issue.severity === 'warning') warningCount += 1;
      else errorCount += 1;
    }
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

export function createStaticGtfsAdapter(config: TransitFeedSnapshotConfig): StaticGtfsAdapter {
  return new StaticGtfsAdapter(config);
}
