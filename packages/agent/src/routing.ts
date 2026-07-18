import { NAMED_EVIDENCE_TOOL_NAMES, type NamedEvidenceToolName } from './contracts.js';

export const ORACLE_AGENT_QUERY_CLASSES = Object.freeze([
  'dataset',
  'coverage',
  'artifacts',
  'dictionary',
  'pipeline_runs',
  'property_lookup',
  'property_evidence',
  'roof_age',
  'water_view',
  'ownership_age',
  'regional_owner',
  'transit_walkability',
  'starbucks_walkability',
  'combined_ranking',
  'ambiguous',
] as const);

export type OracleAgentQueryClass = (typeof ORACLE_AGENT_QUERY_CLASSES)[number];

type CriterionQueryClass = Extract<
  OracleAgentQueryClass,
  | 'roof_age'
  | 'water_view'
  | 'ownership_age'
  | 'regional_owner'
  | 'transit_walkability'
  | 'starbucks_walkability'
>;

function orderedTools(
  ...names: readonly NamedEvidenceToolName[]
): readonly NamedEvidenceToolName[] {
  const requested = new Set(names);
  return Object.freeze(NAMED_EVIDENCE_TOOL_NAMES.filter((name) => requested.has(name)));
}

const commonPropertyEvidenceTools = orderedTools(
  'search_properties',
  'get_property',
  'get_property_evidence',
);

function propertyCriterionTools(
  criterionTool: NamedEvidenceToolName,
): readonly NamedEvidenceToolName[] {
  return orderedTools(...commonPropertyEvidenceTools, criterionTool);
}

/**
 * Frozen request classes and the named tools each class exposes to the model.
 * The full agent still owns all sixteen tools; the AI SDK filters only the
 * provider-facing tool list for a request. Multi-criterion asks use the
 * immutable combined ranking inquiry plus the common property/evidence path.
 */
export const ACTIVE_TOOL_NAMES_BY_QUERY_CLASS = Object.freeze({
  dataset: orderedTools('get_dataset_info'),
  coverage: orderedTools('get_dataset_info', 'get_dataset_coverage'),
  artifacts: orderedTools('get_dataset_info', 'list_artifacts'),
  dictionary: orderedTools('get_dataset_info', 'get_data_dictionary'),
  pipeline_runs: orderedTools('get_dataset_info', 'list_pipeline_runs', 'get_pipeline_run'),
  property_lookup: commonPropertyEvidenceTools,
  property_evidence: commonPropertyEvidenceTools,
  roof_age: propertyCriterionTools('find_roof_age_candidates'),
  water_view: propertyCriterionTools('find_water_view_candidates'),
  ownership_age: propertyCriterionTools('find_ownership_age_candidates'),
  regional_owner: propertyCriterionTools('find_regional_owner_properties'),
  transit_walkability: propertyCriterionTools('find_transit_walkable_properties'),
  starbucks_walkability: propertyCriterionTools('find_starbucks_walkable_properties'),
  combined_ranking: propertyCriterionTools('rank_review_candidates'),
  ambiguous: orderedTools(
    'get_dataset_info',
    'get_dataset_coverage',
    ...commonPropertyEvidenceTools,
  ),
}) satisfies Readonly<Record<OracleAgentQueryClass, readonly NamedEvidenceToolName[]>>;

const criterionPatterns: Readonly<Record<CriterionQueryClass, readonly RegExp[]>> = Object.freeze({
  roof_age: [/\broof(?:s|ing)?\b/iu, /\byear[\s-]+built\b/iu, /\bbuilding age\b/iu],
  water_view: [
    /\bwater[\s-]+view\b/iu,
    /\bwaterfront\b/iu,
    /\b(?:shoreline|ocean|bay|lake)[\s-]+(?:view|distance|proximity)\b/iu,
    /\bdistance[\s-]+to[\s-]+water\b/iu,
  ],
  ownership_age: [
    /\bownership[\s-]+(?:age|tenure|history)\b/iu,
    /\bowner[\s-]+tenure\b/iu,
    /\b(?:owned|ownership)[\s-]+for\b/iu,
    /\blong[\s-]*term owner\b/iu,
  ],
  regional_owner: [
    /\bregional[\s-]+owner\b/iu,
    /\blocal[\s-]+owner\b/iu,
    /\bowner[\s-]+region\b/iu,
    /\bowner[\s-]+(?:location|residence)\b/iu,
  ],
  transit_walkability: [
    /\btransit\b/iu,
    /\bpublic[\s-]+transport(?:ation)?\b/iu,
    /\b(?:train|bus|rail)[\s-]+(?:station|stop|walkability|distance)\b/iu,
    /\b(?:vta|caltrain)\b/iu,
  ],
  starbucks_walkability: [/\bstarbucks\b/iu, /\bcoffee[\s-]+(?:shop|store)[\s-]+walkability\b/iu],
});

function matchesAny(question: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(question));
}

export function classifyOracleAgentQuestion(normalizedQuestion: string): OracleAgentQueryClass {
  const matchingCriteria = (Object.keys(criterionPatterns) as CriterionQueryClass[]).filter(
    (queryClass) => matchesAny(normalizedQuestion, criterionPatterns[queryClass]),
  );
  if (
    matchingCriteria.length > 1 ||
    /\b(?:rank|ranking|ranked|combined|overall|weighted|review score|all six|multiple criteria)\b/iu.test(
      normalizedQuestion,
    )
  ) {
    return 'combined_ranking';
  }
  const criterion = matchingCriteria[0];
  if (criterion !== undefined) return criterion;

  if (
    /\b(?:pipeline|ingestion)[\s-]+(?:run|runs|status|history)\b|\brun[\s-]+id\b/iu.test(
      normalizedQuestion,
    )
  ) {
    return 'pipeline_runs';
  }
  if (/\bdata[\s-]+dictionary\b|\bdictionary\b|\bfield definitions?\b/iu.test(normalizedQuestion)) {
    return 'dictionary';
  }
  if (/\b(?:artifact|artifacts|parquet|duckdb|manifest|ipfs|cid)\b/iu.test(normalizedQuestion)) {
    return 'artifacts';
  }
  if (/\b(?:coverage|completeness|covered|row counts?)\b/iu.test(normalizedQuestion)) {
    return 'coverage';
  }
  if (/\b(?:dataset|data set|release information|release details)\b/iu.test(normalizedQuestion)) {
    return 'dataset';
  }
  if (
    /\b(?:evidence|citation|citations|provenance|source id|support state)\b/iu.test(
      normalizedQuestion,
    )
  ) {
    return 'property_evidence';
  }
  if (
    /\b(?:property|properties|parcel|parcels|apn|address|addresses|street)\b/iu.test(
      normalizedQuestion,
    )
  ) {
    return 'property_lookup';
  }
  return 'ambiguous';
}

export function selectActiveNamedEvidenceTools(
  normalizedQuestion: string,
): readonly NamedEvidenceToolName[] {
  return ACTIVE_TOOL_NAMES_BY_QUERY_CLASS[classifyOracleAgentQuestion(normalizedQuestion)];
}
