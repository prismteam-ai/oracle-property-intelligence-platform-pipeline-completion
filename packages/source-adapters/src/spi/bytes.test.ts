import { describe, expect, it } from 'vitest';

import { createImmutableBytes, isSha256Hex, sha256Hex, verifyImmutableBytes } from './bytes.js';

describe('immutable byte artifacts', () => {
  it('copies both input and output buffers and verifies integrity', () => {
    const input = new TextEncoder().encode('santa-clara');
    const bytes = createImmutableBytes(input);
    input[0] = 0;

    const firstRead = bytes.copy();
    firstRead[0] = 0;

    expect(new TextDecoder().decode(bytes.copy())).toBe('santa-clara');
    expect(bytes.sha256).toBe(sha256Hex(new TextEncoder().encode('santa-clara')));
    expect(
      verifyImmutableBytes(bytes, {
        byteSize: bytes.byteLength,
        sha256: bytes.sha256,
      }),
    ).toBe(true);
  });

  it('rejects malformed digests, size changes, and digest changes', () => {
    const bytes = createImmutableBytes(new Uint8Array([1, 2, 3]));
    expect(isSha256Hex(bytes.sha256)).toBe(true);
    expect(verifyImmutableBytes(bytes, { byteSize: 4, sha256: bytes.sha256 })).toBe(false);
    expect(verifyImmutableBytes(bytes, { byteSize: 3, sha256: 'not-a-digest' })).toBe(false);
    expect(verifyImmutableBytes(bytes, { byteSize: 3, sha256: '0'.repeat(64) })).toBe(false);
  });
});
