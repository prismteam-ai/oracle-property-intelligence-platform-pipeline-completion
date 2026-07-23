import { describe, expect, it } from 'vitest';

import {
  acquiredArtifactSchema,
  acquisitionPlanSchema,
  sourceCheckpointSchema,
  sourceDescriptorSchema,
  sourceRunSummarySchema,
  validationReportSchema,
} from './source.js';

const hash = 'a'.repeat(64);
const otherHash = 'b'.repeat(64);
const sourceId = 'sc:source:scc-parcels';
const snapshotId = `sc:snapshot:scc-parcels:${hash}`;
const artifactId = `sc:artifact:sha256:${hash}`;
const at = '2026-07-17T00:00:00.000Z';

const schemaFingerprint = {
  algorithm: 'sha256',
  value: otherHash,
  schemaName: 'scc-parcels-csv',
  canonicalizationVersion: '1.0.0',
};

const license = {
  licenseSnapshotId: `sc:license:scc-parcels:${hash}`,
  capturedAt: at,
  title: 'County terms snapshot',
  canonicalUrl: 'https://data.sccgov.org/terms',
  termsSha256: hash,
  redistribution: 'unknown',
  containsPersonalData: false,
  attribution: ['County of Santa Clara'],
  limitations: ['Redistribution review pending'],
};

describe('source contracts', () => {
  it('parses a strict source descriptor with authority, legal, and rate policy', () => {
    expect(
      sourceDescriptorSchema.parse({
        sourceId,
        contractVersion: '1.0.0',
        name: 'Santa Clara County Parcels',
        authority: {
          authorityType: 'official_government',
          organization: 'County of Santa Clara',
          jurisdiction: 'Santa Clara County, CA',
          canonicalUrl: 'https://data.sccgov.org/',
          authorityRank: 100,
        },
        acquisitionMethod: 'bulk_download',
        encodings: ['csv'],
        entityKinds: ['property'],
        defaultVisibility: 'restricted',
        license,
        ratePolicy: {
          maxRequestsPerWindow: 100,
          windowMs: 1_000,
          maxConcurrency: 4,
          maxAttempts: 6,
          initialBackoffMs: 100,
          maxBackoffMs: 10_000,
          jitter: 'full',
          respectRetryAfter: true,
        },
        freshnessSemantics: 'Dataset modification timestamp',
      }).sourceId,
    ).toBe(sourceId);
  });

  it('requires complete immutable acquisition metadata and rejects raw credentials', () => {
    const artifact = {
      artifactId,
      sourceId,
      snapshotId,
      retrievedAt: at,
      sourceAsOf: { state: 'unknown', reason: 'Source does not publish an as-of time' },
      request: {
        requestKey: 'page-0001',
        method: 'GET',
        url: 'https://data.sccgov.org/download/parcels.csv',
        headers: [{ name: 'accept', valueSha256: hash }],
        bodySha256: null,
        attempt: 1,
      },
      response: {
        httpStatus: 200,
        etag: 'etag-1',
        lastModified: at,
        finalUrl: 'https://data.sccgov.org/download/parcels.csv',
      },
      mediaType: 'text/csv',
      encoding: 'csv',
      byteSize: 1_024,
      sha256: hash,
      schemaFingerprint,
      rawUri: `s3://oracle-raw/${hash}.csv`,
      licenseSnapshotRef: `sc:license:scc-parcels:${hash}`,
      visibility: 'restricted',
    };

    expect(acquiredArtifactSchema.parse(artifact).byteSize).toBe(1_024);
    expect(
      acquiredArtifactSchema.safeParse({
        ...artifact,
        request: {
          ...artifact.request,
          headers: [{ name: 'authorization', valueSha256: hash, value: 'Bearer secret' }],
        },
      }).success,
    ).toBe(false);
    expect(acquiredArtifactSchema.safeParse({ ...artifact, sha256: otherHash }).success).toBe(
      false,
    );
    expect(
      acquiredArtifactSchema.safeParse({
        ...artifact,
        snapshotId: `sc:snapshot:other-source:${hash}`,
      }).success,
    ).toBe(false);
    const withoutLicense = Object.fromEntries(
      Object.entries(artifact).filter(([key]) => key !== 'licenseSnapshotRef'),
    );
    expect(acquiredArtifactSchema.safeParse(withoutLicense).success).toBe(false);
  });

  it('rejects validation and run summaries whose accounting does not balance', () => {
    expect(
      validationReportSchema.safeParse({
        artifactId,
        schemaFingerprint,
        status: 'valid',
        decodedRecords: 10,
        acceptedRecords: 8,
        rejectedRecords: 1,
        issues: [],
        validatedAt: at,
      }).success,
    ).toBe(false);

    expect(
      sourceRunSummarySchema.safeParse({
        sourceId,
        snapshotId,
        runId: `sc:run:${hash}`,
        contractVersion: '1.0.0',
        status: 'succeeded',
        startedAt: at,
        completedAt: at,
        artifactsAcquired: 1,
        bytesAcquired: 1_024,
        decodedRecords: 10,
        acceptedRecords: 9,
        rejectedRecords: 1,
        normalizedMutations: 9,
        visibilityCounts: {
          public: 8,
          authenticated: 0,
          restricted: 0,
          prohibited_public: 0,
        },
        warningCount: 0,
        errorCount: 0,
        finalCheckpoint: {
          sourceId,
          snapshotId,
          contractVersion: '1.0.0',
          cursor: 'done',
          nextSequence: 1,
          completedRequestKeys: ['page-0001'],
          acquiredArtifactIds: [artifactId],
          updatedAt: at,
          complete: true,
        },
      }).success,
    ).toBe(false);
  });

  it('rejects acquisition and checkpoint collisions while accepting unique progress', () => {
    const checkpoint = {
      sourceId,
      snapshotId,
      contractVersion: '1.0.0',
      cursor: 'page-2',
      nextSequence: 2,
      completedRequestKeys: ['page-0001'],
      acquiredArtifactIds: [artifactId],
      updatedAt: at,
      complete: false,
    };
    expect(sourceCheckpointSchema.parse(checkpoint).nextSequence).toBe(2);
    expect(
      sourceCheckpointSchema.safeParse({
        ...checkpoint,
        completedRequestKeys: ['page-0001', 'page-0001'],
      }).success,
    ).toBe(false);
    expect(
      sourceCheckpointSchema.safeParse({
        ...checkpoint,
        acquiredArtifactIds: [artifactId, artifactId],
      }).success,
    ).toBe(false);

    const plan = {
      sourceId,
      snapshotId,
      contractVersion: '1.0.0',
      plannedAt: at,
      items: [
        {
          requestKey: 'page-0001',
          sequence: 0,
          method: 'GET',
          url: 'https://data.sccgov.org/download/parcels-1.csv',
          encoding: 'csv',
          expectedMediaTypes: ['text/csv'],
        },
        {
          requestKey: 'page-0002',
          sequence: 1,
          method: 'GET',
          url: 'https://data.sccgov.org/download/parcels-2.csv',
          encoding: 'csv',
          expectedMediaTypes: ['text/csv'],
        },
      ],
    };
    expect(acquisitionPlanSchema.parse(plan).items).toHaveLength(2);
    expect(
      acquisitionPlanSchema.safeParse({
        ...plan,
        items: [plan.items[0], { ...plan.items[1], sequence: 0 }],
      }).success,
    ).toBe(false);
  });
});
