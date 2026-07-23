import type { AnalyticalParameter, AnalyticalQuery } from '@oracle/data-runtime/analytical-runtime';

import type { InquiryName, RankingCriterion, RankingWeight } from './contracts.js';

export const INQUIRY_PAGE_SIZE_MAXIMUM = 100;
const QUERY_TIMEOUT_MILLISECONDS = 5_000;
const QUERY_SCAN_BYTES_MAXIMUM = 512 * 1024 * 1024;

export type FixedInquiryPlanInput = Readonly<{
  name: Exclude<InquiryName, 'combined_review'>;
  threshold: number | null;
  includeProxy: boolean;
  city: string | null;
  postalCode: string | null;
  propertyId: string | null;
  afterPropertyId: string | null;
  limit: number;
}>;

export type FixedRankingPlanInput = Readonly<{
  includeProxy: boolean;
  city: string | null;
  postalCode: string | null;
  propertyId: string | null;
  weights: readonly RankingWeight[];
  minimumEvidenceCoverage: number;
  afterScore: number | null;
  afterPropertyId: string | null;
  limit: number;
}>;

function evidenceProjection(feature: Exclude<InquiryName, 'combined_review'>): string {
  return `COALESCE((
    SELECT to_json(list(struct_pack(
      evidenceId := pe.evidence_id,
      supportClass := pe.support_class,
      confidence := pe.confidence,
      asOf := pe.as_of,
      algorithmName := pe.algorithm_name,
      algorithmVersion := pe.algorithm_version,
      valueJson := pe.value_json,
      sourceIdsJson := pe.source_ids_json,
      limitationsJson := pe.limitations_json,
      visibility := pe.visibility
    ) ORDER BY pe.evidence_id))
    FROM property_evidence AS pe
    WHERE pe.property_id = pq.property_id
      AND pe.feature = '${feature}'
      AND pe.visibility = 'public'
  ), '[]') AS evidence_json`;
}

const identityProjection = `
  pq.property_id,
  pq.parcel_identifier,
  pq.address_street,
  pq.address_city,
  pq.address_zip,
  pq.latitude,
  pq.longitude`;

const filters = `
  AND (? IS NULL OR pq.address_city = ?)
  AND (? IS NULL OR pq.address_zip = ?)
  AND (? IS NULL OR pq.property_id = ?)
  AND (? IS NULL OR pq.property_id > ?)`;

const evidenceExists = (
  feature: Exclude<InquiryName, 'combined_review'>,
  support: string,
): string =>
  `EXISTS (
    SELECT 1
    FROM property_evidence AS pe
    WHERE pe.property_id = pq.property_id
      AND pe.feature = '${feature}'
      AND pe.support_class = ${support}
      AND pe.visibility = 'public'
  )`;

const inquiryStatements: Readonly<Record<Exclude<InquiryName, 'combined_review'>, string>> =
  Object.freeze({
    roof_age: `
SELECT${identityProjection},
  pq.roof_support_class AS support_class,
  pq.roof_age_years::DOUBLE AS value_number,
  pq.roof_reference_date AS value_text,
  ${evidenceProjection('roof_age')}
FROM property_query AS pq
WHERE pq.visibility = 'public'
  AND (pq.roof_support_class = 'supported' OR (? AND pq.roof_support_class = 'proxy'))
  AND pq.roof_age_years > ?
  AND ${evidenceExists('roof_age', 'pq.roof_support_class')}${filters}
ORDER BY pq.property_id ASC
LIMIT ?`,
    water_view_candidate: `
SELECT${identityProjection},
  pq.water_support_class AS support_class,
  pq.water_distance_meters AS value_number,
  pq.water_visibility_state AS value_text,
  ${evidenceProjection('water_view_candidate')}
FROM property_query AS pq
WHERE pq.visibility = 'public'
  AND (pq.water_support_class = 'supported' OR (? AND pq.water_support_class = 'proxy'))
  AND pq.water_distance_meters <= ?
  AND ${evidenceExists('water_view_candidate', 'pq.water_support_class')}${filters}
ORDER BY pq.property_id ASC
LIMIT ?`,
    ownership_age: `
SELECT${identityProjection},
  pq.ownership_support_class AS support_class,
  pq.years_since_exchange::DOUBLE AS value_number,
  pq.last_exchange_date AS value_text,
  ${evidenceProjection('ownership_age')}
FROM property_query AS pq
WHERE pq.visibility = 'public'
  AND pq.ownership_support_class = 'supported'
  AND pq.years_since_exchange > ?
  AND ${evidenceExists('ownership_age', 'pq.ownership_support_class')}${filters}
ORDER BY pq.property_id ASC
LIMIT ?`,
    regional_owner: `
SELECT${identityProjection},
  pq.regional_owner_support_class AS support_class,
  1::DOUBLE AS value_number,
  NULL::VARCHAR AS value_text,
  ${evidenceProjection('regional_owner')}
FROM property_query AS pq
WHERE pq.visibility = 'public'
  AND pq.regional_owner_support_class = 'supported'
  AND pq.is_regional_owner = true
  AND ${evidenceExists('regional_owner', 'pq.regional_owner_support_class')}${filters}
ORDER BY pq.property_id ASC
LIMIT ?`,
    transit_walkability: `
SELECT${identityProjection},
  pq.transit_support_class AS support_class,
  pq.transit_distance_meters AS value_number,
  pq.transit_walk_minutes::VARCHAR AS value_text,
  ${evidenceProjection('transit_walkability')}
FROM property_query AS pq
WHERE pq.visibility = 'public'
  AND (pq.transit_support_class = 'supported' OR (? AND pq.transit_support_class = 'proxy'))
  AND pq.transit_distance_meters <= ?
  AND ${evidenceExists('transit_walkability', 'pq.transit_support_class')}${filters}
ORDER BY pq.property_id ASC
LIMIT ?`,
    starbucks_walkability: `
SELECT${identityProjection},
  pq.starbucks_support_class AS support_class,
  pq.starbucks_distance_meters AS value_number,
  pq.starbucks_walk_minutes::VARCHAR AS value_text,
  ${evidenceProjection('starbucks_walkability')}
FROM property_query AS pq
WHERE pq.visibility = 'public'
  AND (pq.starbucks_support_class = 'supported' OR (? AND pq.starbucks_support_class = 'proxy'))
  AND pq.starbucks_distance_meters <= ?
  AND ${evidenceExists('starbucks_walkability', 'pq.starbucks_support_class')}${filters}
ORDER BY pq.property_id ASC
LIMIT ?`,
  });

