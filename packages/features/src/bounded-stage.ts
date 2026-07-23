import { createHash } from 'node:crypto';

import {
  boundedProcessingBudgetSchema,
  immutableBoundedArtifactSchema,
  type BoundedProcessingBudget,
  type ImmutableBoundedArtifact,
} from '@oracle/contracts/bounded-processing';
import type { Visibility } from '@oracle/contracts/visibility';

const FEATURE_STAGE = 'derive_features' as const;
const NDJSON_MEDIA_TYPE = 'application/x-ndjson' as const;
const MIXED_INTERNAL = 'mixed_internal' as const;
const MAX_CANONICAL_CONTAINER_ITEMS = 256;

export type BoundedFeatureArtifactVisibility = Visibility | typeof MIXED_INTERNAL;

export interface BoundedFeatureInput<TInput> {
  readonly partitionId: number;
  readonly ordinal: number;
  readonly sortKey: string;
  /** Canonical JSON byte size for value; one work item must fit the shared byte budget. */
  readonly byteSize: number;
  /** SHA-256 of canonical JSON for value. */
  readonly contentSha256: string;
  readonly value: TInput;
}

/**
 * A cursor backed by an ordered file, a bounded database cursor, or another
 * spill-backed source. Implementations must not pre-collect the result set.
 */
export interface BoundedFeatureCursor<TInput> {
  /** Metadata-only lookahead; implementations must not materialize `value`. */
  peek(): Promise<Omit<BoundedFeatureInput<TInput>, 'value'> | null>;
  next(): Promise<BoundedFeatureInput<TInput> | null>;
  close(): Promise<void>;
}

export interface BoundedFeatureOutput<TOutput> {
  readonly sortKey: string;
  readonly visibility: BoundedFeatureArtifactVisibility;
  readonly value: TOutput;
}

export interface BoundedFeatureChunkIdentity {
  readonly generationId: string;
  readonly stage: typeof FEATURE_STAGE;
  readonly dataset: string;
  readonly partitionId: number;
  readonly sequence: number;
  readonly visibility: BoundedFeatureArtifactVisibility;
  readonly logicalKey: string;
}

export interface BoundedFeatureChunkCommit {
  readonly uri: string;
  readonly byteSize: number;
  readonly sha256: string;
}

/** A sink must forward each segment to bounded disk/object storage immediately. */
export interface BoundedFeatureChunkSink {
  write(segment: Uint8Array): Promise<void>;
  commit(): Promise<BoundedFeatureChunkCommit>;
  abort(): Promise<void>;
}

export interface BoundedFeatureChunkStore {
  open(identity: BoundedFeatureChunkIdentity): Promise<BoundedFeatureChunkSink>;
  /** Returns only a fully committed immutable object after verifying its stored hash and size. */
  inspect(identity: BoundedFeatureChunkIdentity): Promise<BoundedFeatureChunkCommit | null>;
  /** Atomically adopts the inspected object iff its exact identity, hash, and size still match. */
  adopt(
    identity: BoundedFeatureChunkIdentity,
    expected: BoundedFeatureChunkCommit,
  ): Promise<BoundedFeatureChunkCommit>;
}

export interface BoundedFeatureResumeState {
  readonly generationId: string;
  readonly partitionId: number;
  readonly nextInputOrdinal: number;
  readonly lastInputSortKey: string | null;
  readonly lastInputContentSha256: string | null;
  readonly lastOutputSortKey: string | null;
  readonly nextPublicSequence: number;
  readonly nextAuthenticatedSequence: number;
  readonly nextRestrictedSequence: number;
  readonly nextProhibitedPublicSequence: number;
  readonly nextMixedInternalSequence: number;
  readonly outputRecordCount: number;
  readonly outputByteCount: number;
  readonly logicalPrefixSha256: string;
}

export interface BoundedFeatureDurableCheckpoint extends BoundedFeatureResumeState {
  readonly inputManifestSha256: string;
  readonly lastArtifact: ImmutableBoundedArtifact;
}

