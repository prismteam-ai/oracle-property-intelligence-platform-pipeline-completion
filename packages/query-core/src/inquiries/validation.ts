import type {
  CombinedRankingInput,
  InquiryCapability,
  InquiryReleaseContext,
  InquirySupportClass,
  RankingCriterion,
  RankingWeight,
} from './contracts.js';
import { INQUIRY_PAGE_SIZE_MAXIMUM } from './plans.js';

const criteria = Object.freeze([
  'roof_age',
  'water_view_candidate',
  'ownership_age',
  'regional_owner',
  'transit_walkability',
  'starbucks_walkability',
] as const satisfies readonly RankingCriterion[]);
const supportClasses = new Set<InquirySupportClass>([
  'supported',
  'proxy',
  'unknown',
  'unsupported',
]);

export type NormalizedPage = Readonly<{
  releaseId: string;
  limit: number;
  cursor: string | null;
  city: string | null;
  postalCode: string | null;
  propertyId: string | null;
}>;

function object(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

export function assertExactKeys(
  value: unknown,
  allowed: readonly string[],
  label = 'Inquiry input',
): Readonly<Record<string, unknown>> {
  const record = object(value, label);
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new TypeError(`${label} contains unsupported fields`);
  return record;
}

function boundedString(
  value: unknown,
  label: string,
  maximum: number,
  nullable = false,
): string | null {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized, 'utf8') > maximum ||
    containsControlCharacter(normalized)
  ) {
    throw new RangeError(`${label} is outside its allowed bounds`);
  }
  return normalized;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function requiredBoundedString(value: unknown, label: string, maximum: number): string {
  const result = boundedString(value, label, maximum);
  if (result === null) throw new TypeError(`${label} is required`);
  return result;
}

function boundedNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  integer: boolean,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum ||
    (integer && !Number.isInteger(value))
  ) {
    throw new RangeError(`${label} is outside its allowed bounds`);
  }
  return value;
}

function optionalBoolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean`);
  return value;
}

function instant(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 64);
  if (
    parsed === null ||
    !Number.isFinite(Date.parse(parsed)) ||
    !/[zZ]|[+-]\d\d:\d\d$/u.test(parsed)
  ) {
    throw new TypeError(`${label} must be an offset-qualified ISO-8601 timestamp`);
  }
  return parsed;
}

function capability(value: unknown, label: string): InquiryCapability {
  const record = assertExactKeys(
    value,
    ['state', 'supportClasses', 'numerator', 'denominator', 'limitations'],
    label,
  );
  if (record.state !== 'supported' && record.state !== 'partial' && record.state !== 'blocked') {
    throw new TypeError(`${label}.state is invalid`);
  }
  if (
    !Array.isArray(record.supportClasses) ||
    record.supportClasses.length === 0 ||
    !record.supportClasses.every((item) => supportClasses.has(item as InquirySupportClass))
  ) {
    throw new TypeError(`${label}.supportClasses is invalid`);
  }
  const numerator = boundedNumber(record.numerator, `${label}.numerator`, 0, 10_000_000_000, true);
  const denominator = boundedNumber(
    record.denominator,
    `${label}.denominator`,
    0,
    10_000_000_000,
    true,
  );
  if (numerator > denominator) throw new RangeError(`${label} numerator exceeds denominator`);
  if (
    !Array.isArray(record.limitations) ||
    !record.limitations.every(
      (item) => typeof item === 'string' && item.trim().length > 0 && item.length <= 500,
    )
  ) {
    throw new TypeError(`${label}.limitations is invalid`);
  }
  if (
    record.state === 'blocked' &&
    (numerator !== 0 || record.supportClasses.includes('supported'))
  ) {
    throw new TypeError(`${label} blocked capability cannot support positive claims`);
  }
  if (record.state === 'supported' && !record.supportClasses.includes('supported')) {
    throw new TypeError(`${label} supported capability must declare supported results`);
  }
  return Object.freeze({
    state: record.state,
    supportClasses: Object.freeze(
      [...new Set(record.supportClasses as readonly InquirySupportClass[])].sort(),
    ),
    numerator,
    denominator,
    limitations: Object.freeze([...(record.limitations as readonly string[])]),
  });
}

function rankingWeight(value: unknown, label: string): RankingWeight {
  const record = assertExactKeys(value, ['criterion', 'weight', 'proxyMultiplier'], label);
  if (!criteria.includes(record.criterion as RankingCriterion)) {
    throw new TypeError(`${label}.criterion is invalid`);
  }
  return Object.freeze({
    criterion: record.criterion as RankingCriterion,
    weight: boundedNumber(record.weight, `${label}.weight`, 0, 100, false),
    proxyMultiplier: boundedNumber(record.proxyMultiplier, `${label}.proxyMultiplier`, 0, 1, false),
  });
}

export function normalizeRelease(value: InquiryReleaseContext): InquiryReleaseContext {
  const record = assertExactKeys(
    value,
    [
      'schemaVersion',
      'releaseId',
      'runId',
      'manifestCid',
      'asOf',
      'policyVersion',
      'rankingWeights',
      'capabilities',
    ],
    'Release context',
  );
  const capabilitiesRecord = assertExactKeys(record.capabilities, criteria, 'Release capabilities');
  if (!Array.isArray(record.rankingWeights) || record.rankingWeights.length !== criteria.length) {
    throw new TypeError('Release rankingWeights must cover every criterion');
  }
  const weights = record.rankingWeights.map((item, index) =>
    rankingWeight(item, `Release rankingWeights[${index}]`),
  );
  if (new Set(weights.map(({ criterion }) => criterion)).size !== criteria.length) {
    throw new TypeError('Release rankingWeights contain duplicates');
  }
  if (weights.every(({ weight }) => weight === 0)) {
    throw new TypeError('Release rankingWeights require a positive weight');
  }
  const capabilities = Object.fromEntries(
    criteria.map((criterion) => [
      criterion,
      capability(capabilitiesRecord[criterion], `Release capabilities.${criterion}`),
    ]),
  ) as Record<RankingCriterion, InquiryCapability>;
  return Object.freeze({
    schemaVersion: requiredBoundedString(record.schemaVersion, 'schemaVersion', 64),
    releaseId: requiredBoundedString(record.releaseId, 'releaseId', 256),
    runId: requiredBoundedString(record.runId, 'runId', 256),
    manifestCid: requiredBoundedString(record.manifestCid, 'manifestCid', 512),
    asOf: instant(record.asOf, 'asOf'),
    policyVersion: requiredBoundedString(record.policyVersion, 'policyVersion', 256),
    rankingWeights: Object.freeze(weights.sort((a, b) => a.criterion.localeCompare(b.criterion))),
    capabilities: Object.freeze(capabilities),
  });
}

export function normalizePage(
  record: Readonly<Record<string, unknown>>,
  release: InquiryReleaseContext,
): NormalizedPage {
  const releaseId = requiredBoundedString(record.releaseId, 'releaseId', 256);
  if (releaseId !== release.releaseId) throw new TypeError('Request releaseId is stale');
  const limit =
    record.limit === undefined
      ? 20
      : boundedNumber(record.limit, 'limit', 1, INQUIRY_PAGE_SIZE_MAXIMUM, true);
  const cursor = boundedString(record.cursor, 'cursor', 512, true);
  return Object.freeze({
    releaseId,
    limit,
    cursor,
    city: boundedString(record.city, 'city', 100, true),
    postalCode: boundedString(record.postalCode, 'postalCode', 20, true),
    propertyId: boundedString(record.propertyId, 'propertyId', 256, true),
  });
}

export function optionalBoundedNumber(
  record: Readonly<Record<string, unknown>>,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
  integer = true,
): number {
  return record[field] === undefined
    ? fallback
    : boundedNumber(record[field], field, minimum, maximum, integer);
}

export function optionalStrictBoolean(
  record: Readonly<Record<string, unknown>>,
  field: string,
  fallback: boolean,
): boolean {
  return optionalBoolean(record[field], field, fallback);
}

export function assertAsOf(
  record: Readonly<Record<string, unknown>>,
  release: InquiryReleaseContext,
): void {
  if (record.asOf !== undefined && instant(record.asOf, 'asOf') !== release.asOf) {
    throw new TypeError('Request asOf does not match the immutable release');
  }
}

export function normalizeRanking(
  input: CombinedRankingInput,
  release: InquiryReleaseContext,
): Readonly<{
  criteria: readonly RankingCriterion[];
  weights: readonly RankingWeight[];
  includeProxy: boolean;
  minimumEvidenceCoverage: number;
}> {
  const record = input as Readonly<Record<string, unknown>>;
  const selected =
    input.criteria === undefined
      ? criteria
      : input.criteria.map((criterion) => {
          if (!criteria.includes(criterion)) throw new TypeError('Ranking criterion is invalid');
          return criterion;
        });
  if (selected.length === 0 || new Set(selected).size !== selected.length) {
    throw new TypeError('Ranking criteria must be unique and non-empty');
  }
  const supplied =
    input.weights === undefined
      ? release.rankingWeights
      : input.weights.map((item, index) => rankingWeight(item, `weights[${index}]`));
  if (new Set(supplied.map(({ criterion }) => criterion)).size !== supplied.length) {
    throw new TypeError('Ranking weights contain duplicate criteria');
  }
  const suppliedByCriterion = new Map(supplied.map((weight) => [weight.criterion, weight]));
  const defaultsByCriterion = new Map(
    release.rankingWeights.map((weight) => [weight.criterion, weight]),
  );
  const normalized = criteria.map((criterion) => {
    const weight = suppliedByCriterion.get(criterion) ?? defaultsByCriterion.get(criterion);
    if (weight === undefined) throw new TypeError(`Missing ranking weight: ${criterion}`);
    return selected.includes(criterion) ? weight : Object.freeze({ ...weight, weight: 0 });
  });
  if (normalized.every(({ weight }) => weight === 0)) {
    throw new TypeError('Selected ranking criteria require a positive total weight');
  }
  return Object.freeze({
    criteria: Object.freeze([...selected]),
    weights: Object.freeze(normalized),
    includeProxy: optionalBoolean(record.includeProxy, 'includeProxy', false),
    minimumEvidenceCoverage: optionalBoundedNumber(
      record,
      'minimumEvidenceCoverage',
      0,
      0,
      1,
      false,
    ),
  });
}

export function baseAllowedKeys(extra: readonly string[]): readonly string[] {
  return Object.freeze([
    'releaseId',
    'limit',
    'cursor',
    'city',
    'postalCode',
    'propertyId',
    ...extra,
  ]);
}

export function criterionCapability(
  release: InquiryReleaseContext,
  criterion: RankingCriterion,
): InquiryCapability {
  return release.capabilities[criterion];
}

export function combinedCapability(
  release: InquiryReleaseContext,
  selected: readonly RankingCriterion[],
): InquiryCapability {
  const capabilities = selected.map((criterion) => release.capabilities[criterion]);
  const limitations = [...new Set(capabilities.flatMap(({ limitations }) => limitations))].sort();
  return Object.freeze({
    state: capabilities.some(({ state }) => state === 'supported')
      ? capabilities.every(({ state }) => state === 'supported')
        ? 'supported'
        : 'partial'
      : capabilities.some(({ state }) => state === 'partial')
        ? 'partial'
        : 'blocked',
    supportClasses: Object.freeze(
      [...new Set(capabilities.flatMap(({ supportClasses: classes }) => classes))].sort(),
    ),
    numerator: capabilities.reduce((total, item) => total + item.numerator, 0),
    denominator: capabilities.reduce((total, item) => total + item.denominator, 0),
    limitations: Object.freeze(limitations),
  });
}

export const RANKING_CRITERIA = criteria;
