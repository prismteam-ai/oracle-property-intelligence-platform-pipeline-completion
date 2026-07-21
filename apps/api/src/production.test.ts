import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { createProductionAgentSemanticPolicy } from '@oracle/agent';
import {
  PRODUCTION_SERVING_INPUT_FIELDS,
  ProductionServingError,
  type ProductionServingConfig,
  type ProductionServingService,
} from '@oracle/query-core/serving/index';
import { PROPERTY_SEARCH_EXTENDED_INPUT_FIELDS } from '@oracle/query-core/serving/contracts';
import { describe, expect, it } from 'vitest';

import { createProductionApiHandler } from './handler.js';

const expected = Object.freeze({
  releaseId: 'release-santa-clara-2026-07-17',
  runId: 'run-santa-clara-2026-07-17',
  manifestSha256: 'a'.repeat(64),
  manifestCid: 'bafybeiverifiedmanifest',
  asOf: '2026-07-17T00:00:00.000Z',
  schemaVersion: '1.0.0',
  policyVersion: 'owner-free-public-serving@1.0.0',
});

const criteria = [
  'roof_age',
  'water_view_candidate',
  'ownership_age',
  'regional_owner',
  'transit_walkability',
  'starbucks_walkability',
] as const;
const testCapabilities = Object.freeze({
  roof_age: Object.freeze({
    state: 'supported' as const,
    supportClasses: Object.freeze(['supported'] as const),
    numerator: 1,
    denominator: 1,
    limitations: Object.freeze(['Roof evidence is limited to the immutable public release.']),
  }),
  water_view_candidate: Object.freeze({
    state: 'supported' as const,
    supportClasses: Object.freeze(['supported'] as const),
    numerator: 1,
    denominator: 1,
    limitations: Object.freeze([]),
  }),
  ownership_age: Object.freeze({
    state: 'supported' as const,
    supportClasses: Object.freeze(['supported'] as const),
    numerator: 1,
    denominator: 1,
    limitations: Object.freeze([]),
  }),
  regional_owner: Object.freeze({
    state: 'supported' as const,
    supportClasses: Object.freeze(['supported'] as const),
    numerator: 1,
    denominator: 1,
    limitations: Object.freeze([]),
  }),
  transit_walkability: Object.freeze({
    state: 'supported' as const,
    supportClasses: Object.freeze(['supported'] as const),
    numerator: 1,
    denominator: 1,
    limitations: Object.freeze([]),
  }),
  starbucks_walkability: Object.freeze({
    state: 'supported' as const,
    supportClasses: Object.freeze(['supported'] as const),
    numerator: 1,
    denominator: 1,
    limitations: Object.freeze([]),
  }),
});

