import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type {
  BoundedProcessingBudget,
  ImmutableBoundedArtifact,
} from '@oracle/contracts/bounded-processing';
import { describe, expect, it } from 'vitest';

import { deriveRoofAge, type RoofAgeInput } from './property-intelligence/roof.js';
import {
  PERMIT_ID,
  PROPERTY_ID,
  completeCoverage,
  sourceObservation,
} from './property-intelligence/test-helpers.test-support.js';
import {
  BoundedFeatureBudgetError,
  BoundedFeatureIntegrityError,
  ProcessWideFeatureBudget,
  boundedFeatureValueSha256,
  runBoundedFeaturePartition as runBoundedFeaturePartitionPackage,
  type BoundedFeatureChunkIdentity,
  type BoundedFeatureChunkSink,
  type BoundedFeatureCursor,
  type BoundedFeatureBudgetCoordinator,
  type BoundedFeatureDurableCheckpoint,
  type BoundedFeatureInput,
  type BoundedFeatureOutput,
  type BoundedFeatureStageRequest,
  type BoundedFeatureStageResult,
} from './bounded-stage.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const GENERATION_ID = `sc:generation:${HASH_A}`;

function runBoundedFeaturePartition<TInput, TOutput>(
  request: BoundedFeatureStageRequest<TInput, TOutput>,
  sharedBudget: BoundedFeatureBudgetCoordinator = new ProcessWideFeatureBudget(request.budget),
): Promise<BoundedFeatureStageResult> {
  return runBoundedFeaturePartitionPackage(request, sharedBudget);
}

const BUDGET: BoundedProcessingBudget = Object.freeze({
  policyVersion: 'bounded-process-budget-v1',
  maxBufferedRecords: 2,
  maxBufferedBytes: 64 * 1024,
  maxRssBytes: 768 * 1024 * 1024,
  duckdbMemoryBytes: 256 * 1024 * 1024,
  runtimeReserveBytes: 128 * 1024 * 1024,
  maxOpenFiles: 32,
  maxWorkers: 1,
  maxRecordsPerOutputChunk: 2,
  maxBytesPerOutputChunk: 48 * 1024,
  rssSampleIntervalRecords: 1,
});

class ArrayCursor<T> implements BoundedFeatureCursor<T> {
  private index = 0;
  public closed = false;

  public constructor(private readonly values: readonly BoundedFeatureInput<T>[]) {}

  public peek(): Promise<Omit<BoundedFeatureInput<T>, 'value'> | null> {
    const value = this.values[this.index];
    if (value === undefined) return Promise.resolve(null);
    return Promise.resolve({
      partitionId: value.partitionId,
      ordinal: value.ordinal,
      sortKey: value.sortKey,
      byteSize: value.byteSize,
      contentSha256: value.contentSha256,
    });
  }

  public next(): Promise<BoundedFeatureInput<T> | null> {
    return Promise.resolve(this.values[this.index++] ?? null);
  }

  public close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

interface StoredChunk {
  readonly identity: BoundedFeatureChunkIdentity;
  readonly bytes: Uint8Array;
}

class MemoryStore {
  public readonly chunks: StoredChunk[] = [];

  public constructor(private readonly corruptCommit = false) {}

  public inspect(identity: BoundedFeatureChunkIdentity) {
    const stored = this.chunks.find((chunk) => chunk.identity.logicalKey === identity.logicalKey);
    if (stored === undefined) return Promise.resolve(null);
    return Promise.resolve(
      Object.freeze({
        uri: `file:///spill/${identity.logicalKey}`,
        byteSize: stored.bytes.byteLength,
        sha256: createHash('sha256').update(stored.bytes).digest('hex'),
      }),
    );
  }

  public async adopt(
    identity: BoundedFeatureChunkIdentity,
    expected: {
      readonly uri: string;
      readonly byteSize: number;
      readonly sha256: string;
    },
  ) {
    const inspected = await this.inspect(identity);
    if (
      inspected?.uri !== expected.uri ||
      inspected.byteSize !== expected.byteSize ||
      inspected.sha256 !== expected.sha256
    ) {
      throw new Error('orphan changed during adoption');
    }
    return inspected;
  }

