import { createHash } from 'node:crypto';

import type { Visibility } from '@oracle/contracts/visibility';

import { scoreReconciliation } from '../scoring.js';
import type {
  CandidateField,
  DuplicateGroup,
  EntityLinkingRun,
  EvidenceAvailability,
  LinkEvidence,
  LinkGapReason,
  LinkLineageReference,
  LinkMethod,
  LinkPolicy,
  LinkProposal,
  LinkResolution,
  LinkableEntity,
  ReviewDecision,
} from './model.js';
import { policyFor } from './policies.js';
import type { LinkRelation } from './model.js';

const visibilityRank: Readonly<Record<Visibility, number>> = Object.freeze({
  public: 0,
  authenticated: 1,
  restricted: 2,
  prohibited_public: 3,
});

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite number in link input');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  throw new TypeError(`Unsupported link input type ${typeof value}`);
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function normalize(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

function mostRestrictive(values: readonly Visibility[]): Visibility {
  const result = [...values].sort((left, right) => visibilityRank[right] - visibilityRank[left])[0];
  if (result === undefined) throw new RangeError('Visibility propagation requires a value');
  return result;
}

function weakestAvailability(
  values: readonly Exclude<EvidenceAvailability, 'blocked'>[],
): Exclude<EvidenceAvailability, 'blocked'> {
  return values.includes('partial') ? 'partial' : 'complete';
}

function validateLineage(value: LinkLineageReference): void {
  if (!/^sc:source:[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.sourceId)) {
    throw new TypeError('Link lineage source ID is malformed');
  }
  const snapshotPrefix = value.sourceId.replace('sc:source:', 'sc:snapshot:');
  if (!new RegExp(`^${snapshotPrefix}:[a-f0-9]{64}$`, 'u').test(value.snapshotId)) {
    throw new TypeError('Link lineage snapshot does not belong to its source');
  }
  if (!/^sc:artifact:sha256:[a-f0-9]{64}$/u.test(value.artifactId)) {
    throw new TypeError('Link lineage artifact ID is malformed');
  }
  if (!/^[a-f0-9]{64}$/u.test(value.recordSha256) || value.recordKey.trim().length === 0) {
    throw new TypeError('Link lineage record identity is malformed');
  }
}

function stableLineage(values: readonly LinkLineageReference[]): readonly LinkLineageReference[] {
  const unique = new Map<string, LinkLineageReference>();
  for (const value of values) {
    validateLineage(value);
    unique.set(canonicalJson(value), value);
  }
  return Object.freeze(
    [...unique.values()]
      .sort(
        (left, right) =>
          left.sourceId.localeCompare(right.sourceId) ||
          left.snapshotId.localeCompare(right.snapshotId) ||
          left.recordKey.localeCompare(right.recordKey),
      )
      .map((value) => Object.freeze({ ...value })),
  );
}

function freezeEntity(entity: LinkableEntity): LinkableEntity {
  if (entity.entityId.trim().length === 0 || entity.jurisdiction.trim().length === 0) {
    throw new TypeError('Link entities require an ID and jurisdiction');
  }
  if (entity.lineage.length === 0) throw new TypeError('Link entities require immutable lineage');
  return Object.freeze({
    ...entity,
    identifiers: Object.freeze(entity.identifiers.map((value) => Object.freeze({ ...value }))),
    normalizedKeys: Object.freeze(
      entity.normalizedKeys.map((value) => Object.freeze({ ...value })),
    ),
    candidateAttributes: Object.freeze({ ...entity.candidateAttributes }),
    lineage: stableLineage(entity.lineage),
  });
}

function deduplicateEntities(
  input: readonly LinkableEntity[],
): Readonly<{ entities: readonly LinkableEntity[]; replayGroups: readonly DuplicateGroup[] }> {
  const byId = new Map<string, { entity: LinkableEntity; count: number; serialized: string }>();
  for (const raw of input) {
    const entity = freezeEntity(raw);
    const serialized = canonicalJson(entity);
    const previous = byId.get(entity.entityId);
    if (previous === undefined) byId.set(entity.entityId, { entity, count: 1, serialized });
    else if (previous.serialized !== serialized)
      throw new Error(`Entity ID ${entity.entityId} was reused for different link content`);
    else previous.count += 1;
  }
  const replayGroups = [...byId.values()]
    .filter(({ count }) => count > 1)
    .map(({ entity, count }) =>
      Object.freeze({
        classification: 'replay_duplicate' as const,
        key: `${entity.entityId}|copies:${count}`,
        entityIds: Object.freeze([entity.entityId]),
      }),
    );
  return Object.freeze({
    entities: Object.freeze(
      [...byId.values()]
        .map(({ entity }) => entity)
        .sort((a, b) => a.entityId.localeCompare(b.entityId)),
    ),
    replayGroups: Object.freeze(replayGroups),
  });
}

function sharedKeyGroups(entities: readonly LinkableEntity[]): readonly DuplicateGroup[] {
  const groups = new Map<string, LinkableEntity[]>();
  for (const entity of entities) {
    for (const identifier of entity.identifiers) {
      const key = `authoritative|${normalize(identifier.scheme)}|${normalize(identifier.scope)}|${normalize(identifier.value)}`;
      const values = groups.get(key) ?? [];
      values.push(entity);
      groups.set(key, values);
    }
    for (const exact of entity.normalizedKeys) {
      const key = `normalized|${exact.kind}|${normalize(exact.value)}`;
      const values = groups.get(key) ?? [];
      values.push(entity);
      groups.set(key, values);
    }
  }
  return Object.freeze(
    [...groups.entries()]
      .filter(([, values]) => new Set(values.map(({ entityId }) => entityId)).size > 1)
      .map(([key, values]) => {
        const distinct = [...new Map(values.map((value) => [value.entityId, value])).values()];
        const isApn = key.startsWith('normalized|apn|') || key.includes('|apn|');
        const unitsOnly = distinct.every(({ entityKind }) => entityKind === 'property-unit');
        return Object.freeze({
          classification:
            isApn && unitsOnly
              ? ('shared_apn_distinct_units' as const)
              : key.startsWith('authoritative|')
                ? ('shared_authoritative_identifier' as const)
                : ('shared_normalized_key' as const),
          key,
          entityIds: Object.freeze(distinct.map(({ entityId }) => entityId).sort()),
        });
      })
      .sort((left, right) => left.key.localeCompare(right.key)),
  );
}

function authoritativeStage(
  subject: LinkableEntity,
  targets: readonly LinkableEntity[],
  policy: LinkPolicy,
): readonly LinkableEntity[] {
  for (const rawScheme of policy.authoritativeSchemes) {
    const scheme = normalize(rawScheme);
    const matches = targets.filter((target) =>
      subject.identifiers.some((left) =>
        target.identifiers.some(
          (right) =>
            normalize(left.scheme) === scheme &&
            normalize(right.scheme) === scheme &&
            normalize(left.scope) === normalize(right.scope) &&
            normalize(left.value) === normalize(right.value),
        ),
      ),
    );
    if (matches.length > 0) return matches;
  }
  return [];
}

function normalizedExactStage(
  subject: LinkableEntity,
  targets: readonly LinkableEntity[],
  policy: LinkPolicy,
): readonly LinkableEntity[] {
  for (const kind of policy.normalizedKeyKinds) {
    const matches = targets.filter((target) =>
      subject.normalizedKeys.some((left) =>
        target.normalizedKeys.some(
          (right) =>
            left.kind === kind &&
            right.kind === kind &&
            normalize(left.value) === normalize(right.value),
        ),
      ),
    );
    if (matches.length > 0) return matches;
  }
  return [];
}

function tokenAgreement(left: string, right: string): number {
  const leftTokens = new Set(
    normalize(left)
      .split(/[^a-z0-9]+/gu)
      .filter(Boolean),
  );
  const rightTokens = new Set(
    normalize(right)
      .split(/[^a-z0-9]+/gu)
      .filter(Boolean),
  );
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return intersection / union;
}

function evidenceFor(
  subject: LinkableEntity,
  target: LinkableEntity,
  policy: LinkPolicy,
): readonly LinkEvidence[] {
  const evidence: LinkEvidence[] = [];
  for (const [field, weight] of Object.entries(policy.candidateFields) as [
    CandidateField,
    number,
  ][]) {
    const left = subject.candidateAttributes[field];
    const right = target.candidateAttributes[field];
    if (left === undefined || right === undefined) continue;
    const agreement =
      field === 'postalCode' || field === 'unit'
        ? Number(normalize(left) === normalize(right))
        : tokenAgreement(left, right);
    evidence.push(
      Object.freeze({
        key: field,
        agreement,
        weight,
        hardBlock: field === 'unit' && normalize(left) !== normalize(right),
      }),
    );
  }
  if (
    subject.parentPropertyId !== undefined &&
    subject.parentPropertyId !== null &&
    target.parentPropertyId !== undefined &&
    target.parentPropertyId !== null
  ) {
    evidence.push(
      Object.freeze({
        key: 'parentPropertyId',
        agreement: Number(subject.parentPropertyId === target.parentPropertyId),
        weight: 10,
        hardBlock: subject.parentPropertyId !== target.parentPropertyId,
      }),
    );
  }
  return Object.freeze(evidence.sort((left, right) => left.key.localeCompare(right.key)));
}

function firstAddressNumber(value: string | undefined): string | null {
  if (value === undefined) return null;
  return /\b\d+[a-z]?\b/u.exec(normalize(value))?.[0] ?? null;
}

function boundedCandidatePool(
  subject: LinkableEntity,
  targets: readonly LinkableEntity[],
  policy: LinkPolicy,
): readonly LinkableEntity[] {
  let pool = [...targets];
  const postalCode = subject.candidateAttributes.postalCode;
  if (policy.candidateFields.postalCode !== undefined && postalCode !== undefined) {
    pool = pool.filter(({ candidateAttributes }) => {
      const targetPostalCode = candidateAttributes.postalCode;
      return (
        targetPostalCode === undefined || normalize(targetPostalCode) === normalize(postalCode)
      );
    });
  }
  const addressNumber = firstAddressNumber(subject.candidateAttributes.address);
  if (policy.candidateFields.address !== undefined && addressNumber !== null) {
    pool = pool.filter(({ candidateAttributes }) => {
      const targetNumber = firstAddressNumber(candidateAttributes.address);
      return targetNumber === null || targetNumber === addressNumber;
    });
  }
  return Object.freeze(pool.sort((left, right) => left.entityId.localeCompare(right.entityId)));
}

function proposalFor(
  subject: LinkableEntity,
  target: LinkableEntity,
  policy: LinkPolicy,
  method: LinkMethod,
  score: number,
  evidence: readonly LinkEvidence[],
  accepted: boolean,
): LinkProposal {
  const evidenceLineage = stableLineage([...subject.lineage, ...target.lineage]);
  const identity = {
    subjectEntityId: subject.entityId,
    targetEntityId: target.entityId,
    relation: policy.relation,
    method,
    score,
    evidence,
    evidenceLineage,
    algorithmVersion: 'entity-linking-v1',
  } as const;
  return Object.freeze({
    proposalId: `sc:link:${hash(identity)}`,
    ...identity,
    evidenceAvailability: weakestAvailability([
      subject.evidenceAvailability as Exclude<EvidenceAvailability, 'blocked'>,
      target.evidenceAvailability as Exclude<EvidenceAvailability, 'blocked'>,
    ]),
    visibility: mostRestrictive([subject.visibility, target.visibility]),
    proposalState: accepted ? 'accepted' : 'candidate',
  });
}

function validateReviews(
  proposals: readonly LinkProposal[],
  input: readonly ReviewDecision[],
): Readonly<{
  decisions: readonly ReviewDecision[];
  acceptedProposal: LinkProposal | null;
  rejected: boolean;
}> {
  const proposalIds = new Set(
    proposals
      .filter(({ proposalState }) => proposalState === 'candidate')
      .map(({ proposalId }) => proposalId),
  );
  const decisions = input
    .filter(({ proposalId }) => proposalIds.has(proposalId))
    .map((decision) => {
      const decisionPayload = {
        proposalId: decision.proposalId,
        outcome: decision.outcome,
        reviewerRef: decision.reviewerRef,
        decidedAt: decision.decidedAt,
        rationale: decision.rationale,
        supersedesDecisionId: decision.supersedesDecisionId,
        evidenceLineage: decision.evidenceLineage,
        visibility: decision.visibility,
      } as const;
      if (decision.decisionId !== `sc:review:${hash(decisionPayload)}`) {
        throw new Error(`Review decision ${decision.decisionId} is not content-addressed`);
      }
      if (decision.reviewerRef.trim().length === 0 || decision.rationale.trim().length === 0) {
        throw new TypeError('Review decisions require reviewerRef and rationale');
      }
      if (!Number.isFinite(Date.parse(decision.decidedAt)))
        throw new TypeError('Review decision date is invalid');
      if (decision.evidenceLineage.length === 0)
        throw new TypeError('Review decisions require lineage');
      return Object.freeze({
        ...decision,
        evidenceLineage: stableLineage(decision.evidenceLineage),
      });
    })
    .sort((left, right) => left.decisionId.localeCompare(right.decisionId));
  const byId = new Map(decisions.map((decision) => [decision.decisionId, decision]));
  for (const decision of decisions) {
    if (decision.supersedesDecisionId !== null) {
      const superseded = byId.get(decision.supersedesDecisionId);
      if (superseded?.proposalId !== decision.proposalId) {
        throw new Error(`Review decision ${decision.decisionId} has an invalid supersession`);
      }
    }
  }
  const supersededIds = new Set(
    decisions
      .map(({ supersedesDecisionId }) => supersedesDecisionId)
      .filter((value): value is string => value !== null),
  );
  const effective = decisions.filter(({ decisionId }) => !supersededIds.has(decisionId));
  const accepted = effective.filter(({ outcome }) => outcome === 'accepted');
  if (accepted.length > 1)
    throw new Error('Review cannot accept more than one target for a subject relation');
  const acceptedProposal =
    accepted.length === 1
      ? (proposals.find(({ proposalId }) => proposalId === accepted[0]?.proposalId) ?? null)
      : null;
  return Object.freeze({
    decisions: Object.freeze(decisions),
    acceptedProposal,
    rejected: effective.length > 0 && effective.every(({ outcome }) => outcome === 'rejected'),
  });
}

export function createReviewDecision(input: Omit<ReviewDecision, 'decisionId'>): ReviewDecision {
  const normalized = Object.freeze({
    ...input,
    evidenceLineage: stableLineage(input.evidenceLineage),
  });
  return Object.freeze({ decisionId: `sc:review:${hash(normalized)}`, ...normalized });
}

function resolution(
  subject: LinkableEntity,
  policy: LinkPolicy,
  proposals: readonly LinkProposal[],
  state: LinkResolution['state'],
  matchStage: LinkMethod | null,
  gapReasons: readonly LinkGapReason[],
  reviewInput: readonly ReviewDecision[],
): LinkResolution {
  const review = validateReviews(proposals, reviewInput);
  const acceptedProposal =
    proposals.find(({ proposalState }) => proposalState === 'accepted') ?? review.acceptedProposal;
  const effectiveState =
    review.acceptedProposal !== null
      ? 'review_accepted'
      : review.rejected
        ? 'review_rejected'
        : state;
  const effectiveGaps =
    review.acceptedProposal !== null
      ? []
      : review.rejected
        ? ['review_rejected' as const]
        : gapReasons;
  const visibility = mostRestrictive([
    subject.visibility,
    ...proposals.map(({ visibility }) => visibility),
    ...review.decisions.map(({ visibility: value }) => value),
  ]);
  const identity = {
    subjectEntityId: subject.entityId,
    relation: policy.relation,
    proposals: proposals.map(({ proposalId }) => proposalId),
    reviews: review.decisions.map(({ decisionId }) => decisionId),
    effectiveState,
  };
  const evidenceAvailability =
    subject.evidenceAvailability === 'blocked'
      ? 'blocked'
      : proposals.some(({ evidenceAvailability: value }) => value === 'partial') ||
          subject.evidenceAvailability === 'partial'
        ? 'partial'
        : 'complete';
  return Object.freeze({
    resolutionId: `sc:resolution:${hash(identity)}`,
    subjectEntityId: subject.entityId,
    relation: policy.relation,
    state: effectiveState,
    matchStage,
    acceptedTargetEntityId: acceptedProposal?.targetEntityId ?? null,
    proposals: Object.freeze(
      [...proposals].sort((a, b) => a.proposalId.localeCompare(b.proposalId)),
    ),
    reviewDecisions: review.decisions,
    gapReasons: Object.freeze(effectiveGaps),
    evidenceAvailability,
    strictClaimEligible:
      acceptedProposal !== null &&
      (!policy.requireCompleteEvidence || evidenceAvailability === 'complete'),
    visibility,
  });
}

function resolveSubject(
  subject: LinkableEntity,
  targets: readonly LinkableEntity[],
  policy: LinkPolicy,
  reviews: readonly ReviewDecision[],
): LinkResolution {
  if (!policy.subjectKinds.includes(subject.entityKind))
    throw new TypeError(`Invalid ${policy.relation} subject kind ${subject.entityKind}`);
  if (subject.evidenceAvailability === 'blocked') {
    return resolution(subject, policy, [], 'unknown', null, ['source_blocked'], reviews);
  }
  const eligible = targets.filter(
    (target) =>
      policy.targetKinds.includes(target.entityKind) &&
      target.evidenceAvailability !== 'blocked' &&
      (!policy.requireSameJurisdiction ||
        normalize(target.jurisdiction) === normalize(subject.jurisdiction)),
  );
  const authoritative = authoritativeStage(subject, eligible, policy);
  if (authoritative.length > 0) {
    const unique = authoritative.length === 1;
    const proposals = authoritative.map((target) =>
      proposalFor(subject, target, policy, 'authoritative_identifier', 1, [], unique),
    );
    return resolution(
      subject,
      policy,
      proposals,
      unique ? 'accepted' : 'ambiguous',
      'authoritative_identifier',
      unique ? [] : ['ambiguous_authoritative_identifier', 'review_not_completed'],
      reviews,
    );
  }
  const exact = normalizedExactStage(subject, eligible, policy);
  if (exact.length > 0) {
    const unique = exact.length === 1;
    const proposals = exact.map((target) =>
      proposalFor(subject, target, policy, 'normalized_exact', 1, [], unique),
    );
    return resolution(
      subject,
      policy,
      proposals,
      unique ? 'accepted' : 'ambiguous',
      'normalized_exact',
      unique ? [] : ['ambiguous_normalized_exact', 'review_not_completed'],
      reviews,
    );
  }
  const candidatePool = boundedCandidatePool(subject, eligible, policy);
  if (candidatePool.length > policy.maxCandidatePool) {
    return resolution(
      subject,
      policy,
      [],
      'unresolved',
      null,
      ['candidate_pool_exceeded'],
      reviews,
    );
  }
  const scored = candidatePool
    .map((target) => {
      const evidence = evidenceFor(subject, target, policy);
      if (evidence.length === 0) return null;
      const decision = scoreReconciliation(
        evidence.map(({ key, agreement, weight, hardBlock }) => ({
          key,
          agreement,
          weight,
          hardBlock,
        })),
        { review: policy.candidateThreshold, autoLink: 1 },
      );
      return decision.classification === 'reject'
        ? null
        : proposalFor(
            subject,
            target,
            policy,
            'bounded_candidate',
            decision.score,
            evidence,
            false,
          );
    })
    .filter((value): value is LinkProposal => value !== null)
    .sort(
      (left, right) =>
        right.score - left.score || left.targetEntityId.localeCompare(right.targetEntityId),
    );
  if (scored.length === 0) {
    const anySignals = candidatePool.some(
      (target) => evidenceFor(subject, target, policy).length > 0,
    );
    return resolution(
      subject,
      policy,
      [],
      'unresolved',
      null,
      [
        anySignals ? 'candidate_below_threshold' : 'no_candidate_signals',
        'no_authoritative_or_exact_match',
      ],
      reviews,
    );
  }
  return resolution(
    subject,
    policy,
    scored,
    scored.length === 1 ? 'candidate' : 'ambiguous',
    'bounded_candidate',
    scored.length === 1
      ? ['review_not_completed']
      : ['ambiguous_bounded_candidate', 'review_not_completed'],
    reviews,
  );
}

export function linkEntities(
  relation: LinkRelation,
  unparsedSubjects: readonly LinkableEntity[],
  unparsedTargets: readonly LinkableEntity[],
  reviews: readonly ReviewDecision[] = [],
): EntityLinkingRun {
  const policy = policyFor(relation);
  const subjects = deduplicateEntities(unparsedSubjects);
  const targets = deduplicateEntities(unparsedTargets);
  const resolutions = subjects.entities.map((subject) =>
    resolveSubject(subject, targets.entities, policy, reviews),
  );
  const usedReviewIds = new Set(
    resolutions.flatMap(({ reviewDecisions }) =>
      reviewDecisions.map(({ decisionId }) => decisionId),
    ),
  );
  const unusedReviews = reviews.filter(({ decisionId }) => !usedReviewIds.has(decisionId));
  if (unusedReviews.length > 0)
    throw new Error(
      `Review decision does not reference a candidate proposal: ${unusedReviews[0]?.decisionId ?? 'unknown'}`,
    );
  return Object.freeze({
    algorithmVersion: 'entity-linking-v1',
    relation,
    resolutions: Object.freeze(
      resolutions.sort((left, right) => left.subjectEntityId.localeCompare(right.subjectEntityId)),
    ),
    duplicateGroups: Object.freeze(
      [
        ...subjects.replayGroups,
        ...targets.replayGroups,
        ...sharedKeyGroups(targets.entities),
      ].sort(
        (left, right) =>
          left.classification.localeCompare(right.classification) ||
          left.key.localeCompare(right.key),
      ),
    ),
  });
}
