import { acquiredArtifactSchema } from '@oracle/contracts/source';
import { describe, expect, it } from 'vitest';

import { createAcquiredByteArtifact } from './acquired-artifact.js';
import { createImmutableBytes } from './bytes.js';

const HASH = 'b'.repeat(64);
const SOURCE_BYTES = new TextEncoder().encode('apn,address\n123,Main St\n');

function metadata(bytes: Uint8Array) {
  const immutable = createImmutableBytes(bytes);
  return acquiredArtifactSchema.parse({
    artifactId: `sc:artifact:sha256:${immutable.sha256}`,
    sourceId: 'sc:source:test-parcels',
    snapshotId: `sc:snapshot:test-parcels:${HASH}`,
    retrievedAt: '2026-07-17T09:01:00.000Z',
    sourceAsOf: { state: 'reported', at: '2026-07-16T00:00:00.000Z' },
    request: {
      requestKey: 'page-1',
      method: 'GET',
      url: 'https://data.sccgov.org/page-1.csv',
      headers: [{ name: 'accept', valueSha256: HASH }],
      bodySha256: null,
      attempt: 1,
    },
    response: {
      httpStatus: 200,
      etag: '"fixture"',
      lastModified: '2026-07-16T00:00:00.000Z',
      finalUrl: 'https://data.sccgov.org/page-1.csv',
    },
    mediaType: 'text/csv',
    encoding: 'csv',
    byteSize: immutable.byteLength,
    sha256: immutable.sha256,
    schemaFingerprint: {
      algorithm: 'sha256',
      value: HASH,
      schemaName: 'test-parcels',
      canonicalizationVersion: '1.0.0',
    },
    rawUri: `s3://oracle-raw/${immutable.sha256}`,
    licenseSnapshotRef: `sc:license:test-parcels:${HASH}`,
    visibility: 'public',
  });
}

describe('acquired byte artifact boundary', () => {
  it('binds complete acquisition metadata to immutable bytes', () => {
    const artifact = createAcquiredByteArtifact(metadata(SOURCE_BYTES), SOURCE_BYTES);
    expect(artifact.metadata.request.method).toBe('GET');
    expect(artifact.metadata.response).toMatchObject({ httpStatus: 200, etag: '"fixture"' });
    expect(artifact.metadata).toMatchObject({
      mediaType: 'text/csv',
      byteSize: SOURCE_BYTES.byteLength,
      visibility: 'public',
    });
    expect(artifact.bytes.sha256).toBe(artifact.metadata.sha256);
  });

  it('rejects content changes even when metadata remains schema-valid', () => {
    const changed = new TextEncoder().encode('changed');
    expect(() => createAcquiredByteArtifact(metadata(SOURCE_BYTES), changed)).toThrow(
      'integrity mismatch',
    );
  });
});
