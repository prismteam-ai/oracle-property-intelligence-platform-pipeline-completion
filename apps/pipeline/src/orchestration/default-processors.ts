import { createHash } from 'node:crypto';

import {
  canonicalMutationSchema,
  type CanonicalEntity,
  type CanonicalMutation,
} from '@oracle/contracts/canonical/mutation';
import {
  reduceCanonicalMutations,
  type CanonicalReduction,
} from '@oracle/canonical-model/entities/reducer';
import {
  deriveRoofAge,
  type RoofPermitObservation,
} from '@oracle/features/property-intelligence/roof';
import { linkEntities } from '@oracle/reconciliation/entity-linking/engine';
import { policyFor } from '@oracle/reconciliation/entity-linking/policies';
import type {
  EntityLinkingRun,
  LinkRelation,
  LinkableEntity,
  NormalizedExactKey,
} from '@oracle/reconciliation/entity-linking/model';

import type { PipelineProcessors, ReconciliationOutput } from './types.js';

type DefaultReconciliation = ReconciliationOutput &
  Readonly<{ canonical: CanonicalReduction; links: readonly EntityLinkingRun[] }>;

const RELATIONS = Object.freeze([
  'property_address',
  'property_unit',
  'permit_property',
  'permit_contractor',
  'contractor_business',
  'business_address',
  'ownership_property',
  'ownership_party',
  'transfer_property',
] as const satisfies readonly LinkRelation[]);

