import { createHash } from 'node:crypto';

import {
  canonicalEntitySchema,
  canonicalMutationSchema,
} from '@oracle/contracts/canonical/mutation';
import type { CanonicalMutation } from '@oracle/contracts/canonical/mutation';
import type { FieldLineage } from '@oracle/contracts/canonical/lineage';
import { isoDateTimeSchema, semverSchema, sha256Schema } from '@oracle/contracts/foundation';
import {
  artifactIdSchema,
  entityIdSchema,
  mutationIdSchema,
  observationIdSchema,
  runIdSchema,
  snapshotBelongsToSource,
  snapshotIdSchema,
  sourceIdSchema,
} from '@oracle/contracts/ids';
import type {
  ArtifactId,
  CanonicalEntityKind,
  EntityId,
  MutationId,
  ObservationId,
  RunId,
  SnapshotId,
  SourceId,
} from '@oracle/contracts/ids';
import { visibilitySchema } from '@oracle/contracts/visibility';
import type { Visibility } from '@oracle/contracts/visibility';

import type { CanonicalValue } from '../precedence.js';

export type CanonicalNormalizationContext = Readonly<{
  sourceId: SourceId;
  snapshotId: SnapshotId;
  artifactId: ArtifactId;
  runId: RunId;
  sourceRecordKey: string;
  sourceRecordSha256: string;
  rawPointer: string | null;
  observedAt: string;
  sourceAsOf: string | null;
  transformName: string;
  transformVersion: string;
  authorityRank: number;
  confidence: number;
  visibility: Visibility;
  sequenceStart?: number;
}>;

export type AdditionalObservation = Readonly<{
  fieldPath: `/${string}`;
  value: CanonicalValue;
  visibility?: Visibility;
}>;

const metadataKeys = new Set([
  'id',
  'entityKind',
  'version',
  'validFrom',
  'validTo',
  'recordedAt',
  'visibility',
  'sourceIds',
  'lineage',
]);

