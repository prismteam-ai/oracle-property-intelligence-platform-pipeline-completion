import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpRequest, HttpResponse } from "./types.js";
import { normalizeHeaders } from "./types.js";

export async function readNodeBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function nodeRequestFromIncoming(req: IncomingMessage, baseUrl: string): HttpRequest {
  const url = new URL(req.url ?? "/", baseUrl);
  const query: Record<string, string | undefined> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return {
    method: req.method ?? "GET",
    path: url.pathname,
    query,
    headers,
    baseUrl,
  };
}

export async function writeNodeResponse(res: ServerResponse, response: HttpResponse): Promise<void> {
  res.writeHead(response.status, response.headers ?? {});
  res.end(response.body ?? "");
}

export function mergeBody(req: HttpRequest, body: string): HttpRequest {
  return { ...req, body };
}
