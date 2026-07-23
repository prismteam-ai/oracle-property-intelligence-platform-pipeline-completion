# Real Santa Clara County portable release

This lane turns already normalized, reconciled, and feature-composed serving rows into an immutable
portable release. It does not acquire source data, infer missing facts, publish IPFS/IPNS, update a
pointer, or turn a blocked capability into a successful one.

The production entry point is `buildRealCountyReleaseBundle` in
`packages/data-runtime/src/serving/real-county-release.ts`. The pipeline owns source execution and
mart composition. This boundary owns physical public/restricted separation, Parquet and DuckDB
materialization, deterministic manifests, release gates, clean reopen/parity, and redacted evidence.

## Truthful release scopes

Every build declares exactly one scope:

| Scope                | Meaning                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `evaluator_evidence` | Safe release-mechanics evidence; never production county data.                                                              |
| `pilot`              | Bounded real-source run; never county completion.                                                                           |
| `partial_county`     | Uncapped work may be present, but at least one county capability remains partial, blocked, failed, or otherwise incomplete. |
| `full_county`        | A guarded claim allowed only when every required capability succeeds and all 16 Santa Clara permit authorities are covered. |

The 511 fallback may be `not_configured` when both direct VTA and Caltrain feeds succeed. Every other
currently implemented or explicitly blocked lane must have one terminal state:

- Santa Clara parcels;
- San Jose permits;
- Palo Alto/MTC year built;
- direct VTA and Caltrain GTFS, plus the separately labeled 511 fallback;
- OSM pedestrian graph;
- NOAA shoreline and USGS hydrography/elevation;
- Overture Starbucks candidates;
- CSLB contractors;
- California SOS businesses;
- ownership/recorded transfers; and
- Santa Clara fictitious business names.

`full_county` fails before writing if a required lane is partial/blocked/failed, if a lane is omitted,
or if permit-authority coverage is below `16/16`. This prevents a parcel-only or San-Jose-only run
from acquiring a county-completion label. A blocked ownership or FBN route must have a public-safe
coverage row with a null denominator, zero observed rows, `unknown`/`unsupported` support, and an
explicit limitation.

## Pipeline handoff

The pipeline supplies:

1. `PortableServingBuildInput`-compatible public and restricted relation rows;
2. exact source/snapshot IDs, source snapshot aggregate SHA-256 binding the ordered constituent
   artifact byte hashes, source-schema SHA-256, source as-of, and terminal state;
3. acquisition, restricted-private-use, public-projection, personal-data, and public capability-
   metadata decisions for each snapshot;
4. one artifact policy per supplied relation, including direct/derived lineage, content class, and
   limitations;
5. all 15 capability states and the measured permit-authority numerator; and
6. one source-coverage row for every declared source.

`buildRealCountyReleaseFromPipelineArtifact(martArtifactPath, outputDirectory)` consumes the
pipeline's exact `oracle-real-county-portable-release-input-v1` mart artifact and refuses any other
format. This is the operator path used to materialize an ignored `.cache/oracle-real-county/`
bundle without copying source payloads through stdout or an ad hoc conversion file.

The bridge rejects source coverage whose hashes/as-of do not bind to a declared snapshot. Public
source or derived data requires an explicit `publicProjectionPermission: allowed`; anonymous public
readability is not sufficient. Restricted source data requires approved acquisition and private use.
Capability metadata can be public only through its separate explicit gate.

If an owner-bearing source contributes a minimized public derivative, the same snapshot must also
contribute a restricted comparison artifact. Raw owner-bearing source rows can never be public.

## Immutable output

The destination must not exist. The builder writes into a private sibling staging directory,
verifies the complete set, and atomically renames it into place. Failure removes only that owned
staging directory. Existing releases are never overwritten.

The release root is a controlled mixed-visibility operator bundle because it contains the
`restricted/` subtree. **The bundle root is never a public distributable.** Only individually
verified artifacts under `public/` may be considered for later public projection, and even those
remain unpublished until the separate whole-byte privacy/license scan and human publication gates
pass. Never upload, pin, mirror, or expose the root or the restricted DuckDB catalog.

