import { createHash, timingSafeEqual } from 'node:crypto';

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * A byte value whose backing buffer never escapes. Every read returns a copy,
 * so an acquired source artifact cannot be mutated by a decoder.
 */
export interface ImmutableBytes {
  readonly byteLength: number;
  readonly sha256: string;
  copy(): Uint8Array;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function createImmutableBytes(input: Uint8Array): ImmutableBytes {
  const stored = Uint8Array.from(input);
  const sha256 = sha256Hex(stored);

  return Object.freeze({
    byteLength: stored.byteLength,
    sha256,
    copy: (): Uint8Array => Uint8Array.from(stored),
  });
}

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX_PATTERN.test(value);
}

export function verifyImmutableBytes(
  bytes: ImmutableBytes,
  expected: Readonly<{ byteSize: number; sha256: string }>,
): boolean {
  if (bytes.byteLength !== expected.byteSize || !isSha256Hex(expected.sha256)) {
    return false;
  }

  const actualDigest = Buffer.from(bytes.sha256, 'hex');
  const expectedDigest = Buffer.from(expected.sha256, 'hex');
  return (
    actualDigest.byteLength === expectedDigest.byteLength &&
    timingSafeEqual(actualDigest, expectedDigest)
  );
}
