import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type {
  ArtifactBody,
  ArtifactByteRange,
  ArtifactStore,
  ImmutableArtifactWrite,
  StoredArtifact,
} from '@oracle/artifacts/artifact-store';
import type {
  CheckpointCommit,
  CheckpointCommitResult,
  CheckpointEnvelope,
  CheckpointStore,
  CheckpointValue,
} from '@oracle/artifacts/checkpoint-store';
import { acquiredArtifactSchema, type SourceCheckpoint } from '@oracle/contracts/source';
import { snapshotIdSchema } from '@oracle/contracts/ids';
import type { AnalyticalRuntime } from '@oracle/data-runtime/analytical-runtime';

import {
  createAcquiredByteArtifact,
  type AcquiredByteArtifact,
} from '../../spi/acquired-artifact.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../../spi/http.js';
import {
  OVERTURE_STARBUCKS_DESCRIPTOR,
  OVERTURE_STARBUCKS_SCHEMA_FINGERPRINT,
} from './constants.js';
import type { OvertureArtifactConfig } from './types.js';

export const FIXTURE_SHA256 = '6b91c2c2aaf6f407b3aa9e965794a7cfef4ad4889286b917e174b4bd6a2092d1';
export const SNAPSHOT_ID = snapshotIdSchema.parse(
  `sc:snapshot:overture-starbucks:${FIXTURE_SHA256}`,
);
export const FIXTURE_URL = 'https://fixtures.invalid/overture-starbucks.geojson';
export const FIXTURE_LAST_MODIFIED = '2026-06-17T17:24:40.000Z';
export const FIXTURE_ETAG = '"fixture-2026-06-17"';

export async function fixtureBytes(): Promise<Uint8Array> {
  return readFile(
    new URL(
      '../../../../testkit/src/sources/overture-starbucks/official-overture-2026-06-17-excerpt.geojson',
      import.meta.url,
    ),
  );
}

export async function fixtureConfig(
  encoding: 'geojson' | 'parquet' = 'geojson',
): Promise<OvertureArtifactConfig> {
  const bytes = await fixtureBytes();
  return Object.freeze({
    url: FIXTURE_URL,
    encoding,
    mediaTypes: Object.freeze([
      encoding === 'geojson' ? 'application/geo+json' : 'application/vnd.apache.parquet',
    ]),
    expectedBytes: bytes.byteLength,
    expectedSha256: FIXTURE_SHA256,
    expectedEtag: FIXTURE_ETAG,
    expectedLastModified: FIXTURE_LAST_MODIFIED,
  });
}

async function collect(body: ArtifactBody): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return Uint8Array.from(body);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of body) {
    chunks.push(Uint8Array.from(chunk));
    length += chunk.byteLength;
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

export class TestArtifactStore implements ArtifactStore {
  readonly #byUri = new Map<string, Readonly<{ stored: StoredArtifact; bytes: Uint8Array }>>();

  public async putImmutable(request: ImmutableArtifactWrite): Promise<StoredArtifact> {
    const bytes = await collect(request.body);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== request.expectedSha256) throw new Error('test artifact SHA mismatch');
    const uri = `file:///test-artifacts/${encodeURIComponent(request.logicalKey)}`;
    if (this.#byUri.has(uri)) throw new Error('immutable artifact conflict');
    const stored: StoredArtifact = Object.freeze({
      logicalKey: request.logicalKey,
      uri,
      mediaType: request.mediaType,
      byteSize: bytes.byteLength,
      sha256: actual,
      storedAt: '2026-07-17T10:00:02.000Z',
      metadata: Object.freeze({ ...request.metadata }),
    });
    this.#byUri.set(uri, Object.freeze({ stored, bytes }));
    return stored;
  }

  public async head(uri: string): Promise<StoredArtifact | undefined> {
    await Promise.resolve();
    return this.#byUri.get(uri)?.stored;
  }

  public async *read(uri: string, range?: ArtifactByteRange): AsyncIterable<Uint8Array> {
    await Promise.resolve();
    const artifact = this.#byUri.get(uri);
    if (artifact === undefined) throw new Error('artifact absent');
    yield range === undefined
      ? Uint8Array.from(artifact.bytes)
      : artifact.bytes.slice(range.start, range.endInclusive + 1);
  }
}

export class TestCheckpointStore implements CheckpointStore {
  readonly checkpoints = new Map<string, CheckpointEnvelope>();
  conflict = false;

  public async load(scope: string): Promise<CheckpointEnvelope | undefined> {
    await Promise.resolve();
    return this.checkpoints.get(scope);
  }

  public async commit<TPayload extends CheckpointValue>(
    request: CheckpointCommit<TPayload>,
  ): Promise<CheckpointCommitResult<TPayload>> {
    await Promise.resolve();
    const current = this.checkpoints.get(request.checkpoint.scope);
    if (this.conflict || (current?.revision ?? null) !== request.expectedRevision) {
      return Object.freeze({ status: 'conflict', current });
    }
    this.checkpoints.set(request.checkpoint.scope, request.checkpoint);
    return Object.freeze({ status: 'committed', checkpoint: request.checkpoint });
  }
}

async function* responseBody(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  await Promise.resolve();
  for (const chunk of chunks) yield Uint8Array.from(chunk);
}

export interface TestResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly chunks?: readonly Uint8Array[];
}

