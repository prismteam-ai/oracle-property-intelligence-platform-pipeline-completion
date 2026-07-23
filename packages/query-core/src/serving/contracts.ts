import type { NamedQueryName } from '@oracle/contracts/query';

import type {
  InquiryCapability,
  InquiryReleaseContext,
  RankingWeight,
} from '../inquiries/contracts.js';

export type ProductionServingErrorCode =
  | 'INVALID_REQUEST'
  | 'RELEASE_MISMATCH'
  | 'STALE_OR_TAMPERED_CURSOR'
  | 'RESULT_TOO_LARGE'
  | 'QUERY_BUDGET_EXCEEDED'
  | 'RELEASE_INVALID'
  | 'INTERNAL_QUERY_ERROR';

export class ProductionServingError extends Error {
  public readonly code: ProductionServingErrorCode;
  public readonly releaseId: string | undefined;

  public constructor(
    code: ProductionServingErrorCode,
    message: string,
    options: Readonly<{ releaseId?: string; cause?: unknown }> = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProductionServingError';
    this.code = code;
    this.releaseId = options.releaseId;
  }
}

export type ProductionServingExpectedRelease = Readonly<{
  releaseId: string;
  runId: string;
  manifestSha256: string;
  manifestCid: string;
  asOf: string;
  schemaVersion: string;
  policyVersion: string;
}>;

export type ProductionServingConfig = Readonly<{
  releaseRoot: string;
  manifestRelativePath: string;
  expected: ProductionServingExpectedRelease;
  cursorSecret: Uint8Array;
  rankingWeights: readonly RankingWeight[];
  capabilities: InquiryReleaseContext['capabilities'];
  limitations?: readonly string[];
}>;

export type ProductionServingRelease = Readonly<{
  schemaVersion: string;
  releaseId: string;
  runId: string;
  manifestCid: string;
  manifestSha256: string;
  asOf: string;
  policyVersion: string;
  county: 'Santa Clara';
  state: 'CA';
  immutable: true;
  verified: true;
}>;

export type ProductionServingEnvelope = Readonly<{
  schemaVersion: string;
  releaseId: string;
  runId: string;
  manifestCid: string;
  asOf: string;
  coverage: Readonly<Record<string, unknown>>;
  limitations: readonly string[];
  data: unknown;
  nextCursor: string | null;
  truncated: boolean;
  timing: Readonly<{ elapsedMs: number; bytesScanned: number }>;
}>;

export type ProductionServingRequest = Readonly<{
  operation: NamedQueryName;
  input: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}>;

export interface ProductionServingService {
  readonly release: ProductionServingRelease;
  execute(request: ProductionServingRequest): Promise<ProductionServingEnvelope>;
  validateCursor(
    request: Readonly<{
      operation: NamedQueryName;
      releaseId: string;
      cursor: string;
    }>,
  ): void;
}

const release = ['releaseId'] as const;
const page = ['limit', 'cursor'] as const;
const filters = ['city', 'postalCode', 'propertyId'] as const;
const propertySearchSharedFields = [...release, ...filters, 'parcelIdentifier', ...page] as const;

export const PROPERTY_SEARCH_SORTS = Object.freeze([
  'property_id',
  'address',
  'parcel_identifier',
] as const);
export type PropertySearchSort = (typeof PROPERTY_SEARCH_SORTS)[number];

export const REGIONAL_OWNER_POLICY_ID = 'bay-area-nine-counties-v1';

/**
 * API/query-core opt-in fields layered over the stable shared/MCP property-search contract.
 * Transports must select this list explicitly rather than widening the shared operation map.
 */
export const PROPERTY_SEARCH_EXTENDED_INPUT_FIELDS = Object.freeze([
  ...propertySearchSharedFields,
  'query',
  'sort',
] as const);
export type PropertySearchExtendedInputField =
  (typeof PROPERTY_SEARCH_EXTENDED_INPUT_FIELDS)[number];

export const PRODUCTION_SERVING_INPUT_FIELDS = Object.freeze({
  get_dataset_info: Object.freeze([]),
  get_dataset_coverage: Object.freeze([...release]),
  list_pipeline_runs: Object.freeze([...release, ...page]),
  get_pipeline_run: Object.freeze([...release, 'runId']),
  search_properties: Object.freeze([...propertySearchSharedFields]),
  get_property: Object.freeze([...release, 'propertyId']),
  get_property_evidence: Object.freeze([...release, 'propertyId', 'feature', ...page]),
  find_roof_age_candidates: Object.freeze([
    ...release,
    ...filters,
    'minimumAgeYears',
    'asOf',
    'evidenceMode',
    'includeProxy',
    ...page,
  ]),
  find_water_view_candidates: Object.freeze([
    ...release,
    ...filters,
    'maximumWaterDistanceMeters',
    'minimumTerrainVisibilityConfidence',
    'waterFeatureTypes',
    'includeProxy',
    ...page,
  ]),
  find_ownership_age_candidates: Object.freeze([
    ...release,
    ...filters,
    'minimumTenureYears',
    'requireCompleteHistory',
    'asOf',
    ...page,
  ]),
  find_regional_owner_properties: Object.freeze([
    ...release,
    ...filters,
    'regionPolicyId',
    'requireCurrentOwner',
    ...page,
  ]),
  find_transit_walkable_properties: Object.freeze([
    ...release,
    ...filters,
    'maximumNetworkDistanceMeters',
    'maximumSnapDistanceMeters',
    'includeProxy',
    'serviceDate',
    'agencyId',
    'routeId',
    ...page,
  ]),
  find_starbucks_walkable_properties: Object.freeze([
    ...release,
    ...filters,
    'maximumNetworkDistanceMeters',
    'maximumSnapDistanceMeters',
    'includeProxy',
    'minimumPlaceConfidence',
    ...page,
  ]),
  rank_review_candidates: Object.freeze([
    ...release,
    ...filters,
    'criteria',
    'weights',
    'includeProxy',
    'minimumEvidenceCoverage',
    ...page,
  ]),
  list_artifacts: Object.freeze([...release, 'publicationClass', ...page]),
  get_data_dictionary: Object.freeze([...release, 'entity', ...page]),
} as const satisfies Readonly<Record<NamedQueryName, readonly string[]>>);

export type ServingCapabilities = Readonly<
  Record<
    | 'roof_age'
    | 'water_view_candidate'
    | 'ownership_age'
    | 'regional_owner'
    | 'transit_walkability'
    | 'starbucks_walkability',
    InquiryCapability
  >
>;
