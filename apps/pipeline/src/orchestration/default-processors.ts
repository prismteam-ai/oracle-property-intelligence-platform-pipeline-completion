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
import type {
  CapabilityReleaseState,
  RealCountyCapability,
  RealCountyReleaseInput,
  SourceSnapshotGate,
} from '@oracle/data-runtime/serving/real-county-release';
import type { ServingRow } from '@oracle/data-runtime/serving/schema';

import { canonicalJson, sha256 } from './canonical-json.js';
import type { PipelineProcessors, ReconciliationOutput, SourceExecutionManifest } from './types.js';

const REAL_COUNTY_CAPABILITIES = Object.freeze([
  'santa_clara_parcels',
  'san_jose_permits',
  'palo_alto_year_built',
  'vta_gtfs',
  'caltrain_gtfs',
  'transit_511_fallback',
  'osm_pedestrian_graph',
  'noaa_shoreline',
  'usgs_hydrography',
  'usgs_elevation',
  'overture_starbucks',
  'cslb_contractors',
  'ca_sos_businesses',
  'ownership_transfers',
  'santa_clara_fbn',
] as const satisfies readonly RealCountyCapability[]);

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

function uniqueStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

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

export function capabilityStates(
  sources: readonly SourceExecutionManifest[],
): readonly CapabilityReleaseState[] {
  return Object.freeze(
    REAL_COUNTY_CAPABILITIES.map((capability: RealCountyCapability) => {
      const related = sources.filter((source) => source.capability === capability);
      const terminalStates = new Set(related.map(({ terminalState }) => terminalState));
      const state: CapabilityReleaseState['state'] =
        related.length === 0
          ? 'not_configured'
          : terminalStates.size > 1
            ? 'partial'
            : terminalStates.has('complete')
              ? 'succeeded'
              : terminalStates.has('partial')
                ? 'partial'
                : terminalStates.has('blocked')
                  ? 'blocked'
                  : 'failed';
      const limitations = uniqueStrings(related.flatMap(({ limitations }) => limitations));
      return Object.freeze({
        capability,
        state,
        sourceIds: Object.freeze(related.map(({ sourceId }) => sourceId).sort()),
        limitations: Object.freeze(
          state === 'succeeded'
            ? limitations
            : limitations.length > 0
              ? limitations
              : [
                  capability === 'transit_511_fallback' && state === 'not_configured'
                    ? 'No 511 fallback feed was configured; direct operator GTFS remains authoritative.'
                    : `${capability} did not reach a supported terminal state.`,
                ],
        ),
      });
    }),
  );
}

export function schemaSetSha256(source: SourceExecutionManifest): string {
  const hashes = [...new Set(source.schemaHashes)].sort();
  const only = hashes[0];
  if (hashes.length === 1 && only !== undefined) return only;
  return sha256(
    hashes.length === 0
      ? { sourceId: source.sourceId, schema: 'unavailable' }
      : { contract: 'sorted-schema-hash-set-v1', schemaHashes: hashes },
  );
}

function permission(
  redistribution: SourceExecutionManifest['license']['redistribution'],
): SourceSnapshotGate['publicProjectionPermission'] {
  if (redistribution === 'approved') return 'allowed';
  if (redistribution === 'restricted') return 'restricted';
  if (redistribution === 'prohibited') return 'prohibited';
  return 'pending';
}

export function sourceSnapshotGates(
  sources: readonly SourceExecutionManifest[],
): readonly SourceSnapshotGate[] {
  return Object.freeze(
    sources.map((source) =>
      Object.freeze({
        sourceId: source.sourceId,
        snapshotId: source.snapshotIdentity.observedContentId ?? source.snapshotIdentity.intentId,
        sourceSha256: source.sourceHash,
        schemaSha256: schemaSetSha256(source),
        asOf: source.sourceAsOf,
        terminalState:
          source.terminalState === 'complete' ? ('succeeded' as const) : source.terminalState,
        acquisitionPermission:
          source.supportState === 'blocked' ? ('blocked' as const) : ('allowed' as const),
        privateUsePermission:
          source.supportState === 'blocked' ? ('prohibited' as const) : ('allowed' as const),
        publicProjectionPermission: permission(source.license.redistribution),
        capabilityMetadataPublic: true,
        containsOwnerData:
          source.license.containsPersonalData ||
          source.capability === 'ownership_transfers' ||
          source.capability === 'santa_clara_fbn',
        limitations: uniqueStrings(source.limitations),
      }),
    ),
  );
}