function event(rawPath: string, body: unknown = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath,
    rawQueryString: '',
    headers: { 'content-type': 'application/json', origin: 'https://oracle.test' },
    requestContext: {
      accountId: 'test',
      apiId: 'test',
      domainName: 'test',
      domainPrefix: 'test',
      http: {
        method: rawPath === '/health' ? 'GET' : 'POST',
        path: rawPath,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'request-production-test',
      routeKey: '$default',
      stage: '$default',
      time: '17/Jul/2026:00:00:00 +0000',
      timeEpoch: 1,
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function parse(response: APIGatewayProxyResultV2): Readonly<Record<string, unknown>> {
  if (typeof response === 'string') throw new TypeError('Unexpected string response.');
  return JSON.parse(response.body ?? '{}') as Readonly<Record<string, unknown>>;
}

async function productionEnvironment(
  includeAgent = false,
): Promise<Readonly<Record<string, string>>> {
  const releaseRoot = await mkdtemp(join(tmpdir(), 'oracle-api-release-'));
  await writeFile(
    join(releaseRoot, 'serving.json'),
    JSON.stringify({
      manifestRelativePath: 'portable-release.json',
      expected,
      rankingWeights: criteria.map((criterion) => ({
        criterion,
        weight: 1,
        proxyMultiplier: 0.5,
      })),
      capabilities: testCapabilities,
      limitations: ['Production test composition; no fixture selected from environment.'],
    }),
  );
  const policy = createProductionAgentSemanticPolicy(testCapabilities);
  return Object.freeze({
    ORACLE_ALLOWED_ORIGINS: 'https://oracle.test',
    ORACLE_RELEASE_ROOT: releaseRoot,
    ORACLE_SERVING_CONFIG_RELATIVE_PATH: 'serving.json',
    ORACLE_CURSOR_HMAC_SECRET_BASE64: Buffer.alloc(32, 7).toString('base64'),
    ...(includeAgent
      ? {
          ORACLE_MODEL_PROVIDER: 'amazon-bedrock',
          ORACLE_BEDROCK_MODEL_ID: 'test-profile',
          ORACLE_BEDROCK_REGION: 'us-east-2',
          ORACLE_AGENT_POLICY_HASH: policy.hash,
        }
      : {}),
  });
}

function servingService(
  requests: Readonly<{ operation: string; input: Readonly<Record<string, unknown>> }>[],
): ProductionServingService {
  return {
    release: Object.freeze({
      ...expected,
      county: 'Santa Clara',
      state: 'CA',
      immutable: true,
      verified: true,
    }),
    validateCursor: ({ cursor }) => {
      if (cursor !== 'inner-serving-cursor') throw new TypeError('Invalid test cursor.');
    },
    execute: async (request) => {
      requests.push(Object.freeze({ operation: request.operation, input: request.input }));
      return await Promise.resolve(
        Object.freeze({
          schemaVersion: expected.schemaVersion,
          releaseId: expected.releaseId,
          runId: expected.runId,
          manifestCid: expected.manifestCid,
          asOf: expected.asOf,
          coverage: Object.freeze({ county: 'Santa Clara' }),
          limitations: Object.freeze([]),
          data: Object.freeze({ operation: request.operation, input: request.input }),
          nextCursor: null,
          truncated: false,
          timing: Object.freeze({ elapsedMs: 1, bytesScanned: 128 }),
        }),
      );
    },
  };
}

describe('production API composition', () => {
  it('composes the actual selected model and returns the frozen status/answer trace shapes', async () => {
    const environment = await productionEnvironment(true);
    const evidenceId = `sc:evidence:${'c'.repeat(64)}`;
    const base = servingService([]);
    let modelCall = 0;
    const api = createProductionApiHandler(environment, {
      createServingService: async () =>
        await Promise.resolve({
          ...base,
          execute: async () =>
            await Promise.resolve({
              schemaVersion: expected.schemaVersion,
              releaseId: expected.releaseId,
              runId: expected.runId,
              manifestCid: expected.manifestCid,
              asOf: expected.asOf,
              coverage: { roof_age: testCapabilities.roof_age },
              limitations: ['Returned roof evidence is release-bound.'],
              data: {
                results: [
                  {
                    propertyId: 'sc:property:test',
                    evidence: [
                      {
                        evidenceId,
                        supportClass: 'supported',
                        sourceIds: ['sc:source:test'],
                        limitations: [],
                        visibility: 'public',
                      },
                    ],
                  },
                ],
              },
              nextCursor: null,
              truncated: false,
              timing: { elapsedMs: 1, bytesScanned: 128 },
            }),
        }),
      testOnlyAgentDependencies: {
        label: 'TEST_ONLY_DETERMINISTIC_AGENT',
        dependencies: {
          createGateway: (config) => ({
            ...config,
            model: {
              specificationVersion: 'v3',
              provider: 'amazon-bedrock',
              modelId: config.modelId,
              supportedUrls: {},
              doGenerate: () => {
                modelCall += 1;
                const tool = modelCall === 1;
                return Promise.resolve({
                  content: tool
                    ? [
                        {
                          type: 'tool-call' as const,
                          toolCallId: 'call-1',
                          toolName: 'find_roof_age_candidates',
                          input: JSON.stringify({ minimumAgeYears: 15 }),
                        },
                      ]
                    : [{ type: 'text' as const, text: `Qualified [evidence:${evidenceId}].` }],
                  finishReason: {
                    unified: tool ? ('tool-calls' as const) : ('stop' as const),
                    raw: tool ? 'tool_use' : 'end_turn',
                  },
                  usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                  },
                  warnings: [],
                });
              },
              doStream: () => Promise.resolve({ stream: new ReadableStream() }),
            },
          }),
        },
      },
    });

    const health = parse(await api(event('/health'), {} as Context));
    expect(health).toMatchObject({ dataQueryPerformed: false, status: 'ready' });
    expect(modelCall).toBe(0);
    const status = parse(
      await api(event('/agent.status', { releaseId: expected.releaseId }), {} as Context),
    );
    expect(status).toMatchObject({
      limitations: [
        'Production test composition; no fixture selected from environment.',
        'Roof evidence is limited to the immutable public release.',
        'Agent status reflects configuration readiness only; it does not invoke the model, so a configured agent can still fail at ask time if the model is unreachable.',
      ],
      data: {
        status: 'available',
        modelProfileId: 'test-profile',
        policyHash: environment.ORACLE_AGENT_POLICY_HASH,
        limitations: [
          'Production test composition; no fixture selected from environment.',
          'Roof evidence is limited to the immutable public release.',
          // agent.status reports configuration readiness and never invokes the
          // model - asserted here so the distinction cannot be quietly dropped.
          // modelCall stays 0 below, which is the proof it is not a live probe.
          'Agent status reflects configuration readiness only; it does not invoke the model, so a configured agent can still fail at ask time if the model is unreachable.',
        ],
      },
    });
    expect(modelCall).toBe(0);
    const answer = parse(
      await api(
        event('/agent.ask', { releaseId: expected.releaseId, prompt: 'Find roof candidates.' }),
        {} as Context,
      ),
    );
    expect(answer).toMatchObject({
      data: {
        status: 'complete',
        answer: `Qualified [evidence:${evidenceId}].`,
        citations: [evidenceId],
        toolCalls: [
          {
            callIndex: 1,
            toolName: 'find_roof_age_candidates',
            releaseId: expected.releaseId,
            evidenceIds: [evidenceId],
          },
        ],
      },
    });
    expect(JSON.stringify(answer)).not.toMatch(/reasoning|chain.of.thought|tool.*input/iu);
  });

  it('composes the default-style handler over the shared production serving boundary', async () => {
    const environment = await productionEnvironment();
    const requests: Readonly<{
      operation: string;
      input: Readonly<Record<string, unknown>>;
    }>[] = [];
    let receivedConfig: ProductionServingConfig | undefined;
    const api = createProductionApiHandler(environment, {
      createServingService: async (config) => {
        receivedConfig = config;
        return await Promise.resolve(servingService(requests));
      },
    });

    const health = await api(event('/health'), {} as Context);
    expect(parse(health)).toMatchObject({
      service: 'api',
      status: 'ready',
      readiness: 'ready',
      dataQueryPerformed: false,
      fixture: null,
    });
    expect(receivedConfig).toMatchObject({
      releaseRoot: environment.ORACLE_RELEASE_ROOT,
      manifestRelativePath: 'portable-release.json',
      expected,
    });
    expect(requests).toHaveLength(0);

    const result = await api(
      event('/pipeline.listRuns', { releaseId: expected.releaseId, limit: 17 }),
      {} as Context,
    );
    expect(result).toMatchObject({ statusCode: 200 });
    expect(requests).toEqual([
      {
        operation: 'list_pipeline_runs',
        input: { releaseId: expected.releaseId, limit: 17 },
      },
    ]);
    expect(parse(result)).toMatchObject({
      releaseId: expected.releaseId,
      runId: expected.runId,
      data: {
        operation: 'list_pipeline_runs',
        input: { releaseId: expected.releaseId, limit: 17 },
      },
    });
  });

  it('maps all sixteen application query operations to canonical shared inputs', async () => {
    const environment = await productionEnvironment();
    const requests: Readonly<{
      operation: string;
      input: Readonly<Record<string, unknown>>;
    }>[] = [];
    const api = createProductionApiHandler(environment, {
      createServingService: async () => await Promise.resolve(servingService(requests)),
    });
    const releaseId = expected.releaseId;
    const propertyId = 'sc:property:test';
    const cases = [
      ['dataset.getInfo', {}, 'get_dataset_info', {}],
      ['dataset.getCoverage', { releaseId }, 'get_dataset_coverage', { releaseId }],
      ['pipeline.listRuns', { releaseId }, 'list_pipeline_runs', { releaseId, limit: 25 }],
      [
        'pipeline.getRun',
        { releaseId, runId: expected.runId },
        'get_pipeline_run',
        { releaseId, runId: expected.runId },
      ],
      [
        'property.search',
        { releaseId, query: ' Hamilton ', sort: 'address' },
        'search_properties',
        { releaseId, query: 'Hamilton', sort: 'address', limit: 25 },
      ],
      ['property.get', { releaseId, propertyId }, 'get_property', { releaseId, propertyId }],
      [
        'property.getEvidence',
        { releaseId, propertyId },
        'get_property_evidence',
        { releaseId, propertyId, limit: 25 },
      ],
      [
        'inquiry.roofAge',
        { releaseId },
        'find_roof_age_candidates',
        { releaseId, minimumAgeYears: 15, includeProxy: false, limit: 25 },
      ],
      [
        'inquiry.waterCandidates',
        { releaseId },
        'find_water_view_candidates',
        {
          releaseId,
          maximumWaterDistanceMeters: 5_000,
          minimumTerrainVisibilityConfidence: 0.5,
          waterFeatureTypes: ['ocean', 'bay', 'reservoir', 'lake', 'river', 'stream', 'canal'],
          includeProxy: false,
          limit: 25,
        },
      ],
      [
        'inquiry.ownershipAge',
        { releaseId },
        'find_ownership_age_candidates',
        {
          releaseId,
          minimumTenureYears: 10,
          requireCompleteHistory: true,
          limit: 25,
        },
      ],
      [
        'inquiry.regionalOwner',
        { releaseId },
        'find_regional_owner_properties',
        { releaseId, regionPolicyId: 'bay-area-nine-counties-v1', limit: 25 },
      ],
      [
        'inquiry.transitWalkability',
        { releaseId },
        'find_transit_walkable_properties',
        {
          releaseId,
          maximumNetworkDistanceMeters: 800,
          maximumSnapDistanceMeters: 200,
          includeProxy: false,
          limit: 25,
        },
      ],
      [
        'inquiry.starbucksWalkability',
        { releaseId },
        'find_starbucks_walkable_properties',
        {
          releaseId,
          maximumNetworkDistanceMeters: 800,
          maximumSnapDistanceMeters: 200,
          minimumPlaceConfidence: 0.7,
          includeProxy: false,
          limit: 25,
        },
      ],
      [
        'inquiry.rankCandidates',
        { releaseId },
        'rank_review_candidates',
        {
          releaseId,
          criteria: ['roof_age', 'ownership_age', 'transit_walkability'],
          weights: [
            { criterion: 'roof_age', weight: 1, proxyMultiplier: 0.5 },
            { criterion: 'ownership_age', weight: 1, proxyMultiplier: 0.5 },
            { criterion: 'transit_walkability', weight: 1, proxyMultiplier: 0.5 },
          ],
          includeProxy: false,
          minimumEvidenceCoverage: 0.5,
          limit: 25,
        },
      ],
      ['artifacts.list', { releaseId }, 'list_artifacts', { releaseId, limit: 25 }],
      [
        'artifacts.getDataDictionary',
        { releaseId },
        'get_data_dictionary',
        { releaseId, limit: 25 },
      ],
    ] as const;

    for (const [applicationOperation, body] of cases) {
      const result = await api(event(`/${applicationOperation}`, body), {} as Context);
      expect(result, applicationOperation).toMatchObject({ statusCode: 200 });
    }

    expect(requests).toEqual(cases.map(([, , operation, input]) => ({ operation, input })));
    for (const request of requests) {
      const allowed =
        request.operation === 'search_properties'
          ? PROPERTY_SEARCH_EXTENDED_INPUT_FIELDS
          : PRODUCTION_SERVING_INPUT_FIELDS[
              request.operation as keyof typeof PRODUCTION_SERVING_INPUT_FIELDS
            ];
      expect(allowed, request.operation).toBeDefined();
      expect(
        Object.keys(request.input).filter((field) => !allowed.includes(field)),
        request.operation,
      ).toEqual([]);
    }
  });

  it('preserves shared evidence and limitations without transport reinterpretation', async () => {
    const environment = await productionEnvironment();
    const base = servingService([]);
    const evidence = Object.freeze([
      Object.freeze({
        evidenceId: `sc:evidence:${'b'.repeat(64)}`,
        supportClass: 'supported',
        sourceIds: Object.freeze(['sc:source:test']),
        limitations: Object.freeze(['Source-shaped production composition test evidence.']),
      }),
    ]);
    const api = createProductionApiHandler(environment, {
      createServingService: async () =>
        await Promise.resolve({
          ...base,
          execute: async () =>
            await Promise.resolve({
              schemaVersion: expected.schemaVersion,
              releaseId: expected.releaseId,
              runId: expected.runId,
              manifestCid: expected.manifestCid,
              asOf: expected.asOf,
              coverage: { roof_age: { state: 'supported' } },
              limitations: ['County coverage is release-bound.'],
              data: { results: [{ propertyId: 'sc:property:test', evidence }] },
              nextCursor: null,
              truncated: false,
              timing: { elapsedMs: 2, bytesScanned: 256 },
            }),
        }),
    });

    const result = parse(
      await api(event('/inquiry.roofAge', { releaseId: expected.releaseId }), {} as Context),
    );
    expect(result).toMatchObject({
      coverage: { roof_age: { state: 'supported' } },
      limitations: ['County coverage is release-bound.'],
      data: { results: [{ propertyId: 'sc:property:test', evidence }] },
    });
  });

  it('returns and accepts the exact shared release-bound cursor used by MCP', async () => {
    const environment = await productionEnvironment();
    const requests: Readonly<Record<string, unknown>>[] = [];
    const base = servingService([]);
    const api = createProductionApiHandler(environment, {
      createServingService: async () =>
        await Promise.resolve({
          ...base,
          execute: async (request) => {
            requests.push(request.input);
            return await Promise.resolve({
              schemaVersion: expected.schemaVersion,
              releaseId: expected.releaseId,
              runId: expected.runId,
              manifestCid: expected.manifestCid,
              asOf: expected.asOf,
              coverage: {},
              limitations: [],
              data: { runs: [] },
              nextCursor: request.input.cursor === undefined ? 'inner-serving-cursor' : null,
              truncated: request.input.cursor === undefined,
              timing: { elapsedMs: 1, bytesScanned: 128 },
            });
          },
        }),
    });

    const first = parse(
      await api(event('/pipeline.listRuns', { releaseId: expected.releaseId }), {} as Context),
    );
    expect(first.nextCursor).toBe('inner-serving-cursor');
    const second = await api(
      event('/pipeline.listRuns', {
        releaseId: expected.releaseId,
        cursor: 'inner-serving-cursor',
      }),
      {} as Context,
    );
    expect(second).toMatchObject({ statusCode: 200 });
    expect(requests[1]).toMatchObject({ cursor: 'inner-serving-cursor' });
  });

  it('maps shared serving failures to fixed redacted API errors', async () => {
    const environment = await productionEnvironment();
    const base = servingService([]);
    const api = createProductionApiHandler(environment, {
      createServingService: async () =>
        await Promise.resolve({
          ...base,
          execute: async () =>
            await Promise.reject(
              new ProductionServingError(
                'INTERNAL_QUERY_ERROR',
                'select secret from C:\\private\\release.parquet',
              ),
            ),
        }),
    });

    const result = await api(event('/dataset.getInfo'), {} as Context);
    expect(result).toMatchObject({ statusCode: 500 });
    const serialized = JSON.stringify(parse(result));
    expect(serialized).toContain('INTERNAL_ERROR');
    expect(serialized).not.toContain('select secret');
    expect(serialized).not.toContain('private');
    expect(serialized).not.toContain('parquet');
  });

  it('forwards every public property sort without production rejection', async () => {
    const environment = await productionEnvironment();
    const requests: Readonly<{
      operation: string;
      input: Readonly<Record<string, unknown>>;
    }>[] = [];
    const api = createProductionApiHandler(environment, {
      createServingService: async () => await Promise.resolve(servingService(requests)),
    });
    for (const sort of ['property_id', 'address', 'parcel_identifier'] as const) {
      const result = await api(
        event('/property.search', {
          releaseId: expected.releaseId,
          query: 'Hamilton',
          sort,
        }),
        {} as Context,
      );
      expect(result, sort).toMatchObject({ statusCode: 200 });
    }
    expect(requests).toEqual(
      ['property_id', 'address', 'parcel_identifier'].map((sort) => ({
        operation: 'search_properties',
        input: { releaseId: expected.releaseId, query: 'Hamilton', sort, limit: 25 },
      })),
    );
  });

  it('rejects unsupported API-only filters instead of silently dropping them', async () => {
    const environment = await productionEnvironment();
    const requests: Readonly<{
      operation: string;
      input: Readonly<Record<string, unknown>>;
    }>[] = [];
    const api = createProductionApiHandler(environment, {
      createServingService: async () => await Promise.resolve(servingService(requests)),
    });
    const attempts = [
      ['/inquiry.transitWalkability', { releaseId: expected.releaseId, transitMode: 'rail' }],
      ['/artifacts.list', { releaseId: expected.releaseId, artifactType: 'manifest' }],
    ] as const;

    for (const [path, body] of attempts) {
      const result = await api(event(path, body), {} as Context);
      expect(result, path).toMatchObject({ statusCode: 400 });
      expect(parse(result), path).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    }
    expect(requests).toHaveLength(0);
  });

  it('fails closed with truthful health when production configuration is absent', async () => {
    const api = createProductionApiHandler({
      ORACLE_ALLOWED_ORIGINS: 'https://oracle.test',
    });
    const health = await api(event('/health'), {} as Context);
    expect(parse(health)).toMatchObject({
      status: 'degraded',
      readiness: 'unconfigured',
      dataQueryPerformed: false,
      fixture: null,
    });

    const query = await api(event('/dataset.getInfo'), {} as Context);
    expect(query).toMatchObject({ statusCode: 503 });
    expect(parse(query)).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } });
  });

  it('distinguishes partial production configuration from an absent release', async () => {
    const api = createProductionApiHandler({
      ORACLE_ALLOWED_ORIGINS: 'https://oracle.test',
      ORACLE_RELEASE_ROOT: 'C:\\partial-release',
    });
    const health = await api(event('/health'), {} as Context);
    expect(parse(health)).toMatchObject({
      status: 'degraded',
      readiness: 'configuration_error',
      dataQueryPerformed: false,
      fixture: null,
    });
  });

  it('has no production environment switch that selects a fixture service', async () => {
    const api = createProductionApiHandler({
      ORACLE_ALLOWED_ORIGINS: 'https://oracle.test',
      ORACLE_FIXTURE: 'TEST_ONLY_DETERMINISTIC_FIXTURE',
      NODE_ENV: 'test',
    });
    const result = await api(event('/dataset.getInfo'), {} as Context);
    expect(parse(result)).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } });
  });
});
