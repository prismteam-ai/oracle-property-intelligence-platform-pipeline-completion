import { acquiredArtifactSchema, type AcquiredArtifact } from '@oracle/contracts/source';

import type { ArtifactByteRange, RecoverableArtifactStore } from '@oracle/artifacts/artifact-store';

import { createImmutableBytes, type ImmutableBytes } from './bytes.js';

export const LEGACY_WHOLE_COPY_MAX_BYTES = 1024 * 1024;
export const MAX_ANALYTICAL_SNAPSHOT_MANIFEST_BYTES = 1024 * 1024;
export const ANALYTICAL_SNAPSHOT_MANIFEST_MEDIA_TYPE =
  'application/vnd.oracle.analytical-snapshot-manifest+json;version=1';

export type AnalyticalSnapshotDataArtifact = Readonly<{
  uri: string;
  byteLength: number;
  sha256: string;
}>;

export type AnalyticalSnapshotManifestV1 = Readonly<{
  formatVersion: '1.0.0';
  dataArtifacts: readonly AnalyticalSnapshotDataArtifact[];
  scanBytesByOperation: Readonly<Record<string, number>>;
}>;

export type AnalyticalSnapshotReference = Readonly<{
  formatVersion: '1.0.0';
  manifestUri: string;
  manifestSha256: string;
  byteLength: number;
}>;

export type DurableAcquiredArtifactReference =
  | Readonly<{
      formatVersion: '1.0.0';
      metadata: AcquiredArtifact;
    }>
  | Readonly<{
      formatVersion: '2.0.0';
      metadata: AcquiredArtifact;
      analyticalSnapshot?: AnalyticalSnapshotReference;
    }>;

export type AcquiredArtifactReadOptions = Readonly<{
  range?: ArtifactByteRange;
  /** Hard upper bound for each yielded byte chunk. */
  maxChunkBytes?: number;
}>;

export interface StreamingArtifactContentV2 {
  readonly formatVersion: '2.0.0';
  readonly byteLength: number;
  readonly sha256: string;
  readonly rawUri: string;
  readonly analyticalSnapshot?: AnalyticalSnapshotReference;
  /** Opens a fresh, repeatable, integrity-checked bounded read on every call. */
  read(options?: AcquiredArtifactReadOptions): AsyncIterable<Uint8Array>;
}

export interface AcquiredByteArtifact {
  readonly metadata: AcquiredArtifact;
  readonly bytes: ImmutableBytes;
  readonly content?: undefined;
}

export interface StreamingAcquiredArtifact {
  readonly metadata: AcquiredArtifact;
  readonly content: StreamingArtifactContentV2;
  readonly bytes?: undefined;
}

export type AcquiredArtifactSource = AcquiredByteArtifact | StreamingAcquiredArtifact;

/** Constructs the only acquisition result accepted by decoders. */
export function createAcquiredByteArtifact(
  metadataInput: AcquiredArtifact,
  input: Uint8Array,
  maximumByteLength = LEGACY_WHOLE_COPY_MAX_BYTES,
): AcquiredByteArtifact {
  if (!Number.isSafeInteger(maximumByteLength) || maximumByteLength < 0) {
    throw new RangeError('Legacy whole-copy maximum must be a non-negative safe integer');
  }
  if (input.byteLength > maximumByteLength) {
    throw new LegacyWholeCopyLimitError(input.byteLength, maximumByteLength);
  }
  const metadata = acquiredArtifactSchema.parse(metadataInput);
  const bytes = createImmutableBytes(input);
  if (
    metadata.byteSize !== bytes.byteLength ||
    metadata.sha256 !== bytes.sha256 ||
    metadata.artifactId !== `sc:artifact:sha256:${bytes.sha256}`
  ) {
    throw new Error(`Acquired artifact integrity mismatch: ${metadata.artifactId}`);
  }

  return Object.freeze({ metadata, bytes });
}

