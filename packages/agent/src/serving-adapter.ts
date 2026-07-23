import { jsonValueSchema } from '@oracle/contracts';
import type { RankingWeight } from '@oracle/query-core/inquiries/contracts';
import {
  REGIONAL_OWNER_POLICY_ID,
  type ProductionServingEnvelope,
  type ProductionServingService,
} from '@oracle/query-core/serving/contracts';

import {
  NAMED_EVIDENCE_TOOL_NAMES,
  evidenceReferenceSchema,
  namedEvidenceEnvelopeSchema,
  namedEvidenceInputSchemas,
  type NamedEvidenceEnvelope,
  type NamedEvidenceExecutor,
  type NamedEvidenceToolName,
} from './contracts.js';

export const ORACLE_AGENT_SERVING_ADAPTER_VERSION = 'oracle-agent-serving@1.0.0';
export const ORACLE_AGENT_SERVING_SCHEMA_VERSION = '1.0.0';

export const ORACLE_AGENT_SERVING_LIMITS = Object.freeze({
  maximumPageRows: 100,
  maximumEvidence: 1_000,
  maximumPayloadBytes: 900 * 1024,
  queryTimeoutMs: 5_000,
  maximumScanBytes: 512 * 1024 * 1024,
});

const rankingCriteria = Object.freeze([
  'roof_age',
  'water_view_candidate',
  'ownership_age',
  'regional_owner',
  'transit_walkability',
  'starbucks_walkability',
] as const);
const knownTools = new Set<string>(NAMED_EVIDENCE_TOOL_NAMES);
const rowCollectionKeys = new Set([
  'artifacts',
  'fields',
  'properties',
  'relationships',
  'results',
  'runs',
  'sources',
]);
const prohibitedAuthorityKey =
  /(?:sql|statement|relationpath|tablepath|filepath|path|uri|url|host|bucket|objectkey|prefix|raw)$/iu;
const prohibitedLocatorValue = /(?:file:\/\/|s3:\/\/|https?:\/\/|[a-z]:\\|\/var\/|\/tmp\/)/iu;
const restrictedIdentityKeys = new Set([
  'applicantaddress',
  'applicantemail',
  'applicantname',
  'applicantphone',
  'grantor',
  'grantee',
  'mailingaddress',
  'owneraddress',
  'owner',
  'ownercontact',
  'owneremail',
  'owneridentity',
  'ownermailingaddress',
  'ownername',
  'ownerphone',
  'registrantaddress',
  'registrantname',
]);

export class OracleAgentServingAdapterError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OracleAgentServingAdapterError';
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return Object.freeze(Object.fromEntries(Object.entries(value)));
}

function defined(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze(
    Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)),
  );
}

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function stringArray(value: unknown): readonly string[] {
  let candidate = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return Object.freeze([]);
    }
  }
  if (!Array.isArray(candidate)) return Object.freeze([]);
  return Object.freeze(
    [...new Set(candidate.filter((item): item is string => typeof item === 'string'))].sort(),
  );
}

function propertyIdentity(value: Readonly<Record<string, unknown>>, inherited: string | null) {
  const candidate = value.propertyId ?? value.property_id;
  return typeof candidate === 'string' ? candidate : inherited;
}

