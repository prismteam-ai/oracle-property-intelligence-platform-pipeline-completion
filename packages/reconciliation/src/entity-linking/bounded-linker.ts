import type { BoundedProcessingBudget } from '@oracle/contracts/bounded-processing';
import type { ProcessWideBudgetCoordinator } from '@oracle/canonical-model/bounded-budget';

import { linkEntities } from './engine.js';
import type {
  DuplicateClassification,
  LinkRelation,
  LinkResolution,
  LinkableEntity,
  ReviewDecision,
} from './model.js';
import { policyFor } from './policies.js';

export const BOUNDED_RECONCILIATION_STAGE_VERSION = 'bounded-reconciliation-v1' as const;

export const LINK_RELATIONS = Object.freeze([
  'property_address',
  'property_unit',
  'permit_property',
  'permit_contractor',
  'contractor_business',
  'business_address',
  'ownership_property',
  'ownership_party',
  'transfer_property',
] as const satisfies readonly LinkRelation[]);

export type BoundedCandidateStage =
  'authoritative_identifier' | 'normalized_exact' | 'bounded_candidate';

export type BoundedDuplicateMember = Readonly<{
  classification: DuplicateClassification;
  key: string;
  entityId: string;
  ordinal: number;
}>;

export interface BoundedReconciliationSubjectTransaction {
  readonly state: 'claimed' | 'recovered_incomplete_claim';
  /** Atomically persists the resolution and marks the exact input claim complete. */
  commit(resolution: LinkResolution): Promise<'committed' | 'replay'>;
  /** Releases the transaction lock while retaining a recoverable incomplete claim. */
  abort(reason: unknown): Promise<void>;
}

export type BoundedReconciliationSubjectClaim =
  Readonly<{ state: 'replay_completed' }> | BoundedReconciliationSubjectTransaction;

/**
 * Production implementations use three indexed disk queries in policy order.
 * Authoritative and exact scans yield their complete match set. The candidate
 * scan applies the frozen postal/address-number coarse filters and yields at
 * most `maxCandidatePool + 1`, which is sufficient to preserve overflow
 * semantics without materializing all eligible county targets.
 */
export interface BoundedReconciliationRepository {
  readonly generationId: string;
  streamSubjects(relation: LinkRelation): AsyncIterable<LinkableEntity>;
  streamCandidateTargets(
    relation: LinkRelation,
    subject: LinkableEntity,
    stage: BoundedCandidateStage,
  ): AsyncIterable<LinkableEntity>;
  streamReviews(relation: LinkRelation, subjectEntityId: string): AsyncIterable<ReviewDecision>;
  streamDuplicateMembers(relation: LinkRelation): AsyncIterable<BoundedDuplicateMember>;
  /** Atomically creates/reads the durable claim before candidate or resolution work. */
  beginSubject(
    relation: LinkRelation,
    subjectEntityId: string,
    contentSha256: string,
  ): Promise<BoundedReconciliationSubjectClaim>;
  writeDuplicateMember(relation: LinkRelation, value: BoundedDuplicateMember): Promise<void>;
  finalizeRelation(relation: LinkRelation, summary: BoundedReconciliationSummary): Promise<void>;
  abortRelation(relation: LinkRelation, reason: unknown): Promise<void>;
}

export type BoundedReconciliationInput = Readonly<{
  generationId: string;
  relation: LinkRelation;
  budget: BoundedProcessingBudget;
  repository: BoundedReconciliationRepository;
  /** Reserved before canonical size/hash work for every streamed record. */
  maximumCanonicalBytesPerRecord: number;
  canonicalSha256(value: unknown): string;
  canonicalByteLength(value: unknown): number;
  /** One instance must be shared by every concurrent downstream worker. */
  sharedBudget: ProcessWideBudgetCoordinator;
  sampleRssBytes?: () => number;
}>;

export type BoundedReconciliationSummary = Readonly<{
  stageVersion: typeof BOUNDED_RECONCILIATION_STAGE_VERSION;
  generationId: string;
  relation: LinkRelation;
  subjects: number;
  replaySubjects: number;
  resolutions: number;
  duplicateGroups: number;
  peakBufferedRecords: number;
  peakBufferedBytes: number;
  peakRssBytes: number;
}>;

export class BoundedReconciliationIntegrityError extends Error {
  public readonly code = 'BOUNDED_INPUT_INTEGRITY' as const;
}

export class BoundedReconciliationBudgetError extends Error {
  public readonly code = 'BOUNDED_BUDGET_EXCEEDED' as const;
}

/**
 * Resolves a relation one subject at a time. Exact policy order, authority,
 * normalization, scoring, ambiguity, review, visibility, and lineage semantics
 * are delegated to the established entity-linking-v1 engine. The only arrays
 * here are a single subject's disk-index-selected candidate/review working set,
 * strictly charged to the shared process budget.
 */
