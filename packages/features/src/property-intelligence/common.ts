import { createHash } from 'node:crypto';

import type { EvidenceSourceReference, FeatureKind } from '@oracle/contracts/evidence';
import type { EntityId } from '@oracle/contracts/ids';
import type { SupportState } from '@oracle/contracts/pipeline';
import type { Visibility } from '@oracle/contracts/visibility';

import { createFeatureEvidence, type ImmutableFeatureEvidence } from '../feature-evidence.js';

export type JsonPrimitive = boolean | number | string | null;
export type JsonData = JsonPrimitive | readonly JsonData[] | { readonly [key: string]: JsonData };

export type CoverageState = 'complete' | 'partial' | 'blocked' | 'unknown';

export type ImmutableEvidenceSourceReference = Readonly<
  Omit<EvidenceSourceReference, 'fieldPaths'> & { readonly fieldPaths: readonly string[] }
>;

export interface SourceObservation {
  readonly observationId: string;
  readonly kind: string;
  readonly reference: ImmutableEvidenceSourceReference;
  readonly observedAt: string;
  readonly sourceAsOf: string | null;
  readonly visibility: Visibility;
  readonly fields: Readonly<Record<string, JsonData>>;
}

export interface InquiryCoverage {
  readonly state: CoverageState;
  readonly jurisdiction: string;
  readonly windowStart: string | null;
  readonly windowEnd: string | null;
  readonly measuredAt: string;
  readonly sourceIds: readonly string[];
  readonly limitations: readonly string[];
  readonly observations: readonly SourceObservation[];
}

export interface InquiryCalculation {
  readonly name: string;
  readonly version: string;
  readonly parameters: Readonly<Record<string, JsonData>>;
}

export interface InquiryResult<T> {
  readonly propertyId: EntityId;
  readonly feature: FeatureKind;
  readonly value: Readonly<T> | null;
  readonly supportClass: SupportState;
  readonly confidence: number;
  readonly sourceObservations: readonly SourceObservation[];
  readonly calculation: InquiryCalculation;
  readonly asOf: string;
  readonly coverage: InquiryCoverage;
  readonly limitations: readonly string[];
  readonly visibility: Visibility;
  readonly evidence: ImmutableFeatureEvidence;
}

const VISIBILITY_RANK: Readonly<Record<Visibility, number>> = Object.freeze({
  public: 0,
  authenticated: 1,
  restricted: 2,
  prohibited_public: 3,
});

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
}

export function parseInstant(value: string, label: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError(`${label} must be an ISO-8601 timestamp`);
  }
  return milliseconds;
}

function jsonClone(value: unknown, label: string): JsonData {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${label} contains a non-finite number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item, index) => jsonClone(item, `${label}[${index}]`)));
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    const output: Record<string, JsonData> = {};
    for (const [key, item] of entries) {
      if (item === undefined) {
        throw new TypeError(`${label}.${key} must not be undefined`);
      }
      output[key] = jsonClone(item, `${label}.${key}`);
    }
    return Object.freeze(output);
  }
  throw new TypeError(`${label} is not JSON data`);
}

export function stableJson(value: unknown): string {
  return JSON.stringify(jsonClone(value, 'value'));
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}

function normalizeObservation(observation: SourceObservation): SourceObservation {
  assertNonEmpty(observation.observationId, 'observationId');
  assertNonEmpty(observation.kind, 'observation kind');
  parseInstant(observation.observedAt, 'observation observedAt');
  if (observation.sourceAsOf !== null) {
    parseInstant(observation.sourceAsOf, 'observation sourceAsOf');
  }
  const fields = jsonClone(observation.fields, 'observation fields');
  if (Array.isArray(fields) || fields === null || typeof fields !== 'object') {
    throw new TypeError('observation fields must be an object');
  }
  return Object.freeze({
    ...observation,
    reference: Object.freeze({
      ...observation.reference,
      fieldPaths: sortedUnique(observation.reference.fieldPaths),
    }),
    fields: fields as Readonly<Record<string, JsonData>>,
  });
}

export function normalizeCoverage(coverage: InquiryCoverage): InquiryCoverage {
  assertNonEmpty(coverage.jurisdiction, 'coverage jurisdiction');
  parseInstant(coverage.measuredAt, 'coverage measuredAt');
  const start =
    coverage.windowStart === null
      ? null
      : parseInstant(coverage.windowStart, 'coverage windowStart');
  const end =
    coverage.windowEnd === null ? null : parseInstant(coverage.windowEnd, 'coverage windowEnd');
  if (coverage.state === 'complete' && (start === null || end === null)) {
    throw new TypeError('Complete coverage requires a bounded time window');
  }
  if (start !== null && end !== null && start > end) {
    throw new RangeError('coverage windowStart must not be after windowEnd');
  }
  const observations = coverage.observations
    .map(normalizeObservation)
    .sort((left, right) => left.observationId.localeCompare(right.observationId));
  if (
    new Set(observations.map(({ observationId }) => observationId)).size !== observations.length
  ) {
    throw new TypeError('Coverage observation IDs must be unique');
  }
  return Object.freeze({
    ...coverage,
    sourceIds: sortedUnique(coverage.sourceIds),
    limitations: sortedUnique(coverage.limitations),
    observations: Object.freeze(observations),
  });
}