function extractEvidence(value: unknown): NamedEvidenceEnvelope['evidence'] {
  const evidence = new Map<string, NamedEvidenceEnvelope['evidence'][number]>();
  const visit = (candidate: unknown, inheritedPropertyId: string | null): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, inheritedPropertyId);
      return;
    }
    const item = record(candidate);
    if (item === null) return;
    const propertyId = propertyIdentity(item, inheritedPropertyId);
    const evidenceId = item.evidenceId ?? item.evidence_id;
    const visibility = item.visibility;
    if (typeof evidenceId === 'string') {
      if (visibility !== 'public') {
        throw new OracleAgentServingAdapterError(
          'Evidence without explicit public visibility was returned',
        );
      }
      const parsed = evidenceReferenceSchema.safeParse({
        evidenceId,
        propertyId,
        supportState: item.supportState ?? item.supportClass ?? item.support_class,
        sourceIds: stringArray(item.sourceIds ?? item.source_ids_json),
        limitations: stringArray(item.limitations ?? item.limitations_json),
      });
      if (!parsed.success) {
        throw new OracleAgentServingAdapterError('Malformed public evidence was returned');
      }
      const existing = evidence.get(evidenceId);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(parsed.data)) {
        throw new OracleAgentServingAdapterError('Conflicting public evidence identity detected');
      }
      evidence.set(evidenceId, Object.freeze(parsed.data));
    }
    for (const child of Object.values(item)) visit(child, propertyId);
  };
  visit(value, null);
  const result = [...evidence.values()].sort((left, right) =>
    left.evidenceId.localeCompare(right.evidenceId),
  );
  if (result.length > ORACLE_AGENT_SERVING_LIMITS.maximumEvidence) {
    throw new OracleAgentServingAdapterError('Public evidence exceeds the adapter bound');
  }
  return result;
}

const redacted = Symbol('redacted');

function redact(value: unknown, key = ''): unknown {
  if (typeof value === 'string' && prohibitedLocatorValue.test(value)) return redacted;
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const result = value.map((item) => redact(item)).filter((item) => item !== redacted);
    return Object.freeze(result);
  }
  const item = record(value);
  if (item === null) return redacted;
  if (item.visibility !== undefined && item.visibility !== 'public') return redacted;
  const output: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(item)) {
    const normalized = normalizedKey(childKey);
    if (
      normalized === 'evidence' ||
      restrictedIdentityKeys.has(normalized) ||
      prohibitedAuthorityKey.test(childKey)
    ) {
      continue;
    }
    const sanitized = redact(child, childKey);
    if (sanitized !== redacted) output[childKey] = sanitized;
  }
  if (rowCollectionKeys.has(normalizedKey(key)) && Object.keys(output).length === 0)
    return redacted;
  return Object.freeze(output);
}

function assertCollectionBounds(value: unknown, key = '$'): void {
  if (Array.isArray(value)) {
    if (
      rowCollectionKeys.has(normalizedKey(key)) &&
      value.length > ORACLE_AGENT_SERVING_LIMITS.maximumPageRows
    ) {
      throw new OracleAgentServingAdapterError('Serving row page exceeds the adapter bound');
    }
    for (const item of value) assertCollectionBounds(item, key);
    return;
  }
  const item = record(value);
  if (item === null) return;
  for (const [childKey, child] of Object.entries(item)) assertCollectionBounds(child, childKey);
}

function assertPublicVisibility(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertPublicVisibility(item);
    return;
  }
  const item = record(value);
  if (item === null) return;
  if (item.visibility !== undefined && item.visibility !== 'public') {
    throw new OracleAgentServingAdapterError('Non-public serving data was returned');
  }
  for (const child of Object.values(item)) assertPublicVisibility(child);
}

function assertRelease(service: ProductionServingService, result: ProductionServingEnvelope): void {
  if (
    service.release.schemaVersion !== ORACLE_AGENT_SERVING_SCHEMA_VERSION ||
    result.schemaVersion !== service.release.schemaVersion ||
    result.releaseId !== service.release.releaseId ||
    result.runId !== service.release.runId ||
    result.manifestCid !== service.release.manifestCid ||
    result.asOf !== service.release.asOf
  ) {
    throw new OracleAgentServingAdapterError('Serving release identity verification failed');
  }
  const data = record(result.data);
  const nestedRelease = record(data?.release);
  if (
    nestedRelease !== null &&
    (nestedRelease.schemaVersion !== service.release.schemaVersion ||
      nestedRelease.releaseId !== service.release.releaseId ||
      nestedRelease.runId !== service.release.runId ||
      nestedRelease.manifestCid !== service.release.manifestCid ||
      nestedRelease.asOf !== service.release.asOf)
  ) {
    throw new OracleAgentServingAdapterError('Nested serving release identity is inconsistent');
  }
  if (
    result.timing.bytesScanned < 0 ||
    result.timing.bytesScanned > ORACLE_AGENT_SERVING_LIMITS.maximumScanBytes ||
    result.timing.elapsedMs < 0 ||
    result.timing.elapsedMs > ORACLE_AGENT_SERVING_LIMITS.queryTimeoutMs
  ) {
    throw new OracleAgentServingAdapterError('Serving query budget verification failed');
  }
}