export interface BoundedFeatureBudgetSnapshot {
  readonly bufferedRecords: number;
  readonly bufferedBytes: number;
  readonly peakBufferedRecords: number;
  readonly peakBufferedBytes: number;
}

/** Structural bridge for one process-wide coordinator shared across package stages. */
export interface BoundedFeatureBudgetCoordinator {
  acquire(records: number, bytes: number): () => void;
  assertPolicy(policy: BoundedProcessingBudget): void;
  snapshot(): BoundedFeatureBudgetSnapshot;
}

export interface BoundedFeatureStageResult {
  readonly generationId: string;
  readonly partitionId: number;
  readonly inputRecordCount: number;
  readonly outputRecordCount: number;
  readonly outputByteCount: number;
  readonly artifactCount: number;
  readonly logicalSha256: string;
  readonly finalResumeState: BoundedFeatureResumeState;
  readonly budget: BoundedFeatureBudgetSnapshot;
}

export interface BoundedFeatureStageRequest<TInput, TOutput> {
  readonly generationId: string;
  readonly partitionId: number;
  readonly dataset: string;
  readonly artifactLogicalPrefix: string;
  readonly inputManifestSha256: string;
  readonly outputSchemaSha256: string;
  readonly sourceLineageSha256: string;
  readonly licenseIdentitySha256: string;
  readonly budget: BoundedProcessingBudget;
  /** Hard ceiling reserved before one input value is materialized or validated. */
  readonly maxInputBytesPerRecord: number;
  /** Hard ceiling reserved before one derived encoded row is allocated. */
  readonly maxOutputBytesPerRecord: number;
  readonly cursor: BoundedFeatureCursor<TInput>;
  readonly store: BoundedFeatureChunkStore;
  /** Must invoke the existing authoritative feature algorithm for exactly one work item. */
  readonly derive: (
    input: TInput,
    identity: Readonly<{ partitionId: number; ordinal: number; sortKey: string }>,
  ) => BoundedFeatureOutput<TOutput> | Promise<BoundedFeatureOutput<TOutput>>;
  readonly persistCheckpoint: (checkpoint: BoundedFeatureDurableCheckpoint) => Promise<void>;
  readonly recordArtifact: (artifact: ImmutableBoundedArtifact) => Promise<void>;
  readonly resume?: BoundedFeatureDurableCheckpoint;
  readonly rssBytes?: () => number;
}

export class BoundedFeatureIntegrityError extends Error {
  public readonly code = 'BOUNDED_INPUT_INTEGRITY' as const;
}

export class BoundedFeatureBudgetError extends Error {
  public readonly code = 'BOUNDED_BUDGET_EXCEEDED' as const;
}

/**
 * One shared lease instance is passed to every concurrent partition worker.
 * It accounts for only process-resident segments; the sink owns bounded spill.
 */
export class ProcessWideFeatureBudget implements BoundedFeatureBudgetCoordinator {
  private bufferedRecords = 0;
  private bufferedBytes = 0;
  private peakBufferedRecords = 0;
  private peakBufferedBytes = 0;

  public constructor(private readonly policy: BoundedProcessingBudget) {
    boundedProcessingBudgetSchema.parse(policy);
  }

  public acquire(records: number, bytes: number): () => void {
    assertSafeNonnegative(records, 'lease records');
    assertSafeNonnegative(bytes, 'lease bytes');
    const nextRecords = this.bufferedRecords + records;
    const nextBytes = this.bufferedBytes + bytes;
    if (nextRecords > this.policy.maxBufferedRecords || nextBytes > this.policy.maxBufferedBytes) {
      throw new BoundedFeatureBudgetError('Feature stage exceeded the shared buffered budget');
    }
    this.bufferedRecords = nextRecords;
    this.bufferedBytes = nextBytes;
    this.peakBufferedRecords = Math.max(this.peakBufferedRecords, nextRecords);
    this.peakBufferedBytes = Math.max(this.peakBufferedBytes, nextBytes);
    let released = false;
    return () => {
      if (released) throw new Error('Feature budget lease was released twice');
      released = true;
      this.bufferedRecords -= records;
      this.bufferedBytes -= bytes;
    };
  }

