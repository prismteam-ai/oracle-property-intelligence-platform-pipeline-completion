import { readFile } from 'node:fs/promises';

import { mutationSortKeyHex } from '@oracle/contracts/bounded-processing';
import type {
  BoundedProcessingBudget,
  ImmutableBoundedArtifact,
} from '@oracle/contracts/bounded-processing';
import type {
  CanonicalArtifactReference,
  EntityLinkCandidate,
} from '@oracle/contracts/canonical/mutation';
import { describe, expect, it } from 'vitest';

import { ProcessWideBoundedBudget } from '../bounded-budget.js';
import { canonicalJson } from '../normalizers/core.js';
import { normalizePropertyRecord } from '../normalizers/property.js';
import { testContext } from '../normalizers/test-context.test-support.js';
import { BoundedCanonicalBudgetError, reduceBoundedCanonicalPartition } from './bounded-reducer.js';
import type {
  BoundedCanonicalPartitionSummary,
  BoundedCanonicalPartitionTransaction,
} from './bounded-reducer.js';
import { reduceCanonicalMutations } from './reducer.js';
import type { CanonicalEntityAggregate } from './reducer.js';

const budget: BoundedProcessingBudget = {
  policyVersion: 'bounded-process-budget-v1',
  maxBufferedRecords: 100,
  maxBufferedBytes: 1_000_000,
  maxRssBytes: 10_000_000,
  duckdbMemoryBytes: 1,
  runtimeReserveBytes: 1,
  maxOpenFiles: 10,
  maxWorkers: 1,
  maxRecordsPerOutputChunk: 100,
  maxBytesPerOutputChunk: 1_000_000,
  rssSampleIntervalRecords: 1,
};

class Transaction implements BoundedCanonicalPartitionTransaction {
  public readonly generationId = `sc:generation:${'a'.repeat(64)}`;
  public readonly partitionId = 0;
  public readonly identities = new Map<string, string>();
  public readonly entities: CanonicalEntityAggregate[] = [];
  public readonly links: EntityLinkCandidate[] = [];
  public readonly artifacts: CanonicalArtifactReference[] = [];
  public summary: BoundedCanonicalPartitionSummary | null = null;
  public aborted = false;

  public claimMutation(id: string, hash: string): Promise<'claimed' | 'replay'> {
    const old = this.identities.get(id);
    if (old === hash) return Promise.resolve('replay');
    if (old !== undefined) throw new Error('identity collision');
    this.identities.set(id, hash);
    return Promise.resolve('claimed');
  }

  public writeEntity(value: CanonicalEntityAggregate): Promise<void> {
    this.entities.push(value);
    return Promise.resolve();
  }

  public writeLink(value: EntityLinkCandidate): Promise<void> {
    this.links.push(value);
    return Promise.resolve();
  }

  public writeArtifact(value: CanonicalArtifactReference): Promise<void> {
    this.artifacts.push(value);
    return Promise.resolve();
  }

  public finalize(summary: BoundedCanonicalPartitionSummary): Promise<void> {
    this.summary = summary;
    return Promise.resolve();
  }

  public abort(): Promise<void> {
    this.aborted = true;
    return Promise.resolve();
  }
}

function fixture() {
  return [
    ...normalizePropertyRecord(
      {
        apn: '123-45-678',
        jurisdiction: 'Palo Alto',
        address: null,
        unit: null,
        parcelGeometry: null,
        landAreaSquareMeters: null,
      },
      testContext(),
    ),
  ].sort((left, right) => mutationSortKeyHex(left).localeCompare(mutationSortKeyHex(right)));
}

function artifact(mutations: ReturnType<typeof fixture>): ImmutableBoundedArtifact {
  return {
    generationId: `sc:generation:${'a'.repeat(64)}`,
    stage: 'partition_mutations',
    dataset: 'canonical-mutations',
    partitionId: 0,
    sequence: 0,
    logicalKey: 'partition-0',
    uri: 'file:///partition-0.ndjson',
    mediaType: 'application/x-ndjson',
    byteSize: 1,
    sha256: 'b'.repeat(64),
    recordCount: mutations.length,
    firstSortKey: mutationSortKeyHex(mutations[0]),
    lastSortKey: mutationSortKeyHex(mutations.at(-1)),
    schemaSha256: 'c'.repeat(64),
    sourceLineageSha256: 'd'.repeat(64),
    licenseIdentitySha256: 'e'.repeat(64),
    visibility: 'public',
  };
}

async function* rows(values: readonly unknown[]): AsyncIterable<unknown> {
  await Promise.resolve();
  for (const value of values) yield value;
}