function canonicalInput(
  name: NamedEvidenceToolName,
  input: Readonly<Record<string, unknown>>,
  releaseId: string,
  rankingWeights: readonly RankingWeight[],
): Readonly<Record<string, unknown>> {
  const common = defined({
    releaseId,
    city: input.city,
    postalCode: input.postalCode,
    propertyId: input.propertyId,
    limit: input.limit,
    cursor: input.cursor,
  });
  switch (name) {
    case 'get_dataset_info':
      return Object.freeze({});
    case 'get_dataset_coverage':
      return Object.freeze({ releaseId });
    case 'list_pipeline_runs':
      return defined({ releaseId, limit: input.limit, cursor: input.cursor });
    case 'get_pipeline_run':
      return defined({ releaseId, runId: input.runId });
    case 'search_properties':
      return defined({ ...common, parcelIdentifier: input.query });
    case 'get_property':
      return defined({ releaseId, propertyId: input.propertyId });
    case 'get_property_evidence':
      return defined({
        releaseId,
        propertyId: input.propertyId,
        feature: input.feature,
        limit: input.limit,
        cursor: input.cursor,
      });
    case 'find_roof_age_candidates':
      return defined({
        ...common,
        minimumAgeYears: input.minimumAgeYears,
        includeProxy: input.includeProxy,
      });
    case 'find_water_view_candidates':
      return defined({
        ...common,
        maximumWaterDistanceMeters: input.maximumDistanceMeters,
        includeProxy: input.includeProxy,
      });
    case 'find_ownership_age_candidates':
      return defined({
        ...common,
        minimumTenureYears: input.minimumTenureYears,
        requireCompleteHistory: true,
      });
    case 'find_regional_owner_properties':
      if (input.regionPolicyId !== undefined && input.regionPolicyId !== REGIONAL_OWNER_POLICY_ID) {
        throw new OracleAgentServingAdapterError('Region policy does not match the release');
      }
      return defined({
        ...common,
        regionPolicyId: REGIONAL_OWNER_POLICY_ID,
        requireCurrentOwner: true,
      });
    case 'find_transit_walkable_properties':
      return defined({
        ...common,
        maximumNetworkDistanceMeters: input.maximumNetworkDistanceMeters,
        maximumSnapDistanceMeters: 200,
        includeProxy: input.includeProxy,
      });
    case 'find_starbucks_walkable_properties':
      return defined({
        ...common,
        maximumNetworkDistanceMeters: input.maximumNetworkDistanceMeters,
        maximumSnapDistanceMeters: 200,
        minimumPlaceConfidence: 0.7,
        includeProxy: input.includeProxy,
      });
    case 'rank_review_candidates':
      return defined({
        ...common,
        criteria: rankingCriteria,
        weights: rankingWeights,
        includeProxy: input.includeProxy,
        minimumEvidenceCoverage: input.minimumEvidenceCoverage,
      });
    case 'list_artifacts':
      return defined({
        releaseId,
        publicationClass: 'public',
        limit: input.limit,
        cursor: input.cursor,
      });
    case 'get_data_dictionary':
      return defined({ releaseId, limit: input.limit, cursor: input.cursor });
  }
}

