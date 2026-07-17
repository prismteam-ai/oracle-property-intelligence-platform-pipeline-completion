import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

import { createProductionMcpHandler } from './composition.js';

let defaultHandler: Promise<
  (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>
> | null = null;

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  defaultHandler ??= createProductionMcpHandler(process.env);
  return await (
    await defaultHandler
  )(event);
}

export { createLambdaMcpHandler } from './transport.js';
export { createProductionMcpHandler } from './composition.js';
export type { NamedEvidenceRequest, NamedEvidenceService } from './service.js';
