import { createHash } from 'node:crypto';

import type { RecoverableArtifactStore, StoredArtifact } from '@oracle/artifacts/artifact-store';
import {
  boundedDescriptorPageSha256,
  type BoundedDescriptorRoot,
} from '@oracle/contracts/bounded-processing';
import type {
  RecordBudgetLease,
  SharedRecordBudget,
} from '@oracle/source-adapters/spi/record-budget';

import { canonicalJson } from './canonical-json.js';

export const CHUNK_SCHEMA_VERSION = '2.0.0' as const;
export const CHUNK_LEDGER_SCHEMA_VERSION = 'oracle-chunk-ledger-v1' as const;
export const CHUNK_LEDGER_PAGE_SIZE = 256 as const;
const EMPTY_SHA256 = createHash('sha256').digest('hex');
const MAXIMUM_LEDGER_PAGE_BYTES = 4 * 1024 * 1024;

export type ChunkReference = Readonly<{
  schemaVersion: typeof CHUNK_SCHEMA_VERSION;
  sequence: number;
  firstOrdinal: number;
  lastOrdinal: number;
  recordCount: number;
  logicalKey: string;
  uri: string;
  mediaType: 'application/x-ndjson';
  byteSize: number;
  sha256: string;
  visibility: string;
  licenseSnapshotRef: string;
  /** Canonical, PII-free application cursor committed atomically with this chunk reference. */
  resumeCursor: string | null;
}>;

export type ChunkLedger = Readonly<{
  schemaVersion: typeof CHUNK_LEDGER_SCHEMA_VERSION;
  logicalPrefix: string;
  pageSize: typeof CHUNK_LEDGER_PAGE_SIZE;
  sealedPageCount: number;
  sealedChunkCount: number;
  sealedRecordCount: number;
  sealedByteSize: number;
  sealedChainSha256: string;
  totalChunks: number;
  totalRecords: number;
  totalByteSize: number;
  resumeCursor: string | null;
  licenseSnapshotRefs: readonly string[];
  tail: readonly ChunkReference[];
}>;

export type ChunkSequence<T> = Readonly<{
  schemaVersion: typeof CHUNK_SCHEMA_VERSION;
  recordCount: number;
  logicalSha256: string;
  /** Inline references are retained only for small legacy/acquisition sequences. */
  chunks: readonly ChunkReference[];
  chunkInventory?: BoundedDescriptorRoot | null;
  licenseSnapshotRefs?: readonly string[];
  readReferences?(): AsyncIterable<ChunkReference>;
  read(): AsyncIterable<T>;
}>;

export function emptyChunkLedger(logicalPrefix: string): ChunkLedger {
  return Object.freeze({
    schemaVersion: CHUNK_LEDGER_SCHEMA_VERSION,
    logicalPrefix: logicalPrefix.replace(/\/$/u, ''),
    pageSize: CHUNK_LEDGER_PAGE_SIZE,
    sealedPageCount: 0,
    sealedChunkCount: 0,
    sealedRecordCount: 0,
    sealedByteSize: 0,
    sealedChainSha256: EMPTY_SHA256,
    totalChunks: 0,
    totalRecords: 0,
    totalByteSize: 0,
    resumeCursor: null,
    licenseSnapshotRefs: Object.freeze([]),
    tail: Object.freeze([]),
  });
}

export function emptyChunkSequence<T>(): ChunkSequence<T> {
  const logicalSha256 = createHash('sha256').digest('hex');
  return Object.freeze({
    schemaVersion: CHUNK_SCHEMA_VERSION,
    recordCount: 0,
    logicalSha256,
    chunks: Object.freeze([]),
    chunkInventory: null,
    licenseSnapshotRefs: Object.freeze([]),
    readReferences: async function* () {
      yield* await Promise.resolve([] as ChunkReference[]);
    },
    read: async function* () {
      yield* await Promise.resolve([] as T[]);
    },
  });
}

const DEFAULT_MAXIMUM_RECORD_BYTES = 1024 * 1024;
const DEFAULT_MAXIMUM_CHUNK_BYTES = 4 * 1024 * 1024;

type Buffered = Readonly<{
  line: Uint8Array;
  resumeCursor: string | null;
  lease: RecordBudgetLease;
}>;

type RestoreState = 'available' | 'reading' | 'complete' | 'invalid';

export class CanonicalChunkWriter<T> {
  readonly #store: RecoverableArtifactStore;
  readonly #logicalPrefix: string;
  readonly #visibility: string;
  readonly #licenseSnapshotRef: string;
  readonly #budget: SharedRecordBudget;
  readonly #signal: AbortSignal;
  readonly #onChunk: ((chunks: readonly ChunkReference[]) => Promise<void>) | undefined;
  readonly #onLedger: ((ledger: ChunkLedger) => Promise<void>) | undefined;
  readonly #maximumRecordsPerChunk: number;
  readonly #maximumBytesPerChunk: number;
  readonly #maximumBytesPerRecord: number;
  readonly #cursorFor: ((value: T) => string | null) | undefined;
  readonly #onBufferedRecordDelta: ((delta: number) => void) | undefined;
  readonly #chunks: ChunkReference[];
  #ledger: ChunkLedger | undefined;
  readonly #logicalHash = createHash('sha256');
  readonly #buffer: Buffered[] = [];
  #bufferedBytes = 0;
  #recordCount = 0;
  #restoreState: RestoreState = 'available';
  #finished = false;

  public get bufferedRecordCount(): number {
    return this.#buffer.length;
  }

