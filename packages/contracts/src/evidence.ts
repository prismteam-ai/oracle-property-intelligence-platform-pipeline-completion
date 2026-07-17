import { z } from 'zod';

import {
  isoDateTimeSchema,
  jsonValueSchema,
  nonEmptyStringSchema,
  semverSchema,
} from './foundation.js';
import {
  artifactIdSchema,
  entityIdSchema,
  evidenceIdSchema,
  snapshotBelongsToSource,
  snapshotIdSchema,
  sourceIdSchema,
} from './ids.js';
import { supportStateSchema } from './pipeline.js';
import { visibilitySchema } from './visibility.js';

export const evidenceSourceReferenceSchema = z
  .strictObject({
    sourceId: sourceIdSchema,
    snapshotId: snapshotIdSchema,
    artifactId: artifactIdSchema,
    recordKey: nonEmptyStringSchema,
    fieldPaths: z.array(nonEmptyStringSchema).min(1),
  })
  .refine((reference) => snapshotBelongsToSource(reference.snapshotId, reference.sourceId), {
    message: 'Evidence snapshot must belong to its source',
    path: ['snapshotId'],
  });

export type EvidenceSourceReference = z.infer<typeof evidenceSourceReferenceSchema>;

export const featureKindSchema = z.enum([
  'roof_age',
  'water_view_candidate',
  'ownership_age',
  'regional_owner',
  'transit_walkability',
  'starbucks_walkability',
  'combined_review_score',
]);

export type FeatureKind = z.infer<typeof featureKindSchema>;

export const algorithmReferenceSchema = z.strictObject({
  name: nonEmptyStringSchema,
  version: semverSchema,
  parameters: z.record(z.string(), jsonValueSchema),
});

export type AlgorithmReference = z.infer<typeof algorithmReferenceSchema>;

export const featureEvidenceSchema = z
  .strictObject({
    evidenceId: evidenceIdSchema,
    entityId: entityIdSchema,
    feature: featureKindSchema,
    supportState: supportStateSchema,
    confidence: z.number().min(0).max(1),
    value: jsonValueSchema,
    sourceReferences: z.array(evidenceSourceReferenceSchema),
    algorithm: algorithmReferenceSchema,
    asOf: isoDateTimeSchema,
    visibility: visibilitySchema,
    limitations: z.array(nonEmptyStringSchema),
  })
  .superRefine((evidence, context) => {
    if (
      ['supported', 'proxy'].includes(evidence.supportState) &&
      evidence.sourceReferences.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Supported and proxy evidence require source references',
        path: ['sourceReferences'],
      });
    }
    if (evidence.supportState !== 'supported' && evidence.limitations.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Non-supported evidence requires an explicit limitation',
        path: ['limitations'],
      });
    }
  });

export type FeatureEvidence = z.infer<typeof featureEvidenceSchema>;
