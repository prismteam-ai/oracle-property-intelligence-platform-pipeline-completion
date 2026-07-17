import { createHash } from 'node:crypto';

import type { Visibility, VisibilityCounts } from '@oracle/contracts/visibility';

import type { EntityLinkingRun, LinkLineageReference } from '../entity-linking/model.js';
import type {
  ConfidenceBand,
  CoverageCompletenessState,
  CoverageGapReason,
  CoverageMetric,
  CoverageMetricInput,
  CoverageReport,
  RelationMethod,
} from './model.js';

const duplicateClasses = [
  'replay_duplicate',
  'shared_apn_distinct_units',
  'shared_authoritative_identifier',
  'shared_normalized_key',
] as const;
const relationMethods = [
  'authoritative_identifier',
  'normalized_exact',
  'bounded_candidate',
  'review_decision',
] as const;
const confidenceBands = ['high', 'medium', 'low', 'none'] as const;
const terminalStates = ['succeeded', 'partial', 'blocked', 'failed', 'unavailable'] as const;
const dimensions = ['source', 'entity', 'field', 'relation'] as const;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Coverage values must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  throw new TypeError(`Unsupported coverage input type ${typeof value}`);
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function ratio(numerator: number, denominator: number | null): number | null {
  return denominator === null ? null : round(numerator / denominator);
}

function assertCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${label} must be a non-negative safe integer`);
}

function validateLineage(value: LinkLineageReference): void {
  if (!/^sc:source:[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.sourceId)) {
    throw new TypeError('Coverage lineage source ID is malformed');
  }
  const snapshotPrefix = value.sourceId.replace('sc:source:', 'sc:snapshot:');
  if (!new RegExp(`^${snapshotPrefix}:[a-f0-9]{64}$`, 'u').test(value.snapshotId)) {
    throw new TypeError('Coverage lineage snapshot does not belong to its source');
  }
  if (!/^sc:artifact:sha256:[a-f0-9]{64}$/u.test(value.artifactId)) {
    throw new TypeError('Coverage lineage artifact ID is malformed');
  }
  if (!/^[a-f0-9]{64}$/u.test(value.recordSha256) || value.recordKey.trim().length === 0) {
    throw new TypeError('Coverage lineage record identity is malformed');
  }
}

function stableLineage(values: readonly LinkLineageReference[]): readonly LinkLineageReference[] {
  if (values.length === 0) throw new TypeError('Coverage requires immutable lineage');
  for (const value of values) validateLineage(value);
  return Object.freeze(
    [...new Map(values.map((value) => [canonicalJson(value), value])).values()]
      .sort(
        (left, right) =>
          left.sourceId.localeCompare(right.sourceId) ||
          left.snapshotId.localeCompare(right.snapshotId) ||
          left.recordKey.localeCompare(right.recordKey),
      )
      .map((value) => Object.freeze({ ...value })),
  );
}

function completeRecord<K extends string>(
  keys: readonly K[],
  input: Readonly<Partial<Record<K, number>>>,
): Readonly<Record<K, number>> {
  return Object.freeze(
    Object.fromEntries(
      keys.map((key) => {
        const value = input[key] ?? 0;
        assertCount(value, key);
        return [key, value];
      }),
    ) as Record<K, number>,
  );
}

function visibilityTotal(counts: VisibilityCounts): number {
  return counts.public + counts.authenticated + counts.restricted + counts.prohibited_public;
}

function deriveCompleteness(input: CoverageMetricInput): CoverageCompletenessState {
  if (input.terminalState === 'blocked') return 'blocked';
  if (input.terminalState === 'failed') return 'failed';
  if (input.terminalState === 'unavailable' || input.denominator.value === null) return 'unknown';
  if (input.terminalState === 'succeeded' && input.numerator >= input.denominator.value)
    return 'complete';
  return 'partial';
}

function validateTimeWindow(input: CoverageMetricInput): void {
  if (input.timeWindow === null) return;
  const start = Date.parse(input.timeWindow.start);
  const end = Date.parse(input.timeWindow.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    throw new RangeError('Coverage time window must be ordered ISO-8601 values');
  }
}

function validateGaps(
  input: CoverageMetricInput,
  completenessState: CoverageCompletenessState,
): readonly CoverageGapReason[] {
  const gaps = input.gapReasons
    .map((gap) => {
      if (gap.detail.trim().length === 0)
        throw new TypeError('Coverage gap detail must be non-empty');
      if (gap.count !== null) assertCount(gap.count, `gap ${gap.code}`);
      return Object.freeze({ ...gap });
    })
    .sort(
      (left, right) =>
        left.code.localeCompare(right.code) || left.detail.localeCompare(right.detail),
    );
  if (completenessState !== 'complete' && gaps.length === 0) {
    throw new Error('Non-complete coverage requires at least one explicit gap reason');
  }
  if (
    input.denominator.value === null &&
    !gaps.some(
      ({ code }) => code === 'denominator_unavailable' || code === 'capability_unavailable',
    )
  ) {
    throw new Error('Unknown denominator requires an explicit denominator/capability gap');
  }
  if (
    input.denominator.value !== null &&
    input.numerator > input.denominator.value &&
    !gaps.some(({ code }) => code === 'numerator_exceeds_denominator')
  ) {
    throw new Error('A numerator above its denominator requires an explicit gap reason');
  }
  return Object.freeze(gaps);
}

export function measureCoverage(input: CoverageMetricInput): CoverageMetric {
  if (
    input.dataset.trim().length === 0 ||
    input.subject.trim().length === 0 ||
    input.jurisdiction.trim().length === 0
  ) {
    throw new TypeError('Coverage dataset, subject, and jurisdiction are required');
  }
  assertCount(input.numerator, 'Coverage numerator');
  if (input.denominator.value !== null) {
    assertCount(input.denominator.value, 'Coverage denominator');
    if (input.denominator.value === 0) {
      throw new RangeError(
        'A zero denominator cannot establish complete empty coverage; use null with a gap reason',
      );
    }
  }
  if (!Number.isFinite(Date.parse(input.denominator.asOf)))
    throw new TypeError('Coverage denominator asOf is invalid');
  if (input.denominator.scope.trim().length === 0)
    throw new TypeError('Coverage denominator scope is required');
  if (input.sourceIds.length === 0) throw new TypeError('Coverage requires at least one source ID');
  validateTimeWindow(input);
  for (const [key, value] of Object.entries(input.visibilityCounts))
    assertCount(value, `visibility ${key}`);
  if (visibilityTotal(input.visibilityCounts) !== input.numerator) {
    throw new Error('Visibility counts must sum to the measured numerator');
  }
  const duplicateCounts = completeRecord(duplicateClasses, input.duplicateCounts);
  const methodCounts = completeRecord(relationMethods, input.methodCounts ?? {});
  const confidenceCounts = completeRecord(confidenceBands, input.confidenceCounts ?? {});
  if (input.dimension === 'relation') {
    const methodTotal = Object.values(methodCounts).reduce((sum, count) => sum + count, 0);
    const confidenceTotal = Object.values(confidenceCounts).reduce((sum, count) => sum + count, 0);
    if (methodTotal !== input.numerator || confidenceTotal !== input.numerator) {
      throw new Error('Relation method and confidence counts must each sum to the numerator');
    }
  } else if (
    Object.values(methodCounts).some((count) => count !== 0) ||
    Object.values(confidenceCounts).some((count) => count !== 0)
  ) {
    throw new Error('Only relation coverage may report match methods and confidence');
  }
  const completenessState = deriveCompleteness(input);
  const gapReasons = validateGaps(input, completenessState);
  const denominatorLineage = stableLineage(input.denominator.lineage);
  const lineage = stableLineage([...input.lineage, ...denominatorLineage]);
  const denominator = Object.freeze({ ...input.denominator, lineage: denominatorLineage });
  const publicCount = input.visibilityCounts.public;
  const authenticatedCount = publicCount + input.visibilityCounts.authenticated;
  const operatorCount = authenticatedCount + input.visibilityCounts.restricted;
  const identity = {
    dimension: input.dimension,
    dataset: input.dataset,
    subject: input.subject,
    jurisdiction: input.jurisdiction,
    timeWindow: input.timeWindow,
    denominator,
    lineage,
  };
  return Object.freeze({
    metricId: `sc:coverage:${hash(identity)}`,
    dimension: input.dimension,
    dataset: input.dataset,
    subject: input.subject,
    jurisdiction: input.jurisdiction,
    timeWindow: input.timeWindow === null ? null : Object.freeze({ ...input.timeWindow }),
    numerator: input.numerator,
    denominator,
    coverageRatio: ratio(input.numerator, input.denominator.value),
    completenessState,
    terminalState: input.terminalState,
    gapReasons,
    sourceIds: Object.freeze([...new Set(input.sourceIds)].sort()),
    visibilityCounts: Object.freeze({ ...input.visibilityCounts }),
    audienceCoverage: Object.freeze({
      public: Object.freeze({
        numerator: publicCount,
        ratio: ratio(publicCount, input.denominator.value),
      }),
      authenticated: Object.freeze({
        numerator: authenticatedCount,
        ratio: ratio(authenticatedCount, input.denominator.value),
      }),
      operator: Object.freeze({
        numerator: operatorCount,
        ratio: ratio(operatorCount, input.denominator.value),
      }),
    }),
    duplicateCounts,
    methodCounts,
    confidenceCounts,
    lineage,
  });
}

export function buildCoverageReport(
  jurisdiction: string,
  asOf: string,
  input: readonly CoverageMetricInput[],
): CoverageReport {
  if (jurisdiction.trim().length === 0 || !Number.isFinite(Date.parse(asOf))) {
    throw new TypeError('Coverage report requires a jurisdiction and ISO-8601 asOf');
  }
  const byId = new Map<string, CoverageMetric>();
  for (const candidate of input.map(measureCoverage)) {
    const previous = byId.get(candidate.metricId);
    if (previous !== undefined && canonicalJson(previous) !== canonicalJson(candidate)) {
      throw new Error(`Coverage metric ID ${candidate.metricId} was reused`);
    }
    byId.set(candidate.metricId, candidate);
  }
  const metrics = [...byId.values()].sort(
    (left, right) =>
      left.dimension.localeCompare(right.dimension) ||
      left.dataset.localeCompare(right.dataset) ||
      left.subject.localeCompare(right.subject),
  );
  const terminalStateCounts = completeRecord(
    terminalStates,
    Object.fromEntries(
      terminalStates.map((state) => [
        state,
        metrics.filter((metric) => metric.terminalState === state).length,
      ]),
    ),
  );
  const dimensionCounts = completeRecord(
    dimensions,
    Object.fromEntries(
      dimensions.map((dimension) => [
        dimension,
        metrics.filter((metric) => metric.dimension === dimension).length,
      ]),
    ),
  );
  return Object.freeze({
    schemaVersion: 'coverage-report-v1',
    jurisdiction,
    asOf,
    metrics: Object.freeze(metrics),
    terminalStateCounts,
    dimensionCounts,
  });
}

function visibilityCounts(values: readonly Visibility[]): VisibilityCounts {
  return Object.freeze({
    public: values.filter((value) => value === 'public').length,
    authenticated: values.filter((value) => value === 'authenticated').length,
    restricted: values.filter((value) => value === 'restricted').length,
    prohibited_public: values.filter((value) => value === 'prohibited_public').length,
  });
}

export type LinkingCoverageContext = Readonly<{
  dataset: string;
  subject: string;
  jurisdiction: string;
  timeWindow: CoverageMetricInput['timeWindow'];
  sourceIds: readonly string[];
  asOf: string;
  lineage: readonly LinkLineageReference[];
}>;

export function relationCoverageFromLinkingRun(
  run: EntityLinkingRun,
  context: LinkingCoverageContext,
): CoverageMetric {
  const accepted = run.resolutions.filter(
    ({ state }) => state === 'accepted' || state === 'review_accepted',
  );
  const methodCounts: Partial<Record<RelationMethod, number>> = {};
  const confidenceCounts: Partial<Record<ConfidenceBand, number>> = {};
  for (const resolution of accepted) {
    const method: RelationMethod =
      resolution.state === 'review_accepted'
        ? 'review_decision'
        : (resolution.matchStage ?? 'bounded_candidate');
    methodCounts[method] = (methodCounts[method] ?? 0) + 1;
    const confidence: ConfidenceBand =
      method === 'authoritative_identifier' || method === 'normalized_exact'
        ? 'high'
        : method === 'review_decision'
          ? 'medium'
          : 'low';
    confidenceCounts[confidence] = (confidenceCounts[confidence] ?? 0) + 1;
  }
  const unresolved = run.resolutions.filter(
    ({ state }) => !['accepted', 'review_accepted'].includes(state),
  );
  const gapReasons: CoverageGapReason[] = [];
  const unknown = unresolved.filter(({ state }) => state === 'unknown').length;
  const ambiguous = unresolved.filter(({ state }) => state === 'ambiguous').length;
  const pending = unresolved.filter(({ state }) => state === 'candidate').length;
  const unmatched = unresolved.length - unknown - ambiguous - pending;
  if (unknown > 0)
    gapReasons.push({
      code: 'capability_unavailable',
      count: unknown,
      detail: 'Source capability is blocked or unavailable.',
    });
  if (ambiguous > 0)
    gapReasons.push({
      code: 'ambiguous_links',
      count: ambiguous,
      detail: 'Multiple candidates remain visible and unresolved.',
    });
  if (pending > 0)
    gapReasons.push({
      code: 'candidate_review_pending',
      count: pending,
      detail: 'Bounded candidate links require a separate review decision.',
    });
  if (unmatched > 0)
    gapReasons.push({
      code: 'unmatched_records',
      count: unmatched,
      detail: 'No accepted link exists after the ordered matching stages.',
    });
  const restricted = accepted.filter(({ visibility }) => visibility !== 'public').length;
  if (restricted > 0)
    gapReasons.push({
      code: 'restricted_visibility',
      count: restricted,
      detail: 'Accepted links retain source visibility and are not all publicly queryable.',
    });
  const duplicateCounts = Object.fromEntries(
    duplicateClasses.map((classification) => [
      classification,
      run.duplicateGroups.filter((group) => group.classification === classification).length,
    ]),
  );
  if (run.duplicateGroups.length > 0) {
    gapReasons.push({
      code: 'duplicate_records',
      count: run.duplicateGroups.length,
      detail:
        'Duplicate/shared-key classifications are retained rather than first-row deduplicated.',
    });
  }
  return measureCoverage({
    dimension: 'relation',
    dataset: context.dataset,
    subject: context.subject,
    jurisdiction: context.jurisdiction,
    timeWindow: context.timeWindow,
    numerator: accepted.length,
    denominator: {
      value: run.resolutions.length === 0 ? null : run.resolutions.length,
      method: run.resolutions.length === 0 ? 'capability_unavailable' : 'observed_population',
      scope: `${context.jurisdiction}|${context.subject}`,
      asOf: context.asOf,
      lineage: context.lineage,
    },
    terminalState:
      run.resolutions.length === 0
        ? 'unavailable'
        : unresolved.length === 0
          ? 'succeeded'
          : unknown === run.resolutions.length
            ? 'blocked'
            : 'partial',
    gapReasons:
      run.resolutions.length === 0
        ? [
            {
              code: 'denominator_unavailable',
              count: null,
              detail: 'No source population was available for measurement.',
            },
          ]
        : gapReasons,
    sourceIds: context.sourceIds,
    visibilityCounts: visibilityCounts(accepted.map(({ visibility }) => visibility)),
    duplicateCounts,
    methodCounts,
    confidenceCounts,
    lineage: context.lineage,
  });
}
