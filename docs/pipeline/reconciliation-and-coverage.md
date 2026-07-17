# Reconciliation and coverage

Status: implemented for ORA-051–056.

## Boundary

The reconciliation package consumes frozen canonical records. It does not
acquire source data, normalize canonical entities, choose preferred canonical
field values, publish artifacts, or make inquiry claims. Its outputs are
deterministic link proposals, separately recorded review decisions, duplicate
classifications, and denominator-bound coverage metrics.

The implementation entry points are:

- `linkEntities` and `createReviewDecision` in
  `@oracle/reconciliation/entity-linking/engine`;
- `policyFor` in `@oracle/reconciliation/entity-linking/policies`;
- `measureCoverage`, `buildCoverageReport`, and
  `relationCoverageFromLinkingRun` in
  `@oracle/reconciliation/coverage/report`.

There are no package-barrel changes. The package's existing wildcard subpath
export resolves these modules after build.

## Ordered link semantics

Every relation follows the same non-overlapping stages:

1. authority identifier, considered in policy order;
2. normalized exact key, considered in policy order;
3. bounded candidate scoring;
4. a separate immutable review decision for a candidate or ambiguity.

The first stage that finds any target is terminal for automatic matching. A
collision at an authoritative or normalized stage remains ambiguous; the
engine does not continue to a weaker stage to pick a convenient row. A unique
authoritative or normalized target is accepted. A scored candidate is never
accepted by score alone, including a score of `1`; it remains a candidate until
a content-addressed review decision accepts it.

Review decisions append evidence. They reference one candidate proposal and
may supersede an earlier decision for that same proposal. The proposal stays a
candidate in the record; the resolution derives an effective
`review_accepted` or `review_rejected` state without mutating the original
evidence.

Input order does not influence proposals, resolutions, duplicate groups, or
coverage. IDs are content-addressed from canonical serialization, and output
collections use stable identity-based ordering. Replaying an identical entity
ID is classified as `replay_duplicate`; reusing an ID for different content is
a hard error.

## Domain policies

| Relation            | Strong evidence                           | Exact evidence                            | Candidate evidence         |
| ------------------- | ----------------------------------------- | ----------------------------------------- | -------------------------- |
| property/address    | source property or county parcel ID       | APN, normalized address                   | address and postal code    |
| property/unit       | assessment or source unit ID              | normalized address plus unit              | address, unit, postal code |
| permit/property     | source property, parcel, or assessment ID | address plus unit, then APN, then address | address, unit, postal code |
| permit/contractor   | CSLB license                              | normalized license                        | name and address           |
| contractor/business | California SOS or approved FBN ID         | normalized entity number                  | legal name and address     |
| business/address    | source address or property ID             | normalized address                        | address and postal code    |
| ownership/property  | source property or assessment ID          | address plus unit, then APN, then address | address, unit, postal code |
| ownership/party     | source party ID                           | none                                      | name and address           |
| transfer/property   | source property or assessment ID          | address plus unit, then APN, then address | address, unit, postal code |

Address-unit exact keys precede APN for unit-capable relations. This permits a
supported unit identifier to disambiguate a shared parcel. An APN without unit
evidence remains ambiguous across distinct units. A candidate unit mismatch is
a hard block even if street address and postal code agree.

Permit owner/applicant text is deliberately absent from the permit/property
and ownership link signals. It cannot establish a current owner, ownership
interest, transfer, or property identity.

Candidate pools are jurisdiction-filtered where the relation is local, then
deterministically blocked by available postal code and street number before
scoring. Targets that lack a blocking field remain eligible so incomplete
source fields do not become false negatives. Exceeding the policy bound produces
`candidate_pool_exceeded`; candidates are not silently truncated. Candidate
scores use declared field weights, retain every contribution, and use stable
target-ID tie breaking.

## Blocked, partial, and visibility behavior

A blocked subject capability emits `unknown` with `source_blocked`, no proposal,
and no positive relation. This is the required behavior for business/FBN and
ownership sources that have not been integrated.

A partial source may establish a record-level exact link, but the resolution
retains `evidenceAvailability: partial` and `strictClaimEligible: false`.
Downstream ownership-tenure and
regional-owner features must therefore deny strict claims unless their own
complete-history/current-owner contracts also pass. Reconciliation never
upgrades partial evidence to complete.

