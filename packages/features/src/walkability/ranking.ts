import { isoDateTimeSchema } from '@oracle/contracts/foundation';

import { mostRestrictiveVisibility, sortedUnique } from './evidence.js';
import type { SupportState, Visibility } from './types.js';

export type RankingCriterion =
  | 'roof_age'
  | 'water_view_candidate'
  | 'ownership_age'
  | 'regional_owner'
  | 'transit_walkability'
  | 'starbucks_walkability';

export interface RankingComponentPolicy {
  readonly criterion: RankingCriterion;
  readonly weight: number;
  readonly proxyMultiplier: number;
}

export interface RankingPolicy {
  readonly policyId: string;
  readonly version: string;
  readonly components: readonly RankingComponentPolicy[];
  readonly includeProxy: boolean;
  readonly minimumEvidenceCoverage: number;
  readonly unknownHandling: 'zero_contribution_and_reduce_coverage';
}

export interface RankingSignalInput {
  readonly criterion: RankingCriterion;
  readonly supportState: SupportState;
  /** Normalized deterministic component value in the closed interval [0, 1]. */
  readonly value: number | null;
  readonly evidenceLinks: readonly string[];
  readonly limitations: readonly string[];
  readonly visibility: Visibility;
}

export interface RankingCandidateInput {
  readonly propertyId: string;
  readonly signals: readonly RankingSignalInput[];
}

export interface RankingComponentResult {
  readonly criterion: RankingCriterion;
  readonly supportState: SupportState;
  readonly value: number | null;
  readonly weight: number;
  readonly appliedMultiplier: number;
  readonly contribution: number;
  readonly evidenceLinks: readonly string[];
  readonly limitations: readonly string[];
  readonly exclusionReason:
    'missing_evidence' | 'proxy_disabled' | 'unknown' | 'unsupported' | null;
}

export interface RankedCandidate {
  readonly rank: number | null;
  readonly propertyId: string;
  readonly score: number;
  readonly weightedScore: number;
  readonly maximumWeightedScore: number;
  readonly evidenceCoverage: number;
  readonly excluded: boolean;
  readonly exclusionReasons: readonly string[];
  readonly components: readonly RankingComponentResult[];
  readonly evidenceLinks: readonly string[];
  readonly limitations: readonly string[];
  readonly visibility: Visibility;
}

