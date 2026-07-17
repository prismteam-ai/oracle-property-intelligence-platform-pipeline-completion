# Named inquiries and local IPFS artifact construction

This module provides the deterministic, SQL-free query and local artifact boundary used by the
Oracle assessment. It does not publish data, call Filebase, pin content, or mutate IPNS.

## Named inquiry contract

`NamedInquiryExecutor` exposes exactly seven operations over an existing `AnalyticalSession`:

- roof age;
- potential water-view candidates;
- ownership age;
- regional owners;
- transit walkability;
- Starbucks walkability; and
- transparent combined-review ranking.

The executor accepts structured values only. Every operation selects one fixed statement from the
allowlisted planner in `packages/query-core/src/inquiries/plans.ts`. Callers cannot provide SQL,
relations, columns, expressions, functions, files, object keys, paths, URLs, hosts, extensions, or
resource settings. Values such as city, postal code, property ID, thresholds, ranking weights, and
cursor keys are DuckDB parameters; they are never interpolated into a statement.

Plans read only the fixed `property_query` and `property_evidence` relations through the existing
`AnalyticalSession` port. They have a five-second timeout, a 512 MiB immutable scan estimate bound,
and at most 101 fetched rows so a page of at most 100 results can determine whether another page
exists. The serialized response is capped at 1 MiB. The hosting API/MCP layers may impose tighter
bounds.

### Immutable release binding

Construction validates and copies the complete release context:

- schema, release, run, manifest CID, as-of, and policy versions;
- terminal capability state for every inquiry;
- capability numerator, denominator, supported classes, and limitations; and
- one complete, unique, bounded ranking-weight policy.

Every request must repeat the exact immutable `releaseId`. A supplied `asOf` must exactly equal the
release as-of value. Every response repeats the release/run/manifest/as-of/policy metadata and the
applicable capability. A blocked capability returns no positive rows and does not execute a query.
Contradictory metadata, such as a blocked capability claiming supported evidence or a supported
capability omitting the `supported` result class, is rejected. A returned row whose support class
is absent from the immutable capability is also rejected before serialization.

Inputs reject additional properties and enforce these core bounds:

- page size `1..100`;
- cursor at most 512 UTF-8 bytes;
- bounded identifiers and filters with control characters rejected;
- age thresholds `1..200` years;
- water distance `1..20,000` metres;
- walk distance `1..10,000` metres;
- ranking weights `0..100`, proxy multipliers `0..1`, and evidence coverage `0..1`.

Cursors contain only the inquiry, release ID, a SHA-256 fingerprint of the canonical normalized
request, and deterministic keyset sort keys. The fingerprint binds filters, thresholds, proxy
selection, page size, and, for combined ranking, the selected criteria, effective weights, and
minimum evidence coverage. It is not caller-provided authority. Cursors are base64url encoded and
protected by HMAC-SHA-256 using an injected secret of at least 32 bytes. Tampered, oversized,
cross-inquiry, stale-release, and cross-query cursors fail closed. The six inquiries sort by
`property_id ASC`; combined ranking sorts by `score DESC, property_id ASC`.

### Evidence semantics

A positive result must have matching public `property_evidence` of the same feature and support
class. Combined positive components are checked individually. Evidence later than the immutable
release as-of is rejected. Results preserve evidence ID, support class, confidence, as-of,
algorithm/version, value, source IDs, and limitations. Non-public evidence is not returned.

- Strict roof results require the materialized `supported` class. Proxy rows appear only when the
  caller explicitly enables them. The feature pipeline remains responsible for ensuring strict
  support means conclusive completed/finaled roof work rather than permit issuance or building age.
- Water results are always `water_view_candidate`; `actualViewProven` is always `false` because
  mapped water and terrain do not prove a real building view.
- Ownership-age results require supported evidence and a verified exchange date. Missing or blocked
  history never establishes “no exchange.”
- Regional-owner results require supported coarse policy evidence and never expose raw owner
  identity.
- Transit and Starbucks strict results require supported network-distance evidence. Explicit proxy
  inclusion is separate.

Combined ranking uses the six fixed release criteria and fixed default thresholds: roof age over 15
years, water distance at most 5,000 metres, ownership age over 10 years, a supported regional-owner
flag, and transit/Starbucks network distance at most 800 metres. Selected supported components
contribute their declared weight; selected proxy components contribute `weight * proxyMultiplier`;
unknown/unsupported components contribute zero. Score is the contribution sum divided by selected
weight, and evidence coverage is the weight represented by supported/proxy components divided by
selected weight. Each result exposes every component and contribution. No model creates or changes
the score.

## Canonical per-property JSON