  public open(identity: BoundedFeatureChunkIdentity): Promise<BoundedFeatureChunkSink> {
    const segments: Uint8Array[] = [];
    let aborted = false;
    const sink: BoundedFeatureChunkSink = {
      write: (segment) => {
        if (aborted) throw new Error('write after abort');
        segments.push(segment.slice());
        return Promise.resolve();
      },
      commit: () => {
        const bytes = Buffer.concat(segments);
        this.chunks.push(Object.freeze({ identity, bytes }));
        return Promise.resolve(
          Object.freeze({
            uri: `file:///spill/${identity.logicalKey}`,
            byteSize: bytes.byteLength,
            sha256: this.corruptCommit ? HASH_C : createHash('sha256').update(bytes).digest('hex'),
          }),
        );
      },
      abort: () => {
        aborted = true;
        segments.length = 0;
        return Promise.resolve();
      },
    };
    return Promise.resolve(sink);
  }
}

function input<T>(
  ordinal: number,
  sortKey: string,
  value: T,
  partitionId = 3,
): BoundedFeatureInput<T> {
  const canonicalByteSize = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  return Object.freeze({
    partitionId,
    ordinal,
    sortKey,
    byteSize: canonicalByteSize,
    contentSha256: boundedFeatureValueSha256(value),
    value,
  });
}

function roofInput(): RoofAgeInput {
  const observation = sourceObservation('permit', 'permit-1', {
    permitType: 'Reroof',
    description: 'Tear off and replace roof',
    status: 'Finaled',
    completedAt: '2005-06-01T00:00:00.000Z',
  });
  return Object.freeze({
    propertyId: PROPERTY_ID,
    asOf: '2026-07-17T00:00:00.000Z',
    permits: Object.freeze([
      Object.freeze({
        ...observation,
        permitId: PERMIT_ID,
        permitType: 'Reroof',
        description: 'Tear off and replace roof',
        status: 'Finaled',
        issuedAt: '2005-05-01T00:00:00.000Z',
        completedAt: '2005-06-01T00:00:00.000Z',
      }),
    ]),
    buildingAge: Object.freeze([]),
    permitCoverage: completeCoverage(),
  });
}

function baseRequest<TInput, TOutput>(options: {
  readonly values: readonly BoundedFeatureInput<TInput>[];
  readonly store: MemoryStore;
  readonly derive: (value: TInput, ordinal: number) => BoundedFeatureOutput<TOutput>;
  readonly partitionId?: number;
  readonly budget?: BoundedProcessingBudget;
  readonly resume?: BoundedFeatureDurableCheckpoint;
  readonly checkpoints?: BoundedFeatureDurableCheckpoint[];
  readonly artifacts?: ImmutableBoundedArtifact[];
}) {
  const checkpoints = options.checkpoints ?? [];
  const artifacts = options.artifacts ?? [];
  return {
    generationId: GENERATION_ID,
    partitionId: options.partitionId ?? 3,
    dataset: 'property_feature_evidence',
    artifactLogicalPrefix: `bounded/${GENERATION_ID}`,
    inputManifestSha256: HASH_B,
    outputSchemaSha256: HASH_C,
    sourceLineageSha256: HASH_A,
    licenseIdentitySha256: HASH_B,
    budget: options.budget ?? BUDGET,
    maxInputBytesPerRecord: 8 * 1024,
    maxOutputBytesPerRecord: 8 * 1024,
    cursor: new ArrayCursor(options.values),
    store: options.store,
    derive: (value: TInput, identity: Readonly<{ ordinal: number }>) =>
      options.derive(value, identity.ordinal),
    persistCheckpoint: (checkpoint: BoundedFeatureDurableCheckpoint) => {
      checkpoints.push(checkpoint);
      return Promise.resolve();
    },
    recordArtifact: (artifact: ImmutableBoundedArtifact) => {
      artifacts.push(artifact);
      return Promise.resolve();
    },
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    rssBytes: () => 200 * 1024 * 1024,
  };
}

function parsedRows(store: MemoryStore): readonly unknown[] {
  return store.chunks.flatMap(({ bytes }) =>
    new TextDecoder()
      .decode(bytes)
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown),
  );
}

