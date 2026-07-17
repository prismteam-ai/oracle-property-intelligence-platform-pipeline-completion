import { z } from 'zod';

import {
  isoDateTimeSchema,
  nonEmptyStringSchema,
  semverSchema,
  sha256Schema,
} from './foundation.js';
import {
  artifactIdSchema,
  licenseSnapshotIdSchema,
  runIdSchema,
  schemaFingerprintValueSchema,
  snapshotBelongsToSource,
  snapshotIdSchema,
  sourceIdSchema,
} from './ids.js';
import { visibilityCountsSchema, visibilitySchema } from './visibility.js';

export const sourceAuthoritySchema = z.strictObject({
  authorityType: z.enum([
    'official_government',
    'existing_elephant',
    'recognized_distributor',
    'licensed_commercial',
  ]),
  organization: nonEmptyStringSchema,
  jurisdiction: nonEmptyStringSchema,
  canonicalUrl: z.url(),
  authorityRank: z.number().int().min(1).max(100),
});

export type SourceAuthority = z.infer<typeof sourceAuthoritySchema>;

export const licenseSnapshotSchema = z.strictObject({
  licenseSnapshotId: licenseSnapshotIdSchema,
  capturedAt: isoDateTimeSchema,
  title: nonEmptyStringSchema,
  canonicalUrl: z.url().nullable(),
  termsSha256: sha256Schema,
  redistribution: z.enum(['approved', 'restricted', 'prohibited', 'unknown']),
  containsPersonalData: z.boolean(),
  attribution: z.array(nonEmptyStringSchema),
  limitations: z.array(nonEmptyStringSchema),
});

export type LicenseSnapshot = z.infer<typeof licenseSnapshotSchema>;

export const ratePolicySchema = z
  .strictObject({
    maxRequestsPerWindow: z.number().int().positive(),
    windowMs: z.number().int().positive(),
    maxConcurrency: z.number().int().positive(),
    maxAttempts: z.number().int().min(1).max(20),
    initialBackoffMs: z.number().int().nonnegative(),
    maxBackoffMs: z.number().int().positive(),
    jitter: z.enum(['none', 'full']),
    respectRetryAfter: z.boolean(),
  })
  .refine((policy) => policy.maxBackoffMs >= policy.initialBackoffMs, {
    message: 'maxBackoffMs must be at least initialBackoffMs',
    path: ['maxBackoffMs'],
  });

export type RatePolicy = z.infer<typeof ratePolicySchema>;

export const schemaFingerprintSchema = z.strictObject({
  algorithm: z.literal('sha256'),
  value: schemaFingerprintValueSchema,
  schemaName: nonEmptyStringSchema,
  canonicalizationVersion: semverSchema,
});

export type SchemaFingerprint = z.infer<typeof schemaFingerprintSchema>;

export const sourceEncodingSchema = z.enum([
  'csv',
  'zip',
  'geojson',
  'pbf',
  'geotiff',
  'json',
  'parquet',
  'other',
]);

export type SourceEncoding = z.infer<typeof sourceEncodingSchema>;

export const sourceDescriptorSchema = z
  .strictObject({
    sourceId: sourceIdSchema,
    contractVersion: semverSchema,
    name: nonEmptyStringSchema,
    authority: sourceAuthoritySchema,
    acquisitionMethod: z.enum(['bulk_download', 'api', 'static_artifact', 'manual_snapshot']),
    encodings: z.array(sourceEncodingSchema).min(1),
    entityKinds: z.array(nonEmptyStringSchema).min(1),
    defaultVisibility: visibilitySchema,
    license: licenseSnapshotSchema,
    ratePolicy: ratePolicySchema,
    freshnessSemantics: nonEmptyStringSchema,
  })
  .refine(
    (descriptor) =>
      descriptor.license.licenseSnapshotId.startsWith(
        `${descriptor.sourceId.replace('sc:source:', 'sc:license:')}:`,
      ),
    { message: 'License snapshot must belong to the described source', path: ['license'] },
  );

export type SourceDescriptor = z.infer<typeof sourceDescriptorSchema>;

export const sourceAsOfSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('reported'), at: isoDateTimeSchema }),
  z.strictObject({
    state: z.literal('derived'),
    at: isoDateTimeSchema,
    basis: nonEmptyStringSchema,
  }),
  z.strictObject({ state: z.literal('unknown'), reason: nonEmptyStringSchema }),
]);

export type SourceAsOf = z.infer<typeof sourceAsOfSchema>;

export const acquisitionRequestSchema = z
  .strictObject({
    sourceId: sourceIdSchema,
    snapshotId: snapshotIdSchema,
    requestedAt: isoDateTimeSchema,
    mode: z.enum(['full', 'incremental', 'resume']),
    requestedSourceAsOf: sourceAsOfSchema,
    checkpointCursor: nonEmptyStringSchema.optional(),
  })
  .refine((request) => snapshotBelongsToSource(request.snapshotId, request.sourceId), {
    message: 'Snapshot must belong to the requested source',
    path: ['snapshotId'],
  });

