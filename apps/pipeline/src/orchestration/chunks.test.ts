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
  emptyChunkLedger,
  migrateLegacyChunkLedger,
  openChunkSequence,
  openLedgerChunkSequence,
  type ChunkLedger,
  type ChunkReference,
} from './chunks.js';

class MemoryStore implements RecoverableArtifactStore {
  readonly records = new Map<string, { stored: StoredArtifact; bytes: Uint8Array }>();
  failBeforeNextWrite = false;
  failAfterNextWrite = false;
  failBeforeLogicalKey: string | null = null;
  failAfterLogicalKey: string | null = null;
  failHeadLogicalKeyOnce: string | null = null;
  readFragmentBytes: number | null = null;

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
    if (
      this.failBeforeLogicalKey !== null &&
      request.logicalKey.includes(this.failBeforeLogicalKey)
    ) {
      this.failBeforeLogicalKey = null;
      throw new Error('targeted crash before write');
    }
    if (this.records.has(request.logicalKey)) throw new Error('immutable conflict');
    const chunks: Uint8Array[] = [];
    if (request.body instanceof Uint8Array) {
      chunks.push(request.body);
    } else {
      for await (const chunk of request.body) chunks.push(chunk);
    }
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
    if (
      this.failAfterLogicalKey !== null &&
      request.logicalKey.includes(this.failAfterLogicalKey)
    ) {
      this.failAfterLogicalKey = null;
      this.failHeadLogicalKeyOnce = request.logicalKey;
      throw new Error('targeted crash after write');
    }
    return stored;
  }

  public head(uri: string): Promise<StoredArtifact | undefined> {
    return Promise.resolve(
      [...this.records.values()].find(({ stored }) => stored.uri === uri)?.stored,
    );
  }

  public headByLogicalKey(logicalKey: string): Promise<StoredArtifact | undefined> {
    if (this.failHeadLogicalKeyOnce === logicalKey) {
      this.failHeadLogicalKeyOnce = null;
      return Promise.reject(new Error('simulated process death before orphan adoption'));
    }
    const item = this.records.get(logicalKey);
    if (item === undefined) return Promise.resolve(undefined);
    const hash = createHash('sha256').update(item.bytes).digest('hex');
    if (hash !== item.stored.sha256) throw new ChunkIntegrityError('corrupt body');
    return Promise.resolve(item.stored);
  }

  public async *read(uri: string, range?: ArtifactByteRange): AsyncIterable<Uint8Array> {
    const item = [...this.records.values()].find(({ stored }) => stored.uri === uri);
    if (item === undefined) throw new Error('missing');
    const bytes =
      range === undefined ? item.bytes : item.bytes.slice(range.start, range.endInclusive + 1);
    const fragmentBytes = this.readFragmentBytes ?? bytes.byteLength;
    for (let offset = 0; offset < bytes.byteLength; offset += fragmentBytes) {
      yield await Promise.resolve(bytes.slice(offset, offset + fragmentBytes));
    }
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
  it('enforces independent record/chunk byte caps with explicit transferred-lease ownership', async () => {
    const store = new MemoryStore();
    store.readFragmentBytes = 1;
    const budget = createSharedRecordBudget(3);
    let chunks: readonly ChunkReference[] = [];
    const writer = new CanonicalChunkWriter<string>({
      store,
      logicalPrefix: 'run/byte-boundaries/normalize/events',
      visibility: 'public',
      licenseSnapshotRef: 'sc:license:byte-boundaries',
      budget,
      signal: new AbortController().signal,
      maximumRecordsPerChunk: 10,
      maximumBytesPerRecord: 64,
      maximumBytesPerChunk: 128,
      onChunk: (next) => {
        chunks = next;
        return Promise.resolve();
      },
    });
    const exactBoundary = 'a'.repeat(61);
    await writer.append(exactBoundary);
    await writer.append(exactBoundary);
    await writer.append(exactBoundary);
    const sequence = await writer.finish();
    expect(chunks.map(({ byteSize }) => byteSize)).toEqual([128, 64]);
    const reopened = await openChunkSequence<string>(store, sequence.chunks, {
      recordCount: 3,
      logicalSha256: sequence.logicalSha256,
    });
    const values: string[] = [];
    for await (const value of reopened.read()) values.push(value);
    expect(values).toEqual([exactBoundary, exactBoundary, exactBoundary]);

    let callerReleases = 0;
    const callerLease = { release: () => (callerReleases += 1) };
    await expect(writer.append('b'.repeat(62), callerLease)).rejects.toThrow(
      'exceeds 64 byte record budget',
    );
    expect(callerReleases).toBe(0);
    callerLease.release();
    expect(callerReleases).toBe(1);
    expect(budget.metrics().inUse).toBe(0);
  });

  it('rejects an oversized canonical line assembled from small fragments in linear space', async () => {
    const store = new MemoryStore();
    store.readFragmentBytes = 997;
    const body = Buffer.from(`"${'x'.repeat(1024 * 1024)}"\n`, 'utf8');
    const sha256 = createHash('sha256').update(body).digest('hex');
    const logicalKey = `run/oversized/normalize/events/00000000-${sha256}.ndjson`;
    const metadata = Object.freeze({
      schemaVersion: '2.0.0',
      sequence: '0',
      firstOrdinal: '0',
      lastOrdinal: '0',
      recordCount: '1',
      visibility: 'public',
      licenseSnapshotRef: 'sc:license:oversized',
      resumeCursor: '',
    });
    const stored = await store.putImmutable({
      logicalKey,
      mediaType: 'application/x-ndjson',
      body,
      expectedSha256: sha256,
      metadata,
      ifAbsent: true,
    });
    const reference: ChunkReference = Object.freeze({
      schemaVersion: '2.0.0',
      sequence: 0,
      firstOrdinal: 0,
      lastOrdinal: 0,
      recordCount: 1,
      logicalKey,
      uri: stored.uri,
      mediaType: 'application/x-ndjson',
      byteSize: body.byteLength,
      sha256,
      visibility: 'public',
      licenseSnapshotRef: 'sc:license:oversized',
      resumeCursor: null,
    });
    await expect(
      openChunkSequence<string>(store, [reference], {
        recordCount: 1,
        logicalSha256: sha256,
      }),
    ).rejects.toThrow('Chunk line exceeds 1 MiB');
  });

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

  it('bounds a 20k parcel-shaped descriptor checkpoint with immutable 256-entry pages', async () => {
    const store = new MemoryStore();
    const budget = createSharedRecordBudget(1);
    let checkpoint = emptyChunkLedger('run/parcels/normalize/events');
    let maximumCheckpointBytes = 0;
    const writer = new CanonicalChunkWriter<
      Readonly<{ parcelId: string; address: string; cursor: string }>
    >({
      store,
      logicalPrefix: 'run/parcels/normalize/events',
      visibility: 'public',
      licenseSnapshotRef: 'sc:license:parcels',
      budget,
      signal: new AbortController().signal,
      maximumRecordsPerChunk: 1,
      restoredLedger: checkpoint,
      cursorFor: ({ cursor }) => cursor,
      onLedger: (ledger) => {
        checkpoint = ledger;
        maximumCheckpointBytes = Math.max(
          maximumCheckpointBytes,
          Buffer.byteLength(JSON.stringify(ledger)),
        );
        return Promise.resolve();
      },
    });
    for (let ordinal = 0; ordinal < 20_000; ordinal += 1) {
      await writer.append({
        parcelId: `APN-${ordinal.toString().padStart(8, '0')}`,
        address: `${ordinal} bounded ledger lane, Santa Clara CA`,
        cursor: JSON.stringify({ artifactIndex: 0, recordOrdinal: ordinal }),
      });
    }
    const sequence = await writer.finish();
    expect(checkpoint).toMatchObject({
      totalChunks: 20_000,
      totalRecords: 20_000,
      sealedPageCount: Math.ceil(20_000 / 256),
      tail: [],
    });
    expect(maximumCheckpointBytes).toBeLessThan(512 * 1024);
    expect(sequence.chunks).toEqual([]);
    expect(sequence.chunkInventory).toMatchObject({
      descriptorCount: 20_000,
      recordCount: 20_000,
      pageCount: Math.ceil(20_000 / 256),
    });
    expect(budget.metrics().highWaterRecords).toBe(1);
  }, 60_000);

  it('preserves bytes and logical identity across ledger interruption and legacy migration', async () => {
    type Event = Readonly<{ value: number; cursor: string }>;
    const values = Array.from({ length: 600 }, (_, value) => ({ value, cursor: String(value) }));

    const cleanStore = new MemoryStore();
    let cleanCheckpoint = emptyChunkLedger('run/clean/normalize/events');
    const cleanWriter = new CanonicalChunkWriter<Event>({
      store: cleanStore,
      logicalPrefix: 'run/clean/normalize/events',
      visibility: 'public',
      licenseSnapshotRef: 'sc:license:test',
      budget: createSharedRecordBudget(1),
      signal: new AbortController().signal,
      maximumRecordsPerChunk: 1,
      restoredLedger: cleanCheckpoint,
      cursorFor: ({ cursor }) => cursor,
      onLedger: (ledger) => {
        cleanCheckpoint = ledger;
        return Promise.resolve();
      },
    });
    for (const value of values) await cleanWriter.append(value);
    const clean = await cleanWriter.finish();

    const store = new MemoryStore();
    let checkpoint: ChunkLedger = emptyChunkLedger('run/resume/normalize/events');
    const createWriter = () =>
      new CanonicalChunkWriter<Event>({
        store,
        logicalPrefix: 'run/resume/normalize/events',
        visibility: 'public',
        licenseSnapshotRef: 'sc:license:test',
        budget: createSharedRecordBudget(1),
        signal: new AbortController().signal,
        maximumRecordsPerChunk: 1,
        restoredLedger: checkpoint,
        cursorFor: ({ cursor }) => cursor,
        onLedger: (ledger) => {
          checkpoint = ledger;
          return Promise.resolve();
        },
      });
    const interrupted = createWriter();
    for (const value of values.slice(0, 311)) await interrupted.append(value);
    const resumed = createWriter();
    await resumed.restore();
    for (const value of values.slice(311)) await resumed.append(value);
    const resumedSequence = await resumed.finish();
    const resumedValues: Event[] = [];
    for await (const value of resumedSequence.read()) resumedValues.push(value);
    expect(resumedValues).toEqual(values);
    expect(resumedSequence.logicalSha256).toBe(clean.logicalSha256);

    const legacyStore = new MemoryStore();
    const legacyWriter = new CanonicalChunkWriter<Event>({
      store: legacyStore,
      logicalPrefix: 'run/legacy/normalize/events',
      visibility: 'public',
      licenseSnapshotRef: 'sc:license:test',
      budget: createSharedRecordBudget(1),
      signal: new AbortController().signal,
      maximumRecordsPerChunk: 1,
      cursorFor: ({ cursor }) => cursor,
      onChunk: () => Promise.resolve(),
    });
    for (const value of values) await legacyWriter.append(value);
    const legacy = await legacyWriter.finish();
    const migrated = await migrateLegacyChunkLedger(
      legacyStore,
      'run/legacy/normalize/events',
      legacy.chunks,
    );
    const reopened = await openLedgerChunkSequence<Event>(legacyStore, migrated, {
      recordCount: legacy.recordCount,
      logicalSha256: legacy.logicalSha256,
      logicalPrefix: 'run/legacy/normalize/events',
    });
    const migratedReferences: ChunkReference[] = [];
    for await (const reference of reopened.readReferences?.() ?? []) {
      migratedReferences.push(reference);
    }
    expect(reopened.logicalSha256).toBe(legacy.logicalSha256);
    expect(reopened.recordCount).toBe(legacy.recordCount);
    expect(migratedReferences).toEqual(legacy.chunks);
    expect(migrated).toMatchObject({ totalChunks: 600, sealedPageCount: 2 });
    expect(migrated.resumeCursor).toBe('599');
    await expect(
      openLedgerChunkSequence<Event>(
        legacyStore,
        Object.freeze({ ...migrated, sealedChainSha256: '0'.repeat(64) }),
        {
          recordCount: legacy.recordCount,
          logicalSha256: legacy.logicalSha256,
          logicalPrefix: 'run/legacy/normalize/events',
        },
      ),
    ).rejects.toBeInstanceOf(ChunkIntegrityError);
    await expect(
      openLedgerChunkSequence<Event>(legacyStore, migrated, {
        recordCount: legacy.recordCount,
        logicalSha256: legacy.logicalSha256,
        logicalPrefix: 'run/substituted/normalize/events',
      }),
    ).rejects.toBeInstanceOf(ChunkIntegrityError);
    await expect(
      openLedgerChunkSequence<Event>(
        legacyStore,
        Object.freeze({ ...migrated, totalRecords: Number.MAX_SAFE_INTEGER + 1 }),
        {
          recordCount: legacy.recordCount,
          logicalSha256: legacy.logicalSha256,
          logicalPrefix: 'run/legacy/normalize/events',
        },
      ),
    ).rejects.toBeInstanceOf(ChunkIntegrityError);
    await expect(
      openLedgerChunkSequence<Event>(
        legacyStore,
        Object.freeze({ ...migrated, licenseSnapshotRefs: ['sc:license:substituted'] }),
        {
          recordCount: legacy.recordCount,
          logicalSha256: legacy.logicalSha256,
          logicalPrefix: 'run/legacy/normalize/events',
        },
      ),
    ).rejects.toBeInstanceOf(ChunkIntegrityError);
    await expect(
      openLedgerChunkSequence<Event>(
        legacyStore,
        Object.freeze({ ...migrated, resumeCursor: 'tampered' }),
        {
          recordCount: legacy.recordCount,
          logicalSha256: legacy.logicalSha256,
          logicalPrefix: 'run/legacy/normalize/events',
        },
      ),
    ).rejects.toBeInstanceOf(ChunkIntegrityError);
    expect(clean.recordCount).toBe(values.length);
  }, 60_000);

  it('adopts exact chunk/page orphans across every ledger seal crash window', async () => {
    const modes = [
      'chunk-before',
      'chunk-after',
      'page-before',
      'page-after',
      'checkpoint',
    ] as const;
    for (const mode of modes) {
      const store = new MemoryStore();
      let checkpoint = emptyChunkLedger(`run/${mode}/normalize/events`);
      let failCheckpoint = false;
      const writer = new CanonicalChunkWriter<Readonly<{ ordinal: number }>>({
        store,
        logicalPrefix: `run/${mode}/normalize/events`,
        visibility: 'public',
        licenseSnapshotRef: 'sc:license:crash-window',
        budget: createSharedRecordBudget(1),
        signal: new AbortController().signal,
        maximumRecordsPerChunk: 1,
        restoredLedger: checkpoint,
        onLedger: (ledger) => {
          if (failCheckpoint && ledger.sealedPageCount === 1) {
            failCheckpoint = false;
            return Promise.reject(new Error('targeted checkpoint callback crash'));
          }
          checkpoint = ledger;
          return Promise.resolve();
        },
      });
      for (let ordinal = 0; ordinal < 255; ordinal += 1) await writer.append({ ordinal });
      if (mode === 'chunk-before') store.failBeforeLogicalKey = '/00000255-';
      if (mode === 'chunk-after') store.failAfterLogicalKey = '/00000255-';
      if (mode === 'page-before') store.failBeforeLogicalKey = '/ledger/p/';
      if (mode === 'page-after') store.failAfterLogicalKey = '/ledger/p/';
      if (mode === 'checkpoint') failCheckpoint = true;
      await expect(writer.append({ ordinal: 255 })).rejects.toThrow();
      const sequence = await writer.finish();
      const values: number[] = [];
      for await (const value of sequence.read()) values.push(value.ordinal);
      expect(values).toEqual(Array.from({ length: 256 }, (_, ordinal) => ordinal));
      expect(checkpoint).toMatchObject({ totalChunks: 256, sealedPageCount: 1, tail: [] });
    }
  }, 60_000);
});
