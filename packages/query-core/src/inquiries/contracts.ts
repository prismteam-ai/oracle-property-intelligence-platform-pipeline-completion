import type { AnalyticalSession } from '@oracle/data-runtime/analytical-runtime';

export type InquiryCapabilityState = 'supported' | 'partial' | 'blocked';
export type InquirySupportClass = 'supported' | 'proxy' | 'unknown' | 'unsupported';
export type InquiryVisibility = 'public' | 'authenticated' | 'restricted' | 'prohibited_public';

export type InquiryName =
  | 'roof_age'
  | 'water_view_candidate'
  | 'ownership_age'
  | 'regional_owner'
  | 'transit_walkability'
  | 'starbucks_walkability'
  | 'combined_review';

export type InquiryCapability = Readonly<{
  state: InquiryCapabilityState;
  supportClasses: readonly InquirySupportClass[];
  numerator: number;
  denominator: number;
  limitations: readonly string[];
}>;

export type InquiryReleaseContext = Readonly<{
  schemaVersion: string;
  releaseId: string;
  runId: string;
  manifestCid: string;
  asOf: string;
  policyVersion: string;
  rankingWeights: readonly RankingWeight[];
  capabilities: Readonly<Record<Exclude<InquiryName, 'combined_review'>, InquiryCapability>>;
}>;

export type InquiryPage = Readonly<{
  releaseId: string;
  limit?: number;
  cursor?: string | null;
}>;

export type PropertyFilters = Readonly<{
  city?: string | null;
  postalCode?: string | null;
  propertyId?: string | null;
}>;

export type EvidenceSummary = Readonly<{
  evidenceId: string;
  supportClass: InquirySupportClass;
  confidence: number;
  asOf: string;
  algorithmName: string;
  algorithmVersion: string;
  value: null | boolean | number | string | readonly unknown[] | Readonly<Record<string, unknown>>;
  sourceIds: readonly string[];
  limitations: readonly string[];
  visibility: InquiryVisibility;
}>;

export type PropertyIdentity = Readonly<{
  propertyId: string;
  parcelIdentifier: string;
  addressStreet: string | null;
  addressCity: string | null;
  addressZip: string | null;
  latitude: number | null;
  longitude: number | null;
}>;

export type InquiryItem<TValue> = PropertyIdentity &
  Readonly<{
    supportClass: InquirySupportClass;
    value: Readonly<TValue>;
    evidence: readonly EvidenceSummary[];
    limitations: readonly string[];
  }>;

export type InquiryResponse<TValue> = Readonly<{
  schemaVersion: string;
  releaseId: string;
  runId: string;
  manifestCid: string;
  asOf: string;
  query: Readonly<{
    name: InquiryName;
    policyVersion: string;
    parameters: Readonly<Record<string, null | boolean | number | string>>;
  }>;
  capability: InquiryCapability;
  results: readonly InquiryItem<TValue>[];
  resultCount: number;
  nextCursor: string | null;
  truncated: boolean;
  limitations: readonly string[];
  timing: Readonly<{ elapsedMs: number; bytesScanned: number | null }>;
}>;

export type RoofAgeInput = PropertyFilters &
  InquiryPage &
  Readonly<{ minimumAgeYears?: number; includeProxy?: boolean; asOf?: string }>;
export type WaterViewInput = PropertyFilters &
  InquiryPage &
  Readonly<{ maximumDistanceMeters?: number; includeProxy?: boolean }>;
export type OwnershipAgeInput = PropertyFilters &
  InquiryPage &
  Readonly<{ minimumTenureYears?: number }>;
export type RegionalOwnerInput = PropertyFilters & InquiryPage;
export type WalkabilityInput = PropertyFilters &
  InquiryPage &
  Readonly<{ maximumNetworkDistanceMeters?: number; includeProxy?: boolean }>;

export type RankingCriterion = Exclude<InquiryName, 'combined_review'>;
export type RankingWeight = Readonly<{
  criterion: RankingCriterion;
  weight: number;
  proxyMultiplier: number;
}>;
export type CombinedRankingInput = PropertyFilters &
  InquiryPage &
  Readonly<{
    criteria?: readonly RankingCriterion[];
    weights?: readonly RankingWeight[];
    includeProxy?: boolean;
    minimumEvidenceCoverage?: number;
  }>;

export type InquiryExecutionContext = Readonly<{
  session: AnalyticalSession;
  signal?: AbortSignal;
}>;

export type RoofAgeValue = Readonly<{ ageYears: number; referenceDate: string | null }>;
export type WaterViewValue = Readonly<{
  distanceMeters: number;
  terrainVisibilityState: string;
  actualViewProven: false;
}>;
export type OwnershipAgeValue = Readonly<{
  yearsSinceExchange: number;
  lastExchangeDate: string;
  completeHistoryRequired: true;
}>;
export type RegionalOwnerValue = Readonly<{
  isRegionalOwner: true;
  rawOwnerIdentityExposed: false;
}>;
export type WalkabilityValue = Readonly<{
  networkDistanceMeters: number;
  estimatedWalkMinutes: number;
}>;
export type CombinedRankingValue = Readonly<{
  rank: number;
  score: number;
  evidenceCoverage: number;
  components: readonly Readonly<{
    criterion: RankingCriterion;
    supportClass: InquirySupportClass;
    normalizedValue: number | null;
    weight: number;
    proxyMultiplier: number;
    contribution: number;
  }>[];
}>;
