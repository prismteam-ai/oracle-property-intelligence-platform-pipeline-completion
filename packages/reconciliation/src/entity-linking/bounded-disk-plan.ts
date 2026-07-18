/** Disk-backed cross-partition index plan consumed through streaming row APIs. */
export const BOUNDED_LINK_INDEX_PLAN_VERSION = 'bounded-link-index-plan-v1' as const;

export const BOUNDED_LINK_INDEX_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS bounded_linkable_entity (
     generation_id VARCHAR NOT NULL,
     entity_id VARCHAR NOT NULL,
     entity_kind VARCHAR NOT NULL,
     jurisdiction_norm VARCHAR NOT NULL,
     evidence_availability VARCHAR NOT NULL,
     visibility VARCHAR NOT NULL,
     entity_json JSON NOT NULL,
     entity_sha256 VARCHAR NOT NULL,
     PRIMARY KEY (generation_id, entity_id)
   )`,
  `CREATE TABLE IF NOT EXISTS bounded_authority_identifier (
     generation_id VARCHAR NOT NULL,
     entity_id VARCHAR NOT NULL,
     scheme VARCHAR NOT NULL,
     scope VARCHAR NOT NULL,
     value_norm VARCHAR NOT NULL,
     PRIMARY KEY (generation_id, entity_id, scheme, scope, value_norm)
   )`,
  `CREATE TABLE IF NOT EXISTS bounded_normalized_exact_key (
     generation_id VARCHAR NOT NULL,
     entity_id VARCHAR NOT NULL,
     key_kind VARCHAR NOT NULL,
     value_norm VARCHAR NOT NULL,
     PRIMARY KEY (generation_id, entity_id, key_kind, value_norm)
   )`,
  `CREATE TABLE IF NOT EXISTS bounded_candidate_attribute (
     generation_id VARCHAR NOT NULL,
     entity_id VARCHAR NOT NULL,
     attribute_name VARCHAR NOT NULL,
     value_norm VARCHAR NOT NULL,
     PRIMARY KEY (generation_id, entity_id, attribute_name)
   )`,
  `CREATE TABLE IF NOT EXISTS bounded_review_decision (
     generation_id VARCHAR NOT NULL,
     relation VARCHAR NOT NULL,
     subject_entity_id VARCHAR NOT NULL,
     decision_id VARCHAR NOT NULL,
     decision_json JSON NOT NULL,
     PRIMARY KEY (generation_id, decision_id)
   )`,
  `CREATE TABLE IF NOT EXISTS bounded_link_resolution (
     generation_id VARCHAR NOT NULL,
     relation VARCHAR NOT NULL,
     subject_entity_id VARCHAR NOT NULL,
     resolution_json JSON NOT NULL,
     resolution_sha256 VARCHAR NOT NULL,
     PRIMARY KEY (generation_id, relation, subject_entity_id)
   )`,
  `CREATE TABLE IF NOT EXISTS bounded_reconciliation_subject_claim (
     generation_id VARCHAR NOT NULL,
     relation VARCHAR NOT NULL,
     subject_entity_id VARCHAR NOT NULL,
     input_sha256 VARCHAR NOT NULL,
     claim_state VARCHAR NOT NULL CHECK (claim_state IN ('claimed', 'completed')),
     resolution_sha256 VARCHAR,
     CHECK ((claim_state = 'claimed' AND resolution_sha256 IS NULL)
         OR (claim_state = 'completed' AND resolution_sha256 IS NOT NULL)),
     PRIMARY KEY (generation_id, relation, subject_entity_id)
   )`,
  `CREATE TABLE IF NOT EXISTS bounded_duplicate_member (
     generation_id VARCHAR NOT NULL,
     relation VARCHAR NOT NULL,
     classification VARCHAR NOT NULL,
     duplicate_key VARCHAR NOT NULL,
     entity_id VARCHAR NOT NULL,
     PRIMARY KEY (generation_id, relation, classification, duplicate_key, entity_id)
   )`,
  'CREATE INDEX IF NOT EXISTS bounded_linkable_kind_idx ON bounded_linkable_entity(generation_id, entity_kind, entity_id)',
  'CREATE INDEX IF NOT EXISTS bounded_authority_lookup_idx ON bounded_authority_identifier(generation_id, scheme, scope, value_norm, entity_id)',
  'CREATE INDEX IF NOT EXISTS bounded_exact_lookup_idx ON bounded_normalized_exact_key(generation_id, key_kind, value_norm, entity_id)',
  'CREATE INDEX IF NOT EXISTS bounded_candidate_lookup_idx ON bounded_candidate_attribute(generation_id, attribute_name, value_norm, entity_id)',
  'CREATE INDEX IF NOT EXISTS bounded_review_subject_idx ON bounded_review_decision(generation_id, relation, subject_entity_id, decision_id)',
  'CREATE INDEX IF NOT EXISTS bounded_duplicate_relation_idx ON bounded_duplicate_member(generation_id, relation, classification, duplicate_key, entity_id)',
] as const);

export const BOUNDED_SUBJECT_CLAIM_QUERY = `
SELECT input_sha256, claim_state, resolution_sha256
FROM bounded_reconciliation_subject_claim
WHERE generation_id = ? AND relation = ? AND subject_entity_id = ?` as const;

/** Atomically creates or reopens the durable claim before any resolution work begins. */
export const BOUNDED_SUBJECT_CLAIM_TRANSACTION = Object.freeze([
  'BEGIN TRANSACTION',
  `INSERT INTO bounded_reconciliation_subject_claim
     (generation_id, relation, subject_entity_id, input_sha256, claim_state, resolution_sha256)
   VALUES (?, ?, ?, ?, 'claimed', NULL)
   ON CONFLICT (generation_id, relation, subject_entity_id) DO NOTHING`,
  BOUNDED_SUBJECT_CLAIM_QUERY,
  'COMMIT',
] as const);

/**
 * Repository adapters execute these statements in one serializable transaction.
 * An existing `claimed` row with the same input is recoverable; a `completed`
 * row is replayable; a different input hash is an integrity conflict.
 */
export const BOUNDED_SUBJECT_COMMIT_TRANSACTION = Object.freeze([
  'BEGIN TRANSACTION',
  `INSERT INTO bounded_link_resolution
     (generation_id, relation, subject_entity_id, resolution_json, resolution_sha256)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT (generation_id, relation, subject_entity_id) DO UPDATE SET
     resolution_json = excluded.resolution_json,
     resolution_sha256 = excluded.resolution_sha256
   WHERE bounded_link_resolution.resolution_sha256 = excluded.resolution_sha256`,
  `UPDATE bounded_reconciliation_subject_claim
   SET claim_state = 'completed', resolution_sha256 = ?
   WHERE generation_id = ? AND relation = ? AND subject_entity_id = ?
     AND input_sha256 = ? AND claim_state = 'claimed'`,
  `SELECT CASE
     WHEN (SELECT count(*) FROM bounded_link_resolution
           WHERE generation_id = ? AND relation = ? AND subject_entity_id = ?
             AND resolution_sha256 = ?) = 1
      AND (SELECT count(*) FROM bounded_reconciliation_subject_claim
           WHERE generation_id = ? AND relation = ? AND subject_entity_id = ?
             AND input_sha256 = ? AND claim_state = 'completed'
             AND resolution_sha256 = ?) = 1
     THEN TRUE
     ELSE error('bounded reconciliation commit row-effect assertion failed')
   END AS effects_match`,
  'COMMIT',
] as const);

/**
 * The adapter binds policy-owned kind/scheme/key lists as temporary parameter
 * relations. UNION performs a disk-backed distinct before the final stable
 * entity scan, so retry and worker count cannot alter candidate order.
 */
export const BOUNDED_AUTHORITATIVE_TARGET_QUERY = `
SELECT DISTINCT entity.entity_json
FROM bounded_authority_identifier subject
JOIN bounded_authority_identifier target
  ON target.generation_id = subject.generation_id
 AND target.scheme = subject.scheme
 AND target.scope = subject.scope
 AND target.value_norm = subject.value_norm
