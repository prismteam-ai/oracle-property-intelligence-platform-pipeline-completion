import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES } from './schemas.js';
import { createNamedEvidenceMcpServer } from './server.js';
import type { NamedEvidenceService } from './service.js';

type LambdaHandler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;

type JsonRpcErrorCode = -32_000 | -32_600 | -32_700;

function jsonRpcError(
  statusCode: number,
  code: JsonRpcErrorCode,
  message: string,
  headers: Readonly<Record<string, string>> = {},
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }),
  };
}

function health(): APIGatewayProxyResultV2 {
  return {
    statusCode: 200,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
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
    }),
  };
}

function decodeBody(event: APIGatewayProxyEventV2): Uint8Array {
  if (event.body === undefined) return new Uint8Array();
  return event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : Buffer.from(event.body, 'utf8');
}

function eventHeaders(event: APIGatewayProxyEventV2): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers)) {
    if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

function requestMethod(event: APIGatewayProxyEventV2): string {
  return event.requestContext.http.method.toUpperCase();
}

function createRequest(event: APIGatewayProxyEventV2, body: Uint8Array): Request {
  const method = requestMethod(event);
  return new Request(`https://oracle.invalid${event.rawPath}`, {
    method,
    headers: eventHeaders(event),
    ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
  });
}

async function toLambdaResponse(response: Response): Promise<APIGatewayProxyResultV2> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    return jsonRpcError(500, -32_000, 'The MCP response exceeded the configured size limit.');
  }
  const headers: Record<string, string> = { 'cache-control': 'no-store' };
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() !== 'set-cookie') headers[name] = value;
  });
  return {
    statusCode: response.status,
    headers,
    body: new TextDecoder().decode(bytes),
  };
}

export function createLambdaMcpHandler(service: NamedEvidenceService): LambdaHandler {
  return async (event) => {
    if (event.rawPath === '/health' || event.rawPath === '/mcp/health') {
      if (requestMethod(event) !== 'GET') {
        return jsonRpcError(405, -32_000, 'Method not allowed.', { allow: 'GET' });
      }
      return health();
    }
    if (event.rawPath !== '/mcp') {
      return jsonRpcError(404, -32_000, 'MCP endpoint not found.');
    }
    if (event.rawQueryString.length > 0) {
      return jsonRpcError(400, -32_600, 'Query-string authority is not accepted by this MCP.');
    }
    const method = requestMethod(event);
    if (method !== 'POST') {
      return jsonRpcError(405, -32_000, 'Method not allowed.', { allow: 'POST' });
    }
    const body = decodeBody(event);
    if (body.byteLength > MAX_REQUEST_BYTES) {
      return jsonRpcError(413, -32_600, 'The MCP request exceeded the 16 KiB limit.');
    }

    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = createNamedEvidenceMcpServer(service);
    await server.connect(transport);
    try {
      return await toLambdaResponse(await transport.handleRequest(createRequest(event, body)));
    } catch {
      return jsonRpcError(400, -32_700, 'The MCP request could not be processed.');
    } finally {
      await server.close();
    }
  };
}
