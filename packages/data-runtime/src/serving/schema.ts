export type ServingVisibility = 'public' | 'restricted';

export type ServingScalar = null | boolean | number | string;
export type ServingRow = Readonly<Record<string, ServingScalar>>;

export type ServingColumn = Readonly<{
  name: string;
  duckdbType: 'VARCHAR' | 'BOOLEAN' | 'BIGINT' | 'DOUBLE';
  nullable: boolean;
  description: string;
}>;

export type ServingRelationName =
  | 'canonical_history'
  | 'property_query'
  | 'elephant_properties'
  | 'property_evidence'
  | 'source_coverage'
  | 'field_coverage'
  | 'relation_coverage'
  | 'pipeline_runs'
  | 'data_dictionary';

export type ServingRelationDefinition = Readonly<{
  name: ServingRelationName;
  fileName: string;
  grain: string;
  columns: readonly ServingColumn[];
  sortColumns: readonly string[];
  uniqueColumns: readonly string[];
  allowedVisibilities: readonly ServingVisibility[];
}>;

const column = (
  name: string,
  duckdbType: ServingColumn['duckdbType'],
  nullable: boolean,
  description: string,
): ServingColumn => Object.freeze({ name, duckdbType, nullable, description });

const featureColumns = (
  prefix: string,
  valueColumns: readonly ServingColumn[],
): readonly ServingColumn[] => [
  column(`${prefix}_support_class`, 'VARCHAR', false, `${prefix} evidence support class.`),
  ...valueColumns,
];

export const ELEPHANT_PROPERTY_COLUMNS: readonly ServingColumn[] = Object.freeze([
  column('property_id', 'VARCHAR', false, 'Stable property identifier.'),
  column('property_cid', 'VARCHAR', true, 'Immutable per-property JSON CID, when published.'),
  column('request_identifier', 'VARCHAR', true, 'Source request or lookup identifier.'),
  column('parcel_identifier', 'VARCHAR', true, 'County parcel identifier or APN.'),
  column('source_system', 'VARCHAR', true, 'Elephant source-system discriminator.'),
  column('county_name', 'VARCHAR', true, 'Human-readable county name.'),
  column('state_code', 'VARCHAR', true, 'Two-letter state code.'),
  column('address_street', 'VARCHAR', true, 'Situs street line.'),
  column('address_city', 'VARCHAR', true, 'Situs city.'),
  column('address_zip', 'VARCHAR', true, 'Situs postal code.'),
  column('latitude', 'DOUBLE', true, 'Property point latitude.'),
  column('longitude', 'DOUBLE', true, 'Property point longitude.'),
  column('lot_size_acre', 'DOUBLE', true, 'Lot size in acres.'),
  column('lot_area_sqft', 'DOUBLE', true, 'Lot area in square feet.'),
  column('exterior_wall_material', 'VARCHAR', true, 'Primary exterior wall material.'),
  column('roof_covering_material', 'VARCHAR', true, 'Primary roof covering material.'),
  column('property_type', 'VARCHAR', true, 'Structural property classification.'),
  column('property_usage_type', 'VARCHAR', true, 'Use or zoning classification.'),
  column('built_year', 'BIGINT', true, 'Primary structure build year.'),
  column('livable_floor_area', 'DOUBLE', true, 'Livable floor area in square feet.'),
  column('total_area', 'DOUBLE', true, 'Total building area in square feet.'),
  column('assessed_value', 'DOUBLE', true, 'Assessed value.'),
  column('market_value', 'DOUBLE', true, 'Market value.'),
  column('land_value', 'DOUBLE', true, 'Land-only value.'),
  column('avm_value', 'DOUBLE', true, 'Automated valuation estimate.'),
  column('owner_name', 'VARCHAR', true, 'Restricted primary owner name.'),
  column('owners_text', 'VARCHAR', true, 'Restricted searchable owner names.'),
  column('owner_count', 'BIGINT', true, 'Owner count.'),
  column('owner_occupied', 'BOOLEAN', true, 'Owner-occupied indicator.'),
  column('last_sale_date', 'VARCHAR', true, 'Most recent recorded sale date.'),
  column('last_sale_price', 'DOUBLE', true, 'Most recent recorded sale price.'),
  column('subdivision', 'VARCHAR', true, 'Subdivision name.'),
  column('has_permits', 'BOOLEAN', true, 'Known-permit indicator.'),
  column('permit_count', 'BIGINT', true, 'Known permit count.'),
  column('has_sunbiz_tenant', 'BOOLEAN', true, 'Sunbiz-linked tenant indicator.'),
  column('has_bbb_contractor', 'BOOLEAN', true, 'BBB-linked contractor indicator.'),
  column('hoa_flag', 'BOOLEAN', true, 'HOA indicator when supported.'),
]);

