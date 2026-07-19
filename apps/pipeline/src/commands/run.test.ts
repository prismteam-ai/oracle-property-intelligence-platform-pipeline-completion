import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LocalArtifactStore } from '@oracle/artifacts/implementations/local-artifact-store';
import { LocalCheckpointStore } from '@oracle/artifacts/implementations/local-checkpoint-store';
import type { CanonicalMutation } from '@oracle/contracts/canonical/mutation';
import { runIdSchema, snapshotIdSchema, sourceIdSchema } from '@oracle/contracts/ids';
import {
  acquiredArtifactSchema,
  acquisitionPlanSchema,
  sourceDescriptorSchema,
  sourceRunSummarySchema,
  type AcquisitionPlan,
  type AcquisitionRequest,
  type SourceCheckpoint,
} from '@oracle/contracts/source';
import {
  createStreamingAcquiredArtifact,
  type AcquiredArtifactSource,
} from '@oracle/source-adapters/spi/acquired-artifact';
import type {
  Clock,
  DiscoveryResult,
  RecordValidation,
  SourceRunObservationV2,
  StreamingAcquisitionContext,
  StreamingSourceAdapter,
  ValidationContext,
} from '@oracle/source-adapters/spi/adapter';
import type { CsvDecodedRecord } from '@oracle/source-adapters/spi/decode';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runPipeline } from '../orchestration/runner.js';
import type {
  OrchestrationDependencies,
  PipelineConfiguration,
  PipelineProcessors,
  SourceConfiguration,
} from '../orchestration/types.js';
import {
  collectResponseHeaders,
  FetchTransport,
  isWithinAuthorizationScope,
  pipelineHeaderTimeoutMs,
  RedirectRejectedError,
  RetryableAcquisitionCheckpointStore,
  runCommand,
  usesBoundedPipelineProcessors,
} from './run.js';

const temporaryDirectories: string[] = [];
const WORKSPACE_DIRECTORY = fileURLToPath(new URL('../../../../', import.meta.url));
const SAN_JOSE_DOWNLOAD_URL =
  'https://data.sanjoseca.gov/dataset/fd9ceb0c-75e0-402e-9fe3-3f6e04f2c23f/resource/761b7ae8-3be1-4ad6-923d-c7af6404a904/download/buildingpermitsactive.csv';
const SAN_JOSE_S3_PATH =
  '/og-production-open-data-sanjoseca-892364687672/resources/761b7ae8-3be1-4ad6-923d-c7af6404a904/buildingpermitsactive.csv';

