import { createHash } from 'node:crypto';

import type { AnalyticalRow } from '@oracle/data-runtime/analytical-runtime';

import type {
  CombinedRankingInput,
  CombinedRankingValue,
  EvidenceSummary,
  InquiryCapability,
  InquiryExecutionContext,
  InquiryItem,
  InquiryName,
  InquiryReleaseContext,
  InquiryResponse,
  InquirySupportClass,
  OwnershipAgeInput,
  OwnershipAgeValue,
  PropertyIdentity,
  RankingCriterion,
  RegionalOwnerInput,
  RegionalOwnerValue,
  RoofAgeInput,
  RoofAgeValue,
  WalkabilityInput,
  WalkabilityValue,
  WaterViewInput,
  WaterViewValue,
} from './contracts.js';
import { InquiryCursorCodec } from './cursor.js';
import {
  createFixedInquiryQuery,
  createFixedRankingQuery,
  type FixedInquiryPlanInput,
} from './plans.js';
import {
  assertAsOf,
  assertExactKeys,
  baseAllowedKeys,
  combinedCapability,
  criterionCapability,
  normalizePage,
  normalizeRanking,
  normalizeRelease,
  optionalBoundedNumber,
  optionalStrictBoolean,
  RANKING_CRITERIA,
} from './validation.js';

type SimpleInquiryName = Exclude<InquiryName, 'combined_review'>;
type QueryParameter = null | boolean | number | string;
const RESPONSE_BYTES_MAXIMUM = 1024 * 1024;

type SimpleRow = AnalyticalRow &
  Readonly<{
    property_id: unknown;
    parcel_identifier: unknown;
    address_street: unknown;
    address_city: unknown;
    address_zip: unknown;
    latitude: unknown;
    longitude: unknown;
    support_class: unknown;
    value_number: unknown;
    value_text: unknown;
    evidence_json: unknown;
  }>;

type RankingRow = AnalyticalRow &
  Readonly<{
    property_id: unknown;
    parcel_identifier: unknown;
    address_street: unknown;
    address_city: unknown;
    address_zip: unknown;
    latitude: unknown;
    longitude: unknown;
    score: unknown;
    evidence_coverage: unknown;
    ranking_position: unknown;
    roof_state: unknown;
    water_state: unknown;
    ownership_state: unknown;
    regional_owner_state: unknown;
    transit_state: unknown;
    starbucks_state: unknown;
    evidence_json: unknown;
  }>;

type SimpleExecution<TValue> = Readonly<{
  name: SimpleInquiryName;
  input: unknown;
  context: InquiryExecutionContext;
  allowedKeys: readonly string[];
  threshold: number | null;
  includeProxy: boolean;
  parameters: Readonly<Record<string, QueryParameter>>;
  value: (row: SimpleRow) => Readonly<TValue>;
}>;

export class NamedInquiryExecutor {
  readonly #release: InquiryReleaseContext;
  readonly #cursor: InquiryCursorCodec;

  public constructor(release: InquiryReleaseContext, cursorSecret: Uint8Array) {
    this.#release = normalizeRelease(release);
    this.#cursor = new InquiryCursorCodec(cursorSecret);
  }

