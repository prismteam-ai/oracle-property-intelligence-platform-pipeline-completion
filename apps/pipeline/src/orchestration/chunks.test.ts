import { createHash } from 'node:crypto';

import type {
  ArtifactByteRange,
  ImmutableArtifactWrite,
  RecoverableArtifactStore,
  StoredArtifact,
  StreamingImmutableArtifactWrite,
} from '@oracle/artifacts/artifact-store';
import { createSharedRecordBudget } from '@oracle/source-adapters/spi/record-budget';
import { describe, expect, it } from 'vitest';

import {
  CanonicalChunkWriter,
  ChunkIntegrityError,
  openChunkSequence,
  type ChunkReference,
} from './chunks.js';

class MemoryStore implements RecoverableArtifactStore {
  readonly records = new Map<string, { stored: StoredArtifact; bytes: Uint8Array }>();
  failBeforeNextWrite = false;
  failAfterNextWrite = false;

  public putImmutable(request: ImmutableArtifactWrite): Promise<StoredArtifact> {
    return this.putImmutableStreaming(request);
  }

  public async putImmutableStreaming(
    request: StreamingImmutableArtifactWrite,
  ): Promise<StoredArtifact> {
    if (this.failBeforeNextWrite) {
      this.failBeforeNextWrite = false;
      throw new Error('crash before chunk write');
    }
    if (this.records.has(request.logicalKey)) throw new Error('immutable conflict');
    const chunks: Uint8Array[] = [];
    for await (const chunk of request.body as AsyncIterable<Uint8Array>) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (request.expectedSha256 !== undefined && request.expectedSha256 !== sha256) {
      throw new Error('hash mismatch');
    }
    const stored = Object.freeze({
      logicalKey: request.logicalKey,
      uri: `memory://${encodeURIComponent(request.logicalKey)}`,
      mediaType: request.mediaType,
      byteSize: bytes.byteLength,
      sha256,
      storedAt: '2026-07-18T00:00:00.000Z',
      metadata: request.metadata,
    });
    this.records.set(request.logicalKey, { stored, bytes });
    if (this.failAfterNextWrite) {
      this.failAfterNextWrite = false;
      throw new Error('crash before checkpoint');
    }
    return stored;
  }

  public head(uri: string): Promise<StoredArtifact | undefined> {
    return Promise.resolve(
      [...this.records.values()].find(({ stored }) => stored.uri === uri)?.stored,
    );
  }

  public headByLogicalKey(logicalKey: string): Promise<StoredArtifact | undefined> {
    const item = this.records.get(logicalKey);
    if (item === undefined) return Promise.resolve(undefined);
    const hash = createHash('sha256').update(item.bytes).digest('hex');
    if (hash !== item.stored.sha256) throw new ChunkIntegrityError('corrupt body');
    return Promise.resolve(item.stored);
  }

  public async *read(uri: string, range?: ArtifactByteRange): AsyncIterable<Uint8Array> {
    const item = [...this.records.values()].find(({ stored }) => stored.uri === uri);
    if (item === undefined) throw new Error('missing');
    yield await Promise.resolve(
      range === undefined ? item.bytes : item.bytes.slice(range.start, range.endInclusive + 1),
    );
  }
}

async function write(
  store: MemoryStore,
  maximumRecordsPerChunk: number,
  values: readonly Readonly<{ ordinal: number; fanout: number }>[],
) {
  const budget = createSharedRecordBudget(maximumRecordsPerChunk);
  const writer = new CanonicalChunkWriter<(typeof values)[number]>({
    store,
    logicalPrefix: 'run/source/normalize/chunks',
    visibility: 'public',
    licenseSnapshotRef: 'sc:license:test',
    budget,
    signal: new AbortController().signal,
    maximumRecordsPerChunk,
    onChunk: async () => Promise.resolve(),
  });
  for (const value of values) await writer.append(value);
  return { sequence: await writer.finish(), metrics: budget.metrics() };
}

