import { createHash } from 'node:crypto';

import { createCheckpointEnvelope } from '@oracle/artifacts/checkpoint-store';
import { assertStoredArtifactIntegrity } from '@oracle/artifacts/artifact-store';
import {
  canonicalMutationSchema,
  type CanonicalMutation,
} from '@oracle/contracts/canonical/mutation';
import {
  acquiredArtifactSchema,
  acquisitionPlanSchema,
  sourceCheckpointSchema,
  sourceRunSummarySchema,
  type AcquisitionPlan,
  type AcquisitionRequest,
  type SourceCheckpoint,
  type SourceDescriptor,
  type SourceAsOf,
  type SourceRunSummary,
  type ValidationIssue,
} from '@oracle/contracts/source';

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
import {
  createAcquiredByteArtifact,
  type AcquiredByteArtifact,
} from '../../spi/acquired-artifact.js';
import type { GeoJsonDecodedRecord, GeoTiffDecodedRecord } from '../../spi/decode.js';
import type { HttpResponse } from '../../spi/http.js';
import { sha256Hex } from '../../spi/bytes.js';
import {
  NOAA_CUSP_SHORELINE,
  USGS_3DEP_ELEVATION,
  USGS_3DHP_HYDROGRAPHY,
  WATER_ELEVATION_PRODUCTS,
  assertCurrentProduct,
  type WaterElevationProduct,
  type WaterElevationProductKind,
} from './catalog.js';
import {
  boundsIntersect,
  degreesToApproximateMeters,
  type SupportedGeometry,
  type Wgs84Bounds,
} from './geometry.js';
import {
  decodeElevationGeoTiff,
  decodeHydroFeatureCollection,
  decodeNoaaShorelineArchive,
  summarizeNoDataWindow,
} from './formats.js';

export const SANTA_CLARA_WATER_TERRAIN_BOUNDS: Wgs84Bounds = Object.freeze([
  -122.25, 36.85, -121.15, 37.55,
]);

export const WATER_VIEW_LIMITATIONS = Object.freeze([
  'Mapped shoreline or hydrography proximity does not prove a view.',
  'Bare-earth terrain line-of-sight excludes buildings and vegetation.',
  'Windows, observer height, orientation, and on-site obstructions are not represented.',
]);

export type WaterViewClaim = 'candidate' | 'verified_view';

export function assertWaterViewClaim(claim: WaterViewClaim): void {
  if (claim !== 'candidate') {
    throw new TypeError(
      'This source family may emit water-view candidates only, never verified views',
    );
  }
}

interface ProviderRecordMetadata {
  readonly productKind: WaterElevationProductKind;
  readonly productVersion: string;
  readonly sourceId: SourceDescriptor['sourceId'];
  readonly snapshotId: AcquisitionRequest['snapshotId'];
  readonly retrievedAt: string;
  readonly sourceAsOfAt: string;
  readonly recordKey: string;
  readonly artifactSha256: string;
  readonly attribution: readonly string[];
  readonly limitations: readonly string[];
}

export interface WaterVectorDecodedRecord extends GeoJsonDecodedRecord, ProviderRecordMetadata {
  readonly productKind: 'hydrography' | 'shoreline';
  readonly geometry: SupportedGeometry;
}

export interface ElevationDecodedRecord extends GeoTiffDecodedRecord, ProviderRecordMetadata {
  readonly productKind: 'elevation';
  readonly bounds: Wgs84Bounds;
  readonly resolutionDegrees: readonly [number, number];
  readonly horizontalCrs: string;
  readonly horizontalUnits: string;
  readonly verticalCrs: string;
  readonly verticalUnits: string;
}

export type WaterElevationDecodedRecord = WaterVectorDecodedRecord | ElevationDecodedRecord;
export type WaterElevationValidatedRecord = WaterElevationDecodedRecord;

export interface WaterElevationAdapterOptions {
  readonly bounds?: Wgs84Bounds;
  readonly hydroPageSize?: number;
  readonly elevationSize?: readonly [number, number];
  readonly products?: readonly WaterElevationProduct[];
}

interface SentResponse {
  readonly response: HttpResponse;
  readonly attempt: number;
}