```text
<release-root>/
  release-manifest.json
  release-evidence.json
  public/
    *.parquet
    data-dictionary.parquet
    oracle-public.duckdb
  restricted/
    *.parquet
    data-dictionary.parquet
    oracle-restricted.duckdb
```

Parquet is the deterministic portable source of truth. Each DuckDB file is a physically separate,
immutable evaluator catalog materialized from exactly one visibility profile. The restricted-only
37-column Elephant compatibility relation cannot enter the public profile.

`release-manifest.json` is canonical UTF-8 JSON with a trailing LF and the existing portable
manifest `1.0.0` shape. It binds every Parquet path, visibility, grain, ordered schema, non-null
counts, row count, byte size, SHA-256, source/snapshot lineage, limitations, DuckDB version, release,
run, county, state, and generated/as-of instant. Its self-hash is calculated over the canonical
payload without the self-hash field, matching the existing artifact manifest contract.

`release-evidence.json` is separately canonical and self-hashed. It records only evaluator-safe
metadata: release scope, completion-claim boolean, permit-authority fraction, terminal capability
states, artifact/catalog hashes and counts, and pass/fail gate summaries. It contains no source
payload, owner value, credential, raw private record, or public pointer.

## Gates and verification

Promotion requires all of these checks inside the atomic staging boundary:

1. exact capability inventory and truthful completion scope;
2. exact source-snapshot/hash/as-of coverage binding;
3. artifact-level acquisition, license, private-use, and public-projection approval;
4. deterministic row/schema/grain/non-null validation;
5. Parquet `PAR1` boundaries, SHA-256, size, schema, counts, and public JSON-key checks;
6. separate public/restricted catalogs with no restricted-only public relation;
7. persistent DuckDB close/reopen plus row-count and row-checksum parity against Parquet;
8. restricted owner/contact value hashing and comparison against every public scalar and JSON leaf;
9. canonical manifest and evidence self-hashes; and
10. a second clean verification of every immutable file before atomic promotion.

The privacy comparison retains only SHA-256 values and counts. Errors report a count, never the
matching owner/private value. The public/restricted test seeds an owner value into an innocently
named public column to prove that schema-only scanning is insufficient and the value-overlap gate
fails closed.

`verifyRealCountyReleaseBundle(releaseRoot)` reopens a promoted bundle, enforces the exact two
catalog paths and every canonical Parquet path inside the root, verifies both canonical documents
and every Parquet/DuckDB hash, reopens both DuckDB catalogs, compares their exact table
inventories/schemas/row checksums against Parquet, and runs the privacy intersection again. It
returns only release/run IDs, scope, manifest/evidence hashes, visibility counts, and a zero public
owner-value count.

## Accepted live pilot evidence

The final accepted `p7` pilot completed on 2026-07-17 and its approved mart body had SHA-256
`267c50fc264175206965de6bd0654a7a6f8c079b80c6eaba196807193592ff5d`. The immutable bridge
materialized and then independently reopened this ignored local bundle:

```text
.cache/oracle-real-county/p7-portable-release/
```

The redacted verification result is:

- release ID: `santa-clara-7e1dc2a9148295a2a1ffdeaa`;
- run ID: `sc:run:ba8503d4c26d2831b3184f1cb283ce5568ca3f2b43194e228fb766531167be6a`;
- scope: `pilot`, with no county-completion claim and permit coverage `1/16`;
- manifest self-hash:
  `230a6f32efbc4ad9c27ad8f9f2d9b30aa0c415c317c523f9d9de5ee156faa4c5`;
- evidence self-hash:
  `bb54aeb7768e05a7dd416e5096c59b5035b6d3e4bafab455626d1a4408cc11d4`;
- 253 accepted and zero quarantined records, with all 14 required sources represented and 3
  complete;
- three public Parquet artifacts with 43 aggregate rows and three restricted Parquet artifacts
  with 242 aggregate rows;
- 15 capability states: 3 succeeded, 7 partial, 4 blocked, and 1 not configured; and
- zero public owner-value overlaps, zero prohibited public schema columns, and zero detected secret
  patterns.

