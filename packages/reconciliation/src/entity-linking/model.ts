import type { CanonicalEntityKind } from '@oracle/contracts/ids';
import type { Visibility } from '@oracle/contracts/visibility';

export type EvidenceAvailability = 'complete' | 'partial' | 'blocked';

export type LinkLineageReference = Readonly<{
  sourceId: string;
  snapshotId: string;
  artifactId: string;
  recordKey: string;
  recordSha256: string;
}>;

export type AuthorityIdentifier = Readonly<{
  scheme: string;
  value: string;
  scope: string;
}>;

export type NormalizedExactKey = Readonly<{
  kind: 'apn' | 'address' | 'address_unit' | 'license' | 'entity_number' | 'document_id';
  value: string;
}>;

export type CandidateAttributes = Readonly<{
  address?: string;
  name?: string;
  postalCode?: string;
  unit?: string;
}>;

export type LinkableEntity = Readonly<{
  entityId: string;
  entityKind: CanonicalEntityKind;
  jurisdiction: string;
  parentPropertyId?: string | null;
  identifiers: readonly AuthorityIdentifier[];
  normalizedKeys: readonly NormalizedExactKey[];
  candidateAttributes: CandidateAttributes;
  evidenceAvailability: EvidenceAvailability;
  visibility: Visibility;
  lineage: readonly LinkLineageReference[];
}>;

export type LinkRelation =
  | 'property_address'
  | 'property_unit'
  | 'permit_property'
  | 'permit_contractor'
  | 'contractor_business'
  | 'business_address'
  | 'ownership_property'
  | 'ownership_party'
  | 'transfer_property';

export type LinkMethod = 'authoritative_identifier' | 'normalized_exact' | 'bounded_candidate';

export type CandidateField = keyof CandidateAttributes;

export type LinkPolicy = Readonly<{
  relation: LinkRelation;
  subjectKinds: readonly CanonicalEntityKind[];
  targetKinds: readonly CanonicalEntityKind[];
  authoritativeSchemes: readonly string[];
  normalizedKeyKinds: readonly NormalizedExactKey['kind'][];
  candidateFields: Readonly<Partial<Record<CandidateField, number>>>;
  candidateThreshold: number;
  maxCandidatePool: number;
  requireSameJurisdiction: boolean;
  requireCompleteEvidence: boolean;
}>;

export type LinkEvidence = Readonly<{
  key: string;
  agreement: number;
  weight: number;
  hardBlock: boolean;
}>;

export type LinkProposal = Readonly<{
  proposalId: string;
  subjectEntityId: string;
  targetEntityId: string;
  relation: LinkRelation;
  method: LinkMethod;
  score: number;
  evidence: readonly LinkEvidence[];
  evidenceLineage: readonly LinkLineageReference[];
  evidenceAvailability: Exclude<EvidenceAvailability, 'blocked'>;
  visibility: Visibility;
  proposalState: 'accepted' | 'candidate';
  algorithmVersion: 'entity-linking-v1';
}>;

export type ReviewDecision = Readonly<{
  decisionId: string;
  proposalId: string;
  outcome: 'accepted' | 'rejected';
  reviewerRef: string;
  decidedAt: string;
  rationale: string;
  supersedesDecisionId: string | null;
  evidenceLineage: readonly LinkLineageReference[];
  visibility: Visibility;
}>;

export type LinkGapReason =
  | 'source_blocked'
  | 'no_authoritative_or_exact_match'
  | 'no_candidate_signals'
  | 'candidate_below_threshold'
  | 'candidate_pool_exceeded'
  | 'ambiguous_authoritative_identifier'
  | 'ambiguous_normalized_exact'
  | 'ambiguous_bounded_candidate'
  | 'review_not_completed'
  | 'review_rejected';

export type LinkResolution = Readonly<{
  resolutionId: string;
  subjectEntityId: string;
  relation: LinkRelation;
  state:
    | 'accepted'
    | 'candidate'
    | 'ambiguous'
    | 'review_accepted'
    | 'review_rejected'
    | 'unresolved'
    | 'unknown';
  matchStage: LinkMethod | null;
  acceptedTargetEntityId: string | null;
  proposals: readonly LinkProposal[];
  reviewDecisions: readonly ReviewDecision[];
  gapReasons: readonly LinkGapReason[];
  evidenceAvailability: EvidenceAvailability;
  strictClaimEligible: boolean;
  visibility: Visibility;
}>;

export type DuplicateClassification =
  | 'replay_duplicate'
  | 'shared_apn_distinct_units'
  | 'shared_authoritative_identifier'
  | 'shared_normalized_key';

export type DuplicateGroup = Readonly<{
  classification: DuplicateClassification;
  key: string;
  entityIds: readonly string[];
}>;

export type EntityLinkingRun = Readonly<{
  algorithmVersion: 'entity-linking-v1';
  relation: LinkRelation;
  resolutions: readonly LinkResolution[];
  duplicateGroups: readonly DuplicateGroup[];
}>;
