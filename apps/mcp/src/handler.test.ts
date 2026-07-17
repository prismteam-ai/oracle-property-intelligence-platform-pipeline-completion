import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { handler } from './handler.js';
import {
  namedEvidenceToolNames,
  type EvidenceEnvelope,
  type NamedEvidenceToolName,
} from './schemas.js';
import type { NamedEvidenceRequest, NamedEvidenceService } from './service.js';
import { createLambdaMcpHandler } from './transport.js';

const protocolVersion = '2025-11-25';
const mcpHeaders = {
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json',
  'mcp-protocol-version': protocolVersion,
};

function event(
  rawPath: string,
  options: Readonly<{
    method?: string;
    headers?: Readonly<Record<string, string>>;
    body?: string;
    isBase64Encoded?: boolean;
    rawQueryString?: string;
  }> = {},
): APIGatewayProxyEventV2 {
  const method = options.method ?? 'POST';
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath,
    rawQueryString: options.rawQueryString ?? '',
    headers: { ...(options.headers ?? {}) },
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
      requestId: 'request-test',
      routeKey: '$default',
      stage: '$default',
      time: '17/Jul/2026:00:00:00 +0000',
      timeEpoch: 1,
    },
    isBase64Encoded: options.isBase64Encoded ?? false,
    ...(options.body === undefined ? {} : { body: options.body }),
  };
}

function body(response: APIGatewayProxyResultV2): Record<string, unknown> {
  if (typeof response === 'string') throw new TypeError('Unexpected string Lambda response');
  return JSON.parse(response.body ?? '{}') as Record<string, unknown>;
}

function request(method: string, params: Readonly<Record<string, unknown>>, id = 1): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

function initializeRequest(version = protocolVersion): string {
  return request('initialize', {
    protocolVersion: version,
    capabilities: {},
    clientInfo: { name: 'oracle-mcp-test', version: '1.0.0' },
  });
}

function envelope(overrides: Partial<EvidenceEnvelope> = {}): EvidenceEnvelope {
  return {
    schemaVersion: '1.0.0',
    releaseId: 'release-2026-07-17',
    runId: 'run-2026-07-17',
    manifestCid: 'bafybeioracletestmanifest',
    asOf: '2026-07-17T00:00:00.000Z',
    coverage: {},
    limitations: [],
    data: { records: [] },
    nextCursor: null,
    truncated: false,
    timing: { elapsedMs: 1, bytesScanned: 0 },
    ...overrides,
  };
}

class FixtureService implements NamedEvidenceService {
  public readonly calls: NamedEvidenceRequest[] = [];
  public result: EvidenceEnvelope = envelope();
  public cursorIsValid = true;

  public execute(requestValue: NamedEvidenceRequest): Promise<unknown> {
    this.calls.push(requestValue);
    return Promise.resolve(this.result);
  }

  public validateCursor(): void {
    if (!this.cursorIsValid) throw new TypeError('fixture cursor rejection');
  }
}

