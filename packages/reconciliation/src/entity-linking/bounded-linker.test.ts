import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { BoundedProcessingBudget } from '@oracle/contracts/bounded-processing';
import { ProcessWideBoundedBudget } from '@oracle/canonical-model/bounded-budget';
import { describe, expect, it } from 'vitest';

import { createReviewDecision, linkEntities } from './engine.js';
import {
  BOUNDED_LINK_INDEX_DDL,
  BOUNDED_SUBJECT_CLAIM_TRANSACTION,
  BOUNDED_SUBJECT_COMMIT_TRANSACTION,
} from './bounded-disk-plan.js';
import {
  BoundedReconciliationBudgetError,
  BoundedReconciliationIntegrityError,
  LINK_RELATIONS,
  reconcileBoundedRelation as reconcileBoundedRelationPackage,
} from './bounded-linker.js';
import type {
  BoundedCandidateStage,
  BoundedDuplicateMember,
  BoundedReconciliationInput,
  BoundedReconciliationRepository,
  BoundedReconciliationSummary,
  BoundedReconciliationSubjectClaim,
} from './bounded-linker.js';
import type { LinkRelation, LinkResolution, LinkableEntity, ReviewDecision } from './model.js';
import { policyFor } from './policies.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

const lineage = [
  {
    sourceId: 'sc:source:test-fixture',
    snapshotId: `sc:snapshot:test-fixture:${'1'.repeat(64)}`,
    artifactId: `sc:artifact:sha256:${'2'.repeat(64)}`,
    recordKey: 'safe-fixture',
    recordSha256: '3'.repeat(64),
  },
] as const;

function entity(
  entityId: string,
  entityKind: LinkableEntity['entityKind'],
  overrides: Partial<LinkableEntity> = {},
): LinkableEntity {
  return {
    entityId,
    entityKind,
    jurisdiction: 'Santa Clara County',
    identifiers: [],
    normalizedKeys: [],
    candidateAttributes: {},
    evidenceAvailability: 'complete',
    visibility: 'public',
    lineage,
    ...overrides,
  };
}

async function* stream<T>(values: readonly T[]): AsyncIterable<T> {
  await Promise.resolve();
  for (const value of values) yield value;
}

function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error('Expected a non-empty policy fixture');
  return value;
}

class Repository implements BoundedReconciliationRepository {
  public readonly generationId = `sc:generation:${'a'.repeat(64)}`;
  public readonly resolutions: LinkResolution[] = [];
  public readonly duplicateMembers: BoundedDuplicateMember[] = [];
  public readonly claims = new Map<
    string,
    { inputSha256: string; state: 'claimed' | 'completed'; resolutionSha256: string | null }
  >();
  public summary: BoundedReconciliationSummary | null = null;
  public aborted = false;

  public constructor(
    private readonly subjects: readonly LinkableEntity[],
    private readonly targets: readonly LinkableEntity[],
    private readonly reviews: readonly ReviewDecision[] = [],
    private readonly duplicateInput: readonly BoundedDuplicateMember[] = [],
  ) {}

  public streamSubjects(): AsyncIterable<LinkableEntity> {
    return stream(this.subjects);
  }

  public streamCandidateTargets(
    _relation: LinkRelation,
    subject: LinkableEntity,
    stage: BoundedCandidateStage,
  ): AsyncIterable<LinkableEntity> {
    const authoritative = this.targets.filter((target) =>
      subject.identifiers.some((left) =>
        target.identifiers.some(
          (right) =>
            left.scheme === right.scheme &&
            left.scope.toLowerCase() === right.scope.toLowerCase() &&
            left.value.toLowerCase() === right.value.toLowerCase(),
        ),
      ),
    );
    if (stage === 'authoritative_identifier') return stream(authoritative);
    const exact = this.targets.filter((target) =>
      subject.normalizedKeys.some((left) =>
        target.normalizedKeys.some(
          (right) =>
            left.kind === right.kind && left.value.toLowerCase() === right.value.toLowerCase(),
        ),
      ),
    );
    if (stage === 'normalized_exact') return stream(exact);
    return stream(this.targets);
  }

  public streamReviews(): AsyncIterable<ReviewDecision> {
    return stream(this.reviews);
  }

