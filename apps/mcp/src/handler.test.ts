import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import { healthResponseSchema, mcpFoundationErrorSchema } from '@oracle/contracts';

import { handler } from './handler.js';

function parseJson(value: string | undefined): unknown {
  return JSON.parse(value ?? '{}') as unknown;
}

function responseBody(response: APIGatewayProxyResultV2): string | undefined {
  return typeof response === 'string' ? undefined : response.body;
}

function event(rawPath: string): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath,
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: 'test',
      apiId: 'test',
      domainName: 'test',
      domainPrefix: 'test',
      http: {
        method: 'POST',
        path: rawPath,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'test',
      routeKey: '$default',
      stage: '$default',
      time: '17/Jul/2026:00:00:00 +0000',
      timeEpoch: 1,
    },
    isBase64Encoded: false,
  };
}

describe('foundation-only MCP surface', () => {
  it('immediately returns a promise that resolves to typed health', async () => {
    const responsePromise = handler(event('/mcp/health'));

    expect(responsePromise).toBeInstanceOf(Promise);

    const response = await responsePromise;
    expect(response).toMatchObject({ statusCode: 200 });
    expect(healthResponseSchema.parse(parseJson(responseBody(response)))).toEqual({
      service: 'mcp',
      status: 'ok',
      foundationOnly: true,
    });
  });

  it('truthfully rejects every non-health request', async () => {
    for (const path of ['/mcp', '/mcp/tools/list', '/anything']) {
      const response = await handler(event(path));
      expect(response).toMatchObject({ statusCode: 501 });
      expect(mcpFoundationErrorSchema.parse(parseJson(responseBody(response)))).toEqual({
        error: {
          code: 'MCP_FOUNDATION_ONLY',
          message: 'The MCP protocol and property tools are not implemented in ORA-010.',
        },
      });
    }
  });
});