JOIN bounded_policy_scheme policy ON policy.value = subject.scheme
JOIN bounded_linkable_entity entity ON entity.generation_id = target.generation_id
 AND entity.entity_id = target.entity_id
JOIN bounded_policy_target_kind kind ON kind.value = entity.entity_kind
WHERE subject.generation_id = ? AND subject.entity_id = ?
  AND entity.evidence_availability <> 'blocked'
  AND (? = FALSE OR entity.jurisdiction_norm = ?)
ORDER BY entity.entity_id` as const;

export const BOUNDED_EXACT_TARGET_QUERY = `
SELECT DISTINCT entity.entity_json
FROM bounded_normalized_exact_key subject
JOIN bounded_normalized_exact_key target
  ON target.generation_id = subject.generation_id
 AND target.key_kind = subject.key_kind
 AND target.value_norm = subject.value_norm
JOIN bounded_policy_exact_kind policy ON policy.value = subject.key_kind
JOIN bounded_linkable_entity entity ON entity.generation_id = target.generation_id
 AND entity.entity_id = target.entity_id
JOIN bounded_policy_target_kind kind ON kind.value = entity.entity_kind
WHERE subject.generation_id = ? AND subject.entity_id = ?
  AND entity.evidence_availability <> 'blocked'
  AND (? = FALSE OR entity.jurisdiction_norm = ?)