export const canonicalEntityMetadataKeys: ReadonlySet<string> = metadataKeys;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON numbers must be finite');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    return `{${Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => {
        if (item === undefined) {
          throw new TypeError(`Canonical JSON does not allow undefined at ${key}`);
        }
        return `${JSON.stringify(key)}:${canonicalJson(item)}`;
      })
      .join(',')}}`;
  }
  throw new TypeError(`Canonical JSON does not support ${typeof value}`);
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function sha256Utf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort();
  if (unexpected.length > 0) {
    throw new TypeError(`${label} contains unexpected field ${unexpected.join(', ')}`);
  }
}

export function deterministicEntityId(
  kind: CanonicalEntityKind,
  identityParts: readonly CanonicalValue[],
): EntityId {
  return entityIdSchema.parse(`sc:entity:${kind}:${sha256(identityParts)}`);
}

export function normalizeText(value: string, fieldName: string): string {
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (normalized.length === 0) {
    throw new TypeError(`${fieldName} must not be empty`);
  }
  return normalized;
}

export function normalizeNullableText(
  value: string | null | undefined,
  fieldName: string,
): string | null {
  return value === null || value === undefined ? null : normalizeText(value, fieldName);
}

export function normalizeNullableDateTime(
  value: string | null | undefined,
  fieldName: string,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const result = isoDateTimeSchema.safeParse(value);
  if (!result.success) {
    throw new TypeError(`${fieldName} must be an ISO-8601 datetime with an offset`);
  }
  return result.data;
}

function parseContext(context: CanonicalNormalizationContext): CanonicalNormalizationContext {
  const sourceId = sourceIdSchema.parse(context.sourceId);
  const snapshotId = snapshotIdSchema.parse(context.snapshotId);
  if (!snapshotBelongsToSource(snapshotId, sourceId)) {
    throw new TypeError('Normalization snapshot must belong to its source');
  }
  const sourceRecordKey = normalizeText(context.sourceRecordKey, 'sourceRecordKey');
  const rawPointer = normalizeNullableText(context.rawPointer, 'rawPointer');
  const observedAt = isoDateTimeSchema.parse(context.observedAt);
  const sourceAsOf =
    context.sourceAsOf === null ? null : isoDateTimeSchema.parse(context.sourceAsOf);
  if (
    !Number.isInteger(context.authorityRank) ||
    context.authorityRank < 1 ||
    context.authorityRank > 100
  ) {
    throw new RangeError('authorityRank must be an integer between 1 and 100');
  }
  if (!Number.isFinite(context.confidence) || context.confidence < 0 || context.confidence > 1) {
    throw new RangeError('confidence must be between zero and one');
  }
  const sequenceStart = context.sequenceStart ?? 0;
  if (!Number.isSafeInteger(sequenceStart) || sequenceStart < 0) {
    throw new RangeError('sequenceStart must be a non-negative safe integer');
  }
  return Object.freeze({
    ...context,
    sourceId,
    snapshotId,
    artifactId: artifactIdSchema.parse(context.artifactId),
    runId: runIdSchema.parse(context.runId),
    sourceRecordKey,
    sourceRecordSha256: sha256Schema.parse(context.sourceRecordSha256),
    rawPointer,
    observedAt,
    sourceAsOf,
    transformName: normalizeText(context.transformName, 'transformName'),
    transformVersion: semverSchema.parse(context.transformVersion),
    visibility: visibilitySchema.parse(context.visibility),
    sequenceStart,
  });
}

function makeLineage(context: CanonicalNormalizationContext, value: CanonicalValue): FieldLineage {
  const sourceRecord = {
    sourceId: context.sourceId,
    snapshotId: context.snapshotId,
    artifactId: context.artifactId,
    recordKey: context.sourceRecordKey,
    recordSha256: context.sourceRecordSha256,
    rawPointer: context.rawPointer,
  } as const;
  const transformations = [
    {
      name: context.transformName,
      version: context.transformVersion,
      appliedAt: context.observedAt,
      inputSha256: context.sourceRecordSha256,
      outputSha256: sha256(value),
    },
  ] as const;
  return Object.freeze({
    sourceRecord,
    transformations: [...transformations],
    lineageSha256: sha256({ sourceRecord, transformations }),
  });
}

function mutationIdFor(payload: unknown): MutationId {
  return mutationIdSchema.parse(`sc:mutation:${sha256(payload)}`);
}

function observationIdFor(payload: unknown): ObservationId {
  return observationIdSchema.parse(`sc:observation:${sha256(payload)}`);
}

export function emitCanonicalEntity(
  kind: CanonicalEntityKind,
  id: EntityId,
  domainFields: Readonly<Record<string, CanonicalValue>>,
  unparsedContext: CanonicalNormalizationContext,
  additionalObservations: readonly AdditionalObservation[] = [],
): readonly CanonicalMutation[] {
  const context = parseContext(unparsedContext);
  if (!id.startsWith(`sc:entity:${kind}:`)) {
    throw new TypeError(`Entity ID does not belong to ${kind}`);
  }
  const regularObservations = Object.entries(domainFields).map(([key, value]) => ({
    fieldPath: `/${key}` as const,
    value,
    visibility: undefined,
  }));
  const observationInputs = [...regularObservations, ...additionalObservations].sort(
    (left, right) => left.fieldPath.localeCompare(right.fieldPath),
  );
  const duplicatePaths = observationInputs.filter(
    (candidate, index) =>
      observationInputs.findIndex(({ fieldPath }) => fieldPath === candidate.fieldPath) !== index,
  );
  if (duplicatePaths.length > 0) {
    throw new Error(`Duplicate observation path ${duplicatePaths[0]?.fieldPath ?? 'unknown'}`);
  }

  const observations = observationInputs.map((input) => {
    const visibility = visibilitySchema.parse(input.visibility ?? context.visibility);
    const lineage = makeLineage(context, input.value);
    const identity = {
      entityId: id,
      entityKind: kind,
      fieldPath: input.fieldPath,
      value: input.value,
      observedAt: context.observedAt,
      sourceAsOf: context.sourceAsOf,
      authorityRank: context.authorityRank,
      confidence: context.confidence,
      visibility,
      lineage,
    } as const;
    return {
      observationId: observationIdFor(identity),
      ...identity,
    } as const;
  });

  const entity = canonicalEntitySchema.parse({
    id,
    entityKind: kind,
    version: 1,
    validFrom: context.sourceAsOf ?? context.observedAt,
    validTo: null,
    recordedAt: context.observedAt,
    visibility: context.visibility,
    sourceIds: [context.sourceId],
    lineage: observations.map(({ lineage }) => lineage),
    ...domainFields,
  });
  const entityPayload = {
    kind: 'entity_upsert' as const,
    runId: context.runId,
    sourceId: context.sourceId,
    snapshotId: context.snapshotId,
    sequence: context.sequenceStart ?? 0,
    emittedAt: context.observedAt,
    visibility: context.visibility,
    entity,
  };
  const entityMutation = canonicalMutationSchema.parse({
    mutationId: mutationIdFor(entityPayload),
    ...entityPayload,
  });
  const observationMutations = observations.map((observation, index) => {
    const payload = {
      kind: 'field_observation' as const,
      runId: context.runId,
      sourceId: context.sourceId,
      snapshotId: context.snapshotId,
      sequence: (context.sequenceStart ?? 0) + index + 1,
      emittedAt: context.observedAt,
      visibility: observation.visibility,
      observation,
    };
    return canonicalMutationSchema.parse({ mutationId: mutationIdFor(payload), ...payload });
  });
  return Object.freeze([entityMutation, ...observationMutations]);
}
