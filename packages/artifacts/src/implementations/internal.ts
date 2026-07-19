import { createHash } from 'node:crypto';
import { rename } from 'node:fs/promises';

import {
  AtomicPromotionExhaustedError,
  type ArtifactBody,
  type ArtifactMetadata,
} from '../artifact-store.js';

const WINDOWS_PROMOTION_ATTEMPTS = 8;
const WINDOWS_PROMOTION_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

type AtomicPromotionOptions = Readonly<{
  platform?: NodeJS.Platform;
  attempts?: number;
  rename?: (source: string, target: string) => Promise<void>;
  delay?: (milliseconds: number) => Promise<void>;
  retryAllowed?: (error: unknown, attempt: number) => boolean | Promise<boolean>;
}>;

export async function promoteAtomically(
  source: string,
  target: string,
  options: AtomicPromotionOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? WINDOWS_PROMOTION_ATTEMPTS;
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new RangeError('Atomic promotion attempts must be a positive safe integer');
  }
  const renamePath = options.rename ?? rename;
  const delay = options.delay ?? wait;
  const platform = options.platform ?? process.platform;

  for (let attempt = 1; ; attempt += 1) {
    try {
      await renamePath(source, target);
      return;
    } catch (error) {
      const code = errorCode(error);
      const transientWindowsFailure =
        platform === 'win32' && WINDOWS_PROMOTION_RETRY_CODES.has(code ?? '');
      if (!transientWindowsFailure) {
        throw error;
      }
      if (options.retryAllowed !== undefined && !(await options.retryAllowed(error, attempt))) {
        throw error;
      }
      if (attempt >= attempts) {
        throw new AtomicPromotionExhaustedError(attempts, code ?? 'UNKNOWN', error);
      }
      await delay(25 * attempt);
    }
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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