interface HttpFailure {
  readonly code: 'AUTHENTICATION' | 'RECORD_QUALITY' | 'TERMS_ACCESS' | 'TRANSIENT_SOURCE';
  readonly retryable: boolean;
  readonly message: string;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (typeof value !== 'object') {
    throw new TypeError('Cannot canonicalize non-JSON value');
  }
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

function header(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const selected = Object.entries(headers).find(
    ([candidate]) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return selected?.[1];
}

function httpDateToIso(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}

function retryAfterMilliseconds(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1_000) : undefined;
}

export function classifyHttpStatus(status: number): HttpFailure | null {
  if (status >= 200 && status < 300) {
    return null;
  }
  if (status === 401) {
    return Object.freeze({
      code: 'AUTHENTICATION',
      retryable: false,
      message: 'Source authentication failed',
    });
  }
  if (status === 403) {
    return Object.freeze({
      code: 'TERMS_ACCESS',
      retryable: false,
      message: 'Source access is forbidden',
    });
  }
  if (status === 429 || status >= 500) {
    return Object.freeze({
      code: 'TRANSIENT_SOURCE',
      retryable: true,
      message: `Transient source HTTP ${status}`,
    });
  }
  return Object.freeze({
    code: 'RECORD_QUALITY',
    retryable: false,
    message: `Unexpected source HTTP ${status}`,
  });
}

async function collectBody(response: HttpResponse, signal: AbortSignal): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    chunks.push(Uint8Array.from(chunk));
    byteLength += chunk.byteLength;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function queryUrl(base: string, parameters: Readonly<Record<string, string>>): string {
  const url = new URL(base);
  for (const [name, value] of Object.entries(parameters)) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

function boundsParameter(bounds: Wgs84Bounds): string {
  return bounds.join(',');
}

function hydroCountUrl(layer: 50 | 60, bounds: Wgs84Bounds): string {
  return queryUrl(
    `${USGS_3DHP_HYDROGRAPHY.resolvedArtifactUrl.replace('/50', '')}/${layer}/query`,
    {
      where: '1=1',
      geometry: boundsParameter(bounds),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      returnCountOnly: 'true',
      f: 'json',
    },
  );
}

function hydroPageUrl(
  layer: 50 | 60,
  bounds: Wgs84Bounds,
  offset: number,
  pageSize: number,
): string {
  return queryUrl(
    `${USGS_3DHP_HYDROGRAPHY.resolvedArtifactUrl.replace('/50', '')}/${layer}/query`,
    {
      where: '1=1',
      geometry: boundsParameter(bounds),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: '*',
      returnGeometry: 'true',
      outSR: '4326',
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
      orderByFields: 'OBJECTID',
      f: 'geojson',
    },
  );
}

function elevationUrl(bounds: Wgs84Bounds, size: readonly [number, number]): string {
  return queryUrl(USGS_3DEP_ELEVATION.resolvedArtifactUrl, {
    bbox: boundsParameter(bounds),
    bboxSR: '4326',
    imageSR: '4326',
    size: size.join(','),
    format: 'tiff',
    pixelType: 'F32',
    interpolation: 'RSP_BilinearInterpolation',
    compression: 'LZW',
    f: 'image',
  });
}

async function sendWithRetry(
  url: string,
  method: 'GET' | 'HEAD',
  context: Pick<AcquisitionContext, 'delay' | 'http' | 'ratePolicy' | 'signal'>,
): Promise<SentResponse> {
  for (let attempt = 1; attempt <= context.ratePolicy.maxAttempts; attempt += 1) {
    context.signal.throwIfAborted();
    const response = await context.http.send(
      Object.freeze({ method, url, headers: Object.freeze({ Accept: '*/*' }) }),
      context.signal,
    );
    const failure = classifyHttpStatus(response.status);
    if (failure === null) {
      return Object.freeze({ response, attempt });
    }
    if (!failure.retryable || attempt === context.ratePolicy.maxAttempts) {
      const error = new Error(failure.message);
      Object.assign(error, failure, { phase: 'acquire' });
      throw error;
    }
    const retryAfter = context.ratePolicy.respectRetryAfter
      ? retryAfterMilliseconds(header(response.headers, 'retry-after'))
      : undefined;
    const exponential = Math.min(
      context.ratePolicy.maxBackoffMs,
      context.ratePolicy.initialBackoffMs * 2 ** (attempt - 1),
    );
    await context.delay.wait(retryAfter ?? exponential, context.signal);
  }
  throw new Error('Retry loop invariant violated');
}

async function discoveryRequest(
  url: string,
  method: 'GET' | 'HEAD',
  context: DiscoveryContext,
): Promise<SentResponse> {
  return sendWithRetry(url, method, context);
}

function sourceAsOf(product: WaterElevationProduct): SourceAsOf {
  return Object.freeze({ state: 'reported' as const, at: product.serviceAsOf });
}

function assertFrozenArtifactIdentity(
  product: WaterElevationProduct,
  response: HttpResponse,
  bytes?: Uint8Array,
): void {
  const expected = product.frozenArtifact;
  if (expected === null) return;
  const observedEtag = header(response.headers, 'etag');
  const observedLastModified = httpDateToIso(header(response.headers, 'last-modified'));
  const contentLength = header(response.headers, 'content-length');
  if (
    observedEtag !== expected.etag ||
    observedLastModified !== expected.lastModified ||
    contentLength === undefined ||
    Number(contentLength) !== expected.byteSize
  ) {
    throw new Error(`INTEGRITY: Frozen ${product.productName} response identity drifted`);
  }
  if (
    bytes !== undefined &&
    (bytes.byteLength !== expected.byteSize || sha256Hex(bytes) !== expected.sha256)
  ) {
    throw new Error(`INTEGRITY: Frozen ${product.productName} bytes drifted`);
  }
}

function parseCount(bytes: Uint8Array): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error('SCHEMA_DRIFT: USGS 3DHP count response is malformed', { cause: error });
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('count' in parsed) ||
    typeof parsed.count !== 'number' ||
    !Number.isSafeInteger(parsed.count) ||
    parsed.count < 0
  ) {
    throw new Error('SCHEMA_DRIFT: USGS 3DHP count response is missing a valid count');
  }
  return parsed.count;
}

