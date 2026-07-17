import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { LocalArtifactStore } from '@oracle/artifacts/implementations/local-artifact-store';
import type {
  ArtifactByteRange,
  ArtifactStore,
  ImmutableArtifactWrite,
  StoredArtifact,
} from '@oracle/artifacts/artifact-store';
import { LocalCheckpointStore } from '@oracle/artifacts/implementations/local-checkpoint-store';
import { runIdSchema, snapshotIdSchema } from '@oracle/contracts/ids';
import type {
  AnalyticalQuery,
  AnalyticalResult,
  AnalyticalRow,
  AnalyticalRuntime,
  AnalyticalSession,
  AnalyticalSnapshot,
} from '@oracle/data-runtime/analytical-runtime';
import { createSantaClaraSocrataParcelsAdapter } from '@oracle/source-adapters/providers/santa-clara-socrata-parcels/index';
import {
  SANTA_CLARA_PARCELS_API_ROOT,
  SANTA_CLARA_PARCELS_COUNT_URLS,
  SANTA_CLARA_PARCELS_METADATA_URL,
  SANTA_CLARA_PARCELS_SCHEMA_COLUMNS,
} from '@oracle/source-adapters/providers/santa-clara-socrata-parcels/index';
import type { HttpRequest, HttpResponse, HttpTransport } from '@oracle/source-adapters/spi/http';

import { createDefaultPipelineProcessors } from '../orchestration/default-processors.js';
import { createRunProfile } from '../orchestration/profiles.js';
import { runPipeline } from '../orchestration/runner.js';
import type {
  PipelineResult,
  RunProfileName,
  SourceConfiguration,
} from '../orchestration/types.js';
import type { OrchestrationPhase } from '../orchestration/types.js';
import type { SourceId } from '@oracle/contracts/ids';
import { composeProductionSources } from '../composition/source-registry.js';
import {
  readPipelineSourceConfig,
  sourceConfigFingerprint,
  type AuthorizationRule,
} from '../composition/source-config.js';

const FIXED_INSTANT = '2026-07-17T13:00:00.000Z';
const FIXTURE_RELATIVE_PATH =
  'packages/testkit/src/sources/santa-clara-socrata-parcels/duplicate-apn.geojson';
const ORIGINAL_KEY_METADATA = 'oracleOriginalLogicalKey';
type DuckDBRuntimeModule = Readonly<{
  DuckDBAnalyticalRuntime: new (
    options: Readonly<{
      loadSnapshot: (
        snapshot: AnalyticalSnapshot,
        signal?: AbortSignal,
      ) => Promise<
        Readonly<{
          manifestBytes: Uint8Array;
          scanBytesByOperation: Readonly<Record<string, number>>;
        }>
      >;
      nowMilliseconds: () => number;
    }>,
  ) => AnalyticalRuntime;
}>;

function requiredFixtureSnapshot(
  value: ReturnType<typeof snapshotIdSchema.parse> | null,
): ReturnType<typeof snapshotIdSchema.parse> {
  if (value === null) throw new Error('Fixture snapshot identity was not created');
  return value;
}

/** Keeps contract logical keys intact while making every path segment portable to Windows. */
class PortableLocalArtifactStore implements ArtifactStore {
  readonly #delegate: LocalArtifactStore;
  readonly #rootDirectory: string;

  public constructor(rootDirectory: string, now: () => string) {
    this.#rootDirectory = resolve(rootDirectory);
    this.#delegate = new LocalArtifactStore({ rootDirectory: this.#rootDirectory, now });
  }