  public async roofAge(
    input: RoofAgeInput,
    context: InquiryExecutionContext,
  ): Promise<InquiryResponse<RoofAgeValue>> {
    const record = assertExactKeys(
      input,
      baseAllowedKeys(['minimumAgeYears', 'includeProxy', 'asOf']),
    );
    assertAsOf(record, this.#release);
    const minimumAgeYears = optionalBoundedNumber(record, 'minimumAgeYears', 15, 1, 200);
    const includeProxy = optionalStrictBoolean(record, 'includeProxy', false);
    return this.#executeSimple({
      name: 'roof_age',
      input,
      context,
      allowedKeys: baseAllowedKeys(['minimumAgeYears', 'includeProxy', 'asOf']),
      threshold: minimumAgeYears,
      includeProxy,
      parameters: Object.freeze({ minimumAgeYears, includeProxy }),
      value: (row) =>
        Object.freeze({
          ageYears: requiredNumber(row.value_number, 'roof age'),
          referenceDate: nullableString(row.value_text, 'roof reference date'),
        }),
    });
  }

  public async waterViewCandidates(
    input: WaterViewInput,
    context: InquiryExecutionContext,
  ): Promise<InquiryResponse<WaterViewValue>> {
    const record = assertExactKeys(
      input,
      baseAllowedKeys(['maximumDistanceMeters', 'includeProxy']),
    );
    const maximumDistanceMeters = optionalBoundedNumber(
      record,
      'maximumDistanceMeters',
      5_000,
      1,
      20_000,
    );
    const includeProxy = optionalStrictBoolean(record, 'includeProxy', false);
    return this.#executeSimple({
      name: 'water_view_candidate',
      input,
      context,
      allowedKeys: baseAllowedKeys(['maximumDistanceMeters', 'includeProxy']),
      threshold: maximumDistanceMeters,
      includeProxy,
      parameters: Object.freeze({ maximumDistanceMeters, includeProxy }),
      value: (row) =>
        Object.freeze({
          distanceMeters: requiredNumber(row.value_number, 'water distance'),
          terrainVisibilityState: requiredString(row.value_text, 'terrain visibility state'),
          actualViewProven: false as const,
        }),
    });
  }

  public async ownershipAge(
    input: OwnershipAgeInput,
    context: InquiryExecutionContext,
  ): Promise<InquiryResponse<OwnershipAgeValue>> {
    const record = assertExactKeys(input, baseAllowedKeys(['minimumTenureYears']));
    const minimumTenureYears = optionalBoundedNumber(record, 'minimumTenureYears', 10, 1, 200);
    return this.#executeSimple({
      name: 'ownership_age',
      input,
      context,
      allowedKeys: baseAllowedKeys(['minimumTenureYears']),
      threshold: minimumTenureYears,
      includeProxy: false,
      parameters: Object.freeze({ minimumTenureYears, completeHistoryRequired: true }),
      value: (row) =>
        Object.freeze({
          yearsSinceExchange: requiredNumber(row.value_number, 'years since exchange'),
          lastExchangeDate: requiredString(row.value_text, 'last exchange date'),
          completeHistoryRequired: true as const,
        }),
    });
  }

  public async regionalOwners(
    input: RegionalOwnerInput,
    context: InquiryExecutionContext,
  ): Promise<InquiryResponse<RegionalOwnerValue>> {
    return this.#executeSimple({
      name: 'regional_owner',
      input,
      context,
      allowedKeys: baseAllowedKeys([]),
      threshold: null,
      includeProxy: false,
      parameters: Object.freeze({ regionPolicyId: this.#release.policyVersion }),
      value: () =>
        Object.freeze({ isRegionalOwner: true as const, rawOwnerIdentityExposed: false as const }),
    });
  }

  public async transitWalkability(
    input: WalkabilityInput,
    context: InquiryExecutionContext,
  ): Promise<InquiryResponse<WalkabilityValue>> {
    return this.#walkability('transit_walkability', input, context);
  }

  public async starbucksWalkability(
    input: WalkabilityInput,
    context: InquiryExecutionContext,
  ): Promise<InquiryResponse<WalkabilityValue>> {
    return this.#walkability('starbucks_walkability', input, context);
  }

  public async combinedRanking(
    input: CombinedRankingInput,
    context: InquiryExecutionContext,
  ): Promise<InquiryResponse<CombinedRankingValue>> {
    const record = assertExactKeys(
      input,
      baseAllowedKeys(['criteria', 'weights', 'includeProxy', 'minimumEvidenceCoverage']),
    );
    const page = normalizePage(record, this.#release);
    const ranking = normalizeRanking(input, this.#release);
    const capability = combinedCapability(this.#release, ranking.criteria);
    const effectiveWeights = Object.freeze(
      ranking.weights.map((weight) =>
        this.#release.capabilities[weight.criterion].state === 'blocked'
          ? Object.freeze({ ...weight, weight: 0 })
          : weight,
      ),
    );
    const parameters = Object.freeze({
      criteria: ranking.criteria.join(','),
      weights: effectiveWeights
        .map(
          ({ criterion, weight, proxyMultiplier }) => `${criterion}:${weight}:${proxyMultiplier}`,
        )
        .join(','),
      includeProxy: ranking.includeProxy,
      minimumEvidenceCoverage: ranking.minimumEvidenceCoverage,
      city: page.city,
      postalCode: page.postalCode,
      propertyId: page.propertyId,
      limit: page.limit,
      cursor: page.cursor,
    });
    const queryFingerprint = requestFingerprint({
      criteria: ranking.criteria,
      weights: effectiveWeights,
      includeProxy: ranking.includeProxy,
      minimumEvidenceCoverage: ranking.minimumEvidenceCoverage,
      city: page.city,
      postalCode: page.postalCode,
      propertyId: page.propertyId,
      limit: page.limit,
    });
    if (capability.state === 'blocked') {
      return this.#empty('combined_review', capability, parameters);
    }
    let afterScore: number | null = null;
    let afterPropertyId: string | null = null;
    if (page.cursor !== null) {
      const keys = this.#cursor.decode(page.cursor, {
        inquiry: 'combined_review',
        releaseId: this.#release.releaseId,
        queryFingerprint,
      });
      if (keys.length !== 2 || typeof keys[0] !== 'number' || typeof keys[1] !== 'string') {
        throw new TypeError('Combined-ranking cursor keys are invalid');
      }
      [afterScore, afterPropertyId] = keys;
    }
    const result = await context.session.execute<RankingRow>({
      ...createFixedRankingQuery({
        includeProxy: ranking.includeProxy,
        city: page.city,
        postalCode: page.postalCode,
        propertyId: page.propertyId,
        weights: effectiveWeights,
        minimumEvidenceCoverage: ranking.minimumEvidenceCoverage,
        afterScore,
        afterPropertyId,
        limit: page.limit,
      }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    const hasMore = result.rows.length > page.limit;
    const rows = result.rows.slice(0, page.limit);
    const selectedWeights = new Map(effectiveWeights.map((weight) => [weight.criterion, weight]));
    const results = rows.map((row) => {
      const score = requiredNumber(row.score, 'ranking score');
      const coverage = requiredNumber(row.evidence_coverage, 'evidence coverage');
      const allEvidence = parseEvidence(row.evidence_json, this.#release.asOf);
      const evidence = allEvidence.filter((item) =>
        ranking.criteria.some(
          (criterion) =>
            this.#release.capabilities[criterion].state !== 'blocked' &&
            evidenceFeature(item).includes(criterion),
        ),
      );
      const components = ranking.criteria.map((criterion) => {
        const weight = selectedWeights.get(criterion);
        if (weight === undefined) throw new TypeError(`Missing selected weight: ${criterion}`);
        const supportClass =
          this.#release.capabilities[criterion].state === 'blocked'
            ? 'unsupported'
            : supportForRankingRow(row, criterion);
        const criterionReleaseCapability = this.#release.capabilities[criterion];
        if (!criterionReleaseCapability.supportClasses.includes(supportClass)) {
          throw new TypeError(
            `Combined result support class contradicts release capability: ${criterion}`,
          );
        }
        if (
          (supportClass === 'supported' || supportClass === 'proxy') &&
          !evidence.some(
            (item) => evidenceFeature(item) === criterion && item.supportClass === supportClass,
          )
        ) {
          throw new TypeError(
            `Combined positive component lacks matching public evidence: ${criterion}`,
          );
        }
        const normalizedValue = supportClass === 'supported' || supportClass === 'proxy' ? 1 : null;
        const contribution =
          normalizedValue === null
            ? 0
            : weight.weight *
              normalizedValue *
              (supportClass === 'proxy' ? weight.proxyMultiplier : 1);
        return Object.freeze({
          criterion,
          supportClass,
          normalizedValue,
          weight: weight.weight,
          proxyMultiplier: weight.proxyMultiplier,
          contribution,
        });
      });
      const supportClass: InquirySupportClass = components.some(
        (component) => component.supportClass === 'supported',
      )
        ? 'supported'
        : 'proxy';
      if (!capability.supportClasses.includes(supportClass)) {
        throw new TypeError('Combined result support class contradicts release capability');
      }
      return Object.freeze({
        ...identity(row),
        supportClass,
        value: Object.freeze({
          rank: requiredNumber(row.ranking_position, 'ranking position'),
          score,
          evidenceCoverage: coverage,
          components: Object.freeze(components),
        }),
        evidence: Object.freeze(evidence),
        limitations: Object.freeze([
          ...new Set([
            ...capability.limitations,
            ...evidence.flatMap(({ limitations }) => limitations),
          ]),
        ]),
      });
    });
    const last = results.at(-1);
    const nextCursor =
      hasMore && last !== undefined
        ? this.#cursor.encode({
            inquiry: 'combined_review',
            releaseId: this.#release.releaseId,
            queryFingerprint,
            keys: [last.value.score, last.propertyId],
          })
        : null;
    return this.#response(
      'combined_review',
      capability,
      parameters,
      results,
      nextCursor,
      hasMore || result.truncated,
      result.elapsedMs,
      result.scannedBytes,
    );
  }

  #walkability(
    name: 'transit_walkability' | 'starbucks_walkability',
    input: WalkabilityInput,
    context: InquiryExecutionContext,
  ): Promise<InquiryResponse<WalkabilityValue>> {
    const record = assertExactKeys(
      input,
      baseAllowedKeys(['maximumNetworkDistanceMeters', 'includeProxy']),
    );
    const maximumNetworkDistanceMeters = optionalBoundedNumber(
      record,
      'maximumNetworkDistanceMeters',
      800,
      1,
      10_000,
    );
    const includeProxy = optionalStrictBoolean(record, 'includeProxy', false);
    return this.#executeSimple({
      name,
      input,
      context,
      allowedKeys: baseAllowedKeys(['maximumNetworkDistanceMeters', 'includeProxy']),
      threshold: maximumNetworkDistanceMeters,
      includeProxy,
      parameters: Object.freeze({ maximumNetworkDistanceMeters, includeProxy }),
      value: (row) =>
        Object.freeze({
          networkDistanceMeters: requiredNumber(row.value_number, 'network distance'),
          estimatedWalkMinutes: requiredNumberString(row.value_text, 'walk minutes'),
        }),
    });
  }

  async #executeSimple<TValue>(request: SimpleExecution<TValue>): Promise<InquiryResponse<TValue>> {
    const record = assertExactKeys(request.input, request.allowedKeys);
    const page = normalizePage(record, this.#release);
    const responseParameters = Object.freeze({
      ...request.parameters,
      city: page.city,
      postalCode: page.postalCode,
      propertyId: page.propertyId,
      limit: page.limit,
      cursor: page.cursor,
    });
    const queryFingerprint = requestFingerprint({
      ...request.parameters,
      city: page.city,
      postalCode: page.postalCode,
      propertyId: page.propertyId,
      limit: page.limit,
    });
    const capability = criterionCapability(this.#release, request.name);
    if (capability.state === 'blocked') {
      return this.#empty(request.name, capability, responseParameters);
    }
    let afterPropertyId: string | null = null;
    if (page.cursor !== null) {
      const keys = this.#cursor.decode(page.cursor, {
        inquiry: request.name,
        releaseId: this.#release.releaseId,
        queryFingerprint,
      });
      if (keys.length !== 1 || typeof keys[0] !== 'string') {
        throw new TypeError('Inquiry cursor keys are invalid');
      }
      [afterPropertyId] = keys;
    }
    const plan: FixedInquiryPlanInput = Object.freeze({
      name: request.name,
      threshold: request.threshold,
      includeProxy: request.includeProxy,
      city: page.city,
      postalCode: page.postalCode,
      propertyId: page.propertyId,
      afterPropertyId,
      limit: page.limit,
    });
    const result = await request.context.session.execute<SimpleRow>({
      ...createFixedInquiryQuery(plan),
      ...(request.context.signal === undefined ? {} : { signal: request.context.signal }),
    });
    const hasMore = result.rows.length > page.limit;
    const results = result.rows.slice(0, page.limit).map((row) => {
      const rowSupportClass = supportClass(row.support_class);
      if (rowSupportClass !== 'supported' && rowSupportClass !== 'proxy') {
        throw new TypeError('Positive inquiry row has a non-positive support class');
      }
      if (!capability.supportClasses.includes(rowSupportClass)) {
        throw new TypeError('Inquiry result support class contradicts release capability');
      }
      const evidence = parseEvidence(row.evidence_json, this.#release.asOf);
      if (evidence.length === 0) throw new TypeError('Positive inquiry row lacks public evidence');
      if (!evidence.some((item) => item.supportClass === rowSupportClass)) {
        throw new TypeError('Positive inquiry row lacks matching public evidence support class');
      }
      return Object.freeze({
        ...identity(row),
        supportClass: rowSupportClass,
        value: request.value(row),
        evidence: Object.freeze(evidence),
        limitations: Object.freeze([
          ...new Set([
            ...capability.limitations,
            ...evidence.flatMap(({ limitations }) => limitations),
          ]),
        ]),
      });
    });
    const last = results.at(-1);
    const nextCursor =
      hasMore && last !== undefined
        ? this.#cursor.encode({
            inquiry: request.name,
            releaseId: this.#release.releaseId,
            queryFingerprint,
            keys: [last.propertyId],
          })
        : null;
    return this.#response(
      request.name,
      capability,
      responseParameters,
      results,
      nextCursor,
      hasMore || result.truncated,
      result.elapsedMs,
      result.scannedBytes,
    );
  }

  #empty<TValue>(
    name: InquiryName,
    capability: InquiryCapability,
    parameters: Readonly<Record<string, QueryParameter>>,
  ): InquiryResponse<TValue> {
    return this.#response(name, capability, parameters, [], null, false, 0, 0);
  }

  #response<TValue>(
    name: InquiryName,
    capability: InquiryCapability,
    parameters: Readonly<Record<string, QueryParameter>>,
    results: readonly InquiryItem<TValue>[],
    nextCursor: string | null,
    truncated: boolean,
    elapsedMs: number,
    bytesScanned: number | null,
  ): InquiryResponse<TValue> {
    const response: InquiryResponse<TValue> = Object.freeze({
      schemaVersion: this.#release.schemaVersion,
      releaseId: this.#release.releaseId,
      runId: this.#release.runId,
      manifestCid: this.#release.manifestCid,
      asOf: this.#release.asOf,
      query: Object.freeze({
        name,
        policyVersion: this.#release.policyVersion,
        parameters,
      }),
      capability,
      results: Object.freeze([...results]),
      resultCount: results.length,
      nextCursor,
      truncated,
      limitations: Object.freeze([...capability.limitations]),
      timing: Object.freeze({ elapsedMs, bytesScanned }),
    });
    if (Buffer.byteLength(JSON.stringify(response), 'utf8') > RESPONSE_BYTES_MAXIMUM) {
      throw new RangeError('Inquiry response exceeds 1 MiB');
    }
    return response;
  }
}

