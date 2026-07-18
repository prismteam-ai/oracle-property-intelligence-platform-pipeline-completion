import { createHash } from 'node:crypto';

import type { RecoverableArtifactStore, StoredArtifact } from '@oracle/artifacts/artifact-store';
import type {
  RecordBudgetLease,
  SharedRecordBudget,
} from '@oracle/source-adapters/spi/record-budget';

import { canonicalJson } from './canonical-json.js';

export const CHUNK_SCHEMA_VERSION = '2.0.0' as const;

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

export type ChunkSequence<T> = Readonly<{
  schemaVersion: typeof CHUNK_SCHEMA_VERSION;
  recordCount: number;
  logicalSha256: string;
  chunks: readonly ChunkReference[];
  read(): AsyncIterable<T>;
}>;

export function emptyChunkSequence<T>(): ChunkSequence<T> {
  const logicalSha256 = createHash('sha256').digest('hex');
  return Object.freeze({
    schemaVersion: CHUNK_SCHEMA_VERSION,
    recordCount: 0,
    logicalSha256,
    chunks: Object.freeze([]),
    read: async function* () {
      yield* await Promise.resolve([] as T[]);
    },
  });
}

type Buffered<T> = Readonly<{ value: T; lease: RecordBudgetLease }>;

export class CanonicalChunkWriter<T> {
  readonly #store: RecoverableArtifactStore;
  readonly #logicalPrefix: string;
  readonly #visibility: string;
  readonly #licenseSnapshotRef: string;
  readonly #budget: SharedRecordBudget;
  readonly #signal: AbortSignal;
  readonly #onChunk: (chunks: readonly ChunkReference[]) => Promise<void>;
  readonly #maximumRecordsPerChunk: number;
  readonly #cursorFor: ((value: T) => string | null) | undefined;
  readonly #onBufferedRecordDelta: ((delta: number) => void) | undefined;
  readonly #chunks: ChunkReference[];
  readonly #logicalHash = createHash('sha256');
  readonly #buffer: Buffered<T>[] = [];
  #recordCount = 0;

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
      restoredChunks?: readonly ChunkReference[];
      cursorFor?: (value: T) => string | null;
      onBufferedRecordDelta?: (delta: number) => void;
      onChunk: (chunks: readonly ChunkReference[]) => Promise<void>;
    }>,
  ) {
    if (!Number.isSafeInteger(input.maximumRecordsPerChunk) || input.maximumRecordsPerChunk < 1) {
      throw new RangeError('maximumRecordsPerChunk must be a positive safe integer');
    }
    this.#store = input.store;
    this.#logicalPrefix = input.logicalPrefix.replace(/\/$/u, '');
    this.#visibility = input.visibility;
    this.#licenseSnapshotRef = input.licenseSnapshotRef;
    this.#budget = input.budget;
    this.#signal = input.signal;
    this.#maximumRecordsPerChunk = input.maximumRecordsPerChunk;
    this.#chunks = [...(input.restoredChunks ?? [])];
    this.#cursorFor = input.cursorFor;
    this.#onBufferedRecordDelta = input.onBufferedRecordDelta;
    this.#onChunk = input.onChunk;
  }

  public async restore(): Promise<void> {
    validateChunkReferences(this.#chunks);
    for (const reference of this.#chunks) {
      const stored = await this.#store.headByLogicalKey(reference.logicalKey);
      assertChunkStored(reference, stored);
      let count = 0;
      for await (const line of readCanonicalLines(this.#store, reference)) {
        this.#logicalHash.update(line);
        count += 1;
      }
      if (count !== reference.recordCount) {
        throw new ChunkIntegrityError(`Chunk record-count mismatch: ${reference.logicalKey}`);
      }
      this.#recordCount += count;
    }
  }

  public async append(value: T, transferredLease?: RecordBudgetLease): Promise<void> {
    this.#signal.throwIfAborted();
    if (
      transferredLease === undefined &&
      this.#budget.metrics().inUse >= this.#budget.capacity &&
      this.#buffer.length > 0
    ) {
      await this.flush();
    }
    const lease = transferredLease ?? (await this.#budget.acquire(this.#signal));
    this.#buffer.push(Object.freeze({ value, lease }));
    this.#onBufferedRecordDelta?.(1);
    if (this.#buffer.length >= this.#maximumRecordsPerChunk) await this.flush();
  }

  public async flush(): Promise<void> {
    if (this.#buffer.length === 0) return;
    const buffered = [...this.#buffer];
    const firstOrdinal = this.#recordCount;
    const lines = buffered.map(({ value }) =>
      new TextEncoder().encode(`${canonicalJson(value)}\n`),
    );
    const chunkHash = createHash('sha256');
    let byteSize = 0;
    for (const line of lines) {
      chunkHash.update(line);
      byteSize += line.byteLength;
    }
    const sha256 = chunkHash.digest('hex');
    const sequence = this.#chunks.length;
    const logicalKey = `${this.#logicalPrefix}/${sequence.toString().padStart(8, '0')}-${firstOrdinal.toString().padStart(12, '0')}-${sha256}.ndjson`;
    const resumeCursor = this.#cursorFor?.(buffered.at(-1)?.value as T) ?? null;
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
    await this.#onChunk(Object.freeze([...this.#chunks, reference]));
    this.#chunks.push(reference);
    this.#recordCount += buffered.length;
    for (const line of lines) this.#logicalHash.update(line);
    this.#buffer.splice(0, buffered.length);
    this.#onBufferedRecordDelta?.(-buffered.length);
    for (const { lease } of buffered) {
      lease.release();
    }
  }

  public async finish(): Promise<ChunkSequence<T>> {
    await this.flush();
    const chunks = Object.freeze([...this.#chunks]);
    const logicalSha256 = this.#logicalHash.digest('hex');
    const store = this.#store;
    return Object.freeze({
      schemaVersion: CHUNK_SCHEMA_VERSION,
      recordCount: this.#recordCount,
      logicalSha256,
      chunks,
      read: () => readChunkSequence<T>(store, chunks),
    });
  }

  /** Releases every buffered lease after an abort/error without writing a partial chunk. */
  public abort(): void {
    const buffered = this.#buffer.splice(0);
    this.#onBufferedRecordDelta?.(-buffered.length);
    for (const { lease } of buffered) lease.release();
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

export async function openChunkSequencePrefix<T>(
  store: RecoverableArtifactStore,
  chunks: readonly ChunkReference[],
): Promise<ChunkSequence<T>> {
  validateChunkReferences(chunks);
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
    read: () => readChunkSequence<T>(store, frozen),
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
  const chunks: ChunkReference[] = [];
  for (const sequence of frozen) {
    for (const reference of sequence.chunks) chunks.push(reference);
  }
  return Object.freeze({
    schemaVersion: CHUNK_SCHEMA_VERSION,
    recordCount,
    logicalSha256: logical.digest('hex'),
    chunks: Object.freeze(chunks),
    read: async function* () {
      for (const sequence of frozen) yield* sequence.read();
    },
  });
}

async function* readChunkSequence<T>(
  store: RecoverableArtifactStore,
  chunks: readonly ChunkReference[],
): AsyncIterable<T> {
  for (const reference of chunks) {
    for await (const line of readCanonicalLines(store, reference)) {
      yield JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(line)) as T;
    }
  }
}

async function* readCanonicalLines(
  store: RecoverableArtifactStore,
  reference: ChunkReference,
): AsyncIterable<Uint8Array> {
  let pending = new Uint8Array(0);
  for await (const chunk of store.read(reference.uri)) {
    const combined = new Uint8Array(pending.byteLength + chunk.byteLength);
    combined.set(pending);
    combined.set(chunk, pending.byteLength);
    let start = 0;
    for (let index = 0; index < combined.byteLength; index += 1) {
      if (combined[index] !== 10) continue;
      yield combined.slice(start, index + 1);
      start = index + 1;
    }
    pending = combined.slice(start);
    if (pending.byteLength > 16 * 1024 * 1024) {
      throw new ChunkIntegrityError(`Chunk line exceeds 16 MiB: ${reference.logicalKey}`);
    }
  }
  if (pending.byteLength !== 0) {
    throw new ChunkIntegrityError(`Chunk lacks canonical trailing LF: ${reference.logicalKey}`);
  }
}

function validateChunkReferences(chunks: readonly ChunkReference[]): void {
  let nextOrdinal = 0;
  const keys = new Set<string>();
  for (const [sequence, reference] of chunks.entries()) {
    if (
      !isCurrentChunkSchema(reference.schemaVersion) ||
      reference.sequence !== sequence ||
      reference.firstOrdinal !== nextOrdinal ||
      reference.lastOrdinal !== reference.firstOrdinal + reference.recordCount - 1 ||
      reference.recordCount < 1 ||
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