function callTool(name: NamedEvidenceToolName, input: Readonly<Record<string, unknown>>): string {
  return request('tools/call', { name, arguments: input });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

const minimumInput: Readonly<Record<NamedEvidenceToolName, Readonly<Record<string, unknown>>>> = {
  get_dataset_info: {},
  get_dataset_coverage: { releaseId: 'release-2026-07-17' },
  list_pipeline_runs: { releaseId: 'release-2026-07-17' },
  get_pipeline_run: { releaseId: 'release-2026-07-17', runId: 'run-2026-07-17' },
  search_properties: { releaseId: 'release-2026-07-17' },
  get_property: { releaseId: 'release-2026-07-17', propertyId: 'property-1' },
  get_property_evidence: { releaseId: 'release-2026-07-17', propertyId: 'property-1' },
  find_roof_age_candidates: { releaseId: 'release-2026-07-17' },
  find_water_view_candidates: { releaseId: 'release-2026-07-17' },
  find_ownership_age_candidates: { releaseId: 'release-2026-07-17' },
  find_regional_owner_properties: { releaseId: 'release-2026-07-17' },
  find_transit_walkable_properties: { releaseId: 'release-2026-07-17' },
  find_starbucks_walkable_properties: { releaseId: 'release-2026-07-17' },
  rank_review_candidates: {
    releaseId: 'release-2026-07-17',
    criteria: ['roof_age'],
  },
  list_artifacts: { releaseId: 'release-2026-07-17' },
  get_data_dictionary: { releaseId: 'release-2026-07-17' },
};

describe('Streamable HTTP lifecycle and Lambda integration', () => {
  it('serves a cheap, data-query-free health response', async () => {
    const service = new FixtureService();
    const response = await createLambdaMcpHandler(service)(event('/mcp/health', { method: 'GET' }));

    expect(response).toMatchObject({ statusCode: 200 });
    expect(body(response)).toEqual({
      service: 'oracle-named-evidence-mcp',
      status: 'ok',
      dataQueriesExecuted: 0,
      transport: 'streamable-http',
      releaseBinding: 'immutable',
      elephantCompatibility: {
        state: 'blocked',
        callerSqlExposed: false,
        surface: 'separate-and-uncertified',
      },
    });
    expect(service.calls).toHaveLength(0);
  });

  it('negotiates initialize through the official SDK', async () => {
    const response = await createLambdaMcpHandler(new FixtureService())(
      event('/mcp', { headers: mcpHeaders, body: initializeRequest() }),
    );

    expect(response).toMatchObject({ statusCode: 200 });
    expect(response).not.toHaveProperty('cookies');
    expect(body(response)).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion,
        serverInfo: { name: 'oracle-named-evidence', version: '1.0.0' },
        capabilities: { tools: { listChanged: true } },
      },
    });
  });

  it('accepts API Gateway base64 request bodies', async () => {
    const response = await createLambdaMcpHandler(new FixtureService())(
      event('/mcp', {
        headers: mcpHeaders,
        body: Buffer.from(initializeRequest(), 'utf8').toString('base64'),
        isBase64Encoded: true,
      }),
    );
    expect(response).toMatchObject({ statusCode: 200 });
    expect(body(response)).toMatchObject({ result: { protocolVersion } });
  });

  it('enforces protocol, media type, Accept, path, method, and query-string rules', async () => {
    const mcp = createLambdaMcpHandler(new FixtureService());
    const cases = [
      [
        event('/mcp', {
          headers: { 'content-type': 'application/json' },
          body: initializeRequest(),
        }),
        406,
      ],
      [
        event('/mcp', {
          headers: { accept: mcpHeaders.accept, 'content-type': 'text/plain' },
          body: initializeRequest(),
        }),
        415,
      ],
      [event('/mcp', { method: 'GET', headers: { accept: 'text/event-stream' } }), 405],
      [event('/not-mcp', { headers: mcpHeaders, body: initializeRequest() }), 404],
      [
        event('/mcp', {
          headers: mcpHeaders,
          body: initializeRequest(),
          rawQueryString: 'token=forbidden',
        }),
        400,
      ],
      [event('/mcp', { headers: mcpHeaders, body: '{' }), 400],
      [
        event('/mcp', {
          headers: { ...mcpHeaders, 'mcp-protocol-version': '1900-01-01' },
          body: request('tools/list', {}),
        }),
        400,
      ],
    ] as const;

    for (const [input, expectedStatus] of cases) {
      expect(await mcp(input)).toMatchObject({ statusCode: expectedStatus });
    }
  });

  it('rejects oversized requests before creating a service call', async () => {
    const service = new FixtureService();
    const response = await createLambdaMcpHandler(service)(
      event('/mcp', { headers: mcpHeaders, body: 'x'.repeat(16 * 1024 + 1) }),
    );
    expect(response).toMatchObject({ statusCode: 413 });
    expect(service.calls).toHaveLength(0);
  });

  it('exports a production handler that discovers tools but fails execution closed', async () => {
    const response = await handler(
      event('/mcp', {
        headers: mcpHeaders,
        body: callTool('get_dataset_info', {}),
      }),
    );
    expect(body(response)).toMatchObject({
      result: {
        isError: true,
        content: [
          {
            type: 'text',
            text: expect.stringContaining('SERVICE_UNAVAILABLE'),
          },
        ],
      },
    });
  });
});