describe('bounded feature partition stage', () => {
  it('has byte-for-byte semantic parity with the legacy roof golden result', async () => {
    const work = roofInput();
    const expected = deriveRoofAge(work);
    const store = new MemoryStore();
    const result = await runBoundedFeaturePartition(
      baseRequest({
        values: [input(0, `${PROPERTY_ID}\0roof_age`, work)],
        store,
        derive: (value) => ({
          sortKey: `${value.propertyId}\0roof_age`,
          visibility: deriveRoofAge(value).visibility,
          value: deriveRoofAge(value),
        }),
      }),
    );

    expect(parsedRows(store)).toEqual([JSON.parse(JSON.stringify(expected))]);
    expect(result.inputRecordCount).toBe(1);
    expect(result.outputRecordCount).toBe(1);
    expect(result.budget.peakBufferedRecords).toBe(1);
    expect(result.budget.bufferedBytes).toBe(0);
  });

  it('is deterministic across source batching, safe worker budgets, and independent stores', async () => {
    const values = [0, 1, 2, 3].map((ordinal) =>
      input(ordinal, `property-${ordinal.toString().padStart(2, '0')}\0roof_age`, {
        propertyId: `property-${ordinal}`,
        supportClass: ordinal % 2 === 0 ? 'supported' : 'unknown',
      }),
    );
    const run = async (maxWorkers: number) => {
      const store = new MemoryStore();
      const artifacts: ImmutableBoundedArtifact[] = [];
      const request = baseRequest({
        values,
        store,
        artifacts,
        budget: { ...BUDGET, maxWorkers, maxOpenFiles: maxWorkers + 8 },
        derive: (value, ordinal) => ({
          sortKey: `property-${ordinal.toString().padStart(2, '0')}\0roof_age`,
          visibility: ordinal < 2 ? 'public' : 'restricted',
          value,
        }),
      });
      const result = await runBoundedFeaturePartition(
        request,
        maxWorkers > 1 ? new ProcessWideFeatureBudget(request.budget) : undefined,
      );
      return {
        artifacts,
        bytes: store.chunks.map(({ bytes }) => Buffer.from(bytes).toString('hex')),
        result,
      };
    };

    const left = await run(1);
    const right = await run(3);
    expect(right.bytes).toEqual(left.bytes);
    expect(right.artifacts).toEqual(left.artifacts);
    expect(right.result.logicalSha256).toBe(left.result.logicalSha256);
  });

  it('emits identical partition artifacts regardless of worker scheduling order', async () => {
    const runOrder = async (partitions: readonly number[]) => {
      const artifacts: ImmutableBoundedArtifact[] = [];
      for (const partitionId of partitions) {
        const store = new MemoryStore();
        await runBoundedFeaturePartition(
          baseRequest({
            partitionId,
            values: [input(0, `property-${partitionId}\0roof_age`, { partitionId }, partitionId)],
            store,
            artifacts,
            derive: (value) => ({
              sortKey: `property-${value.partitionId}\0roof_age`,
              visibility: 'public',
              value,
            }),
          }),
        );
      }
      return artifacts.sort(
        (left, right) =>
          left.partitionId - right.partitionId ||
          left.sequence - right.sequence ||
          left.logicalKey.localeCompare(right.logicalKey),
      );
    };

    expect(await runOrder([5, 2])).toEqual(await runOrder([2, 5]));
  });

  it('accepts one plain structural budget coordinator across concurrent package workers', async () => {
    const processCoordinator = new ProcessWideFeatureBudget(BUDGET);
    let acquisitions = 0;
    let activeLeases = 0;
    const externalCoordinator: BoundedFeatureBudgetCoordinator = {
      acquire: (records, bytes) => {
        acquisitions += 1;
        const release = processCoordinator.acquire(records, bytes);
        activeLeases += 1;
        return () => {
          activeLeases -= 1;
          release();
        };
      },
      assertPolicy: (policy) => processCoordinator.assertPolicy(policy),
      snapshot: () => processCoordinator.snapshot(),
    };
    const worker = (partitionId: number) =>
      runBoundedFeaturePartition(
        baseRequest({
          partitionId,
          values: [input(0, `property-${partitionId}\0roof_age`, { partitionId }, partitionId)],
          store: new MemoryStore(),
          derive: (value) => {
            expect(activeLeases).toBeGreaterThan(0);
            return {
              sortKey: `property-${value.partitionId}\0roof_age`,
              visibility: 'public',
              value,
            };
          },
        }),
        externalCoordinator,
      );

    const results = await Promise.all([worker(2), worker(5)]);
    expect(results.map(({ outputRecordCount }) => outputRecordCount)).toEqual([1, 1]);
    expect(acquisitions).toBe(2);
    expect(activeLeases).toBe(0);
    expect(externalCoordinator.snapshot()).toMatchObject({ bufferedRecords: 0, bufferedBytes: 0 });
  });

  it('resumes from the last durable chunk without replaying an aborted chunk', async () => {
    const values = [0, 1, 2].map((ordinal) => input(ordinal, `key-${ordinal}`, { ordinal }));
    const budget = { ...BUDGET, maxRecordsPerOutputChunk: 1 };
    const store = new MemoryStore();
    const checkpoints: BoundedFeatureDurableCheckpoint[] = [];
    await expect(
      runBoundedFeaturePartition(
        baseRequest({
          values,
          store,
          checkpoints,
          budget,
          derive: (value, ordinal) => {
            if (ordinal === 2) throw new Error('injected crash');
            return { sortKey: `key-${ordinal}`, visibility: 'public', value };
          },
        }),
      ),
    ).rejects.toThrow(/injected crash/u);

    const durable = checkpoints.at(-1);
    expect(durable?.nextInputOrdinal).toBe(1);
    expect(store.chunks).toHaveLength(1);
    if (durable === undefined) throw new Error('Expected durable checkpoint');
    await expect(
      runBoundedFeaturePartition({
        ...baseRequest({
          values: values.slice(durable.nextInputOrdinal),
          store,
          budget,
          resume: durable,
          derive: (value, ordinal) => ({ sortKey: `key-${ordinal}`, visibility: 'public', value }),
        }),
        inputManifestSha256: HASH_C,
      }),
    ).rejects.toBeInstanceOf(BoundedFeatureIntegrityError);
    await runBoundedFeaturePartition(
      baseRequest({
        values: values.slice(durable.nextInputOrdinal),
        store,
        checkpoints,
        budget,
        resume: durable,
        derive: (value, ordinal) => ({ sortKey: `key-${ordinal}`, visibility: 'public', value }),
      }),
    );
    expect(parsedRows(store)).toEqual([{ ordinal: 0 }, { ordinal: 1 }, { ordinal: 2 }]);
    expect(store.chunks.map(({ identity }) => identity.sequence)).toEqual([0, 1, 2]);
  });

  it('inspects and adopts a byte-identical committed orphan after a checkpoint crash', async () => {
    const values = [input(0, 'key-0', { ordinal: 0 })];
    const store = new MemoryStore();
    const firstArtifacts: ImmutableBoundedArtifact[] = [];
    let crash = true;
    await expect(
      runBoundedFeaturePartition({
        ...baseRequest({
          values,
          store,
          artifacts: firstArtifacts,
          derive: (value) => ({ sortKey: 'key-0', visibility: 'public', value }),
        }),
        persistCheckpoint: () => {
          if (crash) throw new Error('checkpoint crash');
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow('checkpoint crash');
    expect(store.chunks).toHaveLength(1);
    crash = false;
    const replayArtifacts: ImmutableBoundedArtifact[] = [];
    await runBoundedFeaturePartition(
      baseRequest({
        values,
        store,
        artifacts: replayArtifacts,
        derive: (value) => ({ sortKey: 'key-0', visibility: 'public', value }),
      }),
    );
    expect(store.chunks).toHaveLength(1);
    expect(replayArtifacts).toEqual(firstArtifacts);
  });

  it('requires a shared coordinator and preallocation metadata even for one worker', async () => {
    const request = baseRequest({
      values: [input(0, 'key-0', { ordinal: 0 })],
      store: new MemoryStore(),
      budget: BUDGET,
      derive: (value) => ({ sortKey: 'key-0', visibility: 'public', value }),
    });
    await expect(
      runBoundedFeaturePartitionPackage(
        request as Parameters<typeof runBoundedFeaturePartitionPackage>[0],
        undefined as never,
      ),
    ).rejects.toBeInstanceOf(BoundedFeatureBudgetError);
    const cursorWithoutLookahead = {
      next: () => Promise.resolve(input(0, 'key-0', { ordinal: 0 })),
      close: () => Promise.resolve(),
    } as unknown as BoundedFeatureCursor<{ ordinal: number }>;
    await expect(
      runBoundedFeaturePartition(
        { ...request, cursor: cursorWithoutLookahead },
        new ProcessWideFeatureBudget(request.budget),
      ),
    ).rejects.toBeInstanceOf(BoundedFeatureBudgetError);

    await expect(
      runBoundedFeaturePartition(
        baseRequest({
          values: [input(0, 'key-0', { ordinal: 0 })],
          store: new MemoryStore(),
          derive: (value) => ({
            sortKey: 'key-0',
            visibility: 'public',
            value: { values: Array.from({ length: 257 }, () => value) },
          }),
        }),
      ),
    ).rejects.toBeInstanceOf(BoundedFeatureBudgetError);
  });

  it('rejects replay, missing ordinals, corrupt content, output disorder, and RSS excess', async () => {
    const cases = [
      input(1, 'key-1', { ordinal: 1 }),
      { ...input(0, 'key-0', { ordinal: 0 }), contentSha256: HASH_C },
    ];
    for (const value of cases) {
      await expect(
        runBoundedFeaturePartition(
          baseRequest({
            values: [value],
            store: new MemoryStore(),
            derive: (item) => ({ sortKey: 'key-0', visibility: 'public', value: item }),
          }),
        ),
      ).rejects.toBeInstanceOf(BoundedFeatureIntegrityError);
    }

    await expect(
      runBoundedFeaturePartition(
        baseRequest({
          values: [input(0, 'key-0', { ordinal: 0 }), input(1, 'key-1', { ordinal: 1 })],
          store: new MemoryStore(),
          derive: (value, ordinal) => ({
            sortKey: ordinal === 0 ? 'z' : 'a',
            visibility: 'public',
            value,
          }),
        }),
      ),
    ).rejects.toBeInstanceOf(BoundedFeatureIntegrityError);

    const request = baseRequest({
      values: [input(0, 'key-0', { ordinal: 0 })],
      store: new MemoryStore(),
      budget: { ...BUDGET, maxRssBytes: 400 * 1024 * 1024, duckdbMemoryBytes: 64 * 1024 * 1024 },
      derive: (value) => ({ sortKey: 'key-0', visibility: 'public', value }),
    });
    await expect(
      runBoundedFeaturePartition({ ...request, rssBytes: () => 500 * 1024 * 1024 }),
    ).rejects.toBeInstanceOf(BoundedFeatureBudgetError);

    await expect(
      runBoundedFeaturePartition(
        baseRequest({
          values: [input(0, 'key-0', { ordinal: 0 })],
          store: new MemoryStore(true),
          derive: (value) => ({ sortKey: 'key-0', visibility: 'public', value }),
        }),
      ),
    ).rejects.toBeInstanceOf(BoundedFeatureIntegrityError);
  });

  it('shares exact record/byte leases across workers and rejects oversized rows', async () => {
    const shared = new ProcessWideFeatureBudget(BUDGET);
    const release = shared.acquire(1, BUDGET.maxBufferedBytes);
    expect(() => shared.acquire(1, 1)).toThrow(BoundedFeatureBudgetError);
    release();
    expect(shared.snapshot()).toMatchObject({ bufferedRecords: 0, bufferedBytes: 0 });

    const tiny = { ...BUDGET, maxBufferedBytes: 32, maxBytesPerOutputChunk: 32 };
    await expect(
      runBoundedFeaturePartition(
        baseRequest({
          values: [input(0, 'key-0', { ordinal: 0 })],
          store: new MemoryStore(),
          budget: tiny,
          derive: (value) => ({
            sortKey: 'key-0',
            visibility: 'public',
            value: { ...value, pad: 'x'.repeat(64) },
          }),
        }),
      ),
    ).rejects.toBeInstanceOf(BoundedFeatureBudgetError);
  });

  it('keeps production code free of county collection and whole-file helpers', async () => {
    const source = await readFile(new URL('./bounded-stage.ts', import.meta.url), 'utf8');
    for (const forbidden of [
      /readAll/u,
      /readFile/u,
      /\.toArray\(/u,
      /\.all\(/u,
      /Promise\.all/u,
      /collect(?:Rows|All|County)/u,
    ]) {
      expect(source).not.toMatch(forbidden);
    }
  });
});
