import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  PRODUCTION_SERVING_INPUT_FIELDS,
  ProductionServingError,
  type ProductionServingConfig,
  type ProductionServingEnvelope,
  type ProductionServingRequest,
  type ProductionServingService,
} from '@oracle/query-core/serving/index';

import {
  createProductionMcpHandler,
  createProductionNamedEvidenceService,
  productionServingConfigFromEnvironment,
  type McpProductionEnvironment,
  type ProductionServingFactory,
} from './composition.js';
import { namedEvidenceToolDefinitions, namedEvidenceToolNames } from './schemas.js';

const release = Object.freeze({
  schemaVersion: '1.0.0',
  releaseId: 'release-santa-clara-2026-07-17',
  runId: 'run-santa-clara-2026-07-17',
  manifestCid: 'bafybeiverifiedmanifest',
  manifestSha256: 'a'.repeat(64),
  asOf: '2026-07-17T00:00:00.000Z',
  policyVersion: 'oracle-policy-v1',
  county: 'Santa Clara',
  state: 'CA',
  immutable: true,
  verified: true,
} as const);

const envelope: ProductionServingEnvelope = Object.freeze({
  schemaVersion: release.schemaVersion,
  releaseId: release.releaseId,
  runId: release.runId,
  manifestCid: release.manifestCid,
  asOf: release.asOf,
  coverage: Object.freeze({ county: 'Santa Clara' }),
  limitations: Object.freeze(['Production-serving composition fixture only.']),
  data: Object.freeze({ records: [] }),
  nextCursor: null,
  truncated: false,
  timing: Object.freeze({ elapsedMs: 1, bytesScanned: 0 }),
});

const capability = Object.freeze({
  state: 'supported',
  supportClasses: Object.freeze(['supported', 'proxy', 'unknown'] as const),
  numerator: 1,
  denominator: 1,
  limitations: Object.freeze([]),
});

let releaseRoot = '';
let configuredEnvironment: McpProductionEnvironment = {};

beforeEach(async () => {
  releaseRoot = await mkdtemp(join(tmpdir(), 'oracle-mcp-composition-'));
  await writeFile(
    join(releaseRoot, 'serving-config.json'),
    JSON.stringify({
      manifestRelativePath: 'release-manifest.json',
      expected: {
        releaseId: release.releaseId,
        runId: release.runId,
        manifestSha256: release.manifestSha256,
        manifestCid: release.manifestCid,
        asOf: release.asOf,
        schemaVersion: release.schemaVersion,
        policyVersion: release.policyVersion,
      },
      rankingWeights: [
        'roof_age',
        'water_view_candidate',
        'ownership_age',
        'regional_owner',
        'transit_walkability',
        'starbucks_walkability',
      ].map((criterion) => ({ criterion, weight: 1, proxyMultiplier: 0.5 })),
      capabilities: {
        roof_age: capability,
        water_view_candidate: capability,
        ownership_age: capability,
        regional_owner: capability,
        transit_walkability: capability,
        starbucks_walkability: capability,
      },
      limitations: ['Known release limitation.'],
    }),
    'utf8',
  );
  configuredEnvironment = {
    ORACLE_RELEASE_ROOT: releaseRoot,
    ORACLE_SERVING_CONFIG_RELATIVE_PATH: 'serving-config.json',
    ORACLE_CURSOR_HMAC_SECRET_BASE64: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
  };
});

afterEach(async () => {
  await rm(releaseRoot, { recursive: true, force: true });
});

function serving(
  options: Readonly<{
    execute?: (request: ProductionServingRequest) => Promise<ProductionServingEnvelope>;
  }> = {},
): ProductionServingService {
  return {
    release,
    execute: options.execute ?? (() => Promise.resolve(envelope)),
    validateCursor: vi.fn(),
  };
}

function factory(service: ProductionServingService): ProductionServingFactory {
  return vi.fn<(config: ProductionServingConfig) => Promise<ProductionServingService>>(() =>
    Promise.resolve(service),
  );
}