`buildCanonicalPropertyJson` requires an injected public projection policy. The property identifier
must be explicitly included in a non-empty approved top-level field list. Unapproved source fields
are not copied. Approved fields must exist on every input record.

The public projection fails closed when an approved field, or any nested object/array key under an
approved field, represents prohibited owner identity, owner mailing/contact information,
grantor/grantee details, permit-applicant details, FBN registrant/residence and party
identifier/address details, SOS officer/agent residential addresses, protected addresses, SSN/date
of birth fields, direct email/phone/contact details, or a policy-injected prohibited name. Matching
normalizes case and punctuation so variants such as `owner_name`, `Owner-Name`, nested
`OwnerMailingAddress`, and `Social-Security_Number` cannot bypass the check. These conservative
name checks supplement, but do not replace, the injected exact approved allowlist or the required
full-byte release scanners. Non-identifying fields such as an approved coarse `regional_owner` flag
remain possible.

JSON values reject `undefined`, non-finite numbers, functions, symbols, and other non-JSON values.
Objects use bytewise UTF-8 key order, negative zero becomes zero, output is UTF-8 with exactly one
trailing LF, and no generated timestamp is inserted. Records are sorted by property ID. Each object
receives a deterministic path:

```text
properties/<sha256-prefix>/<base64url-property-id>.json
```

The result records the exact byte length and SHA-256 for every object.

## Deterministic UnixFS CAR shards

`buildPropertyCarRelease` assigns properties to SHA-256 prefix shards. A prefix is extended until
the configured maximum property count is satisfied. Every completed shard must also fit the
configured byte ceiling; the default is 4 GiB and an oversized build fails rather than silently
loosening the bound.

The frozen profile is CIDv1, DAG-PB, SHA2-256, UnixFS inline file nodes, and CARv1. Directory links,
file blocks, shards, index rows, and source inputs have deterministic ordering. The root index maps
every eligible property ID to:

- its immutable logical path;
- JSON SHA-256 and byte length;
- shard prefix and root CID; and
- independently addressable file CID.

The index also binds the eligible-property denominator, shard denominator, count/byte ceilings, and
each shard's root CID, SHA-256, bytes, and property count. Reversing source input order produces the
same JSON bytes, root-index bytes/hash, shard bytes, and CIDs.

`verifyPropertyCarRelease` is networkless. It verifies the root-index bytes/hash and all count and
metadata parity, shard SHA-256 and bounds, every CAR block CID, root CID, file CID, CAR record
length/range, extracted payload bytes, per-property SHA-256, uniqueness, and complete
source/index/shard membership. It also parses the pinned DAG-PB/UnixFS directory profile and walks
every indexed logical path from the declared shard root through intermediate links to the declared
file CID. An otherwise valid but unlinked file block fails closed. `readCarRange` serves only
validated in-bounds byte ranges. Corrupt bytes, CIDs, links, ranges, counts, hashes, or index
metadata fail closed.

## Local verification

Use the repository-pinned toolchain explicitly from PowerShell:

```powershell
$env:PATH = 'E:\nvm\v22.18.0;' + $env:PATH
node --version
corepack pnpm --version
corepack pnpm --filter @oracle/query-core lint
corepack pnpm --filter @oracle/query-core typecheck
corepack pnpm --filter @oracle/query-core test
corepack pnpm --filter @oracle/query-core build
corepack pnpm --filter @oracle/artifacts lint
corepack pnpm --filter @oracle/artifacts typecheck
corepack pnpm --filter @oracle/artifacts test
corepack pnpm --filter @oracle/artifacts build
corepack pnpm --filter @oracle/testkit lint
corepack pnpm --filter @oracle/testkit typecheck
corepack pnpm --filter @oracle/testkit test
corepack pnpm --filter @oracle/testkit build
```

The query-core integration suite creates real native DuckDB tables and executes all six inquiry
goldens plus combined ranking through `DuckDBAnalyticalRuntime`. It also covers blocked ownership,
absence semantics, parameterization, simple and combined pagination, tampered/stale/oversized and
cross-query cursors, invalid bounds, capability/result parity, evidence class/time parity, corrupt
evidence, and response limits. The artifact suite covers input-order rebuild parity, independent
addressability, root-to-file DAG reachability, range verification, public-field policy, count/byte
bounds, root-index parity, and corruption.

## Explicit non-publication scope

These modules only construct and verify local immutable bytes. They do not access credentials or
make network/provider calls. They do not upload CARs, publish or pin a CID, update or resolve IPNS,
write Filebase/S3 objects, or assert gateway, quota, retention, or public availability. Final public
publication remains separately gated on source rights, the approved exact public allowlist, scanning
of the complete immutable release byte set, account/quota checks, and explicit human approval.