  public snapshot(): BoundedFeatureBudgetSnapshot {
    return Object.freeze({
      bufferedRecords: this.bufferedRecords,
      bufferedBytes: this.bufferedBytes,
      peakBufferedRecords: this.peakBufferedRecords,
      peakBufferedBytes: this.peakBufferedBytes,
    });
  }

  public assertPolicy(policy: BoundedProcessingBudget): void {
    if (boundedFeatureValueSha256(this.policy) !== boundedFeatureValueSha256(policy)) {
      throw new BoundedFeatureBudgetError('Shared feature budget does not match the stage policy');
    }
  }
}

interface OpenChunk {
  readonly identity: BoundedFeatureChunkIdentity;
  readonly sink: BoundedFeatureChunkSink | null;
  readonly orphan: BoundedFeatureChunkCommit | null;
  readonly hash: ReturnType<typeof createHash>;
  recordCount: number;
  byteSize: number;
  firstSortKey: string;
  lastSortKey: string;
}

const INITIAL_PREFIX_SHA256 = sha256Bytes(new Uint8Array());

export function initialBoundedFeatureResumeState(
  generationId: string,
  partitionId: number,
): BoundedFeatureResumeState {
  return Object.freeze({
    generationId,
    partitionId,
    nextInputOrdinal: 0,
    lastInputSortKey: null,
    lastInputContentSha256: null,
    lastOutputSortKey: null,
    nextPublicSequence: 0,
    nextAuthenticatedSequence: 0,
    nextRestrictedSequence: 0,
    nextProhibitedPublicSequence: 0,
    nextMixedInternalSequence: 0,
    outputRecordCount: 0,
    outputByteCount: 0,
    logicalPrefixSha256: INITIAL_PREFIX_SHA256,
  });
}

