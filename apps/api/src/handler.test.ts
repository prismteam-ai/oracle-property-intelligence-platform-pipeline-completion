import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import {
  API_LIMITS,
  applicationOperations,
  queryOperationByApplicationOperation,
  type ApplicationOperation,
} from './contract.js';
import { createApiHandler, handler as productionHandler } from './handler.js';
import type {
  AgentResult,
  AgentStatus,
  QueryRequest,
  QueryResult,
  ReleaseDescriptor,
  RuntimeServices,
} from './runtime.js';

const release: ReleaseDescriptor = Object.freeze({
  schemaVersion: '1.0.0',
  releaseId: 'release-santa-clara-2026-07-17',
  runId: 'run-santa-clara-2026-07-17',
  manifestCid: 'bafybeiverifiedmanifest',
  asOf: '2026-07-17T00:00:00.000Z',
  immutable: true,
  verified: true,
});

type FixtureOptions = Readonly<{
  bytesScanned?: number | null;
  data?: unknown;
  release?: ReleaseDescriptor;
  agent?: 'available' | 'unavailable';
}>;

function fixtureServices(options: FixtureOptions = {}): RuntimeServices {
  const fixtureRelease = options.release ?? release;
  return {
    deployment: 'test',
    readiness: 'test_fixture',
    fixtureLabel: 'TEST_ONLY_DETERMINISTIC_FIXTURE',
    allowedOrigins: ['https://oracle.test'],
    cursorSecret: new Uint8Array(32).fill(7),
    query: {
      kind: 'verified-immutable-release',
      execute: async (request: QueryRequest): Promise<QueryResult> =>
        await Promise.resolve({
          release: fixtureRelease,
          coverage: { county: 'Santa Clara', fixture: true },
          limitations: ['TEST ONLY — deterministic fixture; never production county evidence.'],
          data: options.data ?? {
            operation: request.operation,
            parameters: request.parameters,
            rows:
              request.continuation === null
                ? [{ propertyId: 'sc:test:1' }]
                : [{ propertyId: 'sc:test:2' }],
          },
          nextContinuation:
            request.continuation === null && request.operation === 'search_properties'
              ? ['sc:test:1']
              : null,
          truncated: request.operation === 'search_properties' && request.continuation === null,
          timing: { elapsedMs: 2, bytesScanned: options.bytesScanned ?? 256 },
        }),
    },
    agent:
      options.agent === 'unavailable'
        ? null
        : {
            kind: 'no-fallback-bounded-agent',
            ask: async (request): Promise<AgentResult> =>
              await Promise.resolve({
                release: fixtureRelease,
                status: 'available',
                answer: { text: `Fixture answer for: ${request.prompt}` },
                citations: ['evidence:test:1'],
                limitations: ['TEST ONLY — mocked provider.'],
                timing: { elapsedMs: 3, bytesScanned: 0 },
              }),
            status: async (): Promise<AgentStatus> =>
              await Promise.resolve({
                release: fixtureRelease,
                status: 'available',
                modelProfile: 'test-only-mocked-provider',
                policyHash: 'test-only-policy-hash',
                limitations: ['TEST ONLY — mocked provider.'],
              }),
          },
  };
}

function event(
  rawPath: string,
  body: unknown = {},
  options: Readonly<{
    method?: string;
    origin?: string;
    contentType?: string | null;
    rawBody?: string;
  }> = {},
): APIGatewayProxyEventV2 {
  const headers: Record<string, string> = {};
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.contentType !== null)
    headers['content-type'] = options.contentType ?? 'application/json';
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath,
    rawQueryString: '',
    headers,
    requestContext: {
      accountId: 'test',
      apiId: 'test',
      domainName: 'test',
      domainPrefix: 'test',
      http: {
        method: options.method ?? 'POST',
        path: rawPath,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'request-test-1',
      routeKey: '$default',
      stage: '$default',
      time: '17/Jul/2026:00:00:00 +0000',
      timeEpoch: 1,
    },
    body: options.rawBody ?? JSON.stringify(body),
    isBase64Encoded: false,
  };
}

const context = {} as Context;

function parse(response: APIGatewayProxyResultV2): Readonly<Record<string, unknown>> {
  if (typeof response === 'string') throw new TypeError('Unexpected string response.');
  return JSON.parse(response.body ?? '{}') as Readonly<Record<string, unknown>>;
}

function errorCode(response: APIGatewayProxyResultV2): string {
  const value = parse(response).error as Readonly<Record<string, unknown>>;
  return String(value.code);
}

