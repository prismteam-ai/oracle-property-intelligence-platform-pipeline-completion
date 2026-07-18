import { sha256Schema } from '@oracle/contracts/foundation';

export type ArtifactMetadata = Readonly<Record<string, string>>;

export type ArtifactBody = Uint8Array | AsyncIterable<Uint8Array>;

export type ArtifactByteRange = Readonly<{
  start: number;
  endInclusive: number;
}>;

export type ImmutableArtifactWrite = Readonly<{
  logicalKey: string;
  mediaType: string;
  body: ArtifactBody;
  expectedSha256: string;
  metadata: ArtifactMetadata;
  ifAbsent: true;
}>;

export type StoredArtifact = Readonly<{
  logicalKey: string;
  uri: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  storedAt: string;
  metadata: ArtifactMetadata;
}>;

export interface ArtifactStore {
  putImmutable(request: ImmutableArtifactWrite): Promise<StoredArtifact>;
  head(uri: string): Promise<StoredArtifact | undefined>;
  read(uri: string, range?: ArtifactByteRange): AsyncIterable<Uint8Array>;
}

export type StreamingImmutableArtifactWrite = Omit<ImmutableArtifactWrite, 'expectedSha256'> &
  Readonly<{ expectedSha256?: string }>;

export interface RecoverableArtifactStore extends ArtifactStore {
  putImmutableStreaming(request: StreamingImmutableArtifactWrite): Promise<StoredArtifact>;
  /**
   * Resolves the canonical immutable object for a confined logical key. Implementations verify
   * persisted metadata and the complete body hash before returning, so callers may safely adopt a
   * byte-identical write-before-checkpoint orphan without weakening putImmutable conflicts.
   */
  headByLogicalKey(logicalKey: string): Promise<StoredArtifact | undefined>;
}

export function assertSha256(value: string): asserts value is string {
  sha256Schema.parse(value);
}

export function assertArtifactByteRange(range: ArtifactByteRange): void {
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.endInclusive) ||
    range.start < 0 ||
    range.endInclusive < range.start
  ) {
    throw new RangeError('Artifact byte range must be safe, non-negative, and ordered');
  }
}

export function assertStoredArtifactIntegrity(
  expected: Pick<StoredArtifact, 'logicalKey' | 'mediaType' | 'byteSize' | 'sha256'>,
  actual: StoredArtifact,
): void {
  assertSha256(expected.sha256);
  assertSha256(actual.sha256);

  if (
    actual.logicalKey !== expected.logicalKey ||
    actual.mediaType !== expected.mediaType ||
    actual.byteSize !== expected.byteSize ||
    actual.sha256 !== expected.sha256
  ) {
    throw new Error(`Immutable artifact integrity mismatch for ${expected.logicalKey}`);
  }
}