  public constructor(
    input: Readonly<{
      store: RecoverableArtifactStore;
      logicalPrefix: string;
      visibility: string;
      licenseSnapshotRef: string;
      budget: SharedRecordBudget;
      signal: AbortSignal;
      maximumRecordsPerChunk: number;
      maximumBytesPerChunk?: number;
      maximumBytesPerRecord?: number;
      restoredChunks?: readonly ChunkReference[];
      restoredLedger?: ChunkLedger;
      cursorFor?: (value: T) => string | null;
      onBufferedRecordDelta?: (delta: number) => void;
      onChunk?: (chunks: readonly ChunkReference[]) => Promise<void>;
      onLedger?: (ledger: ChunkLedger) => Promise<void>;
    }>,
  ) {
    if (!Number.isSafeInteger(input.maximumRecordsPerChunk) || input.maximumRecordsPerChunk < 1) {
      throw new RangeError('maximumRecordsPerChunk must be a positive safe integer');
    }
    const maximumBytesPerChunk = input.maximumBytesPerChunk ?? DEFAULT_MAXIMUM_CHUNK_BYTES;
    const maximumBytesPerRecord = input.maximumBytesPerRecord ?? DEFAULT_MAXIMUM_RECORD_BYTES;
    if (!Number.isSafeInteger(maximumBytesPerChunk) || maximumBytesPerChunk < 1) {
      throw new RangeError('maximumBytesPerChunk must be a positive safe integer');
    }
    if (
      !Number.isSafeInteger(maximumBytesPerRecord) ||
      maximumBytesPerRecord < 1 ||
      maximumBytesPerRecord > maximumBytesPerChunk
    ) {
      throw new RangeError('maximumBytesPerRecord must fit inside the chunk byte budget');
    }
    const ledgerMode = input.restoredLedger !== undefined;
    if (
      (ledgerMode && (input.onLedger === undefined || input.onChunk !== undefined)) ||
      (!ledgerMode && (input.onChunk === undefined || input.onLedger !== undefined))
    ) {
      throw new TypeError('Chunk writer requires exactly one matching persistence mode');
    }
    this.#store = input.store;
    this.#logicalPrefix = input.logicalPrefix.replace(/\/$/u, '');
    if (
      input.restoredLedger !== undefined &&
      input.restoredLedger.logicalPrefix !== this.#logicalPrefix
    ) {
      throw new ChunkIntegrityError('Chunk ledger belongs to another logical prefix');
    }
    this.#visibility = input.visibility;
    this.#licenseSnapshotRef = input.licenseSnapshotRef;
    this.#budget = input.budget;
    this.#signal = input.signal;
    this.#maximumRecordsPerChunk = input.maximumRecordsPerChunk;
    this.#maximumBytesPerChunk = maximumBytesPerChunk;
    this.#maximumBytesPerRecord = maximumBytesPerRecord;
    this.#chunks = [...(input.restoredChunks ?? [])];
    this.#ledger = input.restoredLedger;
    this.#cursorFor = input.cursorFor;
    this.#onBufferedRecordDelta = input.onBufferedRecordDelta;
    this.#onChunk = input.onChunk;
    this.#onLedger = input.onLedger;
  }

  public async restore(): Promise<void> {
    for await (const value of this.restoreAndRead()) void value;
  }