function propertyRows(
  reconciled: DefaultReconciliation,
  features: readonly ReturnType<typeof deriveRoofAge>[],
  capabilities: readonly CapabilityReleaseState[],
): readonly ServingRow[] {
  const roofByProperty = new Map(features.map((feature) => [feature.propertyId, feature]));
  const state = new Map(capabilities.map(({ capability, state: value }) => [capability, value]));
  const unsupported = (capability: RealCountyCapability): string =>
    state.get(capability) === 'blocked' ? 'unsupported' : 'unknown';
  return Object.freeze(
    reconciled.canonical.entities
      .map(({ entity }) => entity)
      .filter(
        (entity): entity is Extract<CanonicalEntity, { entityKind: 'property' }> =>
          entity.entityKind === 'property',
      )
      .map((entity) => {
        const roof = roofByProperty.get(entity.id);
        return Object.freeze({
          property_id: entity.id,
          parcel_identifier: entity.apn,
          address_street: null,
          address_city: entity.jurisdiction,
          address_zip: null,
          latitude: null,
          longitude: null,
          roof_support_class: roof?.supportClass ?? 'unknown',
          roof_age_years: roof?.value?.ageYears ?? null,
          roof_reference_date: roof?.value?.basisDate ?? null,
          water_support_class: unsupported('noaa_shoreline'),
          water_distance_meters: null,
          water_visibility_state: null,
          ownership_support_class: unsupported('ownership_transfers'),
          years_since_exchange: null,
          last_exchange_date: null,
          regional_owner_support_class: unsupported('ownership_transfers'),
          is_regional_owner: null,
          transit_support_class: 'unknown',
          transit_distance_meters: null,
          transit_walk_minutes: null,
          starbucks_support_class: 'unknown',
          starbucks_distance_meters: null,
          starbucks_walk_minutes: null,
          combined_review_score: null,
          evidence_coverage: roof?.supportClass === 'supported' ? 1 / 6 : 0,
          visibility: 'restricted',
        });
      }),
  );
}

function evidenceRows(
  features: readonly ReturnType<typeof deriveRoofAge>[],
): readonly ServingRow[] {
  return Object.freeze(
    features.map((feature) =>
      Object.freeze({
        evidence_id: feature.evidence.evidenceId,
        property_id: feature.propertyId,
        feature: feature.feature,
        support_class: feature.supportClass,
        confidence: feature.confidence,
        as_of: feature.asOf,
        algorithm_name: feature.calculation.name,
        algorithm_version: feature.calculation.version,
        value_json: canonicalJson(feature.value),
        source_ids_json: canonicalJson(feature.coverage.sourceIds),
        source_references_json: canonicalJson(feature.sourceObservations),
        limitations_json: canonicalJson(feature.limitations),
        visibility: 'restricted',
      }),
    ),
  );
}

