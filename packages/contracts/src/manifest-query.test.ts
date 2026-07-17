import { describe, expect, it } from 'vitest';

import { evidenceSourceReferenceSchema } from './evidence.js';
import { artifactManifestEntrySchema, publicationEligibilitySchema } from './manifest.js';
import { namedQueryRequestSchema, namedQueryResultSchema } from './query.js';

const hash = 'a'.repeat(64);
const otherHash = 'b'.repeat(64);
const at = '2026-07-17T00:00:00.000Z';

const fingerprint = {
  algorithm: 'sha256',
  value: otherHash,
  schemaName: 'property-search',
  canonicalizationVersion: '1.0.0',
};

describe('evidence source integrity', () => {
  const reference = {
    sourceId: 'sc:source:scc-parcels',
    snapshotId: `sc:snapshot:scc-parcels:${hash}`,
    artifactId: `sc:artifact:sha256:${hash}`,
    recordKey: 'row-1',
    fieldPaths: ['/apn'],
  };

  it('accepts coherent source snapshots and rejects cross-source references', () => {
    expect(evidenceSourceReferenceSchema.parse(reference).sourceId).toBe(reference.sourceId);
    expect(
      evidenceSourceReferenceSchema.safeParse({
        ...reference,
        snapshotId: `sc:snapshot:other-source:${hash}`,
      }).success,
    ).toBe(false);
  });
});

describe('publication eligibility', () => {
  it('accepts only scanned, rights-approved, non-personal public bytes as eligible', () => {
    expect(
      publicationEligibilitySchema.parse({
        state: 'eligible',
        visibility: 'public',
        rights: 'approved',
        scanPassed: true,
        containsPersonalData: false,
        rightsReference: 'legal-review-1',
        scannerVersion: '1.0.0',
      }).state,
    ).toBe('eligible');
  });

  it.each([
    { visibility: 'prohibited_public' },
    { rights: 'restricted' },
    { scanPassed: false },
    { containsPersonalData: true },
  ])('rejects invalid publication eligibility override %o', (override) => {
    expect(
      publicationEligibilitySchema.safeParse({
        state: 'eligible',
        visibility: 'public',
        rights: 'approved',
        scanPassed: true,
        containsPersonalData: false,
        rightsReference: 'legal-review-1',
        scannerVersion: '1.0.0',
        ...override,
      }).success,
    ).toBe(false);
  });

  it('forbids a prohibited-public artifact from carrying public eligibility', () => {
    expect(
      artifactManifestEntrySchema.safeParse({
        artifactId: `sc:artifact:sha256:${hash}`,
        artifactType: 'query_mart',
        uri: `ipfs://bafy${hash}`,
        mirrorUri: `s3://oracle-public/${hash}.parquet`,
        cid: `bafy${hash}`,
        mediaType: 'application/vnd.apache.parquet',
        byteSize: 1_024,
        sha256: hash,
        rowCount: 10,
        schemaFingerprint: fingerprint,
        sourceIds: ['sc:source:scc-parcels'],
        visibility: 'prohibited_public',
        publicationEligibility: {
          state: 'eligible',
          visibility: 'public',
          rights: 'approved',
          scanPassed: true,
          containsPersonalData: false,
          rightsReference: 'human-override-must-not-work',
          scannerVersion: '1.0.0',
        },
      }).success,
    ).toBe(false);
  });
});

describe('named query contracts', () => {
  it('binds requests and results to an immutable release manifest', () => {
    const manifestId = `sc:manifest:${hash}`;
    expect(
      namedQueryRequestSchema.parse({
        query: 'find_roof_age_candidates',
        releaseManifestId: manifestId,
        parameters: { minimumAgeYears: 15 },
        page: { limit: 100, cursor: null },
      }).releaseManifestId,
    ).toBe(manifestId);

    expect(
      namedQueryResultSchema.parse({
        query: 'find_roof_age_candidates',
        releaseManifestId: manifestId,
        status: 'complete',
        generatedAt: at,
        items: [{ propertyId: 'sc:entity:property:apn-123' }],
        evidenceIds: [`sc:evidence:${hash}`],
        coverage: [],
        limitations: [],
        nextCursor: null,
      }).items,
    ).toHaveLength(1);
  });

  it('rejects arbitrary SQL authority and unknown query names', () => {
    expect(
      namedQueryRequestSchema.safeParse({
        query: 'query_sql',
        releaseManifestId: `sc:manifest:${hash}`,
        parameters: { sql: "select * from read_csv_auto('https://example.com')" },
        page: { limit: 100, cursor: null },
      }).success,
    ).toBe(false);
  });
});
