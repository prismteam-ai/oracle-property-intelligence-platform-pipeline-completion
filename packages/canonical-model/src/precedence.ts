import { isoDateTimeSchema } from '@oracle/contracts/foundation';

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | Readonly<{ [key: string]: CanonicalValue }>;

export type PrecedenceCandidate<TValue extends CanonicalValue = CanonicalValue> = Readonly<{
  observationId: string;
  authorityPriority: number;
  sourceAsOf: string;
  observedAt: string;
  confidence: number;
  value: TValue;
}>;

export type PrecedenceDecision<TValue extends CanonicalValue = CanonicalValue> = Readonly<{
  algorithm: 'canonical-precedence-v1';
  selected: PrecedenceCandidate<TValue>;
  orderedObservationIds: readonly string[];
  hasConflict: boolean;
}>;

function compareDateDescending(left: string, right: string): number {
  const leftTime = Date.parse(isoDateTimeSchema.parse(left));
  const rightTime = Date.parse(isoDateTimeSchema.parse(right));
  return rightTime - leftTime;
}

function canonicalize(value: CanonicalValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical numeric values must be finite');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const arrayValue = value as readonly CanonicalValue[];
    return `[${arrayValue.map((item) => canonicalize(item)).join(',')}]`;
  }
  const objectValue = value as Readonly<Record<string, CanonicalValue>>;
  return `{${Object.entries(objectValue)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(',')}}`;
}

function compareCandidates<TValue extends CanonicalValue>(
  left: PrecedenceCandidate<TValue>,
  right: PrecedenceCandidate<TValue>,
): number {
  return (
    right.authorityPriority - left.authorityPriority ||
    compareDateDescending(left.sourceAsOf, right.sourceAsOf) ||
    compareDateDescending(left.observedAt, right.observedAt) ||
    right.confidence - left.confidence ||
    (left.observationId < right.observationId
      ? -1
      : left.observationId > right.observationId
        ? 1
        : 0)
  );
}

function assertCandidate(candidate: PrecedenceCandidate): void {
  if (candidate.observationId.trim().length === 0) {
    throw new TypeError('Precedence observationId must not be empty');
  }
  if (!Number.isSafeInteger(candidate.authorityPriority) || candidate.authorityPriority < 0) {
    throw new RangeError('Precedence authorityPriority must be a non-negative safe integer');
  }
  if (
    !Number.isFinite(candidate.confidence) ||
    candidate.confidence < 0 ||
    candidate.confidence > 1
  ) {
    throw new RangeError('Precedence confidence must be between zero and one');
  }
  compareDateDescending(candidate.sourceAsOf, candidate.observedAt);
  canonicalize(candidate.value);
}

export function selectByCanonicalPrecedence<TValue extends CanonicalValue>(
  candidates: readonly PrecedenceCandidate<TValue>[],
): PrecedenceDecision<TValue> {
  if (candidates.length === 0) {
    throw new RangeError('Canonical precedence requires at least one observation');
  }
  for (const candidate of candidates) {
    assertCandidate(candidate);
  }

  const observationIds = new Set(candidates.map(({ observationId }) => observationId));
  if (observationIds.size !== candidates.length) {
    throw new Error('Canonical precedence observation IDs must be unique');
  }

  const ordered = [...candidates].sort(compareCandidates);
  const selected = ordered[0];
  if (selected === undefined) {
    throw new Error('Canonical precedence failed to select an observation');
  }
  const values = new Set(ordered.map(({ value }) => canonicalize(value)));

  return Object.freeze({
    algorithm: 'canonical-precedence-v1',
    selected,
    orderedObservationIds: Object.freeze(ordered.map(({ observationId }) => observationId)),
    hasConflict: values.size > 1,
  });
}
