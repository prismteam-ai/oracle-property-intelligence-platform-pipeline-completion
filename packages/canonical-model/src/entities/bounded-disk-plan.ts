/**
 * Frozen DuckDB-compatible storage plan for bounded canonical reduction.
 * The runtime owns the connection and streams parameters/results; this package
 * owns the relational invariants and never requests a process-wide result set.
 */
export const BOUNDED_CANONICAL_DISK_PLAN_VERSION = 'bounded-canonical-disk-plan-v1' as const;

export const BOUNDED_CANONICAL_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS bounded_mutation_identity (
     generation_id VARCHAR NOT NULL,
     mutation_id VARCHAR NOT NULL,
     content_sha256 VARCHAR NOT NULL,
     partition_id UINTEGER NOT NULL,
     PRIMARY KEY (generation_id, mutation_id)
   )`,
  `CREATE TABLE IF NOT EXISTS bounded_canonical_entity (
     generation_id VARCHAR NOT NULL,
     partition_id UINTEGER NOT NULL,
     entity_id VARCHAR NOT NULL,
     entity_kind VARCHAR NOT NULL,
     visibility VARCHAR NOT NULL,
     entity_json JSON NOT NULL,
     entity_sha256 VARCHAR NOT NULL,
     PRIMARY KEY (generation_id, entity_id)
   )`,
  `CREATE TABLE IF NOT EXISTS bounded_canonical_observation (
     generation_id VARCHAR NOT NULL,
     entity_id VARCHAR NOT NULL,
     field_path VARCHAR NOT NULL,
     observation_id VARCHAR NOT NULL,
     visibility VARCHAR NOT NULL,
     observation_json JSON NOT NULL,
     observation_sha256 VARCHAR NOT NULL,
     PRIMARY KEY (generation_id, observation_id)
   )`,
  `CREATE TABLE IF NOT EXISTS bounded_canonical_conflict (
     generation_id VARCHAR NOT NULL,
     entity_id VARCHAR NOT NULL,
     field_path VARCHAR NOT NULL,
     conflict_id VARCHAR NOT NULL,
     conflict_json JSON NOT NULL,
     conflict_sha256 VARCHAR NOT NULL,
     PRIMARY KEY (generation_id, conflict_id)
   )`,
  `CREATE TABLE IF NOT EXISTS bounded_preferred_observation (
     generation_id VARCHAR NOT NULL,
     entity_id VARCHAR NOT NULL,
     field_path VARCHAR NOT NULL,
     ordinal UINTEGER NOT NULL,
     observation_id VARCHAR NOT NULL,
     PRIMARY KEY (generation_id, entity_id, field_path, ordinal)
   )`,
  `CREATE TABLE IF NOT EXISTS bounded_link_candidate (
     generation_id VARCHAR NOT NULL,
     partition_id UINTEGER NOT NULL,
     from_entity_id VARCHAR NOT NULL,
     to_entity_id VARCHAR NOT NULL,
     link_id VARCHAR NOT NULL,
     link_json JSON NOT NULL,
     link_sha256 VARCHAR NOT NULL,
     PRIMARY KEY (generation_id, link_id)
   )`,
  `CREATE TABLE IF NOT EXISTS bounded_artifact_reference (
     generation_id VARCHAR NOT NULL,
     partition_id UINTEGER NOT NULL,
     artifact_id VARCHAR NOT NULL,
     role VARCHAR NOT NULL,
     artifact_json JSON NOT NULL,
     artifact_sha256 VARCHAR NOT NULL,
     PRIMARY KEY (generation_id, artifact_id, role)
   )`,
  `CREATE TABLE IF NOT EXISTS bounded_partition_commit (
     generation_id VARCHAR NOT NULL,
     stage VARCHAR NOT NULL,
     partition_id UINTEGER NOT NULL,
     input_sha256 VARCHAR NOT NULL,
     summary_sha256 VARCHAR NOT NULL,
     committed_at TIMESTAMP NOT NULL,
     PRIMARY KEY (generation_id, stage, partition_id)
   )`,
  'CREATE INDEX IF NOT EXISTS bounded_entity_kind_idx ON bounded_canonical_entity(generation_id, entity_kind, entity_id)',
  'CREATE INDEX IF NOT EXISTS bounded_observation_entity_idx ON bounded_canonical_observation(generation_id, entity_id, field_path, observation_id)',
  'CREATE INDEX IF NOT EXISTS bounded_link_from_idx ON bounded_link_candidate(generation_id, from_entity_id, link_id)',
] as const);

export const BOUNDED_CANONICAL_ORDERED_SCANS = Object.freeze({
  entities:
    'SELECT entity_json FROM bounded_canonical_entity WHERE generation_id = ? ORDER BY entity_id',
  observations:
    'SELECT observation_json FROM bounded_canonical_observation WHERE generation_id = ? ORDER BY entity_id, field_path, observation_id',
  conflicts:
    'SELECT conflict_json FROM bounded_canonical_conflict WHERE generation_id = ? ORDER BY entity_id, field_path, conflict_id',
  links:
    'SELECT link_json FROM bounded_link_candidate WHERE generation_id = ? ORDER BY from_entity_id, link_id',
  artifacts:
    'SELECT artifact_json FROM bounded_artifact_reference WHERE generation_id = ? ORDER BY artifact_id, role',
} as const);