describe('bounded canonical reduction', () => {
  it('matches the legacy golden semantics while buffering one entity group', async () => {
    const mutations = fixture();
    const transaction = new Transaction();
    const summary = await reduceBoundedCanonicalPartition({
      generationId: transaction.generationId,
      partitionId: 0,
      partitionCount: 1,
      artifact: artifact(mutations),
      budget,
      maximumMutationBytes: 16_384,
      maximumAggregateBytes: 262_144,
      mutations: rows(mutations),
      transaction,
      sharedBudget: new ProcessWideBoundedBudget(budget),
      sampleRssBytes: () => 1,
    });
    expect(canonicalJson(transaction.entities)).toBe(
      canonicalJson(reduceCanonicalMutations(mutations).entities),
    );
    expect(summary).toMatchObject({
      inputRecords: mutations.length,
      entityRecords: 1,
      peakBufferedRecords: mutations.length + 1,
    });
    expect(transaction.aborted).toBe(false);
  });

  it('adopts exact durable replay without rewriting outputs', async () => {
    const mutations = fixture();
    const transaction = new Transaction();
    for (const mutation of mutations) {
      await transaction.claimMutation(
        mutation.mutationId,
        (await import('../normalizers/core.js')).sha256(mutation),
      );
    }
    const summary = await reduceBoundedCanonicalPartition({
      generationId: transaction.generationId,
      partitionId: 0,
      partitionCount: 1,
      artifact: artifact(mutations),
      budget,
      maximumMutationBytes: 16_384,
      maximumAggregateBytes: 262_144,
      mutations: rows(mutations),
      transaction,
      sharedBudget: new ProcessWideBoundedBudget(budget),
      sampleRssBytes: () => 1,
    });
    expect(summary.replayRecords).toBe(mutations.length);
    expect(transaction.entities).toHaveLength(0);
  });

  it('fails closed when one entity group breaches the shared budget', async () => {
    const mutations = fixture();
    const transaction = new Transaction();
    const constrainedBudget = { ...budget, maxBufferedRecords: 1, maxRecordsPerOutputChunk: 1 };
    const sharedBudget = new ProcessWideBoundedBudget(constrainedBudget);
    await expect(
      reduceBoundedCanonicalPartition({
        generationId: transaction.generationId,
        partitionId: 0,
        partitionCount: 1,
        artifact: artifact(mutations),
        budget: constrainedBudget,
        maximumMutationBytes: 16_384,
        maximumAggregateBytes: 262_144,
        mutations: rows(mutations),
        transaction,
        sharedBudget,
        sampleRssBytes: () => 1,
      }),
    ).rejects.toBeInstanceOf(BoundedCanonicalBudgetError);
    expect(transaction.aborted).toBe(true);
    expect(sharedBudget.snapshot()).toMatchObject({ bufferedRecords: 0, bufferedBytes: 0 });
  });

  it('enforces one aggregate lease across two concurrent partition workers', async () => {
    const mutations = fixture();
    let entered: () => void = () => undefined;
    let unblock: () => void = () => undefined;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const unblockPromise = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    class BlockingTransaction extends Transaction {
      public override async writeEntity(value: CanonicalEntityAggregate): Promise<void> {
        entered();
        await unblockPromise;
        await super.writeEntity(value);
      }
    }
    const concurrentBudget = {
      ...budget,
      maxBufferedRecords: mutations.length + 1,
      maxRecordsPerOutputChunk: mutations.length + 1,
    };
    const sharedBudget = new ProcessWideBoundedBudget(concurrentBudget);
    const first = new BlockingTransaction();
    const firstRun = reduceBoundedCanonicalPartition({
      generationId: first.generationId,
      partitionId: 0,
      partitionCount: 1,
      artifact: artifact(mutations),
      budget: concurrentBudget,
      maximumMutationBytes: 16_384,
      maximumAggregateBytes: 262_144,
      mutations: rows(mutations),
      transaction: first,
      sharedBudget,
      sampleRssBytes: () => 1,
    });
    await enteredPromise;
    const second = new Transaction();
    await expect(
      reduceBoundedCanonicalPartition({
        generationId: second.generationId,
        partitionId: 0,
        partitionCount: 1,
        artifact: artifact(mutations),
        budget: concurrentBudget,
        maximumMutationBytes: 16_384,
        maximumAggregateBytes: 262_144,
        mutations: rows(mutations),
        transaction: second,
        sharedBudget,
        sampleRssBytes: () => 1,
      }),
    ).rejects.toBeInstanceOf(BoundedCanonicalBudgetError);
    unblock();
    await firstRun;
    expect(second.aborted).toBe(true);
    expect(sharedBudget.snapshot()).toMatchObject({
      bufferedRecords: 0,
      bufferedBytes: 0,
      peakBufferedRecords: mutations.length + 1,
    });
  });

  it('requires an explicit shared coordinator even for one worker', async () => {
    const mutations = fixture();
    const transaction = new Transaction();
    await expect(
      reduceBoundedCanonicalPartition({
        generationId: transaction.generationId,
        partitionId: 0,
        partitionCount: 1,
        artifact: artifact(mutations),
        budget,
        maximumMutationBytes: 16_384,
        maximumAggregateBytes: 262_144,
        mutations: rows(mutations),
        transaction,
        sampleRssBytes: () => 1,
      } as unknown as Parameters<typeof reduceBoundedCanonicalPartition>[0]),
    ).rejects.toBeInstanceOf(BoundedCanonicalBudgetError);
  });

  it('keeps mutation hashing, reduction, aggregate serialization, and writes under leases', async () => {
    const mutations = fixture();
    const delegate = new ProcessWideBoundedBudget(budget);
    let activeLeases = 0;
    const sharedBudget = {
      assertPolicy: (policy: BoundedProcessingBudget) => delegate.assertPolicy(policy),
      snapshot: () => delegate.snapshot(),
      acquire: (records: number, bytes: number) => {
        const release = delegate.acquire(records, bytes);
        activeLeases += 1;
        return () => {
          activeLeases -= 1;
          release();
        };
      },
    };
    class LeaseAssertingTransaction extends Transaction {
      public override claimMutation(id: string, mutationHash: string) {
        expect(activeLeases).toBeGreaterThan(0);
        return super.claimMutation(id, mutationHash);
      }

      public override writeEntity(value: CanonicalEntityAggregate) {
        expect(activeLeases).toBeGreaterThan(0);
        return super.writeEntity(value);
      }
    }
    const transaction = new LeaseAssertingTransaction();
    await reduceBoundedCanonicalPartition({
      generationId: transaction.generationId,
      partitionId: 0,
      partitionCount: 1,
      artifact: artifact(mutations),
      budget,
      maximumMutationBytes: 16_384,
      maximumAggregateBytes: 262_144,
      mutations: rows(mutations),
      transaction,
      sharedBudget,
      sampleRssBytes: () => 1,
    });
    expect(activeLeases).toBe(0);
    expect(sharedBudget.snapshot()).toMatchObject({ bufferedRecords: 0, bufferedBytes: 0 });
  });

  it('rejects mutation identity collisions and corrupt artifact counts', async () => {
    const mutations = fixture();
    const collision = new Transaction();
    const first = mutations[0];
    if (first === undefined) throw new Error('Expected canonical fixture mutations');
    collision.identities.set(first.mutationId, 'f'.repeat(64));
    await expect(
      reduceBoundedCanonicalPartition({
        generationId: collision.generationId,
        partitionId: 0,
        partitionCount: 1,
        artifact: artifact(mutations),
        budget,
        maximumMutationBytes: 16_384,
        maximumAggregateBytes: 262_144,
        mutations: rows(mutations),
        transaction: collision,
        sharedBudget: new ProcessWideBoundedBudget(budget),
        sampleRssBytes: () => 1,
      }),
    ).rejects.toThrow('identity collision');
    expect(collision.aborted).toBe(true);

    const corrupt = new Transaction();
    await expect(
      reduceBoundedCanonicalPartition({
        generationId: corrupt.generationId,
        partitionId: 0,
        partitionCount: 1,
        artifact: { ...artifact(mutations), recordCount: mutations.length + 1 },
        budget,
        maximumMutationBytes: 16_384,
        maximumAggregateBytes: 262_144,
        mutations: rows(mutations),
        transaction: corrupt,
        sharedBudget: new ProcessWideBoundedBudget(budget),
        sampleRssBytes: () => 1,
      }),
    ).rejects.toThrow('declared');
    expect(corrupt.aborted).toBe(true);
  });

  it('contains no whole-corpus collection escape hatches in the production engine', async () => {
    const source = await readFile(new URL('./bounded-reducer.ts', import.meta.url), 'utf8');
    for (const forbidden of ['readAll(', 'runAndReadAll(', 'getRowObjects(', 'readFile(']) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('rejects hostile legacy caller arrays before iteration or sorting', () => {
    const hostile = new Proxy(new Array(65_537), {
      get(target, property, receiver) {
        if (property === Symbol.iterator) throw new Error('caller corpus was iterated');
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    expect(() => reduceCanonicalMutations(hostile as never)).toThrow(RangeError);
  });
});
