# Real Santa Clara County pipeline run

The production CLI composes the implemented Santa Clara source lanes into one resumable run. It performs live discovery, immutable acquisition, adapter validation and normalization, canonical reduction, reconciliation, the currently supported roof evidence derivation, and a portable-release input mart. It does not publish IPFS/IPNS, update a pointer, deploy, or mutate a source system.

Fixture mode is a deterministic test of a committed parcel excerpt. It is never production evidence and cannot run the `full` profile.

## Runtime and storage

Use Node `22.18.0`. Keep all real-county outputs under the ignored `.cache/oracle-real-county/` tree. CLI stdout is a redacted run manifest containing source IDs, counts, hashes, capability states, timings, and limitations; it does not contain source rows or owner-bearing records.

```powershell
$repo = 'E:\Coding\Soofi\oracle-property-intelligence-platform-pipeline-completion'
$evidence = Join-Path $repo '.cache\oracle-real-county'
Set-Location $repo

pnpm --filter @oracle/pipeline build
node apps/pipeline/dist/cli.js discovery `
  --requested-at 2026-07-17T13:00:00.000Z `
  --workspace $repo `
  --output (Join-Path $evidence 'discovery')

node apps/pipeline/dist/cli.js pilot `
  --requested-at 2026-07-17T13:05:00.000Z `
  --workspace $repo `
  --output (Join-Path $evidence 'pilot')
```

Use a new canonical ISO-8601 `--requested-at` value for a logically new run. Reuse the same value, profile, source config, and output directory to resume an interrupted run. A changed configuration cannot resume under the old deterministic run ID.

Do not start the uncapped run until discovery and the bounded pilot have established that configured source locks, byte ceilings, authentication indirection, and local resources are valid:

```powershell
node apps/pipeline/dist/cli.js full `
  --requested-at 2026-07-17T14:00:00.000Z `
  --source-config (Join-Path $evidence 'source-config.json') `
  --workspace $repo `
  --output (Join-Path $evidence 'full')
```

`full` means uncapped acquisition, not an automatic county-completion claim. A full configuration is rejected unless its required capability set exactly matches the 14 production lanes in this runbook; 511 remains optional. The manifest claims county completion only when that complete inventory reaches `complete`. A missing, unexpected, blocked, failed, partial, or discovery-only required lane makes the run partial, blocked, or ineligible. San Jose permit coverage is one city authority and is not countywide permit coverage.

Historic, superseded: the orchestration implementation used to materialize acquired source bytes and normalized mutations in memory before global reconciliation. A live uncapped run on 2026-07-17 (`f1`) preserved roughly 119.8 MB of immutable artifacts/checkpoints, then reached Node's heap limit near 4.14 GB during concurrent parcel/San Jose processing before `build_marts`. That run remains resumable resource-blocker evidence, not a full release. The in-memory path is no longer what `pilot`, `full`, or `incremental` execute: `usesBoundedPipelineProcessors` (`apps/pipeline/src/commands/run.ts:829-831`) selects the `bounded_streaming_v2` processors for every non-fixture production profile, and the in-memory `small_run_only_v1` processors are now reached only by the fixture pilot. Bounded execution has its own resource ceilings; see "Operator execution ceilings" below.

### Operator execution ceilings

Bounded compute stages enforce a single budget object validated as a set by `boundedProcessingBudgetSchema` (`maxBufferedBytes + duckdbMemoryBytes + runtimeReserveBytes <= maxRssBytes`). Two operator overrides raise only the enforcement ceilings — they do not enter policy objects, policy hashes, or generation identity, so an overridden run produces the same generation identity as a default run:

- `ORACLE_PIPELINE_DUCKDB_MEMORY_BYTES`
- `ORACLE_PIPELINE_MAX_RSS_BYTES`

Raise them together. Raising the DuckDB ceiling alone does not help and actively guarantees failure, because DuckDB allocation counts toward process RSS: a run configured that way aborted `reduce_canonical` after 112 minutes at 1138 MB RSS. Both now flow through `applyOperatorCeilings()` and an unbalanced pair is rejected at startup in under a second rather than mid-compute. Evidence records continue to report the true observed DuckDB-memory and process-RSS peaks.

## Profile semantics