function response(
  status: number,
  url: string,
  headers: Readonly<Record<string, string>> = {},
  body: ReadableStream<Uint8Array> | null = null,
): Response {
  return {
    status,
    url,
    headers: new Headers(headers),
    body,
  } as Response;
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function delayedStream(
  delays: readonly number[],
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  let index = 0;
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const delay = delays[index];
      if (delay === undefined) {
        controller.close();
        return;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
      if (cancelled) return;
      if (signal?.aborted === true) {
        controller.error(signal.reason);
        return;
      }
      controller.enqueue(Uint8Array.of(index + 1));
      index += 1;
    },
    cancel() {
      cancelled = true;
    },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

const RESUME_INSTANT = '2026-07-18T00:00:00.000Z';

describe('production processor selection', () => {
  it('routes production pilots through bounded processing while preserving tiny fixtures', () => {
    expect(usesBoundedPipelineProcessors('pilot', false)).toBe(true);
    expect(usesBoundedPipelineProcessors('pilot', true)).toBe(false);
    expect(usesBoundedPipelineProcessors('full', false)).toBe(true);
    expect(usesBoundedPipelineProcessors('incremental', false)).toBe(true);
    expect(usesBoundedPipelineProcessors('discovery', false)).toBe(false);
  });
});

interface ResumeCounters {
  discover: number;
  plan: number;
  acquire: number;
  networkWrites: number;
  adoptedArtifacts: number;
}

function resumeCounters(): ResumeCounters {
  return { discover: 0, plan: 0, acquire: 0, networkWrites: 0, adoptedArtifacts: 0 };
}

class ResumeProofAdapter implements StreamingSourceAdapter<CsvDecodedRecord, CsvDecodedRecord> {
  readonly #slug: string;
  readonly #failAfterPrefix: boolean;
  readonly #itemCount: number;
  readonly #counters: ResumeCounters;
  readonly #sourceId;
  readonly #snapshotId;
  readonly #descriptor;

  public constructor(
    slug: string,
    counters: ResumeCounters,
    options: Readonly<{ itemCount: number; failAfterPrefix?: boolean }>,
  ) {
    this.#slug = slug;
    this.#counters = counters;
    this.#itemCount = options.itemCount;
    this.#failAfterPrefix = options.failAfterPrefix ?? false;
    this.#sourceId = sourceIdSchema.parse(`sc:source:${slug}`);
    this.#snapshotId = snapshotIdSchema.parse(`sc:snapshot:${slug}:${'a'.repeat(64)}`);
    this.#descriptor = sourceDescriptorSchema.parse({
      sourceId: this.#sourceId,
      contractVersion: '2.0.0',
      name: `Resume proof ${slug}`,
      authority: {
        authorityType: 'official_government',
        organization: 'Resume proof authority',
        jurisdiction: 'Santa Clara County, California',
        canonicalUrl: `https://${slug}.example.test/`,
        authorityRank: 1,
      },
      acquisitionMethod: 'bulk_download',
      encodings: ['csv'],
      entityKinds: ['test'],
      defaultVisibility: 'public',
      license: {
        licenseSnapshotId: `sc:license:${slug}:${'b'.repeat(64)}`,
        capturedAt: RESUME_INSTANT,
        title: 'Resume proof terms',
        canonicalUrl: `https://${slug}.example.test/terms`,
        termsSha256: 'b'.repeat(64),
        redistribution: 'approved',
        containsPersonalData: false,
        attribution: ['Resume proof authority'],
        limitations: [],
      },
      ratePolicy: {
        maxRequestsPerWindow: 10,
        windowMs: 1_000,
        maxConcurrency: 1,
        maxAttempts: 1,
        initialBackoffMs: 0,
        maxBackoffMs: 1,
        jitter: 'none',
        respectRetryAfter: true,
      },
      freshnessSemantics: 'Frozen resume proof snapshot',
    });
  }

  public describe() {
    return this.#descriptor;
  }

  public discover(): Promise<DiscoveryResult> {
    this.#counters.discover += 1;
    return Promise.resolve({
      sourceId: this.#sourceId,
      discoveredAt: RESUME_INSTANT,
      resources: Object.freeze(
        Array.from({ length: this.#itemCount }, (_, index) => ({
          requestKey: `item-${index}`,
          url: `https://${this.#slug}.example.test/item-${index}.csv`,
          sourceAsOf: { state: 'reported' as const, at: RESUME_INSTANT },
          expectedRecords: 1,
          mediaTypes: ['text/csv'],
          continuationToken: null,
        })),
      ),
      complete: true,
      limitations: [],
    });
  }

  public plan(request: AcquisitionRequest, discovery: DiscoveryResult): Promise<AcquisitionPlan> {
    this.#counters.plan += 1;
    return Promise.resolve(
      acquisitionPlanSchema.parse({
        sourceId: this.#sourceId,
        snapshotId: request.snapshotId,
        contractVersion: '2.0.0',
        plannedAt: RESUME_INSTANT,
        items: discovery.resources.map((resource, sequence) => ({
          requestKey: resource.requestKey,
          sequence,
          method: 'GET',
          url: resource.url,
          encoding: 'csv',
          expectedMediaTypes: ['text/csv'],
        })),
      }),
    );
  }

  public async *acquire(
    plan: AcquisitionPlan,
    _checkpoint: SourceCheckpoint | undefined,
    context: StreamingAcquisitionContext,
  ): AsyncIterable<AcquiredArtifactSource> {
    this.#counters.acquire += 1;
    for (const [ordinal, item] of plan.items.entries()) {
      const bytes = new TextEncoder().encode(`${this.#slug},${item.requestKey}\n`);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const logicalKey = `raw/resume-proof/${this.#slug}/${item.requestKey}.csv`;
      let stored = await context.artifactStore.headByLogicalKey(logicalKey);
      if (stored === undefined) {
        this.#counters.networkWrites += 1;
        stored = await context.artifactStore.putImmutableStreaming({
          logicalKey,
          mediaType: 'text/csv',
          body: bytes,
          expectedSha256: sha256,
          metadata: { sourceId: this.#sourceId, requestKey: item.requestKey },
          ifAbsent: true,
        });
      } else {
        this.#counters.adoptedArtifacts += 1;
      }
      const metadata = acquiredArtifactSchema.parse({
        artifactId: `sc:artifact:sha256:${stored.sha256}`,
        sourceId: this.#sourceId,
        snapshotId: plan.snapshotId,
        retrievedAt: RESUME_INSTANT,
        sourceAsOf: { state: 'reported', at: RESUME_INSTANT },
        request: {
          requestKey: item.requestKey,
          method: 'GET',
          url: item.url,
          headers: [],
          bodySha256: null,
          attempt: 1,
        },
        response: { httpStatus: 200, etag: null, lastModified: null, finalUrl: item.url },
        mediaType: 'text/csv',
        encoding: 'csv',
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        schemaFingerprint: {
          algorithm: 'sha256',
          value: 'c'.repeat(64),
          schemaName: 'resume-proof-csv-v1',
          canonicalizationVersion: '1.0.0',
        },
        rawUri: stored.uri,
        licenseSnapshotRef: this.#descriptor.license.licenseSnapshotId,
        visibility: 'public',
      });
      yield await createStreamingAcquiredArtifact(metadata, context.artifactStore);
      if (this.#failAfterPrefix && ordinal === 0) {
        throw Object.assign(new Error('injected acquisition failure after durable prefix'), {
          code: 'TRANSIENT_SOURCE',
          retryable: true,
        });
      }
    }
  }

  public async *decode(artifact: AcquiredArtifactSource): AsyncIterable<CsvDecodedRecord> {
    yield await Promise.resolve({
      format: 'csv',
      artifactId: artifact.metadata.artifactId,
      ordinal: 0,
      visibility: 'public',
      header: ['value'],
      values: ['resume-proof'],
    });
  }

  public validate(
    record: CsvDecodedRecord,
    context: ValidationContext,
  ): Promise<RecordValidation<CsvDecodedRecord>> {
    context.signal.throwIfAborted();
    return Promise.resolve({ status: 'accepted', record, issues: [] });
  }

  public async *normalize(record: CsvDecodedRecord): AsyncIterable<CanonicalMutation> {
    yield await Promise.resolve(
      Object.freeze({
        kind: 'resume_proof_mutation',
        id: `${this.#slug}-${record.ordinal}`,
      }) as unknown as CanonicalMutation,
    );
  }

  public summarize(run: SourceRunObservationV2) {
    return Promise.resolve(
      sourceRunSummarySchema.parse({
        sourceId: this.#sourceId,
        snapshotId: this.#snapshotId,
        runId: run.runId,
        contractVersion: '2.0.0',
        status: 'succeeded',
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        artifactsAcquired: run.artifacts.length,
        bytesAcquired: run.artifacts.reduce((sum, artifact) => sum + artifact.byteSize, 0),
        decodedRecords: run.decodedRecords,
        acceptedRecords: run.acceptedRecords,
        rejectedRecords: run.rejectedRecords,
        normalizedMutations: run.mutations.count,
        visibilityCounts: {
          public: run.mutations.count,
          authenticated: 0,
          restricted: 0,
          prohibited_public: 0,
        },
        warningCount: 0,
        errorCount: 0,
        finalCheckpoint: run.finalCheckpoint,
      }),
    );
  }
}

