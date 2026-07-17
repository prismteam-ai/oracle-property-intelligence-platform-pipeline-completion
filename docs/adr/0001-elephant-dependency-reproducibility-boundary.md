# ADR 0001: Elephant dependency reproducibility boundary

- Status: Accepted for the authorized local ORA-003 implementation
- Date: 2026-07-17
- Decision owner: Oracle assessment
- Scope: Supporting Elephant source identities and future modification form

## Context

The assessment must reuse the Team Kit Oracle and Elephant contracts without
turning a mutable branch, an unreviewed source copy, or a developer workstation
checkout into a release dependency. The six supporting repositories are owned
upstream by `elephant-xyz`; the assessment owns its adapters, artifacts,
runtime, and release evidence. It does not own or assume access to Elephant's
operational AWS, Neon, Filebase, queue, or signing resources.

The coordinator independently observed each public default branch and `HEAD` on
2026-07-17. ORA-003 receives those identities as verified inputs; it does not
repeat the network check, clone, install, copy, execute, modify, or redistribute
upstream source.

Source identity and legal permission answer different questions:

- a repository URL plus a full commit SHA identifies bytes;
- a verified license and an explicit redistribution decision authorize a use.

The first does not imply the second.

## Decision

Use **exact upstream pin plus assessment-owned adapter** as the active
reproducibility boundary.

1. Record every upstream using its canonical
   `https://github.com/<owner>/<repository>.git` URL, observed default branch,
   and exact 40-character commit SHA.
2. Treat the branch as observation metadata only. The consumable `pinnedRef`
   is the full SHA and must equal the recorded commit.
3. Keep assessment-specific behavior in assessment-owned adapters. Do not edit
   or silently fork an upstream worktree in place.
4. Keep license state and redistribution state explicit and independent from
   commit identity. The current six records make no redistribution claim.
5. Fail closed on drift, missing ownership, moving or abbreviated refs, local
   paths, unknown states, duplicates, or redistribution claims without approval
   evidence.
6. Permit a future upstream modification only in one of two reviewed forms:
   - an exact-base, SHA-256-bound vendored patch/apply manifest with a
     deterministic apply command and expected result-tree hash; or
   - an approved, reachable fork commit identified by canonical HTTPS URL and
     full SHA, with its exact upstream base relationship recorded.
7. Never accept a mutable branch/tag, workstation path, unhashed patch,
   unapproved source copy, or unreachable fork commit as a release dependency.

The machine-readable policy and lock are
`config/dependencies/dependency-lock.contract.json` and
`config/dependencies/elephant-dependencies.lock.json`. The TypeScript validator
uses only Node standard-library APIs and treats the policy shape and allowed
states as fail-closed invariants.

## Elephant MCP security boundary

Keep the official unmodified `elephant-xyz/elephant-mcp` pin
`0aa1ede8406819e341a58d3abcb3593e5cd3ba94` as compatibility evidence for the
later isolated ORA-026 initialize, tool-list, metadata, schema, and safe-positive
smoke route.

That identity is not approval to expose its direct caller-authored SQL path.
`queryProperties` and `queryPermits` remain blocked until ORA-069 certifies an
approved replacement compatibility implementation against parser/AST,
relation/function allowlist, isolation, resource-bound, dependency, fuzz, and
reachability requirements. The assessment's named SQL-free evidence tools
remain the primary evaluator authority.

## Alternatives considered

### Depend on `main`

Rejected. It is convenient for development but cannot reproduce a reviewed
release after upstream moves.

### Depend on a local sibling checkout

Rejected. It hides bytes and local edits, fails clean-room reproduction, and is
not reachable by reviewers or CI.

### Vendor all six repositories now

Rejected for this wave. It copies a large ownership surface before a concrete
modification exists and before license/redistribution review. It also obscures
which assessment delta is actually required.

### Create assessment forks now

Deferred. A fork adds maintenance and review surface without value when no
upstream modification exists. If a change becomes necessary, the reachable
fork-SHA form is already defined.

### Reimplement the Elephant pipeline independently

Rejected. It would discard the Team Kit/Elephant orchestration contracts and
weaken the assessment's agent-team evidence. Assessment-owned adapters extend
the pinned contracts instead.

## Consequences and tradeoffs

- Rebuild inputs are reviewable and cannot silently follow branch movement.
- The assessment owns every adaptation and does not imply ownership of upstream
  runtime resources.
- License uncertainty remains visible instead of being converted into a false
  redistribution claim.
- A future upstream fix requires a small manifest or reachable fork decision,
  adding review work in exchange for deterministic provenance.
- The lock proves identity, not runtime compatibility, source safety, license
  permission, deployment readiness, or successful execution. ORA-010, ORA-022,
  ORA-025, ORA-026, and ORA-069 own those later proofs.
- ORA-003 adds no package manifest or lockfile because it materializes no
  package. Product toolchain and transitive package locks are frozen by
  ORA-010.

## Verification

Run the offline validator and adversarial self-test exactly as documented in
`docs/operations/dependency-reproduction.md`. The self-test writes temporary
invalid fixtures only under `config/dependencies`, verifies the required
failure classes, and removes the fixture directory in a guarded `finally`
block.
