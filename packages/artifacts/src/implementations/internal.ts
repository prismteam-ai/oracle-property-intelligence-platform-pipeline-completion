import { createHash } from 'node:crypto';

import type { ArtifactBody, ArtifactMetadata } from '../artifact-store.js';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError('Value is not canonical JSON');
}

export function assertLogicalKey(logicalKey: string): void {
  if (
    logicalKey.length === 0 ||
    logicalKey.startsWith('/') ||
    logicalKey.includes('\\') ||
    logicalKey.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new TypeError('Artifact logicalKey must be a safe relative POSIX path');
  }
}

export function cloneMetadata(metadata: ArtifactMetadata): ArtifactMetadata {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(metadata)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => {
          if (key.length === 0 || typeof value !== 'string') {
            throw new TypeError('Artifact metadata must contain non-empty string keys and values');
          }
          return [key, value];
        }),
    ),
  );
}

export async function consumeBody(
  body: ArtifactBody,
  consume: (chunk: Uint8Array) => Promise<void>,
): Promise<{ byteSize: number; sha256: string }> {
  const hash = createHash('sha256');
  let byteSize = 0;
  const chunks: AsyncIterable<Uint8Array> = body instanceof Uint8Array ? singleChunk(body) : body;

  for await (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array))
      throw new TypeError('Artifact body yielded a non-byte chunk');
    byteSize += chunk.byteLength;
    if (!Number.isSafeInteger(byteSize))
      throw new RangeError('Artifact byte size exceeds safe integer');
    hash.update(chunk);
    await consume(chunk);
  }
  return { byteSize, sha256: hash.digest('hex') };
}

async function* singleChunk(body: Uint8Array): AsyncIterable<Uint8Array> {
  yield await Promise.resolve(body);
}

export class ImmutableArtifactConflictError extends Error {
  public constructor(public readonly logicalKey: string) {
    super(`Immutable artifact already exists: ${logicalKey}`);
    this.name = 'ImmutableArtifactConflictError';
  }
}

export class ArtifactIntegrityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ArtifactIntegrityError';
  }
}