function identity(row: AnalyticalRow): PropertyIdentity {
  return Object.freeze({
    propertyId: requiredString(row.property_id, 'property_id'),
    parcelIdentifier: requiredString(row.parcel_identifier, 'parcel_identifier'),
    addressStreet: nullableString(row.address_street, 'address_street'),
    addressCity: nullableString(row.address_city, 'address_city'),
    addressZip: nullableString(row.address_zip, 'address_zip'),
    latitude: nullableNumber(row.latitude, 'latitude'),
    longitude: nullableNumber(row.longitude, 'longitude'),
  });
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is invalid`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requiredString(value, label);
}

function nullableNumber(value: unknown, label: string): number | null {
  if (value === null) return null;
  return requiredNumber(value, label);
}

function requiredNumber(value: unknown, label: string): number {
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) {
    throw new TypeError(`${label} is invalid`);
  }
  return number;
}

function requiredNumberString(value: unknown, label: string): number {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} is invalid`);
  }
  return requiredNumber(Number(value), label);
}

function supportClass(value: unknown): InquirySupportClass {
  if (
    value !== 'supported' &&
    value !== 'proxy' &&
    value !== 'unknown' &&
    value !== 'unsupported'
  ) {
    throw new TypeError('Inquiry support class is invalid');
  }
  return value;
}

