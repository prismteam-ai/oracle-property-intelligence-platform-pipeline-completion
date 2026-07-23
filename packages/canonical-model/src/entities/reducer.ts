import {
  canonicalEntitySchema,
  canonicalMutationSchema,
} from '@oracle/contracts/canonical/mutation';
import type {
  CanonicalArtifactReference,
  CanonicalEntity,
  CanonicalMutation,
  EntityLinkCandidate,
} from '@oracle/contracts/canonical/mutation';
import { fieldConflictSchema } from '@oracle/contracts/canonical/lineage';
import type {
  FieldConflict,
  FieldLineage,
  FieldObservation,
} from '@oracle/contracts/canonical/lineage';
import { conflictIdSchema } from '@oracle/contracts/ids';
import type { Visibility } from '@oracle/contracts/visibility';

import { selectByCanonicalPrecedence } from '../precedence.js';
import type { CanonicalValue, PrecedenceDecision } from '../precedence.js';
import { canonicalEntityMetadataKeys, canonicalJson, sha256 } from '../normalizers/core.js';

type EntityUpsertMutation = Extract<CanonicalMutation, { kind: 'entity_upsert' }>;
type ObservationMutation = Extract<CanonicalMutation, { kind: 'field_observation' }>;

export type CanonicalEntityAggregate = Readonly<{
  entity: CanonicalEntity;
  observations: readonly FieldObservation[];
  conflicts: readonly FieldConflict[];
  preferredObservationIds: Readonly<Record<string, readonly string[]>>;
}>;

export type CanonicalReduction = Readonly<{
  entities: readonly CanonicalEntityAggregate[];
  links: readonly EntityLinkCandidate[];
  artifacts: readonly CanonicalArtifactReference[];
}>;

const visibilityRank: Readonly<Record<Visibility, number>> = Object.freeze({
  public: 0,
  authenticated: 1,
  restricted: 2,
  prohibited_public: 3,
});

const multivaluedPaths = new Set([
  '/unitIds',
  '/propertyLinks',
  '/contractorIds',
  '/serviceIds',
  '/categories',
  '/brandIdentifiers',
]);
const MAX_CANONICAL_GROUP_MUTATIONS = 4_096;
const MAX_CANONICAL_REDUCTION_MUTATIONS = 65_536;

function mostRestrictiveVisibility(values: readonly Visibility[]): Visibility {
  assertBoundedArray(values, MAX_CANONICAL_GROUP_MUTATIONS, 'visibility values');
  const selected = [...values].sort(
    (left, right) => visibilityRank[right] - visibilityRank[left],
  )[0];
  if (selected === undefined) {
    throw new RangeError('At least one visibility is required');
  }
  return selected;
}