describe('named evidence tool boundary', () => {
  it('lists exactly the frozen SQL-free tools with strict schemas and compatibility labeling', async () => {
    const response = await createLambdaMcpHandler(new FixtureService())(
      event('/mcp', { headers: mcpHeaders, body: request('tools/list', {}) }),
    );
    const responseBody = body(response) as {
      result: {
        tools: {
          name: string;
          inputSchema: Record<string, unknown>;
          outputSchema: Record<string, unknown>;
          _meta: Record<string, unknown>;
        }[];
      };
    };
    const tools = responseBody.result.tools;

    expect(tools.map(({ name }) => name)).toEqual(namedEvidenceToolNames);
    expect(tools.map(({ name }) => name)).not.toContain('queryProperties');
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(tool.outputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(tool._meta).toMatchObject({
        'oracle/surface': 'named-evidence',
        'oracle/sqlAuthority': 'absent',
        'oracle/elephantCompatibility': 'blocked-uncertified-separate-surface',
      });
    }
  });

  it('locks the complete inspector-visible tool schema against unreviewed drift', async () => {
    const response = await createLambdaMcpHandler(new FixtureService())(
      event('/mcp', { headers: mcpHeaders, body: request('tools/list', {}) }),
    );
    const tools = (body(response) as { result: { tools: unknown[] } }).result.tools;
    const digest = createHash('sha256').update(stableJson(tools)).digest('hex');
    expect(digest).toBe('3b42e564ed04557824afd7ae6721f738ef2e00c7473ad544bcf015d5aadc9ac2');
  });

  it('rejects additional properties for every frozen operation before execution', async () => {
    const service = new FixtureService();
    const mcp = createLambdaMcpHandler(service);
    for (const name of namedEvidenceToolNames) {
      const response = await mcp(
        event('/mcp', {
          headers: mcpHeaders,
          body: callTool(name, { ...minimumInput[name], sql: 'select * from properties' }),
        }),
      );
      expect(body(response)).toMatchObject({
        result: {
          isError: true,
          content: [{ text: expect.stringContaining('MCP error -32602') }],
        },
      });
    }
    expect(service.calls).toHaveLength(0);
  });

  it('exposes no caller SQL, relation, expression, path, object, URL, or host authority', async () => {
    const service = new FixtureService();
    const mcp = createLambdaMcpHandler(service);
    for (const forbidden of ['sql', 'table', 'expression', 'path', 'objectKey', 'url', 'host']) {
      const response = await mcp(
        event('/mcp', {
          headers: mcpHeaders,
          body: callTool('get_dataset_coverage', {
            releaseId: 'release-2026-07-17',
            [forbidden]: 'caller-controlled-authority',
          }),
        }),
      );
      expect(body(response)).toMatchObject({ result: { isError: true } });
    }
    expect(service.calls).toHaveLength(0);
  });

  it('does not expose authenticated or restricted artifacts on the public MCP', async () => {
    const service = new FixtureService();
    const response = await createLambdaMcpHandler(service)(
      event('/mcp', {
        headers: mcpHeaders,
        body: callTool('list_artifacts', {
          releaseId: 'release-2026-07-17',
          publicationClass: 'restricted',
        }),
      }),
    );
    expect(body(response)).toMatchObject({ result: { isError: true } });
    expect(service.calls).toHaveLength(0);
  });

  it('passes every parsed named operation to the injected service without semantic mutation', async () => {
    const service = new FixtureService();
    const mcp = createLambdaMcpHandler(service);
    for (const name of namedEvidenceToolNames) {
      service.result = envelope();
      const response = await mcp(
        event('/mcp', { headers: mcpHeaders, body: callTool(name, minimumInput[name]) }),
      );
      expect(body(response)).toMatchObject({ result: { structuredContent: envelope() } });
    }
    expect(service.calls.map(({ tool }) => tool)).toEqual(namedEvidenceToolNames);
  });

  it('preserves support, unknown, evidence, coverage, and limitation data verbatim', async () => {
    const service = new FixtureService();
    const evidenceData = {
      results: [
        {
          propertyId: 'property-1',
          supportState: 'unknown',
          evidenceIds: [],
          limitations: ['Ownership history is blocked at the approved source boundary.'],
        },
      ],
    };
    service.result = envelope({
      data: evidenceData,
      coverage: { ownership: { state: 'blocked', numerator: 0, denominator: 487_319 } },
      limitations: ['Unknown records are not positive matches.'],
    });
    const response = await createLambdaMcpHandler(service)(
      event('/mcp', {
        headers: mcpHeaders,
        body: callTool('find_ownership_age_candidates', {
          releaseId: 'release-2026-07-17',
        }),
      }),
    );
    expect(body(response)).toMatchObject({
      result: {
        structuredContent: {
          data: evidenceData,
          coverage: { ownership: { state: 'blocked', numerator: 0, denominator: 487_319 } },
          limitations: ['Unknown records are not positive matches.'],
        },
      },
    });
  });

  it('fails closed on immutable-release drift', async () => {
    const service = new FixtureService();
    service.result = envelope({ releaseId: 'another-release' });
    const response = await createLambdaMcpHandler(service)(
      event('/mcp', {
        headers: mcpHeaders,
        body: callTool('get_dataset_coverage', { releaseId: 'release-2026-07-17' }),
      }),
    );
    expect(body(response)).toMatchObject({
      result: { isError: true, content: [{ text: expect.stringContaining('RELEASE_MISMATCH') }] },
    });
  });

  it('rejects tampered cursors before query execution', async () => {
    const service = new FixtureService();
    service.cursorIsValid = false;
    const response = await createLambdaMcpHandler(service)(
      event('/mcp', {
        headers: mcpHeaders,
        body: callTool('search_properties', {
          releaseId: 'release-2026-07-17',
          cursor: 'tampered.cursor',
        }),
      }),
    );
    expect(body(response)).toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringContaining('STALE_OR_TAMPERED_CURSOR') }],
      },
    });
    expect(service.calls).toHaveLength(0);
  });

  it('rejects invalid page sizes and UTF-8 cursors beyond 512 bytes', async () => {
    const service = new FixtureService();
    const mcp = createLambdaMcpHandler(service);
    for (const invalid of [
      { releaseId: 'release-2026-07-17', pageSize: 101 },
      { releaseId: 'release-2026-07-17', cursor: 'é'.repeat(257) },
    ]) {
      const response = await mcp(
        event('/mcp', { headers: mcpHeaders, body: callTool('search_properties', invalid) }),
      );
      expect(body(response)).toMatchObject({
        result: {
          isError: true,
          content: [{ text: expect.stringContaining('MCP error -32602') }],
        },
      });
    }
    expect(service.calls).toHaveLength(0);
  });

  it('converts oversized service results to a bounded typed tool error', async () => {
    const service = new FixtureService();
    service.result = envelope({ data: { oversized: 'x'.repeat(910 * 1024) } });
    const response = await createLambdaMcpHandler(service)(
      event('/mcp', { headers: mcpHeaders, body: callTool('get_dataset_info', {}) }),
    );
    expect(response).toMatchObject({ statusCode: 200 });
    expect(body(response)).toMatchObject({
      result: { isError: true, content: [{ text: expect.stringContaining('RESULT_TOO_LARGE') }] },
    });
    expect(Buffer.byteLength(JSON.stringify(body(response)), 'utf8')).toBeLessThan(1024 * 1024);
  });

  it('rejects a returned continuation cursor when its integrity binding fails', async () => {
    const service = new FixtureService();
    service.result = envelope({ nextCursor: 'returned.invalid', truncated: true });
    service.cursorIsValid = false;
    const response = await createLambdaMcpHandler(service)(
      event('/mcp', { headers: mcpHeaders, body: callTool('get_dataset_info', {}) }),
    );
    expect(body(response)).toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringContaining('STALE_OR_TAMPERED_CURSOR') }],
      },
    });
  });

  it('fails closed when a service result drifts from the output schema', async () => {
    const service: NamedEvidenceService = {
      execute: vi.fn().mockResolvedValue({ releaseId: 'release-2026-07-17', data: [] }),
    };
    const response = await createLambdaMcpHandler(service)(
      event('/mcp', { headers: mcpHeaders, body: callTool('get_dataset_info', {}) }),
    );
    const encoded = JSON.stringify(body(response));
    expect(encoded).toContain('INTERNAL_ERROR');
    expect(encoded).not.toContain('expected object');
  });

  it('redacts unexpected dependency errors', async () => {
    const service: NamedEvidenceService = {
      execute: vi.fn().mockRejectedValue(new Error('C:\\secret\\artifact.duckdb SQL SELECT token')),
    };
    const response = await createLambdaMcpHandler(service)(
      event('/mcp', { headers: mcpHeaders, body: callTool('get_dataset_info', {}) }),
    );
    const encoded = JSON.stringify(body(response));
    expect(encoded).toContain('INTERNAL_ERROR');
    expect(encoded).not.toContain('artifact.duckdb');
    expect(encoded).not.toContain('SELECT');
  });
});
