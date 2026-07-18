import type { AnalyticalParameter, AnalyticalQuery } from '@oracle/data-runtime/analytical-runtime';

export const SERVING_TIMEOUT_MILLISECONDS = 5_000;
export const SERVING_SCAN_BYTES_MAXIMUM = 512 * 1024 * 1024;
export const SERVING_PAGE_SIZE_MAXIMUM = 100;

export type GeneralPlanName =
  | 'get_dataset_info'
  | 'get_dataset_coverage_source'
  | 'get_dataset_coverage_field'
  | 'get_dataset_coverage_relation'
  | 'list_pipeline_runs'
  | 'get_pipeline_run'
  | 'search_properties_by_property_id'
  | 'search_properties_by_address'
  | 'search_properties_by_parcel_identifier'
  | 'get_property'
  | 'get_property_evidence'
  | 'list_artifacts'
  | 'get_data_dictionary';

const statements: Readonly<Record<GeneralPlanName, string>> = Object.freeze({
  get_dataset_info: `
SELECT
  (SELECT count(*)::BIGINT FROM property_query WHERE visibility = 'public') AS property_count,
  (SELECT count(DISTINCT source_id)::BIGINT FROM source_coverage) AS source_count,
  (SELECT count(*)::BIGINT FROM pipeline_runs) AS pipeline_run_count,
  (SELECT run_id FROM pipeline_runs ORDER BY started_at DESC, run_id ASC LIMIT 1) AS latest_run_id,
  (SELECT status FROM pipeline_runs ORDER BY started_at DESC, run_id ASC LIMIT 1) AS latest_run_status`,
  get_dataset_coverage_source: `
SELECT source_id, scope, support_class, expected_count, observed_count, quarantine_count,
  source_sha256, schema_sha256, as_of, limitations_json
FROM source_coverage
ORDER BY source_id ASC, scope ASC
LIMIT ?`,
  get_dataset_coverage_field: `
SELECT relation_name, field_name, support_class, numerator, denominator, ratio,
  source_ids_json, limitations_json
FROM field_coverage
ORDER BY relation_name ASC, field_name ASC
LIMIT ?`,
  get_dataset_coverage_relation: `
SELECT relation_name, support_class, linked_count, eligible_count, ratio,
  method_version, limitations_json
FROM relation_coverage
ORDER BY relation_name ASC
LIMIT ?`,
  list_pipeline_runs: `
SELECT run_id, status, started_at, completed_at, pipeline_version, source_ids_json,
  expected_count, observed_count, quarantine_count, limitations_json
FROM pipeline_runs
WHERE (? IS NULL OR started_at < ? OR (started_at = ? AND run_id > ?))
ORDER BY started_at DESC, run_id ASC
LIMIT ?`,
  get_pipeline_run: `
SELECT run_id, status, started_at, completed_at, pipeline_version, source_ids_json,
  expected_count, observed_count, quarantine_count, limitations_json
FROM pipeline_runs
WHERE run_id = ?
ORDER BY run_id ASC
LIMIT 2`,
  search_properties_by_property_id: `
SELECT property_id, parcel_identifier, address_street, address_city, address_zip,
  latitude, longitude, roof_support_class, water_support_class, ownership_support_class,
  regional_owner_support_class, transit_support_class, starbucks_support_class,
  combined_review_score, evidence_coverage
FROM property_query
WHERE visibility = 'public'
  AND (? IS NULL OR address_city = ?)
  AND (? IS NULL OR address_zip = ?)
  AND (? IS NULL OR property_id = ?)
  AND (? IS NULL OR parcel_identifier = ?)
  AND (? IS NULL OR property_id = ? OR parcel_identifier = ?
    OR contains(lower(coalesce(address_street, '')), lower(?)))
  AND (? IS NULL OR property_id > ?)
ORDER BY property_id ASC
LIMIT ?`,
  search_properties_by_address: `
SELECT property_id, parcel_identifier, address_street, address_city, address_zip,
  latitude, longitude, roof_support_class, water_support_class, ownership_support_class,
  regional_owner_support_class, transit_support_class, starbucks_support_class,
  combined_review_score, evidence_coverage
FROM property_query
WHERE visibility = 'public'
  AND (? IS NULL OR address_city = ?)
  AND (? IS NULL OR address_zip = ?)
  AND (? IS NULL OR property_id = ?)
  AND (? IS NULL OR parcel_identifier = ?)
  AND (? IS NULL OR property_id = ? OR parcel_identifier = ?
    OR contains(lower(coalesce(address_street, '')), lower(?)))
  AND (? IS NULL OR coalesce(address_street, '') > ?
    OR (coalesce(address_street, '') = ? AND property_id > ?))
ORDER BY coalesce(address_street, '') ASC, property_id ASC
LIMIT ?`,
  search_properties_by_parcel_identifier: `
SELECT property_id, parcel_identifier, address_street, address_city, address_zip,
  latitude, longitude, roof_support_class, water_support_class, ownership_support_class,
  regional_owner_support_class, transit_support_class, starbucks_support_class,
  combined_review_score, evidence_coverage
FROM property_query
WHERE visibility = 'public'
  AND (? IS NULL OR address_city = ?)
  AND (? IS NULL OR address_zip = ?)
  AND (? IS NULL OR property_id = ?)
  AND (? IS NULL OR parcel_identifier = ?)
  AND (? IS NULL OR property_id = ? OR parcel_identifier = ?
    OR contains(lower(coalesce(address_street, '')), lower(?)))
  AND (? IS NULL OR coalesce(parcel_identifier, '') > ?
    OR (coalesce(parcel_identifier, '') = ? AND property_id > ?))
ORDER BY coalesce(parcel_identifier, '') ASC, property_id ASC
LIMIT ?`,
  get_property: `
SELECT * FROM property_query
WHERE visibility = 'public' AND property_id = ?
ORDER BY property_id ASC
LIMIT 2`,
  get_property_evidence: `
SELECT evidence_id, property_id, feature, support_class, confidence, as_of,
  algorithm_name, algorithm_version, value_json, source_ids_json,
  source_references_json, limitations_json, visibility
FROM property_evidence
WHERE visibility = 'public'
  AND property_id = ?
  AND (? IS NULL OR feature = ?)
  AND (? IS NULL OR evidence_id > ?)
ORDER BY evidence_id ASC
LIMIT ?`,
  list_artifacts: `
SELECT relation, media_type, byte_size, sha256, row_count, schema_sha256,
  grain, limitations_json, visibility
FROM release_artifacts
WHERE visibility = 'public'
  AND (? IS NULL OR relation > ?)
ORDER BY relation ASC
LIMIT ?`,
  get_data_dictionary: `
SELECT relation_name, ordinal, column_name, duckdb_type, nullable, grain,
  description, visibility
FROM data_dictionary
WHERE visibility = 'public'
  AND (? IS NULL OR relation_name = ?)
  AND (? IS NULL OR relation_name > ? OR (relation_name = ? AND ordinal > ?))
ORDER BY relation_name ASC, ordinal ASC
LIMIT ?`,
});

