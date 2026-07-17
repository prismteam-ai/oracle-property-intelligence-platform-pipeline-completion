import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { awsLambdaRequestHandler } from '@trpc/server/adapters/aws-lambda';

import type { ApiError, HealthResponse } from '@oracle/contracts';
import { createObservability } from '@oracle/observability';

import { appRouter } from './router.js';

const observability = createObservability('oracle-foundation-api');

const trpcHandler = awsLambdaRequestHandler({
  router: appRouter,
  createContext: () => ({ observability }),
  onError: ({ error, path }) => {
    observability.logger.warn('Foundation API request rejected', {
      code: error.code,
      operation: path ?? 'unknown',
    });
  },
});

function json(statusCode: number, body: HealthResponse | ApiError): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

export async function handler(
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyResultV2> {
  if (event.rawPath === '/health') {
    observability.logger.info('Foundation API health check');
    return json(200, { service: 'api', status: 'ok', foundationOnly: true });
  }

  const operation = event.rawPath.replace(/^\/(?:trpc\/)?/, '');
  if (operation !== 'foundation.status') {
    return json(404, {
      error: {
        code: 'UNKNOWN_OPERATION',
        message: 'Only foundation.status is available in the foundation scaffold.',
        operation: operation.length > 0 ? operation : 'unknown',
      },
    });
  }

  return trpcHandler(event, context);
}