function validateRankingWeights(weights: readonly RankingWeight[]): readonly RankingWeight[] {
  if (
    weights.length !== rankingCriteria.length ||
    rankingCriteria.some(
      (criterion) => weights.filter((weight) => weight.criterion === criterion).length !== 1,
    ) ||
    weights.some(
      ({ weight, proxyMultiplier }) =>
        !Number.isFinite(weight) ||
        weight < 0 ||
        weight > 100 ||
        !Number.isFinite(proxyMultiplier) ||
        proxyMultiplier < 0 ||
        proxyMultiplier > 1,
    )
  ) {
    throw new OracleAgentServingAdapterError(
      'The immutable six-criterion ranking policy is incomplete',
    );
  }
  return Object.freeze(
    rankingCriteria.map((criterion) => {
      const weight = weights.find((candidate) => candidate.criterion === criterion);
      if (weight === undefined) {
        throw new OracleAgentServingAdapterError('The immutable ranking policy is incomplete');
      }
      return Object.freeze({ ...weight });
    }),
  );
}

async function boundedExecute(
  service: ProductionServingService,
  operation: NamedEvidenceToolName,
  input: Readonly<Record<string, unknown>>,
  externalSignal?: AbortSignal,
): Promise<ProductionServingEnvelope> {
  const controller = new AbortController();
  const signal =
    externalSignal === undefined
      ? controller.signal
      : AbortSignal.any([externalSignal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new OracleAgentServingAdapterError('Serving query exceeded 5 seconds'));
      controller.abort();
    }, ORACLE_AGENT_SERVING_LIMITS.queryTimeoutMs);
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(new OracleAgentServingAdapterError('Serving query was aborted'));
    if (signal.aborted) abortListener();
    else signal.addEventListener('abort', abortListener, { once: true });
  });
  try {
    return await Promise.race([service.execute({ operation, input, signal }), timeout, aborted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener !== undefined) signal.removeEventListener('abort', abortListener);
  }
}

export function createProductionServingExecutor(
  service: ProductionServingService,
  configuredRankingWeights: readonly RankingWeight[],
): NamedEvidenceExecutor {
  const runtimeRelease = record(service.release);
  if (
    runtimeRelease?.immutable !== true ||
    runtimeRelease.verified !== true ||
    runtimeRelease.schemaVersion !== ORACLE_AGENT_SERVING_SCHEMA_VERSION
  ) {
    throw new OracleAgentServingAdapterError('Production serving release is not verified');
  }
  const rankingWeights = validateRankingWeights(configuredRankingWeights);
  return Object.freeze({
    execute: async (name, input, options) => {
      if (!knownTools.has(name)) {
        throw new OracleAgentServingAdapterError('Unknown named evidence tool');
      }
      const parsed = namedEvidenceInputSchemas[name].parse(input);
      const parsedInput = Object.freeze(Object.fromEntries(Object.entries(parsed)));
      if (
        parsedInput.releaseId !== undefined &&
        parsedInput.releaseId !== service.release.releaseId
      ) {
        throw new OracleAgentServingAdapterError('Requested release does not match production');
      }
      const result = await boundedExecute(
        service,
        name,
        canonicalInput(name, parsedInput, service.release.releaseId, rankingWeights),
        options.signal,
      );
      assertRelease(service, result);
      assertPublicVisibility(result.data);
      assertCollectionBounds(result.data);
      const evidence = extractEvidence(result.data);
      const redactedData = redact(result.data);
      if (redactedData === redacted) {
        throw new OracleAgentServingAdapterError('Serving data was entirely restricted');
      }
      const envelope = namedEvidenceEnvelopeSchema.parse({
        schemaVersion: result.schemaVersion,
        releaseId: result.releaseId,
        runId: result.runId,
        manifestCid: result.manifestCid,
        asOf: result.asOf,
        coverage: jsonValueSchema.parse(result.coverage),
        limitations: result.limitations,
        data: jsonValueSchema.parse(redactedData),
        evidence,
        nextCursor: result.nextCursor,
        truncated: result.truncated,
        timing: result.timing,
      });
      if (
        Buffer.byteLength(JSON.stringify(envelope), 'utf8') >
        ORACLE_AGENT_SERVING_LIMITS.maximumPayloadBytes
      ) {
        throw new OracleAgentServingAdapterError('Adapted evidence payload exceeds 900 KiB');
      }
      return Object.freeze(envelope);
    },
  });
}
