import { z } from 'zod';

import { isoDateTimeSchema, nonEmptyStringSchema, semverSchema } from '../foundation.js';
import {
  artifactIdSchema,
  entityIdSchema,
  linkIdSchema,
  mutationIdSchema,
  observationIdSchema,
  runIdSchema,
  snapshotBelongsToSource,
  snapshotIdSchema,
  sourceIdSchema,
} from '../ids.js';
import { visibilitySchema } from '../visibility.js';
import {
  businessSchema,
  contractorSchema,
  ownershipEventSchema,
  ownershipInterestSchema,
  partySchema,
} from './organization.js';
import { addressSchema, propertySchema, propertyUnitSchema } from './property.js';
import { permitSchema } from './permit.js';
import {
  elevationRasterRefSchema,
  hydroFeatureSchema,
  pedestrianGraphRefSchema,
  placeSchema,
  transitServiceSchema,
  transitStopSchema,
} from './geospatial.js';
import { fieldObservationSchema } from './lineage.js';

export const canonicalEntitySchema = z.discriminatedUnion('entityKind', [
  propertySchema,
  propertyUnitSchema,
  addressSchema,
  permitSchema,
  partySchema,
  ownershipInterestSchema,
  ownershipEventSchema,
  contractorSchema,
  businessSchema,
  transitStopSchema,
  transitServiceSchema,
  placeSchema,
  hydroFeatureSchema,
  pedestrianGraphRefSchema,
  elevationRasterRefSchema,
]);

export type CanonicalEntity = z.infer<typeof canonicalEntitySchema>;

export const entityLinkCandidateSchema = z.strictObject({
  linkId: linkIdSchema,
  fromEntityId: entityIdSchema,
  toEntityId: entityIdSchema,
  method: z.enum(['authoritative', 'normalized_exact', 'candidate_scored', 'manual']),
  score: z.number().min(0).max(1),
  evidenceObservationIds: z.array(observationIdSchema).min(1),
  algorithmVersion: semverSchema,
  reviewStatus: z.enum(['accepted', 'candidate', 'rejected', 'manual_review']),
});

export type EntityLinkCandidate = z.infer<typeof entityLinkCandidateSchema>;

export const canonicalArtifactReferenceSchema = z.strictObject({
  artifactId: artifactIdSchema,
  role: z.enum(['raw', 'canonical', 'evidence', 'query_mart', 'coverage', 'publication']),
  entityId: entityIdSchema.nullable(),
  description: nonEmptyStringSchema,
});

export type CanonicalArtifactReference = z.infer<typeof canonicalArtifactReferenceSchema>;

const mutationContextShape = {
  mutationId: mutationIdSchema,
  runId: runIdSchema,
  sourceId: sourceIdSchema,
  snapshotId: snapshotIdSchema,
  sequence: z.number().int().nonnegative(),
  emittedAt: isoDateTimeSchema,
  visibility: visibilitySchema,
};

export const canonicalMutationSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('entity_upsert'),
      ...mutationContextShape,
      entity: canonicalEntitySchema,
    }),
    z.strictObject({
      kind: z.literal('field_observation'),
      ...mutationContextShape,
      observation: fieldObservationSchema,
    }),
    z.strictObject({
      kind: z.literal('link_candidate'),
      ...mutationContextShape,
      link: entityLinkCandidateSchema,
    }),
    z.strictObject({
      kind: z.literal('artifact_reference'),
      ...mutationContextShape,
      artifact: canonicalArtifactReferenceSchema,
    }),
  ])
  .superRefine((mutation, context) => {
    if (!snapshotBelongsToSource(mutation.snapshotId, mutation.sourceId)) {
      context.addIssue({
        code: 'custom',
        message: 'Mutation snapshot must belong to its source',
        path: ['snapshotId'],
      });
    }
    const nestedVisibility =
      mutation.kind === 'entity_upsert'
        ? mutation.entity.visibility
        : mutation.kind === 'field_observation'
          ? mutation.observation.visibility
          : mutation.visibility;
    if (nestedVisibility !== mutation.visibility) {
      context.addIssue({
        code: 'custom',
        message: 'Mutation visibility must preserve nested record visibility',
        path: [mutation.kind === 'entity_upsert' ? 'entity' : 'observation', 'visibility'],
      });
    }
  });

export type CanonicalMutation = z.infer<typeof canonicalMutationSchema>;
