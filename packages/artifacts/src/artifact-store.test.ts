import { describe, expect, it } from 'vitest';

import {
  assertArtifactByteRange,
  assertSha256,
  assertStoredArtifactIntegrity,
  type StoredArtifact,
} from './artifact-store.js';

const digest = 'a'.repeat(64);

const stored: StoredArtifact = Object.freeze({
  logicalKey: 'raw/santa-clara/parcel/source.csv',
  uri: 's3://oracle-artifacts/raw/santa-clara/parcel/source.csv',
  mediaType: 'text/csv',
  byteSize: 42,
  sha256: digest,
  storedAt: '2026-07-17T00:00:00.000Z',
  metadata: Object.freeze({ source: 'santa-clara-parcels' }),
});

describe('artifact store boundary', () => {
  it('accepts exact immutable artifact identity and byte ranges', () => {
    expect(() => assertSha256(digest)).not.toThrow();
    expect(() => assertArtifactByteRange({ start: 0, endInclusive: 3 })).not.toThrow();
    expect(() => assertStoredArtifactIntegrity(stored, stored)).not.toThrow();
  });

  it('rejects malformed digests, ranges, and changed bytes', () => {
    expect(() => assertSha256('ABC')).toThrow(/SHA-256/u);
    expect(() => assertArtifactByteRange({ start: 4, endInclusive: 3 })).toThrow(/ordered/u);
    expect(() =>
      assertStoredArtifactIntegrity(stored, { ...stored, sha256: 'b'.repeat(64) }),
    ).toThrow(/integrity mismatch/u);
  });
});