export async function createStreamingAcquiredArtifact(
  metadataInput: AcquiredArtifact,
  store: RecoverableArtifactStore,
  options: Readonly<{
    analyticalManifestLogicalKey?: string;
    analyticalSnapshot?: AnalyticalSnapshotReference;
  }> = {},
): Promise<StreamingAcquiredArtifact> {
  const metadata = acquiredArtifactSchema.parse(metadataInput);
  const stored = await store.head(metadata.rawUri);
  if (stored?.byteSize !== metadata.byteSize) {
    throw new Error(`Acquired artifact store integrity mismatch: ${metadata.artifactId}`);
  }
  if (stored.sha256 !== metadata.sha256 || stored.mediaType !== metadata.mediaType) {
    throw new Error(`Acquired artifact store integrity mismatch: ${metadata.artifactId}`);
  }
  if (
    options.analyticalManifestLogicalKey !== undefined &&
    options.analyticalSnapshot !== undefined
  ) {
    throw new TypeError('Specify an analytical manifest logical key or reference, not both');
  }
  const analyticalSnapshot =
    options.analyticalManifestLogicalKey === undefined
      ? options.analyticalSnapshot === undefined
        ? undefined
        : await verifyAnalyticalSnapshotReference(store, options.analyticalSnapshot)
      : await resolveAnalyticalSnapshotReference(store, options.analyticalManifestLogicalKey);
  const content: StreamingArtifactContentV2 = Object.freeze({
    formatVersion: '2.0.0' as const,
    byteLength: metadata.byteSize,
    sha256: metadata.sha256,
    rawUri: metadata.rawUri,
    ...(analyticalSnapshot === undefined ? {} : { analyticalSnapshot }),
    read: (options = {}) => boundedRead(store, metadata.rawUri, metadata.byteSize, options),
  });
  return Object.freeze({ metadata, content });
}

export function durableAcquiredArtifactReference(
  artifact: AcquiredArtifactSource,
): DurableAcquiredArtifactReference {
  const metadata = acquiredArtifactSchema.parse(artifact.metadata);
  if (artifact.content === undefined) {
    return Object.freeze({ formatVersion: '1.0.0' as const, metadata });
  }
  return Object.freeze({
    formatVersion: '2.0.0' as const,
    metadata,
    ...(artifact.content.analyticalSnapshot === undefined
      ? {}
      : { analyticalSnapshot: artifact.content.analyticalSnapshot }),
  });
}

export async function openDurableAcquiredArtifactReference(
  reference: DurableAcquiredArtifactReference,
  store: RecoverableArtifactStore,
): Promise<StreamingAcquiredArtifact> {
  if (reference.formatVersion !== '2.0.0') {
    throw new TypeError('Legacy acquired-artifact references require the reviewed whole-copy path');
  }
  return createStreamingAcquiredArtifact(reference.metadata, store, {
    ...(reference.analyticalSnapshot === undefined
      ? {}
      : { analyticalSnapshot: reference.analyticalSnapshot }),
  });
}

export async function resolveAnalyticalSnapshotReference(
  store: RecoverableArtifactStore,
  logicalKey: string,
): Promise<AnalyticalSnapshotReference> {
  const stored = await store.headByLogicalKey(logicalKey);
  if (stored === undefined) {
    throw new Error(`Analytical snapshot manifest is missing: ${logicalKey}`);
  }
  if (stored.mediaType !== ANALYTICAL_SNAPSHOT_MANIFEST_MEDIA_TYPE) {
    throw new Error(`Analytical snapshot manifest media type is invalid: ${logicalKey}`);
  }
  if (stored.byteSize < 1 || stored.byteSize > MAX_ANALYTICAL_SNAPSHOT_MANIFEST_BYTES) {
    throw new LegacyWholeCopyLimitError(stored.byteSize, MAX_ANALYTICAL_SNAPSHOT_MANIFEST_BYTES);
  }
  return Object.freeze({
    formatVersion: '1.0.0' as const,
    manifestUri: stored.uri,
    manifestSha256: stored.sha256,
    byteLength: stored.byteSize,
  });
}

async function verifyAnalyticalSnapshotReference(
  store: RecoverableArtifactStore,
  reference: AnalyticalSnapshotReference,
): Promise<AnalyticalSnapshotReference> {
  const formatVersion: string = reference.formatVersion;
  if (
    formatVersion !== '1.0.0' ||
    !Number.isSafeInteger(reference.byteLength) ||
    reference.byteLength < 1 ||
    reference.byteLength > MAX_ANALYTICAL_SNAPSHOT_MANIFEST_BYTES ||
    !/^[0-9a-f]{64}$/.test(reference.manifestSha256)
  ) {
    throw new TypeError('Analytical snapshot reference is invalid');
  }
  const byUri = await store.head(reference.manifestUri);
  if (byUri === undefined) throw new Error('Analytical snapshot manifest is missing');
  const stored = await store.headByLogicalKey(byUri.logicalKey);
  if (
    stored?.uri !== reference.manifestUri ||
    stored.mediaType !== ANALYTICAL_SNAPSHOT_MANIFEST_MEDIA_TYPE ||
    stored.byteSize !== reference.byteLength ||
    stored.sha256 !== reference.manifestSha256
  ) {
    throw new Error('Analytical snapshot reference failed immutable verification');
  }
  return Object.freeze({ ...reference });
}

