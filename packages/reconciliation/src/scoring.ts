export type ReconciliationSignal = Readonly<{
  key: string;
  agreement: number;
  weight: number;
  hardBlock?: boolean;
}>;

export type ReconciliationThresholds = Readonly<{
  autoLink: number;
  review: number;
}>;

export type ReconciliationDecision = Readonly<{
  algorithm: 'weighted-reconciliation-v1';
  score: number;
  classification: 'auto_link' | 'review' | 'reject';
  hardBlocked: boolean;
  contributions: readonly Readonly<{
    key: string;
    weightedAgreement: number;
  }>[];
}>;

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

export function scoreReconciliation(
  signals: readonly ReconciliationSignal[],
  thresholds: ReconciliationThresholds,
): ReconciliationDecision {
  if (signals.length === 0) {
    throw new RangeError('Reconciliation scoring requires at least one signal');
  }
  if (
    !Number.isFinite(thresholds.autoLink) ||
    !Number.isFinite(thresholds.review) ||
    thresholds.review < 0 ||
    thresholds.autoLink > 1 ||
    thresholds.review >= thresholds.autoLink
  ) {
    throw new RangeError('Reconciliation thresholds require 0 <= review < autoLink <= 1');
  }

  const signalKeys = new Set<string>();
  let totalWeight = 0;
  let weightedAgreement = 0;
  let hardBlocked = false;
  const contributions: { key: string; weightedAgreement: number }[] = [];

  for (const signal of signals) {
    if (signal.key.trim().length === 0 || signalKeys.has(signal.key)) {
      throw new Error('Reconciliation signal keys must be non-empty and unique');
    }
    if (!Number.isFinite(signal.agreement) || signal.agreement < 0 || signal.agreement > 1) {
      throw new RangeError('Reconciliation agreement must be between zero and one');
    }
    if (!Number.isFinite(signal.weight) || signal.weight <= 0) {
      throw new RangeError('Reconciliation signal weight must be positive');
    }
    signalKeys.add(signal.key);
    totalWeight += signal.weight;
    weightedAgreement += signal.agreement * signal.weight;
    hardBlocked ||= signal.hardBlock === true;
    contributions.push({
      key: signal.key,
      weightedAgreement: round(signal.agreement * signal.weight),
    });
  }

  const score = round(weightedAgreement / totalWeight);
  const classification = hardBlocked
    ? 'reject'
    : score >= thresholds.autoLink
      ? 'auto_link'
      : score >= thresholds.review
        ? 'review'
        : 'reject';

  return Object.freeze({
    algorithm: 'weighted-reconciliation-v1',
    score,
    classification,
    hardBlocked,
    contributions: Object.freeze(
      contributions
        .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
        .map((contribution) => Object.freeze(contribution)),
    ),
  });
}