  public streamDuplicateMembers(): AsyncIterable<BoundedDuplicateMember> {
    return stream(this.duplicateInput);
  }

  public seedClaim(
    relation: LinkRelation,
    subjectId: string,
    hash: string,
    state: 'claimed' | 'completed',
  ): void {
    const key = `${relation}\0${subjectId}`;
    this.claims.set(key, { inputSha256: hash, state, resolutionSha256: null });
  }

  public beginSubject(
    relation: LinkRelation,
    subjectId: string,
    inputSha256: string,
  ): Promise<BoundedReconciliationSubjectClaim> {
    const key = `${relation}\0${subjectId}`;
    const old = this.claims.get(key);
    if (old !== undefined && old.inputSha256 !== inputSha256) throw new Error('claim collision');
    if (old?.state === 'completed') return Promise.resolve({ state: 'replay_completed' });
    const recovered = old?.state === 'claimed';
    this.claims.set(key, { inputSha256, state: 'claimed', resolutionSha256: null });
    return Promise.resolve({
      state: recovered ? ('recovered_incomplete_claim' as const) : ('claimed' as const),
      commit: (resolution) => {
        const resolutionSha256 = hash(resolution);
        const existing = this.claims.get(key);
        if (existing?.state === 'completed') {
          if (existing.resolutionSha256 !== resolutionSha256)
            throw new Error('resolution collision');
          return Promise.resolve('replay' as const);
        }
        this.resolutions.push(resolution);
        this.claims.set(key, { inputSha256, state: 'completed', resolutionSha256 });
        return Promise.resolve('committed' as const);
      },
      abort: () => Promise.resolve(),
    });
  }

  public writeDuplicateMember(
    _relation: LinkRelation,
    value: BoundedDuplicateMember,
  ): Promise<void> {
    this.duplicateMembers.push(value);
    return Promise.resolve();
  }

  public finalizeRelation(
    _relation: LinkRelation,
    summary: BoundedReconciliationSummary,
  ): Promise<void> {
    this.summary = summary;
    return Promise.resolve();
  }

  public abortRelation(): Promise<void> {
    this.aborted = true;
    return Promise.resolve();
  }
}

const budget: BoundedProcessingBudget = {
  policyVersion: 'bounded-process-budget-v1',
  maxBufferedRecords: 20,
  maxBufferedBytes: 100_000,
  maxRssBytes: 1_000_000,
  duckdbMemoryBytes: 1,
  runtimeReserveBytes: 1,
  maxOpenFiles: 10,
  maxWorkers: 1,
  maxRecordsPerOutputChunk: 20,
  maxBytesPerOutputChunk: 100_000,
  rssSampleIntervalRecords: 1,
};

const canonical = (value: unknown): string => JSON.stringify(value);
const hash = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex');

function reconcileBoundedRelation(
  input: Omit<BoundedReconciliationInput, 'sharedBudget' | 'maximumCanonicalBytesPerRecord'> &
    Partial<Pick<BoundedReconciliationInput, 'sharedBudget' | 'maximumCanonicalBytesPerRecord'>>,
) {
  return reconcileBoundedRelationPackage({
    ...input,
    maximumCanonicalBytesPerRecord: input.maximumCanonicalBytesPerRecord ?? 10_000,
    sharedBudget: input.sharedBudget ?? new ProcessWideBoundedBudget(input.budget),
  });
}