const minimalInputs: Readonly<Record<ApplicationOperation, Readonly<Record<string, unknown>>>> = {
  'dataset.getInfo': {},
  'dataset.getCoverage': { releaseId: release.releaseId },
  'pipeline.listRuns': { releaseId: release.releaseId },
  'pipeline.getRun': { releaseId: release.releaseId, runId: release.runId },
  'property.search': { releaseId: release.releaseId },
  'property.get': { releaseId: release.releaseId, propertyId: 'sc:property:test' },
  'property.getEvidence': { releaseId: release.releaseId, propertyId: 'sc:property:test' },
  'inquiry.roofAge': { releaseId: release.releaseId },
  'inquiry.waterCandidates': { releaseId: release.releaseId },
  'inquiry.ownershipAge': { releaseId: release.releaseId },
  'inquiry.regionalOwner': { releaseId: release.releaseId },
  'inquiry.transitWalkability': { releaseId: release.releaseId },
  'inquiry.starbucksWalkability': { releaseId: release.releaseId },
  'inquiry.rankCandidates': { releaseId: release.releaseId },
  'artifacts.list': { releaseId: release.releaseId },
  'artifacts.getDataDictionary': { releaseId: release.releaseId },
  'agent.ask': { releaseId: release.releaseId, prompt: 'Which supported properties qualify?' },
  'agent.status': { releaseId: release.releaseId },
};

