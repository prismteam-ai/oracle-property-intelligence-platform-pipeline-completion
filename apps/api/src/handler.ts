import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';

import { createObservability } from '@oracle/observability';

import {
  API_LIMITS,
  InputContractError,
  isApplicationOperation,
  parseApplicationRequest,
  type ApplicationOperation,
} from './contract.js';
import { ApiFailure, publicMessage, statusFor } from './errors.js';
import {
  loadProductionRuntimeServices,
  productionConfigurationState,
  unconfiguredProductionServices,
  type ProductionCompositionDependencies,
} from './production.js';
import { executeOperation } from './router.js';
import type { ApiErrorCode, ApiErrorEnvelope, RuntimeServices } from './runtime.js';

const observability = createObservability('oracle-application-api');

function originHeaders(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): Readonly<Record<string, string>> {
  if (origin === undefined) return {};
  if (!allowedOrigins.includes(origin)) throw new ApiFailure('ORIGIN_NOT_ALLOWED');
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,x-request-id',
    'access-control-max-age': '600',
    vary: 'origin',
  };
}

function response(
  statusCode: number,
  value: unknown,
  headers: Readonly<Record<string, string>>,
): APIGatewayProxyResultV2 {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body, 'utf8') > API_LIMITS.responseBytes)
    throw new ApiFailure('RESPONSE_TOO_LARGE');
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
    body,
  };
}

function requestBody(event: APIGatewayProxyEventV2): unknown {
  const encoded = event.body ?? '';
  const bytes = event.isBase64Encoded
    ? Buffer.from(encoded, 'base64')
    : Buffer.from(encoded, 'utf8');
  if (bytes.byteLength > API_LIMITS.requestBytes) throw new ApiFailure('REQUEST_TOO_LARGE');
  if (bytes.byteLength === 0) return {};
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new ApiFailure('INVALID_REQUEST');
  }
}

function operationFromPath(rawPath: string): string {
  return rawPath.replace(/^\/+/, '').replace(/^trpc\//, '');
}

function errorResponse(
  code: ApiErrorCode,
  operation: ApplicationOperation | 'unknown',
  requestId: string,
  headers: Readonly<Record<string, string>>,
): APIGatewayProxyResultV2 {
  const body: ApiErrorEnvelope = {
    error: {
      code,
      message: publicMessage(code),
      operation,
      requestId,
      retryable: ['QUERY_BUDGET_EXCEEDED', 'AGENT_UNAVAILABLE', 'SERVICE_UNAVAILABLE'].includes(
        code,
      ),
    },
  };
  return response(statusFor(code), body, headers);
}

export function createApiHandler(services: RuntimeServices) {
  if (services.deployment === 'production' && services.fixtureLabel !== undefined) {
    throw new Error('Test fixture services cannot be composed in production.');
  }
  if (services.allowedOrigins.includes('*')) {
    throw new Error('Wildcard CORS origins are prohibited.');
  }
  return async (
    event: APIGatewayProxyEventV2,
    context: Context,
  ): Promise<APIGatewayProxyResultV2> => {
    void context;
    const requestId = event.requestContext.requestId || 'unavailable';
    const operationName = operationFromPath(event.rawPath);
    const operation = isApplicationOperation(operationName) ? operationName : 'unknown';
    let cors: Readonly<Record<string, string>> = {};
    try {
      cors = originHeaders(event.headers.origin ?? event.headers.Origin, services.allowedOrigins);
      if (event.requestContext.http.method === 'OPTIONS') return response(204, {}, cors);
      if (event.rawPath === '/health') {
        return response(
          200,
          {
            service: 'api',
            status: services.readiness === 'ready' ? 'ready' : 'degraded',
            readiness: services.readiness,
            dataQueryPerformed: false,
            productionReleaseRequired: true,
            fixture: services.fixtureLabel ?? null,
          },
          cors,
        );
      }
      if (services.deployment === 'production' && services.readiness !== 'ready') {
        throw new ApiFailure('SERVICE_UNAVAILABLE');
      }
      if (operation === 'unknown') throw new ApiFailure('UNKNOWN_OPERATION');
      if (event.requestContext.http.method !== 'POST') throw new ApiFailure('METHOD_NOT_ALLOWED');
      const contentType = event.headers['content-type'] ?? event.headers['Content-Type'];
      if (!contentType?.toLowerCase().startsWith('application/json'))
        throw new ApiFailure('INVALID_REQUEST');
      let parsed;
      try {
        parsed = parseApplicationRequest(operation, requestBody(event));
      } catch (error) {
        if (error instanceof InputContractError) throw new ApiFailure('INVALID_REQUEST');
        throw error;
      }
      const result = await executeOperation(services, operation, parsed);
      return response(200, result, cors);
    } catch (error) {
      const failure = error instanceof ApiFailure ? error : new ApiFailure('INTERNAL_ERROR');
      observability.logger.warn('Application API request rejected', {
        code: failure.code,
        operation,
        requestId,
      });
      return errorResponse(failure.code, operation, requestId, cors);
    }
  };
}

export function createProductionApiHandler(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: ProductionCompositionDependencies = {},
) {
  let servicesPromise: Promise<RuntimeServices> | undefined;
  const services = async (): Promise<RuntimeServices> => {
    const configurationState = productionConfigurationState(environment);
    servicesPromise ??=
      configurationState === 'absent'
        ? Promise.resolve(unconfiguredProductionServices(environment))
        : configurationState === 'partial'
          ? Promise.resolve(unconfiguredProductionServices(environment, 'configuration_error'))
          : loadProductionRuntimeServices(environment, dependencies).catch(() =>
              unconfiguredProductionServices(environment, 'configuration_error'),
            );
    return await servicesPromise;
  };
  return async (
    event: APIGatewayProxyEventV2,
    context: Context,
  ): Promise<APIGatewayProxyResultV2> => {
    const configured = await services();
    return await createApiHandler(configured)(event, context);
  };
}

// Production composition is attempted once per warm Lambda. Missing or invalid
// server-owned release configuration remains query-free and fails closed; no
// environment switch can select a fixture or deterministic test service.
export const handler = createProductionApiHandler(process.env);