function parseEvidence(value: unknown, releaseAsOf: string): readonly EvidenceSummary[] {
  if (typeof value !== 'string') throw new TypeError('Evidence projection is invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new TypeError('Evidence projection is corrupt', { cause: error });
  }
  if (!Array.isArray(parsed)) throw new TypeError('Evidence projection must be an array');
  return Object.freeze(
    parsed.map((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new TypeError('Evidence item is invalid');
      }
      const record = item as Readonly<Record<string, unknown>>;
      const visibility = record.visibility;
      if (visibility !== 'public')
        throw new TypeError('Non-public evidence reached public inquiry');
      const sourceIds = parseStringArray(record.sourceIdsJson, 'evidence source IDs');
      if (sourceIds.length === 0 || sourceIds.some((sourceId) => sourceId.length === 0)) {
        throw new TypeError('Evidence source IDs must be non-empty');
      }
      const limitations = parseStringArray(record.limitationsJson, 'evidence limitations');
      let evidenceValue: EvidenceSummary['value'];
      try {
        evidenceValue = JSON.parse(
          requiredString(record.valueJson, 'evidence value'),
        ) as EvidenceSummary['value'];
      } catch (error) {
        throw new TypeError('Evidence value is corrupt', { cause: error });
      }
      const confidence = requiredNumber(record.confidence, 'evidence confidence');
      if (confidence < 0 || confidence > 1) throw new TypeError('Evidence confidence is invalid');
      const evidenceAsOf = requiredString(record.asOf, 'evidence as-of');
      if (
        !Number.isFinite(Date.parse(evidenceAsOf)) ||
        !/[zZ]|[+-]\d\d:\d\d$/u.test(evidenceAsOf)
      ) {
        throw new TypeError('Evidence as-of is invalid');
      }
      if (Date.parse(evidenceAsOf) > Date.parse(releaseAsOf)) {
        throw new TypeError('Evidence as-of is later than the immutable release');
      }
      const summary = {
        evidenceId: requiredString(record.evidenceId, 'evidence ID'),
        supportClass: supportClass(record.supportClass),
        confidence,
        asOf: evidenceAsOf,
        algorithmName: requiredString(record.algorithmName, 'evidence algorithm name'),
        algorithmVersion: requiredString(record.algorithmVersion, 'evidence algorithm version'),
        value: evidenceValue,
        sourceIds: Object.freeze(sourceIds),
        limitations: Object.freeze(limitations),
        visibility,
      } as EvidenceSummary & { __feature?: string };
      Object.defineProperty(summary, '__feature', {
        value: typeof record.feature === 'string' ? record.feature : '',
        enumerable: false,
      });
      return Object.freeze(summary);
    }),
  );
}

function requestFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalFingerprintJson(value), 'utf8').digest('hex');
}

function canonicalFingerprintJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalFingerprintJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalFingerprintJson(item)}`)
      .join(',')}}`;
  }
  throw new TypeError('Normalized inquiry fingerprint input is invalid');
}

function parseStringArray(value: unknown, label: string): readonly string[] {
  if (typeof value !== 'string') throw new TypeError(`${label} is invalid`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new TypeError(`${label} is corrupt`, { cause: error });
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new TypeError(`${label} is invalid`);
  }
  return parsed;
}

function evidenceFeature(value: EvidenceSummary): string {
  return (value as EvidenceSummary & Readonly<{ __feature?: string }>).__feature ?? '';
}

function supportForRankingRow(row: RankingRow, criterion: RankingCriterion): InquirySupportClass {
  const fields: Readonly<Record<RankingCriterion, unknown>> = {
    roof_age: row.roof_state,
    water_view_candidate: row.water_state,
    ownership_age: row.ownership_state,
    regional_owner: row.regional_owner_state,
    transit_walkability: row.transit_state,
    starbucks_walkability: row.starbucks_state,
  };
  return supportClass(fields[criterion]);
}

export const NAMED_INQUIRY_NAMES = Object.freeze([
  ...RANKING_CRITERIA,
  'combined_review',
] as const satisfies readonly InquiryName[]);