Both catalog files passed a fresh-process reopen and exact table/schema/row-checksum parity check.
The exact per-artifact, per-catalog, and source snapshot aggregate hashes and redacted coverage
counts remain in `release-manifest.json`, `release-evidence.json`, and
`public/source-coverage.parquet` inside that local bundle. Descriptive limitation text contains the
phrase “mailing address” for blocked owner-bearing capabilities; it does not contain an address or
owner value. Ownership and FBN source rows were not acquired, so the bundle's restricted sensitive-
value comparison set is empty rather than evidence that private owner rows were published.
NOAA completed with 50 accepted records after the adapter correction. The earlier `p6` bundle
remains immutable but is superseded because its operator timestamp was invalid.

The accepted orchestration evidence records requested/completed times
`2026-07-17T21:29:36.037Z` and `2026-07-17T21:30:33.928Z`. The portable `pipeline_runs` row records
started/completed times `2026-07-17T21:29:36.037Z` and `2026-07-17T21:30:33.863Z`. Both pairs are
strictly ordered; retain the small boundary-layer timestamp difference rather than rewriting it.

This path is local evaluator evidence only. It contains a `restricted/` subtree and must not be
copied, uploaded, pinned, or treated as a public release.

## Owner-free p8 public serving closure

The accepted p7 San Jose ACTIVE permit snapshot is CC0-1.0 and contains 34 non-null APN
observations across 50 accepted rows, representing 19 distinct APNs. The fixed
`buildOwnerFreePublicServingRelease` projection publishes only those APNs, deterministic
county-scoped property IDs, and explicit lineage. It publishes no address, coordinate, owner,
applicant, contractor, contact, raw payload, or positive criterion fact.

The full local verification bundle is ignored at
`.cache/oracle-real-county/p8-public-serving-verification/`. It contains 19 public
`property_query` rows, 114 public `property_evidence` rows (six unknown/unsupported criteria per
property), 40 `field_coverage` rows, eight `relation_coverage` rows, 14 `source_coverage` rows, one
`pipeline_runs` row, and the generated 83-row dictionary. Its restricted comparison contains 107
observations and 61 distinct sensitive-value hashes; public overlap is zero.

The deployment closure is ignored at `.cache/oracle-real-county/p8-public-serving/` and contains
exactly `release-manifest.json`, `serving-config.json`, and the seven public Parquet files. The
public-only manifest self-hash is
`29b424b88d9a63cd852dc9bbf1dd9c91d46bc8f024005c3dedca63b46376b7ba`, its file SHA-256 is
`df24a663efb3c1c4b32923a53b6052ce5d5f6e9bd56fadf164c2165b41e9d8e2`, and its reproducible
CIDv1/raw/sha2-256 is `bafkreig7estgh35tyhclgkjduu5wauwolvpw5g6vn6w7czgccznud2oy4i`.
The closure has no restricted directory, evidence sidecar, DuckDB catalog, checkpoint, credential,
or extra file. County completion remains false. Computing this CID did not publish or upload the
manifest; publication and deployment remain separate authorized promotion actions.

## Uncapped profile outcome

The `f1` uncapped run terminated before `build_marts` after 285.5 seconds with a Node fatal heap
out-of-memory condition near 4.14 GB. It therefore produced no accepted mart and no
`partial_county` or `full_county` portable bundle. Its resumable 47-file, approximately 119.8 MB
checkpoint/artifact evidence remains under `.cache/oracle-real-county/f1/`.

Do not relabel the pilot bundle as county completion. A blind larger-heap resume is not an accepted
remedy. Incomplete orchestration-v1 checkpoints, including `f1`, still fail with
`LEGACY_INCOMPLETE_CHECKPOINT` before reacquisition.

Superseded as of 2026-07-21: the bounded reconciliation/feature/mart replacement is now composed
and is what production profiles execute, so the `full` profile no longer stops before that phase
for want of a bounded processor. The `UNBOUNDED_COUNTY_PHASE` guard is retained against a
mis-composed runtime. This removes a resource blocker only. It does not produce, and must not be
read as producing, a `partial_county` or `full_county` bundle: no such bundle exists.