ORDER BY entity.entity_id` as const;

export const BOUNDED_CANDIDATE_TARGET_QUERY = `
SELECT entity.entity_json
FROM bounded_linkable_entity entity
JOIN bounded_policy_target_kind kind ON kind.value = entity.entity_kind
LEFT JOIN bounded_candidate_attribute postal
  ON postal.generation_id = entity.generation_id
 AND postal.entity_id = entity.entity_id
 AND postal.attribute_name = 'postalCode'
LEFT JOIN bounded_candidate_attribute address_number
  ON address_number.generation_id = entity.generation_id
 AND address_number.entity_id = entity.entity_id
 AND address_number.attribute_name = 'addressNumber'
WHERE entity.generation_id = ?
  AND entity.evidence_availability <> 'blocked'
  AND (? = FALSE OR entity.jurisdiction_norm = ?)
  AND (? IS NULL OR postal.value_norm IS NULL OR postal.value_norm = ?)
  AND (? IS NULL OR address_number.value_norm IS NULL OR address_number.value_norm = ?)
ORDER BY entity.entity_id
LIMIT ?` as const;

export const BOUNDED_CANDIDATE_QUERY_INVARIANTS = Object.freeze({
  authoritative: 'complete ordered result',
  normalizedExact: 'complete ordered result after authoritative result is empty',
  boundedCandidate: 'policy eligible coarse-filtered result limited to maxCandidatePool plus one',
} as const);

/*
  Reference form showing the disk joins which back the two exact stages:
  SELECT target.entity_id
  FROM bounded_authority_identifier subject
  JOIN bounded_authority_identifier target
    ON target.generation_id = subject.generation_id
   AND target.scheme = subject.scheme
   AND target.scope = subject.scope
   AND target.value_norm = subject.value_norm
  JOIN bounded_policy_scheme policy ON policy.value = subject.scheme
  WHERE subject.generation_id = ? AND subject.entity_id = ?;
  SELECT target.entity_id
  FROM bounded_normalized_exact_key subject
  JOIN bounded_normalized_exact_key target
    ON target.generation_id = subject.generation_id
   AND target.key_kind = subject.key_kind
   AND target.value_norm = subject.value_norm
  JOIN bounded_policy_exact_kind policy ON policy.value = subject.key_kind
  WHERE subject.generation_id = ? AND subject.entity_id = ?;
*/

export const BOUNDED_DUPLICATE_MEMBER_QUERY = `
SELECT classification, duplicate_key, entity_id,
       row_number() OVER (
         PARTITION BY classification, duplicate_key ORDER BY entity_id
       ) - 1 AS ordinal
FROM (
  SELECT classification, duplicate_key, entity_id,
         count(*) OVER (PARTITION BY classification, duplicate_key) AS member_count
  FROM bounded_duplicate_member
  WHERE generation_id = ? AND relation = ?
)
WHERE member_count > 1
ORDER BY classification, duplicate_key, ordinal, entity_id` as const;
