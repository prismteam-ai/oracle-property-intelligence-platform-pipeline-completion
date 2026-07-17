import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import { apiErrorSchema, healthResponseSchema } from '@oracle/contracts';

import { handler } from './handler.js';
import { appRouter } from './router.js';

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
        method: 'GET',
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

const context = {} as Context;

function parseJson(value: string | undefined): unknown {
  return JSON.parse(value ?? '{}') as unknown;
}

function responseBody(response: APIGatewayProxyResultV2): string | undefined {
  return typeof response === 'string' ? undefined : response.body;
}

describe('foundation API', () => {
  it('returns typed health', async () => {
    const response = await handler(event('/health'), context);
    expect(response).toMatchObject({ statusCode: 200 });
    expect(healthResponseSchema.parse(parseJson(responseBody(response)))).toEqual({
      service: 'api',
      status: 'ok',
      foundationOnly: true,
    });
  });

  it('provides the named foundation.status operation', async () => {
    const result = await appRouter.createCaller({}).foundation.status();
    expect(result).toMatchObject({ operation: 'foundation.status', state: 'foundation_only' });
  });

  it('serves foundation.status through the Lambda adapter', async () => {
    const response = await handler(event('/foundation.status'), context);
    expect(response).toMatchObject({ statusCode: 200 });
    expect(parseJson(responseBody(response))).toMatchObject({
      result: {
        data: {
          operation: 'foundation.status',
          state: 'foundation_only',
        },
      },
    });
  });

  it('rejects unknown operations with the typed error contract', async () => {
    const response = await handler(event('/properties.search'), context);
    expect(response).toMatchObject({ statusCode: 404 });
    expect(apiErrorSchema.parse(parseJson(responseBody(response)))).toEqual({
      error: {
        code: 'UNKNOWN_OPERATION',
        message: 'Only foundation.status is available in the foundation scaffold.',
        operation: 'properties.search',
      },
    });
  });
});