export const SERVING_RELATIONS: Readonly<Record<ServingRelationName, ServingRelationDefinition>> =
  Object.freeze({
    canonical_history: Object.freeze({
      name: 'canonical_history',
      fileName: 'canonical-history.parquet',
      grain: 'one row per canonical entity version',
      columns: Object.freeze([
        column('entity_id', 'VARCHAR', false, 'Canonical entity identifier.'),
        column('entity_kind', 'VARCHAR', false, 'Canonical entity kind.'),
        column('version', 'BIGINT', false, 'Monotonic entity version.'),
        column('valid_from', 'VARCHAR', false, 'ISO-8601 validity start.'),
        column('valid_to', 'VARCHAR', true, 'ISO-8601 validity end.'),
        column('recorded_at', 'VARCHAR', false, 'ISO-8601 materialization timestamp.'),
        column('source_ids_json', 'VARCHAR', false, 'Canonical JSON array of source identifiers.'),
        column('payload_json', 'VARCHAR', false, 'Canonical JSON entity payload.'),
        column('lineage_json', 'VARCHAR', false, 'Canonical JSON field lineage.'),
        column('visibility', 'VARCHAR', false, 'Row visibility class.'),
      ]),
      sortColumns: Object.freeze(['entity_kind', 'entity_id', 'version']),
      uniqueColumns: Object.freeze(['entity_id', 'version']),
      allowedVisibilities: Object.freeze(['public', 'restricted'] as const),
    }),
    property_query: Object.freeze({
      name: 'property_query',
      fileName: 'property-query.parquet',
      grain: 'exactly one row per property_id',
      columns: Object.freeze([
        column('property_id', 'VARCHAR', false, 'Stable property identifier.'),
        column('parcel_identifier', 'VARCHAR', false, 'Normalized county parcel identifier.'),
        column('address_street', 'VARCHAR', true, 'Public situs street line.'),
        column('address_city', 'VARCHAR', true, 'Public situs city.'),
        column('address_zip', 'VARCHAR', true, 'Public situs postal code.'),
        column('latitude', 'DOUBLE', true, 'Public property point latitude.'),
        column('longitude', 'DOUBLE', true, 'Public property point longitude.'),
        ...featureColumns('roof', [
          column('roof_age_years', 'BIGINT', true, 'Supported or proxy roof age in whole years.'),
          column('roof_reference_date', 'VARCHAR', true, 'Evidence date used for roof age.'),
        ]),
        ...featureColumns('water', [
          column('water_distance_meters', 'DOUBLE', true, 'Distance to evaluated water feature.'),
          column('water_visibility_state', 'VARCHAR', true, 'Terrain visibility candidate state.'),
        ]),
        ...featureColumns('ownership', [
          column('years_since_exchange', 'BIGINT', true, 'Whole years since verified exchange.'),
          column('last_exchange_date', 'VARCHAR', true, 'Latest verified exchange date.'),
        ]),
        ...featureColumns('regional_owner', [
          column('is_regional_owner', 'BOOLEAN', true, 'Versioned coarse regional-owner result.'),
        ]),
        ...featureColumns('transit', [
          column(
            'transit_distance_meters',
            'DOUBLE',
            true,
            'Pedestrian network distance to transit.',
          ),
          column(
            'transit_walk_minutes',
            'DOUBLE',
            true,
            'Estimated pedestrian minutes to transit.',
          ),
        ]),
        ...featureColumns('starbucks', [
          column(
            'starbucks_distance_meters',
            'DOUBLE',
            true,
            'Pedestrian network distance to Starbucks.',
          ),
          column(
            'starbucks_walk_minutes',
            'DOUBLE',
            true,
            'Estimated pedestrian minutes to Starbucks.',
          ),
        ]),
        column('combined_review_score', 'DOUBLE', true, 'Transparent deterministic review score.'),
        column(
          'evidence_coverage',
          'DOUBLE',
          false,
          'Fraction of configured evidence weight supported.',
        ),
        column('visibility', 'VARCHAR', false, 'Row visibility class.'),
      ]),
      sortColumns: Object.freeze(['property_id']),
      uniqueColumns: Object.freeze(['property_id']),
      allowedVisibilities: Object.freeze(['public', 'restricted'] as const),
    }),
    elephant_properties: Object.freeze({
      name: 'elephant_properties',
      fileName: 'elephant-properties.parquet',
      grain: 'exactly one row per Elephant property_id',
      columns: ELEPHANT_PROPERTY_COLUMNS,
      sortColumns: Object.freeze(['property_id']),
      uniqueColumns: Object.freeze(['property_id']),
      allowedVisibilities: Object.freeze(['restricted'] as const),
    }),
    property_evidence: Object.freeze({
      name: 'property_evidence',
      fileName: 'property-evidence.parquet',
      grain: 'one row per immutable evidence_id',
      columns: Object.freeze([
        column('evidence_id', 'VARCHAR', false, 'Immutable evidence identifier.'),
        column('property_id', 'VARCHAR', false, 'Referenced property identifier.'),
        column('feature', 'VARCHAR', false, 'Feature or inquiry kind.'),
        column('support_class', 'VARCHAR', false, 'supported, proxy, unknown, or unsupported.'),
        column('confidence', 'DOUBLE', false, 'Confidence in the closed interval [0,1].'),
        column('as_of', 'VARCHAR', false, 'ISO-8601 evidence timestamp.'),
        column('algorithm_name', 'VARCHAR', false, 'Deterministic algorithm name.'),
        column('algorithm_version', 'VARCHAR', false, 'Exact algorithm version.'),
        column('value_json', 'VARCHAR', false, 'Canonical JSON evidence value.'),
        column('source_ids_json', 'VARCHAR', false, 'Canonical JSON source identifier array.'),
        column('source_references_json', 'VARCHAR', false, 'Canonical JSON source references.'),
        column('limitations_json', 'VARCHAR', false, 'Canonical JSON limitations array.'),
        column('visibility', 'VARCHAR', false, 'Row visibility class.'),
      ]),
      sortColumns: Object.freeze(['property_id', 'feature', 'evidence_id']),
      uniqueColumns: Object.freeze(['evidence_id']),
      allowedVisibilities: Object.freeze(['public', 'restricted'] as const),
    }),
    source_coverage: Object.freeze({
      name: 'source_coverage',
      fileName: 'source-coverage.parquet',
      grain: 'one row per source and measured scope',
      columns: Object.freeze([
        column('source_id', 'VARCHAR', false, 'Stable source identifier.'),
        column('scope', 'VARCHAR', false, 'Coverage scope.'),
        column('support_class', 'VARCHAR', false, 'Coverage support class.'),
        column('expected_count', 'BIGINT', true, 'Expected denominator, null when unavailable.'),
        column('observed_count', 'BIGINT', false, 'Observed accepted count.'),
        column('quarantine_count', 'BIGINT', false, 'Quarantined row count.'),
        column('source_sha256', 'VARCHAR', false, 'Immutable source-byte hash.'),
        column('schema_sha256', 'VARCHAR', false, 'Source schema fingerprint.'),
        column('as_of', 'VARCHAR', true, 'Source as-of timestamp.'),
        column('limitations_json', 'VARCHAR', false, 'Canonical JSON limitations array.'),
      ]),
      sortColumns: Object.freeze(['source_id', 'scope']),
      uniqueColumns: Object.freeze(['source_id', 'scope']),
      allowedVisibilities: Object.freeze(['public', 'restricted'] as const),
    }),
    field_coverage: Object.freeze({
      name: 'field_coverage',
      fileName: 'field-coverage.parquet',
      grain: 'one row per relation and field',
      columns: Object.freeze([
        column('relation_name', 'VARCHAR', false, 'Serving or canonical relation.'),
        column('field_name', 'VARCHAR', false, 'Field name.'),
        column('support_class', 'VARCHAR', false, 'Field support class.'),
        column('numerator', 'BIGINT', false, 'Non-null supported row count.'),
        column('denominator', 'BIGINT', false, 'Declared field denominator.'),
        column('ratio', 'DOUBLE', false, 'numerator / denominator, or zero for zero denominator.'),
        column('source_ids_json', 'VARCHAR', false, 'Canonical JSON source identifier array.'),
        column('limitations_json', 'VARCHAR', false, 'Canonical JSON limitations array.'),
      ]),
      sortColumns: Object.freeze(['relation_name', 'field_name']),
      uniqueColumns: Object.freeze(['relation_name', 'field_name']),
      allowedVisibilities: Object.freeze(['public', 'restricted'] as const),
    }),
    relation_coverage: Object.freeze({
      name: 'relation_coverage',
      fileName: 'relation-coverage.parquet',
      grain: 'one row per relationship type',
      columns: Object.freeze([
        column('relation_name', 'VARCHAR', false, 'Canonical relationship type.'),
        column('support_class', 'VARCHAR', false, 'Relationship support class.'),
        column('linked_count', 'BIGINT', false, 'Linked canonical entity count.'),
        column('eligible_count', 'BIGINT', false, 'Eligible denominator.'),
        column('ratio', 'DOUBLE', false, 'linked_count / eligible_count.'),
        column('method_version', 'VARCHAR', false, 'Linking policy version.'),
        column('limitations_json', 'VARCHAR', false, 'Canonical JSON limitations array.'),
      ]),
      sortColumns: Object.freeze(['relation_name']),
      uniqueColumns: Object.freeze(['relation_name']),
      allowedVisibilities: Object.freeze(['public', 'restricted'] as const),
    }),
    pipeline_runs: Object.freeze({
      name: 'pipeline_runs',
      fileName: 'pipeline-runs.parquet',
      grain: 'one row per immutable pipeline run',
      columns: Object.freeze([
        column('run_id', 'VARCHAR', false, 'Pipeline run identifier.'),
        column('status', 'VARCHAR', false, 'Terminal or active run status.'),
        column('started_at', 'VARCHAR', false, 'ISO-8601 start timestamp.'),
        column('completed_at', 'VARCHAR', true, 'ISO-8601 completion timestamp.'),
        column('pipeline_version', 'VARCHAR', false, 'Exact pipeline version.'),
        column('source_ids_json', 'VARCHAR', false, 'Canonical JSON source identifier array.'),
        column('expected_count', 'BIGINT', true, 'Expected total when known.'),
        column('observed_count', 'BIGINT', false, 'Observed total.'),
        column('quarantine_count', 'BIGINT', false, 'Quarantined total.'),
        column('limitations_json', 'VARCHAR', false, 'Canonical JSON limitations array.'),
      ]),
      sortColumns: Object.freeze(['started_at', 'run_id']),
      uniqueColumns: Object.freeze(['run_id']),
      allowedVisibilities: Object.freeze(['public', 'restricted'] as const),
    }),
    data_dictionary: Object.freeze({
      name: 'data_dictionary',
      fileName: 'data-dictionary.parquet',
      grain: 'one row per released relation column',
      columns: Object.freeze([
        column('relation_name', 'VARCHAR', false, 'Released DuckDB relation.'),
        column('ordinal', 'BIGINT', false, 'One-based column ordinal.'),
        column('column_name', 'VARCHAR', false, 'Column name.'),
        column('duckdb_type', 'VARCHAR', false, 'Stable DuckDB logical type.'),
        column('nullable', 'BOOLEAN', false, 'Whether null values are allowed.'),
        column('grain', 'VARCHAR', false, 'Relation row grain.'),
        column('description', 'VARCHAR', false, 'Field semantics.'),
        column('visibility', 'VARCHAR', false, 'Artifact visibility.'),
      ]),
      sortColumns: Object.freeze(['relation_name', 'ordinal']),
      uniqueColumns: Object.freeze(['relation_name', 'ordinal']),
      allowedVisibilities: Object.freeze(['public', 'restricted'] as const),
    }),
  });

export const PUBLIC_PROHIBITED_COLUMN_PATTERN =
  /(^|_)(owner_name|owners_text|mailing_address|grantor|grantee|email|phone|contact)(_|$)/iu;

export function relationDefinition(name: ServingRelationName): ServingRelationDefinition {
  return SERVING_RELATIONS[name];
}
