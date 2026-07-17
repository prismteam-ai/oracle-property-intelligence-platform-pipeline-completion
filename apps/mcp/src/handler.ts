import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

import type { HealthResponse, McpFoundationError } from '@oracle/contracts';
import { createObservability } from '@oracle/observability';

const observability = createObservability('oracle-foundation-mcp');

function json(
  statusCode: number,
  body: HealthResponse | McpFoundationError,
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

export function handler(event: APIGatewayProxyEventV2): APIGatewayProxyResultV2 {
  if (event.rawPath === '/mcp/health' || event.rawPath === '/health') {
    observability.logger.info('Foundation MCP health check');
    return json(200, { service: 'mcp', status: 'ok', foundationOnly: true });
  }

  observability.logger.warn('MCP request rejected because only the foundation exists', {
    method: event.requestContext.http.method,
  });
  return json(501, {
    error: {
      code: 'MCP_FOUNDATION_ONLY',
      message: 'The MCP protocol and property tools are not implemented in ORA-010.',
    },
  });
}