describe('canonical chunk spill and recovery', () => {
  it('keeps logical identity deterministic across chunk sizes and enforces boundary one', async () => {
    const values = Array.from({ length: 17 }, (_, ordinal) => ({ ordinal, fanout: ordinal % 3 }));
    const one = await write(new MemoryStore(), 1, values);
    const five = await write(new MemoryStore(), 5, values);
    expect(one.sequence.logicalSha256).toBe(five.sequence.logicalSha256);
    expect(one.sequence.recordCount).toBe(values.length);
    expect(one.metrics.highWaterRecords).toBe(1);
    expect(five.metrics.highWaterRecords).toBeLessThanOrEqual(5);
  });

  it('shares one hard boundary across concurrent source writers and normalization fan-out', async () => {
    const store = new MemoryStore();
    const budget = createSharedRecordBudget(1);
    const writer = (source: string) =>
      new CanonicalChunkWriter<Readonly<{ source: string; output: number }>>({
        store,
        logicalPrefix: `run/${source}/normalize/events`,
        visibility: 'public',
        licenseSnapshotRef: 'sc:license:test',
        budget,
        signal: new AbortController().signal,
        maximumRecordsPerChunk: 1,
        onChunk: () => Promise.resolve(),
      });
    const sources = ['source-a', 'source-b'].map((source) => ({ source, writer: writer(source) }));
    await Promise.all(
      sources.map(async ({ source, writer: sourceWriter }) => {
        for (let output = 0; output < 5; output += 1) {
          await sourceWriter.append({ source, output });
        }
        return sourceWriter.finish();
      }),
    );
    expect(budget.metrics()).toMatchObject({
      capacity: 1,
      highWaterRecords: 1,
      inUse: 0,
      totalAcquired: 10,
    });
  });

  it('adopts a byte-identical write-before-checkpoint orphan', async () => {
    const store = new MemoryStore();
    store.failAfterNextWrite = true;
    const result = await write(store, 2, [
      { ordinal: 0, fanout: 2 },
      { ordinal: 1, fanout: 1 },
    ]);
    expect(result.sequence.chunks).toHaveLength(1);
    expect(store.records.size).toBe(1);
  });

  it('resumes a mid-record fan-out cursor without reacquisition or duplicate output', async () => {
    type Event = Readonly<{
      kind: 'start' | 'mutation' | 'complete';
      offset: number;
      cursor: Readonly<{ record: number; mutationOffset: number; complete: boolean }>;
    }>;
    const store = new MemoryStore();
    const budget = createSharedRecordBudget(1);
    let checkpointed: readonly ChunkReference[] = [];
    let acquisitions = 1;
    const createWriter = (restoredChunks: readonly ChunkReference[]) =>
      new CanonicalChunkWriter<Event>({
        store,
        logicalPrefix: 'run/source/normalize/events',
        visibility: 'public',
        licenseSnapshotRef: 'sc:license:test',
        budget,
        signal: new AbortController().signal,
        maximumRecordsPerChunk: 1,
        restoredChunks,
        cursorFor: (event) => JSON.stringify(event.cursor),
        onChunk: (chunks) => {
          checkpointed = chunks;
          return Promise.resolve();
        },
      });
    const first = createWriter([]);
    await first.append({
      kind: 'start',
      offset: 0,
      cursor: { record: 1, mutationOffset: 0, complete: false },
    });
    await first.append({
      kind: 'mutation',
      offset: 1,
      cursor: { record: 1, mutationOffset: 1, complete: false },
    });
    expect(JSON.parse(checkpointed.at(-1)?.resumeCursor ?? '{}')).toMatchObject({
      mutationOffset: 1,
      complete: false,
    });

    const resumed = createWriter(checkpointed);
    await resumed.restore();
    // Acquisition is a durable earlier phase; resume re-decodes only the current logical record.
    acquisitions += 0;
    for (const offset of [2, 3]) {
      await resumed.append({
        kind: 'mutation',
        offset,
        cursor: { record: 1, mutationOffset: offset, complete: false },
      });
    }
    const sequence = await (async () => {
      await resumed.append({
        kind: 'complete',
        offset: 3,
        cursor: { record: 1, mutationOffset: 3, complete: true },
      });
      return resumed.finish();
    })();
    const offsets: number[] = [];
    for await (const event of sequence.read()) {
      if (event.kind === 'mutation') offsets.push(event.offset);
    }
    expect(offsets).toEqual([1, 2, 3]);
    expect(acquisitions).toBe(1);
    expect(budget.metrics().highWaterRecords).toBe(1);
  });

  it('retries safely before write, after write before checkpoint, and after checkpoint', async () => {
    type Event = Readonly<{ value: number; cursor: Readonly<{ offset: number }> }>;
    const events = [
      { value: 1, cursor: { offset: 1 } },
      { value: 2, cursor: { offset: 2 } },
    ] as const;
    const createWriter = (
      store: MemoryStore,
      budget: ReturnType<typeof createSharedRecordBudget>,
      onChunk: (chunks: readonly ChunkReference[]) => Promise<void>,
      restoredChunks: readonly ChunkReference[] = [],
    ) =>
      new CanonicalChunkWriter<Event>({
        store,
        logicalPrefix: 'run/source/crash/events',
        visibility: 'public',
        licenseSnapshotRef: 'sc:license:test',
        budget,
        signal: new AbortController().signal,
        maximumRecordsPerChunk: 2,
        restoredChunks,
        cursorFor: ({ cursor }) => JSON.stringify(cursor),
        onChunk,
      });

    const cleanStore = new MemoryStore();
    const clean = createWriter(cleanStore, createSharedRecordBudget(2), () => Promise.resolve());
    for (const event of events) await clean.append(event);
    const cleanSequence = await clean.finish();

    const beforeStore = new MemoryStore();
    const beforeBudget = createSharedRecordBudget(2);
    beforeStore.failBeforeNextWrite = true;
    const beforeWrite = createWriter(beforeStore, beforeBudget, () => Promise.resolve());
    await beforeWrite.append(events[0]);
    await expect(beforeWrite.append(events[1])).rejects.toThrow('crash before chunk write');
    expect(beforeStore.records.size).toBe(0);
    expect(beforeBudget.metrics().inUse).toBe(2);
    const retriedBeforeWrite = await beforeWrite.finish();
    expect(retriedBeforeWrite.logicalSha256).toBe(cleanSequence.logicalSha256);
    expect(beforeBudget.metrics().inUse).toBe(0);

    const store = new MemoryStore();
    const budget = createSharedRecordBudget(2);
    let checkpointed: readonly ChunkReference[] = [];
    let failCheckpoint = true;
    const afterWrite = createWriter(store, budget, (chunks) => {
      if (failCheckpoint) {
        failCheckpoint = false;
        return Promise.reject(new Error('crash after write before checkpoint'));
      }
      checkpointed = chunks;
      return Promise.resolve();
    });
    await afterWrite.append(events[0]);
    await expect(afterWrite.append(events[1])).rejects.toThrow(
      'crash after write before checkpoint',
    );
    expect(store.records.size).toBe(1);
    expect(checkpointed).toEqual([]);
    expect(budget.metrics().inUse).toBe(2);
    const adopted = await afterWrite.finish();
    expect(adopted.chunks).toHaveLength(1);
    expect(store.records.size).toBe(1);
    expect(adopted.logicalSha256).toBe(cleanSequence.logicalSha256);
    expect(budget.metrics().inUse).toBe(0);

    const afterCheckpoint = createWriter(
      store,
      budget,
      (chunks) => {
        checkpointed = chunks;
        return Promise.resolve();
      },
      checkpointed,
    );
    await afterCheckpoint.restore();
    await afterCheckpoint.append({ value: 3, cursor: { offset: 3 } });
    const complete = await afterCheckpoint.finish();
    const values: number[] = [];
    for await (const event of complete.read()) values.push(event.value);
    expect(values).toEqual([1, 2, 3]);
  });

  it('rejects missing, corrupt, and duplicate checkpoint chunk references', async () => {
    const store = new MemoryStore();
    const { sequence } = await write(store, 2, [
      { ordinal: 0, fanout: 0 },
      { ordinal: 1, fanout: 0 },
      { ordinal: 2, fanout: 0 },
    ]);
    const first = sequence.chunks[0];
    if (first === undefined) throw new Error('missing fixture chunk');
    await expect(
      openChunkSequence(store, [first, first], {
        recordCount: sequence.recordCount,
        logicalSha256: sequence.logicalSha256,
      }),
    ).rejects.toBeInstanceOf(ChunkIntegrityError);

    const missing = new MemoryStore();
    await expect(
      openChunkSequence(missing, sequence.chunks, {
        recordCount: sequence.recordCount,
        logicalSha256: sequence.logicalSha256,
      }),
    ).rejects.toBeInstanceOf(ChunkIntegrityError);

    const item = store.records.get(first.logicalKey);
    if (item === undefined) throw new Error('missing stored chunk');
    store.records.set(first.logicalKey, {
      ...item,
      stored: Object.freeze({
        ...item.stored,
        metadata: { ...item.stored.metadata, visibility: 'restricted' },
      }),
    });
    await expect(
      openChunkSequence(store, sequence.chunks, {
        recordCount: sequence.recordCount,
        logicalSha256: sequence.logicalSha256,
      }),
    ).rejects.toBeInstanceOf(ChunkIntegrityError);
    store.records.set(first.logicalKey, item);
    item.bytes[0] = (item.bytes[0] ?? 0) ^ 1;
    await expect(
      openChunkSequence(store, sequence.chunks as readonly ChunkReference[], {
        recordCount: sequence.recordCount,
        logicalSha256: sequence.logicalSha256,
      }),
    ).rejects.toBeInstanceOf(ChunkIntegrityError);
  });
});