export function boundedFeatureValueSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export async function runBoundedFeaturePartition<TInput, TOutput>(
  request: BoundedFeatureStageRequest<TInput, TOutput>,
  sharedBudget: BoundedFeatureBudgetCoordinator,
): Promise<BoundedFeatureStageResult> {
  const budget = boundedProcessingBudgetSchema.parse(request.budget);
  const coordinator = sharedBudget as BoundedFeatureBudgetCoordinator | undefined;
  if (coordinator === undefined) {
    throw new BoundedFeatureBudgetError(
      'Feature package calls require an explicit process-wide budget coordinator',
    );
  }
  if (
    typeof request.cursor.peek !== 'function' ||
    !Number.isSafeInteger(request.maxInputBytesPerRecord) ||
    request.maxInputBytesPerRecord < 1 ||
    request.maxInputBytesPerRecord > budget.maxBufferedBytes ||
    !Number.isSafeInteger(request.maxOutputBytesPerRecord) ||
    request.maxOutputBytesPerRecord < 1 ||
    request.maxOutputBytesPerRecord > budget.maxBytesPerOutputChunk ||
    request.maxInputBytesPerRecord + request.maxOutputBytesPerRecord > budget.maxBufferedBytes
  ) {
    throw new BoundedFeatureBudgetError(
      'Feature workers require metadata lookahead and a bounded output reservation',
    );
  }
  coordinator.assertPolicy(budget);
  const inspectOrphan = request.store.inspect.bind(request.store);
  const adoptOrphan = request.store.adopt.bind(request.store);
  assertPartition(request.partitionId);
  assertNonEmpty(request.dataset, 'dataset');
  assertNonEmpty(request.artifactLogicalPrefix, 'artifactLogicalPrefix');
  assertSha256(request.inputManifestSha256, 'inputManifestSha256');
  assertSha256(request.outputSchemaSha256, 'outputSchemaSha256');
  assertSha256(request.sourceLineageSha256, 'sourceLineageSha256');
  assertSha256(request.licenseIdentitySha256, 'licenseIdentitySha256');
  const state = mutableResume(
    request.resume ?? initialBoundedFeatureResumeState(request.generationId, request.partitionId),
  );
  if (state.generationId !== request.generationId || state.partitionId !== request.partitionId) {
    throw new BoundedFeatureIntegrityError(
      'Resume state belongs to another generation or partition',
    );
  }
  if (request.resume !== undefined) validateResume(request.resume, request);

  const rssBytes = request.rssBytes ?? (() => process.memoryUsage().rss);
  let open: OpenChunk | null = null;
  let inputRecordCount = 0;
  let artifactCount = 0;
  let sinceRssSample = 0;

  const commitOpen = async (): Promise<void> => {
    const current = open;
    if (current === null) return;
    const expectedSha256 = current.hash.digest('hex');
    let committed: BoundedFeatureChunkCommit;
    try {
      if (current.orphan === null) {
        if (current.sink === null) throw new BoundedFeatureIntegrityError('Feature sink missing');
        committed = await current.sink.commit();
      } else {
        if (
          current.orphan.byteSize !== current.byteSize ||
          current.orphan.sha256 !== expectedSha256
        ) {
          throw new BoundedFeatureIntegrityError(
            'Committed feature orphan does not match deterministic replay bytes',
          );
        }
        committed = await adoptOrphan.call(request.store, current.identity, current.orphan);
      }
    } catch (error) {
      await current.sink?.abort();
      open = null;
      throw error;
    }
    if (committed.byteSize !== current.byteSize || committed.sha256 !== expectedSha256) {
      await current.sink?.abort();
      open = null;
      throw new BoundedFeatureIntegrityError('Chunk store commit does not match streamed bytes');
    }
    open = null;
    const artifact = immutableBoundedArtifactSchema.parse({
      generationId: request.generationId,
      stage: FEATURE_STAGE,
      dataset: request.dataset,
      partitionId: request.partitionId,
      sequence: current.identity.sequence,
      logicalKey: current.identity.logicalKey,
      uri: committed.uri,
      mediaType: NDJSON_MEDIA_TYPE,
      byteSize: current.byteSize,
      sha256: expectedSha256,
      recordCount: current.recordCount,
      firstSortKey: current.firstSortKey,
      lastSortKey: current.lastSortKey,
      schemaSha256: request.outputSchemaSha256,
      sourceLineageSha256: request.sourceLineageSha256,
      licenseIdentitySha256: request.licenseIdentitySha256,
      visibility: current.identity.visibility,
    });
    await request.recordArtifact(artifact);
    incrementSequence(state, current.identity.visibility);
    artifactCount += 1;
    await request.persistCheckpoint(
      Object.freeze({
        ...freezeResume(state),
        inputManifestSha256: request.inputManifestSha256,
        lastArtifact: artifact,
      }),
    );
  };

  try {
    for (;;) {
      const preview = await request.cursor.peek();
      if (preview === null) break;
      if (preview.byteSize > request.maxInputBytesPerRecord) {
        throw new BoundedFeatureBudgetError(
          'Feature input metadata exceeds its preallocated validation lease',
        );
      }
      const reservedBytes = request.maxInputBytesPerRecord + request.maxOutputBytesPerRecord;
      // Acquire before cursor value materialization and derive/output allocation.
      const release = coordinator.acquire(1, reservedBytes);
      try {
        const input = await request.cursor.next();
        if (input === null) break;
        if (
          preview.partitionId !== input.partitionId ||
          preview.ordinal !== input.ordinal ||
          preview.sortKey !== input.sortKey ||
          preview.byteSize !== input.byteSize ||
          preview.contentSha256 !== input.contentSha256
        ) {
          throw new BoundedFeatureIntegrityError(
            'Feature cursor changed identity between lookahead and materialization',
          );
        }
        validateInput(input, request.partitionId, state, request.maxInputBytesPerRecord);
        const derived = await request.derive(input.value, {
          partitionId: input.partitionId,
          ordinal: input.ordinal,
          sortKey: input.sortKey,
        });
        validateOutput(derived, state.lastOutputSortKey);
        const measuredOutputBytes =
          measureCanonicalJsonBytes(
            derived.value,
            request.maxOutputBytesPerRecord - 1,
            MAX_CANONICAL_CONTAINER_ITEMS,
          ) + 1;
        if (measuredOutputBytes > request.maxOutputBytesPerRecord) {
          throw new BoundedFeatureBudgetError(
            'Feature output exceeds its preallocated canonical encoding lease',
          );
        }
        const line = new TextEncoder().encode(`${canonicalJson(derived.value)}\n`);
        if (
          input.byteSize + line.byteLength > reservedBytes ||
          line.byteLength > request.maxOutputBytesPerRecord
        ) {
          throw new BoundedFeatureBudgetError(
            'Feature input and output exceed one process-wide work-item lease',
          );
        }
        if (line.byteLength > budget.maxBytesPerOutputChunk) {
          throw new BoundedFeatureBudgetError('One feature row exceeds maxBytesPerOutputChunk');
        }
        if (
          open !== null &&
          (open.identity.visibility !== derived.visibility ||
            open.recordCount + 1 > budget.maxRecordsPerOutputChunk ||
            open.byteSize + line.byteLength > budget.maxBytesPerOutputChunk)
        ) {
          await commitOpen();
        }
        if (open === null) {
          const identity: BoundedFeatureChunkIdentity = chunkIdentity(
            request,
            derived.visibility,
            sequenceFor(state, derived.visibility),
          );
          const orphan = await inspectOrphan.call(request.store, identity);
          open = {
            identity,
            sink: orphan === null ? await request.store.open(identity) : null,
            orphan,
            hash: createHash('sha256'),
            recordCount: 0,
            byteSize: 0,
            firstSortKey: derived.sortKey,
            lastSortKey: derived.sortKey,
          };
        }
        await open.sink?.write(line);
        open.hash.update(line);
        open.recordCount += 1;
        open.byteSize += line.byteLength;
        open.lastSortKey = derived.sortKey;
        state.nextInputOrdinal = input.ordinal + 1;
        state.lastInputSortKey = input.sortKey;
        state.lastInputContentSha256 = input.contentSha256;
        state.lastOutputSortKey = derived.sortKey;
        state.outputRecordCount += 1;
        state.outputByteCount += line.byteLength;
        state.logicalPrefixSha256 = hashChain(state.logicalPrefixSha256, input.contentSha256, line);
        inputRecordCount += 1;
        sinceRssSample += 1;
        if (sinceRssSample >= budget.rssSampleIntervalRecords) {
          sinceRssSample = 0;
          if (rssBytes() > budget.maxRssBytes) {
            throw new BoundedFeatureBudgetError('Feature stage exceeded maxRssBytes');
          }
        }
      } finally {
        release();
      }
    }
    await commitOpen();
  } catch (error) {
    if (open !== null) await open.sink?.abort();
    throw error;
  } finally {
    await request.cursor.close();
  }

  const snapshot = coordinator.snapshot();
  return Object.freeze({
    generationId: request.generationId,
    partitionId: request.partitionId,
    inputRecordCount,
    outputRecordCount: state.outputRecordCount,
    outputByteCount: state.outputByteCount,
    artifactCount,
    logicalSha256: state.logicalPrefixSha256,
    finalResumeState: freezeResume(state),
    budget: snapshot,
  });
}