describe('Oracle application API contract', () => {
  it('keeps health cheap, query-free, and visibly labels test fixtures', async () => {
    let queries = 0;
    const services = fixtureServices();
    const api = createApiHandler({
      ...services,
      query: {
        kind: 'verified-immutable-release',
        execute: async (request) => {
          queries += 1;
          return services.query.execute(request);
        },
      },
    });
    const result = await api(event('/health', {}, { method: 'GET' }), context);
    expect(result).toMatchObject({ statusCode: 200 });
    expect(parse(result)).toMatchObject({
      dataQueryPerformed: false,
      status: 'degraded',
      readiness: 'test_fixture',
      fixture: 'TEST_ONLY_DETERMINISTIC_FIXTURE',
    });
    expect(queries).toBe(0);
  });

  it.each(applicationOperations)('serves the strict bounded %s operation', async (operation) => {
    const result = await createApiHandler(fixtureServices())(
      event(`/${operation}`, minimalInputs[operation]),
      context,
    );
    expect(result).toMatchObject({ statusCode: 200 });
    expect(parse(result)).toMatchObject({
      schemaVersion: '1.0.0',
      releaseId: release.releaseId,
      runId: release.runId,
    });
  });

  it.each(applicationOperations)('rejects additional properties for %s', async (operation) => {
    const result = await createApiHandler(fixtureServices())(
      event(`/${operation}`, { ...minimalInputs[operation], sql: 'select * from secrets' }),
      context,
    );
    expect(result).toMatchObject({ statusCode: 400 });
    expect(errorCode(result)).toBe('INVALID_REQUEST');
  });

  it('maps every deterministic route to the frozen named-query inventory', () => {
    expect(Object.values(queryOperationByApplicationOperation)).toHaveLength(16);
    expect(new Set(Object.values(queryOperationByApplicationOperation)).size).toBe(16);
  });

  it('rejects unknown operations, wrong methods, media types, and invalid calendar dates', async () => {
    const api = createApiHandler(fixtureServices());
    const unknown = await api(event('/property.runArbitrarySql'), context);
    expect(errorCode(unknown)).toBe('UNKNOWN_OPERATION');
    const method = await api(event('/dataset.getInfo', {}, { method: 'GET' }), context);
    expect(errorCode(method)).toBe('METHOD_NOT_ALLOWED');
    const media = await api(event('/dataset.getInfo', {}, { contentType: 'text/plain' }), context);
    expect(errorCode(media)).toBe('INVALID_REQUEST');
    const date = await api(
      event('/inquiry.roofAge', { releaseId: release.releaseId, asOf: '2026-02-30' }),
      context,
    );
    expect(errorCode(date)).toBe('INVALID_REQUEST');
  });

  it('uses an integrity-protected release-bound opaque cursor', async () => {
    const api = createApiHandler(fixtureServices());
    const first = await api(event('/property.search', minimalInputs['property.search']), context);
    const cursor = String(parse(first).nextCursor);
    expect(Buffer.byteLength(cursor, 'utf8')).toBeLessThanOrEqual(API_LIMITS.cursorBytes);

    const second = await api(
      event('/property.search', { releaseId: release.releaseId, cursor }),
      context,
    );
    expect(second).toMatchObject({ statusCode: 200 });
    expect(parse(second)).toMatchObject({ nextCursor: null, truncated: false });

    const tampered = await api(
      event('/property.search', { releaseId: release.releaseId, cursor: `${cursor}x` }),
      context,
    );
    expect(tampered).toMatchObject({ statusCode: 409 });
    expect(errorCode(tampered)).toBe('STALE_CURSOR');
  });

  it('rejects cursors rebound to another immutable release', async () => {
    const api = createApiHandler(fixtureServices());
    const first = await api(event('/property.search', minimalInputs['property.search']), context);
    const cursor = String(parse(first).nextCursor);
    const stale = await api(
      event('/property.search', { releaseId: 'release-other', cursor }),
      context,
    );
    expect(errorCode(stale)).toBe('STALE_CURSOR');
  });

  it('enforces request, page, scan, and response budgets', async () => {
    const api = createApiHandler(fixtureServices());
    const oversizedRequest = await api(
      event(
        '/dataset.getInfo',
        {},
        { rawBody: JSON.stringify({ value: 'x'.repeat(API_LIMITS.requestBytes) }) },
      ),
      context,
    );
    expect(errorCode(oversizedRequest)).toBe('REQUEST_TOO_LARGE');

    const page = await api(
      event('/property.search', { releaseId: release.releaseId, limit: 101 }),
      context,
    );
    expect(errorCode(page)).toBe('INVALID_REQUEST');

    const scan = await createApiHandler(
      fixtureServices({ bytesScanned: API_LIMITS.maximumScanBytes + 1 }),
    )(event('/dataset.getCoverage', minimalInputs['dataset.getCoverage']), context);
    expect(errorCode(scan)).toBe('QUERY_BUDGET_EXCEEDED');

    const huge = await createApiHandler(
      fixtureServices({ data: { value: 'x'.repeat(API_LIMITS.responseBytes) } }),
    )(event('/dataset.getInfo'), context);
    expect(errorCode(huge)).toBe('RESPONSE_TOO_LARGE');
  });

  it('fails closed for stale release and corrupt release metadata', async () => {
    const stale = await createApiHandler(fixtureServices())(
      event('/dataset.getCoverage', { releaseId: 'release-stale' }),
      context,
    );
    expect(errorCode(stale)).toBe('RELEASE_MISMATCH');

    const corrupt = { ...release, verified: false } as unknown as ReleaseDescriptor;
    const corrupted = await createApiHandler(fixtureServices({ release: corrupt }))(
      event('/dataset.getInfo'),
      context,
    );
    expect(errorCode(corrupted)).toBe('DATA_CORRUPTION');
  });

  it('uses a literal CORS allowlist and never emits wildcard authority', async () => {
    const api = createApiHandler(fixtureServices());
    const allowed = await api(
      event('/dataset.getInfo', {}, { origin: 'https://oracle.test' }),
      context,
    );
    expect(allowed).toMatchObject({
      headers: { 'access-control-allow-origin': 'https://oracle.test' },
    });
    const denied = await api(
      event('/dataset.getInfo', {}, { origin: 'https://attacker.test' }),
      context,
    );
    expect(errorCode(denied)).toBe('ORIGIN_NOT_ALLOWED');
    expect(JSON.stringify(denied)).not.toContain('access-control-allow-origin":"*');
    expect(() => createApiHandler({ ...fixtureServices(), allowedOrigins: ['*'] })).toThrow(
      /Wildcard CORS/,
    );
  });

  it('returns stable redacted errors without stack, path, SQL, or input echo', async () => {
    const result = await createApiHandler(fixtureServices())(
      event('/property.search', {
        releaseId: release.releaseId,
        table: 'secret_table',
        path: 'C:\\secret',
        url: 'https://internal',
      }),
      context,
    );
    const serialized = JSON.stringify(result);
    expect(errorCode(result)).toBe('INVALID_REQUEST');
    expect(serialized).not.toContain('secret_table');
    expect(serialized).not.toContain('C:\\secret');
    expect(serialized).not.toContain('https://internal');
    expect(serialized).not.toContain('stack');
  });

  it('reports the no-fallback agent as degraded instead of returning canned success', async () => {
    const result = await createApiHandler(fixtureServices({ agent: 'unavailable' }))(
      event('/agent.ask', minimalInputs['agent.ask']),
      context,
    );
    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorCode(result)).toBe('AGENT_UNAVAILABLE');
  });

  it('prevents a test-only deterministic fixture from entering production composition', () => {
    expect(() => createApiHandler({ ...fixtureServices(), deployment: 'production' })).toThrow(
      /Test fixture/,
    );
  });

  it('keeps the default production handler fail-closed without the recovered executor', async () => {
    const result = await productionHandler(event('/dataset.getInfo'), context);
    expect(result).toMatchObject({ statusCode: 503 });
    expect(errorCode(result)).toBe('SERVICE_UNAVAILABLE');
  });
});
