import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { LocalArtifactStore } from '@oracle/artifacts/implementations/local-artifact-store';
import type {
  ArtifactByteRange,
  RecoverableArtifactStore,
  ImmutableArtifactWrite,
  StreamingImmutableArtifactWrite,
  StoredArtifact,
} from '@oracle/artifacts/artifact-store';
import {
  createCheckpointEnvelope,
  type CheckpointCommit,
  type CheckpointCommitResult,
  type CheckpointEnvelope,
  type CheckpointStore,
  type CheckpointValue,
} from '@oracle/artifacts/checkpoint-store';
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
  CSLB_MASTER_DOWNLOAD_EVENT,
  CSLB_MASTER_SELECT_VALUE,
  CSLB_PORTAL_SELECT_FIELD,
  CSLB_PORTAL_URL,
} from '@oracle/source-adapters/providers/cslb-contractors/constants';
import {
  SANTA_CLARA_PARCELS_API_ROOT,
  SANTA_CLARA_PARCELS_COUNT_URLS,
  SANTA_CLARA_PARCELS_METADATA_URL,
  SANTA_CLARA_PARCELS_SCHEMA_COLUMNS,
} from '@oracle/source-adapters/providers/santa-clara-socrata-parcels/index';
import type { HttpRequest, HttpResponse, HttpTransport } from '@oracle/source-adapters/spi/http';
import {
  ANALYTICAL_SNAPSHOT_MANIFEST_MEDIA_TYPE,
  MAX_ANALYTICAL_SNAPSHOT_MANIFEST_BYTES,
  parseAnalyticalSnapshotManifest,
  type AnalyticalSnapshotManifestV1,
} from '@oracle/source-adapters/spi/acquired-artifact';

import { createDefaultPipelineProcessors } from '../orchestration/default-processors.js';
import { createBoundedPipelineProcessors } from '../orchestration/bounded-processors.js';
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
const CSLB_FINAL_EXPORT_HEADER_TIMEOUT_MS = 120_000;
const CSLB_FINAL_EXPORT_TIMEOUT_HEADER = 'x-oracle-header-timeout-ms';
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
class PortableLocalArtifactStore implements RecoverableArtifactStore {
  readonly #delegate: LocalArtifactStore;
  readonly #rootDirectory: string;

  public constructor(rootDirectory: string, now: () => string) {
    this.#rootDirectory = resolve(rootDirectory);
    this.#delegate = new LocalArtifactStore({ rootDirectory: this.#rootDirectory, now });
  }

  public async putImmutable(request: ImmutableArtifactWrite): Promise<StoredArtifact> {
    return this.#put(request);
  }

  public async putImmutableStreaming(
    request: StreamingImmutableArtifactWrite,
  ): Promise<StoredArtifact> {
    return this.#put(request);
  }

  async #put(request: StreamingImmutableArtifactWrite): Promise<StoredArtifact> {
    const physicalKey = this.#physicalKey(request.logicalKey);
    const stored = await this.#delegate.putImmutableStreaming({
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

  public async headByLogicalKey(logicalKey: string): Promise<StoredArtifact | undefined> {
    const stored = await this.#delegate.headByLogicalKey(this.#physicalKey(logicalKey));
    if (stored === undefined) return undefined;
    if (stored.metadata[ORIGINAL_KEY_METADATA] !== logicalKey) {
      throw new Error(`Portable artifact logical-key metadata mismatch for ${logicalKey}`);
    }
    return this.#restore(stored, logicalKey);
  }

  public read(uri: string, range?: ArtifactByteRange): AsyncIterable<Uint8Array> {
    return this.#delegate.read(this.#delegateUri(this.#logicalKey(uri)), range);
  }

  public physicalUri(uri: string): string {
    return this.#delegateUri(this.#logicalKey(uri));
  }