export interface RankingResult {
  readonly policy: RankingPolicy;
  readonly calculation: Readonly<{
    name: 'transparent-evidence-weighted-ranking';
    version: '1.0.0';
    asOf: string;
    denominator: 'all_configured_component_weights';
    unknownHandling: 'zero_contribution_and_reduce_coverage';
  }>;
  readonly candidates: readonly RankedCandidate[];
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function assertPolicy(policy: RankingPolicy): void {
  if (policy.policyId.trim().length === 0 || policy.version.trim().length === 0) {
    throw new TypeError('Ranking policy ID and version are required');
  }
  if (
    !Number.isFinite(policy.minimumEvidenceCoverage) ||
    policy.minimumEvidenceCoverage < 0 ||
    policy.minimumEvidenceCoverage > 1
  ) {
    throw new TypeError('Minimum evidence coverage must be in [0, 1]');
  }
  if (policy.components.length === 0) throw new TypeError('Ranking requires components');
  const criteria = policy.components.map(({ criterion }) => criterion);
  if (new Set(criteria).size !== criteria.length) {
    throw new TypeError('Ranking policy criteria must be unique');
  }
  for (const component of policy.components) {
    if (!Number.isFinite(component.weight) || component.weight < 0) {
      throw new TypeError(`Invalid weight for ${component.criterion}`);
    }
    if (
      !Number.isFinite(component.proxyMultiplier) ||
      component.proxyMultiplier < 0 ||
      component.proxyMultiplier > 1
    ) {
      throw new TypeError(`Invalid proxy multiplier for ${component.criterion}`);
    }
  }
  if (policy.components.every(({ weight }) => weight === 0)) {
    throw new TypeError('Ranking total configured weight must be positive');
  }
}

function assertSignal(signal: RankingSignalInput): void {
  const evidenceBearing = signal.supportState === 'supported' || signal.supportState === 'proxy';
  if (evidenceBearing) {
    if (
      signal.value === null ||
      !Number.isFinite(signal.value) ||
      signal.value < 0 ||
      signal.value > 1
    ) {
      throw new TypeError(`${signal.criterion} evidence value must be in [0, 1]`);
    }
    if (signal.evidenceLinks.length === 0) {
      throw new TypeError(`${signal.criterion} evidence requires at least one evidence link`);
    }
  } else if (signal.value !== null) {
    throw new TypeError(`${signal.criterion} ${signal.supportState} evidence must have null value`);
  }
}

function componentResult(
  component: RankingComponentPolicy,
  signal: RankingSignalInput | undefined,
  includeProxy: boolean,
): RankingComponentResult {
  if (signal === undefined) {
    return Object.freeze({
      criterion: component.criterion,
      supportState: 'unknown',
      value: null,
      weight: component.weight,
      appliedMultiplier: 0,
      contribution: 0,
      evidenceLinks: Object.freeze([]),
      limitations: Object.freeze([
        'No evidence signal was supplied for this configured criterion.',
      ]),
      exclusionReason: 'missing_evidence',
    });
  }
  assertSignal(signal);
  const proxyDisabled = signal.supportState === 'proxy' && !includeProxy;
  const multiplier =
    signal.supportState === 'supported'
      ? 1
      : signal.supportState === 'proxy' && includeProxy
        ? component.proxyMultiplier
        : 0;
  const contribution = signal.value === null ? 0 : signal.value * component.weight * multiplier;
  const exclusionReason = proxyDisabled
    ? 'proxy_disabled'
    : signal.supportState === 'unknown'
      ? 'unknown'
      : signal.supportState === 'unsupported'
        ? 'unsupported'
        : null;
  return Object.freeze({
    criterion: component.criterion,
    supportState: signal.supportState,
    value: signal.value,
    weight: component.weight,
    appliedMultiplier: multiplier,
    contribution: round(contribution),
    evidenceLinks: sortedUnique(signal.evidenceLinks),
    limitations: sortedUnique(signal.limitations),
    exclusionReason,
  });
}

function rankCandidate(
  candidate: RankingCandidateInput,
  policy: RankingPolicy,
): Omit<RankedCandidate, 'rank'> {
  if (candidate.propertyId.trim().length === 0) throw new TypeError('Property ID is required');
  const signals = new Map<RankingCriterion, RankingSignalInput>();
  for (const signal of candidate.signals) {
    if (signals.has(signal.criterion)) {
      throw new TypeError(`Duplicate ${signal.criterion} signal for ${candidate.propertyId}`);
    }
    signals.set(signal.criterion, signal);
  }
  const configuredCriteria = new Set(policy.components.map(({ criterion }) => criterion));
  for (const criterion of signals.keys()) {
    if (!configuredCriteria.has(criterion)) {
      throw new TypeError(
        `Ranking signal criterion ${criterion} is not configured by policy ${policy.policyId}`,
      );
    }
  }
  const components = policy.components.map((component) =>
    componentResult(component, signals.get(component.criterion), policy.includeProxy),
  );
  const maximumWeightedScore = policy.components.reduce(
    (total, component) => total + component.weight,
    0,
  );
  const weightedScore = components.reduce((total, component) => total + component.contribution, 0);
  const evidencedWeight = components.reduce(
    (total, component) => (component.exclusionReason === null ? total + component.weight : total),
    0,
  );
  const evidenceCoverage = evidencedWeight / maximumWeightedScore;
  const exclusionReasons =
    evidenceCoverage < policy.minimumEvidenceCoverage
      ? Object.freeze([
          `evidence_coverage_below_minimum:${round(evidenceCoverage)}<${policy.minimumEvidenceCoverage}`,
        ])
      : Object.freeze([]);
  const selectedSignals = [...signals.values()];
  return Object.freeze({
    propertyId: candidate.propertyId,
    score: round(weightedScore / maximumWeightedScore),
    weightedScore: round(weightedScore),
    maximumWeightedScore: round(maximumWeightedScore),
    evidenceCoverage: round(evidenceCoverage),
    excluded: exclusionReasons.length > 0,
    exclusionReasons,
    components: Object.freeze(components),
    evidenceLinks: sortedUnique(components.flatMap((component) => component.evidenceLinks)),
    limitations: sortedUnique(components.flatMap((component) => component.limitations)),
    visibility: mostRestrictiveVisibility(selectedSignals.map((signal) => signal.visibility)),
  });
}

/**
 * Missing and unknown signals always contribute zero against the full configured
 * denominator. They can only lower evidence coverage, never increase a score.
 */
export function rankReviewCandidates(
  policy: RankingPolicy,
  candidates: readonly RankingCandidateInput[],
  asOf: string,
): RankingResult {
  assertPolicy(policy);
  const calculationAsOf = isoDateTimeSchema.parse(asOf);
  const propertyIds = candidates.map(({ propertyId }) => propertyId);
  if (new Set(propertyIds).size !== propertyIds.length) {
    throw new TypeError('Ranking candidate property IDs must be unique');
  }
  const unranked = candidates.map((candidate) => rankCandidate(candidate, policy));
  unranked.sort(
    (left, right) =>
      Number(left.excluded) - Number(right.excluded) ||
      right.score - left.score ||
      right.evidenceCoverage - left.evidenceCoverage ||
      left.propertyId.localeCompare(right.propertyId),
  );
  let rank = 0;
  const ranked = unranked.map((candidate) => {
    if (!candidate.excluded) rank += 1;
    return Object.freeze({ ...candidate, rank: candidate.excluded ? null : rank });
  });
  return Object.freeze({
    policy: Object.freeze({
      ...policy,
      components: Object.freeze(
        policy.components.map((component) => Object.freeze({ ...component })),
      ),
    }),
    calculation: Object.freeze({
      name: 'transparent-evidence-weighted-ranking',
      version: '1.0.0',
      asOf: calculationAsOf,
      denominator: 'all_configured_component_weights',
      unknownHandling: policy.unknownHandling,
    }),
    candidates: Object.freeze(ranked),
  });
}
