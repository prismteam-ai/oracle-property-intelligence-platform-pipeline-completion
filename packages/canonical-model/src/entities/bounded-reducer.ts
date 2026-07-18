import type {
  BoundedProcessingBudget,
  ImmutableBoundedArtifact,
} from '@oracle/contracts/bounded-processing';
import {
  mutationSortKeyHex,
  partitionForMutation,
  semanticMutationGroupKey,
} from '@oracle/contracts/bounded-processing';
import { canonicalMutationSchema } from '@oracle/contracts/canonical/mutation';
import type {
  CanonicalArtifactReference,
  CanonicalMutation,
  EntityLinkCandidate,
} from '@oracle/contracts/canonical/mutation';

import type { ProcessWideBudgetCoordinator } from '../bounded-budget.js';
import { canonicalJson, sha256 } from '../normalizers/core.js';
import { reduceCanonicalEntityGroup } from './reducer.js';
import type { CanonicalEntityAggregate } from './reducer.js';

export const BOUNDED_CANONICAL_STAGE_VERSION = 'bounded-canonical-reduction-v1' as const;

export type DurableIdentityClaim = 'claimed' | 'replay';

/**
 * A partition transaction is backed by a durable unique index in production.
 * `claimMutation` must atomically insert (mutationId, contentSha256), return
 * `replay` for an identical existing row, and reject identity/content collisions.
 */
export interface BoundedCanonicalPartitionTransaction {
  readonly generationId: string;
  readonly partitionId: number;
  claimMutation(mutationId: string, contentSha256: string): Promise<DurableIdentityClaim>;
  writeEntity(value: CanonicalEntityAggregate): Promise<void>;
  writeLink(value: EntityLinkCandidate): Promise<void>;
  writeArtifact(value: CanonicalArtifactReference): Promise<void>;
  finalize(summary: BoundedCanonicalPartitionSummary): Promise<void>;
  abort(reason: unknown): Promise<void>;
}

export type BoundedCanonicalPartitionInput = Readonly<{
  generationId: string;
  partitionId: number;
  partitionCount: number;
  artifact: ImmutableBoundedArtifact;
  budget: BoundedProcessingBudget;
  /** Maximum canonical bytes for one mutation, reserved before validation/serialization. */
  maximumMutationBytes: number;
  /** Maximum canonical bytes for one reduced aggregate, reserved before reduction. */
  maximumAggregateBytes: number;
  mutations: AsyncIterable<unknown>;
  transaction: BoundedCanonicalPartitionTransaction;
  /** One instance must be shared by every concurrent downstream worker. */
  sharedBudget: ProcessWideBudgetCoordinator;
  sampleRssBytes?: () => number;
}>;

export type BoundedCanonicalPartitionSummary = Readonly<{
  stageVersion: typeof BOUNDED_CANONICAL_STAGE_VERSION;
  generationId: string;
  partitionId: number;
  inputRecords: number;
  replayRecords: number;
  entityRecords: number;
  linkRecords: number;
  artifactRecords: number;
  peakBufferedRecords: number;
  peakBufferedBytes: number;
  peakRssBytes: number;
  firstSortKey: string | null;
  lastSortKey: string | null;
}>;

export class BoundedCanonicalIntegrityError extends Error {
  public readonly code = 'BOUNDED_INPUT_INTEGRITY' as const;
}

export class BoundedCanonicalBudgetError extends Error {
  public readonly code = 'BOUNDED_BUDGET_EXCEEDED' as const;
}

