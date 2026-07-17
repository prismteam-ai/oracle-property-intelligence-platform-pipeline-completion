# Walkability and transparent ranking

Status: implemented feature contract for ORA-064–067.

## Purpose and boundary

The walkability package consumes the already-pinned OSM pedestrian graph, normalized GTFS
snapshots, and Overture Starbucks candidates. It performs no acquisition, live provider call,
publication, or source mutation. All output is deterministic for the same immutable inputs and
calculation parameters.

Walking distance means distance along a successful directed pedestrian-network path. Geodesic
math is used only to measure a bounded endpoint-to-node snap and each graph edge's stored
geometry. Snap offsets are reported separately and are never returned as a replacement walking
route. A missing graph path therefore yields `unknown`, not a straight-line estimate labelled as
walking distance.

## Offline pedestrian routing (ORA-064)

`routePedestrian` validates the graph, snaps both coordinates to route-eligible nodes within the
caller-provided bound, and runs deterministic shortest-path routing. Equal-cost paths are resolved
by stable edge/path identity, so graph input order cannot change the result.

An edge is eligible only when all of the following hold:

- the pinned graph marks it routable;
- pedestrian access is explicitly allowed;
- its stored forward/reverse direction agrees with pedestrian direction;
- endpoint barriers allow pedestrian passage;
- neither endpoint explicitly prohibits crossing;
- declared edge/node levels intersect, or unlevelled endpoints do not assert a level
  discontinuity; and
- the transition does not violate a pedestrian-applicable OSM `no_*` or `only_*` turn
  restriction.

Unknown access, unknown direction, unknown barrier access already make an adapter edge
non-routable and remain visible in rejection counts. The feature does not upgrade those states.
Nodes with forbidden barriers, prohibited crossings, no eligible incident edge, or a requested
level mismatch cannot be snap targets.

Typed terminal reasons are:

- `invalid_request`;
- `invalid_graph`;
- `origin_snap_failed`;
- `destination_snap_failed`;
- `disconnected_components`; and
- `no_route`.

Successful results include the ordered node and edge path, routed network meters, walk time under
the versioned speed parameter, graph artifact/version, both snap distances, rejected-edge reason
counts, and graph limitations. Failures retain any successful snap and the same rejection and
lineage context.

## Transit walkability (ORA-065)

Transit evaluation is bound to an explicit service date. The normalized feed has already applied
`calendar.txt` and `calendar_dates.txt`; the feature additionally requires the snapshot's selected
date to equal the query date. A boarding identity must be active, passenger-boardable, permit
pickup on that date, have active service IDs, and use GTFS location type `0` (stop/platform) or
`4` (boarding area).

Stations, parents, entrances, and other non-boarding geometry cannot independently satisfy the
inquiry. They can serve as the pedestrian access destination only when parent relationships or a
non-forbidden directional GTFS transfer connects them into a qualifying boarding identity.
Transfer traversal is deliberately reversed from `to_stop_id` to `from_stop_id` because the
search starts at the boarding identity and looks for access geometry that can lead into it; a
transfer declared only in the opposite direction cannot qualify that geometry. The result
preserves both identities:

- `boardingStop`: the active stop/platform/boarding area and its route/service IDs;
- `accessStop`: the routed self/parent/entrance/transfer geometry.

GTFS `transfer_type=3` never creates topology. A bounded four-hop station topology traversal
prevents a malformed transfer graph from becoming an unbounded destination expansion. Exact
duplicate feed rows follow explicit primary-feed precedence; conflicting duplicates are excluded
as `duplicate_stop_conflict` rather than selected first.

A reachable destination beyond the requested maximum remains a supported negative result with
`withinThreshold:false`. No eligible destination or no network route returns `unknown`. Coverage
reports observed, eligible, routed, and excluded destination counts plus exclusion reasons,
including service exceptions, non-boardable locations, date mismatch, duplicates, and routing
failure.

## Starbucks walkability (ORA-066)

Every destination retains its Overture GERS ID, release, match mode, confidence, operating state,
contributors, source licenses/notices, and sampled validation state. Eligibility never converts
name/category similarity into a verified store identity.

Strict mode requires:

- a Starbucks candidate rather than `not_starbucks_candidate`;
- confidence at or above the caller's threshold;
- open Overture operating state;
- candidate state `candidate`;
- sampled official validation state `sampled_open`; and
- evidence that is not `prohibited_public`.

Closed candidates and sampled-closed candidates are always excluded. Unconfirmed, unknown, or
conflicting validation can be included only through the explicit `includeUnconfirmed` option; the
result then has support state `proxy` and a review-required limitation. It is never silently
promoted to supported.

Conflicting rows with one GERS ID are all excluded. Identical versions and materially identical
place identities use deterministic, evidence-aware precedence and expose duplicate-collapse
counts. No candidates, only excluded candidates, or no routed destination yields `unknown`; source
absence never produces a positive proximity claim.

## Common evidence envelope

Transit and Starbucks outputs carry:

- `supportState`: `supported`, `proxy`, or `unknown` for these calculations;
- typed feature value or `null`;
- immutable source observations with source/snapshot/artifact/record IDs;
- algorithm name, semantic version, and exact parameters;
- calculation `asOf`;
- measured destination coverage and reason counts;
- sorted limitations and evidence links; and
- the most restrictive visibility of the evidence used.

Restricted evidence remains restricted. `prohibited_public` Starbucks evidence is not route
eligible and remains visible in an unknown result's exclusion accounting. Source observations,
limitations, evidence links, destinations, and routes are stably ordered.

## Combined ranking (ORA-067)

`rankReviewCandidates` is a deterministic policy calculation, not an AI score. The versioned
policy declares each criterion's non-negative weight, its proxy multiplier, whether proxies are
enabled, the minimum evidence coverage, and the fixed unknown policy
`zero_contribution_and_reduce_coverage`.

For each configured component:

```text
supported contribution = value × weight
proxy contribution     = value × weight × proxyMultiplier (only when enabled)
unknown/unsupported    = 0
missing                = 0

score = sum(contributions) / sum(all configured weights)
```

The denominator never shrinks when evidence is absent. Missing or unknown evidence therefore
cannot improve a score and also reduces `evidenceCoverage`. Candidates below minimum coverage
are retained with `rank:null` and an explicit exclusion reason. Stable ordering is: included
before excluded, score descending, coverage descending, then property ID.

Each ranked row exposes raw normalized component values, weights, applied multipliers,
contributions, support states, component exclusions, evidence links, limitations, total and
maximum weighted score, coverage, policy/calculation version, as-of date, and propagated
visibility. A signal whose criterion is absent from the policy is rejected rather than ignored,
and the calculation as-of value must be an ISO timestamp with an explicit offset.

## Verification

Focused tests cover:

- known small graphs, replay and input-order independence;
- one-way, turn restriction, barrier, crossing, level, disconnected-component, and snap failures;
- routed distance differing from direct geodesic distance;
- GTFS service-date exceptions, active boardability, parent/entrance/platform preservation,
  transfers, forbidden transfers, and conflicting duplicates;
- sampled-open, unconfirmed proxy, strict unknown, closed, prohibited-public, conflicting GERS,
  and duplicate Overture destinations;
- deterministic ranks, proxy multipliers, missing/unknown zero contribution, coverage exclusion,
  evidence links, limitations, and visibility propagation; and
- a safe semantic golden registry for later query/API/MCP parity checks.

The implementation intentionally does not claim real-county walkability until the full pinned OSM,
GTFS, and Overture artifacts are integrated and their measured coverage is available.