function dateCompare(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

function assertDuplicateIdentity(
  map: Map<string, string>,
  identity: string,
  value: unknown,
  label: string,
): boolean {
  const serialized = canonicalJson(value);
  const previous = map.get(identity);
  if (previous === undefined) {
    map.set(identity, serialized);
    return false;
  }
  if (previous !== serialized) {
    throw new Error(`${label} ${identity} was reused for different content`);
  }
  return true;
}

function chooseBase(upserts: readonly EntityUpsertMutation[]): EntityUpsertMutation {
  assertBoundedArray(upserts, MAX_CANONICAL_GROUP_MUTATIONS, 'entity upserts');
  const ordered = [...upserts].sort(
    (left, right) =>
      right.entity.version - left.entity.version ||
      dateCompare(right.entity.recordedAt, left.entity.recordedAt) ||
      left.mutationId.localeCompare(right.mutationId),
  );
  const selected = ordered[0];
  if (selected === undefined) {
    throw new Error('Cannot reduce an entity without an upsert');
  }
  return selected;
}

function precedence(observations: readonly FieldObservation[]): PrecedenceDecision {
  assertBoundedArray(observations, MAX_CANONICAL_GROUP_MUTATIONS, 'field observations');
  return selectByCanonicalPrecedence(
    observations.map((observation) => ({
      observationId: observation.observationId,
      authorityPriority: observation.authorityRank,
      sourceAsOf: observation.sourceAsOf ?? observation.observedAt,
      observedAt: observation.observedAt,
      confidence: observation.confidence,
      value: observation.value,
    })),
  );
}

function mergeMultivalued(observations: readonly FieldObservation[]): CanonicalValue[] {
  assertBoundedArray(observations, MAX_CANONICAL_GROUP_MUTATIONS, 'multivalue observations');
  const values = new Map<string, CanonicalValue>();
  for (const observation of observations) {
    if (!Array.isArray(observation.value)) {
      throw new TypeError(`Multivalued observation ${observation.fieldPath} must be an array`);
    }
    for (const value of observation.value as readonly CanonicalValue[]) {
      values.set(canonicalJson(value), value);
    }
  }
  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

function conflictFor(
  entityId: string,
  fieldPath: string,
  observations: readonly FieldObservation[],
  decision: PrecedenceDecision,
  multivalued: boolean,
): FieldConflict | null {
  if (!decision.hasConflict) {
    return null;
  }
  const observationIds = [...decision.orderedObservationIds];
  const resolvedAt = [...observations].sort((left, right) =>
    dateCompare(right.observedAt, left.observedAt),
  )[0]?.observedAt;
  if (resolvedAt === undefined) {
    throw new Error('A conflict requires observations');
  }
  const selectedObservation = observations.find(
    ({ observationId }) => observationId === decision.selected.observationId,
  );
  if (selectedObservation === undefined) {
    throw new Error('Precedence selected an unknown observation');
  }
  const other = observations.find(
    ({ observationId }) => observationId !== selectedObservation.observationId,
  );
  const resolution = multivalued
    ? {
        state: 'coexist' as const,
        method: 'multivalued' as const,
        rationale: 'Distinct supported values coexist under canonical-multivalue-v1.',
        resolvedAt,
      }
    : {
        state: 'selected' as const,
        selectedObservationId: selectedObservation.observationId,
        method:
          other !== undefined && other.authorityRank !== selectedObservation.authorityRank
            ? ('authority_precedence' as const)
            : ('temporal_precedence' as const),
        rationale: `Selected by ${decision.algorithm}; all competing observations remain immutable.`,
        resolvedAt,
      };
  return fieldConflictSchema.parse({
    conflictId: conflictIdSchema.parse(
      `sc:conflict:${sha256({ entityId, fieldPath, observationIds, algorithm: decision.algorithm })}`,
    ),
    entityId,
    fieldPath,
    observationIds,
    resolution,
  });
}

function reduceEntity(
  upserts: readonly EntityUpsertMutation[],
  observationMutations: readonly ObservationMutation[],
): CanonicalEntityAggregate {
  assertBoundedArray(upserts, MAX_CANONICAL_GROUP_MUTATIONS, 'entity upserts');
  assertBoundedArray(observationMutations, MAX_CANONICAL_GROUP_MUTATIONS, 'observation mutations');
  const base = chooseBase(upserts);
  if (upserts.some(({ entity }) => entity.entityKind !== base.entity.entityKind)) {
    throw new Error(`Entity ${base.entity.id} has conflicting entity kinds`);
  }
  const observationIdentity = new Map<string, string>();
  const observations = observationMutations
    .filter(
      ({ observation }) =>
        !assertDuplicateIdentity(
          observationIdentity,
          observation.observationId,
          observation,
          'Observation ID',
        ),
    )
    .map(({ observation }) => observation)
    .sort(
      (left, right) =>
        left.fieldPath.localeCompare(right.fieldPath) ||
        left.observationId.localeCompare(right.observationId),
    );
  const byPath = new Map<string, FieldObservation[]>();
  for (const observation of observations) {
    if (
      observation.entityId !== base.entity.id ||
      observation.entityKind !== base.entity.entityKind
    ) {
      throw new Error(
        `Observation ${observation.observationId} targets the wrong entity aggregate`,
      );
    }
    const existing = byPath.get(observation.fieldPath) ?? [];
    existing.push(observation);
    byPath.set(observation.fieldPath, existing);
  }

  const domainKeys = Object.keys(base.entity).filter(
    (key) => !canonicalEntityMetadataKeys.has(key),
  );
  for (const key of domainKeys) {
    if (!byPath.has(`/${key}`)) {
      throw new Error(`Entity ${base.entity.id} is missing immutable observation /${key}`);
    }
  }

  const entity = structuredClone(base.entity) as unknown as Record<string, unknown>;
  const conflicts: FieldConflict[] = [];
  const preferredObservationIds: Record<string, readonly string[]> = {};
  for (const [fieldPath, fieldObservations] of [...byPath.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const decision = precedence(fieldObservations);
    const multivalued = multivaluedPaths.has(fieldPath);
    preferredObservationIds[fieldPath] = Object.freeze(
      multivalued ? [...decision.orderedObservationIds] : [decision.selected.observationId],
    );
    const key = fieldPath.slice(1);
    if (Object.hasOwn(entity, key)) {
      entity[key] = multivalued
        ? mergeMultivalued(fieldObservations)
        : structuredClone(decision.selected.value);
    }
    const conflict = conflictFor(
      base.entity.id,
      fieldPath,
      fieldObservations,
      decision,
      multivalued,
    );
    if (conflict !== null) {
      conflicts.push(conflict);
    }
  }

  const lineages = new Map<string, FieldLineage>();
  for (const lineage of [
    ...upserts.flatMap(({ entity: candidate }) => candidate.lineage),
    ...observations.map(({ lineage }) => lineage),
  ]) {
    const previous = lineages.get(lineage.lineageSha256);
    if (previous !== undefined && canonicalJson(previous) !== canonicalJson(lineage)) {
      throw new Error(`Lineage hash ${lineage.lineageSha256} was reused for different content`);
    }
    lineages.set(lineage.lineageSha256, lineage);
  }
  entity.visibility = mostRestrictiveVisibility([
    ...upserts.flatMap((mutation) => [mutation.visibility, mutation.entity.visibility]),
    ...observationMutations.flatMap((mutation) => [
      mutation.visibility,
      mutation.observation.visibility,
    ]),
  ]);
  entity.sourceIds = [
    ...new Set([
      ...upserts.flatMap(({ entity: candidate }) => candidate.sourceIds),
      ...observations.map(({ lineage }) => lineage.sourceRecord.sourceId),
    ]),
  ].sort();
  entity.lineage = [...lineages.values()].sort((left, right) =>
    left.lineageSha256.localeCompare(right.lineageSha256),
  );
  entity.version = Math.max(...upserts.map(({ entity: candidate }) => candidate.version));
  entity.validFrom = [...upserts].sort((left, right) =>
    dateCompare(left.entity.validFrom, right.entity.validFrom),
  )[0]?.entity.validFrom;
  entity.recordedAt = [...upserts].sort((left, right) =>
    dateCompare(right.entity.recordedAt, left.entity.recordedAt),
  )[0]?.entity.recordedAt;
  const validToValues = upserts.map(({ entity: candidate }) => candidate.validTo);
  entity.validTo = validToValues.includes(null)
    ? null
    : [...(validToValues as string[])].sort((left, right) => dateCompare(right, left))[0];

  return Object.freeze({
    entity: canonicalEntitySchema.parse(entity),
    observations: Object.freeze(observations),
    conflicts: Object.freeze(
      conflicts.sort((left, right) => left.conflictId.localeCompare(right.conflictId)),
    ),
    preferredObservationIds: Object.freeze(preferredObservationIds),
  });
}

/**
 * Reduces one semantic entity group. County processing calls this only after the
 * durable partitioner has ordered and grouped mutations by entity identity.
 * Keeping this primitive separate from the legacy corpus reducer allows the
 * bounded path to retain the exact canonical precedence implementation while
 * holding no more than one explicitly budgeted entity group in memory.
 */
export function reduceCanonicalEntityGroup(input: readonly unknown[]): CanonicalEntityAggregate {
  assertBoundedArray(input, MAX_CANONICAL_GROUP_MUTATIONS, 'canonical entity group');
  const mutationIdentity = new Map<string, string>();
  const upserts: EntityUpsertMutation[] = [];
  const observations: ObservationMutation[] = [];
  let entityId: string | null = null;
  for (const value of input) {
    const mutation = canonicalMutationSchema.parse(value);
    if (mutation.kind !== 'entity_upsert' && mutation.kind !== 'field_observation') {
      throw new TypeError('Canonical entity groups may contain only upserts and observations');
    }
    if (assertDuplicateIdentity(mutationIdentity, mutation.mutationId, mutation, 'Mutation ID')) {
      continue;
    }
    const candidateId =
      mutation.kind === 'entity_upsert' ? mutation.entity.id : mutation.observation.entityId;
    if (entityId !== null && candidateId !== entityId) {
      throw new Error(`Canonical entity group mixed ${entityId} with ${candidateId}`);
    }
    entityId = candidateId;
    if (mutation.kind === 'entity_upsert') upserts.push(mutation);
    else observations.push(mutation);
  }
  if (entityId === null || upserts.length === 0) {
    throw new Error('Canonical entity group requires at least one entity upsert');
  }
  return reduceEntity(upserts, observations);
}

export function reduceCanonicalMutations(input: readonly unknown[]): CanonicalReduction {
  assertBoundedArray(input, MAX_CANONICAL_REDUCTION_MUTATIONS, 'canonical reduction input');
  const mutationIdentity = new Map<string, string>();
  const mutations = input
    .map((mutation) => canonicalMutationSchema.parse(mutation))
    .filter(
      (mutation) =>
        !assertDuplicateIdentity(mutationIdentity, mutation.mutationId, mutation, 'Mutation ID'),
    )
    .sort((left, right) => left.mutationId.localeCompare(right.mutationId));
  const upsertsByEntity = new Map<string, EntityUpsertMutation[]>();
  const observationsByEntity = new Map<string, ObservationMutation[]>();
  const links: EntityLinkCandidate[] = [];
  const artifacts: CanonicalArtifactReference[] = [];
  for (const mutation of mutations) {
    if (mutation.kind === 'entity_upsert') {
      const existing = upsertsByEntity.get(mutation.entity.id) ?? [];
      existing.push(mutation);
      upsertsByEntity.set(mutation.entity.id, existing);
    } else if (mutation.kind === 'field_observation') {
      const existing = observationsByEntity.get(mutation.observation.entityId) ?? [];
      existing.push(mutation);
      observationsByEntity.set(mutation.observation.entityId, existing);
    } else if (mutation.kind === 'link_candidate') {
      links.push(mutation.link);
    } else {
      artifacts.push(mutation.artifact);
    }
  }
  for (const entityId of observationsByEntity.keys()) {
    if (!upsertsByEntity.has(entityId)) {
      throw new Error(`Observations for ${entityId} have no entity upsert`);
    }
  }
  const entities = [...upsertsByEntity.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entityId, upserts]) => reduceEntity(upserts, observationsByEntity.get(entityId) ?? []));
  return Object.freeze({
    entities: Object.freeze(entities),
    links: Object.freeze(links.sort((left, right) => left.linkId.localeCompare(right.linkId))),
    artifacts: Object.freeze(
      artifacts.sort(
        (left, right) =>
          left.artifactId.localeCompare(right.artifactId) || left.role.localeCompare(right.role),
      ),
    ),
  });
}

function assertBoundedArray(values: readonly unknown[], maximum: number, label: string): void {
  if (values.length > maximum) {
    throw new RangeError(`${label} exceeds the bounded maximum of ${maximum}`);
  }
}