function assertEnvelope(input: BoundedCanonicalPartitionInput): void {
  if (input.transaction.generationId !== input.generationId) {
    throw new BoundedCanonicalIntegrityError('Canonical transaction has a mixed generation');
  }
  if (
    input.transaction.partitionId !== input.partitionId ||
    input.artifact.partitionId !== input.partitionId
  ) {
    throw new BoundedCanonicalIntegrityError('Canonical transaction has a stale partition');
  }
  if (input.artifact.generationId !== input.generationId) {
    throw new BoundedCanonicalIntegrityError('Canonical artifact has a mixed generation');
  }
  if (input.artifact.stage !== 'partition_mutations') {
    throw new BoundedCanonicalIntegrityError(
      'Canonical input is not a partitioned mutation artifact',
    );
  }
  if (
    !Number.isSafeInteger(input.partitionCount) ||
    input.partitionCount < 1 ||
    input.partitionId < 0 ||
    input.partitionId >= input.partitionCount
  ) {
    throw new BoundedCanonicalIntegrityError('Canonical partition coordinates are invalid');
  }
  for (const [label, value] of [
    ['maximumMutationBytes', input.maximumMutationBytes],
    ['maximumAggregateBytes', input.maximumAggregateBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > input.budget.maxBufferedBytes) {
      throw new BoundedCanonicalBudgetError(`${label} is outside the shared byte budget`);
    }
  }
}

/**
 * Consumes one immutable, semantic-sort-ordered mutation partition. Only the
 * current entity group is buffered; all corpus-wide replay state and output
 * ordering live in the caller's disk-backed transaction.
 */
export async function reduceBoundedCanonicalPartition(
  input: BoundedCanonicalPartitionInput,
): Promise<BoundedCanonicalPartitionSummary> {
  assertEnvelope(input);
  const sharedBudget = input.sharedBudget as ProcessWideBudgetCoordinator | undefined;
  if (sharedBudget === undefined) {
    throw new BoundedCanonicalBudgetError(
      'Canonical package calls require an explicit process-wide budget coordinator',
    );
  }
  try {
    sharedBudget.assertPolicy(input.budget);
  } catch (error) {
    throw new BoundedCanonicalBudgetError(
      error instanceof Error ? error.message : 'Canonical shared budget policy mismatch',
    );
  }
  const sampleRss = input.sampleRssBytes ?? (() => process.memoryUsage().rss);
  let inputRecords = 0;
  let replayRecords = 0;
  let entityRecords = 0;
  let linkRecords = 0;
  let artifactRecords = 0;
  let peakBufferedRecords = 0;
  let peakBufferedBytes = 0;
  let peakRssBytes = sampleRss();
  let firstSortKey: string | null = null;
  let lastSortKey: string | null = null;
  let previousSortKey: string | null = null;
  let activeGroup: string | null = null;
  let entityGroup: CanonicalMutation[] = [];
  let entityGroupBytes = 0;
  let entityGroupReleases: (() => void)[] = [];

  const acquire = (records: number, bytes: number): (() => void) => {
    try {
      return sharedBudget.acquire(records, bytes);
    } catch (error) {
      throw new BoundedCanonicalBudgetError(
        error instanceof Error ? error.message : 'Canonical shared budget was exceeded',
      );
    }
  };

  const sampleBudget = (): void => {
    peakBufferedRecords = Math.max(peakBufferedRecords, entityGroup.length);
    peakBufferedBytes = Math.max(peakBufferedBytes, entityGroupBytes);
    const processWide = sharedBudget.snapshot();
    peakBufferedRecords = Math.max(peakBufferedRecords, processWide.peakBufferedRecords);
    peakBufferedBytes = Math.max(peakBufferedBytes, processWide.peakBufferedBytes);
    peakRssBytes = Math.max(peakRssBytes, sampleRss());
    if (
      entityGroup.length > input.budget.maxBufferedRecords ||
      entityGroupBytes > input.budget.maxBufferedBytes ||
      peakRssBytes > input.budget.maxRssBytes
    ) {
      throw new BoundedCanonicalBudgetError(
        'Canonical entity group exceeded the shared process budget',
      );
    }
  };

  const releaseEntityGroup = (): void => {
    for (const release of entityGroupReleases.reverse()) release();
    entityGroup = [];
    entityGroupBytes = 0;
    entityGroupReleases = [];
  };

  const flushEntity = async (): Promise<void> => {
    if (entityGroup.length === 0) return;
    const releaseOutput = acquire(1, input.maximumAggregateBytes);
    try {
      const aggregate = reduceCanonicalEntityGroup(entityGroup);
      const aggregateBytes = Buffer.byteLength(canonicalJson(aggregate), 'utf8');
      if (aggregateBytes > input.maximumAggregateBytes) {
        throw new BoundedCanonicalBudgetError(
          'Canonical aggregate exceeded its preallocated serialization lease',
        );
      }
      sampleBudget();
      await input.transaction.writeEntity(aggregate);
      entityRecords += 1;
    } finally {
      releaseOutput();
      releaseEntityGroup();
    }
  };

  try {
    for await (const value of input.mutations) {
      const releaseMutation = acquire(1, input.maximumMutationBytes);
      let retainedMutationLease = false;
      try {
        const mutation = canonicalMutationSchema.parse(value);
        const mutationBytes = Buffer.byteLength(canonicalJson(mutation), 'utf8');
        if (mutationBytes > input.maximumMutationBytes) {
          throw new BoundedCanonicalBudgetError(
            'Canonical mutation exceeded its preallocated validation lease',
          );
        }
        inputRecords += 1;
        if (partitionForMutation(mutation, input.partitionCount) !== input.partitionId) {
          throw new BoundedCanonicalIntegrityError(
            `Mutation ${mutation.mutationId} is in the wrong semantic partition`,
          );
        }
        const sortKey = mutationSortKeyHex(mutation);
        if (previousSortKey !== null && previousSortKey > sortKey) {
          throw new BoundedCanonicalIntegrityError(
            'Canonical mutation partition is not semantically sorted',
          );
        }
        previousSortKey = sortKey;
        firstSortKey ??= sortKey;
        lastSortKey = sortKey;
        const group = semanticMutationGroupKey(mutation);
        if (activeGroup !== null && activeGroup !== group) await flushEntity();
        activeGroup = group;

        const contentSha256 = sha256(mutation);
        const claim = await input.transaction.claimMutation(mutation.mutationId, contentSha256);
        if (claim === 'replay') {
          replayRecords += 1;
          continue;
        }

        if (mutation.kind === 'entity_upsert' || mutation.kind === 'field_observation') {
          entityGroupReleases.push(releaseMutation);
          retainedMutationLease = true;
          entityGroup.push(mutation);
          entityGroupBytes += mutationBytes;
          sampleBudget();
        } else if (mutation.kind === 'link_candidate') {
          await flushEntity();
          await input.transaction.writeLink(mutation.link);
          linkRecords += 1;
        } else {
          await flushEntity();
          sampleBudget();
          await input.transaction.writeArtifact(mutation.artifact);
          artifactRecords += 1;
        }
      } finally {
        if (!retainedMutationLease) releaseMutation();
      }
      if (inputRecords % input.budget.rssSampleIntervalRecords === 0) sampleBudget();
    }
    await flushEntity();
    if (inputRecords !== input.artifact.recordCount) {
      throw new BoundedCanonicalIntegrityError(
        `Canonical artifact declared ${input.artifact.recordCount} records but yielded ${inputRecords}`,
      );
    }
    if (
      firstSortKey !== input.artifact.firstSortKey ||
      lastSortKey !== input.artifact.lastSortKey
    ) {
      throw new BoundedCanonicalIntegrityError(
        'Canonical artifact sort boundaries do not match its rows',
      );
    }
    sampleBudget();
    const summary = Object.freeze({
      stageVersion: BOUNDED_CANONICAL_STAGE_VERSION,
      generationId: input.generationId,
      partitionId: input.partitionId,
      inputRecords,
      replayRecords,
      entityRecords,
      linkRecords,
      artifactRecords,
      peakBufferedRecords,
      peakBufferedBytes,
      peakRssBytes,
      firstSortKey,
      lastSortKey,
    });
    await input.transaction.finalize(summary);
    return summary;
  } catch (error) {
    releaseEntityGroup();
    await input.transaction.abort(error);
    throw error;
  }
}