function releaseInput(
  input: Parameters<PipelineProcessors['buildMarts']>[0],
  reconciled: DefaultReconciliation,
  features: readonly ReturnType<typeof deriveRoofAge>[],
): Omit<RealCountyReleaseInput, 'outputDirectory'> {
  const capabilities = capabilityStates(input.sources);
  const snapshots = sourceSnapshotGates(input.sources);
  const property = propertyRows(reconciled, features, capabilities);
  const evidence = evidenceRows(features);
  const coverage: readonly ServingRow[] = Object.freeze(
    input.sources.map((source) =>
      Object.freeze({
        source_id: source.sourceId,
        scope: source.scope,
        support_class:
          source.terminalState === 'complete'
            ? 'supported'
            : source.terminalState === 'blocked'
              ? 'unsupported'
              : 'unknown',
        expected_count: source.coverage.expectedRecords,
        observed_count: source.coverage.acceptedRecords,
        quarantine_count: source.coverage.quarantinedRecords,
        source_sha256: source.sourceHash,
        schema_sha256: schemaSetSha256(source),
        as_of: source.sourceAsOf,
        limitations_json: canonicalJson(source.limitations),
      }),
    ),
  );
  const pipelineRuns: readonly ServingRow[] = Object.freeze([
    Object.freeze({
      run_id: input.run.runId,
      status: input.sources.every(({ terminalState }) => terminalState === 'complete')
        ? 'succeeded'
        : 'partial',
      started_at: input.run.requestedAt,
      completed_at: input.run.completedAt,
      pipeline_version: input.run.pipelineVersion,
      source_ids_json: canonicalJson(input.sources.map(({ sourceId }) => sourceId).sort()),
      expected_count: input.sources.every(({ coverage: item }) => item.expectedRecords !== null)
        ? input.sources.reduce((total, source) => total + (source.coverage.expectedRecords ?? 0), 0)
        : null,
      observed_count: input.sources.reduce(
        (total, source) => total + source.coverage.acceptedRecords,
        0,
      ),
      quarantine_count: input.sources.reduce(
        (total, source) => total + source.coverage.quarantinedRecords,
        0,
      ),
      limitations_json: canonicalJson(input.sources.flatMap(({ limitations }) => limitations)),
    }),
  ]);
  const buildSourceIds = Object.freeze(input.sources.map(({ sourceId }) => sourceId).sort());
  const releaseId = `santa-clara-${sha256({ runId: input.run.runId, snapshots }).slice(0, 24)}`;
  const sourceLineage = Object.freeze(
    snapshots.map(({ sourceId, snapshotId }) =>
      Object.freeze({ sourceId, snapshotId, role: 'direct' as const }),
    ),
  );
  const propertyEvidenceSourceIds = new Set(
    reconciled.canonical.entities
      .map(({ entity }) => entity)
      .filter(({ entityKind }) => entityKind === 'property' || entityKind === 'permit')
      .flatMap(({ lineage }) => lineage.map(({ sourceRecord }) => sourceRecord.sourceId)),
  );
  const derivedLineage = Object.freeze(
    input.sources
      .filter(
        (source) =>
          source.coverage.acceptedRecords > 0 && propertyEvidenceSourceIds.has(source.sourceId),
      )
      .map((source) => snapshots.find(({ sourceId }) => sourceId === source.sourceId))
      .filter((snapshot): snapshot is SourceSnapshotGate => snapshot !== undefined)
      .map(({ sourceId, snapshotId }) =>
        Object.freeze({ sourceId, snapshotId, role: 'derived' as const }),
      ),
  );
  if (derivedLineage.length === 0) {
    throw new Error('Portable property marts require at least one non-blocked source snapshot');
  }
  return Object.freeze({
    build: Object.freeze({
      releaseId,
      runId: input.run.runId,
      generatedAt: input.run.completedAt,
      sourceIds: buildSourceIds,
      profiles: Object.freeze([
        Object.freeze({
          visibility: 'public' as const,
          relations: Object.freeze({ source_coverage: coverage, pipeline_runs: pipelineRuns }),
        }),
        Object.freeze({
          visibility: 'restricted' as const,
          relations: Object.freeze({ property_query: property, property_evidence: evidence }),
        }),
      ]),
    }),
    releaseScope: input.run.profile === 'pilot' ? 'pilot' : 'partial_county',
    permitAuthoritiesCovered: input.sources.some(
      ({ capability, coverage: item }) =>
        capability === 'san_jose_permits' && item.acceptedRecords > 0,
    )
      ? 1
      : 0,
    permitAuthoritiesTotal: 16 as const,
    sourceSnapshots: snapshots,
    capabilities,
    artifactPolicies: Object.freeze([
      Object.freeze({
        visibility: 'public' as const,
        relation: 'source_coverage' as const,
        contentClass: 'capability_metadata' as const,
        sourceLineage,
        limitations: Object.freeze([
          'Coverage rows are redacted capability metadata, not source payloads.',
        ]),
      }),
      Object.freeze({
        visibility: 'public' as const,
        relation: 'pipeline_runs' as const,
        contentClass: 'capability_metadata' as const,
        sourceLineage,
        limitations: Object.freeze(['Run evidence contains counts and hashes only.']),
      }),
      Object.freeze({
        visibility: 'restricted' as const,
        relation: 'property_query' as const,
        contentClass: 'derived_data' as const,
        sourceLineage: derivedLineage,
        limitations: Object.freeze([
          'Unknown feature fields remain null and cannot be interpreted as negative facts.',
        ]),
      }),
      Object.freeze({
        visibility: 'restricted' as const,
        relation: 'property_evidence' as const,
        contentClass: 'derived_data' as const,
        sourceLineage: derivedLineage,
        limitations: Object.freeze([
          'Evidence remains restricted until every source license gate passes.',
        ]),
      }),
    ]),
  });
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
    buildMarts: (input: Parameters<PipelineProcessors['buildMarts']>[0], signal: AbortSignal) => {
      signal.throwIfAborted();
      const reconciled = input.reconciled as DefaultReconciliation;
      const features = input.features as readonly ReturnType<typeof deriveRoofAge>[];
      return Promise.resolve(
        Object.freeze({
          format: 'oracle-real-county-portable-release-input-v1',
          properties: Object.freeze(
            reconciled.canonical.entities
              .filter(({ entity }) => entity.entityKind === 'property')
              .map(({ entity }) => entity),
          ),
          featureEvidence: features,
          portableReleaseInput: releaseInput(input, reconciled, features),
        }),
      );
    },
  });
}
