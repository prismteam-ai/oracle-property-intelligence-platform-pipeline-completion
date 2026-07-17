import { createHash } from 'node:crypto';

export interface TestClock {
  now(): string;
}

export class DeterministicClock implements TestClock {
  readonly #instants: readonly string[];
  #index = 0;

  public constructor(instants: readonly string[]) {
    if (instants.length === 0) {
      throw new TypeError('DeterministicClock requires at least one instant');
    }
    this.#instants = Object.freeze([...instants]);
  }

  public now(): string {
    const instant = this.#instants[Math.min(this.#index, this.#instants.length - 1)];
    this.#index += 1;
    if (instant === undefined) {
      throw new Error('DeterministicClock invariant violated');
    }
    return instant;
  }
}

export interface ScriptedHttpRequest {
  readonly method: 'GET' | 'HEAD' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

/** Constructor input for a deterministic transport response. */
export interface ScriptedHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly chunks: readonly Uint8Array[];
}

export interface ScriptedHttpResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: AsyncIterable<Uint8Array>;
}

function cloneHttpRequest(request: ScriptedHttpRequest): ScriptedHttpRequest {
  const common = {
    method: request.method,
    url: request.url,
    headers: Object.freeze({ ...request.headers }),
  } as const;
  return request.body === undefined
    ? Object.freeze(common)
    : Object.freeze({ ...common, body: Uint8Array.from(request.body) });
}

function cloneScriptedResponse(response: ScriptedHttpResponse): ScriptedHttpResponse {
  return Object.freeze({
    status: response.status,
    headers: Object.freeze({ ...response.headers }),
    chunks: Object.freeze(response.chunks.map((chunk) => Uint8Array.from(chunk))),
  });
}

async function* streamHttpBody(
  chunks: readonly Uint8Array[],
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) {
    signal.throwIfAborted();
    await Promise.resolve();
    signal.throwIfAborted();
    yield Uint8Array.from(chunk);
  }
}

export class ScriptedHttpTransport {
  readonly #responses: ScriptedHttpResponse[];
  readonly #requests: ScriptedHttpRequest[] = [];

  public constructor(responses: readonly ScriptedHttpResponse[]) {
    this.#responses = responses.map((response) => cloneScriptedResponse(response));
  }

  public get requests(): readonly ScriptedHttpRequest[] {
    return Object.freeze(this.#requests.map((request) => cloneHttpRequest(request)));
  }

  public async send(
    request: ScriptedHttpRequest,
    signal: AbortSignal,
  ): Promise<ScriptedHttpResult> {
    signal.throwIfAborted();
    this.#requests.push(cloneHttpRequest(request));
    const response = this.#responses.shift();
    if (response === undefined) {
      throw new Error(`No scripted response for ${request.method} ${request.url}`);
    }
    return Promise.resolve(
      Object.freeze({
        status: response.status,
        headers: Object.freeze({ ...response.headers }),
        body: streamHttpBody(response.chunks, signal),
      }),
    );
  }
}

type ArtifactBody = Uint8Array | AsyncIterable<Uint8Array>;

interface ArtifactWrite {
  readonly logicalKey: string;
  readonly mediaType: string;
  readonly body: ArtifactBody;
  readonly expectedSha256: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly ifAbsent: true;
}

interface StoredArtifact {
  readonly logicalKey: string;
  readonly uri: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly storedAt: string;
  readonly metadata: Readonly<Record<string, string>>;
}

async function collectBytes(body: ArtifactBody): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    return Uint8Array.from(body);
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of body) {
    chunks.push(Uint8Array.from(chunk));
    byteLength += chunk.byteLength;
  }
  const joined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

export class InMemoryArtifactStore {
  readonly #clock: TestClock;
  readonly #artifacts = new Map<
    string,
    Readonly<{ descriptor: StoredArtifact; bytes: Uint8Array }>
  >();

  public constructor(clock: TestClock) {
    this.#clock = clock;
  }

