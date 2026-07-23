import { acquiredArtifactSchema } from '@oracle/contracts/source';
import { describe, expect, it } from 'vitest';

import type { RecoverableArtifactStore } from '@oracle/artifacts/artifact-store';

import {
  ANALYTICAL_SNAPSHOT_MANIFEST_MEDIA_TYPE,
  encodeAnalyticalSnapshotManifest,
  createAcquiredByteArtifact,
  createStreamingAcquiredArtifact,
  LegacyWholeCopyLimitError,
  parseAnalyticalSnapshotManifest,
  resolveAnalyticalSnapshotReference,
} from './acquired-artifact.js';
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

  it('rejects legacy whole-copy artifacts above the reviewed fixture bound', () => {
    expect(() => createAcquiredByteArtifact(metadata(SOURCE_BYTES), SOURCE_BYTES, 1)).toThrow(
      LegacyWholeCopyLimitError,
    );
  });

  it('opens repeatable bounded streaming reads after verifying stored metadata', async () => {
    const artifactMetadata = metadata(SOURCE_BYTES);
    const store = {
      head: () =>
        Promise.resolve({
          logicalKey: 'raw/source',
          uri: artifactMetadata.rawUri,
          mediaType: artifactMetadata.mediaType,
          byteSize: artifactMetadata.byteSize,
          sha256: artifactMetadata.sha256,
          storedAt: artifactMetadata.retrievedAt,
          metadata: {},
        }),
      read: async function* () {
        yield await Promise.resolve(SOURCE_BYTES);
      },
    } as unknown as RecoverableArtifactStore;
    const artifact = await createStreamingAcquiredArtifact(artifactMetadata, store);
    const collect = async () => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of artifact.content.read({ maxChunkBytes: 3 })) chunks.push(chunk);
      return Buffer.concat(chunks);
    };
    expect((await collect()).equals(SOURCE_BYTES)).toBe(true);
    expect((await collect()).equals(SOURCE_BYTES)).toBe(true);
    const lengths: number[] = [];
    for await (const chunk of artifact.content.read({ maxChunkBytes: 3 })) {
      lengths.push(chunk.byteLength);
    }
    expect(Math.max(...lengths)).toBeLessThanOrEqual(3);
  });

  it('encodes and strictly validates tiny analytical snapshot manifests', () => {
    const bytes = encodeAnalyticalSnapshotManifest({
      formatVersion: '1.0.0',
      dataArtifacts: [
        { uri: 'file:///raw/data.parquet', byteLength: 775_000_000, sha256: '1'.repeat(64) },
      ],
      scanBytesByOperation: {
        decode_gtfs_bounded_finalize: 12_000_000,
        decode_overture_santa_clara_starbucks_candidates: 775_000_000,
      },
    });
    const manifest = parseAnalyticalSnapshotManifest(JSON.parse(new TextDecoder().decode(bytes)));
    expect(manifest.dataArtifacts[0]?.byteLength).toBe(775_000_000);
    expect(ANALYTICAL_SNAPSHOT_MANIFEST_MEDIA_TYPE).toContain('version=1');
    expect(() =>
      parseAnalyticalSnapshotManifest({
        ...manifest,
        unexpected: true,
      }),
    ).toThrow('invalid');
  });

  it('resolves only a verified, bounded derived analytical manifest by logical key', async () => {
    const stored = {
      logicalKey: 'derived/source/analytical-manifest.json',
      uri: 'file:///derived/analytical-manifest.json',
      mediaType: ANALYTICAL_SNAPSHOT_MANIFEST_MEDIA_TYPE,
      byteSize: 128,
      sha256: '2'.repeat(64),
      storedAt: '2026-07-18T00:00:00.000Z',
      metadata: {},
    };
    const store = {
      headByLogicalKey: () => Promise.resolve(stored),
    } as unknown as RecoverableArtifactStore;
    await expect(resolveAnalyticalSnapshotReference(store, stored.logicalKey)).resolves.toEqual({
      formatVersion: '1.0.0',
      manifestUri: stored.uri,
      manifestSha256: stored.sha256,
      byteLength: stored.byteSize,
    });
    const oversized = {
      ...store,
      headByLogicalKey: () => Promise.resolve({ ...stored, byteSize: 1024 * 1024 + 1 }),
    } as unknown as RecoverableArtifactStore;
    await expect(
      resolveAnalyticalSnapshotReference(oversized, stored.logicalKey),
    ).rejects.toBeInstanceOf(LegacyWholeCopyLimitError);
  });
});
