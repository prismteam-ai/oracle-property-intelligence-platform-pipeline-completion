import { z } from 'zod';

import { sha256Schema } from './foundation.js';

const stableKeyPattern = '[a-z0-9][a-z0-9._~-]{0,127}';
const slugPattern = '[a-z0-9]+(?:-[a-z0-9]+)*';

export const canonicalEntityKindSchema = z.enum([
  'property',
  'property-unit',
  'address',
  'permit',
  'party',
  'ownership-interest',
  'ownership-event',
  'contractor',
  'business',
  'transit-stop',
  'transit-service',
  'place',
  'hydro-feature',
  'pedestrian-graph-ref',
  'elevation-raster-ref',
]);

export type CanonicalEntityKind = z.infer<typeof canonicalEntityKindSchema>;

export const sourceIdSchema = z
  .string()
  .regex(new RegExp(`^sc:source:${slugPattern}$`, 'u'), 'Malformed Santa Clara source ID')
  .brand<'SourceId'>();
export type SourceId = z.infer<typeof sourceIdSchema>;

export const snapshotIdSchema = z
  .string()
  .regex(
    new RegExp(`^sc:snapshot:${slugPattern}:[a-f0-9]{64}$`, 'u'),
    'Malformed deterministic Santa Clara snapshot ID',
  )
  .brand<'SnapshotId'>();
export type SnapshotId = z.infer<typeof snapshotIdSchema>;

export const runIdSchema = z
  .string()
  .regex(/^sc:run:[a-f0-9]{64}$/u, 'Malformed deterministic Santa Clara run ID')
  .brand<'RunId'>();
export type RunId = z.infer<typeof runIdSchema>;

export const artifactIdSchema = z
  .string()
  .regex(/^sc:artifact:sha256:[a-f0-9]{64}$/u, 'Malformed content-addressed artifact ID')
  .brand<'ArtifactId'>();
export type ArtifactId = z.infer<typeof artifactIdSchema>;

export const entityIdSchema = z
  .string()
  .regex(
    new RegExp(
      `^sc:entity:(?:${canonicalEntityKindSchema.options.join('|')}):${stableKeyPattern}$`,
      'u',
    ),
    'Malformed deterministic Santa Clara entity ID',
  )
  .brand<'EntityId'>();
export type EntityId = z.infer<typeof entityIdSchema>;

export function entityIdSchemaFor(kind: CanonicalEntityKind) {
  return entityIdSchema.refine((value) => value.startsWith(`sc:entity:${kind}:`), {
    message: `Entity ID must use the ${kind} namespace`,
  });
}

export const observationIdSchema = z
  .string()
  .regex(/^sc:observation:[a-f0-9]{64}$/u, 'Malformed deterministic observation ID')
  .brand<'ObservationId'>();
export type ObservationId = z.infer<typeof observationIdSchema>;

export const evidenceIdSchema = z
  .string()
  .regex(/^sc:evidence:[a-f0-9]{64}$/u, 'Malformed deterministic evidence ID')
  .brand<'EvidenceId'>();
export type EvidenceId = z.infer<typeof evidenceIdSchema>;

export const mutationIdSchema = z
  .string()
  .regex(/^sc:mutation:[a-f0-9]{64}$/u, 'Malformed deterministic mutation ID')
  .brand<'MutationId'>();
export type MutationId = z.infer<typeof mutationIdSchema>;

export const conflictIdSchema = z
  .string()
  .regex(/^sc:conflict:[a-f0-9]{64}$/u, 'Malformed deterministic conflict ID')
  .brand<'ConflictId'>();
export type ConflictId = z.infer<typeof conflictIdSchema>;

export const linkIdSchema = z
  .string()
  .regex(/^sc:link:[a-f0-9]{64}$/u, 'Malformed deterministic entity-link ID')
  .brand<'LinkId'>();
export type LinkId = z.infer<typeof linkIdSchema>;

export const manifestIdSchema = z
  .string()
  .regex(/^sc:manifest:[a-f0-9]{64}$/u, 'Malformed deterministic manifest ID')
  .brand<'ManifestId'>();
export type ManifestId = z.infer<typeof manifestIdSchema>;

export const licenseSnapshotIdSchema = z
  .string()
  .regex(
    new RegExp(`^sc:license:${slugPattern}:[a-f0-9]{64}$`, 'u'),
    'Malformed deterministic license snapshot ID',
  )
  .brand<'LicenseSnapshotId'>();
export type LicenseSnapshotId = z.infer<typeof licenseSnapshotIdSchema>;

export const schemaFingerprintValueSchema = sha256Schema.brand<'SchemaFingerprintValue'>();
export type SchemaFingerprintValue = z.infer<typeof schemaFingerprintValueSchema>;

export function snapshotBelongsToSource(snapshotId: SnapshotId, sourceId: SourceId): boolean {
  const expectedPrefix = sourceId.replace('sc:source:', 'sc:snapshot:');
  return snapshotId.startsWith(`${expectedPrefix}:`);
}