const rankingCriteria = Object.freeze([
  'roof_age',
  'water_view_candidate',
  'ownership_age',
  'regional_owner',
  'transit_walkability',
  'starbucks_walkability',
] as const satisfies readonly RankingCriterion[]);

const rankingStatement = `
WITH candidates AS (
  SELECT pq.*,
    CASE WHEN pq.roof_age_years > 15
      AND (pq.roof_support_class = 'supported' OR (? AND pq.roof_support_class = 'proxy'))
      AND ${evidenceExists('roof_age', 'pq.roof_support_class')}
      THEN pq.roof_support_class ELSE 'unknown' END AS roof_state,
    CASE WHEN pq.water_distance_meters <= 5000
      AND (pq.water_support_class = 'supported' OR (? AND pq.water_support_class = 'proxy'))
      AND ${evidenceExists('water_view_candidate', 'pq.water_support_class')}
      THEN pq.water_support_class ELSE 'unknown' END AS water_state,
    CASE WHEN pq.years_since_exchange > 10
      AND pq.ownership_support_class = 'supported'
      AND ${evidenceExists('ownership_age', 'pq.ownership_support_class')}
      THEN 'supported' ELSE 'unknown' END AS ownership_state,
    CASE WHEN pq.is_regional_owner = true
      AND pq.regional_owner_support_class = 'supported'
      AND ${evidenceExists('regional_owner', 'pq.regional_owner_support_class')}
      THEN 'supported' ELSE 'unknown' END AS regional_owner_state,
    CASE WHEN pq.transit_distance_meters <= 800
      AND (pq.transit_support_class = 'supported' OR (? AND pq.transit_support_class = 'proxy'))
      AND ${evidenceExists('transit_walkability', 'pq.transit_support_class')}
      THEN pq.transit_support_class ELSE 'unknown' END AS transit_state,
    CASE WHEN pq.starbucks_distance_meters <= 800
      AND (pq.starbucks_support_class = 'supported' OR (? AND pq.starbucks_support_class = 'proxy'))
      AND ${evidenceExists('starbucks_walkability', 'pq.starbucks_support_class')}
      THEN pq.starbucks_support_class ELSE 'unknown' END AS starbucks_state
  FROM property_query AS pq
  WHERE pq.visibility = 'public'
    AND (? IS NULL OR pq.address_city = ?)
    AND (? IS NULL OR pq.address_zip = ?)
    AND (? IS NULL OR pq.property_id = ?)
), scored AS (
  SELECT *,
    (CASE roof_state WHEN 'supported' THEN ? WHEN 'proxy' THEN ? ELSE 0 END
      + CASE water_state WHEN 'supported' THEN ? WHEN 'proxy' THEN ? ELSE 0 END
      + CASE ownership_state WHEN 'supported' THEN ? WHEN 'proxy' THEN ? ELSE 0 END
      + CASE regional_owner_state WHEN 'supported' THEN ? WHEN 'proxy' THEN ? ELSE 0 END
      + CASE transit_state WHEN 'supported' THEN ? WHEN 'proxy' THEN ? ELSE 0 END
      + CASE starbucks_state WHEN 'supported' THEN ? WHEN 'proxy' THEN ? ELSE 0 END) / ? AS score,
    (CASE WHEN roof_state IN ('supported', 'proxy') THEN ? ELSE 0 END
      + CASE WHEN water_state IN ('supported', 'proxy') THEN ? ELSE 0 END
      + CASE WHEN ownership_state IN ('supported', 'proxy') THEN ? ELSE 0 END
      + CASE WHEN regional_owner_state IN ('supported', 'proxy') THEN ? ELSE 0 END
      + CASE WHEN transit_state IN ('supported', 'proxy') THEN ? ELSE 0 END
      + CASE WHEN starbucks_state IN ('supported', 'proxy') THEN ? ELSE 0 END) / ? AS evidence_coverage
  FROM candidates
), ranked AS (
  SELECT *,
    row_number() OVER (ORDER BY score DESC, property_id ASC)::DOUBLE AS ranking_position
  FROM scored
  WHERE score > 0
    AND evidence_coverage >= ?
)
SELECT${identityProjection},
  score,
  evidence_coverage,
  ranking_position,
  roof_state,
  water_state,
  ownership_state,
  regional_owner_state,
  transit_state,
  starbucks_state,
  COALESCE((
    SELECT to_json(list(struct_pack(
      evidenceId := pe.evidence_id,
      feature := pe.feature,
      supportClass := pe.support_class,
      confidence := pe.confidence,
      asOf := pe.as_of,
      algorithmName := pe.algorithm_name,
      algorithmVersion := pe.algorithm_version,
      valueJson := pe.value_json,
      sourceIdsJson := pe.source_ids_json,
      limitationsJson := pe.limitations_json,
      visibility := pe.visibility
    ) ORDER BY pe.feature, pe.evidence_id))
    FROM property_evidence AS pe
    WHERE pe.property_id = pq.property_id
      AND pe.feature IN ('roof_age', 'water_view_candidate', 'ownership_age', 'regional_owner', 'transit_walkability', 'starbucks_walkability')
      AND pe.visibility = 'public'
  ), '[]') AS evidence_json
FROM ranked AS pq
WHERE (? IS NULL OR score < ? OR (score = ? AND pq.property_id > ?))
ORDER BY score DESC, pq.property_id ASC
LIMIT ?`;