| Profile       | Network behavior                                                                             | Record/item bounds                                                                                               | County claim                        |
| ------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `discovery`   | Probes each official source contract; no acquisition or normalization                        | No records loaded                                                                                                | Never                               |
| `pilot`       | Executes small/pageable sources; large sources are discovery-only unless explicitly opted in | 50 accepted records by default; one planned item for parcels, permits, Palo Alto, shoreline, 3DHP, and elevation | Never                               |
| `full`        | Executes every configured lane                                                               | No pipeline record cap and no acquisition-item cap                                                               | Only if all required lanes complete |
| `incremental` | Uses adapter incremental mode where supported                                                | No pilot cap                                                                                                     | Never                               |

The 3DHP pilot plans only its first page. Therefore a successful first-page load remains `partial` against the discovered multi-page denominator. NOAA shoreline and USGS elevation are single-item products whose adapters enforce frozen byte ceilings.

Overture, CSLB, configured CA SOS bulk data, and configured OSM are discovery-only in the default pilot because their normal artifacts are large. Add the exact source ID to `pilot.includeLargeSources` only after reviewing the frozen contract and local capacity.

## Source composition and truthful limits

| Capability                    | Default production composition                                               | Important limit                                                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Santa Clara parcels           | Live county Socrata adapter                                                  | Parcel rows are not owner or transfer evidence                                                                                            |
| San Jose permits              | Live city feed registry                                                      | One city, not all 16 county permit authorities                                                                                            |
| Palo Alto/MTC year-built      | Live named-subset adapter                                                    | Palo Alto subset is not the county denominator                                                                                            |
| VTA and Caltrain GTFS         | Direct operator feeds pinned to expected archive hashes                      | Feed drift fails closed                                                                                                                   |
| 511 fallback                  | Added only when frozen feed entries are configured                           | Absence is explicitly `not_configured`; it does not weaken direct feeds                                                                   |
| OSM pedestrian graph          | Live only with a dated SHA-256-pinned extract and injected streaming decoder | Default state is blocked; no PBF hash or graph is fabricated                                                                              |
| NOAA/USGS water and elevation | Shoreline, 3DHP hydrography, and elevation adapters                          | Source acquisition is composed; distance/visibility features remain unknown until graph/raster geometry is joined to canonical properties |
| Overture Starbucks            | Frozen Parquet fragment and DuckDB adapter                                   | Candidate place matches are not proof a store is open; walk features require the pedestrian graph and property coordinates                |
| CSLB contractors              | Live/frozen CSLB bulk adapter                                                | License presence is not quality evidence                                                                                                  |
| CA SOS businesses             | Operator-frozen bulk artifact only                                           | Default state is blocked; CAPTCHA search is not scraped and business entities do not establish beneficial ownership                       |
| Ownership transfers           | Capability adapter                                                           | Official access is currently blocked; no no-transfer or owner-region fact is inferred                                                     |
| Santa Clara FBN               | Capability adapter                                                           | Public bulk acquisition is currently blocked and owner-bearing output is prohibited from public release                                   |

The canonical mutations provide property and permit inputs sufficient for roof evidence. Roof evidence is the only criterion that can reach a measured, non-proxy value from the currently composed sources.

Spatial criteria — transit walkability, water view, and Starbucks proximity — are emitted with support class `proxy`, never `measured`. Properties now carry a representative point (a real vertex of the real parcel geometry; before this the spatial join could never match, so every proximity feature was structurally empty), which makes proximity candidate ranking produce rows for the first time. What those rows are is bounded by what is actually configured:

- there is no pedestrian network — the OSM lane is blocked by default — so "walkability" is a coordinate-band proximity proxy, **not** a pedestrian walk time or route distance, and must not be described as one;
- shoreline/hydrography distance and elevation-derived visibility are likewise proxied from candidate proximity, not from raster geometry or a viewshed;
- a Starbucks candidate match is not proof a store is open.

Acquiring those sources does not by itself justify a `measured` feature value, and a proxy value does not become a measured one by being non-null. Consumers see the `proxy` support class on the response and should not upgrade it.

## Source configuration

`--source-config` accepts a JSON document with `schemaVersion: 1`. Omitted sections use conservative defaults. The file may contain public source locks, expected hashes, page sizes, byte ceilings, and names of environment variables. It must not contain API keys, bearer tokens, passwords, signed credential query parameters, URL userinfo, cookies, or credential values.

