import type { VisibilityCounts } from '@oracle/contracts/visibility';

import type {
  DuplicateClassification,
  LinkLineageReference,
  LinkMethod,
} from '../entity-linking/model.js';

export type CoverageDimension = 'source' | 'entity' | 'field' | 'relation';

export type CoverageTerminalState = 'succeeded' | 'partial' | 'blocked' | 'failed' | 'unavailable';

export type CoverageCompletenessState = 'complete' | 'partial' | 'blocked' | 'failed' | 'unknown';

export type CoverageGapCode =
  | 'source_blocked'
  | 'source_partial'
  | 'source_failed'
  | 'denominator_unavailable'
  | 'out_of_window'
  | 'quarantined_records'
  | 'unmatched_records'
  | 'ambiguous_links'
  | 'candidate_review_pending'
  | 'restricted_visibility'
  | 'duplicate_records'
  | 'numerator_exceeds_denominator'
  | 'capability_unavailable';

export type CoverageGapReason = Readonly<{
  code: CoverageGapCode;
  count: number | null;
  detail: string;
}>;

export type CoverageTimeWindow = Readonly<{
  start: string;
  end: string;
}>;

export type CoverageDenominator = Readonly<{
  value: number | null;
  method:
    'authoritative_count' | 'source_manifest' | 'observed_population' | 'capability_unavailable';
  scope: string;
  asOf: string;
  lineage: readonly LinkLineageReference[];
}>;

export type RelationMethod = LinkMethod | 'review_decision';

export type ConfidenceBand = 'high' | 'medium' | 'low' | 'none';

export type CoverageMetricInput = Readonly<{
  dimension: CoverageDimension;
  dataset: string;
  subject: string;
  jurisdiction: string;
  timeWindow: CoverageTimeWindow | null;
  numerator: number;
  denominator: CoverageDenominator;
  terminalState: CoverageTerminalState;
  gapReasons: readonly CoverageGapReason[];
  sourceIds: readonly string[];
  visibilityCounts: VisibilityCounts;
  duplicateCounts: Readonly<Partial<Record<DuplicateClassification, number>>>;
  methodCounts?: Readonly<Partial<Record<RelationMethod, number>>>;
  confidenceCounts?: Readonly<Partial<Record<ConfidenceBand, number>>>;
  lineage: readonly LinkLineageReference[];
}>;

export type AudienceCoverage = Readonly<{
  numerator: number;
  ratio: number | null;
}>;

export type CoverageMetric = Readonly<{
  metricId: string;
  dimension: CoverageDimension;
  dataset: string;
  subject: string;
  jurisdiction: string;
  timeWindow: CoverageTimeWindow | null;
  numerator: number;
  denominator: CoverageDenominator;
  coverageRatio: number | null;
  completenessState: CoverageCompletenessState;
  terminalState: CoverageTerminalState;
  gapReasons: readonly CoverageGapReason[];
  sourceIds: readonly string[];
  visibilityCounts: VisibilityCounts;
  audienceCoverage: Readonly<{
    public: AudienceCoverage;
    authenticated: AudienceCoverage;
    operator: AudienceCoverage;
  }>;
  duplicateCounts: Readonly<Record<DuplicateClassification, number>>;
  methodCounts: Readonly<Record<RelationMethod, number>>;
  confidenceCounts: Readonly<Record<ConfidenceBand, number>>;
  lineage: readonly LinkLineageReference[];
}>;

export type CoverageReport = Readonly<{
  schemaVersion: 'coverage-report-v1';
  jurisdiction: string;
  asOf: string;
  metrics: readonly CoverageMetric[];
  terminalStateCounts: Readonly<Record<CoverageTerminalState, number>>;
  dimensionCounts: Readonly<Record<CoverageDimension, number>>;
}>;