  public async putImmutable(request: ArtifactWrite): Promise<StoredArtifact> {
    if (this.#artifacts.has(request.logicalKey)) {
      throw new Error(`Immutable artifact already exists: ${request.logicalKey}`);
    }
    const bytes = await collectBytes(request.body);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== request.expectedSha256) {
      throw new Error(`Artifact SHA-256 mismatch: ${request.logicalKey}`);
    }
    const descriptor = Object.freeze({
      logicalKey: request.logicalKey,
      uri: `memory://artifacts/${encodeURIComponent(request.logicalKey)}`,
      mediaType: request.mediaType,
      byteSize: bytes.byteLength,
      sha256,
      storedAt: this.#clock.now(),
      metadata: Object.freeze({ ...request.metadata }),
    });
    this.#artifacts.set(
      request.logicalKey,
      Object.freeze({ descriptor, bytes: Uint8Array.from(bytes) }),
    );
    return descriptor;
  }

  public async head(uri: string): Promise<StoredArtifact | undefined> {
    return Promise.resolve(this.#find(uri)?.descriptor);
  }

  public async *read(
    uri: string,
    range?: Readonly<{ start: number; endInclusive: number }>,
  ): AsyncIterable<Uint8Array> {
    await Promise.resolve();
    const artifact = this.#find(uri);
    if (artifact === undefined) {
      throw new Error(`Artifact not found: ${uri}`);
    }
    const selected =
      range === undefined
        ? artifact.bytes
        : artifact.bytes.slice(range.start, range.endInclusive + 1);
    yield Uint8Array.from(selected);
  }

  #find(uri: string): Readonly<{ descriptor: StoredArtifact; bytes: Uint8Array }> | undefined {
    for (const artifact of this.#artifacts.values()) {
      if (artifact.descriptor.uri === uri) {
        return artifact;
      }
    }
    return undefined;
  }
}

export type FakeCheckpointValue =
  | null
  | boolean
  | number
  | string
  | readonly FakeCheckpointValue[]
  | Readonly<{ [key: string]: FakeCheckpointValue }>;

interface FakeCheckpointEnvelope<TPayload extends FakeCheckpointValue = FakeCheckpointValue> {
  readonly scope: string;
  readonly revision: string;
  readonly previousRevision: string | null;
  readonly payloadSha256: string;
  readonly writtenAt: string;
  readonly payload: TPayload;
}

export class InMemoryCheckpointStore {
  readonly #checkpoints = new Map<string, FakeCheckpointEnvelope>();

  public async load(scope: string): Promise<FakeCheckpointEnvelope | undefined> {
    return Promise.resolve(this.#checkpoints.get(scope));
  }

  public async commit<TPayload extends FakeCheckpointValue>(request: {
    expectedRevision: string | null;
    checkpoint: FakeCheckpointEnvelope<TPayload>;
  }): Promise<
    | Readonly<{ status: 'committed'; checkpoint: FakeCheckpointEnvelope<TPayload> }>
    | Readonly<{ status: 'conflict'; current: FakeCheckpointEnvelope | undefined }>
  > {
    const current = this.#checkpoints.get(request.checkpoint.scope);
    if ((current?.revision ?? null) !== request.expectedRevision) {
      return Promise.resolve(Object.freeze({ status: 'conflict', current }));
    }
    this.#checkpoints.set(request.checkpoint.scope, request.checkpoint);
    return Promise.resolve(Object.freeze({ status: 'committed', checkpoint: request.checkpoint }));
  }
}

export class ScriptedAnalyticalRuntime<TRow extends Readonly<Record<string, unknown>>> {
  readonly #rows: readonly TRow[];
  readonly #queries: Readonly<{ operation: string; statement: string }>[] = [];

  public constructor(rows: readonly TRow[]) {
    this.#rows = Object.freeze([...rows]);
  }

  public get queries(): readonly Readonly<{ operation: string; statement: string }>[] {
    return Object.freeze([...this.#queries]);
  }

  public async open(_snapshot: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return Promise.resolve({
      execute: async <TResultRow extends Readonly<Record<string, unknown>>>(query: {
        operation: string;
        statement: string;
        maximumRows: number;
        signal?: AbortSignal;
        rowParser?: (row: unknown) => TResultRow;
      }): Promise<
        Readonly<{
          rows: readonly TResultRow[];
          elapsedMs: number;
          scannedBytes: number;
          truncated: boolean;
        }>
      > => {
        query.signal?.throwIfAborted();
        this.#queries.push(
          Object.freeze({ operation: query.operation, statement: query.statement }),
        );
        const selectedRows = this.#rows.slice(0, query.maximumRows);
        const parser = query.rowParser;
        const rows =
          parser === undefined
            ? (selectedRows as unknown as readonly TResultRow[])
            : selectedRows.map((row) => parser(row));
        return Promise.resolve(
          Object.freeze({
            rows,
            elapsedMs: 0,
            scannedBytes: 0,
            truncated: rows.length < this.#rows.length,
          }),
        );
      },
      [Symbol.asyncDispose]: async () => Promise.resolve(),
    });
  }
}

export function createAbortError(message = 'aborted'): DOMException {
  return new DOMException(message, 'AbortError');
}