function issue(
  code: string,
  message: string,
  severity: 'error' | 'fatal' | 'warning' = 'error',
): ValidationIssue {
  return Object.freeze({ code, severity, message, recordKey: null, fieldPath: null });
}

class WaterElevationAdapter implements SourceAdapter<
  WaterElevationDecodedRecord,
  WaterElevationValidatedRecord
> {
  readonly #product: WaterElevationProduct;
  readonly #bounds: Wgs84Bounds;
  readonly #hydroPageSize: number;
  readonly #elevationSize: readonly [number, number];
  readonly #resourceSourceAsOf = new Map<string, SourceAsOf>();
  #expectedDiscoveryResources: DiscoveryResult['resources'] | null = null;

  public constructor(
    product: WaterElevationProduct,
    options: Required<Pick<WaterElevationAdapterOptions, 'hydroPageSize' | 'elevationSize'>> & {
      bounds: Wgs84Bounds;
    },
  ) {
    assertCurrentProduct(product);
    if (
      !Number.isSafeInteger(options.hydroPageSize) ||
      options.hydroPageSize < 1 ||
      options.hydroPageSize > 2_500
    ) {
      throw new RangeError('hydroPageSize must be between 1 and 2500');
    }
    if (
      options.elevationSize.some(
        (value) => !Number.isSafeInteger(value) || value < 1 || value > 4_096,
      )
    ) {
      throw new RangeError('Elevation dimensions must be between 1 and 4096 pixels');
    }
    this.#product = product;
    this.#bounds = options.bounds;
    this.#hydroPageSize = options.hydroPageSize;
    this.#elevationSize = options.elevationSize;
  }

  public describe(): SourceDescriptor {
    return this.#product.descriptor;
  }

  public async discover(context: DiscoveryContext): Promise<DiscoveryResult> {
    context.signal.throwIfAborted();
    const resources: {
      requestKey: string;
      url: string;
      sourceAsOf: ReturnType<typeof sourceAsOf>;
      expectedRecords: number | null;
      mediaTypes: readonly string[];
      continuationToken: string | null;
    }[] = [];
    if (this.#product.kind === 'hydrography') {
      for (const layer of [50, 60] as const) {
        const countResponse = await discoveryRequest(
          hydroCountUrl(layer, this.#bounds),
          'GET',
          context,
        );
        const count = parseCount(await collectBody(countResponse.response, context.signal));
        const pages = Math.ceil(count / this.#hydroPageSize);
        for (let page = 0; page < pages; page += 1) {
          const requestKey = `layer-${layer}-page-${page}`;
          resources.push(
            Object.freeze({
              requestKey,
              url: hydroPageUrl(
                layer,
                this.#bounds,
                page * this.#hydroPageSize,
                this.#hydroPageSize,
              ),
              sourceAsOf: sourceAsOf(this.#product),
              expectedRecords: Math.min(this.#hydroPageSize, count - page * this.#hydroPageSize),
              mediaTypes: Object.freeze(['application/geo+json', 'application/json']),
              continuationToken: page + 1 < pages ? `layer-${layer}-page-${page + 1}` : null,
            }),
          );
        }
      }
    } else {
      const url =
        this.#product.kind === 'shoreline'
          ? this.#product.resolvedArtifactUrl
          : elevationUrl(this.#bounds, this.#elevationSize);
      const identityResponse = await discoveryRequest(url, 'HEAD', context);
      assertFrozenArtifactIdentity(this.#product, identityResponse.response);
      resources.push(
        Object.freeze({
          requestKey: this.#product.kind === 'shoreline' ? 'noaa-west-archive' : '3dep-export',
          url,
          sourceAsOf: sourceAsOf(this.#product),
          expectedRecords:
            this.#product.kind === 'elevation'
              ? this.#elevationSize[0] * this.#elevationSize[1]
              : null,
          mediaTypes:
            this.#product.kind === 'shoreline'
              ? Object.freeze(['application/zip'])
              : Object.freeze(['image/tiff']),
          continuationToken: null,
        }),
      );
    }
    const result = Object.freeze({
      sourceId: this.#product.descriptor.sourceId,
      discoveredAt: context.clock.now(),
      resources: Object.freeze(resources),
      complete: true,
      limitations: this.#product.limitations,
    });
    this.#expectedDiscoveryResources = result.resources;
    return result;
  }

  public plan(
    request: AcquisitionRequest,
    discovery: DiscoveryResult,
    context: PlanningContext,
  ): Promise<AcquisitionPlan> {
    context.signal.throwIfAborted();
    if (
      request.sourceId !== this.#product.descriptor.sourceId ||
      discovery.sourceId !== this.#product.descriptor.sourceId
    ) {
      throw new TypeError('Acquisition request/discovery source does not match adapter');
    }
    if (
      !discovery.complete ||
      this.#expectedDiscoveryResources === null ||
      stableJson(discovery.resources) !== stableJson(this.#expectedDiscoveryResources)
    ) {
      throw new TypeError('Discovery resources do not match the adapter-authoritative request set');
    }
    this.#resourceSourceAsOf.clear();
    discovery.resources.forEach((resource) =>
      this.#resourceSourceAsOf.set(resource.requestKey, resource.sourceAsOf),
    );
    return Promise.resolve(
      acquisitionPlanSchema.parse({
        sourceId: request.sourceId,
        snapshotId: request.snapshotId,
        contractVersion: this.#product.descriptor.contractVersion,
        plannedAt: context.clock.now(),
        items: discovery.resources.map((resource, sequence) => ({
          requestKey: resource.requestKey,
          sequence,
          method: 'GET',
          url: resource.url,
          encoding: this.#product.encoding,
          expectedMediaTypes: [...resource.mediaTypes],
        })),
      }),
    );
  }

  public async *acquire(
    plan: AcquisitionPlan,
    checkpoint: SourceCheckpoint | undefined,
    context: AcquisitionContext,
  ): AsyncIterable<AcquiredByteArtifact> {
    if (plan.sourceId !== this.#product.descriptor.sourceId) {
      throw new TypeError('Acquisition plan source does not match adapter');
    }
    if (
      checkpoint !== undefined &&
      (checkpoint.sourceId !== plan.sourceId ||
        checkpoint.snapshotId !== plan.snapshotId ||
        checkpoint.contractVersion !== plan.contractVersion)
    ) {
      throw new TypeError('Checkpoint ownership does not match acquisition plan');
    }
    let completedRequestKeys = [...(checkpoint?.completedRequestKeys ?? [])];
    let acquiredArtifactIds = [...(checkpoint?.acquiredArtifactIds ?? [])];
    const completed = new Set(completedRequestKeys);
    for (const item of [...plan.items].sort((left, right) => left.sequence - right.sequence)) {
      context.signal.throwIfAborted();
      if (completed.has(item.requestKey) || item.sequence < (checkpoint?.nextSequence ?? 0)) {
        continue;
      }
      if (item.method !== 'GET') {
        throw new TypeError(`Unsupported provider acquisition method ${item.method}`);
      }
      const sent = await sendWithRetry(item.url, item.method, context);
      const bytes = await collectBody(sent.response, context.signal);
      if (bytes.byteLength === 0) {
        throw new Error(`RECORD_QUALITY: Empty source response for ${item.requestKey}`);
      }
      const sha256 = sha256Hex(bytes);
      assertFrozenArtifactIdentity(this.#product, sent.response, bytes);
      const mediaType =
        header(sent.response.headers, 'content-type') ??
        item.expectedMediaTypes[0] ??
        'application/octet-stream';
      const logicalKey = `${plan.sourceId}/${plan.snapshotId}/${item.sequence}-${sha256}`;
      const stored = await context.artifactStore.putImmutable({
        logicalKey,
        mediaType,
        body: bytes,
        expectedSha256: sha256,
        metadata: Object.freeze({
          requestKey: item.requestKey,
          sourceId: plan.sourceId,
          snapshotId: plan.snapshotId,
        }),
        ifAbsent: true,
      });
      assertStoredArtifactIntegrity(
        { logicalKey, mediaType, byteSize: bytes.byteLength, sha256 },
        stored,
      );
      const artifactId = `sc:artifact:sha256:${sha256}`;
      const sourceAsOfValue =
        this.#resourceSourceAsOf.get(item.requestKey) ?? sourceAsOf(this.#product);
      const metadata = acquiredArtifactSchema.parse({
        artifactId,
        sourceId: plan.sourceId,
        snapshotId: plan.snapshotId,
        retrievedAt: context.clock.now(),
        sourceAsOf: sourceAsOfValue,
        request: {
          requestKey: item.requestKey,
          method: item.method,
          url: item.url,
          headers: [],
          bodySha256: null,
          attempt: sent.attempt,
        },
        response: {
          httpStatus: sent.response.status,
          etag: header(sent.response.headers, 'etag') ?? null,
          lastModified: httpDateToIso(header(sent.response.headers, 'last-modified')),
          finalUrl: item.url,
        },
        mediaType,
        encoding: item.encoding,
        byteSize: bytes.byteLength,
        sha256,
        schemaFingerprint: {
          algorithm: 'sha256',
          value: hash(
            `${this.#product.productName}|${this.#product.productVersion}|${item.encoding}`,
          ),
          schemaName: `noaa-usgs-water-elevation/${this.#product.kind}`,
          canonicalizationVersion: '1.0.0',
        },
        rawUri: stored.uri,
        licenseSnapshotRef: this.#product.descriptor.license.licenseSnapshotId,
        visibility: this.#product.descriptor.defaultVisibility,
      });
      completedRequestKeys = [...completedRequestKeys, item.requestKey];
      acquiredArtifactIds = [...acquiredArtifactIds, metadata.artifactId];
      completed.add(item.requestKey);
      const nextCheckpoint = sourceCheckpointSchema.parse({
        sourceId: plan.sourceId,
        snapshotId: plan.snapshotId,
        contractVersion: plan.contractVersion,
        cursor: item.requestKey,
        nextSequence: item.sequence + 1,
        completedRequestKeys,
        acquiredArtifactIds,
        updatedAt: context.clock.now(),
        complete: item.sequence + 1 >= plan.items.length,
      });
      const scope = `${plan.sourceId}/${plan.snapshotId}`;
      const current = await context.checkpointStore.load(scope);
      const envelope = createCheckpointEnvelope({
        scope,
        previousRevision: current?.revision ?? null,
        writtenAt: nextCheckpoint.updatedAt,
        payload: nextCheckpoint,
      });
      const committed = await context.checkpointStore.commit({
        expectedRevision: current?.revision ?? null,
        checkpoint: envelope,
      });
      if (committed.status !== 'committed') {
        throw new Error(`Checkpoint conflict for ${scope}`);
      }
      yield createAcquiredByteArtifact(metadata, bytes);
    }
  }

  public async *decode(
    artifact: AcquiredByteArtifact,
    context: DecodeContext,
  ): AsyncIterable<WaterElevationDecodedRecord> {
    context.signal.throwIfAborted();
    const common = {
      productVersion: this.#product.productVersion,
      sourceId: artifact.metadata.sourceId,
      snapshotId: artifact.metadata.snapshotId,
      retrievedAt: artifact.metadata.retrievedAt,
      sourceAsOfAt:
        artifact.metadata.sourceAsOf.state === 'unknown'
          ? this.#product.serviceAsOf
          : artifact.metadata.sourceAsOf.at,
      artifactSha256: artifact.metadata.sha256,
      attribution: this.#product.attribution,
      limitations: this.#product.limitations,
    } as const;
    if (this.#product.kind === 'elevation') {
      const image = await decodeElevationGeoTiff(artifact.bytes.copy());
      yield Object.freeze({
        ...common,
        productKind: 'elevation' as const,
        recordKey: 'image-0',
        artifactId: artifact.metadata.artifactId,
        ordinal: 0,
        visibility: artifact.metadata.visibility,
        format: 'geotiff',
        imageIndex: 0,
        tile: Object.freeze({ x: 0, y: 0, width: image.width, height: image.height }),
        bands: image.bands,
        samples: image.samples,
        noDataValue: image.noDataValue,
        bounds: image.bounds,
        resolutionDegrees: image.resolutionDegrees,
        horizontalCrs: this.#product.horizontalCrs,
        horizontalUnits: this.#product.horizontalUnits,
        verticalCrs: this.#product.verticalCrs ?? 'unknown',
        verticalUnits: this.#product.verticalUnits ?? 'unknown',
      });
      return;
    }
    const features =
      this.#product.kind === 'shoreline'
        ? decodeNoaaShorelineArchive(artifact.bytes.copy(), this.#bounds)
        : decodeHydroFeatureCollection(artifact.bytes.copy(), this.#bounds);
    for (const [ordinal, feature] of features.entries()) {
      context.signal.throwIfAborted();
      yield Object.freeze({
        ...common,
        productKind: this.#product.kind,
        recordKey: feature.recordKey,
        artifactId: artifact.metadata.artifactId,
        ordinal,
        visibility: artifact.metadata.visibility,
        format: 'geojson',
        featureType: 'Feature',
        geometry: feature.geometry,
        properties: feature.properties,
      });
    }
  }

  public validate(
    record: WaterElevationDecodedRecord,
    context: ValidationContext,
  ): Promise<RecordValidation<WaterElevationValidatedRecord>> {
    context.signal.throwIfAborted();
    if (record.productKind === 'elevation') {
      const dimensions = record.tile.width * record.tile.height * record.bands.length;
      if (dimensions !== record.samples.length) {
        return Promise.resolve(
          Object.freeze({
            status: 'rejected',
            issues: [issue('RASTER_DIMENSIONS', 'Raster dimensions do not match sample count')],
          }),
        );
      }
      if (!boundsIntersect(record.bounds, this.#bounds)) {
        return Promise.resolve(
          Object.freeze({
            status: 'rejected',
            issues: [
              issue('OUTSIDE_CLIP', 'Raster does not intersect the requested clipping bounds'),
            ],
          }),
        );
      }
      const window = summarizeNoDataWindow(record.samples, record.noDataValue);
      if (window.validSamples + window.noDataSamples !== record.samples.length) {
        return Promise.resolve(
          Object.freeze({
            status: 'rejected',
            issues: [issue('RASTER_NODATA', 'Raster nodata accounting failed')],
          }),
        );
      }
    }
    assertWaterViewClaim('candidate');
    return Promise.resolve(
      Object.freeze({
        status: 'accepted',
        record,
        issues: Object.freeze([
          issue('NO_VIEW_CLAIM', WATER_VIEW_LIMITATIONS.join(' '), 'warning'),
        ]),
      }),
    );
  }

  public async *normalize(
    record: WaterElevationValidatedRecord,
    context: NormalizationContext,
  ): AsyncIterable<CanonicalMutation> {
    context.signal.throwIfAborted();
    await Promise.resolve();
    const sourceRecordValue = {
      productKind: record.productKind,
      productVersion: record.productVersion,
      recordKey: record.recordKey,
      geometry: record.format === 'geojson' ? record.geometry : undefined,
      properties: record.format === 'geojson' ? record.properties : undefined,
      bounds: record.format === 'geotiff' ? record.bounds : undefined,
      resolutionDegrees: record.format === 'geotiff' ? record.resolutionDegrees : undefined,
      noDataValue: record.format === 'geotiff' ? record.noDataValue : undefined,
      attribution: record.attribution,
      limitations: [...record.limitations, ...WATER_VIEW_LIMITATIONS],
    };
    const recordSha256 = hash(stableJson(sourceRecordValue));
    const entityKey = hash(`${record.sourceId}|${record.snapshotId}|${record.recordKey}`);
    const entityId =
      record.format === 'geotiff'
        ? `sc:entity:elevation-raster-ref:${entityKey}`
        : `sc:entity:hydro-feature:${entityKey}`;
    const outputSha256 = hash(`${entityId}|${recordSha256}|1.0.0`);
    const lineageCore = {
      sourceRecord: {
        sourceId: record.sourceId,
        snapshotId: record.snapshotId,
        artifactId: record.artifactId,
        recordKey: record.recordKey,
        recordSha256,
        rawPointer: record.format === 'geojson' ? `/features/${record.ordinal}` : '/images/0',
      },
      transformations: [
        {
          name: `normalize-${record.productKind}`,
          version: '1.0.0',
          appliedAt: record.retrievedAt,
          inputSha256: recordSha256,
          outputSha256,
        },
      ],
    };
    const lineage = {
      ...lineageCore,
      lineageSha256: hash(stableJson(lineageCore)),
    };
    const metadata = {
      id: entityId,
      version: 1,
      validFrom: record.sourceAsOfAt,
      validTo: null,
      recordedAt: record.retrievedAt,
      visibility: record.visibility,
      sourceIds: [record.sourceId],
      lineage: [lineage],
    };
    const entity =
      record.format === 'geotiff'
        ? {
            ...metadata,
            entityKind: 'elevation-raster-ref',
            artifactId: record.artifactId,
            bounds: record.bounds,
            horizontalResolutionMeters: degreesToApproximateMeters(
              record.resolutionDegrees[0],
              record.resolutionDegrees[1],
              (record.bounds[1] + record.bounds[3]) / 2,
            )[0],
            verticalDatum: record.verticalCrs,
            sourceAsOf: record.sourceAsOfAt,
          }
        : {
            ...metadata,
            entityKind: 'hydro-feature',
            name:
              typeof record.properties.gnisidlabel === 'string' &&
              record.properties.gnisidlabel.length > 0
                ? record.properties.gnisidlabel
                : null,
            featureType: featureType(record),
            geometry: record.geometry,
          };
    const runHash = hash(`${record.sourceId}|${record.snapshotId}|normalize-water-elevation`);
    yield canonicalMutationSchema.parse({
      kind: 'entity_upsert',
      mutationId: `sc:mutation:${hash(`${runHash}|${record.ordinal}|${entityId}`)}`,
      runId: `sc:run:${runHash}`,
      sourceId: record.sourceId,
      snapshotId: record.snapshotId,
      sequence: record.ordinal,
      emittedAt: record.retrievedAt,
      visibility: record.visibility,
      entity,
    });
  }

  public summarize(run: SourceRunObservation, context: SummaryContext): SourceRunSummary {
    context.signal.throwIfAborted();
    if (run.acceptedRecords + run.rejectedRecords !== run.decodedRecords) {
      throw new TypeError('Run accounting mismatch: accepted plus rejected must equal decoded');
    }
    const visibilityCounts = {
      public: run.mutations.filter((mutation) => mutation.visibility === 'public').length,
      authenticated: run.mutations.filter((mutation) => mutation.visibility === 'authenticated')
        .length,
      restricted: run.mutations.filter((mutation) => mutation.visibility === 'restricted').length,
      prohibited_public: run.mutations.filter(
        (mutation) => mutation.visibility === 'prohibited_public',
      ).length,
    };
    const errorCount = run.validationIssues.filter(
      (current) => current.severity !== 'warning',
    ).length;
    return sourceRunSummarySchema.parse({
      sourceId: run.descriptor.sourceId,
      snapshotId: run.plan.snapshotId,
      runId: run.runId,
      contractVersion: run.descriptor.contractVersion,
      status:
        run.aborted || run.rejectedRecords > 0 || errorCount > 0
          ? run.aborted
            ? 'aborted'
            : 'partial'
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
      warningCount: run.validationIssues.filter((current) => current.severity === 'warning').length,
      errorCount,
      finalCheckpoint: run.finalCheckpoint,
    });
  }
}

function featureType(
  record: WaterVectorDecodedRecord,
): 'lake' | 'other' | 'reservoir' | 'river' | 'shoreline' | 'stream' | 'wetland' {
  if (record.productKind === 'shoreline') {
    return 'shoreline';
  }
  const featureTypeLabel = record.properties.featuretypelabel;
  const gnisLabel = record.properties.gnisidlabel;
  const label =
    `${typeof featureTypeLabel === 'string' ? featureTypeLabel : ''} ${typeof gnisLabel === 'string' ? gnisLabel : ''}`.toLowerCase();
  if (label.includes('reservoir')) return 'reservoir';
  if (label.includes('lake') || label.includes('pond')) return 'lake';
  if (label.includes('river')) return 'river';
  if (label.includes('stream') || label.includes('canal') || label.includes('ditch'))
    return 'stream';
  if (label.includes('wetland') || label.includes('marsh')) return 'wetland';
  return 'other';
}

export function createNoaaUsgsWaterElevationAdapters(
  options: WaterElevationAdapterOptions = {},
): readonly SourceAdapter<WaterElevationDecodedRecord, WaterElevationValidatedRecord>[] {
  const products = options.products ?? WATER_ELEVATION_PRODUCTS;
  return Object.freeze(
    products.map(
      (product) =>
        new WaterElevationAdapter(product, {
          bounds: options.bounds ?? SANTA_CLARA_WATER_TERRAIN_BOUNDS,
          hydroPageSize: options.hydroPageSize ?? 2_000,
          elevationSize: options.elevationSize ?? Object.freeze([256, 256]),
        }),
    ),
  );
}

export function createNoaaCuspShorelineAdapter(
  options: WaterElevationAdapterOptions = {},
): SourceAdapter<WaterElevationDecodedRecord, WaterElevationValidatedRecord> {
  const [adapter] = createNoaaUsgsWaterElevationAdapters({
    ...options,
    products: [NOAA_CUSP_SHORELINE],
  });
  if (adapter === undefined) throw new Error('NOAA shoreline adapter construction failed');
  return adapter;
}

export function createUsgs3dhpHydrographyAdapter(
  options: WaterElevationAdapterOptions = {},
): SourceAdapter<WaterElevationDecodedRecord, WaterElevationValidatedRecord> {
  const [adapter] = createNoaaUsgsWaterElevationAdapters({
    ...options,
    products: [USGS_3DHP_HYDROGRAPHY],
  });
  if (adapter === undefined) throw new Error('USGS 3DHP adapter construction failed');
  return adapter;
}

export function createUsgs3depElevationAdapter(
  options: WaterElevationAdapterOptions = {},
): SourceAdapter<WaterElevationDecodedRecord, WaterElevationValidatedRecord> {
  const [adapter] = createNoaaUsgsWaterElevationAdapters({
    ...options,
    products: [USGS_3DEP_ELEVATION],
  });
  if (adapter === undefined) throw new Error('USGS 3DEP adapter construction failed');
  return adapter;
}
