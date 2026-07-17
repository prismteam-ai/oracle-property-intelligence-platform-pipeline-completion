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

The current orchestration implementation materializes acquired source bytes and normalized mutations in memory before global reconciliation. A live uncapped run on 2026-07-17 preserved roughly 119.8 MB of immutable artifacts/checkpoints, then reached Node's heap limit near 4.14 GB during concurrent parcel/San Jose processing before `build_marts`. Treat that run as resumable resource-blocker evidence, not a full release. Do not blindly raise the heap and resume: complete full execution requires a bounded streaming/spill architecture for decode, normalization, and global reconciliation.

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

The canonical mutations currently provide property and permit inputs sufficient for roof evidence only. Transit distance, pedestrian walk time, shoreline/hydrography distance, elevation-derived visibility, and Starbucks proximity remain `unknown`/`null` in the portable property mart until the canonical composition supplies property coordinates plus graph/raster/service topology. Acquiring those sources does not by itself justify a supported feature value.

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

CA SOS requires an operator-frozen bulk artifact URL, source-as-of instant, expected SHA-256, expected record count, source version, encoding, and source-lock contract. OSM requires a dated extract URL with exact SHA-256 and a workspace-relative decoder module exporting `decoder` or `createDecoder()`. Absolute decoder paths and relative paths that escape the resolved workspace are rejected before import.

## Identities, checkpoints, and release handoff

Each lane has two identities:

- `intentId` deterministically binds the source contract and secret-free configuration. It does not incorporate wall-clock execution time.
- `observedContentId` is created after acquisition from the ordered artifact SHA-256 values, schema fingerprints, and source-as-of evidence. Discovery-only and blocked lanes have no observed-content identity.

Multi-artifact schema identity binds the complete sorted unique schema-hash set. Coverage compares accepted and quarantined records with the configured or discovered denominator; a bounded pilot cannot report complete when it loaded only part of that denominator.

Checkpoints and immutable artifacts are stored below the chosen output directory. Re-running the identical command resumes durable phases and returns an already completed immutable manifest without replay. If a source blocks, its terminal state, stable error code, limitations, and checkpoint remain available while other lanes continue.

The `build_marts` artifact contains `portableReleaseInput`, including all 15 capability states. The public profile contains only redacted `source_coverage` and `pipeline_runs` capability metadata. Property query and evidence rows are restricted. Missing 511 configuration is preserved as `not_configured`; blocked ownership and FBN capability states remain explicit. Feed that input to the portable release bridge with a new output directory under `.cache/oracle-real-county/`. The bridge performs license/privacy checks, deterministic manifest generation, Parquet verification, public/restricted segregation, and clean DuckDB reopen/parity checks. It does not publish or update IPFS/IPNS pointers.

Public IPFS publication is a separate human-gated operation and is outside this runbook.

## Accepted local execution evidence

The accepted final-code discovery is `d6` under `.cache/oracle-real-county/d6/`, with its redacted manifest at `.cache/oracle-real-county/d6.manifest.json`. Run `sc:run:56055288d08642026bece5a640dd6bf0feca0951d53037b168b5e51514bffeaa` was requested at `2026-07-17T21:39:58.389Z` and completed at `2026-07-17T21:40:18.467Z`. It is `partial`/`not_applicable` with the exact 14 required capabilities: 10 discovery-complete and 4 blocked, with zero acquired, accepted, or quarantined records and no marts. `d5` is immutable but superseded because its operator-supplied request timestamp was invalid.

The accepted final-code bounded pilot is `p7` under `.cache/oracle-real-county/`, run ID `sc:run:ba8503d4c26d2831b3184f1cb283ce5568ca3f2b43194e228fb766531167be6a`. It is a `partial`/`not_applicable` pilot with the exact 14 required capability inventory, 253 accepted records, zero quarantines, and the correct 3DHP denominator of 56,873. VTA, Caltrain, and NOAA shoreline reached `complete`; parcels, San Jose permits, Palo Alto year-built, 3DHP, elevation, Overture, and CSLB remained bounded partial; CA SOS, OSM, ownership transfers, and FBN remained blocked. The accepted mart SHA-256 is `267c50fc264175206965de6bd0654a7a6f8c079b80c6eaba196807193592ff5d`.

`p5` is immutable but superseded because its 30-second live NOAA request timed out before acquisition. `p6` is immutable but superseded because its operator-supplied `requestedAt` was later than its wall-clock completion. `p7` used the same pilot item/record bounds with a secret-free 120-second request timeout. Its requested instant, `2026-07-17T21:29:36.037Z`, precedes its completion at `2026-07-17T21:30:33.928Z`. The NOAA lane completed with 50 accepted records and the same source aggregate hash proven in `p6`. The exact previously preserved NOAA archive also passed the corrected strict CRS decoder with 1,880 unique clipped features.

The uncapped `f1` evidence remains the terminal full-run resource result: it ended before `build_marts` with a fatal Node heap OOM near 4.14 GB. It has no full mart, portable release, or county-completion claim.