```json
{
  "schemaVersion": 1,
  "runtime": {
    "maxConcurrentSources": 2,
    "maxBufferedRecords": 50,
    "maximumPhaseAttempts": 2,
    "requestTimeoutMs": 30000
  },
  "pilot": {
    "recordCap": 50,
    "includeLargeSources": []
  },
  "parcels": { "pageSize": 5000 },
  "paloAltoYearBuilt": { "pageSize": 5000 },
  "sanJosePermits": {},
  "waterElevation": {},
  "overture": {},
  "cslb": {},
  "caSos": null,
  "osm": null,
  "fallback511": null
}
```

For a protected 511 fallback URL, configure the frozen `feeds` contract and an `authorization` rule such as `{ "urlPrefix": "https://…", "headerName": "Authorization", "environmentVariable": "ORACLE_511_AUTH" }`. The runtime reads that environment variable only while constructing the outbound request header. The value is not persisted, hashed into the source config, or printed.

Every HTTP request carries the configured `runtime.requestTimeoutMs` abort bound (30 seconds by default). A timeout fails or partially completes only that source lane according to its durable progress; other source workers continue.

CA SOS requires an operator-frozen bulk artifact URL, source-as-of instant, expected SHA-256, expected record count, source version, encoding, and source-lock contract. OSM requires a dated extract URL with exact SHA-256 and a workspace-relative decoder module exporting `decoder` or `createDecoder()`. The module must also export the exact versioned `oracleBoundedOsmDecoderContract` attestation for streaming-v2 input, network prohibition, whole-copy prohibition, deterministic node/way/relation ordering, and enforced blob/tag/reference/member limits. Absolute decoder paths and relative paths that escape the resolved workspace are rejected before import.

## Identities, checkpoints, and release handoff

Each lane has two identities:

- `intentId` deterministically binds the source contract and secret-free configuration. It does not incorporate wall-clock execution time.
- `observedContentId` is created after acquisition from the ordered artifact SHA-256 values, schema fingerprints, and source-as-of evidence. Discovery-only and blocked lanes have no observed-content identity.

Multi-artifact schema identity binds the complete sorted unique schema-hash set. Coverage compares accepted and quarantined records with the configured or discovered denominator; a bounded pilot cannot report complete when it loaded only part of that denominator.

Checkpoints and immutable artifacts are stored below the chosen output directory. Re-running the identical command resumes durable phases and returns an already completed immutable manifest without replay. If a source blocks, its terminal state, stable error code, limitations, and checkpoint remain available while other lanes continue.

The `build_marts` artifact contains `portableReleaseInput`, including all 15 capability states. Its original p7 public profile contains only redacted `source_coverage` and `pipeline_runs` metadata; its original property and evidence rows remain restricted. The fixed p8 recovery path separately derives public property identity only from the frozen CC0 San Jose APN observations. Missing 511 configuration is preserved as `not_configured`; blocked ownership and FBN capability states remain explicit. The portable release bridge performs license/privacy checks, deterministic manifest generation, Parquet verification, public/restricted segregation, and clean DuckDB reopen/parity checks. It does not publish or update IPFS/IPNS pointers.

Public IPFS publication is a separate human-gated operation and is outside this runbook.

## Accepted local execution evidence

The accepted final-code discovery is `d6` under `.cache/oracle-real-county/d6/`, with its redacted manifest at `.cache/oracle-real-county/d6.manifest.json`. Run `sc:run:56055288d08642026bece5a640dd6bf0feca0951d53037b168b5e51514bffeaa` was requested at `2026-07-17T21:39:58.389Z` and completed at `2026-07-17T21:40:18.467Z`. It is `partial`/`not_applicable` with the exact 14 required capabilities: 10 discovery-complete and 4 blocked, with zero acquired, accepted, or quarantined records and no marts. `d5` is immutable but superseded because its operator-supplied request timestamp was invalid.

The accepted final-code bounded pilot is `p7` under `.cache/oracle-real-county/`, run ID `sc:run:ba8503d4c26d2831b3184f1cb283ce5568ca3f2b43194e228fb766531167be6a`. It is a `partial`/`not_applicable` pilot with the exact 14 required capability inventory, 253 accepted records, zero quarantines, and the correct 3DHP denominator of 56,873. VTA, Caltrain, and NOAA shoreline reached `complete`; parcels, San Jose permits, Palo Alto year-built, 3DHP, elevation, Overture, and CSLB remained bounded partial; CA SOS, OSM, ownership transfers, and FBN remained blocked. The accepted mart SHA-256 is `267c50fc264175206965de6bd0654a7a6f8c079b80c6eaba196807193592ff5d`.