  /**
   * Verifies and restores the persisted prefix while exposing its typed values to one consumer.
   * The writer becomes appendable only after the iterable is exhausted successfully. Returning
   * early, aborting, or encountering corruption permanently invalidates this writer instance.
   */
  public restoreAndRead(): AsyncIterable<T> {
    if (
      this.#restoreState !== 'available' ||
      this.#recordCount !== 0 ||
      this.#buffer.length !== 0 ||
      this.#finished
    ) {
      throw new Error('Chunk writer restore can only be consumed once before writing');
    }
    this.#restoreState = 'reading';
    const source = this.#readRestoredValues();
    const invalidateIncompleteRestore = () => {
      if (this.#restoreState === 'reading') this.#restoreState = 'invalid';
    };
    const iterator: AsyncIterator<T> = {
      next: () => source.next(),
      return: async () => {
        try {
          return await source.return(undefined);
        } finally {
          invalidateIncompleteRestore();
        }
      },
      throw: async (error?: unknown) => {
        try {
          return await source.throw(error);
        } finally {
          invalidateIncompleteRestore();
        }
      },
    };
    let claimed = false;
    return Object.freeze({
      [Symbol.asyncIterator](): AsyncIterator<T> {
        if (claimed) throw new Error('Restored chunk prefix iterable can only be consumed once');
        claimed = true;
        return iterator;
      },
    });
  }

  async *#readRestoredValues(): AsyncGenerator<T, void, unknown> {
    let completed = false;
    const decoder = new TextDecoder('utf8', { fatal: true });
    const references =
      this.#ledger === undefined
        ? arrayReferences(this.#chunks, this.#logicalPrefix)
        : streamChunkLedgerReferences(this.#store, this.#ledger, this.#logicalPrefix);
    try {
      this.#signal.throwIfAborted();
      for await (const reference of references) {
        this.#signal.throwIfAborted();
        const stored = await this.#store.headByLogicalKey(reference.logicalKey);
        assertChunkStored(reference, stored);
        const bodyHash = createHash('sha256');
        let byteSize = 0;
        let count = 0;
        for await (const line of readCanonicalLines(this.#store, reference)) {
          this.#signal.throwIfAborted();
          bodyHash.update(line);
          byteSize += line.byteLength;
          this.#logicalHash.update(line);
          count += 1;
          let value: T;
          try {
            value = JSON.parse(decoder.decode(line)) as T;
          } catch {
            throw new ChunkIntegrityError(`Chunk contains invalid JSON: ${reference.logicalKey}`);
          }
          yield value;
          this.#signal.throwIfAborted();
        }
        const bodySha256 = bodyHash.digest('hex');
        if (
          count !== reference.recordCount ||
          byteSize !== reference.byteSize ||
          bodySha256 !== reference.sha256
        ) {
          throw new ChunkIntegrityError(`Chunk body identity mismatch: ${reference.logicalKey}`);
        }
        this.#recordCount += count;
      }
      completed = true;
      this.#restoreState = 'complete';
    } finally {
      if (!completed && this.#restoreState === 'reading') this.#restoreState = 'invalid';
    }
  }

  public async append(
    value: T,
    transferredLease?: RecordBudgetLease,
    onLeaseTransferred?: () => void,
  ): Promise<void> {
    this.#assertWritable();
    this.#signal.throwIfAborted();
    const line = new TextEncoder().encode(`${canonicalJson(value)}\n`);
    if (line.byteLength > this.#maximumBytesPerRecord) {
      // Validation occurs before buffer ownership. A caller-supplied lease remains caller-owned
      // when this check rejects; once buffered, abort/flush release it exactly once.
      throw new ChunkIntegrityError(
        `Canonical record exceeds ${this.#maximumBytesPerRecord} byte record budget`,
      );
    }
    if (
      this.#buffer.length > 0 &&
      ((transferredLease === undefined && this.#budget.metrics().inUse >= this.#budget.capacity) ||
        this.#bufferedBytes + line.byteLength > this.#maximumBytesPerChunk)
    ) {
      await this.flush();
    }
    const lease = transferredLease ?? (await this.#budget.acquire(this.#signal));
    this.#buffer.push(
      Object.freeze({ line, resumeCursor: this.#cursorFor?.(value) ?? null, lease }),
    );
    onLeaseTransferred?.();
    this.#bufferedBytes += line.byteLength;
    this.#onBufferedRecordDelta?.(1);
    if (this.#buffer.length >= this.#maximumRecordsPerChunk) await this.flush();
  }

  public async flush(): Promise<void> {
    this.#assertWritable();
    if (this.#buffer.length === 0) return;
    const buffered = [...this.#buffer];
    const firstOrdinal = this.#recordCount;
    const lines = buffered.map(({ line }) => line);
    const chunkHash = createHash('sha256');
    let byteSize = 0;
    for (const line of lines) {
      chunkHash.update(line);
      byteSize += line.byteLength;
    }
    const sha256 = chunkHash.digest('hex');
    const sequence = this.#ledger?.totalChunks ?? this.#chunks.length;
    const logicalKey = `${this.#logicalPrefix}/${sequence.toString().padStart(8, '0')}-${firstOrdinal.toString().padStart(12, '0')}-${sha256}.ndjson`;
    const resumeCursor = buffered.at(-1)?.resumeCursor ?? null;
    const request = {
      logicalKey,
      mediaType: 'application/x-ndjson',
      body: streamLines(lines),
      expectedSha256: sha256,
      metadata: {
        schemaVersion: CHUNK_SCHEMA_VERSION,
        sequence: String(sequence),
        firstOrdinal: String(firstOrdinal),
        lastOrdinal: String(firstOrdinal + buffered.length - 1),
        recordCount: String(buffered.length),
        visibility: this.#visibility,
        licenseSnapshotRef: this.#licenseSnapshotRef,
        resumeCursor: resumeCursor ?? '',
      },
      ifAbsent: true as const,
    };
    let stored: StoredArtifact;
    try {
      stored = await this.#store.putImmutableStreaming(request);
    } catch (error) {
      const orphan = await this.#store.headByLogicalKey(logicalKey);
      if (orphan === undefined) throw error;
      stored = orphan;
    }
    if (
      stored.logicalKey !== logicalKey ||
      stored.mediaType !== request.mediaType ||
      stored.sha256 !== sha256 ||
      stored.byteSize !== byteSize ||
      Object.entries(request.metadata).some(([key, value]) => stored.metadata[key] !== value)
    ) {
      throw new ChunkIntegrityError(`Immutable orphan mismatch: ${logicalKey}`);
    }
    const reference: ChunkReference = Object.freeze({
      schemaVersion: CHUNK_SCHEMA_VERSION,
      sequence,
      firstOrdinal,
      lastOrdinal: firstOrdinal + buffered.length - 1,
      recordCount: buffered.length,
      logicalKey,
      uri: stored.uri,
      mediaType: 'application/x-ndjson',
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      visibility: this.#visibility,
      licenseSnapshotRef: this.#licenseSnapshotRef,
      resumeCursor,
    });
    if (this.#ledger === undefined) {
      const candidate = Object.freeze([...this.#chunks, reference]);
      await this.#onChunk?.(candidate);
      this.#chunks.push(reference);
    } else {
      const candidate = await appendChunkLedger(this.#store, this.#ledger, reference);
      await this.#onLedger?.(candidate);
      this.#ledger = candidate;
    }
    this.#recordCount += buffered.length;
    for (const line of lines) this.#logicalHash.update(line);
    this.#buffer.splice(0, buffered.length);
    this.#bufferedBytes -= byteSize;
    this.#onBufferedRecordDelta?.(-buffered.length);
    for (const { lease } of buffered) {
      lease.release();
    }
  }

  public async finish(): Promise<ChunkSequence<T>> {
    this.#assertWritable();
    await this.flush();
    if (this.#ledger !== undefined) {
      const completed = await finishChunkLedger(this.#store, this.#ledger);
      if (completed.ledger !== this.#ledger) {
        await this.#onLedger?.(completed.ledger);
        this.#ledger = completed.ledger;
      }
      this.#finished = true;
      const logicalSha256 = this.#logicalHash.digest('hex');
      const store = this.#store;
      const ledger = this.#ledger;
      return Object.freeze({
        schemaVersion: CHUNK_SCHEMA_VERSION,
        recordCount: this.#recordCount,
        logicalSha256,
        chunks: Object.freeze([]),
        chunkInventory: completed.inventory,
        licenseSnapshotRefs: ledger.licenseSnapshotRefs,
        readReferences: () => streamChunkLedgerReferences(store, ledger, this.#logicalPrefix),
        read: () =>
          readChunkSequence<T>(
            store,
            streamChunkLedgerReferences(store, ledger, this.#logicalPrefix),
          ),
      });
    }
    const chunks = Object.freeze([...this.#chunks]);
    this.#finished = true;
    const logicalSha256 = this.#logicalHash.digest('hex');
    const store = this.#store;
    return Object.freeze({
      schemaVersion: CHUNK_SCHEMA_VERSION,
      recordCount: this.#recordCount,
      logicalSha256,
      chunks,
      chunkInventory: null,
      licenseSnapshotRefs: Object.freeze([
        ...new Set(chunks.map(({ licenseSnapshotRef }) => licenseSnapshotRef)),
      ]),
      readReferences: () => arrayReferences(chunks),
      read: () => readChunkSequence<T>(store, arrayReferences(chunks)),
    });
  }

  /** Releases every buffered lease after an abort/error without writing a partial chunk. */
  public abort(): void {
    const buffered = this.#buffer.splice(0);
    this.#bufferedBytes = 0;
    this.#onBufferedRecordDelta?.(-buffered.length);
    for (const { lease } of buffered) lease.release();
  }

  #assertWritable(): void {
    if (this.#finished) {
      throw new Error('Chunk writer is already finished');
    }
    if (this.#restoreState === 'reading') {
      throw new Error('Chunk writer restore must finish before writing');
    }
    if (this.#restoreState === 'invalid') {
      throw new Error('Chunk writer cannot continue after an incomplete or failed restore');
    }
  }
}

export async function openChunkSequence<T>(
  store: RecoverableArtifactStore,
  chunks: readonly ChunkReference[],
  expected: Readonly<{ recordCount: number; logicalSha256: string }>,
): Promise<ChunkSequence<T>> {
  const sequence = await openChunkSequencePrefix<T>(store, chunks);
  if (
    sequence.recordCount !== expected.recordCount ||
    sequence.logicalSha256 !== expected.logicalSha256
  ) {
    throw new ChunkIntegrityError('Chunk sequence logical identity mismatch');
  }
  return sequence;
}

export async function openLedgerChunkSequence<T>(
  store: RecoverableArtifactStore,
  ledger: ChunkLedger,
  expected: Readonly<{ recordCount: number; logicalSha256: string; logicalPrefix: string }>,
): Promise<ChunkSequence<T>> {
  const logical = createHash('sha256');
  let recordCount = 0;
  for await (const reference of streamChunkLedgerReferences(
    store,
    ledger,
    expected.logicalPrefix,
  )) {
    const stored = await store.headByLogicalKey(reference.logicalKey);
    assertChunkStored(reference, stored);
    for await (const line of readCanonicalLines(store, reference)) {
      logical.update(line);
      recordCount += 1;
    }
  }
  const logicalSha256 = logical.digest('hex');
  if (recordCount !== expected.recordCount || logicalSha256 !== expected.logicalSha256) {
    throw new ChunkIntegrityError('Chunk ledger logical identity mismatch');
  }
  const completed = await finishChunkLedger(store, ledger);
  return Object.freeze({
    schemaVersion: CHUNK_SCHEMA_VERSION,
    recordCount,
    logicalSha256,
    chunks: Object.freeze([]),
    chunkInventory: completed.inventory,
    licenseSnapshotRefs: completed.ledger.licenseSnapshotRefs,
    readReferences: () =>
      streamChunkLedgerReferences(store, completed.ledger, expected.logicalPrefix),
    read: () =>
      readChunkSequence<T>(
        store,
        streamChunkLedgerReferences(store, completed.ledger, expected.logicalPrefix),
      ),
  });
}

export async function openLedgerChunkSequencePrefix<T>(
  store: RecoverableArtifactStore,
  ledger: ChunkLedger,
  logicalPrefix: string,
): Promise<ChunkSequence<T>> {
  const logical = createHash('sha256');
  let recordCount = 0;
  for await (const reference of streamChunkLedgerReferences(store, ledger, logicalPrefix)) {
    const stored = await store.headByLogicalKey(reference.logicalKey);
    assertChunkStored(reference, stored);
    for await (const line of readCanonicalLines(store, reference)) {
      logical.update(line);
      recordCount += 1;
    }
  }
  return Object.freeze({
    schemaVersion: CHUNK_SCHEMA_VERSION,
    recordCount,
    logicalSha256: logical.digest('hex'),
    chunks: Object.freeze([]),
    chunkInventory: null,
    licenseSnapshotRefs: ledger.licenseSnapshotRefs,
    readReferences: () => streamChunkLedgerReferences(store, ledger, logicalPrefix),
    read: () =>
      readChunkSequence<T>(store, streamChunkLedgerReferences(store, ledger, logicalPrefix)),
  });
}

export async function openChunkSequencePrefix<T>(
  store: RecoverableArtifactStore,
  chunks: readonly ChunkReference[],
  expectedLogicalPrefix?: string,
): Promise<ChunkSequence<T>> {
  validateChunkReferences(chunks, expectedLogicalPrefix);
  const logical = createHash('sha256');
  let recordCount = 0;
  for (const reference of chunks) {
    const stored = await store.headByLogicalKey(reference.logicalKey);
    assertChunkStored(reference, stored);
    for await (const line of readCanonicalLines(store, reference)) {
      logical.update(line);
      recordCount += 1;
    }
  }
  const logicalSha256 = logical.digest('hex');
  const frozen = Object.freeze([...chunks]);
  return Object.freeze({
    schemaVersion: CHUNK_SCHEMA_VERSION,
    recordCount,
    logicalSha256,
    chunks: frozen,
    chunkInventory: null,
    licenseSnapshotRefs: Object.freeze([
      ...new Set(frozen.map(({ licenseSnapshotRef }) => licenseSnapshotRef)),
    ]),
    readReferences: () => arrayReferences(frozen),
    read: () => readChunkSequence<T>(store, arrayReferences(frozen)),
  });
}

export async function combineChunkSequences<T>(
  sequences: readonly ChunkSequence<T>[],
): Promise<ChunkSequence<T>> {
  const logical = createHash('sha256');
  let recordCount = 0;
  for (const sequence of sequences) {
    for await (const value of sequence.read()) {
      logical.update(`${canonicalJson(value)}\n`);
      recordCount += 1;
    }
  }
  const frozen = Object.freeze([...sequences]);
  const licenseSnapshotRefs = Object.freeze([
    ...new Set(
      frozen.flatMap(
        (sequence) =>
          sequence.licenseSnapshotRefs ??
          sequence.chunks.map(({ licenseSnapshotRef }) => licenseSnapshotRef),
      ),
    ),
  ]);
  return Object.freeze({
    schemaVersion: CHUNK_SCHEMA_VERSION,
    recordCount,
    logicalSha256: logical.digest('hex'),
    chunks: Object.freeze([]),
    chunkInventory: null,
    licenseSnapshotRefs,
    readReferences: async function* () {
      for (const sequence of frozen) {
        yield* sequence.readReferences?.() ?? arrayReferences(sequence.chunks);
      }
    },
    read: async function* () {
      for (const sequence of frozen) yield* sequence.read();
    },
  });
}

export async function migrateLegacyChunkLedger(
  store: RecoverableArtifactStore,
  logicalPrefix: string,
  chunks: readonly ChunkReference[],
): Promise<ChunkLedger> {
  validateChunkReferences(chunks, logicalPrefix);
  let ledger = emptyChunkLedger(logicalPrefix);
  for (const reference of chunks) ledger = await appendChunkLedger(store, ledger, reference);
  return ledger;
}

async function appendChunkLedger(
  store: RecoverableArtifactStore,
  ledger: ChunkLedger,
  reference: ChunkReference,
): Promise<ChunkLedger> {
  validateChunkLedger(ledger, ledger.logicalPrefix);
  if (
    reference.sequence !== ledger.totalChunks ||
    reference.firstOrdinal !== ledger.totalRecords ||
    reference.lastOrdinal !== reference.firstOrdinal + reference.recordCount - 1
  ) {
    throw new ChunkIntegrityError('Chunk ledger append is not contiguous');
  }
  const tail = Object.freeze([...ledger.tail, reference]);
  const candidate = Object.freeze({
    ...ledger,
    totalChunks: ledger.totalChunks + 1,
    totalRecords: ledger.totalRecords + reference.recordCount,
    totalByteSize: ledger.totalByteSize + reference.byteSize,
    resumeCursor: reference.resumeCursor,
    licenseSnapshotRefs: Object.freeze(
      [...new Set([...ledger.licenseSnapshotRefs, reference.licenseSnapshotRef])].sort(),
    ),
    tail,
  });
  return tail.length === CHUNK_LEDGER_PAGE_SIZE ? sealChunkLedgerTail(store, candidate) : candidate;
}

async function sealChunkLedgerTail(
  store: RecoverableArtifactStore,
  ledger: ChunkLedger,
): Promise<ChunkLedger> {
  if (ledger.tail.length === 0) return ledger;
  const page = ledgerPage(ledger.sealedPageCount, ledger.tail);
  const stored = await putLedgerJson(store, ledgerPageLogicalKey(ledger, page.page), page, {
    kind: 'chunk-ledger-page',
    page: String(page.page),
  });
  const sealedChainSha256 = hashCanonical({
    format: 'oracle-chunk-ledger-chain-v1',
    previous: ledger.sealedChainSha256,
    page: page.page,
    artifactSha256: stored.sha256,
  });
  return Object.freeze({
    ...ledger,
    sealedPageCount: ledger.sealedPageCount + 1,
    sealedChunkCount: ledger.totalChunks,
    sealedRecordCount: ledger.totalRecords,
    sealedByteSize: ledger.totalByteSize,
    sealedChainSha256,
    tail: Object.freeze([]),
  });
}

async function finishChunkLedger(
  store: RecoverableArtifactStore,
  input: ChunkLedger,
): Promise<Readonly<{ ledger: ChunkLedger; inventory: BoundedDescriptorRoot | null }>> {
  const ledger = input.tail.length === 0 ? input : await sealChunkLedgerTail(store, input);
  if (ledger.totalChunks === 0) return Object.freeze({ ledger, inventory: null });
  const pages: {
    page: number;
    uri: string;
    sha256: string;
    descriptorCount: number;
    firstOrderKey: string;
    lastOrderKey: string;
  }[] = [];
  const rootHash = createHash('sha256');
  let byteSize = 0;
  let recordCount = 0;
  let firstOrderKey: string | null = null;
  let lastOrderKey: string | null = null;
  for (let pageNumber = 0; pageNumber < ledger.sealedPageCount; pageNumber += 1) {
    const loaded = await loadLedgerPage(store, ledger, pageNumber);
    const mustBeFull = pageNumber < ledger.sealedPageCount - 1 || ledger.tail.length > 0;
    if (mustBeFull && loaded.page.descriptors.length !== CHUNK_LEDGER_PAGE_SIZE) {
      throw new ChunkIntegrityError('Chunk ledger sealed a short non-final page');
    }
    const first = loaded.page.descriptors[0];
    const last = loaded.page.descriptors.at(-1);
    if (first === undefined || last === undefined)
      throw new ChunkIntegrityError('Empty ledger page');
    const pageFirst = chunkOrderKey(first);
    const pageLast = chunkOrderKey(last);
    pages.push({
      page: pageNumber,
      uri: loaded.stored.uri,
      sha256: loaded.stored.sha256,
      descriptorCount: loaded.page.descriptors.length,
      firstOrderKey: pageFirst,
      lastOrderKey: pageLast,
    });
    firstOrderKey ??= pageFirst;
    lastOrderKey = pageLast;
    for (const reference of loaded.page.descriptors) {
      rootHash.update(`${canonicalJson(reference)}\n`);
      recordCount += reference.recordCount;
      byteSize += reference.byteSize;
    }
  }
  const index = Object.freeze({
    format: 'oracle-bounded-descriptor-page-index-v1' as const,
    pages: Object.freeze(pages),
  });
  const storedIndex = await putLedgerJson(
    store,
    `${ledger.logicalPrefix}/ledger/index-${ledger.sealedChainSha256}.json`,
    index,
    { kind: 'chunk-ledger-index' },
  );
  return Object.freeze({
    ledger,
    inventory: Object.freeze({
      format: 'oracle-bounded-descriptor-root-v1' as const,
      descriptorCount: ledger.totalChunks,
      recordCount,
      byteSize,
      rootSha256: rootHash.digest('hex'),
      firstOrderKey,
      lastOrderKey,
      pageCount: pages.length,
      pageIndexUri: storedIndex.uri,
      pageIndexSha256: storedIndex.sha256,
    }),
  });
}

export async function* streamChunkLedgerReferences(
  store: RecoverableArtifactStore,
  ledger: ChunkLedger,
  expectedLogicalPrefix: string,
): AsyncIterable<ChunkReference> {
  validateChunkLedger(ledger, expectedLogicalPrefix);
  let chain = EMPTY_SHA256;
  let nextSequence = 0;
  let nextOrdinal = 0;
  let sealedRecords = 0;
  let sealedBytes = 0;
  let lastResumeCursor: string | null = null;
  const licenses = new Set<string>();
  for (let pageNumber = 0; pageNumber < ledger.sealedPageCount; pageNumber += 1) {
    const loaded = await loadLedgerPage(store, ledger, pageNumber);
    const mustBeFull = pageNumber < ledger.sealedPageCount - 1 || ledger.tail.length > 0;
    if (mustBeFull && loaded.page.descriptors.length !== CHUNK_LEDGER_PAGE_SIZE) {
      throw new ChunkIntegrityError('Chunk ledger sealed a short non-final page');
    }
    chain = hashCanonical({
      format: 'oracle-chunk-ledger-chain-v1',
      previous: chain,
      page: pageNumber,
      artifactSha256: loaded.stored.sha256,
    });
    for (const reference of loaded.page.descriptors) {
      assertReferencePosition(reference, nextSequence, nextOrdinal, expectedLogicalPrefix);
      nextSequence += 1;
      nextOrdinal += reference.recordCount;
      sealedRecords += reference.recordCount;
      sealedBytes += reference.byteSize;
      lastResumeCursor = reference.resumeCursor;
      licenses.add(reference.licenseSnapshotRef);
      yield reference;
    }
  }
  if (
    chain !== ledger.sealedChainSha256 ||
    nextSequence !== ledger.sealedChunkCount ||
    sealedRecords !== ledger.sealedRecordCount ||
    sealedBytes !== ledger.sealedByteSize
  ) {
    throw new ChunkIntegrityError('Chunk ledger sealed root or counters disagree');
  }
  for (const reference of ledger.tail) {
    assertReferencePosition(reference, nextSequence, nextOrdinal, expectedLogicalPrefix);
    nextSequence += 1;
    nextOrdinal += reference.recordCount;
    lastResumeCursor = reference.resumeCursor;
    licenses.add(reference.licenseSnapshotRef);
    yield reference;
  }
  if (
    nextSequence !== ledger.totalChunks ||
    nextOrdinal !== ledger.totalRecords ||
    ledger.tail.reduce((sum, reference) => sum + reference.byteSize, sealedBytes) !==
      ledger.totalByteSize ||
    lastResumeCursor !== ledger.resumeCursor ||
    canonicalJson([...licenses].sort()) !== canonicalJson(ledger.licenseSnapshotRefs)
  ) {
    throw new ChunkIntegrityError('Chunk ledger totals or cursor disagree');
  }
}

function ledgerPage(page: number, descriptors: readonly ChunkReference[]) {
  const body = Object.freeze({
    format: 'oracle-bounded-descriptor-page-v1' as const,
    page,
    descriptors: Object.freeze([...descriptors]),
  });
  return Object.freeze({ ...body, pageSha256: boundedDescriptorPageSha256(body) });
}

async function loadLedgerPage(
  store: RecoverableArtifactStore,
  ledger: ChunkLedger,
  page: number,
): Promise<Readonly<{ stored: StoredArtifact; page: ReturnType<typeof ledgerPage> }>> {
  const logicalKey = ledgerPageLogicalKey(ledger, page);
  const stored = await store.headByLogicalKey(logicalKey);
  if (stored === undefined)
    throw new ChunkIntegrityError(`Missing chunk ledger page: ${logicalKey}`);
  const bytes = await readBoundedArtifact(store, stored.uri);
  const decoded = new TextDecoder('utf8', { fatal: true }).decode(bytes);
  const parsed: unknown = JSON.parse(decoded);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ChunkIntegrityError(`Invalid chunk ledger page: ${logicalKey}`);
  }
  const raw = parsed as Readonly<Record<string, unknown>>;
  if (
    raw.format !== 'oracle-bounded-descriptor-page-v1' ||
    raw.page !== page ||
    !Array.isArray(raw.descriptors) ||
    raw.descriptors.length < 1 ||
    raw.descriptors.length > CHUNK_LEDGER_PAGE_SIZE ||
    typeof raw.pageSha256 !== 'string' ||
    Object.keys(raw).sort().join(',') !== 'descriptors,format,page,pageSha256'
  ) {
    throw new ChunkIntegrityError(`Invalid chunk ledger page: ${logicalKey}`);
  }
  const verified = raw as ReturnType<typeof ledgerPage>;
  if (
    verified.pageSha256 !== boundedDescriptorPageSha256(verified) ||
    hashBytes(bytes) !== stored.sha256 ||
    canonicalJson(verified) !== decoded
  ) {
    throw new ChunkIntegrityError(`Invalid chunk ledger page: ${logicalKey}`);
  }
  return Object.freeze({ stored, page: verified });
}

async function putLedgerJson(
  store: RecoverableArtifactStore,
  logicalKey: string,
  value: unknown,
  metadata: Readonly<Record<string, string>>,
): Promise<StoredArtifact> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const expectedSha256 = hashBytes(bytes);
  try {
    return await store.putImmutable({
      logicalKey,
      mediaType: 'application/json',
      body: streamLines([bytes]),
      expectedSha256,
      metadata: { schemaVersion: CHUNK_LEDGER_SCHEMA_VERSION, ...metadata },
      ifAbsent: true,
    });
  } catch (error) {
    const stored = await store.headByLogicalKey(logicalKey);
    if (
      stored?.sha256 !== expectedSha256 ||
      stored.byteSize !== bytes.byteLength ||
      stored.mediaType !== 'application/json'
    ) {
      throw error;
    }
    return stored;
  }
}

async function readBoundedArtifact(
  store: RecoverableArtifactStore,
  uri: string,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let byteSize = 0;
  for await (const chunk of store.read(uri)) {
    byteSize += chunk.byteLength;
    if (byteSize > MAXIMUM_LEDGER_PAGE_BYTES) {
      throw new ChunkIntegrityError('Chunk ledger page exceeds 4 MiB');
    }
    chunks.push(Uint8Array.from(chunk));
  }
  return Buffer.concat(chunks, byteSize);
}

function ledgerPageLogicalKey(ledger: ChunkLedger, page: number): string {
  return `${ledger.logicalPrefix}/ledger/p/${page.toString().padStart(8, '0')}.json`;
}

function validateChunkLedger(ledger: ChunkLedger, expectedLogicalPrefix: string): void {
  const runtime = ledger as Readonly<{ schemaVersion: unknown; pageSize: unknown }>;
  const counters = [
    ledger.sealedPageCount,
    ledger.sealedChunkCount,
    ledger.sealedRecordCount,
    ledger.sealedByteSize,
    ledger.totalChunks,
    ledger.totalRecords,
    ledger.totalByteSize,
  ];
  if (
    runtime.schemaVersion !== CHUNK_LEDGER_SCHEMA_VERSION ||
    runtime.pageSize !== CHUNK_LEDGER_PAGE_SIZE ||
    ledger.logicalPrefix !== expectedLogicalPrefix.replace(/\/$/u, '') ||
    counters.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    ledger.tail.length >= CHUNK_LEDGER_PAGE_SIZE ||
    (ledger.sealedPageCount === 0) !== (ledger.sealedChunkCount === 0) ||
    ledger.sealedChunkCount < ledger.sealedPageCount ||
    ledger.sealedChunkCount > ledger.sealedPageCount * CHUNK_LEDGER_PAGE_SIZE ||
    ledger.sealedChunkCount + ledger.tail.length !== ledger.totalChunks ||
    ledger.sealedRecordCount +
      ledger.tail.reduce((sum, reference) => sum + reference.recordCount, 0) !==
      ledger.totalRecords ||
    ledger.sealedByteSize + ledger.tail.reduce((sum, reference) => sum + reference.byteSize, 0) !==
      ledger.totalByteSize ||
    !/^[a-f\d]{64}$/u.test(ledger.sealedChainSha256) ||
    !Array.isArray(ledger.licenseSnapshotRefs) ||
    ledger.licenseSnapshotRefs.some((value) => typeof value !== 'string' || value.length === 0) ||
    canonicalJson([...new Set(ledger.licenseSnapshotRefs)].sort()) !==
      canonicalJson(ledger.licenseSnapshotRefs)
  ) {
    throw new ChunkIntegrityError('Invalid bounded chunk ledger');
  }
}

function assertReferencePosition(
  reference: ChunkReference,
  sequence: number,
  firstOrdinal: number,
  expectedLogicalPrefix: string,
): void {
  const runtime = reference as Readonly<{ schemaVersion: unknown }>;
  if (
    runtime.schemaVersion !== CHUNK_SCHEMA_VERSION ||
    !Number.isSafeInteger(reference.sequence) ||
    !Number.isSafeInteger(reference.firstOrdinal) ||
    !Number.isSafeInteger(reference.lastOrdinal) ||
    !Number.isSafeInteger(reference.recordCount) ||
    !Number.isSafeInteger(reference.byteSize) ||
    reference.sequence !== sequence ||
    reference.firstOrdinal !== firstOrdinal ||
    reference.lastOrdinal !== firstOrdinal + reference.recordCount - 1 ||
    reference.recordCount < 1 ||
    reference.byteSize < 1 ||
    !reference.logicalKey.startsWith(`${expectedLogicalPrefix.replace(/\/$/u, '')}/`) ||
    reference.licenseSnapshotRef.length === 0
  ) {
    throw new ChunkIntegrityError('Missing, duplicate, or non-contiguous chunk reference');
  }
}

function chunkOrderKey(reference: ChunkReference): string {
  return reference.sequence.toString().padStart(16, '0');
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function hashBytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function* readChunkSequence<T>(
  store: RecoverableArtifactStore,
  chunks: AsyncIterable<ChunkReference>,
): AsyncIterable<T> {
  for await (const reference of chunks) {
    for await (const line of readCanonicalLines(store, reference)) {
      yield JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(line)) as T;
    }
  }
}

async function* arrayReferences(
  chunks: readonly ChunkReference[],
  expectedLogicalPrefix?: string,
): AsyncIterable<ChunkReference> {
  validateChunkReferences(chunks, expectedLogicalPrefix);
  for (const reference of chunks) yield await Promise.resolve(reference);
}

export async function* readCanonicalLines(
  store: RecoverableArtifactStore,
  reference: ChunkReference,
): AsyncIterable<Uint8Array> {
  const pending: Uint8Array[] = [];
  let pendingBytes = 0;
  for await (const chunk of store.read(reference.uri)) {
    let start = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 10) continue;
      const segment = chunk.slice(start, index + 1);
      const lineBytes = pendingBytes + segment.byteLength;
      if (lineBytes > DEFAULT_MAXIMUM_RECORD_BYTES) {
        throw new ChunkIntegrityError(`Chunk line exceeds 1 MiB: ${reference.logicalKey}`);
      }
      if (pending.length === 0) {
        yield segment;
      } else {
        const line = new Uint8Array(lineBytes);
        let offset = 0;
        for (const part of pending) {
          line.set(part, offset);
          offset += part.byteLength;
        }
        line.set(segment, offset);
        yield line;
        pending.length = 0;
        pendingBytes = 0;
      }
      start = index + 1;
    }
    if (start < chunk.byteLength) {
      const suffix = chunk.slice(start);
      pending.push(suffix);
      pendingBytes += suffix.byteLength;
    }
    if (pendingBytes > DEFAULT_MAXIMUM_RECORD_BYTES) {
      throw new ChunkIntegrityError(`Chunk line exceeds 1 MiB: ${reference.logicalKey}`);
    }
  }
  if (pendingBytes !== 0) {
    throw new ChunkIntegrityError(`Chunk lacks canonical trailing LF: ${reference.logicalKey}`);
  }
}

function validateChunkReferences(
  chunks: readonly ChunkReference[],
  expectedLogicalPrefix?: string,
): void {
  let nextOrdinal = 0;
  const keys = new Set<string>();
  for (const [sequence, reference] of chunks.entries()) {
    if (
      !isCurrentChunkSchema(reference.schemaVersion) ||
      reference.sequence !== sequence ||
      reference.firstOrdinal !== nextOrdinal ||
      reference.lastOrdinal !== reference.firstOrdinal + reference.recordCount - 1 ||
      reference.recordCount < 1 ||
      (expectedLogicalPrefix !== undefined &&
        !reference.logicalKey.startsWith(`${expectedLogicalPrefix.replace(/\/$/u, '')}/`)) ||
      keys.has(reference.logicalKey)
    ) {
      throw new ChunkIntegrityError('Missing, duplicate, or non-contiguous chunk reference');
    }
    keys.add(reference.logicalKey);
    nextOrdinal = reference.lastOrdinal + 1;
  }
}

function assertChunkStored(reference: ChunkReference, stored: StoredArtifact | undefined): void {
  if (!chunkMatchesStoredArtifact(reference, stored)) {
    throw new ChunkIntegrityError(`Missing or corrupt chunk: ${reference.logicalKey}`);
  }
}

function isCurrentChunkSchema(value: unknown): boolean {
  return value === CHUNK_SCHEMA_VERSION;
}

function chunkMatchesStoredArtifact(
  reference: ChunkReference,
  stored: StoredArtifact | undefined,
): boolean {
  if (stored === undefined) return false;
  const expectedMetadata = {
    schemaVersion: reference.schemaVersion,
    sequence: String(reference.sequence),
    firstOrdinal: String(reference.firstOrdinal),
    lastOrdinal: String(reference.lastOrdinal),
    recordCount: String(reference.recordCount),
    visibility: reference.visibility,
    licenseSnapshotRef: reference.licenseSnapshotRef,
    resumeCursor: reference.resumeCursor ?? '',
  };
  return (
    stored.logicalKey === reference.logicalKey &&
    stored.uri === reference.uri &&
    stored.mediaType === reference.mediaType &&
    stored.byteSize === reference.byteSize &&
    stored.sha256 === reference.sha256 &&
    Object.entries(expectedMetadata).every(([key, value]) => stored.metadata[key] === value)
  );
}

async function* streamLines(lines: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const line of lines) yield await Promise.resolve(line);
}

export class ChunkIntegrityError extends Error {
  public readonly code = 'CHUNK_INTEGRITY';

  public constructor(message: string) {
    super(message);
    this.name = 'ChunkIntegrityError';
  }
}