type MutableResumeState = {
  -readonly [K in keyof BoundedFeatureResumeState]: BoundedFeatureResumeState[K];
};

function mutableResume(state: BoundedFeatureResumeState): MutableResumeState {
  return {
    generationId: state.generationId,
    partitionId: state.partitionId,
    nextInputOrdinal: state.nextInputOrdinal,
    lastInputSortKey: state.lastInputSortKey,
    lastInputContentSha256: state.lastInputContentSha256,
    lastOutputSortKey: state.lastOutputSortKey,
    nextPublicSequence: state.nextPublicSequence,
    nextAuthenticatedSequence: state.nextAuthenticatedSequence,
    nextRestrictedSequence: state.nextRestrictedSequence,
    nextProhibitedPublicSequence: state.nextProhibitedPublicSequence,
    nextMixedInternalSequence: state.nextMixedInternalSequence,
    outputRecordCount: state.outputRecordCount,
    outputByteCount: state.outputByteCount,
    logicalPrefixSha256: state.logicalPrefixSha256,
  };
}

function freezeResume(state: MutableResumeState): BoundedFeatureResumeState {
  return Object.freeze({ ...state });
}

function validateInput<T>(
  input: BoundedFeatureInput<T>,
  partitionId: number,
  state: MutableResumeState,
  maximumInputBytes: number,
): void {
  if (input.partitionId !== partitionId || input.ordinal !== state.nextInputOrdinal) {
    throw new BoundedFeatureIntegrityError(
      'Feature input is replayed, skipped, or from another partition',
    );
  }
  if (
    input.sortKey.length === 0 ||
    (state.lastInputSortKey !== null && compareUtf8(state.lastInputSortKey, input.sortKey) >= 0)
  ) {
    throw new BoundedFeatureIntegrityError('Feature input sort order is not strictly increasing');
  }
  const measuredBytes = measureCanonicalJsonBytes(
    input.value,
    maximumInputBytes,
    MAX_CANONICAL_CONTAINER_ITEMS,
  );
  const bytes = new TextEncoder().encode(canonicalJson(input.value));
  if (input.byteSize !== bytes.byteLength || input.byteSize > maximumInputBytes) {
    throw new BoundedFeatureBudgetError('Feature input work item exceeds its declared byte budget');
  }
  if (measuredBytes !== bytes.byteLength) {
    throw new BoundedFeatureIntegrityError('Feature input canonical byte measurement drifted');
  }
  if (sha256Bytes(bytes) !== input.contentSha256) {
    throw new BoundedFeatureIntegrityError('Feature input content hash mismatch');
  }
}