`p5` is immutable but superseded because its 30-second live NOAA request timed out before acquisition. `p6` is immutable but superseded because its operator-supplied `requestedAt` was later than its wall-clock completion. `p7` used the same pilot item/record bounds with a secret-free 120-second request timeout. Its requested instant, `2026-07-17T21:29:36.037Z`, precedes its completion at `2026-07-17T21:30:33.928Z`. The NOAA lane completed with 50 accepted records and the same source aggregate hash proven in `p6`. The exact previously preserved NOAA archive also passed the corrected strict CRS decoder with 1,880 unique clipped features.

The uncapped `f1` evidence remains the terminal full-run resource result under the superseded in-memory orchestration: it ended before `build_marts` with a fatal Node heap OOM near 4.14 GB. It has no full mart, portable release, or county-completion claim.

### In-flight bounded demo run

A bounded `pilot` run is executing at the time of writing under the `bounded_streaming_v2` processors:

```text
node apps/pipeline/dist/cli.js pilot \
  --source-config config/source/assessment-pilot-demo.json \
  --requested-at 2026-07-19T12:00:00.000Z \
  --output .cache/oracle-demo-bounded
```

This is a bounded pilot, not an uncapped `full` run, and it cannot produce a county-completion claim regardless of outcome.

The reference run was executed on Windows with a short `--output E:/ora-demo/f` root: the DuckDB
native addon ignores the Windows long-path opt-in, so the documented `.cache/oracle-demo-bounded`
path exceeds MAX_PATH. Every value below is copied from the emitted terminal manifest and release
evidence:

- run ID: `sc:run:74239e2f3c9beb70c4721c618f31d0d7db9cf472cc5e376d4f5f13fcf0ee98c2`
- generation ID: `sc:generation:2c8fb9aff0c40c016817f4eddf66236c7773f000ce9f0117f8f4ddd9bd55a2d8`
- release ID: `santa-clara-70ec78efee5b6c6b664fe8a3`
- terminal run status: `partial` (a bounded pilot cannot reach `succeeded` while required capabilities remain blocked or failed)
- accepted / quarantined record counts: 18,882 accepted, 0 quarantined (the expected-record denominator is `null` — the publisher exposes no independent row-count endpoint)
- per-capability terminal states (15 capabilities): 2 succeeded (`vta_gtfs`, `noaa_shoreline`); 5 partial (`santa_clara_parcels`, `san_jose_permits`, `palo_alto_year_built`, `usgs_hydrography`, `usgs_elevation`); 5 blocked (`ca_sos_businesses`, `cslb_contractors`, `osm_pedestrian_graph`, `ownership_transfers`, `santa_clara_fbn`); 2 failed (`caltrain_gtfs`, `overture_starbucks`); 1 not_configured (`transit_511_fallback`)
- accepted mart SHA-256: `f05a26cb6a47e7abee942dceca92702129fe861b56302fecb791525fb591cd1c` (public `property_query`, 5,000 rows)
- requested / completed instants: requested `2026-07-19T12:00:00.000Z`; completed `2026-07-23T05:22:48.425Z`

## Streaming recovery contract (implementation v2)

The pipeline foundation now freezes source-adapter contract `2.0.0` for county-scale lanes. A v2
adapter returns an acquired-artifact reference containing the exact byte length, SHA-256, raw URI,
and a repeatable bounded async reader. HTTP bodies can be passed directly to
`putImmutableStreaming`, which applies store backpressure while computing size and SHA-256 and
enforcing the adapter's byte ceiling. `headByLogicalKey` verifies confined canonical metadata and
the complete stored hash before a write-before-checkpoint orphan can be adopted; immutable write
conflicts remain errors.

Acquisition progress is committed after every yielded reference as a canonical chunk. On restart,
`acquire()` re-emits the exact deterministic prefix; the runner verifies it byte-for-byte, skips
network writes for that prefix, and appends only new references. Omitted, reordered, or changed
prefixes fail with `ACQUISITION_REPLAY_INCOMPATIBLE`. Finalization receives only repeatable durable
acquired-artifact sources, so a fresh process reconstructs output without adapter-local arrays.
The fetch transport uses manual redirects and rejects every 3xx response instead of silently
crossing an origin or media contract.

