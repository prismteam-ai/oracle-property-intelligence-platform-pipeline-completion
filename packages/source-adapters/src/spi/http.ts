export type HttpMethod = 'GET' | 'HEAD' | 'POST';

/** Header values must already be safe to persist in artifact metadata. */
export type HttpHeaders = Readonly<Record<string, string>>;

export interface HttpRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: HttpHeaders;
  readonly body?: Uint8Array;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: HttpHeaders;
  readonly body: AsyncIterable<Uint8Array>;
}

/** The only transport authority available to discovery/acquisition phases. */
export interface HttpTransport {
  send(request: HttpRequest, signal: AbortSignal): Promise<HttpResponse>;
}