const operations: Readonly<Record<GeneralPlanName, string>> = Object.freeze({
  get_dataset_info: 'serving.get_dataset_info@1.0.0',
  get_dataset_coverage_source: 'serving.get_dataset_coverage.source@1.0.0',
  get_dataset_coverage_field: 'serving.get_dataset_coverage.field@1.0.0',
  get_dataset_coverage_relation: 'serving.get_dataset_coverage.relation@1.0.0',
  list_pipeline_runs: 'serving.list_pipeline_runs@1.0.0',
  get_pipeline_run: 'serving.get_pipeline_run@1.0.0',
  search_properties_by_property_id: 'serving.search_properties@1.0.0',
  search_properties_by_address: 'serving.search_properties@1.0.0',
  search_properties_by_parcel_identifier: 'serving.search_properties@1.0.0',
  get_property: 'serving.get_property@1.0.0',
  get_property_evidence: 'serving.get_property_evidence@1.0.0',
  list_artifacts: 'serving.list_artifacts@1.0.0',
  get_data_dictionary: 'serving.get_data_dictionary@1.0.0',
});

export function fixedGeneralQuery(
  name: GeneralPlanName,
  parameters: readonly AnalyticalParameter[],
  maximumRows = SERVING_PAGE_SIZE_MAXIMUM + 1,
): AnalyticalQuery {
  return Object.freeze({
    operation: operations[name],
    statement: statements[name],
    parameters: Object.freeze([...parameters]),
    timeoutMs: SERVING_TIMEOUT_MILLISECONDS,
    maximumScanBytes: SERVING_SCAN_BYTES_MAXIMUM,
    maximumRows,
  });
}