export type AcquisitionRequest = z.infer<typeof acquisitionRequestSchema>;

export const acquisitionPlanItemSchema = z.strictObject({
  requestKey: nonEmptyStringSchema,
  sequence: z.number().int().nonnegative(),
  method: z.enum(['GET', 'POST']),
  url: z.url(),
  encoding: sourceEncodingSchema,
  expectedMediaTypes: z.array(nonEmptyStringSchema).min(1),
});

export type AcquisitionPlanItem = z.infer<typeof acquisitionPlanItemSchema>;

export const acquisitionPlanSchema = z
  .strictObject({
    sourceId: sourceIdSchema,
    snapshotId: snapshotIdSchema,
    contractVersion: semverSchema,
    plannedAt: isoDateTimeSchema,
    items: z.array(acquisitionPlanItemSchema).min(1),
  })
  .refine((plan) => new Set(plan.items.map((item) => item.requestKey)).size === plan.items.length, {
    message: 'Acquisition request keys must be unique',
    path: ['items'],
  })
  .refine((plan) => snapshotBelongsToSource(plan.snapshotId, plan.sourceId), {
    message: 'Snapshot must belong to the planned source',
    path: ['snapshotId'],
  })
  .refine((plan) => new Set(plan.items.map((item) => item.sequence)).size === plan.items.length, {
    message: 'Acquisition item sequences must be unique',
    path: ['items'],
  });

export type AcquisitionPlan = z.infer<typeof acquisitionPlanSchema>;

export const sourceCheckpointSchema = z
  .strictObject({
    sourceId: sourceIdSchema,
    snapshotId: snapshotIdSchema,
    contractVersion: semverSchema,
    cursor: nonEmptyStringSchema,
    nextSequence: z.number().int().nonnegative(),
    completedRequestKeys: z.array(nonEmptyStringSchema),
    acquiredArtifactIds: z.array(artifactIdSchema),
    updatedAt: isoDateTimeSchema,
    complete: z.boolean(),
  })
  .superRefine((checkpoint, context) => {
    if (!snapshotBelongsToSource(checkpoint.snapshotId, checkpoint.sourceId)) {
      context.addIssue({
        code: 'custom',
        message: 'Checkpoint snapshot must belong to its source',
        path: ['snapshotId'],
      });
    }
    if (new Set(checkpoint.completedRequestKeys).size !== checkpoint.completedRequestKeys.length) {
      context.addIssue({
        code: 'custom',
        message: 'Completed checkpoint request keys must be unique',
        path: ['completedRequestKeys'],
      });
    }
    if (new Set(checkpoint.acquiredArtifactIds).size !== checkpoint.acquiredArtifactIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Checkpoint artifact IDs must be unique',
        path: ['acquiredArtifactIds'],
      });
    }
  });

export type SourceCheckpoint = z.infer<typeof sourceCheckpointSchema>;

export const artifactRequestHeaderSchema = z.strictObject({
  name: nonEmptyStringSchema,
  valueSha256: sha256Schema,
});

export type ArtifactRequestHeader = z.infer<typeof artifactRequestHeaderSchema>;

export const artifactRequestMetadataSchema = z.strictObject({
  requestKey: nonEmptyStringSchema,
  method: z.enum(['GET', 'POST']),
  url: z.url(),
  headers: z.array(artifactRequestHeaderSchema),
  bodySha256: sha256Schema.nullable(),
  attempt: z.number().int().positive(),
});

export type ArtifactRequestMetadata = z.infer<typeof artifactRequestMetadataSchema>;

export const artifactResponseMetadataSchema = z.strictObject({
  httpStatus: z.number().int().min(100).max(599),
  etag: nonEmptyStringSchema.nullable(),
  lastModified: isoDateTimeSchema.nullable(),
  finalUrl: z.url(),
});

export type ArtifactResponseMetadata = z.infer<typeof artifactResponseMetadataSchema>;

export const rawArtifactUriSchema = z
  .string()
  .regex(/^(?:file|https|ipfs|s3):\/\/[^\s]+$/u, 'Expected an immutable raw artifact URI');