export async function reconcileBoundedRelation(
  input: BoundedReconciliationInput,
): Promise<BoundedReconciliationSummary> {
  if (input.repository.generationId !== input.generationId) {
    throw new BoundedReconciliationIntegrityError(
      'Reconciliation repository has mixed generation state',
    );
  }
  const sharedBudget = input.sharedBudget as ProcessWideBudgetCoordinator | undefined;
  if (sharedBudget === undefined) {
    throw new BoundedReconciliationBudgetError(
      'Reconciliation package calls require an explicit process-wide budget coordinator',
    );
  }
  if (
    !Number.isSafeInteger(input.maximumCanonicalBytesPerRecord) ||
    input.maximumCanonicalBytesPerRecord < 1 ||
    input.maximumCanonicalBytesPerRecord > input.budget.maxBufferedBytes
  ) {
    throw new BoundedReconciliationBudgetError(
      'Reconciliation requires a bounded canonical record reservation',
    );
  }
  try {
    sharedBudget.assertPolicy(input.budget);
  } catch (error) {
    throw new BoundedReconciliationBudgetError(
      error instanceof Error ? error.message : 'Reconciliation shared budget policy mismatch',
    );
  }
  const sampleRss = input.sampleRssBytes ?? (() => process.memoryUsage().rss);
  let subjects = 0;
  let replaySubjects = 0;
  let resolutions = 0;
  let duplicateGroups = 0;
  let peakBufferedRecords = 0;
  let peakBufferedBytes = 0;
  let peakRssBytes = sampleRss();
  let previousSubjectId: string | null = null;
  let activeReleases: (() => void)[] = [];
  let activeTransaction: BoundedReconciliationSubjectTransaction | null = null;

  const acquire = (records: number, bytes: number): (() => void) => {
    try {
      return sharedBudget.acquire(records, bytes);
    } catch (error) {
      throw new BoundedReconciliationBudgetError(
        error instanceof Error ? error.message : 'Reconciliation shared budget was exceeded',
      );
    }
  };

  const releaseActive = (): void => {
    for (const release of activeReleases.reverse()) release();
    activeReleases = [];
  };

  const assertBudget = (records: number, bytes: number): void => {
    peakBufferedRecords = Math.max(peakBufferedRecords, records);
    peakBufferedBytes = Math.max(peakBufferedBytes, bytes);
    const processWide = sharedBudget.snapshot();
    peakBufferedRecords = Math.max(peakBufferedRecords, processWide.peakBufferedRecords);
    peakBufferedBytes = Math.max(peakBufferedBytes, processWide.peakBufferedBytes);
    peakRssBytes = Math.max(peakRssBytes, sampleRss());
    if (
      records > input.budget.maxBufferedRecords ||
      bytes > input.budget.maxBufferedBytes ||
      peakRssBytes > input.budget.maxRssBytes
    ) {
      throw new BoundedReconciliationBudgetError(
        `Relation ${input.relation} exceeded the shared process budget for one subject`,
      );
    }
  };

  const measuredBytes = (value: unknown, label: string): number => {
    const bytes = input.canonicalByteLength(value);
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > input.maximumCanonicalBytesPerRecord) {
      throw new BoundedReconciliationBudgetError(
        `${label} exceeded its preallocated canonical serialization lease`,
      );
    }
    return bytes;
  };

  try {
    for await (const subject of input.repository.streamSubjects(input.relation)) {
      subjects += 1;
      if (previousSubjectId !== null && previousSubjectId >= subject.entityId) {
        throw new BoundedReconciliationIntegrityError(
          'Reconciliation subjects are not unique and ordered',
        );
      }
      previousSubjectId = subject.entityId;
      const subjectRelease = acquire(1, input.maximumCanonicalBytesPerRecord);
      activeReleases.push(subjectRelease);
      assertEntityArrayBounds(subject, 'Reconciliation subject');
      const subjectBytes = measuredBytes(subject, 'Reconciliation subject');
      assertBudget(1, input.maximumCanonicalBytesPerRecord);
      const claim = await input.repository.beginSubject(
        input.relation,
        subject.entityId,
        input.canonicalSha256(subject),
      );
      if (claim.state === 'replay_completed') {
        replaySubjects += 1;
        releaseActive();
        continue;
      }
      activeTransaction = claim;

      const targets: LinkableEntity[] = [];
      const reviews: ReviewDecision[] = [];
      let bufferedBytes = subjectBytes;
      let previousTargetId: string | null = null;
      const policy = policyFor(input.relation);
      const stages = ['authoritative_identifier', 'normalized_exact', 'bounded_candidate'] as const;
      for (const stage of subject.evidenceAvailability === 'blocked' ? [] : stages) {
        previousTargetId = null;
        for await (const target of input.repository.streamCandidateTargets(
          input.relation,
          subject,
          stage,
        )) {
          if (previousTargetId !== null && previousTargetId >= target.entityId) {
            throw new BoundedReconciliationIntegrityError(
              `Candidate targets for ${subject.entityId} are not unique and ordered`,
            );
          }
          previousTargetId = target.entityId;
          if (stage === 'bounded_candidate' && targets.length >= policy.maxCandidatePool + 1) {
            throw new BoundedReconciliationIntegrityError(
              `Candidate query for ${subject.entityId} did not enforce its disk-side limit`,
            );
          }
          const targetRelease = acquire(1, input.maximumCanonicalBytesPerRecord);
          activeReleases.push(targetRelease);
          assertEntityArrayBounds(target, 'Reconciliation target');
          const targetBytes = measuredBytes(target, 'Reconciliation target');
          targets.push(target);
          bufferedBytes += targetBytes;
          assertBudget(1 + targets.length + reviews.length, bufferedBytes);
        }
        if (targets.length > 0) break;
      }
      let previousReviewId: string | null = null;
      for await (const review of input.repository.streamReviews(input.relation, subject.entityId)) {
        if (previousReviewId !== null && previousReviewId >= review.decisionId) {
          throw new BoundedReconciliationIntegrityError(
            `Reviews for ${subject.entityId} are not unique and ordered`,
          );
        }
        previousReviewId = review.decisionId;
        const reviewRelease = acquire(1, input.maximumCanonicalBytesPerRecord);
        activeReleases.push(reviewRelease);
        if (review.evidenceLineage.length > 256) {
          throw new BoundedReconciliationIntegrityError(
            'Reconciliation review evidence lineage exceeds its fixed bound',
          );
        }
        const reviewBytes = measuredBytes(review, 'Reconciliation review');
        reviews.push(review);
        bufferedBytes += reviewBytes;
        assertBudget(1 + targets.length + reviews.length, bufferedBytes);
      }
      const releaseResolution = acquire(1, input.maximumCanonicalBytesPerRecord);
      activeReleases.push(releaseResolution);
      try {
        const run = linkEntities(input.relation, [subject], targets, reviews);
        const resolution = run.resolutions[0];
        if (resolution === undefined || run.resolutions.length !== 1) {
          throw new BoundedReconciliationIntegrityError(
            `Entity-linking did not emit one resolution for ${subject.entityId}`,
          );
        }
        const resolutionBytes = measuredBytes(resolution, 'Reconciliation resolution');
        assertBudget(1 + targets.length + reviews.length + 1, bufferedBytes + resolutionBytes);
        const commit = await claim.commit(resolution);
        if (commit === 'committed') resolutions += 1;
        else replaySubjects += 1;
        activeTransaction = null;
      } finally {
        releaseActive();
      }
      assertBudget(0, 0);
    }

    let previousDuplicateMemberKey: string | null = null;
    let activeDuplicateGroup: string | null = null;
    let expectedOrdinal = 0;
    for await (const member of input.repository.streamDuplicateMembers(input.relation)) {
      const groupKey = `${member.classification}\0${member.key}`;
      const key = `${groupKey}\0${member.ordinal.toString().padStart(12, '0')}\0${member.entityId}`;
      if (previousDuplicateMemberKey !== null && previousDuplicateMemberKey >= key) {
        throw new BoundedReconciliationIntegrityError(
          'Duplicate members are not unique and ordered',
        );
      }
      previousDuplicateMemberKey = key;
      if (activeDuplicateGroup !== groupKey) {
        activeDuplicateGroup = groupKey;
        expectedOrdinal = 0;
        duplicateGroups += 1;
      }
      if (member.ordinal !== expectedOrdinal) {
        throw new BoundedReconciliationIntegrityError(
          'Duplicate member ordinals are not contiguous',
        );
      }
      expectedOrdinal += 1;
      const release = acquire(1, input.maximumCanonicalBytesPerRecord);
      try {
        const memberBytes = measuredBytes(member, 'Duplicate member');
        assertBudget(1, memberBytes);
        await input.repository.writeDuplicateMember(input.relation, member);
      } finally {
        release();
      }
    }
    const summary = Object.freeze({
      stageVersion: BOUNDED_RECONCILIATION_STAGE_VERSION,
      generationId: input.generationId,
      relation: input.relation,
      subjects,
      replaySubjects,
      resolutions,
      duplicateGroups,
      peakBufferedRecords,
      peakBufferedBytes,
      peakRssBytes,
    });
    await input.repository.finalizeRelation(input.relation, summary);
    return summary;
  } catch (error) {
    await activeTransaction?.abort(error);
    releaseActive();
    await input.repository.abortRelation(input.relation, error);
    throw error;
  }
}

function assertEntityArrayBounds(entity: LinkableEntity, label: string): void {
  if (
    entity.identifiers.length > 256 ||
    entity.normalizedKeys.length > 256 ||
    entity.lineage.length > 256
  ) {
    throw new BoundedReconciliationIntegrityError(`${label} arrays exceed fixed bounds`);
  }
  let candidateAttributeCount = 0;
  for (const ignored in entity.candidateAttributes) {
    void ignored;
    candidateAttributeCount += 1;
    if (candidateAttributeCount > 64) {
      throw new BoundedReconciliationIntegrityError(
        `${label} candidate attributes exceed fixed bounds`,
      );
    }
  }
}