Every proposal combines subject and target visibility using the most
restrictive class. A review can further restrict visibility. Coverage reports
retain one denominator while deriving separate public, authenticated, and
operator numerators. `prohibited_public` records contribute to no audience
projection. Restricted evidence can therefore never improve public coverage.

## Duplicate behavior

Duplicate reporting is separate from matching. The engine classifies:

- identical replay records;
- shared APNs across supported distinct units;
- shared authoritative identifiers across distinct entities;
- shared normalized keys across distinct entities.

Distinct IDs are never collapsed. A shared key appears both as a duplicate
classification and, when used for a relation, as an explicit ambiguity. This
preserves condominium units, assessment cards, source revisions, and unresolved
false-merge risks for review.

## Coverage contract

Coverage metrics use one of four dimensions: source, entity, field, or
relation. Every metric carries:

- dataset and measured subject;
- jurisdiction and an explicit time window or a deliberate `null`;
- numerator;
- denominator value, method, scope, as-of, and immutable source lineage;
- ratio or `null`;
- source terminal and derived completeness states;
- typed gap reasons with counts where measurable;
- source IDs;
- visibility counts and audience-specific ratios;
- duplicate classifications;
- relation method and confidence counts;
- immutable metric lineage.

The denominator methods are authoritative source count, source manifest,
observed population, or unavailable capability. A missing denominator is
`null`; it requires a `denominator_unavailable` or `capability_unavailable` gap.
A zero denominator is rejected because it cannot prove a complete empty
dataset. Numerators above known denominators remain measurable but require the
explicit `numerator_exceeds_denominator` gap rather than being capped or hidden.

Completeness is derived rather than caller-asserted:

- blocked source terminal state becomes `blocked`;
- failed becomes `failed`;
- unavailable or unknown denominator becomes `unknown`;
- succeeded with numerator at least the known denominator becomes `complete`;
- every other measurable case becomes `partial`.

All non-complete metrics require at least one gap reason. Relation method and
confidence counts must independently sum to the accepted-link numerator.
Visibility counts must also sum to the numerator. These arithmetic invariants
prevent coverage labels from drifting away from the reported rows.

`relationCoverageFromLinkingRun` measures accepted and review-accepted links
against the full subject population. It converts unresolved, ambiguous,
pending-review, blocked, restricted, and duplicate states into visible gaps.
Candidate and ambiguous proposals do not count as linked.

## Example blocked capability

```ts
measureCoverage({
  dimension: 'source',
  dataset: 'ownership-events',
  subject: 'transfer history',
  jurisdiction: 'Santa Clara County',
  timeWindow: null,
  numerator: 0,
  denominator: {
    value: null,
    method: 'capability_unavailable',
    scope: 'Santa Clara County ownership history',
    asOf: releaseAsOf,
    lineage: capabilityLineage,
  },
  terminalState: 'blocked',
  gapReasons: [
    {
      code: 'capability_unavailable',
      count: null,
      detail: 'The approved ownership/transfer adapter is not integrated.',
    },
  ],
  sourceIds: [ownershipCapabilitySourceId],
  visibilityCounts: {
    public: 0,
    authenticated: 0,
    restricted: 0,
    prohibited_public: 0,
  },
  duplicateCounts: {},
  lineage: capabilityLineage,
});
```

This output is an implemented engineering state, not functional ownership
coverage and not evidence that no transfers occurred.

## Verification fixtures

The reconciliation testkit contains safe synthetic cases for shared APNs,
unit false merges, candidate review, blocked business capability, partial
ownership history, prohibited permit-owner text, time-window denominators,
gap reasons, and visibility arithmetic. Production runs must replace fixture
lineage with real immutable snapshot/artifact references; fixture IDs must
never appear in county release data.

Focused tests prove:

- replay and input-order independence;
- authoritative-before-exact precedence;
- exact address-unit disambiguation and shared-APN ambiguity;
- no first-row/unit collapse;
- unit-mismatch hard blocks;
- candidate thresholds and bounded-pool failure;
- separate immutable review acceptance;
- contractor, business, permit, ownership, and transfer domain identifiers;
- permit owner text exclusion;
- blocked/partial capability propagation;
- coverage arithmetic and unknown denominators;
- source/entity/field/relation report construction;
- public/authenticated/operator visibility propagation.