function measureCanonicalJsonBytes(
  value: unknown,
  maximumBytes: number,
  maximumArrayItems: number,
): number {
  let bytes: number;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Feature value contains a non-finite number');
    bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  } else if (Array.isArray(value)) {
    if (value.length > maximumArrayItems) {
      throw new BoundedFeatureBudgetError('Feature value contains a corpus-proportional array');
    }
    bytes = 2;
    for (let index = 0; index < value.length; index += 1) {
      bytes += measureCanonicalJsonBytes(value[index], maximumBytes - bytes, maximumArrayItems);
      if (index > 0) bytes += 1;
      if (bytes > maximumBytes) break;
    }
  } else if (typeof value === 'object') {
    bytes = 2;
    const entries = Object.entries(value as Readonly<Record<string, unknown>>).filter(
      ([, item]) => item !== undefined,
    );
    if (entries.length > maximumArrayItems) {
      throw new BoundedFeatureBudgetError('Feature value contains too many object fields');
    }
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry === undefined) continue;
      bytes += Buffer.byteLength(JSON.stringify(entry[0]), 'utf8') + 1;
      bytes += measureCanonicalJsonBytes(entry[1], maximumBytes - bytes, maximumArrayItems);
      if (index > 0) bytes += 1;
      if (bytes > maximumBytes) break;
    }
  } else {
    throw new TypeError(`Feature value is not canonical JSON: ${typeof value}`);
  }
  if (bytes > maximumBytes) {
    throw new BoundedFeatureBudgetError('Feature value exceeds its canonical byte reservation');
  }
  return bytes;
}