export function encodeAnalyticalSnapshotManifest(input: AnalyticalSnapshotManifestV1): Uint8Array {
  const manifest = parseAnalyticalSnapshotManifest(input);
  const canonical = {
    formatVersion: manifest.formatVersion,
    dataArtifacts: [...manifest.dataArtifacts]
      .sort((left, right) => left.uri.localeCompare(right.uri))
      .map((artifact) => ({
        uri: artifact.uri,
        byteLength: artifact.byteLength,
        sha256: artifact.sha256,
      })),
    scanBytesByOperation: Object.fromEntries(
      Object.entries(manifest.scanBytesByOperation).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
  const bytes = new TextEncoder().encode(`${JSON.stringify(canonical)}\n`);
  if (bytes.byteLength > MAX_ANALYTICAL_SNAPSHOT_MANIFEST_BYTES) {
    throw new LegacyWholeCopyLimitError(bytes.byteLength, MAX_ANALYTICAL_SNAPSHOT_MANIFEST_BYTES);
  }
  return bytes;
}

export function parseAnalyticalSnapshotManifest(input: unknown): AnalyticalSnapshotManifestV1 {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Analytical snapshot manifest must be an object');
  }
  const record = input as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !['formatVersion', 'dataArtifacts', 'scanBytesByOperation'].includes(key),
    ) ||
    record.formatVersion !== '1.0.0' ||
    !Array.isArray(record.dataArtifacts) ||
    record.scanBytesByOperation === null ||
    typeof record.scanBytesByOperation !== 'object' ||
    Array.isArray(record.scanBytesByOperation)
  ) {
    throw new TypeError('Analytical snapshot manifest v1 is invalid');
  }
  const artifacts = record.dataArtifacts.map((value) => parseAnalyticalDataArtifact(value));
  if (new Set(artifacts.map(({ uri }) => uri)).size !== artifacts.length) {
    throw new TypeError('Analytical snapshot manifest contains duplicate data artifacts');
  }
  const scanBytesByOperation: Record<string, number> = {};
  for (const [operation, byteLength] of Object.entries(
    record.scanBytesByOperation as Record<string, unknown>,
  )) {
    if (
      operation.trim().length === 0 ||
      !Number.isSafeInteger(byteLength) ||
      (byteLength as number) < 0
    ) {
      throw new TypeError('Analytical snapshot manifest scan budget is invalid');
    }
    scanBytesByOperation[operation] = byteLength as number;
  }
  return Object.freeze({
    formatVersion: '1.0.0' as const,
    dataArtifacts: Object.freeze(artifacts),
    scanBytesByOperation: Object.freeze(scanBytesByOperation),
  });
}

function parseAnalyticalDataArtifact(input: unknown): AnalyticalSnapshotDataArtifact {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Analytical snapshot data artifact must be an object');
  }
  const record = input as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !['uri', 'byteLength', 'sha256'].includes(key)) ||
    typeof record.uri !== 'string' ||
    record.uri.length === 0 ||
    !Number.isSafeInteger(record.byteLength) ||
    (record.byteLength as number) < 0 ||
    typeof record.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.sha256)
  ) {
    throw new TypeError('Analytical snapshot data artifact is invalid');
  }
  return Object.freeze({
    uri: record.uri,
    byteLength: record.byteLength as number,
    sha256: record.sha256,
  });
}

async function* boundedRead(
  store: RecoverableArtifactStore,
  uri: string,
  byteLength: number,
  options: AcquiredArtifactReadOptions,
): AsyncIterable<Uint8Array> {
  const maximum = options.maxChunkBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new RangeError('maxChunkBytes must be a positive safe integer');
  }
  if (options.range !== undefined && options.range.endInclusive >= byteLength) {
    throw new RangeError('Acquired artifact range exceeds content length');
  }
  for await (const chunk of store.read(uri, options.range)) {
    for (let offset = 0; offset < chunk.byteLength; offset += maximum) {
      yield chunk.slice(offset, Math.min(offset + maximum, chunk.byteLength));
    }
  }
}

export class LegacyWholeCopyLimitError extends Error {
  public readonly code = 'LEGACY_WHOLE_COPY_LIMIT';

  public constructor(
    public readonly byteLength: number,
    public readonly maximumByteLength: number,
  ) {
    super(
      `Legacy whole-copy artifact is ${byteLength} bytes; maximum is ${maximumByteLength}. Use streaming acquired-artifact contract 2.0.0.`,
    );
    this.name = 'LegacyWholeCopyLimitError';
  }
}
