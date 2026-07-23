import { z } from 'zod';

import {
  isoDateTimeSchema,
  jsonValueSchema,
  nonEmptyStringSchema,
  semverSchema,
  sha256Schema,
} from '../foundation.js';
import {
  artifactIdSchema,
  canonicalEntityKindSchema,
  conflictIdSchema,
  entityIdSchema,
  observationIdSchema,
  snapshotBelongsToSource,
  snapshotIdSchema,
  sourceIdSchema,
} from '../ids.js';
import { visibilitySchema } from '../visibility.js';

export const sourceRecordReferenceSchema = z
  .strictObject({
    sourceId: sourceIdSchema,
    snapshotId: snapshotIdSchema,
    artifactId: artifactIdSchema,
    recordKey: nonEmptyStringSchema,
    recordSha256: sha256Schema,
    rawPointer: nonEmptyStringSchema.nullable(),
  })
  .refine((reference) => snapshotBelongsToSource(reference.snapshotId, reference.sourceId), {
    message: 'Lineage snapshot must belong to its source',
    path: ['snapshotId'],
  });

export type SourceRecordReference = z.infer<typeof sourceRecordReferenceSchema>;

export const transformationStepSchema = z.strictObject({
  name: nonEmptyStringSchema,
  version: semverSchema,
  appliedAt: isoDateTimeSchema,
  inputSha256: sha256Schema,
  outputSha256: sha256Schema,
});

export type TransformationStep = z.infer<typeof transformationStepSchema>;

export const fieldLineageSchema = z.strictObject({
  sourceRecord: sourceRecordReferenceSchema,
  transformations: z.array(transformationStepSchema).min(1),
  lineageSha256: sha256Schema,
});

export type FieldLineage = z.infer<typeof fieldLineageSchema>;

export const fieldObservationSchema = z
  .strictObject({
    observationId: observationIdSchema,
    entityId: entityIdSchema,
    entityKind: canonicalEntityKindSchema,
    fieldPath: z.string().regex(/^\/[a-zA-Z0-9_~/-]+$/u, 'Expected a JSON Pointer field path'),
    value: jsonValueSchema,
    observedAt: isoDateTimeSchema,
    sourceAsOf: isoDateTimeSchema.nullable(),
    authorityRank: z.number().int().min(1).max(100),
    confidence: z.number().min(0).max(1),
    visibility: visibilitySchema,
    lineage: fieldLineageSchema,
  })
  .refine(
    (observation) => observation.entityId.startsWith(`sc:entity:${observation.entityKind}:`),
    { message: 'Observation entity ID namespace does not match entityKind', path: ['entityId'] },
  );

export type FieldObservation = z.infer<typeof fieldObservationSchema>;

export const conflictResolutionSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('unresolved') }),
  z.strictObject({
    state: z.literal('selected'),
    selectedObservationId: observationIdSchema,
    method: z.enum(['authority_precedence', 'temporal_precedence', 'manual_review']),
    rationale: nonEmptyStringSchema,
    resolvedAt: isoDateTimeSchema,
  }),
  z.strictObject({
    state: z.literal('coexist'),
    method: z.enum(['temporal', 'multivalued']),
    rationale: nonEmptyStringSchema,
    resolvedAt: isoDateTimeSchema,
  }),
]);

export type ConflictResolution = z.infer<typeof conflictResolutionSchema>;

export const fieldConflictSchema = z
  .strictObject({
    conflictId: conflictIdSchema,
    entityId: entityIdSchema,
    fieldPath: z.string().regex(/^\/[a-zA-Z0-9_~/-]+$/u),
    observationIds: z.array(observationIdSchema).min(2),
    resolution: conflictResolutionSchema,
  })
  .superRefine((conflict, context) => {
    if (new Set(conflict.observationIds).size !== conflict.observationIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Conflict observations must be unique',
        path: ['observationIds'],
      });
    }
    if (
      conflict.resolution.state === 'selected' &&
      !conflict.observationIds.includes(conflict.resolution.selectedObservationId)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Selected observation must be a member of the conflict',
        path: ['resolution', 'selectedObservationId'],
      });
    }
  });

export type FieldConflict = z.infer<typeof fieldConflictSchema>;

export const canonicalEntityMetadataSchema = z
  .strictObject({
    id: entityIdSchema,
    entityKind: canonicalEntityKindSchema,
    version: z.number().int().positive(),
    validFrom: isoDateTimeSchema,
    validTo: isoDateTimeSchema.nullable(),
    recordedAt: isoDateTimeSchema,
    visibility: visibilitySchema,
    sourceIds: z.array(sourceIdSchema).min(1),
    lineage: z.array(fieldLineageSchema).min(1),
  })
  .refine((metadata) => metadata.id.startsWith(`sc:entity:${metadata.entityKind}:`), {
    message: 'Entity ID namespace does not match entityKind',
    path: ['id'],
  });

export type CanonicalEntityMetadata = z.infer<typeof canonicalEntityMetadataSchema>;