describe('bounded disk-index reconciliation', () => {
  it('preserves entity-linking-v1 semantics for cross-partition candidates', async () => {
    const subject = entity('permit-1', 'permit', {
      identifiers: [{ scheme: 'source-property-id', value: 'A-1', scope: 'county' }],
    });
    const target = entity('property-on-another-partition', 'property', {
      identifiers: [{ scheme: 'source-property-id', value: 'a-1', scope: 'COUNTY' }],
    });
    const repository = new Repository([subject], [target]);
    const result = await reconcileBoundedRelation({
      generationId: repository.generationId,
      relation: 'permit_property',
      budget,
      repository,
      canonicalSha256: hash,
      canonicalByteLength: (value) => Buffer.byteLength(canonical(value)),
      sampleRssBytes: () => 1,
    });
    expect(repository.resolutions).toEqual(
      linkEntities('permit_property', [subject], [target]).resolutions,
    );
    expect(result).toMatchObject({ subjects: 1, resolutions: 1, replaySubjects: 0 });
  });

  it('adopts a durable subject replay without rewriting the resolution', async () => {
    const subject = entity('permit-1', 'permit');
    const repository = new Repository([subject], []);
    repository.seedClaim('permit_property', subject.entityId, hash(subject), 'completed');
    const result = await reconcileBoundedRelation({
      generationId: repository.generationId,
      relation: 'permit_property',
      budget,
      repository,
      canonicalSha256: hash,
      canonicalByteLength: (value) => Buffer.byteLength(canonical(value)),
      sampleRssBytes: () => 1,
    });
    expect(result.replaySubjects).toBe(1);
    expect(repository.resolutions).toHaveLength(0);
  });

  it('recovers an incomplete durable claim and commits the resolution atomically', async () => {
    const subject = entity('permit-1', 'permit');
    const repository = new Repository([subject], []);
    repository.seedClaim('permit_property', subject.entityId, hash(subject), 'claimed');
    const result = await reconcileBoundedRelation({
      generationId: repository.generationId,
      relation: 'permit_property',
      budget,
      repository,
      canonicalSha256: hash,
      canonicalByteLength: (value) => Buffer.byteLength(canonical(value)),
      sampleRssBytes: () => 1,
    });
    expect(result).toMatchObject({ resolutions: 1, replaySubjects: 0 });
    expect(repository.resolutions).toEqual(
      linkEntities('permit_property', [subject], []).resolutions,
    );
    expect(repository.claims.get(`permit_property\0${subject.entityId}`)?.state).toBe('completed');
  });

  it('matches authoritative ambiguity semantics for every frozen relation', async () => {
    for (const relation of [
      'property_address',
      'property_unit',
      'permit_property',
      'permit_contractor',
      'contractor_business',
      'business_address',
      'ownership_property',
      'ownership_party',
      'transfer_property',
    ] as const) {
      const policy = policyFor(relation);
      const scheme = first(policy.authoritativeSchemes);
      const identifier = { scheme, value: `${relation}-shared`, scope: 'county' };
      const subject = entity(`${relation}-subject`, first(policy.subjectKinds), {
        identifiers: [identifier],
      });
      const targets = ['a', 'b'].map((suffix) =>
        entity(`${relation}-target-${suffix}`, first(policy.targetKinds), {
          identifiers: [identifier],
          visibility: suffix === 'b' ? 'restricted' : 'public',
        }),
      );
      const repository = new Repository([subject], targets);
      await reconcileBoundedRelation({
        generationId: repository.generationId,
        relation,
        budget,
        repository,
        canonicalSha256: hash,
        canonicalByteLength: (value) => Buffer.byteLength(canonical(value)),
        sampleRssBytes: () => 1,
      });
      expect(repository.resolutions, relation).toEqual(
        linkEntities(relation, [subject], targets).resolutions,
      );
      expect(repository.resolutions[0]?.state, relation).toBe('ambiguous');
      expect(repository.resolutions[0]?.visibility, relation).toBe('restricted');
      expect(
        repository.resolutions[0]?.proposals.every(
          (proposal) => proposal.evidenceLineage.length > 0,
        ),
        relation,
      ).toBe(true);
    }
  });

  it('preserves candidate review decisions, visibility, and lineage exactly', async () => {
    const subject = entity('permit-candidate', 'permit', {
      candidateAttributes: { address: '500 University Avenue', postalCode: '94301' },
    });
    const target = entity('property-candidate', 'property', {
      candidateAttributes: { address: '500 University Avenue', postalCode: '94301' },
    });
    const proposal = linkEntities('permit_property', [subject], [target]).resolutions[0]
      ?.proposals[0];
    if (proposal === undefined) throw new Error('Expected candidate proposal');
    const review = createReviewDecision({
      proposalId: proposal.proposalId,
      outcome: 'accepted',
      reviewerRef: 'bounded-review-fixture',
      decidedAt: '2026-07-17T12:00:00.000Z',
      rationale: 'Bounded fixture confirms the candidate.',
      supersedesDecisionId: null,
      evidenceLineage: lineage,
      visibility: 'authenticated',
    });
    const repository = new Repository([subject], [target], [review]);
    await reconcileBoundedRelation({
      generationId: repository.generationId,
      relation: 'permit_property',
      budget,
      repository,
      canonicalSha256: hash,
      canonicalByteLength: (value) => Buffer.byteLength(canonical(value)),
      sampleRssBytes: () => 1,
    });
    expect(repository.resolutions).toEqual(
      linkEntities('permit_property', [subject], [target], [review]).resolutions,
    );
    expect(repository.resolutions[0]).toMatchObject({
      state: 'review_accepted',
      visibility: 'authenticated',
      acceptedTargetEntityId: target.entityId,
    });
    expect(repository.resolutions[0]?.reviewDecisions).toEqual([review]);
  });

  it('streams duplicate membership with the DDL grain required by engine parity', async () => {
    const subject = entity('permit-1', 'permit');
    const duplicateInput: readonly BoundedDuplicateMember[] = [
      {
        classification: 'shared_authoritative_identifier',
        key: 'county\0A-1',
        entityId: 'property-1',
        ordinal: 0,
      },
      {
        classification: 'shared_authoritative_identifier',
        key: 'county\0A-1',
        entityId: 'property-2',
        ordinal: 1,
      },
    ];
    const repository = new Repository([subject], [], [], duplicateInput);
    const result = await reconcileBoundedRelation({
      generationId: repository.generationId,
      relation: 'permit_property',
      budget,
      repository,
      canonicalSha256: hash,
      canonicalByteLength: (value) => Buffer.byteLength(canonical(value)),
      sampleRssBytes: () => 1,
    });
    expect(repository.duplicateMembers).toEqual(duplicateInput);
    expect(result.duplicateGroups).toBe(1);
    expect(BOUNDED_LINK_INDEX_DDL.join('\n')).toContain('bounded_duplicate_member');
    expect(BOUNDED_SUBJECT_CLAIM_TRANSACTION).toEqual([
      'BEGIN TRANSACTION',
      expect.stringContaining("'claimed'"),
      expect.stringContaining('SELECT input_sha256'),
      'COMMIT',
    ]);
    expect(BOUNDED_SUBJECT_COMMIT_TRANSACTION).toEqual([
      'BEGIN TRANSACTION',
      expect.stringContaining('bounded_link_resolution'),
      expect.stringContaining("claim_state = 'completed'"),
      expect.stringContaining('row-effect assertion failed'),
      'COMMIT',
    ]);
  });

  it('fails closed before collecting an oversized candidate pool', async () => {
    const subject = entity('permit-1', 'permit');
    const targets = [entity('property-1', 'property'), entity('property-2', 'property')];
    const repository = new Repository([subject], targets);
    const constrainedBudget = { ...budget, maxBufferedRecords: 2, maxRecordsPerOutputChunk: 2 };
    const sharedBudget = new ProcessWideBoundedBudget(constrainedBudget);
    await expect(
      reconcileBoundedRelation({
        generationId: repository.generationId,
        relation: 'permit_property',
        budget: constrainedBudget,
        repository,
        canonicalSha256: hash,
        canonicalByteLength: (value) => Buffer.byteLength(canonical(value)),
        sharedBudget,
        sampleRssBytes: () => 1,
      }),
    ).rejects.toBeInstanceOf(BoundedReconciliationBudgetError);
    expect(repository.aborted).toBe(true);
    expect(sharedBudget.snapshot()).toMatchObject({ bufferedRecords: 0, bufferedBytes: 0 });
  });

  it('shares the aggregate lease across concurrent relation workers', async () => {
    const subject = entity('permit-1', 'permit', {
      identifiers: [{ scheme: 'source-property-id', value: 'A-1', scope: 'county' }],
    });
    const target = entity('property-1', 'property', {
      identifiers: [{ scheme: 'source-property-id', value: 'a-1', scope: 'COUNTY' }],
    });
    let entered: () => void = () => undefined;
    let unblock: () => void = () => undefined;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const unblockPromise = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    class BlockingRepository extends Repository {
      public override async beginSubject(
        relation: LinkRelation,
        subjectId: string,
        inputSha256: string,
      ): Promise<BoundedReconciliationSubjectClaim> {
        const claim = await super.beginSubject(relation, subjectId, inputSha256);
        if (claim.state === 'replay_completed') return claim;
        return {
          ...claim,
          commit: async (resolution) => {
            entered();
            await unblockPromise;
            return claim.commit(resolution);
          },
        };
      }
    }
    const concurrentBudget = {
      ...budget,
      maxBufferedRecords: 3,
      maxRecordsPerOutputChunk: 3,
    };
    const sharedBudget = new ProcessWideBoundedBudget(concurrentBudget);
    const first = new BlockingRepository([subject], [target]);
    const firstRun = reconcileBoundedRelation({
      generationId: first.generationId,
      relation: 'permit_property',
      budget: concurrentBudget,
      repository: first,
      canonicalSha256: hash,
      canonicalByteLength: (value) => Buffer.byteLength(canonical(value)),
      sharedBudget,
      sampleRssBytes: () => 1,
    });
    await enteredPromise;
    const second = new Repository([subject], [target]);
    await expect(
      reconcileBoundedRelation({
        generationId: second.generationId,
        relation: 'permit_property',
        budget: concurrentBudget,
        repository: second,
        canonicalSha256: hash,
        canonicalByteLength: (value) => Buffer.byteLength(canonical(value)),
        sharedBudget,
        sampleRssBytes: () => 1,
      }),
    ).rejects.toBeInstanceOf(BoundedReconciliationBudgetError);
    unblock();
    await firstRun;
    expect(second.aborted).toBe(true);
    expect(sharedBudget.snapshot()).toMatchObject({
      bufferedRecords: 0,
      bufferedBytes: 0,
      peakBufferedRecords: 3,
    });
  });

  it('matches frozen-engine exact, candidate, overflow, blocked, unmatched, review, visibility, lineage, and duplicate semantics', async () => {
    const parityBudget = {
      ...budget,
      maxBufferedRecords: 64,
      maxRecordsPerOutputChunk: 64,
      maxBufferedBytes: 1_000_000,
      maxBytesPerOutputChunk: 1_000_000,
      maxRssBytes: 2_000_002,
    };
    const candidateAttributes = {
      address: '500 University Avenue',
      unit: '1',
      postalCode: '94301',
      name: 'Acme Holdings',
    };
    for (const relation of LINK_RELATIONS) {
      const policy = policyFor(relation);
      const run = async (
        suffix: string,
        subject: LinkableEntity,
        targets: readonly LinkableEntity[],
        reviews: readonly ReviewDecision[] = [],
        duplicates: readonly BoundedDuplicateMember[] = [],
      ) => {
        const repository = new Repository([subject], targets, reviews, duplicates);
        await reconcileBoundedRelation({
          generationId: repository.generationId,
          relation,
          budget: parityBudget,
          repository,
          canonicalSha256: hash,
          canonicalByteLength: (value) => Buffer.byteLength(canonical(value)),
          sampleRssBytes: () => 1,
        });
        expect(repository.resolutions, `${relation}:${suffix}`).toEqual(
          linkEntities(relation, [subject], targets, reviews).resolutions,
        );
        expect(repository.duplicateMembers, `${relation}:${suffix}:duplicates`).toEqual(duplicates);
        return repository;
      };

      const exactKind = policy.normalizedKeyKinds[0];
      if (exactKind !== undefined) {
        const normalized = { kind: exactKind, value: `${relation}-normalized` };
        await run(
          'normalized-exact',
          entity(`${relation}-exact-subject`, first(policy.subjectKinds), {
            normalizedKeys: [normalized],
          }),
          [
            entity(`${relation}-exact-target`, first(policy.targetKinds), {
              normalizedKeys: [normalized],
            }),
          ],
        );
      }

      const candidateSubject = entity(`${relation}-candidate-subject`, first(policy.subjectKinds), {
        candidateAttributes,
      });
      const candidateTarget = entity(`${relation}-candidate-target`, first(policy.targetKinds), {
        candidateAttributes,
        visibility: 'restricted',
      });
      const proposal = linkEntities(relation, [candidateSubject], [candidateTarget]).resolutions[0]
        ?.proposals[0];
      if (proposal === undefined) throw new Error(`Expected ${relation} candidate proposal`);
      const review = createReviewDecision({
        proposalId: proposal.proposalId,
        outcome: 'accepted',
        reviewerRef: `bounded-${relation}-review`,
        decidedAt: '2026-07-17T12:00:00.000Z',
        rationale: `Frozen ${relation} parity fixture.`,
        supersedesDecisionId: null,
        evidenceLineage: lineage,
        visibility: 'authenticated',
      });
      const duplicateInput: readonly BoundedDuplicateMember[] = [
        {
          classification: 'shared_authoritative_identifier',
          key: `${relation}\0shared`,
          entityId: `${relation}-duplicate-a`,
          ordinal: 0,
        },
        {
          classification: 'shared_authoritative_identifier',
          key: `${relation}\0shared`,
          entityId: `${relation}-duplicate-b`,
          ordinal: 1,
        },
      ];
      const reviewed = await run(
        'candidate-review',
        candidateSubject,
        [candidateTarget],
        [review],
        duplicateInput,
      );
      expect(reviewed.resolutions[0], relation).toMatchObject({
        state: 'review_accepted',
        visibility: 'restricted',
      });
      expect(
        reviewed.resolutions[0]?.proposals[0]?.evidenceLineage.length,
        relation,
      ).toBeGreaterThan(0);

      const overflowTargets = Array.from({ length: policy.maxCandidatePool + 1 }, (_, index) =>
        entity(
          `${relation}-overflow-${index.toString().padStart(3, '0')}`,
          first(policy.targetKinds),
          { candidateAttributes },
        ),
      );
      const overflow = await run(
        'overflow',
        entity(`${relation}-overflow-subject`, first(policy.subjectKinds), {
          candidateAttributes,
        }),
        overflowTargets,
      );
      expect(overflow.resolutions[0], relation).toMatchObject({
        state: 'unresolved',
        proposals: [],
      });

      await run(
        'blocked',
        entity(`${relation}-blocked-subject`, first(policy.subjectKinds), {
          evidenceAvailability: 'blocked',
          candidateAttributes,
        }),
        [candidateTarget],
      );
      await run(
        'unmatched',
        entity(`${relation}-unmatched-subject`, first(policy.subjectKinds)),
        [],
      );
    }
  }, 120_000);

  it('requires a shared coordinator at one worker and performs canonical work only under leases', async () => {
    const subject = entity('permit-lease', 'permit');
    const repository = new Repository([subject], []);
    await expect(
      reconcileBoundedRelationPackage({
        generationId: repository.generationId,
        relation: 'permit_property',
        budget,
        repository,
        maximumCanonicalBytesPerRecord: 10_000,
        canonicalSha256: hash,
        canonicalByteLength: (value: unknown) => Buffer.byteLength(canonical(value)),
        sampleRssBytes: () => 1,
      } as unknown as BoundedReconciliationInput),
    ).rejects.toBeInstanceOf(BoundedReconciliationBudgetError);

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
    await reconcileBoundedRelationPackage({
      generationId: repository.generationId,
      relation: 'permit_property',
      budget,
      repository: new Repository([entity('permit-lease-2', 'permit')], []),
      maximumCanonicalBytesPerRecord: 10_000,
      canonicalSha256: (value) => {
        expect(activeLeases).toBeGreaterThan(0);
        return hash(value);
      },
      canonicalByteLength: (value) => {
        expect(activeLeases).toBeGreaterThan(0);
        return Buffer.byteLength(canonical(value));
      },
      sharedBudget,
      sampleRssBytes: () => 1,
    });
    expect(activeLeases).toBe(0);

    const hostile = entity('permit-hostile', 'permit', {
      identifiers: Array.from({ length: 257 }, (_, index) => ({
        scheme: 'source-property-id',
        value: String(index),
        scope: 'county',
      })),
    });
    await expect(
      reconcileBoundedRelation({
        generationId: repository.generationId,
        relation: 'permit_property',
        budget,
        repository: new Repository([hostile], []),
        canonicalSha256: hash,
        canonicalByteLength: () => {
          throw new Error('hostile array reached canonicalization');
        },
        sampleRssBytes: () => 1,
      }),
    ).rejects.toBeInstanceOf(BoundedReconciliationIntegrityError);
  });

  it('executes row-effect assertions in a real DuckDB transaction', async () => {
    interface TestReader {
      getRowObjectsJS(): Record<string, unknown>[];
    }
    interface TestConnection {
      run(sql: string, values?: unknown[]): Promise<unknown>;
      runAndReadAll(sql: string, values?: unknown[]): Promise<TestReader>;
      closeSync(): void;
    }
    interface TestInstance {
      connect(): Promise<TestConnection>;
      closeSync(): void;
    }
    const modulePath = pathToFileURL(
      resolve(
        import.meta.dirname,
        '../../../data-runtime/node_modules/@duckdb/node-api/lib/index.js',
      ),
    ).href;
    const duckdb = (await import(modulePath)) as unknown as {
      DuckDBInstance: { create(path: string): Promise<TestInstance> };
    };
    const instance = await duckdb.DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    const generation = `sc:generation:${'f'.repeat(64)}`;
    const relation = 'permit_property';
    const executeClaim = async (subject: string, inputSha256: string) => {
      await connection.run(BOUNDED_SUBJECT_CLAIM_TRANSACTION[0]);
      await connection.run(BOUNDED_SUBJECT_CLAIM_TRANSACTION[1], [
        generation,
        relation,
        subject,
        inputSha256,
      ]);
      await connection.run(BOUNDED_SUBJECT_CLAIM_TRANSACTION[2], [generation, relation, subject]);
      await connection.run(BOUNDED_SUBJECT_CLAIM_TRANSACTION[3]);
    };
    const executeCommit = async (
      subject: string,
      inputSha256: string,
      resolutionSha256: string,
    ) => {
      await connection.run(BOUNDED_SUBJECT_COMMIT_TRANSACTION[0]);
      await connection.run(BOUNDED_SUBJECT_COMMIT_TRANSACTION[1], [
        generation,
        relation,
        subject,
        '{}',
        resolutionSha256,
      ]);
      await connection.run(BOUNDED_SUBJECT_COMMIT_TRANSACTION[2], [
        resolutionSha256,
        generation,
        relation,
        subject,
        inputSha256,
      ]);
      await connection.run(BOUNDED_SUBJECT_COMMIT_TRANSACTION[3], [
        generation,
        relation,
        subject,
        resolutionSha256,
        generation,
        relation,
        subject,
        inputSha256,
        resolutionSha256,
      ]);
      await connection.run(BOUNDED_SUBJECT_COMMIT_TRANSACTION[4]);
    };
    try {
      for (const statement of BOUNDED_LINK_INDEX_DDL) await connection.run(statement);
      await executeClaim('subject-ok', HASH_A);
      await executeCommit('subject-ok', HASH_A, HASH_B);
      const completed = (
        await connection.runAndReadAll(
          `SELECT claim_state, resolution_sha256
           FROM bounded_reconciliation_subject_claim
           WHERE subject_entity_id = 'subject-ok'`,
        )
      ).getRowObjectsJS();
      expect(completed).toEqual([{ claim_state: 'completed', resolution_sha256: HASH_B }]);

      await executeClaim('subject-conflict', HASH_A);
      await expect(executeCommit('subject-conflict', HASH_C, HASH_D)).rejects.toThrow(
        /row-effect assertion failed/iu,
      );
      await connection.run('ROLLBACK');
      const conflict = (
        await connection.runAndReadAll(
          `SELECT claim_state, resolution_sha256
           FROM bounded_reconciliation_subject_claim
           WHERE subject_entity_id = 'subject-conflict'`,
        )
      ).getRowObjectsJS();
      expect(conflict).toEqual([{ claim_state: 'claimed', resolution_sha256: null }]);
      const leakedResolution = (
        await connection.runAndReadAll(
          `SELECT count(*) AS count
           FROM bounded_link_resolution
           WHERE subject_entity_id = 'subject-conflict'`,
        )
      ).getRowObjectsJS();
      expect(Number(leakedResolution[0]?.count)).toBe(0);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  }, 120_000);

  it('contains no county-wide result collection escape hatches', async () => {
    const source = await readFile(new URL('./bounded-linker.ts', import.meta.url), 'utf8');
    for (const forbidden of ['readAll(', 'runAndReadAll(', 'getRowObjects(', 'readFile(']) {
      expect(source).not.toContain(forbidden);
    }
  });
});