  public async putImmutable(request: ImmutableArtifactWrite): Promise<StoredArtifact> {
    const physicalKey = this.#physicalKey(request.logicalKey);
    const stored = await this.#delegate.putImmutable({
      ...request,
      logicalKey: physicalKey,
      metadata: Object.freeze({ ...request.metadata, [ORIGINAL_KEY_METADATA]: request.logicalKey }),
    });
    return this.#restore(stored, request.logicalKey);
  }

  public async head(uri: string): Promise<StoredArtifact | undefined> {
    const originalKey = this.#logicalKey(uri);
    const stored = await this.#delegate.head(this.#delegateUri(originalKey));
    return stored === undefined ? undefined : this.#restore(stored, originalKey);
  }

  public read(uri: string, range?: ArtifactByteRange): AsyncIterable<Uint8Array> {
    return this.#delegate.read(this.#delegateUri(this.#logicalKey(uri)), range);
  }

  public physicalUri(uri: string): string {
    return this.#delegateUri(this.#logicalKey(uri));
  }

  #restore(stored: StoredArtifact, originalKey: string): StoredArtifact {
    return Object.freeze({
      ...stored,
      logicalKey: originalKey,
      uri: `file://oracle-artifact/${Buffer.from(originalKey).toString('base64url')}`,
    });
  }

  #logicalKey(uri: string): string {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:' || parsed.hostname !== 'oracle-artifact') {
      throw new TypeError('Portable local artifact URI is invalid');
    }
    return Buffer.from(parsed.pathname.slice(1), 'base64url').toString('utf8');
  }

  #delegateUri(originalKey: string): string {
    return pathToFileURL(join(this.#rootDirectory, this.#physicalKey(originalKey), 'body')).href;
  }

  #physicalKey(originalKey: string): string {
    return `objects/${createHash('sha256').update(originalKey).digest('hex')}`;
  }
}

class SystemClock {
  public now(): string {
    return new Date().toISOString();
  }
}

class FixedClock {
  public now(): string {
    return FIXED_INSTANT;
  }
}

class AbortableDelay {
  public async wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (milliseconds === 0) return Promise.resolve();
    return new Promise<void>((resolveDelay, reject) => {
      const timer = setTimeout(resolveDelay, milliseconds);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new DOMException('Operation aborted', 'AbortError'),
          );
        },
        { once: true },
      );
    });
  }
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  await Promise.resolve();
  yield Uint8Array.from(bytes);
}

function jsonResponse(value: unknown): HttpResponse {
  return Object.freeze({
    status: 200,
    headers: Object.freeze({ 'content-type': 'application/json' }),
    body: oneChunk(new TextEncoder().encode(JSON.stringify(value))),
  });
}

class FixtureParcelTransport implements HttpTransport {
  readonly #fixture: Uint8Array;

  public constructor(fixture: Uint8Array) {
    this.#fixture = Uint8Array.from(fixture);
  }

  public send(request: HttpRequest, signal: AbortSignal): Promise<HttpResponse> {
    signal.throwIfAborted();
    if (request.url === SANTA_CLARA_PARCELS_METADATA_URL) {
      return Promise.resolve(
        jsonResponse({ rowsUpdatedAt: 1_774_250_320, columns: SANTA_CLARA_PARCELS_SCHEMA_COLUMNS }),
      );
    }
    if (request.url === SANTA_CLARA_PARCELS_COUNT_URLS.countyRows)
      return Promise.resolve(jsonResponse([{ count: '2' }]));
    if (request.url === SANTA_CLARA_PARCELS_COUNT_URLS.countyDistinctApns)
      return Promise.resolve(jsonResponse([{ count: '1' }]));
    if (request.url === SANTA_CLARA_PARCELS_COUNT_URLS.paloAltoRows)
      return Promise.resolve(jsonResponse([{ count: '2' }]));
    if (request.url === SANTA_CLARA_PARCELS_COUNT_URLS.paloAltoDistinctApns)
      return Promise.resolve(jsonResponse([{ count: '1' }]));
    if (request.url.startsWith(SANTA_CLARA_PARCELS_API_ROOT)) {
      return Promise.resolve(
        Object.freeze({
          status: 200,
          headers: Object.freeze({
            'content-type': 'application/vnd.geo+json; charset=UTF-8',
            etag: '"official-safe-excerpt"',
            'last-modified': 'Mon, 23 Mar 2026 07:08:59 GMT',
          }),
          body: oneChunk(this.#fixture),
        }),
      );
    }
    return Promise.reject(new Error(`Networkless pilot rejected unregistered URL: ${request.url}`));
  }
}

class FetchTransport implements HttpTransport {
  readonly #authorization: readonly AuthorizationRule[];
  readonly #requestTimeoutMs: number;

