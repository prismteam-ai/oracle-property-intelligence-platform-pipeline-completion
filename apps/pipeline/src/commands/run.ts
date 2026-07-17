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

const FIXED_INSTANT = '2026-07-17T13:00:00.000Z';
const FIXTURE_RELATIVE_PATH =
  'packages/testkit/src/sources/santa-clara-socrata-parcels/duplicate-apn.geojson';
const ORIGINAL_KEY_METADATA = 'oracleOriginalLogicalKey';

/** Keeps contract logical keys intact while making every path segment portable to Windows. */
class PortableLocalArtifactStore implements ArtifactStore {
  readonly #delegate: LocalArtifactStore;
  readonly #rootDirectory: string;

  public constructor(rootDirectory: string, now: () => string) {
    this.#rootDirectory = resolve(rootDirectory);
    this.#delegate = new LocalArtifactStore({ rootDirectory: this.#rootDirectory, now });
  }

  public async putImmutable(request: ImmutableArtifactWrite): Promise<StoredArtifact> {
    const stored = await this.#delegate.putImmutable({
      ...request,
      logicalKey: request.logicalKey
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/'),
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
    const safeKey = originalKey.split('/').map((segment) => encodeURIComponent(segment));
    return pathToFileURL(join(this.#rootDirectory, ...safeKey, 'body')).href;
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
  public async send(request: HttpRequest, signal: AbortSignal): Promise<HttpResponse> {
    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
      signal,
      ...(request.body === undefined ? {} : { body: request.body }),
    };
    const response = await fetch(request.url, init);
    return Object.freeze({
      status: response.status,
      headers: Object.freeze(Object.fromEntries(response.headers.entries())),
      body: response.body ?? oneChunk(new Uint8Array()),
    });
  }
}

const unusedAnalyticalRuntime = Object.freeze({
  open: () =>
    Promise.reject(new Error('The parcel fixture adapter does not invoke analytical SQL')),
});

export type RunCommandOptions = Readonly<{
  profile: RunProfileName;
  workspaceDirectory: string;
  outputDirectory: string;
  fixture: boolean;
  signal?: AbortSignal;
  beforePhase?: (phase: OrchestrationPhase, sourceId: SourceId | null) => void | Promise<void>;
}>;

export async function runCommand(options: RunCommandOptions): Promise<PipelineResult> {
  if (options.fixture && options.profile !== 'pilot' && options.profile !== 'discovery') {
    throw new TypeError('The committed networkless fixture is only valid for discovery or pilot');
  }
  const workspaceDirectory = resolve(options.workspaceDirectory);
  const outputDirectory = resolve(options.outputDirectory);
  const fixture = options.fixture
    ? new Uint8Array(await readFile(resolve(workspaceDirectory, FIXTURE_RELATIVE_PATH)))
    : undefined;
  const clock = options.fixture ? new FixedClock() : new SystemClock();
  const requestedAt = clock.now();
  const sourceDigest = createHash('sha256')
    .update(fixture ?? new TextEncoder().encode(`${requestedAt}|${SANTA_CLARA_PARCELS_API_ROOT}`))
    .digest('hex');
  const snapshotId = snapshotIdSchema.parse(
    `sc:snapshot:santa-clara-socrata-parcels:${sourceDigest}`,
  );
  const runDigest = createHash('sha256')
    .update(`oracle-pipeline-v1|${options.profile}|${snapshotId}|${requestedAt}`)
    .digest('hex');
  const runId = runIdSchema.parse(`sc:run:${runDigest}`);
  const controller = new AbortController();
  options.signal?.addEventListener('abort', () => controller.abort(options.signal?.reason), {
    once: true,
  });
  const artifactStore = new PortableLocalArtifactStore(resolve(outputDirectory, 'artifacts'), () =>
    clock.now(),
  );
  return runPipeline(
    Object.freeze({
      runId,
      pipelineVersion: '1.0.0',
      requestedAt,
      profile: createRunProfile(options.profile, {
        recordCap: options.profile === 'pilot' ? 50 : null,
        maxConcurrentSources: 2,
        maxBufferedRecords: 50,
      }),
      sources: Object.freeze([
        {
          adapter: createSantaClaraSocrataParcelsAdapter({
            pageSize: options.fixture ? 2 : 5_000,
          }) as unknown as SourceConfiguration['adapter'],
          snapshotId,
          limitations: Object.freeze([
            options.fixture
              ? 'Networkless pilot uses the committed official safe parcel excerpt; it is not county-completeness evidence.'
              : 'This command currently composes the authoritative parcel lane; other source lanes must be added before a full release claim.',
          ]),
        },
      ]),
      maximumPhaseAttempts: 2,
    }),
    Object.freeze({
      artifactStore,
      checkpointStore: new LocalCheckpointStore({
        rootDirectory: resolve(outputDirectory, 'checkpoints'),
      }),
      analyticalRuntime: unusedAnalyticalRuntime,
      http: fixture === undefined ? new FetchTransport() : new FixtureParcelTransport(fixture),
      clock,
      delay: new AbortableDelay(),
      processors: createDefaultPipelineProcessors(),
      signal: controller.signal,
      ...(options.beforePhase === undefined ? {} : { beforePhase: options.beforePhase }),
    }),
  );
}