The 2026-07-18 streaming foundation adds verified logical-key orphan recovery, bounded acquired
artifact readers, per-yield durable acquisition replay, fresh-process finalization, one shared
record/event permit budget, deterministic canonical chunk spill, and typed rejection of incomplete
v1 checkpoints before reacquisition. Its full generated streaming-v2 runner stress completed
1,000,000 decoded, normalized, and bounded-reconciliation-consumed mutations under a 512 MiB heap.
The combined high-water equaled the configured 1,000 permits (active records 1, buffered events
999), both current counters returned to zero, and peak V8 heap was 67,765,976 bytes. Its projected
logical SHA-256 was `3c4381a7677cacc314aec5ab3ad489c46afd41cc5ff0365759d5d33cca195ffb`.
This foundation does not alter, regenerate, or supersede p8. The accepted p8 manifest hashes,
CID, row counts, privacy result, partial-pilot label, and no-county-completion result above remain
exactly unchanged — including by the 2026-07-21 bounded-run fixes, which changed enforcement
ceilings, query shape, and routing but no accepted artifact.

## Pending bounded release

A bounded `pilot` run (requested-at `2026-07-19T12:00:00.000Z`, output `.cache/oracle-demo-bounded`)
is executing at the time of writing. It is a bounded pilot: its scope can only be `pilot`, its
completion claim is false, and it cannot be labelled `partial_county` or `full_county`.

The bounded `pilot` run reached a terminal `partial` status and produced a verified
`partial_county` release bundle. Every value below is copied from `release-manifest.json` and
`release-evidence.json`:

- release ID: `santa-clara-fcb0238187938111e15bb86e`
- run ID: `sc:run:327bb527f12e3916cb9e9333c358c2202d694647a3977f7721a2369606d5dad4`
- generation ID: `sc:generation:a337fba4fce92a42f03c4f5726e4ec2b50cdbaaf067035039a8bff2c53b9683f`
- manifest self-hash: `569a8634c2f74c8e45e2ff1187a93470792ae9d6bb32697555a0f42afe3cad5f`
- evidence self-hash: `5cd01733b213777b886f71a1a4dff331faaa3bd2cefb8d8ce77f08b3e5718ff5`
- accepted / quarantined record counts: 19,147 accepted, 6 quarantined
- capability state tally and permit-authority fraction: 3 succeeded / 6 partial / 5 blocked / 1 not_configured (15 capabilities, zero failed); permit-authority coverage 0 of 16 (San Jose permits are partial and jurisdiction-scoped to the City of San Jose, so no property in the pilot slice has an established permit authority)
- public / restricted artifact and row counts: 7 public relations (property_query 5,000; property_evidence 30,000; data_dictionary 85; field_coverage 27; relation_coverage 9; source_coverage 6; pipeline_runs 1) and 7 restricted relations (property_query 8,940; property_evidence 53,640; data_dictionary 85; field_coverage 27; relation_coverage 9; source_coverage 14; pipeline_runs 1). All release gates passed (license, manifest, parquet, clean-reopen, public/restricted segregation); owner-bearing public values 0; public/restricted value overlap 0.

Nothing here is published. Public IPFS publication, Filebase upload, IPNS mutation, and deployment
remain separate human-gated actions outside this code, and no CID recorded in this document has
been published or pinned.

## Reproducible verification

Use the pinned Node runtime:

```powershell
$env:PATH='E:\nvm\v22.18.0;' + $env:PATH
node --version
pnpm --filter @oracle/data-runtime lint
pnpm --filter @oracle/data-runtime typecheck
pnpm --filter @oracle/data-runtime test
pnpm --filter @oracle/data-runtime build
```

The focused suite builds two unrelated release roots and compares manifests, evidence, every
Parquet byte, and both DuckDB catalog bytes. It also proves immutable destination denial,
full-county overclaim denial, license denial, owner-value leakage denial without value disclosure,
self-consistently rehashed Parquet/catalog path-escape denial, catalog parity-tamper denial, and
clean promoted-bundle verification.

Real or private outputs belong only under ignored `.cache/oracle-real-county/`. A pilot or partial
bundle must retain that label in `release-evidence.json`. Public IPFS publication, Filebase upload,
IPNS mutation, deployment, and any other third-party effect remain outside this code and require
their separate human gates.
