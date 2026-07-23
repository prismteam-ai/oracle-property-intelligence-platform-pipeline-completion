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

type DeterministicInquiryQueryClass = CriterionQueryClass | 'combined_ranking';

export type DeterministicInquiryEvidenceRoute = Readonly<{
  queryClass: DeterministicInquiryQueryClass;
  primaryCall: Readonly<{
    toolName: NamedEvidenceToolName;
    input: Readonly<Record<string, unknown>>;
  }>;
  candidateFilters: readonly Readonly<{
    toolName: NamedEvidenceToolName;
    input: Readonly<Record<string, unknown>>;
  }>[];
}>;

const DETERMINISTIC_INQUIRY_TOOL_BY_QUERY_CLASS = Object.freeze({
  roof_age: 'find_roof_age_candidates',
  water_view: 'find_water_view_candidates',
  ownership_age: 'find_ownership_age_candidates',
  regional_owner: 'find_regional_owner_properties',
  transit_walkability: 'find_transit_walkable_properties',
  starbucks_walkability: 'find_starbucks_walkable_properties',
  combined_ranking: 'rank_review_candidates',
} as const satisfies Readonly<Record<DeterministicInquiryQueryClass, NamedEvidenceToolName>>);

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
    /\bwater[\s-]+views?\b/iu,
    /\bwaterfront\b/iu,
    /\b(?:shoreline|ocean|bay|lake)[\s-]+(?:view|distance|proximity)\b/iu,
    /\bdistance[\s-]+to[\s-]+water\b/iu,
    // The README presenter prompt is "Show properties with a view of water."
    // (README.md:56) — the noun-first phrasing matched none of the patterns above,
    // so the demo's own wording routed nowhere.
    /\bviews?[\s-]+of[\s-]+(?:the[\s-]+)?water\b/iu,
    /\bviews?[\s-]+of[\s-]+(?:the[\s-]+)?(?:shoreline|ocean|bay|lake)\b/iu,
  ],
  ownership_age: [
    /\bownership[\s-]+(?:age|tenure|history)\b/iu,
    /\bowner[\s-]+tenure\b/iu,
    /\b(?:owned|ownership)[\s-]+for\b/iu,
    /\b(?:exchanged|transferred)[\s-]+ownership\b/iu,
    /\bownership[\s-]+(?:exchange|transfer)\b/iu,
    /\bchanged[\s-]+hands\b/iu,
    /\blong[\s-]*term owner\b/iu,
  ],
  // Plurals matter: the README demo prompt is "…also have regional ownerS"
  // (README.md:69). \bowner\b cannot match "owners" because the trailing "s" is a
  // word character, so this class failed to match, only transit_walkability did,
  // and the agent silently answered half of a two-predicate question with no
  // indication the ownership half had been dropped.
  regional_owner: [
    /\bregional[\s-]+owners?\b/iu,
    /\blocal[\s-]+owners?\b/iu,
    /\bowners?[\s-]+region\b/iu,
    /\bowners?[\s-]+(?:location|residence)\b/iu,
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

function matchingCriterionClasses(normalizedQuestion: string): readonly CriterionQueryClass[] {
  return (Object.keys(criterionPatterns) as CriterionQueryClass[]).filter((queryClass) =>
    matchesAny(normalizedQuestion, criterionPatterns[queryClass]),
  );
}

function requestsCombinedRanking(normalizedQuestion: string): boolean {
  return /\b(?:rank|ranking|ranked|combined|overall|weighted|review score|all six|multiple criteria)\b/iu.test(
    normalizedQuestion,
  );
}

export function classifyOracleAgentQuestion(normalizedQuestion: string): OracleAgentQueryClass {
  const matchingCriteria = matchingCriterionClasses(normalizedQuestion);
  if (matchingCriteria.length > 1 || requestsCombinedRanking(normalizedQuestion)) {
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

/**
 * Selects the single release-bound inquiry that is already semantically complete
 * for a graded property-intelligence question. The bounded page keeps the
 * evidence context small enough for one synthesis request; defaults remain
 * owned by the frozen inquiry contracts rather than duplicated in the agent.
 */
export function selectDeterministicInquiryEvidenceRoute(
  normalizedQuestion: string,
  releaseId: string,
  limit: number,
): DeterministicInquiryEvidenceRoute | null {
  const queryClass = classifyOracleAgentQuestion(normalizedQuestion);
  if (!(queryClass in DETERMINISTIC_INQUIRY_TOOL_BY_QUERY_CLASS)) return null;
  const deterministicClass = queryClass as DeterministicInquiryQueryClass;
  const roofYears = /\broof(?:s|ing)?\b[^.?!]{0,100}?\b(\d{1,3})\s*years?\b/iu.exec(
    normalizedQuestion,
  )?.[1];
  const ownershipYears =
    /\b(?:ownership|owner|owned|exchange(?:d)?)\b[^.?!]{0,120}?\b(\d{1,3})\s*years?\b/iu.exec(
      normalizedQuestion,
    )?.[1];
  if (deterministicClass === 'roof_age' && roofYears === undefined) return null;
  if (deterministicClass === 'ownership_age' && ownershipYears === undefined) return null;
  const requestedCriteria = matchingCriterionClasses(normalizedQuestion);
  const callClasses: readonly DeterministicInquiryQueryClass[] =
    deterministicClass === 'combined_ranking' &&
    requestedCriteria.length === 2 &&
    !requestsCombinedRanking(normalizedQuestion)
      ? requestedCriteria
      : [deterministicClass];
  if (
    deterministicClass === 'combined_ranking' &&
    requestedCriteria.length > 2 &&
    !requestsCombinedRanking(normalizedQuestion)
  ) {
    return null;
  }
  const thresholdInputByClass: Readonly<
    Partial<Record<DeterministicInquiryQueryClass, Readonly<Record<string, number>>>>
  > = Object.freeze({
    ...(roofYears === undefined
      ? {}
      : {
          roof_age: Object.freeze({
            minimumAgeYears: Number(roofYears),
          }),
        }),
    ...(ownershipYears === undefined
      ? {}
      : {
          ownership_age: Object.freeze({
            minimumTenureYears: Number(ownershipYears),
          }),
        }),
  });
  return Object.freeze({
    queryClass: deterministicClass,
    primaryCall: Object.freeze({
      toolName: DETERMINISTIC_INQUIRY_TOOL_BY_QUERY_CLASS[callClasses[0] ?? deterministicClass],
      input: Object.freeze({
        releaseId,
        limit,
        ...proxyInputFor(callClasses[0] ?? deterministicClass),
        ...(thresholdInputByClass[callClasses[0] ?? deterministicClass] ?? {}),
      }),
    }),
    candidateFilters: Object.freeze(
      callClasses.slice(1).map((callClass) =>
        Object.freeze({
          toolName: DETERMINISTIC_INQUIRY_TOOL_BY_QUERY_CLASS[callClass],
          input: Object.freeze({
            releaseId,
            ...proxyInputFor(callClass),
            ...(thresholdInputByClass[callClass] ?? {}),
          }),
        }),
      ),
    ),
  });
}

/**
 * Spatial criteria are emitted by the pipeline with supportClass 'proxy' — the
 * proximity features are derived from parcel/candidate geometry rather than a
 * routed pedestrian network, which is unconfigured. serving-adapter.ts threads
 * includeProxy into every one of these tools, but the deterministic route never
 * populated it, so the executor saw undefined for the one flag that admits the
 * only support class these criteria ever produce.
 *
 * Requesting proxy explicitly is what makes the answer non-empty; the response
 * still carries the proxy support class, so the distinction stays visible to the
 * caller rather than being presented as a routed measurement.
 */
const PROXY_ELIGIBLE_CLASSES: ReadonlySet<string> = new Set([
  'water_view',
  'transit_walkability',
  'starbucks_walkability',
  'combined_ranking',
]);

function proxyInputFor(queryClass: string): Readonly<Record<string, boolean>> {
  return PROXY_ELIGIBLE_CLASSES.has(queryClass) ? Object.freeze({ includeProxy: true }) : {};
}