  public constructor(authorization: readonly AuthorizationRule[], requestTimeoutMs: number) {
    this.#authorization = authorization;
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  public async send(request: HttpRequest, signal: AbortSignal): Promise<HttpResponse> {
    const headers: Record<string, string> = { ...request.headers };
    for (const rule of this.#authorization) {
      if (!isWithinAuthorizationScope(request.url, rule.urlPrefix)) continue;
      const value = process.env[rule.environmentVariable];
      if (value === undefined || value.length === 0) {
        throw Object.assign(
          new Error(
            `Configured source authorization environment variable is unavailable: ${rule.environmentVariable}`,
          ),
          { code: 'AUTHENTICATION', retryable: false },
        );
      }
      headers[rule.headerName] = value;
    }
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(this.#requestTimeoutMs)]);
    const init: RequestInit = {
      method: request.method,
      headers,
      signal: boundedSignal,
      ...(request.body === undefined ? {} : { body: request.body }),
    };
    const response = await fetch(request.url, init);
    return Object.freeze({
      status: response.status,
      headers: collectResponseHeaders(response.headers),
      body: response.body ?? oneChunk(new Uint8Array()),
    });
  }
}

export function isWithinAuthorizationScope(requestUrl: string, scopeUrl: string): boolean {
  const request = new URL(requestUrl);
  const scope = new URL(scopeUrl);
  if (request.origin !== scope.origin) return false;
  const path = scope.pathname.endsWith('/') ? scope.pathname : `${scope.pathname}/`;
  return request.pathname === scope.pathname || request.pathname.startsWith(path);
}

export function collectResponseHeaders(headers: Headers): Readonly<Record<string, string>> {
  const collected: Record<string, string> = Object.fromEntries(headers.entries());
  const setCookies = headers.getSetCookie();
  if (setCookies.length > 0) collected['set-cookie'] = setCookies.join(',');
  return Object.freeze(collected);
}

class RemappedAnalyticalSession implements AnalyticalSession {
  readonly #delegate: AnalyticalSession;
  readonly #artifacts: PortableLocalArtifactStore;

  public constructor(delegate: AnalyticalSession, artifacts: PortableLocalArtifactStore) {
    this.#delegate = delegate;
    this.#artifacts = artifacts;
  }

  public execute<TRow extends AnalyticalRow = AnalyticalRow>(
    query: AnalyticalQuery,
  ): Promise<AnalyticalResult<TRow>> {
    return this.#delegate.execute<TRow>({
      ...query,
      parameters: query.parameters.map((value) =>
        typeof value === 'string' && value.startsWith('file://oracle-artifact/')
          ? this.#artifacts.physicalUri(value)
          : value,
      ),
    });
  }

  public [Symbol.asyncDispose](): PromiseLike<void> {
    return this.#delegate[Symbol.asyncDispose]();
  }
}

class PipelineAnalyticalRuntime implements AnalyticalRuntime {
  readonly #artifacts: PortableLocalArtifactStore;
  #delegate: Promise<AnalyticalRuntime> | undefined;

  public constructor(artifacts: PortableLocalArtifactStore) {
    this.#artifacts = artifacts;
  }

  async #load(): Promise<AnalyticalRuntime> {
    const moduleSpecifier = ['@oracle/data-runtime/duckdb', 'duckdb-analytical-runtime'].join('/');
    this.#delegate ??= import(moduleSpecifier).then((untypedModule: unknown) => {
      const { DuckDBAnalyticalRuntime } = untypedModule as DuckDBRuntimeModule;
      return new DuckDBAnalyticalRuntime({
        loadSnapshot: async (snapshot: AnalyticalSnapshot, signal?: AbortSignal) => {
          signal?.throwIfAborted();
          const chunks: Uint8Array[] = [];
          let byteLength = 0;
          for await (const chunk of this.#artifacts.read(snapshot.manifestUri)) {
            chunks.push(chunk);
            byteLength += chunk.byteLength;
          }
          const bytes = new Uint8Array(byteLength);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return Object.freeze({
            manifestBytes: bytes,
            scanBytesByOperation: Object.freeze({
              decode_overture_santa_clara_starbucks_candidates: byteLength,
            }),
          });
        },
        nowMilliseconds: () => Date.now(),
      });
    });
    return this.#delegate;
  }

  public async open(
    snapshot: AnalyticalSnapshot,
    signal?: AbortSignal,
  ): Promise<AnalyticalSession> {
    return new RemappedAnalyticalSession(
      await (await this.#load()).open(snapshot, signal),
      this.#artifacts,
    );
  }
}

export type RunCommandOptions = Readonly<{
  profile: RunProfileName;
  workspaceDirectory: string;
  outputDirectory: string;
  fixture: boolean;
  sourceConfigPath?: string;
  requestedAt?: string;
  signal?: AbortSignal;
  beforePhase?: (phase: OrchestrationPhase, sourceId: SourceId | null) => void | Promise<void>;
}>;

