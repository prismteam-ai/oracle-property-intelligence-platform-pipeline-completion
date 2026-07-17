import { z } from 'zod';

import {
  isoDateTimeSchema,
  nonEmptyStringSchema,
  semverSchema,
  sha256Schema,
} from './foundation.js';
import { artifactIdSchema, manifestIdSchema, runIdSchema, sourceIdSchema } from './ids.js';
import { rawArtifactUriSchema, schemaFingerprintSchema } from './source.js';
import { visibilitySchema } from './visibility.js';

export const publicationEligibilitySchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('eligible'),
    visibility: z.literal('public'),
    rights: z.literal('approved'),
    scanPassed: z.literal(true),
    containsPersonalData: z.literal(false),
    rightsReference: nonEmptyStringSchema,
    scannerVersion: semverSchema,
  }),
  z.strictObject({
    state: z.literal('ineligible'),
    visibility: visibilitySchema,
    rights: z.enum(['approved', 'restricted', 'prohibited', 'unknown']),
    scanPassed: z.boolean(),
    containsPersonalData: z.boolean(),
    reasons: z.array(nonEmptyStringSchema).min(1),
    rightsReference: nonEmptyStringSchema,
    scannerVersion: semverSchema,
  }),
]);

export type PublicationEligibility = z.infer<typeof publicationEligibilitySchema>;

export const artifactManifestEntrySchema = z
  .strictObject({
    artifactId: artifactIdSchema,
    artifactType: z.enum([
      'raw',
      'canonical',
      'evidence',
      'query_mart',
      'coverage',
      'per_property_json',
      'car',
      'manifest',
    ]),
    uri: rawArtifactUriSchema,
    mirrorUri: rawArtifactUriSchema.nullable(),
    cid: nonEmptyStringSchema.nullable(),
    mediaType: nonEmptyStringSchema,
    byteSize: z.number().int().nonnegative(),
    sha256: sha256Schema,
    rowCount: z.number().int().nonnegative().nullable(),
    schemaFingerprint: schemaFingerprintSchema,
    sourceIds: z.array(sourceIdSchema).min(1),
    visibility: visibilitySchema,
    publicationEligibility: publicationEligibilitySchema,
  })
  .superRefine((entry, context) => {
    if (entry.artifactId !== `sc:artifact:sha256:${entry.sha256}`) {
      context.addIssue({
        code: 'custom',
        message: 'Manifest artifact ID must match its SHA-256',
        path: ['artifactId'],
      });
    }
    if (entry.visibility !== entry.publicationEligibility.visibility) {
      context.addIssue({
        code: 'custom',
        message: 'Entry visibility and publication eligibility visibility must match',
        path: ['publicationEligibility', 'visibility'],
      });
    }
    if (entry.publicationEligibility.state === 'eligible' && entry.cid === null) {
      context.addIssue({
        code: 'custom',
        message: 'Publication-eligible artifacts require an immutable CID',
        path: ['cid'],
      });
    }
  });

export type ArtifactManifestEntry = z.infer<typeof artifactManifestEntrySchema>;

export const artifactManifestSchema = z
  .strictObject({
    manifestId: manifestIdSchema,
    contractVersion: semverSchema,
    runId: runIdSchema,
    county: z.literal('Santa Clara'),
    state: z.literal('CA'),
    createdAt: isoDateTimeSchema,
    entries: z.array(artifactManifestEntrySchema).min(1),
    manifestSha256: sha256Schema,
  })
  .refine(
    (manifest) =>
      new Set(manifest.entries.map((entry) => entry.artifactId)).size === manifest.entries.length,
    { message: 'Artifact IDs must be unique within a manifest', path: ['entries'] },
  )
  .refine((manifest) => manifest.manifestId === `sc:manifest:${manifest.manifestSha256}`, {
    message: 'Manifest ID must match its SHA-256',
    path: ['manifestId'],
  });

export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