function filterParameters(input: FixedInquiryPlanInput): readonly AnalyticalParameter[] {
  return [
    input.city,
    input.city,
    input.postalCode,
    input.postalCode,
    input.propertyId,
    input.propertyId,
    input.afterPropertyId,
    input.afterPropertyId,
  ];
}

export function createFixedInquiryQuery(input: FixedInquiryPlanInput): AnalyticalQuery {
  const common = [...filterParameters(input), input.limit + 1] as const;
  let parameters: readonly AnalyticalParameter[];
  if (input.name === 'ownership_age') parameters = [input.threshold, ...common];
  else if (input.name === 'regional_owner') parameters = common;
  else parameters = [input.includeProxy, input.threshold, ...common];
  return Object.freeze({
    operation: `inquiry.${input.name}@1.0.0`,
    statement: inquiryStatements[input.name],
    parameters: Object.freeze(parameters),
    timeoutMs: QUERY_TIMEOUT_MILLISECONDS,
    maximumScanBytes: QUERY_SCAN_BYTES_MAXIMUM,
    maximumRows: INQUIRY_PAGE_SIZE_MAXIMUM + 1,
  });
}

function weightMap(
  weights: readonly RankingWeight[],
): ReadonlyMap<RankingCriterion, RankingWeight> {
  return new Map(weights.map((weight) => [weight.criterion, weight]));
}

export function createFixedRankingQuery(input: FixedRankingPlanInput): AnalyticalQuery {
  const byCriterion = weightMap(input.weights);
  const ordered = rankingCriteria.map((criterion) => {
    const weight = byCriterion.get(criterion);
    if (weight === undefined) throw new TypeError(`Missing ranking weight: ${criterion}`);
    return weight;
  });
  const totalWeight = ordered.reduce((total, { weight }) => total + weight, 0);
  const scoreParameters = ordered.flatMap(({ weight, proxyMultiplier }) => [
    weight,
    weight * proxyMultiplier,
  ]);
  const coverageParameters = ordered.map(({ weight }) => weight);
  const parameters: readonly AnalyticalParameter[] = Object.freeze([
    input.includeProxy,
    input.includeProxy,
    input.includeProxy,
    input.includeProxy,
    input.city,
    input.city,
    input.postalCode,
    input.postalCode,
    input.propertyId,
    input.propertyId,
    ...scoreParameters,
    totalWeight,
    ...coverageParameters,
    totalWeight,
    input.minimumEvidenceCoverage,
    input.afterScore,
    input.afterScore,
    input.afterScore,
    input.afterPropertyId,
    input.limit + 1,
  ]);
  return Object.freeze({
    operation: 'inquiry.combined_review@1.0.0',
    statement: rankingStatement,
    parameters,
    timeoutMs: QUERY_TIMEOUT_MILLISECONDS,
    maximumScanBytes: QUERY_SCAN_BYTES_MAXIMUM,
    maximumRows: INQUIRY_PAGE_SIZE_MAXIMUM + 1,
  });
}