const ENTITY_METADATA_KEYS = new Set([
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

/**
 * Provider mutations sometimes carry immutable core values only on the entity upsert.
 * The reducer deliberately requires an observation for every domain value, so the
 * orchestration boundary materializes those missing observations from the upsert's
 * own immutable value and lineage. No value is inferred or sourced externally.
 */
function completeImmutableObservations(
  mutations: readonly CanonicalMutation[],
): readonly CanonicalMutation[] {
  const observed = new Set(
    mutations
      .filter((mutation) => mutation.kind === 'field_observation')
      .map(({ observation }) => `${observation.entityId}\0${observation.fieldPath}`),
  );
  const additions: CanonicalMutation[] = [];
  for (const mutation of mutations) {
    if (mutation.kind !== 'entity_upsert') continue;
    const entity = mutation.entity as unknown as Readonly<Record<string, unknown>>;
    const lineage = mutation.entity.lineage[0];
    if (lineage === undefined) throw new Error(`Entity ${mutation.entity.id} has no lineage`);
    const missing = Object.keys(entity)
      .filter((key) => !ENTITY_METADATA_KEYS.has(key))
      .filter((key) => !observed.has(`${mutation.entity.id}\0/${key}`))
      .sort();
    for (const [index, key] of missing.entries()) {
      const digest = createHash('sha256').update(`${mutation.mutationId}|/${key}`).digest('hex');
      additions.push(
        canonicalMutationSchema.parse({
          kind: 'field_observation',
          mutationId: `sc:mutation:${digest}`,
          runId: mutation.runId,
          sourceId: mutation.sourceId,
          snapshotId: mutation.snapshotId,
          sequence: mutation.sequence + 900 + index,
          emittedAt: mutation.emittedAt,
          visibility: mutation.visibility,
          observation: {
            observationId: `sc:observation:${digest}`,
            entityId: mutation.entity.id,
            entityKind: mutation.entity.entityKind,
            fieldPath: `/${key}`,
            value: entity[key],
            observedAt: mutation.entity.recordedAt,
            sourceAsOf: mutation.entity.validFrom,
            authorityRank: 1,
            confidence: 1,
            visibility: mutation.visibility,
            lineage,
          },
        }),
      );
    }
  }
  return Object.freeze([...mutations, ...additions]);
}

function normalizedKeys(entity: CanonicalEntity): readonly NormalizedExactKey[] {
  switch (entity.entityKind) {
    case 'property':
      return [{ kind: 'apn', value: entity.apn }];
    case 'property-unit':
      return entity.assessmentIdentifier === null
        ? []
        : [{ kind: 'address_unit', value: entity.assessmentIdentifier }];
    case 'address':
      return [{ kind: 'address', value: entity.normalized }];
    case 'contractor':
      return [{ kind: 'license', value: entity.licenseNumber }];
    case 'business':
      return [{ kind: 'entity_number', value: entity.entityNumber }];
    case 'ownership-event':
      return entity.recordedDocumentId === null
        ? []
        : [{ kind: 'document_id', value: entity.recordedDocumentId }];
    default:
      return [];
  }
}

function jurisdiction(entity: CanonicalEntity): string {
  if ('jurisdiction' in entity && typeof entity.jurisdiction === 'string')
    return entity.jurisdiction;
  return 'Santa Clara, CA';
}

function linkable(entity: CanonicalEntity): LinkableEntity {
  const keys = normalizedKeys(entity);
  const identifiers = keys.map((key) => ({
    scheme:
      key.kind === 'apn'
        ? 'county-parcel-id'
        : key.kind === 'license'
          ? 'cslb-license'
          : key.kind === 'entity_number'
            ? 'ca-sos-entity'
            : key.kind === 'document_id'
              ? 'source-document-id'
              : 'source-address-id',
    value: key.value,
    scope: jurisdiction(entity),
  }));
  const candidateAttributes =
    entity.entityKind === 'address'
      ? { address: entity.normalized, postalCode: entity.postalCode }
      : entity.entityKind === 'contractor'
        ? { name: entity.legalName }
        : entity.entityKind === 'business'
          ? { name: entity.legalName }
          : {};
  const parentPropertyId =
    entity.entityKind === 'property-unit'
      ? entity.propertyId
      : entity.entityKind === 'ownership-interest' || entity.entityKind === 'ownership-event'
        ? entity.propertyId
        : null;
  return Object.freeze({
    entityId: entity.id,
    entityKind: entity.entityKind,
    jurisdiction: jurisdiction(entity),
    parentPropertyId,
    identifiers: Object.freeze(identifiers),
    normalizedKeys: Object.freeze(keys),
    candidateAttributes: Object.freeze(candidateAttributes),
    evidenceAvailability: entity.sourceIds.length > 0 ? 'complete' : 'blocked',
    visibility: entity.visibility,
    lineage: Object.freeze(
      entity.lineage.map(({ sourceRecord }) => ({
        sourceId: sourceRecord.sourceId,
        snapshotId: sourceRecord.snapshotId,
        artifactId: sourceRecord.artifactId,
        recordKey: sourceRecord.recordKey,
        recordSha256: sourceRecord.recordSha256,
      })),
    ),
  });
}

function reconcile(canonical: CanonicalReduction): readonly EntityLinkingRun[] {
  const entities = canonical.entities.map(({ entity }) => linkable(entity));
  return Object.freeze(
    RELATIONS.map((relation) => {
      const policy = policyFor(relation);
      return linkEntities(
        relation,
        entities.filter(({ entityKind }) => policy.subjectKinds.includes(entityKind)),
        entities.filter(({ entityKind }) => policy.targetKinds.includes(entityKind)),
      );
    }),
  );
}

function permitObservation(
  entity: Extract<CanonicalEntity, { entityKind: 'permit' }>,
): RoofPermitObservation {
  const lineage = entity.lineage[0];
  if (lineage === undefined) throw new Error(`Permit ${entity.id} has no lineage`);
  return Object.freeze({
    observationId: `permit:${entity.id}`,
    kind: 'permit',
    reference: Object.freeze({
      sourceId: lineage.sourceRecord.sourceId,
      snapshotId: lineage.sourceRecord.snapshotId,
      artifactId: lineage.sourceRecord.artifactId,
      recordKey: lineage.sourceRecord.recordKey,
      fieldPaths: Object.freeze([
        '/permitType',
        '/description',
        '/status',
        '/issuedAt',
        '/completedAt',
      ]),
    }),
    observedAt: entity.recordedAt,
    sourceAsOf: entity.validFrom,
    visibility: entity.visibility,
    fields: Object.freeze({}),
    permitId: entity.id,
    permitType: entity.permitType,
    description: entity.description,
    status: entity.status,
    issuedAt: entity.issuedAt,
    completedAt: entity.completedAt,
  });
}

function deriveRoofEvidence(reconciled: DefaultReconciliation): readonly unknown[] {
  const entities = reconciled.canonical.entities.map(({ entity }) => entity);
  const permits = entities.filter(
    (entity): entity is Extract<CanonicalEntity, { entityKind: 'permit' }> =>
      entity.entityKind === 'permit',
  );
  return Object.freeze(
    entities
      .filter(
        (entity): entity is Extract<CanonicalEntity, { entityKind: 'property' }> =>
          entity.entityKind === 'property',
      )
      .map((property) =>
        deriveRoofAge({
          propertyId: property.id,
          asOf: property.recordedAt,
          permits: permits
            .filter((permit) =>
              permit.propertyLinks.some(({ propertyId }) => propertyId === property.id),
            )
            .map((permit) => permitObservation(permit)),
          buildingAge: [],
          permitCoverage: Object.freeze({
            state: 'partial',
            jurisdiction: property.jurisdiction,
            windowStart: null,
            windowEnd: property.recordedAt,
            measuredAt: property.recordedAt,
            sourceIds: Object.freeze(
              permits
                .flatMap(({ sourceIds }) => sourceIds)
                .filter((value, index, values) => values.indexOf(value) === index),
            ),
            limitations: Object.freeze([
              'The portable default processor does not infer complete countywide permit history.',
            ]),
            observations: Object.freeze([]),
          }),
        }),
      ),
  );
}

export function createDefaultPipelineProcessors(): PipelineProcessors {
  return Object.freeze({
    reconcile: (mutations: readonly CanonicalMutation[], signal: AbortSignal) => {
      signal.throwIfAborted();
      const canonical = reduceCanonicalMutations(completeImmutableObservations(mutations));
      const output: DefaultReconciliation = Object.freeze({
        canonical,
        links: reconcile(canonical),
      });
      return Promise.resolve(output);
    },
    deriveFeatures: (input: ReconciliationOutput, signal: AbortSignal) => {
      signal.throwIfAborted();
      return Promise.resolve(deriveRoofEvidence(input as DefaultReconciliation));
    },
    buildMarts: (
      input: Readonly<{ reconciled: ReconciliationOutput; features: unknown }>,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      const reconciled = input.reconciled as DefaultReconciliation;
      return Promise.resolve(
        Object.freeze({
          format: 'portable-fixture-json-v1',
          properties: Object.freeze(
            reconciled.canonical.entities
              .filter(({ entity }) => entity.entityKind === 'property')
              .map(({ entity }) => entity),
          ),
          featureEvidence: input.features,
        }),
      );
    },
  });
}