export async function runCommand(options: RunCommandOptions): Promise<PipelineResult> {
  if (options.fixture && options.profile !== 'pilot' && options.profile !== 'discovery') {
    throw new TypeError('The committed networkless fixture is only valid for discovery or pilot');
  }
  const workspaceDirectory = resolve(options.workspaceDirectory);
  const outputDirectory = resolve(options.outputDirectory);
  const sourceConfig = await readPipelineSourceConfig(options.sourceConfigPath);
  const configFingerprint = sourceConfigFingerprint(sourceConfig);
  const fixture = options.fixture
    ? new Uint8Array(await readFile(resolve(workspaceDirectory, FIXTURE_RELATIVE_PATH)))
    : undefined;
  const clock = options.fixture ? new FixedClock() : new SystemClock();
  const currentInstant = clock.now();
  const requestedAt = options.requestedAt ?? currentInstant;
  if (
    !Number.isFinite(Date.parse(requestedAt)) ||
    new Date(requestedAt).toISOString() !== requestedAt
  ) {
    throw new TypeError('requestedAt must be a canonical ISO-8601 instant');
  }
  if (Date.parse(requestedAt) > Date.parse(currentInstant)) {
    throw new TypeError('requestedAt cannot be later than the current runtime clock');
  }
  const runDigest = createHash('sha256')
    .update(
      `oracle-pipeline-v2|${options.profile}|${configFingerprint}|${requestedAt}|${options.fixture ? 'fixture' : 'production'}`,
    )
    .digest('hex');
  const runId = runIdSchema.parse(`sc:run:${runDigest}`);
  const fixtureSnapshotId =
    fixture === undefined
      ? null
      : snapshotIdSchema.parse(
          `sc:snapshot:santa-clara-socrata-parcels:${createHash('sha256').update(fixture).digest('hex')}`,
        );
  const controller = new AbortController();
  options.signal?.addEventListener('abort', () => controller.abort(options.signal?.reason), {
    once: true,
  });
  const artifactStore = new PortableLocalArtifactStore(resolve(outputDirectory, 'artifacts'), () =>
    clock.now(),
  );
  const sources =
    fixture === undefined
      ? await composeProductionSources({
          runId,
          requestedAt,
          profile: options.profile,
          workspaceDirectory,
          config: sourceConfig,
          configFingerprint,
        })
      : Object.freeze([
          {
            adapter: createSantaClaraSocrataParcelsAdapter({
              pageSize: 2,
            }) as unknown as SourceConfiguration['adapter'],
            snapshotId: requiredFixtureSnapshot(fixtureSnapshotId),
            scope: 'Committed official Santa Clara parcel excerpt',
            capability: 'fixture_parcels_only',
            executionMode: 'execute' as const,
            supportState: 'available' as const,
            acquisitionItemCap: null,
            discoveryDenominatorStrategy: 'first_non_null' as const,
            requiredForCountyCompletion: false,
            limitations: Object.freeze([
              'Networkless fixture mode uses a committed official safe parcel excerpt and is never production or county-completion evidence.',
            ]),
          },
        ]);
  return runPipeline(
    Object.freeze({
      runId,
      pipelineVersion: '2.0.0',
      requestedAt,
      profile: createRunProfile(options.profile, {
        recordCap: options.profile === 'pilot' ? sourceConfig.pilot.recordCap : null,
        maxConcurrentSources: sourceConfig.runtime.maxConcurrentSources,
        maxBufferedRecords: sourceConfig.runtime.maxBufferedRecords,
      }),
      sources,
      maximumPhaseAttempts: sourceConfig.runtime.maximumPhaseAttempts,
    }),
    Object.freeze({
      artifactStore,
      checkpointStore: new LocalCheckpointStore({
        rootDirectory: resolve(outputDirectory, 'checkpoints'),
      }),
      analyticalRuntime: new PipelineAnalyticalRuntime(artifactStore),
      http:
        fixture === undefined
          ? new FetchTransport(
              sourceConfig.fallback511?.authorization ?? [],
              sourceConfig.runtime.requestTimeoutMs,
            )
          : new FixtureParcelTransport(fixture),
      clock,
      delay: new AbortableDelay(),
      processors: createDefaultPipelineProcessors(),
      signal: controller.signal,
      ...(options.beforePhase === undefined ? {} : { beforePhase: options.beforePhase }),
    }),
  );
}
