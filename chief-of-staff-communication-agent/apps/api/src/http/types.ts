export interface HttpRequest {
  method: string;
  path: string;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  body?: string;
  baseUrl: string;
}

export interface HttpResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export function jsonResponse(
  status: number,
  data: unknown,
  extraHeaders?: Record<string, string>,
): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(data),
  };
}

export function redirectResponse(location: string, extraHeaders?: Record<string, string>): HttpResponse {
  return {
    status: 302,
    headers: { Location: location, ...extraHeaders },
  };
}

export function textResponse(
  status: number,
  body: string,
  contentType = "text/plain",
  extraHeaders?: Record<string, string>,
): HttpResponse {
  return {
    status,
    headers: { "content-type": contentType, ...extraHeaders },
    body,
  };
}

export function normalizeHeaders(
  headers: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}