function validateResume<TInput, TOutput>(
  resume: BoundedFeatureDurableCheckpoint,
  request: BoundedFeatureStageRequest<TInput, TOutput>,
): void {
  const artifact = resume.lastArtifact;
  if (resume.inputManifestSha256 !== request.inputManifestSha256) {
    throw new BoundedFeatureIntegrityError('Feature checkpoint input manifest is stale');
  }
  if (
    artifact.generationId !== request.generationId ||
    artifact.stage !== FEATURE_STAGE ||
    artifact.partitionId !== request.partitionId ||
    artifact.lastSortKey !== resume.lastOutputSortKey ||
    artifact.sequence + 1 !== sequenceFor(mutableResume(resume), artifact.visibility)
  ) {
    throw new BoundedFeatureIntegrityError('Feature checkpoint artifact identity is inconsistent');
  }
}

function validateOutput<T>(output: BoundedFeatureOutput<T>, lastSortKey: string | null): void {
  if (
    output.sortKey.length === 0 ||
    (lastSortKey !== null && compareUtf8(lastSortKey, output.sortKey) >= 0)
  ) {
    throw new BoundedFeatureIntegrityError('Feature output sort order is not strictly increasing');
  }
  if (
    !['public', 'authenticated', 'restricted', 'prohibited_public', MIXED_INTERNAL].includes(
      output.visibility,
    )
  ) {
    throw new BoundedFeatureIntegrityError('Feature output visibility is invalid');
  }
}

function chunkIdentity<TInput, TOutput>(
  request: BoundedFeatureStageRequest<TInput, TOutput>,
  visibility: BoundedFeatureArtifactVisibility,
  sequence: number,
): BoundedFeatureChunkIdentity {
  const partition = request.partitionId.toString().padStart(12, '0');
  const chunk = sequence.toString().padStart(12, '0');
  return Object.freeze({
    generationId: request.generationId,
    stage: FEATURE_STAGE,
    dataset: request.dataset,
    partitionId: request.partitionId,
    sequence,
    visibility,
    logicalKey: `${request.artifactLogicalPrefix}/${request.dataset}/${visibility}/p-${partition}/chunk-${chunk}.ndjson`,
  });
}

function sequenceFor(
  state: MutableResumeState,
  visibility: BoundedFeatureArtifactVisibility,
): number {
  switch (visibility) {
    case 'public':
      return state.nextPublicSequence;
    case 'authenticated':
      return state.nextAuthenticatedSequence;
    case 'restricted':
      return state.nextRestrictedSequence;
    case 'prohibited_public':
      return state.nextProhibitedPublicSequence;
    case MIXED_INTERNAL:
      return state.nextMixedInternalSequence;
  }
}

function incrementSequence(
  state: MutableResumeState,
  visibility: BoundedFeatureArtifactVisibility,
): void {
  switch (visibility) {
    case 'public':
      state.nextPublicSequence += 1;
      break;
    case 'authenticated':
      state.nextAuthenticatedSequence += 1;
      break;
    case 'restricted':
      state.nextRestrictedSequence += 1;
      break;
    case 'prohibited_public':
      state.nextProhibitedPublicSequence += 1;
      break;
    case MIXED_INTERNAL:
      state.nextMixedInternalSequence += 1;
      break;
  }
}

function hashChain(prefix: string, inputSha256: string, output: Uint8Array): string {
  return createHash('sha256')
    .update(Buffer.from(prefix, 'hex'))
    .update(Buffer.from(inputSha256, 'hex'))
    .update(output)
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Feature output contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Readonly<Record<string, unknown>>)
      .filter((entry) => entry[1] !== undefined)
      .sort((left, right) => compareUtf8(left[0], right[0]));
    return `{${entries.map((entry) => `${JSON.stringify(entry[0])}:${canonicalJson(entry[1])}`).join(',')}}`;
  }
  throw new TypeError(`Feature value is not canonical JSON: ${typeof value}`);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new TypeError(`${label} must not be empty`);
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${label} must be SHA-256`);
}

function assertPartition(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError('partitionId must be a non-negative safe integer');
}

function assertSafeNonnegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${label} must be a non-negative safe integer`);
}
