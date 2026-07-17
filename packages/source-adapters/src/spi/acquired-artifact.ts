import { acquiredArtifactSchema, type AcquiredArtifact } from '@oracle/contracts/source';

import { createImmutableBytes, type ImmutableBytes } from './bytes.js';

export interface AcquiredByteArtifact {
  readonly metadata: AcquiredArtifact;
  readonly bytes: ImmutableBytes;
}

/** Constructs the only acquisition result accepted by decoders. */
export function createAcquiredByteArtifact(
  metadataInput: AcquiredArtifact,
  input: Uint8Array,
): AcquiredByteArtifact {
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