function resumeSource(adapter: ResumeProofAdapter): SourceConfiguration {
  return {
    adapter,
    snapshotId: snapshotIdSchema.parse(
      `${adapter.describe().sourceId.replace('sc:source:', 'sc:snapshot:')}:${'a'.repeat(64)}`,
    ),
    scope: 'resume integration proof',
    capability: `resume_${adapter.describe().sourceId}`,
    executionMode: 'execute',
    supportState: 'available',
    acquisitionItemCap: null,
    discoveryDenominatorStrategy: 'sum_non_null',
    requiredForCountyCompletion: false,
  };
}

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `oracle-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  // Test-created paths are kept until process cleanup so failed runs remain inspectable.
  temporaryDirectories.length = 0;
});

describe('executable pipeline commands', () => {
  it('rejects a requested instant later than the runtime clock', async () => {
    await expect(
      runCommand({
        profile: 'pilot',
        fixture: true,
        requestedAt: '2026-07-17T13:00:00.001Z',
        workspaceDirectory: WORKSPACE_DIRECTORY,
        outputDirectory: await temporaryDirectory('future-request'),
      }),
    ).rejects.toThrow('requestedAt cannot be later than the current runtime clock');
  });

  it('preserves duplicate response cookies for stateful portal adapters', () => {
    const headers = new Headers({ 'x-source': 'test' });
    headers.append('set-cookie', 'session=one; Path=/');
    headers.append('set-cookie', 'route=two; Path=/');
    expect(collectResponseHeaders(headers)).toEqual({
      'set-cookie': 'session=one; Path=/,route=two; Path=/',
      'x-source': 'test',
    });
  });

  it('matches authorization only within the configured feed origin and path boundary', () => {
    const scope = 'https://api.511.org/transit/datafeeds';
    expect(isWithinAuthorizationScope(scope, scope)).toBe(true);
    expect(isWithinAuthorizationScope(`${scope}/vta`, scope)).toBe(true);
    expect(isWithinAuthorizationScope('https://api.511.org/transit/datafeeds-evil', scope)).toBe(
      false,
    );
    expect(
      isWithinAuthorizationScope('https://unrelated.example.test/transit/datafeeds', scope),
    ).toBe(false);
  });

  it('uses manual redirects, rejects 3xx, and reports the transport final URL', async () => {
    const originalFetch = globalThis.fetch;
    const calls: RequestInit[] = [];
    try {
      globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
        calls.push(init ?? {});
        return Promise.resolve({
          status: 302,
          headers: new Headers({ location: '/moved' }),
          body: null,
          url: 'https://source.example.test/original',
        });
      }) as typeof fetch;
      const transport = new FetchTransport([], 1_000);
      await expect(
        transport.send(
          { method: 'GET', url: 'https://source.example.test/original', headers: {} },
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(RedirectRejectedError);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.redirect).toBe('manual');

      globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
        calls.push(init ?? {});
        return Promise.resolve({
          status: 200,
          headers: new Headers(),
          body: null,
          url: 'https://source.example.test/canonical',
        });
      }) as typeof fetch;
      const response = await transport.send(
        { method: 'GET', url: 'https://source.example.test/original', headers: {} },
        new AbortController().signal,
      );
      expect(response.finalUrl).toBe('https://source.example.test/canonical');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('follows only the official San Jose download redirect and strips cross-origin secrets', async () => {
    const originalFetch = globalThis.fetch;
    const signedTarget = `https://s3.amazonaws.com${SAN_JOSE_S3_PATH}?X-Amz-Credential=secret&X-Amz-Signature=never-log-this`;
    const calls: Readonly<{ input: string; headers: Headers; redirect: string }>[] = [];
    try {
      globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          input: requestUrl(input),
          headers: new Headers(init?.headers),
          redirect: init?.redirect ?? 'follow',
        });
        if (calls.length === 1) {
          return Promise.resolve(response(302, SAN_JOSE_DOWNLOAD_URL, { location: signedTarget }));
        }
        return Promise.resolve(
          response(200, signedTarget, { 'content-type': 'text/csv' }, delayedStream([0])),
        );
      };
      const transport = new FetchTransport(
        [
          {
            urlPrefix: 'https://data.sanjoseca.gov/',
            headerName: 'x-source-token',
            environmentVariable: 'TEST_SAN_JOSE_TOKEN',
          },
        ],
        1_000,
      );
      process.env.TEST_SAN_JOSE_TOKEN = 'source-secret';
      const result = await transport.send(
        {
          method: 'GET',
          url: SAN_JOSE_DOWNLOAD_URL,
          headers: {
            accept: 'text/csv',
            authorization: 'Bearer secret',
            cookie: 'session=secret',
            'x-api-key': 'secret',
            'x-auth-token': 'future-secret',
            'x-future-credential': 'future-secret',
          },
        },
        new AbortController().signal,
      );
      expect(await collect(result.body)).toEqual(Uint8Array.of(1));
      expect(calls).toHaveLength(2);
      expect(calls.every(({ redirect }) => redirect === 'manual')).toBe(true);
      expect(calls[1]?.input).toBe(signedTarget);
      expect(calls[1]?.headers.get('accept')).toBe('text/csv');
      expect(calls[1]?.headers.get('authorization')).toBeNull();
      expect(calls[1]?.headers.get('cookie')).toBeNull();
      expect(calls[1]?.headers.get('x-api-key')).toBeNull();
      expect(calls[1]?.headers.get('x-auth-token')).toBeNull();
      expect(calls[1]?.headers.get('x-future-credential')).toBeNull();
      expect(calls[1]?.headers.get('x-source-token')).toBeNull();
      expect(result.finalUrl).toBe(`https://s3.amazonaws.com${SAN_JOSE_S3_PATH}`);
      expect(result.finalUrl).not.toContain('secret');
    } finally {
      delete process.env.TEST_SAN_JOSE_TOKEN;
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects redirect downgrades, foreign targets, path escapes, POSTs, and second hops', async () => {
    const originalFetch = globalThis.fetch;
    const validTarget = `https://s3.amazonaws.com${SAN_JOSE_S3_PATH}?X-Amz-Signature=never-log-this`;
    const cases = [
      { method: 'GET' as const, location: validTarget.replace('https:', 'http:'), calls: 1 },
      {
        method: 'GET' as const,
        location: validTarget.replace('s3.amazonaws.com', 'attacker.example.test'),
        calls: 1,
      },
      {
        method: 'GET' as const,
        location: 'https://s3.amazonaws.com/other-bucket/resources/file.csv',
        calls: 1,
      },
      { method: 'POST' as const, location: validTarget, calls: 1 },
      { method: 'GET' as const, location: validTarget, calls: 2, secondHop: true },
    ];
    try {
      for (const testCase of cases) {
        let calls = 0;
        globalThis.fetch = (input: string | URL | Request) => {
          calls += 1;
          return Promise.resolve(
            response(302, requestUrl(input), {
              location:
                testCase.secondHop === true && calls === 2
                  ? SAN_JOSE_DOWNLOAD_URL
                  : testCase.location,
            }),
          );
        };
        const transport = new FetchTransport([], 1_000);
        const rejected = transport.send(
          {
            method: testCase.method,
            url: SAN_JOSE_DOWNLOAD_URL,
            headers: {},
            ...(testCase.method === 'POST' ? { body: Uint8Array.of(1) } : {}),
          },
          new AbortController().signal,
        );
        await expect(rejected).rejects.toBeInstanceOf(RedirectRejectedError);
        await expect(rejected).rejects.not.toThrow('never-log-this');
        expect(calls).toBe(testCase.calls);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('bounds headers separately while allowing a progressing Overture body past the total window', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (input: string | URL | Request) =>
        Promise.resolve(response(200, requestUrl(input), {}, delayedStream([15, 15, 15])));
      const transport = new FetchTransport([], 25);
      const acquired = await transport.send(
        {
          method: 'GET',
          url: 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/pinned.parquet',
          headers: {},
        },
        new AbortController().signal,
      );
      expect(await collect(acquired.body)).toEqual(Uint8Array.of(1, 2, 3));

      globalThis.fetch = (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () =>
              reject(
                init.signal?.reason instanceof Error
                  ? init.signal.reason
                  : new DOMException('Operation aborted', 'AbortError'),
              ),
            { once: true },
          );
        });
      await expect(
        new FetchTransport([], 10).send(
          { method: 'HEAD', url: 'https://source.example.test/slow-headers', headers: {} },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ name: 'AbortError', message: 'Response headers timed out' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('aborts a stalled body on idle timeout and preserves caller cancellation', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (input: string | URL | Request, init?: RequestInit) =>
        Promise.resolve(
          response(200, requestUrl(input), {}, delayedStream([100], init?.signal ?? undefined)),
        );
      const stalled = await new FetchTransport([], 10).send(
        { method: 'GET', url: 'https://source.example.test/stalled', headers: {} },
        new AbortController().signal,
      );
      await expect(collect(stalled.body)).rejects.toMatchObject({
        name: 'AbortError',
        message: 'Response body made no progress',
      });

      const caller = new AbortController();
      const pending = await new FetchTransport([], 1_000).send(
        { method: 'GET', url: 'https://source.example.test/cancelled', headers: {} },
        caller.signal,
      );
      const consumed = collect(pending.body);
      caller.abort(new DOMException('caller stopped', 'AbortError'));
      await expect(consumed).rejects.toMatchObject({
        name: 'AbortError',
        message: 'caller stopped',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('cancels repeated retry/error bodies and releases global abort listeners without consumption', async () => {
    const originalFetch = globalThis.fetch;
    const caller = new AbortController();
    const removeListener = vi.spyOn(caller.signal, 'removeEventListener');
    let cancellations = 0;
    try {
      globalThis.fetch = (input: string | URL | Request) =>
        Promise.resolve(
          response(
            cancellations === 0 ? 429 : 503,
            requestUrl(input),
            { 'retry-after': '0' },
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(Uint8Array.of(1));
              },
              cancel() {
                cancellations += 1;
              },
            }),
          ),
        );
      const transport = new FetchTransport([], 1_000);
      const first = await transport.send(
        { method: 'GET', url: 'https://source.example.test/retry-1', headers: {} },
        caller.signal,
      );
      const second = await transport.send(
        { method: 'GET', url: 'https://source.example.test/retry-2', headers: {} },
        caller.signal,
      );
      expect(first.status).toBe(429);
      expect(second.status).toBe(503);
      expect(cancellations).toBe(2);
      expect(removeListener.mock.calls.filter(([eventName]) => eventName === 'abort')).toHaveLength(
        2,
      );
    } finally {
      removeListener.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  it('extends only a marked CSLB final-export header phase and never transmits the control hint', async () => {
    const originalFetch = globalThis.fetch;
    const transmitted: Headers[] = [];
    try {
      globalThis.fetch = (input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((resolveResponse, reject) => {
          transmitted.push(new Headers(init?.headers));
          const timer = setTimeout(() => resolveResponse(response(200, requestUrl(input))), 30);
          init?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(
                init.signal?.reason instanceof Error
                  ? init.signal.reason
                  : new DOMException('Operation aborted', 'AbortError'),
              );
            },
            { once: true },
          );
        });
      const transport = new FetchTransport([], 10, {
        headerTimeoutMs: (request) => (pipelineHeaderTimeoutMs(request, 10) === 120_000 ? 80 : 10),
      });
      const finalExportBody = new TextEncoder().encode(
        new URLSearchParams({
          __EVENTTARGET: 'ctl00$MainContent$lbMasterCSV',
          __EVENTARGUMENT: '',
          __VIEWSTATE: 'view-state',
          __EVENTVALIDATION: 'event-validation',
          ctl00$MainContent$ddlStatus: 'M',
        }).toString(),
      );
      await expect(
        transport.send(
          {
            method: 'POST',
            url: 'https://web.cslb.ca.gov/onlineservices/dataportal/ContractorList',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              'x-oracle-header-timeout-ms': '120000',
            },
            body: finalExportBody,
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ status: 200 });
      expect(transmitted[0]?.has('x-oracle-header-timeout-ms')).toBe(false);

      await expect(
        transport.send(
          {
            method: 'POST',
            url: 'https://web.cslb.ca.gov/onlineservices/dataportal/ContractorList',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              'x-oracle-header-timeout-ms': '120000',
            },
            body: Uint8Array.of(1),
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ name: 'AbortError', message: 'Response headers timed out' });
      expect(
        pipelineHeaderTimeoutMs(
          {
            method: 'GET',
            url: 'https://web.cslb.ca.gov/onlineservices/dataportal/ContractorList',
            headers: { 'x-oracle-header-timeout-ms': '120000' },
          },
          10,
        ),
      ).toBe(10);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('retries a failed exact run while completed sources stay skipped and durable chunks are adopted', async () => {
    const root = await temporaryDirectory('exact-f4-resume');
    const artifacts = new LocalArtifactStore({
      rootDirectory: join(root, 'artifacts'),
      now: () => RESUME_INSTANT,
    });
    const persistedCheckpoints = new LocalCheckpointStore({
      rootDirectory: join(root, 'checkpoints'),
    });
    const checkpoints = new RetryableAcquisitionCheckpointStore(
      persistedCheckpoints,
      () => RESUME_INSTANT,
    );
    const processors: PipelineProcessors = {
      memoryProfile: 'bounded_streaming_v2',
      reconcile: async (mutations) => {
        let count = 0;
        for await (const mutation of mutations.read()) {
          void mutation;
          count += 1;
        }
        return { canonical: { count }, links: [] };
      },
      deriveFeatures: () => Promise.resolve({}),
      buildMarts: () => Promise.resolve({}),
    };
    const dependencies = (controller: AbortController): OrchestrationDependencies => ({
      artifactStore: artifacts,
      checkpointStore: checkpoints,
      analyticalRuntime: { open: () => Promise.reject(new Error('analytical runtime not used')) },
      http: { send: () => Promise.reject(new Error('HTTP not used')) },
      clock: { now: () => RESUME_INSTANT } satisfies Clock,
      delay: { wait: () => Promise.resolve() },
      processors,
      signal: controller.signal,
    });
    const runId = runIdSchema.parse(`sc:run:${'f'.repeat(64)}`);
    const configuration = (
      complete: ResumeProofAdapter,
      retrying: ResumeProofAdapter,
    ): PipelineConfiguration => ({
      runId,
      pipelineVersion: 'exact-resume-proof-v2',
      requestedAt: RESUME_INSTANT,
      profile: {
        name: 'pilot',
        recordCap: null,
        maxConcurrentSources: 2,
        maxBufferedRecords: 2,
      },
      sources: [resumeSource(complete), resumeSource(retrying)],
      maximumPhaseAttempts: 1,
    });

    const firstCompleteCounters = resumeCounters();
    const firstRetryCounters = resumeCounters();
    const firstComplete = new ResumeProofAdapter('resume-complete', firstCompleteCounters, {
      itemCount: 1,
    });
    const firstRetry = new ResumeProofAdapter('santa-clara-parcel-f4', firstRetryCounters, {
      itemCount: 2,
      failAfterPrefix: true,
    });
    const first = await runPipeline(
      configuration(firstComplete, firstRetry),
      dependencies(new AbortController()),
    );
    expect(first.manifest).toMatchObject({
      runId,
      requestedAt: RESUME_INSTANT,
      status: 'partial',
      sources: [
        { sourceId: firstComplete.describe().sourceId, terminalState: 'complete' },
        { sourceId: firstRetry.describe().sourceId, terminalState: 'failed' },
      ],
    });
    expect(firstCompleteCounters).toMatchObject({ discover: 1, plan: 1, acquire: 1 });
    expect(firstRetryCounters).toMatchObject({
      discover: 1,
      plan: 1,
      acquire: 1,
      networkWrites: 1,
    });
    const finalized = await persistedCheckpoints.load(`pipeline-run:${runId}`);
    const finalizedPayload = finalized?.payload as unknown as {
      sources: readonly {
        sourceId: string;
        snapshotId: string;
        acquisitionChunks: readonly unknown[];
      }[];
    };
    const failedBeforeResume = finalizedPayload.sources.find(
      ({ sourceId }) => sourceId === firstRetry.describe().sourceId,
    );
    expect(failedBeforeResume).toMatchObject({
      snapshotId: resumeSource(firstRetry).snapshotId,
      acquisitionChunks: [expect.any(Object)],
    });

    const resumedCompleteCounters = resumeCounters();
    const resumedRetryCounters = resumeCounters();
    const resumedComplete = new ResumeProofAdapter('resume-complete', resumedCompleteCounters, {
      itemCount: 1,
    });
    const resumedRetry = new ResumeProofAdapter('santa-clara-parcel-f4', resumedRetryCounters, {
      itemCount: 2,
    });
    const resumed = await runPipeline(
      configuration(resumedComplete, resumedRetry),
      dependencies(new AbortController()),
    );
    expect(resumed.manifest).toMatchObject({
      runId: first.manifest.runId,
      requestedAt: first.manifest.requestedAt,
      configurationHash: first.manifest.configurationHash,
      status: 'succeeded',
    });
    expect(resumedCompleteCounters).toEqual(resumeCounters());
    expect(resumedRetryCounters).toMatchObject({
      discover: 0,
      plan: 0,
      acquire: 1,
      adoptedArtifacts: 1,
      networkWrites: 1,
    });
    const resumedSource = resumed.manifest.sources.find(
      ({ sourceId }) => sourceId === resumedRetry.describe().sourceId,
    );
    expect(resumedSource).toMatchObject({
      snapshotId: failedBeforeResume?.snapshotId,
      terminalState: 'complete',
      coverage: { observedRecords: 2, acceptedRecords: 2 },
    });
    const completed = await persistedCheckpoints.load(`pipeline-run:${runId}`);
    const completedPayload = completed?.payload as unknown as {
      sources: readonly { sourceId: string; acquisitionChunks: readonly unknown[] }[];
    };
    expect(
      completedPayload.sources.find(({ sourceId }) => sourceId === resumedRetry.describe().sourceId)
        ?.acquisitionChunks,
    ).toHaveLength(2);
  });

  it('runs every real parcel-adapter phase and the real reducer, reconciliation, feature, and mart processors', async () => {
    const result = await runCommand({
      profile: 'pilot',
      fixture: true,
      workspaceDirectory: WORKSPACE_DIRECTORY,
      outputDirectory: await temporaryDirectory('phases'),
    });

    expect(result.manifest.status).toBe('succeeded');
    expect(result.manifest.sources).toHaveLength(1);
    const source = result.manifest.sources[0];
    expect(source?.terminalState).toBe('complete');
    expect(source?.coverage).toMatchObject({
      expectedRecords: 2,
      observedRecords: 2,
      acceptedRecords: 2,
      quarantinedRecords: 0,
      ratio: 1,
    });
    expect(source?.timings.map(({ phase }) => phase)).toEqual([
      'discover',
      'plan',
      'acquire',
      'decode',
      'validate',
      'normalize',
      'summarize',
    ]);
    expect(result.manifest.artifacts.map(({ phase }) => phase)).toEqual([
      'reconcile',
      'derive_features',
      'build_marts',
    ]);
    expect(source?.summary?.normalizedMutations).toBeGreaterThan(0);
    expect(source?.sourceHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(source?.schemaHashes).toHaveLength(1);
    expect(source?.snapshotIdentity.observedContentId).toMatch(
      /^sc:snapshot:santa-clara-socrata-parcels:[a-f0-9]{64}$/u,
    );
    expect(result.manifest.countyCompletion).toMatchObject({
      state: 'not_applicable',
      claim: 'pilot is not a county-completion profile.',
    });
  });

  it('runs discovery without acquiring or claiming loaded records', async () => {
    const result = await runCommand({
      profile: 'discovery',
      fixture: true,
      workspaceDirectory: WORKSPACE_DIRECTORY,
      outputDirectory: await temporaryDirectory('discovery'),
    });
    expect(result.manifest.status).toBe('succeeded');
    expect(result.manifest.sources[0]?.coverage.observedRecords).toBe(0);
    expect(result.manifest.sources[0]?.artifacts.map(({ phase }) => phase)).toEqual(['discover']);
    expect(result.manifest.artifacts).toEqual([]);
    expect(result.manifest.countyCompletion.state).toBe('not_applicable');
  });

  it('checkpoints an interruption and resumes without replaying durable phases', async () => {
    const outputDirectory = await temporaryDirectory('resume');
    const controller = new AbortController();
    const visited: string[] = [];
    await expect(
      runCommand({
        profile: 'pilot',
        fixture: true,
        workspaceDirectory: WORKSPACE_DIRECTORY,
        outputDirectory,
        signal: controller.signal,
        beforePhase: (phase) => {
          visited.push(phase);
          if (phase === 'decode')
            controller.abort(new DOMException('test interruption', 'AbortError'));
        },
      }),
    ).rejects.toThrow('test interruption');
    expect(visited).toContain('acquire');

    const resumedPhases: string[] = [];
    const resumed = await runCommand({
      profile: 'pilot',
      fixture: true,
      workspaceDirectory: WORKSPACE_DIRECTORY,
      outputDirectory,
      beforePhase: (phase) => {
        resumedPhases.push(phase);
      },
    });
    expect(resumed.manifest.status).toBe('succeeded');
    expect(resumedPhases).not.toContain('discover');
    expect(resumedPhases).not.toContain('plan');
    expect(resumedPhases).not.toContain('acquire');
    expect(resumedPhases).toContain('decode');
  });

  it('returns the immutable completed run on duplicate replay', async () => {
    const outputDirectory = await temporaryDirectory('replay');
    const first = await runCommand({
      profile: 'pilot',
      fixture: true,
      workspaceDirectory: WORKSPACE_DIRECTORY,
      outputDirectory,
    });
    const phases: string[] = [];
    const replay = await runCommand({
      profile: 'pilot',
      fixture: true,
      workspaceDirectory: WORKSPACE_DIRECTORY,
      outputDirectory,
      beforePhase: (phase) => {
        phases.push(phase);
      },
    });
    expect(replay.manifestArtifact.sha256).toBe(first.manifestArtifact.sha256);
    expect(replay.manifest).toEqual(first.manifest);
    expect(phases).toEqual([]);
  });

  it('produces byte-identical manifests in independent clean output directories', async () => {
    const first = await runCommand({
      profile: 'pilot',
      fixture: true,
      workspaceDirectory: WORKSPACE_DIRECTORY,
      outputDirectory: await temporaryDirectory('determinism-a'),
    });
    const second = await runCommand({
      profile: 'pilot',
      fixture: true,
      workspaceDirectory: WORKSPACE_DIRECTORY,
      outputDirectory: await temporaryDirectory('determinism-b'),
    });
    expect(second.manifestArtifact.sha256).toBe(first.manifestArtifact.sha256);
    expect(second.manifest).toEqual(first.manifest);
    expect(first.manifest.backpressure).toEqual({
      maxConcurrentSources: 2,
      maxBufferedRecords: 50,
      observedHighWaterRecords: 50,
      observedHighWaterActiveRecords: 1,
      observedHighWaterBufferedEvents: 49,
      observedHighWaterCombinedRecordsAndEvents: 50,
      activeRecordsAtCompletion: 0,
      bufferedEventsAtCompletion: 0,
      // Includes permits used to materialize the truthful mutation/validation physical projections,
      // not only the canonical normalization-event stream.
      totalBudgetAcquisitions: 116,
    });
  });

  it('binds the networkless run to the committed real official excerpt bytes', async () => {
    const bytes = await readFile(
      resolve(
        WORKSPACE_DIRECTORY,
        'packages/testkit/src/sources/santa-clara-socrata-parcels/duplicate-apn.geojson',
      ),
    );
    const fixtureHash = createHash('sha256').update(bytes).digest('hex');
    const result = await runCommand({
      profile: 'pilot',
      fixture: true,
      workspaceDirectory: WORKSPACE_DIRECTORY,
      outputDirectory: await temporaryDirectory('fixture-hash'),
    });
    expect(result.manifest.sources[0]?.snapshotId).toBe(
      `sc:snapshot:santa-clara-socrata-parcels:${fixtureHash}`,
    );
  });
});