export const acquiredArtifactSchema = z
  .strictObject({
    artifactId: artifactIdSchema,
    sourceId: sourceIdSchema,
    snapshotId: snapshotIdSchema,
    retrievedAt: isoDateTimeSchema,
    sourceAsOf: sourceAsOfSchema,
    request: artifactRequestMetadataSchema,
    response: artifactResponseMetadataSchema,
    mediaType: nonEmptyStringSchema,
    encoding: sourceEncodingSchema,
    byteSize: z.number().int().nonnegative(),
    sha256: sha256Schema,
    schemaFingerprint: schemaFingerprintSchema,
    rawUri: rawArtifactUriSchema,
    licenseSnapshotRef: licenseSnapshotIdSchema,
    visibility: visibilitySchema,
  })
  .superRefine((artifact, context) => {
    if (!snapshotBelongsToSource(artifact.snapshotId, artifact.sourceId)) {
      context.addIssue({
        code: 'custom',
        message: 'Artifact snapshot must belong to its source',
        path: ['snapshotId'],
      });
    }
    if (artifact.artifactId !== `sc:artifact:sha256:${artifact.sha256}`) {
      context.addIssue({
        code: 'custom',
        message: 'Artifact ID must match its SHA-256',
        path: ['artifactId'],
      });
    }
    if (
      !artifact.licenseSnapshotRef.startsWith(
        `${artifact.sourceId.replace('sc:source:', 'sc:license:')}:`,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'License snapshot must belong to the artifact source',
        path: ['licenseSnapshotRef'],
      });
    }
  });

export type AcquiredArtifact = z.infer<typeof acquiredArtifactSchema>;

export const validationIssueSchema = z.strictObject({
  code: nonEmptyStringSchema,
  severity: z.enum(['warning', 'error', 'fatal']),
  message: nonEmptyStringSchema,
  recordKey: nonEmptyStringSchema.nullable(),
  fieldPath: nonEmptyStringSchema.nullable(),
});

export type ValidationIssue = z.infer<typeof validationIssueSchema>;

export const validationReportSchema = z
  .strictObject({
    artifactId: artifactIdSchema,
    schemaFingerprint: schemaFingerprintSchema,
    status: z.enum(['valid', 'invalid', 'quarantined']),
    decodedRecords: z.number().int().nonnegative(),
    acceptedRecords: z.number().int().nonnegative(),
    rejectedRecords: z.number().int().nonnegative(),
    issues: z.array(validationIssueSchema),
    validatedAt: isoDateTimeSchema,
  })
  .superRefine((report, context) => {
    if (report.acceptedRecords + report.rejectedRecords !== report.decodedRecords) {
      context.addIssue({
        code: 'custom',
        message: 'acceptedRecords plus rejectedRecords must equal decodedRecords',
        path: ['decodedRecords'],
      });
    }
    if (report.status === 'valid' && report.issues.some((issue) => issue.severity !== 'warning')) {
      context.addIssue({
        code: 'custom',
        message: 'A valid report cannot contain error or fatal issues',
        path: ['issues'],
      });
    }
  });

export type ValidationReport = z.infer<typeof validationReportSchema>;

export const sourceRunSummarySchema = z
  .strictObject({
    sourceId: sourceIdSchema,
    snapshotId: snapshotIdSchema,
    runId: runIdSchema,
    contractVersion: semverSchema,
    status: z.enum(['succeeded', 'partial', 'failed', 'aborted']),
    startedAt: isoDateTimeSchema,
    completedAt: isoDateTimeSchema,
    artifactsAcquired: z.number().int().nonnegative(),
    bytesAcquired: z.number().int().nonnegative(),
    decodedRecords: z.number().int().nonnegative(),
    acceptedRecords: z.number().int().nonnegative(),
    rejectedRecords: z.number().int().nonnegative(),
    normalizedMutations: z.number().int().nonnegative(),
    visibilityCounts: visibilityCountsSchema,
    warningCount: z.number().int().nonnegative(),
    errorCount: z.number().int().nonnegative(),
    finalCheckpoint: sourceCheckpointSchema,
  })
  .superRefine((summary, context) => {
    if (!snapshotBelongsToSource(summary.snapshotId, summary.sourceId)) {
      context.addIssue({
        code: 'custom',
        message: 'Run snapshot must belong to its source',
        path: ['snapshotId'],
      });
    }
    if (
      summary.finalCheckpoint.sourceId !== summary.sourceId ||
      summary.finalCheckpoint.snapshotId !== summary.snapshotId
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Final checkpoint must belong to the summarized source snapshot',
        path: ['finalCheckpoint'],
      });
    }
    if (summary.acceptedRecords + summary.rejectedRecords !== summary.decodedRecords) {
      context.addIssue({
        code: 'custom',
        message: 'Source summary accounting does not balance',
        path: ['decodedRecords'],
      });
    }
    const visibilityTotal = Object.values(summary.visibilityCounts).reduce(
      (total, count) => total + count,
      0,
    );
    if (visibilityTotal !== summary.normalizedMutations) {
      context.addIssue({
        code: 'custom',
        message: 'Visibility counts must equal normalizedMutations',
        path: ['visibilityCounts'],
      });
    }
  });

export type SourceRunSummary = z.infer<typeof sourceRunSummarySchema>;