export class SequenceTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  readonly #responses: TestResponse[];

  public constructor(responses: readonly TestResponse[]) {
    this.#responses = [...responses];
  }

  public async send(request: HttpRequest, signal: AbortSignal): Promise<HttpResponse> {
    await Promise.resolve();
    signal.throwIfAborted();
    this.requests.push(request);
    const response = this.#responses.shift();
    if (response === undefined) throw new Error('No scripted HTTP response');
    return Object.freeze({
      status: response.status,
      headers: response.headers,
      body: responseBody(response.chunks ?? []),
    });
  }
}

export class TestClock {
  readonly #values: string[];
  #index = 0;

  public constructor(
    values: readonly string[] = [
      '2026-07-17T10:00:00.000Z',
      '2026-07-17T10:00:01.000Z',
      '2026-07-17T10:00:02.000Z',
    ],
  ) {
    this.#values = [...values];
  }

  public now(): string {
    const value = this.#values[Math.min(this.#index, this.#values.length - 1)];
    this.#index += 1;
    if (value === undefined) throw new Error('clock invariant');
    return value;
  }
}

export class TestDelay {
  readonly waits: number[] = [];

  public async wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    await Promise.resolve();
    signal.throwIfAborted();
    this.waits.push(milliseconds);
  }
}

export function responseHeaders(config: OvertureArtifactConfig): Readonly<Record<string, string>> {
  return Object.freeze({
    'content-length': String(config.expectedBytes),
    'content-type': config.mediaTypes[0] ?? 'application/octet-stream',
    etag: config.expectedEtag ?? '',
    'last-modified': 'Wed, 17 Jun 2026 17:24:40 GMT',
  });
}

export const UNUSED_RUNTIME: AnalyticalRuntime = Object.freeze({
  open: async () => {
    await Promise.resolve();
    return {
      execute: async () => {
        await Promise.resolve();
        return { rows: [], elapsedMs: 0, scannedBytes: 0, truncated: false };
      },
      [Symbol.asyncDispose]: async () => {
        await Promise.resolve();
      },
    };
  },
});

export async function acquiredFixture(
  encoding: 'geojson' | 'parquet' = 'geojson',
): Promise<AcquiredByteArtifact> {
  const bytes = await fixtureBytes();
  const mediaType =
    encoding === 'geojson' ? 'application/geo+json' : 'application/vnd.apache.parquet';
  const metadata = acquiredArtifactSchema.parse({
    artifactId: `sc:artifact:sha256:${FIXTURE_SHA256}`,
    sourceId: OVERTURE_STARBUCKS_DESCRIPTOR.sourceId,
    snapshotId: SNAPSHOT_ID,
    retrievedAt: '2026-07-17T10:00:02.000Z',
    sourceAsOf: { state: 'reported', at: FIXTURE_LAST_MODIFIED },
    request: {
      requestKey: 'fixture',
      method: 'GET',
      url: FIXTURE_URL,
      headers: [],
      bodySha256: null,
      attempt: 1,
    },
    response: {
      httpStatus: 200,
      etag: FIXTURE_ETAG,
      lastModified: FIXTURE_LAST_MODIFIED,
      finalUrl: FIXTURE_URL,
    },
    mediaType,
    encoding,
    byteSize: bytes.byteLength,
    sha256: FIXTURE_SHA256,
    schemaFingerprint: {
      algorithm: 'sha256',
      value: OVERTURE_STARBUCKS_SCHEMA_FINGERPRINT,
      schemaName: 'overture-places-v1.17.0',
      canonicalizationVersion: '1.0.0',
    },
    rawUri: 'file:///test-artifacts/overture-fixture',
    licenseSnapshotRef: OVERTURE_STARBUCKS_DESCRIPTOR.license.licenseSnapshotId,
    visibility: 'public',
  });
  return createAcquiredByteArtifact(metadata, bytes);
}

export function completedCheckpoint(): SourceCheckpoint {
  return sourceCheckpointShape();
}

function sourceCheckpointShape(): SourceCheckpoint {
  return {
    sourceId: OVERTURE_STARBUCKS_DESCRIPTOR.sourceId,
    snapshotId: SNAPSHOT_ID,
    contractVersion: '1.0.0',
    cursor: 'complete',
    nextSequence: 1,
    completedRequestKeys: ['overture-2026-06-17.0-santa-clara-fragment'],
    acquiredArtifactIds: [
      `sc:artifact:sha256:${FIXTURE_SHA256}` as SourceCheckpoint['acquiredArtifactIds'][number],
    ],
    updatedAt: '2026-07-17T10:00:02.000Z',
    complete: true,
  };
}
