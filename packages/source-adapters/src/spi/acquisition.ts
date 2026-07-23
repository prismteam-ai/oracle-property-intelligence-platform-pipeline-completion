import type {
  ArtifactMetadata,
  RecoverableArtifactStore,
  StoredArtifact,
} from '@oracle/artifacts/artifact-store';

export async function persistAcquiredBody(
  input: Readonly<{
    store: RecoverableArtifactStore;
    logicalKey: string;
    mediaType: string;
    body: AsyncIterable<Uint8Array>;
    maximumBytes: number;
    expectedSha256?: string;
    metadata: ArtifactMetadata;
    signal: AbortSignal;
  }>,
): Promise<StoredArtifact> {
  if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1) {
    throw new RangeError('maximumBytes must be a positive safe integer');
  }
  return input.store.putImmutableStreaming({
    logicalKey: input.logicalKey,
    mediaType: input.mediaType,
    body: enforceMaximum(input.body, input.maximumBytes, input.signal),
    ...(input.expectedSha256 === undefined ? {} : { expectedSha256: input.expectedSha256 }),
    metadata: input.metadata,
    ifAbsent: true,
  });
}

async function* enforceMaximum(
  body: AsyncIterable<Uint8Array>,
  maximumBytes: number,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  let received = 0;
  for await (const chunk of body) {
    signal.throwIfAborted();
    if (!(chunk instanceof Uint8Array)) throw new TypeError('HTTP body yielded a non-byte chunk');
    received += chunk.byteLength;
    if (!Number.isSafeInteger(received) || received > maximumBytes) {
      throw new AcquisitionByteLimitError(received, maximumBytes);
    }
    yield chunk;
  }
}

export class AcquisitionByteLimitError extends Error {
  public readonly code = 'ACQUISITION_BYTE_LIMIT';

  public constructor(
    public readonly receivedBytes: number,
    public readonly maximumBytes: number,
  ) {
    super(`Acquired response exceeded ${maximumBytes} bytes`);
    this.name = 'AcquisitionByteLimitError';
  }
}
