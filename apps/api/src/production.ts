import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { NamedQueryName } from '@oracle/contracts';
import {
  createProductionOracleAgent,
  type ProductionOracleAgentComposition,
  type ProductionOracleAgentDependencies,
} from '@oracle/agent';
import {
  ProductionServingError,
  createProductionServingService,
  type ProductionServingConfig,
  type ProductionServingService,
} from '@oracle/query-core/serving/index';
import type { RankingWeight } from '@oracle/query-core/inquiries/contracts';

import { ApiFailure } from './errors.js';
import type {
  AgentRequest,
  BoundedAgentService,
  ImmutableQueryService,
  QueryRequest,
  QueryResult,
  RuntimeServices,
} from './runtime.js';

const PAGED_OPERATIONS = new Set<NamedQueryName>([
  'list_pipeline_runs',
  'search_properties',
  'get_property_evidence',
  'find_roof_age_candidates',
  'find_water_view_candidates',
  'find_ownership_age_candidates',
  'find_regional_owner_properties',
  'find_transit_walkable_properties',
  'find_starbucks_walkable_properties',
  'rank_review_candidates',
  'list_artifacts',
  'get_data_dictionary',
]);

type ProductionEnvironment = Readonly<Record<string, string | undefined>>;

const SERVING_ENVIRONMENT_KEYS = Object.freeze([
  'ORACLE_RELEASE_ROOT',
  'ORACLE_SERVING_CONFIG_RELATIVE_PATH',
  'ORACLE_CURSOR_HMAC_SECRET_BASE64',
] as const);

type ServingConfigDocument = Omit<ProductionServingConfig, 'releaseRoot' | 'cursorSecret'>;

export type ProductionCompositionDependencies = Readonly<{
  createServingService?: (config: ProductionServingConfig) => Promise<ProductionServingService>;
  testOnlyAgentDependencies?: Readonly<{
    label: 'TEST_ONLY_DETERMINISTIC_AGENT';
    dependencies: ProductionOracleAgentDependencies;
  }>;
}>;

export function productionConfigurationState(
  environment: ProductionEnvironment,
): 'absent' | 'partial' | 'complete' {
  const present = SERVING_ENVIRONMENT_KEYS.filter(
    (key) => (environment[key]?.trim().length ?? 0) > 0,
  ).length;
  return present === 0
    ? 'absent'
    : present === SERVING_ENVIRONMENT_KEYS.length
      ? 'complete'
      : 'partial';
}