Decode, validation, normalization fan-out, and retained canonical events use one process-wide
`maxBufferedRecords` permit pool. An active decoded record holds one permit through validation,
all normalization outputs, and `record_complete`; buffered events use permits from the same pool.
On pressure a writer flushes its prefix, or immediately flushes an event under its active record's
already-counted permit at the boundary of one. The manifest records PII-free active-record,
buffered-event, and combined permit high-waters plus zero-at-completion counters.
Canonical NDJSON chunks bind schema version, logical key, record interval/count, chunk SHA-256,
ordered logical SHA-256, visibility, and license reference. Resume verifies every checkpointed
chunk by logical key and hash, rejects missing/corrupt/duplicate/non-contiguous references, and
adopts only a byte-identical orphan. Each normalization chunk reference atomically records the
PII-free artifact/record/issue/mutation cursor, including a mid-record fan-out offset, so restart
re-decodes only the interrupted logical record and skips already committed outputs. Incomplete
orchestration-v1 checkpoints, including `f1`, fail
with `LEGACY_INCOMPLETE_CHECKPOINT` before reacquisition. A finalized v1 manifest remains readable.
The v1 whole-copy adapter path is retained only for fixtures and reviewed tiny or blocked
capability lanes: each artifact is capped before copying at 1 MiB and each observation sequence at
10,000 values. The nine county-scale production lanes use v2; an over-bound legacy lane fails
without weakening those streaming contracts.

Analytical decode never treats a raw Parquet or ZIP as snapshot-manifest bytes. Snapshot binding
uses a separately stored, versioned derived JSON manifest capped at 1 MiB. The runtime preallocates
only that verified length, validates its SHA-256 and operation scan budgets, and independently
verifies every listed query-data artifact by URI, byte length, and SHA-256 before its confined
physical URI is passed to DuckDB.

The partitioned bounded reducer/linker/feature/mart processor is now composed and is what production
profiles execute. `usesBoundedPipelineProcessors` (`apps/pipeline/src/commands/run.ts:829-831`)
selects `bounded_streaming_v2` for `full`, `incremental`, and non-fixture `pilot`; the
`small_run_only_v1` processor in `default-processors.ts` remains only for the fixture pilot.
`assertCountyProcessorProfile` still refuses a `full` or `incremental` profile backed by
`small_run_only_v1`, failing with `UNBOUNDED_COUNTY_PHASE` before reconciliation. That gate is
retained as a guard against a mis-composed runtime, not as a description of the default path.
Bounded `incremental` is separately fail-closed until existing county artifacts can be verified and
merged (`apps/pipeline/src/orchestration/bounded-processors.ts:287-290`).

Neither of these changes any release claim. A bounded processor makes county-scale execution
possible; it does not make a run complete, and county completion is still asserted only when the
full required capability inventory reaches `complete`.

The full generated streaming-v2 runner stress was run on 2026-07-18 with
`node --max-old-space-size=512`. It completed 1,000,000 decoded records, 1,000,000 normalized
mutations, and 1,000,000 mutations consumed by bounded reconciliation. The configured and combined
permit high-water was 1,000; active-record high-water was 1, buffered-event high-water was 999,
and both counters returned to zero. Peak observed V8 heap was 67,765,976 bytes. The projected
logical SHA-256 was
`3c4381a7677cacc314aec5ab3ad489c46afd41cc5ff0365759d5d33cca195ffb`; source terminal state was
`complete` with coverage ratio 1. Metrics contain only counts, bounds, heap bytes, state, coverage,
and hashes; no source row is logged.

The accepted owner-free serving recovery is `p8-public-serving`. Its verification bundle proves 19
real APN-grain properties, 114 evidence rows, all seven required public relations, zero prohibited
public privacy-key/value overlap, and a 107-row restricted comparison with 61 distinct sensitive
hashes. The final deployment closure contains only a public-only canonical manifest, the frozen
serving configuration, and seven public Parquet files. Its manifest self-hash is
`29b424b88d9a63cd852dc9bbf1dd9c91d46bc8f024005c3dedca63b46376b7ba` and its local raw CIDv1 is
`bafkreig7estgh35tyhclgkjduu5wauwolvpw5g6vn6w7czgccznud2oy4i`. This is still a bounded,
partial San Jose pilot and never a county-completion claim.