export function coverageContains(
  coverage: InquiryCoverage,
  requiredStart: string,
  requiredEnd: string,
): boolean {
  if (
    coverage.state !== 'complete' ||
    coverage.windowStart === null ||
    coverage.windowEnd === null
  ) {
    return false;
  }
  return (
    parseInstant(coverage.windowStart, 'coverage windowStart') <=
      parseInstant(requiredStart, 'required start') &&
    parseInstant(coverage.windowEnd, 'coverage windowEnd') >=
      parseInstant(requiredEnd, 'required end')
  );
}

export function yearsBefore(asOf: string, years: number): string {
  if (!Number.isInteger(years) || years < 0) {
    throw new RangeError('years must be a non-negative integer');
  }
  const date = new Date(parseInstant(asOf, 'asOf'));
  const originalMonth = date.getUTCMonth();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  if (date.getUTCMonth() !== originalMonth) {
    date.setUTCDate(0);
  }
  return date.toISOString();
}

export function wholeYearsBetween(earlier: string, later: string): number {
  const earlierDate = new Date(parseInstant(earlier, 'earlier date'));
  const laterDate = new Date(parseInstant(later, 'later date'));
  if (earlierDate.getTime() > laterDate.getTime()) {
    throw new RangeError('earlier date must not be after later date');
  }
  let years = laterDate.getUTCFullYear() - earlierDate.getUTCFullYear();
  const anniversary = new Date(earlierDate.getTime());
  anniversary.setUTCFullYear(earlierDate.getUTCFullYear() + years);
  if (anniversary.getTime() > laterDate.getTime()) {
    years -= 1;
  }
  return years;
}

function mergeReferences(
  observations: readonly SourceObservation[],
): readonly EvidenceSourceReference[] {
  const references = new Map<string, EvidenceSourceReference>();
  for (const observation of observations) {
    const reference = observation.reference;
    const key = [
      reference.sourceId,
      reference.snapshotId,
      reference.artifactId,
      reference.recordKey,
    ].join('\0');
    const prior = references.get(key);
    references.set(key, {
      ...reference,
      fieldPaths: [...sortedUnique([...(prior?.fieldPaths ?? []), ...reference.fieldPaths])],
    });
  }
  return Object.freeze(
    [...references.values()].sort((left, right) => {
      const leftKey = `${left.sourceId}\0${left.snapshotId}\0${left.recordKey}`;
      const rightKey = `${right.sourceId}\0${right.snapshotId}\0${right.recordKey}`;
      return leftKey.localeCompare(rightKey);
    }),
  );
}

function strictestVisibility(observations: readonly SourceObservation[]): Visibility {
  return observations.reduce<Visibility>(
    (strictest, observation) =>
      VISIBILITY_RANK[observation.visibility] > VISIBILITY_RANK[strictest]
        ? observation.visibility
        : strictest,
    'public',
  );
}

export function buildInquiryResult<T>(input: {
  readonly propertyId: EntityId;
  readonly feature: FeatureKind;
  readonly value: T | null;
  readonly supportClass: SupportState;
  readonly confidence: number;
  readonly observations: readonly SourceObservation[];
  readonly calculation: InquiryCalculation;
  readonly asOf: string;
  readonly coverage: InquiryCoverage;
  readonly limitations: readonly string[];
}): InquiryResult<T> {
  parseInstant(input.asOf, 'asOf');
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new RangeError('confidence must be between zero and one');
  }
  const coverage = normalizeCoverage(input.coverage);
  const observations = [...input.observations, ...coverage.observations]
    .map(normalizeObservation)
    .sort((left, right) => left.observationId.localeCompare(right.observationId));
  if (
    new Set(observations.map(({ observationId }) => observationId)).size !== observations.length
  ) {
    throw new TypeError('Inquiry observation IDs must be unique');
  }
  const limitations = sortedUnique([...coverage.limitations, ...input.limitations]);
  if (input.supportClass !== 'supported' && limitations.length === 0) {
    throw new TypeError('Non-supported inquiry results require a limitation');
  }
  const calculation = Object.freeze({
    ...input.calculation,
    parameters: jsonClone(input.calculation.parameters, 'calculation parameters') as Readonly<
      Record<string, JsonData>
    >,
  });
  const value =
    input.value === null ? null : (jsonClone(input.value, 'result value') as Readonly<T>);
  const visibility = strictestVisibility(observations);
  const references = mergeReferences(observations);
  const evidenceDigest = createHash('sha256')
    .update(
      stableJson({
        propertyId: input.propertyId,
        feature: input.feature,
        value,
        supportClass: input.supportClass,
        confidence: input.confidence,
        observations,
        calculation,
        asOf: input.asOf,
        coverage,
        limitations,
        visibility,
      }),
    )
    .digest('hex');
  const evidence = createFeatureEvidence({
    evidenceId: `sc:evidence:${evidenceDigest}`,
    entityId: input.propertyId,
    feature: input.feature,
    supportState: input.supportClass,
    confidence: input.confidence,
    value,
    sourceReferences: references,
    algorithm: calculation,
    asOf: input.asOf,
    visibility,
    limitations,
  });

  return Object.freeze({
    propertyId: input.propertyId,
    feature: input.feature,
    value,
    supportClass: input.supportClass,
    confidence: input.confidence,
    sourceObservations: Object.freeze(observations),
    calculation,
    asOf: input.asOf,
    coverage,
    limitations,
    visibility,
    evidence,
  });
}
