import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from "aws-lambda";
import { migrate } from "@indeedee/db";
import { handleHttpRequest } from "../http/app.js";
import { normalizeHeaders } from "../http/types.js";

let migrated = false;

async function ensureMigrated() {
  if (!migrated) {
    await migrate();
    migrated = true;
  }
}

function toHttpRequest(event: APIGatewayProxyEventV2) {
  const domain = event.requestContext.domainName;
  const stage = event.requestContext.stage;
  const basePath = stage && stage !== "$default" ? `/${stage}` : "";
  const baseUrl = process.env.API_BASE_URL ?? `https://${domain}${basePath}`;
  return {
    method: event.requestContext.http.method,
    path: event.rawPath,
    query: event.queryStringParameters ?? {},
    headers: normalizeHeaders(event.headers ?? {}),
    body:
      event.body ?
        event.isBase64Encoded ?
          Buffer.from(event.body, "base64").toString("utf8")
        : event.body
      : undefined,
    baseUrl,
  };
}

function toApiGatewayResponse(response: Awaited<ReturnType<typeof handleHttpRequest>>): APIGatewayProxyResultV2 {
  return {
    statusCode: response.status,
    headers: response.headers,
    body: response.body,
  };
}

export async function handler(
  event: APIGatewayProxyEventV2,
  _context: Context,
): Promise<APIGatewayProxyResultV2> {
  await ensureMigrated();
  const response = await handleHttpRequest(toHttpRequest(event), { serveWeb: false });
  return toApiGatewayResponse(response);
}