function object(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exact(value: Readonly<Record<string, unknown>>, keys: readonly string[], label: string) {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} contains an unsupported field.`);
  }
}

function requiredEnvironment(environment: ProductionEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new TypeError(`Production environment is missing ${name}.`);
  }
  return value;
}

function allowedOrigins(environment: ProductionEnvironment): readonly string[] {
  const origins = (environment.ORACLE_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (origins.length === 0 || new Set(origins).size !== origins.length) {
    throw new TypeError('ORACLE_ALLOWED_ORIGINS must contain unique explicit origins.');
  }
  for (const origin of origins) {
    if (origin === '*') throw new TypeError('Wildcard CORS origins are prohibited.');
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' || parsed.origin !== origin) {
      throw new TypeError('Production CORS origins must be exact HTTPS origins.');
    }
  }
  return Object.freeze(origins);
}

function cursorSecret(environment: ProductionEnvironment): Uint8Array {
  const encoded = requiredEnvironment(environment, 'ORACLE_CURSOR_HMAC_SECRET_BASE64');
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || encoded.length % 4 !== 0) {
    throw new TypeError('ORACLE_CURSOR_HMAC_SECRET_BASE64 must be canonical base64.');
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.byteLength < 32 || decoded.toString('base64') !== encoded) {
    throw new TypeError('The production cursor HMAC secret must contain at least 32 bytes.');
  }
  return new Uint8Array(decoded);
}

function pathInside(root: string, relativePath: string, label: string): string {
  if (
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    relativePath.includes('\\') ||
    relativePath.split('/').includes('..')
  ) {
    throw new TypeError(`${label} must be a portable relative path.`);
  }
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, relativePath);
  if (
    candidate !== resolvedRoot &&
    !candidate.startsWith(`${resolvedRoot}\\`) &&
    !candidate.startsWith(`${resolvedRoot}/`)
  ) {
    throw new TypeError(`${label} escapes the packaged release root.`);
  }
  return candidate;
}

function parseConfigDocument(value: unknown): ServingConfigDocument {
  const document = object(value, 'Serving configuration');
  exact(
    document,
    ['manifestRelativePath', 'expected', 'rankingWeights', 'capabilities', 'limitations'],
    'Serving configuration',
  );
  if (typeof document.manifestRelativePath !== 'string') {
    throw new TypeError('Serving configuration manifestRelativePath must be a string.');
  }
  const expected = object(document.expected, 'Serving configuration expected release');
  exact(
    expected,
    [
      'releaseId',
      'runId',
      'manifestSha256',
      'manifestCid',
      'asOf',
      'schemaVersion',
      'policyVersion',
    ],
    'Serving configuration expected release',
  );
  if (!Array.isArray(document.rankingWeights)) {
    throw new TypeError('Serving configuration rankingWeights must be an array.');
  }
  object(document.capabilities, 'Serving configuration capabilities');
  if (
    document.limitations !== undefined &&
    (!Array.isArray(document.limitations) ||
      !document.limitations.every((item) => typeof item === 'string' && item.trim().length > 0))
  ) {
    throw new TypeError('Serving configuration limitations must be non-empty strings.');
  }
  return document as ServingConfigDocument;
}

async function servingConfig(environment: ProductionEnvironment): Promise<ProductionServingConfig> {
  const releaseRoot = requiredEnvironment(environment, 'ORACLE_RELEASE_ROOT');
  if (!isAbsolute(releaseRoot)) throw new TypeError('ORACLE_RELEASE_ROOT must be absolute.');
  if (!(await stat(releaseRoot)).isDirectory()) {
    throw new TypeError('ORACLE_RELEASE_ROOT must identify a packaged directory.');
  }
  const configRelativePath = requiredEnvironment(
    environment,
    'ORACLE_SERVING_CONFIG_RELATIVE_PATH',
  );
  const configPath = pathInside(releaseRoot, configRelativePath, 'Serving configuration path');
  if (!(await stat(configPath)).isFile()) {
    throw new TypeError('The serving configuration path must identify a packaged file.');
  }
  const document = parseConfigDocument(JSON.parse(await readFile(configPath, 'utf8')) as unknown);
  pathInside(releaseRoot, document.manifestRelativePath, 'Release manifest path');
  return Object.freeze({
    ...document,
    releaseRoot: resolve(releaseRoot),
    cursorSecret: cursorSecret(environment),
  });
}

function canonicalInput(
  service: ProductionServingService,
  request: QueryRequest,
  rankingWeights: readonly RankingWeight[],
): Readonly<Record<string, unknown>> {
  const releaseId = request.releaseId ?? service.release.releaseId;
  const parameters = request.parameters;
  const filters = (): Record<string, unknown> =>
    defined({
      city: parameters.city,
      postalCode: parameters.postalCode,
      propertyId: parameters.propertyId,
    });
  let input: Record<string, unknown>;
  switch (request.operation) {
    case 'get_dataset_info':
      input = {};
      break;
    case 'get_dataset_coverage':
      input = { releaseId };
      break;
    case 'list_pipeline_runs':
      input = { releaseId };
      break;
    case 'get_pipeline_run':
      input = defined({ releaseId, runId: parameters.runId });
      break;
    case 'search_properties': {
      input = defined({
        releaseId,
        ...filters(),
        query: parameters.query,
        sort: parameters.sort,
      });
      break;
    }
    case 'get_property':
      input = defined({ releaseId, propertyId: parameters.propertyId });
      break;
    case 'get_property_evidence':
      input = defined({
        releaseId,
        propertyId: parameters.propertyId,
        feature: parameters.feature,
      });
      break;
    case 'find_roof_age_candidates':
      input = defined({
        releaseId,
        ...filters(),
        minimumAgeYears: parameters.minimumAgeYears,
        asOf: parameters.asOf,
        includeProxy: parameters.includeProxy,
      });
      break;
    case 'find_water_view_candidates':
      input = defined({
        releaseId,
        ...filters(),
        maximumWaterDistanceMeters: parameters.maximumDistanceMeters,
        minimumTerrainVisibilityConfidence: parameters.minimumTerrainConfidence,
        waterFeatureTypes: parameters.waterFeatureTypes,
        includeProxy: parameters.includeProxy,
      });
      break;
    case 'find_ownership_age_candidates':
      input = defined({
        releaseId,
        ...filters(),
        minimumTenureYears: parameters.minimumTenureYears,
        requireCompleteHistory: parameters.requireCompleteCoverage,
      });
      break;
    case 'find_regional_owner_properties':
      input = defined({
        releaseId,
        ...filters(),
        regionPolicyId: parameters.policyId,
      });
      break;
    case 'find_transit_walkable_properties':
      if (parameters.transitMode !== undefined) throw new ApiFailure('INVALID_REQUEST');
      input = defined({
        releaseId,
        ...filters(),
        maximumNetworkDistanceMeters: parameters.maximumNetworkDistanceMeters,
        maximumSnapDistanceMeters: parameters.maximumSnapDistanceMeters,
        serviceDate: parameters.serviceDate,
        agencyId: parameters.agency,
        routeId: parameters.route,
        includeProxy: parameters.includeProxy,
      });
      break;
    case 'find_starbucks_walkable_properties':
      input = defined({
        releaseId,
        ...filters(),
        maximumNetworkDistanceMeters: parameters.maximumNetworkDistanceMeters,
        maximumSnapDistanceMeters: parameters.maximumSnapDistanceMeters,
        minimumPlaceConfidence: parameters.minimumValidationConfidence,
        includeProxy: parameters.includeProxy,
      });
      break;
    case 'rank_review_candidates': {
      const criteria = parameters.signals;
      const weights = parameters.weights;
      if (!Array.isArray(criteria) || typeof weights !== 'object' || weights === null) {
        throw new ApiFailure('INVALID_REQUEST');
      }
      const configured = new Map(rankingWeights.map((weight) => [weight.criterion, weight]));
      const weightRecord = weights as Readonly<Record<string, unknown>>;
      input = defined({
        releaseId,
        ...filters(),
        criteria,
        weights: criteria.map((criterion) => {
          if (typeof criterion !== 'string') throw new ApiFailure('INVALID_REQUEST');
          const baseline = configured.get(criterion as RankingWeight['criterion']);
          const weight = weightRecord[criterion];
          if (baseline === undefined || typeof weight !== 'number') {
            throw new ApiFailure('INVALID_REQUEST');
          }
          return Object.freeze({ criterion, weight, proxyMultiplier: baseline.proxyMultiplier });
        }),
        includeProxy: parameters.includeProxy,
        minimumEvidenceCoverage: parameters.minimumEvidenceCoverage,
      });
      break;
    }
    case 'list_artifacts':
      if (parameters.artifactType !== undefined) throw new ApiFailure('INVALID_REQUEST');
      input = { releaseId };
      break;
    case 'get_data_dictionary':
      input = { releaseId };
      break;
  }
  if (PAGED_OPERATIONS.has(request.operation)) {
    input.limit = request.budget.maximumResults;
    if (request.cursor !== null) input.cursor = request.cursor;
  }
  return Object.freeze(input);
}

function defined(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function mapServingFailure(error: ProductionServingError): ApiFailure {
  switch (error.code) {
    case 'INVALID_REQUEST':
      return new ApiFailure('INVALID_REQUEST');
    case 'RELEASE_MISMATCH':
      return new ApiFailure('RELEASE_MISMATCH');
    case 'STALE_OR_TAMPERED_CURSOR':
      return new ApiFailure('STALE_CURSOR');
    case 'RESULT_TOO_LARGE':
      return new ApiFailure('RESPONSE_TOO_LARGE');
    case 'QUERY_BUDGET_EXCEEDED':
      return new ApiFailure('QUERY_BUDGET_EXCEEDED');
    case 'RELEASE_INVALID':
      return new ApiFailure('DATA_CORRUPTION');
    case 'INTERNAL_QUERY_ERROR':
      return new ApiFailure('INTERNAL_ERROR');
    default:
      return new ApiFailure('INTERNAL_ERROR');
  }
}

function immutableQueryService(
  service: ProductionServingService,
  rankingWeights: readonly RankingWeight[],
): ImmutableQueryService {
  return Object.freeze({
    kind: 'verified-immutable-release' as const,
    execute: async (request: QueryRequest): Promise<QueryResult> => {
      const input = canonicalInput(service, request, rankingWeights);
      const cursor = input.cursor;
      try {
        if (typeof cursor === 'string') {
          service.validateCursor({
            operation: request.operation,
            releaseId: String(input.releaseId),
            cursor,
          });
        }
        const result = await service.execute({
          operation: request.operation,
          input,
          signal: request.signal,
        });
        if (
          result.releaseId !== service.release.releaseId ||
          result.runId !== service.release.runId ||
          result.manifestCid !== service.release.manifestCid ||
          result.asOf !== service.release.asOf ||
          result.schemaVersion !== service.release.schemaVersion
        ) {
          throw new ApiFailure('DATA_CORRUPTION');
        }
        return Object.freeze({
          release: service.release,
          coverage: result.coverage,
          limitations: result.limitations,
          data: result.data,
          nextCursor: result.nextCursor,
          truncated: result.truncated,
          timing: result.timing,
        });
      } catch (error) {
        if (error instanceof ApiFailure) throw error;
        if (error instanceof ProductionServingError) throw mapServingFailure(error);
        throw new ApiFailure('INTERNAL_ERROR');
      }
    },
  });
}

function releaseDescriptor(service: ProductionServingService) {
  return Object.freeze({
    schemaVersion: service.release.schemaVersion,
    releaseId: service.release.releaseId,
    runId: service.release.runId,
    manifestCid: service.release.manifestCid,
    asOf: service.release.asOf,
    immutable: true as const,
    verified: true as const,
  });
}

function immutableAgentService(
  service: ProductionServingService,
  composition: ProductionOracleAgentComposition,
): BoundedAgentService {
  const release = releaseDescriptor(service);
  return Object.freeze({
    kind: 'no-fallback-bounded-agent' as const,
    status: async (releaseId: string, signal: AbortSignal) => {
      if (signal.aborted) throw new ApiFailure('AGENT_UNAVAILABLE');
      if (releaseId !== release.releaseId) throw new ApiFailure('RELEASE_MISMATCH');
      // This reports CONFIGURATION readiness, not live model reachability. It
      // previously returned a bare 'available' constant, which produced a
      // contradiction an evaluator hits immediately: the UI enables the agent
      // because status says available, the evaluator clicks a preset prompt, and
      // ask fails because the model itself is unreachable.
      //
      // A live probe per status call would invoke the model on every page load,
      // so instead the constant is replaced by an actual check of the
      // preconditions ask depends on, and the limitation is stated explicitly so
      // no consumer can read this as proof the model answered.
      const configured =
        composition.agent.model.modelId.trim().length > 0 &&
        composition.policy.hash.trim().length > 0;
      return await Promise.resolve(
        Object.freeze({
          release,
          status: configured ? ('available' as const) : ('unavailable' as const),
          modelProfileId: composition.agent.model.modelId,
          policyHash: composition.policy.hash,
          limitations: Object.freeze([
            ...composition.limitations,
            'Agent status reflects configuration readiness only; it does not invoke the model, so a configured agent can still fail at ask time if the model is unreachable.',
          ]),
        }),
      );
    },
    ask: async (request: AgentRequest) => {
      if (request.releaseId !== release.releaseId || request.timeoutMs !== 25_000) {
        throw new ApiFailure(
          request.releaseId === release.releaseId ? 'INVALID_REQUEST' : 'RELEASE_MISMATCH',
        );
      }
      const startedAt = Date.now();
      try {
        const answer = await composition.agent.ask(
          request.prompt,
          request.releaseId,
          request.signal,
        );
        return Object.freeze({
          release,
          status: 'complete' as const,
          answer: answer.text,
          citations: Object.freeze([...answer.citedEvidenceIds].sort()),
          toolCalls: Object.freeze(
            answer.trace.map((trace) =>
              Object.freeze({
                callIndex: trace.callIndex,
                toolName: trace.toolName,
                releaseId: trace.releaseId,
                evidenceIds: Object.freeze([...trace.evidenceIds].sort()),
              }),
            ),
          ),
          limitations: composition.limitations,
          timing: Object.freeze({ elapsedMs: Date.now() - startedAt, bytesScanned: null }),
        });
      } catch (error) {
        if (error instanceof ApiFailure) throw error;
        throw new ApiFailure('AGENT_UNAVAILABLE');
      }
    },
  });
}

export function unconfiguredProductionServices(
  environment: ProductionEnvironment,
  readiness: 'unconfigured' | 'configuration_error' = 'unconfigured',
): RuntimeServices {
  let origins: readonly string[];
  try {
    origins = allowedOrigins(environment);
  } catch {
    origins = Object.freeze([]);
  }
  return Object.freeze({
    deployment: 'production' as const,
    readiness,
    allowedOrigins: origins,
    cursorSecret: new Uint8Array(32),
    agent: null,
    query: {
      kind: 'verified-immutable-release' as const,
      execute: async () => await Promise.reject(new ApiFailure('SERVICE_UNAVAILABLE')),
    },
  });
}

export async function loadProductionRuntimeServices(
  environment: ProductionEnvironment,
  dependencies: ProductionCompositionDependencies = {},
): Promise<RuntimeServices> {
  const createServingService = dependencies.createServingService ?? createProductionServingService;
  const config = await servingConfig(environment);
  const service = await createServingService(config);
  let agent: BoundedAgentService | null;
  try {
    const testDependencies = dependencies.testOnlyAgentDependencies;
    const composition = await createProductionOracleAgent(
      {
        environment,
        serving: service,
        rankingWeights: config.rankingWeights,
        capabilities: config.capabilities,
        ...(config.limitations === undefined ? {} : { limitations: config.limitations }),
      },
      testDependencies?.dependencies,
    );
    agent = immutableAgentService(service, composition);
  } catch {
    agent = null;
  }
  return Object.freeze({
    deployment: 'production' as const,
    readiness: 'ready' as const,
    allowedOrigins: allowedOrigins(environment),
    cursorSecret: config.cursorSecret,
    agent,
    query: immutableQueryService(service, config.rankingWeights),
  });
}