function event(rawPath: string, body: unknown, method = 'POST'): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath,
    rawQueryString: '',
    headers:
      method === 'POST'
        ? {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-11-25',
          }
        : {},
    requestContext: {
      accountId: 'test',
      apiId: 'test',
      domainName: 'test',
      domainPrefix: 'test',
      http: {
        method,
        path: rawPath,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'request-composition-test',
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
  if (typeof response === 'string') throw new TypeError('Unexpected string Lambda result');
  return JSON.parse(response.body ?? '{}') as Readonly<Record<string, unknown>>;
}

describe('production serving configuration', () => {
  it('returns unconfigured only when every production release field is absent', () => {
    return Promise.all([
      expect(productionServingConfigFromEnvironment({})).resolves.toBeNull(),
      expect(
        productionServingConfigFromEnvironment({ ORACLE_RELEASE_ROOT: releaseRoot }),
      ).rejects.toThrow(/incomplete or invalid/u),
    ]).then(() => undefined);
  });

  it('parses only explicit server-owned release metadata and packaged paths', async () => {
    const config = await productionServingConfigFromEnvironment(configuredEnvironment);
    expect(config).toMatchObject({
      releaseRoot,
      manifestRelativePath: 'release-manifest.json',
      expected: {
        releaseId: release.releaseId,
        runId: release.runId,
        manifestSha256: release.manifestSha256,
        manifestCid: release.manifestCid,
      },
      limitations: ['Known release limitation.'],
    });
    expect(config?.cursorSecret).toHaveLength(32);
    expect(JSON.stringify(config)).not.toContain('fixture');
  });

  it('rejects short or malformed cursor secrets before constructing the service', async () => {
    await expect(
      productionServingConfigFromEnvironment({
        ...configuredEnvironment,
        ORACLE_CURSOR_HMAC_SECRET_BASE64: Buffer.from('short').toString('base64'),
      }),
    ).rejects.toThrow(/incomplete or invalid/u);
    await expect(
      productionServingConfigFromEnvironment({
        ...configuredEnvironment,
        ORACLE_CURSOR_HMAC_SECRET_BASE64: 'not canonical base64',
      }),
    ).rejects.toThrow(/incomplete or invalid/u);
  });

  it('fails closed when immutable release construction rejects configuration or drift', async () => {
    const failedFactory = vi.fn(() =>
      Promise.reject(new ProductionServingError('RELEASE_INVALID', 'C:\\secret\\release drift')),
    );
    await expect(
      createProductionNamedEvidenceService(configuredEnvironment, failedFactory),
    ).resolves.toMatchObject({
      kind: 'unavailable',
    });
    await expect(createProductionNamedEvidenceService({}, failedFactory)).resolves.toMatchObject({
      kind: 'unavailable',
    });
    expect(failedFactory).toHaveBeenCalledTimes(1);
  });
});

describe('production MCP composition', () => {
  it('keeps every Inspector schema in lockstep with the shared serving allowlists', () => {
    for (const definition of namedEvidenceToolDefinitions) {
      const jsonSchema = z.toJSONSchema(definition.inputSchema) as {
        properties?: Readonly<Record<string, unknown>>;
      };
      const inspectorFields = Object.keys(jsonSchema.properties ?? {}).map((field) =>
        field === 'pageSize' ? 'limit' : field,
      );
      expect(inspectorFields.sort()).toEqual(
        [...PRODUCTION_SERVING_INPUT_FIELDS[definition.name]].sort(),
      );
    }
  });

  it('delegates all 16 operations unchanged to the shared production serving service', async () => {
    const execute = vi.fn<
      (request: ProductionServingRequest) => Promise<ProductionServingEnvelope>
    >(() => Promise.resolve(envelope));
    const service = await createProductionNamedEvidenceService(
      configuredEnvironment,
      factory(serving({ execute })),
    );
    expect(service.kind).toBe('verified-immutable-release');
    for (const operation of namedEvidenceToolNames) {
      await service.execute({
        tool: operation,
        input: operation === 'get_dataset_info' ? {} : { releaseId: release.releaseId },
      });
    }
    expect(execute.mock.calls.map(([request]) => request.operation)).toEqual(
      namedEvidenceToolNames,
    );

    await service.execute({
      tool: 'search_properties',
      input: { releaseId: release.releaseId, pageSize: 7, cursor: null },
    });
    expect(execute.mock.calls.at(-1)?.[0]).toMatchObject({
      operation: 'search_properties',
      input: { releaseId: release.releaseId, limit: 7, cursor: null },
    });
    expect(execute.mock.calls.at(-1)?.[0].input).not.toHaveProperty('pageSize');
  });

  it('reports ready only after verified production construction and preserves the shared envelope', async () => {
    const mcp = await createProductionMcpHandler(configuredEnvironment, factory(serving()));
    expect(parse(await mcp(event('/mcp/health', {}, 'GET')))).toMatchObject({
      status: 'ready',
      readiness: 'ready',
      fixture: null,
      dataQueriesExecuted: 0,
    });
    const response = await mcp(
      event('/mcp', {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_dataset_info', arguments: {} },
      }),
    );
    expect(parse(response)).toMatchObject({
      result: { structuredContent: envelope },
    });
  });

  it('forwards cursor validation with the exact operation and immutable release binding', async () => {
    const validateCursor = vi.fn();
    const shared = { ...serving(), validateCursor };
    const service = await createProductionNamedEvidenceService(
      configuredEnvironment,
      factory(shared),
    );
    await service.validateCursor?.({
      tool: 'list_pipeline_runs',
      releaseId: release.releaseId,
      cursor: 'opaque.cursor',
    });
    expect(validateCursor).toHaveBeenCalledWith({
      operation: 'list_pipeline_runs',
      releaseId: release.releaseId,
      cursor: 'opaque.cursor',
    });
  });

  it('redacts shared runtime failures and never leaks paths, SQL, or stack details', async () => {
    const execute = () =>
      Promise.reject(
        new ProductionServingError(
          'INTERNAL_QUERY_ERROR',
          'C:\\secret\\release.duckdb SELECT * FROM restricted',
        ),
      );
    const mcp = await createProductionMcpHandler(
      configuredEnvironment,
      factory(serving({ execute })),
    );
    const response = await mcp(
      event('/mcp', {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_dataset_info', arguments: {} },
      }),
    );
    const encoded = JSON.stringify(parse(response));
    expect(encoded).toContain('INTERNAL_ERROR');
    expect(encoded).not.toContain('release.duckdb');
    expect(encoded).not.toContain('SELECT');
    expect(encoded).not.toContain('stack');
  });

  it('fails closed when the shared result metadata drifts from the verified release', async () => {
    const execute = () => Promise.resolve({ ...envelope, runId: 'run-drifted' });
    const mcp = await createProductionMcpHandler(
      configuredEnvironment,
      factory(serving({ execute })),
    );
    const response = await mcp(
      event('/mcp', {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_dataset_info', arguments: {} },
      }),
    );
    expect(JSON.stringify(parse(response))).toContain('SERVICE_UNAVAILABLE');
  });
});