  public async verify(uri: string): Promise<StoredArtifact> {
    const logicalKey = this.#logicalKey(uri);
    const stored = await this.headByLogicalKey(logicalKey);
    if (stored === undefined) throw new Error(`Artifact not found: ${logicalKey}`);
    return stored;
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

export class FetchTransport implements HttpTransport {
  readonly #authorization: readonly AuthorizationRule[];
  readonly #requestTimeoutMs: number;
  readonly #headerTimeoutMs: (request: HttpRequest) => number;

  public constructor(
    authorization: readonly AuthorizationRule[],
    requestTimeoutMs: number,
    options: Readonly<{ headerTimeoutMs?: (request: HttpRequest) => number }> = {},
  ) {
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
      throw new RangeError('requestTimeoutMs must be a positive safe integer');
    }
    this.#authorization = authorization;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#headerTimeoutMs = options.headerTimeoutMs ?? (() => requestTimeoutMs);
  }

  public async send(request: HttpRequest, signal: AbortSignal): Promise<HttpResponse> {
    signal.throwIfAborted();
    const headers: Record<string, string> = Object.fromEntries(
      Object.entries(request.headers).filter(
        ([name]) => name.toLowerCase() !== CSLB_FINAL_EXPORT_TIMEOUT_HEADER,
      ),
    );
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
    const headerTimeoutMs = this.#headerTimeoutMs(request);
    if (!Number.isSafeInteger(headerTimeoutMs) || headerTimeoutMs < 1) {
      throw new RangeError('header timeout policy must return a positive safe integer');
    }

    const first = await fetchHeaders(
      request.url,
      request.method,
      headers,
      request.body,
      signal,
      headerTimeoutMs,
    );
    let selected = first;
    let redirected = false;
    if (isRedirect(first.response.status)) {
      const target = allowedSanJoseRedirect(request, first.response);
      await discardRedirectBody(first);
      if (target === undefined) {
        throw new RedirectRejectedError(request.url, first.response.status);
      }
      selected = await fetchHeaders(
        target.href,
        request.method,
        sanJoseRedirectHeaders(headers),
        undefined,
        signal,
        headerTimeoutMs,
      );
      redirected = true;
      if (isRedirect(selected.response.status)) {
        const status = selected.response.status;
        await discardRedirectBody(selected);
        throw new RedirectRejectedError(target.href, status);
      }
    }

    const response = selected.response;
    const body = response.body;
    const discardBody = response.status < 200 || response.status >= 300;
    if (body === null || discardBody) {
      try {
        if (body !== null) await body.cancel();
      } finally {
        selected.detachGlobalAbort();
      }
    }
    return Object.freeze({
      status: response.status,
      headers: collectResponseHeaders(response.headers),
      body:
        body === null || discardBody
          ? oneChunk(new Uint8Array())
          : streamWithIdleTimeout(
              body,
              selected.controller,
              signal,
              this.#requestTimeoutMs,
              selected.detachGlobalAbort,
            ),
      finalUrl: redirected ? urlWithoutQuery(response.url) : response.url,
    });
  }
}

type HeaderResponse = Readonly<{
  response: Response;
  controller: AbortController;
  detachGlobalAbort: () => void;
}>;

async function fetchHeaders(
  url: string,
  method: HttpRequest['method'],
  headers: Readonly<Record<string, string>>,
  body: Uint8Array | undefined,
  globalSignal: AbortSignal,
  timeoutMs: number,
): Promise<HeaderResponse> {
  globalSignal.throwIfAborted();
  const controller = new AbortController();
  const propagateGlobalAbort = (): void => controller.abort(abortReason(globalSignal));
  globalSignal.addEventListener('abort', propagateGlobalAbort, { once: true });
  const detachGlobalAbort = (): void =>
    globalSignal.removeEventListener('abort', propagateGlobalAbort);
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Response headers timed out', 'AbortError')),
    timeoutMs,
  );
  try {
    const response = await fetch(url, {
      method,
      headers,
      signal: controller.signal,
      redirect: 'manual',
      ...(body === undefined ? {} : { body }),
    });
    return Object.freeze({ response, controller, detachGlobalAbort });
  } catch (error) {
    detachGlobalAbort();
    if (controller.signal.aborted) throw abortReason(controller.signal);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function allowedSanJoseRedirect(request: HttpRequest, response: Response): URL | undefined {
  if (request.method !== 'GET' && request.method !== 'HEAD') return undefined;
  const source = new URL(request.url);
  if (
    source.origin !== 'https://data.sanjoseca.gov' ||
    source.username !== '' ||
    source.password !== '' ||
    source.search !== '' ||
    source.hash !== ''
  ) {
    return undefined;
  }
  const sourceMatch =
    /^\/dataset\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/resource\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/download\/([^/]+)$/u.exec(
      source.pathname,
    );
  const location = response.headers.get('location');
  if (sourceMatch === null || location === null) return undefined;
  const target = new URL(location, source);
  const [, resourceId, fileName] = sourceMatch;
  if (
    target.origin !== 'https://s3.amazonaws.com' ||
    target.username !== '' ||
    target.password !== '' ||
    target.hash !== '' ||
    target.pathname !==
      `/og-production-open-data-sanjoseca-892364687672/resources/${resourceId}/${fileName}`
  ) {
    return undefined;
  }
  return target;
}

function sanJoseRedirectHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const accept = Object.entries(headers).find(([name]) => name.toLowerCase() === 'accept')?.[1];
  return Object.freeze(accept === undefined ? {} : { accept });
}

function hasCslbFinalExportTimeoutHint(request: HttpRequest): boolean {
  if (
    request.method !== 'POST' ||
    request.url !== CSLB_PORTAL_URL ||
    request.body === undefined ||
    requestHeader(request, 'content-type') !== 'application/x-www-form-urlencoded' ||
    requestHeader(request, CSLB_FINAL_EXPORT_TIMEOUT_HEADER) !==
      String(CSLB_FINAL_EXPORT_HEADER_TIMEOUT_MS)
  ) {
    return false;
  }
  try {
    const parameters = new URLSearchParams(
      new TextDecoder('utf-8', { fatal: true }).decode(request.body),
    );
    return (
      parameters.get('__EVENTTARGET') === CSLB_MASTER_DOWNLOAD_EVENT &&
      parameters.get('__EVENTARGUMENT') === '' &&
      parameters.get(CSLB_PORTAL_SELECT_FIELD) === CSLB_MASTER_SELECT_VALUE &&
      (parameters.get('__VIEWSTATE')?.length ?? 0) > 0 &&
      (parameters.get('__EVENTVALIDATION')?.length ?? 0) > 0
    );
  } catch {
    return false;
  }
}

function requestHeader(request: HttpRequest, expected: string): string | undefined {
  return Object.entries(request.headers).find(
    ([name]) => name.toLowerCase() === expected.toLowerCase(),
  )?.[1];
}

export function pipelineHeaderTimeoutMs(request: HttpRequest, defaultTimeoutMs: number): number {
  return hasCslbFinalExportTimeoutHint(request)
    ? CSLB_FINAL_EXPORT_HEADER_TIMEOUT_MS
    : defaultTimeoutMs;
}

async function discardRedirectBody(response: HeaderResponse): Promise<void> {
  try {
    await response.response.body?.cancel();
  } finally {
    response.detachGlobalAbort();
  }
}

async function* streamWithIdleTimeout(
  body: ReadableStream<Uint8Array>,
  requestController: AbortController,
  globalSignal: AbortSignal,
  idleTimeoutMs: number,
  detachGlobalAbort: () => void,
): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  let complete = false;
  try {
    for (;;) {
      globalSignal.throwIfAborted();
      const next = await readWithIdleTimeout(reader, requestController, idleTimeoutMs);
      if (next.done) {
        complete = true;
        return;
      }
      yield next.value;
    }
  } finally {
    detachGlobalAbort();
    if (!complete) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: AbortController,
  timeoutMs: number,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> {
  return new Promise((resolveRead, rejectRead) => {
    let settled = false;
    const settle = (
      value: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', onAbort);
      resolveRead(value);
    };
    const reject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', onAbort);
      rejectRead(error instanceof Error ? error : new Error(String(error)));
    };
    const onAbort = (): void => reject(abortReason(controller.signal));
    const timeout = setTimeout(
      () => controller.abort(new DOMException('Response body made no progress', 'AbortError')),
      timeoutMs,
    );
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) {
      onAbort();
      return;
    }
    reader.read().then(settle, reject);
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Operation aborted', 'AbortError');
}

function urlWithoutQuery(value: string): string {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.href;
}

export class RedirectRejectedError extends Error {
  public readonly code = 'HTTP_REDIRECT_REJECTED';

  public constructor(url: string, status: number) {
    super(`HTTP redirect ${status} rejected for ${urlWithoutQuery(url)}`);
    this.name = 'RedirectRejectedError';
  }
}

function reopenFailedAcquisition(payload: CheckpointValue): CheckpointValue | undefined {
  if (!isCheckpointObject(payload)) return undefined;
  const run = payload;
  if (run.schemaVersion !== 2 || run.manifestArtifact === null || !Array.isArray(run.sources)) {
    return undefined;
  }
  const sourceValues = run.sources as readonly CheckpointValue[];
  const shouldReopen = sourceValues.some(
    (source) =>
      isCheckpointObject(source) &&
      source.terminalState === 'failed' &&
      source.completedPhase === 'plan',
  );
  if (!shouldReopen) return undefined;
  const sources: readonly CheckpointValue[] = sourceValues.map((source): CheckpointValue => {
    if (!isCheckpointObject(source)) return source;
    const state = source;
    if (state.terminalState !== 'failed' || state.completedPhase !== 'plan') return source;
    return Object.freeze({ ...state, terminalState: null });
  });
  return Object.freeze({
    ...run,
    sources: Object.freeze(sources),
    reconcileArtifact: null,
    featureArtifact: null,
    martArtifact: null,
    manifestArtifact: null,
    completedPhase: null,
  });
}

function isCheckpointObject(
  value: CheckpointValue,
): value is Readonly<Record<string, CheckpointValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class RetryableAcquisitionCheckpointStore implements CheckpointStore {
  readonly #delegate: CheckpointStore;
  readonly #now: () => string;

  public constructor(delegate: CheckpointStore, now: () => string) {
    this.#delegate = delegate;
    this.#now = now;
  }

  public async load(scope: string): Promise<CheckpointEnvelope | undefined> {
    let current = await this.#delegate.load(scope);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (current === undefined) return undefined;
      const payload = reopenFailedAcquisition(current.payload);
      if (payload === undefined) return current;
      const checkpoint = createCheckpointEnvelope({
        scope,
        previousRevision: current.revision,
        writtenAt: this.#now(),
        payload,
      });
      const committed = await this.#delegate.commit({
        expectedRevision: current.revision,
        checkpoint,
      });
      if (committed.status === 'committed') return committed.checkpoint;
      current = committed.current;
    }
    throw new Error(`Concurrent checkpoint conflict while reopening ${scope}`);
  }

  public commit<TPayload extends CheckpointValue>(
    request: CheckpointCommit<TPayload>,
  ): Promise<CheckpointCommitResult<TPayload>> {
    return this.#delegate.commit(request);
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
  readonly #expectedDataArtifacts: ReadonlyMap<
    string,
    AnalyticalSnapshotManifestV1['dataArtifacts'][number]
  >;
  readonly #verifiedDataArtifacts = new Map<string, Promise<string>>();

  public constructor(
    delegate: AnalyticalSession,
    artifacts: PortableLocalArtifactStore,
    manifest: AnalyticalSnapshotManifestV1,
  ) {
    this.#delegate = delegate;
    this.#artifacts = artifacts;
    this.#expectedDataArtifacts = new Map(
      manifest.dataArtifacts.map((artifact) => [artifact.uri, artifact]),
    );
  }

  public async execute<TRow extends AnalyticalRow = AnalyticalRow>(
    query: AnalyticalQuery,
  ): Promise<AnalyticalResult<TRow>> {
    const parameters = await Promise.all(
      query.parameters.map(async (value) => {
        if (typeof value !== 'string' || !value.startsWith('file://oracle-artifact/')) return value;
        const expected = this.#expectedDataArtifacts.get(value);
        if (expected === undefined) {
          throw new Error('Analytical query data artifact is absent from the snapshot manifest');
        }
        let verified = this.#verifiedDataArtifacts.get(value);
        if (verified === undefined) {
          verified = this.#artifacts.verify(value).then((stored) => {
            if (stored.byteSize !== expected.byteLength || stored.sha256 !== expected.sha256) {
              throw new Error('Analytical query data artifact failed snapshot integrity binding');
            }
            return this.#artifacts.physicalUri(value);
          });
          this.#verifiedDataArtifacts.set(value, verified);
        }
        return verified;
      }),
    );
    return this.#delegate.execute<TRow>({
      ...query,
      parameters,
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
          const binding = await readAnalyticalSnapshot(this.#artifacts, snapshot, signal);
          return Object.freeze({
            manifestBytes: binding.bytes,
            scanBytesByOperation: binding.manifest.scanBytesByOperation,
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
    const binding = await readAnalyticalSnapshot(this.#artifacts, snapshot, signal);
    return new RemappedAnalyticalSession(
      await (await this.#load()).open(snapshot, signal),
      this.#artifacts,
      binding.manifest,
    );
  }
}

async function readAnalyticalSnapshot(
  artifacts: PortableLocalArtifactStore,
  snapshot: AnalyticalSnapshot,
  signal?: AbortSignal,
): Promise<Readonly<{ bytes: Uint8Array; manifest: AnalyticalSnapshotManifestV1 }>> {
  signal?.throwIfAborted();
  const stored = await artifacts.verify(snapshot.manifestUri);
  if (stored.mediaType !== ANALYTICAL_SNAPSHOT_MANIFEST_MEDIA_TYPE) {
    throw new TypeError('Analytical snapshot requires a versioned derived manifest');
  }
  if (stored.byteSize < 1 || stored.byteSize > MAX_ANALYTICAL_SNAPSHOT_MANIFEST_BYTES) {
    throw new RangeError(
      `Analytical snapshot manifest exceeds ${MAX_ANALYTICAL_SNAPSHOT_MANIFEST_BYTES} bytes`,
    );
  }
  if (stored.sha256 !== snapshot.manifestSha256) {
    throw new Error('Analytical snapshot manifest metadata SHA-256 mismatch');
  }
  const bytes = new Uint8Array(stored.byteSize);
  let offset = 0;
  for await (const chunk of artifacts.read(snapshot.manifestUri)) {
    signal?.throwIfAborted();
    if (offset + chunk.byteLength > bytes.byteLength) {
      throw new Error('Analytical snapshot manifest exceeded its verified byte length');
    }
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== bytes.byteLength) {
    throw new Error('Analytical snapshot manifest ended before its verified byte length');
  }
  const manifest = parseAnalyticalSnapshotManifest(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
  );
  return Object.freeze({ bytes, manifest });
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
  const checkpointStore = new RetryableAcquisitionCheckpointStore(
    new LocalCheckpointStore({
      rootDirectory: resolve(outputDirectory, 'checkpoints'),
    }),
    () => clock.now(),
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
      checkpointStore,
      analyticalRuntime: new PipelineAnalyticalRuntime(artifactStore),
      http:
        fixture === undefined
          ? new FetchTransport(
              sourceConfig.fallback511?.authorization ?? [],
              sourceConfig.runtime.requestTimeoutMs,
              {
                headerTimeoutMs: (request) =>
                  pipelineHeaderTimeoutMs(request, sourceConfig.runtime.requestTimeoutMs),
              },
            )
          : new FixtureParcelTransport(fixture),
      clock,
      delay: new AbortableDelay(),
      processors:
        options.profile === 'full' || options.profile === 'incremental'
          ? createBoundedPipelineProcessors({
              outputDirectory,
              scratchDirectory: resolve(outputDirectory, 'bounded-processing'),
            })
          : createDefaultPipelineProcessors(),
      signal: controller.signal,
      ...(options.beforePhase === undefined ? {} : { beforePhase: options.beforePhase }),
    }),
  );
}
