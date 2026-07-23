# Changelog

## 2026-07-21 — Execution ceilings, bounded-run survivability, proximity cost, agent routing, acceptance honesty

Fixes found by running the bounded county pipeline end to end. None of them changes a release
claim: county completion remains false, and the pilot label is unchanged.

- Added the missing `ORACLE_PIPELINE_MAX_RSS_BYTES` operator ceiling. The variable was documented
  in the operator runbook but was never read by the codebase, so compute stages always enforced
  `DEFAULT_BUDGET.maxRssBytes` (512 MiB) while `ORACLE_PIPELINE_DUCKDB_MEMORY_BYTES` raised the
  DuckDB limit at open time, bypassing the budget object. Because DuckDB allocation counts toward
  process RSS, raising the DuckDB ceiling alone guaranteed `reduce_canonical` would abort; a run
  died this way after 112 minutes at 1138 MB RSS. Both overrides now flow through
  `applyOperatorCeilings()` and are validated together by `boundedProcessingBudgetSchema`, so an
  unbalanced pair fails at startup rather than mid-compute. The reducer guard also names which of
  its three limits was exceeded (counts and byte sizes only, never mutation content) (`2e1579f`).
- Widened the reconciliation per-subject lease. It was
  `floor(maxBufferedBytes / maxBufferedRecords)` = 8 KiB, three orders of magnitude below the
  sibling leases in the same file (1 MiB, 8 MiB), which aborted `reconcile_links` on real county
  data while passing on fixtures. Enforcement bound only; subjects that already fit are
  byte-identical (`4042647`).
- Stopped DuckDB temp-directory cleanup from destroying a run result. `removeDuckDbTemporaryDirectory`
  runs both before opening the database and from a teardown `finally` block, and a throw in teardown
  _replaced_ the run outcome — a transient `EBUSY` unlink on a scratch file could discard the
  terminal manifest of a multi-hour run or mask the genuine error. Teardown is now best-effort
  (logs and swallows); the pre-open call deliberately stays strict, because a stale temp directory
  that cannot be removed before work begins is a real problem. The Windows retry budget went from
  5 attempts at 50 ms to 10 at 250 ms, since on-access scanners hold spill files open far longer
  than the former sub-second budget allowed (`9555dbb`).
- Ranked proximity candidates on a narrow projection. The proxy-candidate query selected
  `entity.aggregate_json` inside the ranking window, materialising a full canonical aggregate blob
  for every (property, candidate) pair before `row_number()` picked one winner per property; with
  ~5k properties and a ±0.5 degree band this spilled 182.5 GiB and aborted the run. The window now
  carries only ids and coordinates and joins `canonical_entity` once for the rank-1 winner. Same
  `PARTITION BY`, same distance ordering, same `entity_id` tiebreak, so feature artifacts and
  release hashes are unchanged. This cost was latent, not new: it became reachable only once
  properties had a representative point (`d8c5748`). A related no-op `canonical_entity` join is
  now emitted only for specs that actually have a predicate; cardinality and output are unchanged
  (`1da1633`). The underlying ±0.5 degree (~55 km) prefilter band remains the real cost driver and
  is not fixed here.
- Gave properties a representative point. `representativePoint` was missing `case 'property'`, so
  the spatial join — which resolves a property's point via `coalesce(primaryAddressId, entity_id)` —
  could never match: both property adapters hardcode `primaryAddressId` to null and nothing
  constructs an `address` canonical entity. Every proximity feature was therefore structurally
  empty at any data scale. The point is a real vertex of the real parcel geometry, not a synthesised
  centroid (`4042647`).
- Fixed three agent routing defects, each of which silently returned an empty or half answer for a
  prompt taken verbatim from the assignment demo transcript: `includeProxy` was never emitted on the
  deterministic route, so every walkability and water-view query returned zero rows regardless of
  release contents (spatial criteria are only ever emitted with support class `proxy`, the
  pedestrian network being unconfigured — the response still carries that weaker support class);
  `regional_owner` matched `\bowner\b` and so could not match "regional owners", answering half a
  two-predicate question without signalling the dropped half; and `water_view` did not match its own
  demo prompt "Show properties with a view of water" (`4042647`).
- Stopped the acceptance suite from certifying two defects (`4feb9d4`):
  - The cited-agent-answer test skipped itself on every release it existed to certify. It selected
    criteria with state `supported`, but a criterion only reaches `supported` at 100% field
    coverage, so any real bounded release lands on `partial`, the filter came back empty, and an
    empty filter called `test.skip` — reporting green having proven nothing, while the README lists
    a cited agent answer as a mandatory acceptance proof. It now accepts `partial` (which still
    carries genuine evidence), and an empty result fails rather than skips.
  - `agent.status` returned a hardcoded `available` that touched neither the model nor its
    configuration, so the UI could enable the agent and then fail on `ask`. Status now derives from
    the preconditions `ask` actually depends on, and states in its limitations that it reflects
    configuration readiness rather than model reachability. A live probe per status call was
    rejected deliberately: it would invoke the model on every page load. The production test asserts
    that limitation in both envelope and payload and continues to assert `modelCall === 0`.
- Recorded two rights determinations explicitly rather than flipping flags silently:
  - Santa Clara parcels redistribution. `publicSourceIds` admits a source to a public relation only
    when `redistribution === "approved" && !containsPersonalData`, and the parcels source declared
    `unknown`. Primary-source review found the Socrata metadata for `ubcd-cewv` declares no license
    at all and the county terms chain covers warranty/liability/indemnity only — the terms are
    silent, granting nothing and prohibiting nothing. The operator determined on 2026-07-21 that
    redistribution is acceptable for this time-limited hiring-assessment deliverable; the
    determination is recorded in the license block with its basis and its limits, stating plainly
    that this basis is weaker than the named published instruments (CC0, ODbL, the Caltrain
    Developer License, USGS public-domain statements) backing every other approved source here.
    `containsPersonalData` is unchanged everywhere — it is a factual claim about dataset content,
    not a rights judgement (`401a3e3`).
  - San Jose permits lineage attribution. Added
    `license.personalFieldsExcludedFromPublicProjection`, which governs **attribution only** —
    whether a public relation may _name_ a source as a contributor — and never whether a value may
    be published. `publicSourceIds` remains the sole control over publication; the new
    `publicLineageSourceIds` is used by `lineageForSourceIds` alone, so widening attribution cannot
    widen publication. The flag is optional rather than defaulted, so absence is indistinguishable
    from false and a source is attributable only by explicit opt-in. San Jose permits opts in with
    a recorded structural justification, including the documented residual that
    `field_source_ids_json` publishes `recordSha256` hashed over the whole raw CSV row — not
    plaintext, and a confirmation oracle only for someone who already holds the public CC0 row.
    (Working tree at time of writing; not yet committed.)

## 2026-07-20 — Bounded reduction fixes, operator execution ceilings, reconciliation incident

- Fixed bounded canonical reduction to retain the exact byte payload of each validated mutation
  rather than a re-serialized form, so canonical rows carried forward are byte-identical to what
  validation accepted and downstream size accounting and hashing operate on the same bytes that
  were verified (`7a81b0a`).
- Fixed the bounded reduction reader to accept budgeted canonical rows above 64KiB:
  `readNdjsonFile` now performs exact byte accounting, so any row that fits the declared stage
  budget is accepted regardless of the former fixed per-row threshold. Budget enforcement is
  unchanged; only the spurious per-row ceiling is removed (`8d1d64e`).
- Added operator execution-ceiling overrides `ORACLE_PIPELINE_DUCKDB_MEMORY_BYTES` and
  `ORACLE_PIPELINE_MAX_RSS_BYTES` for large-scale runs. They raise only the enforcement ceilings
  at the three enforcement sites; policy objects, policy hashes, and generation identity are
  deliberately unchanged, so an overridden run produces the same generation identity as a default
  run, and evidence records continue to report the true observed DuckDB-memory and process-RSS
  peaks (`0a7e37a`).
- Re-baselined `totalBudgetAcquisitions` from 116 to 136; the new value is deterministic and
  reflects the corrected exact bounded-reduction byte accounting (`eb94559`).
- Fixed lint only; no behavioral change (`9a6ac41`).
- Incident, resolved: cross-run resume of the `parcels`, `permits`, and `year-built` acquisition
  checkpoints failed with `not an exact contiguous prefix` following the ledger-reader change. The
  pipeline behaved as designed at every subsequent step: the three sources were honestly excluded
  rather than partially resumed, feature derivation was consequently starved (zero property
  entities), and the stage refused to commit an empty unit ledger rather than emit a vacuously
  "successful" result. Resolution: a fresh run identity with clean re-acquisition of all
  configured sources; no checkpoint state was reinterpreted or force-accepted. The run that
  actually carries this resolution is a **bounded `pilot`** run (requested-at
  `2026-07-19T12:00:00.000Z`, `--source-config config/source/assessment-pilot-demo.json`,
  `--output .cache/oracle-demo-bounded`), not an uncapped `full` re-acquisition. On Windows it ran
  with a short `--output E:/ora-demo/f` root, because the DuckDB native addon ignores the Windows
  long-path opt-in and the documented `.cache` path exceeds MAX_PATH. Do not describe it as a
  county-completion or full-profile run. Terminal identifiers, copied from the emitted manifest and
  release evidence: run ID `sc:run:74239e2f3c9beb70c4721c618f31d0d7db9cf472cc5e376d4f5f13fcf0ee98c2`,
  generation ID `sc:generation:2c8fb9aff0c40c016817f4eddf66236c7773f000ce9f0117f8f4ddd9bd55a2d8`,
  release ID `santa-clara-70ec78efee5b6c6b664fe8a3`, terminal status `partial`; 18,882 records
  accepted and 0 quarantined; per-capability terminal states across 15 capabilities are 2 succeeded,
  5 partial, 5 blocked, 2 failed, and 1 not_configured.

## Unreleased

- Added the ORA-010 reproducible Node 22 pnpm/Turborepo TypeScript foundation.
- Added honest web, API, MCP, and offline pipeline status surfaces with shared contracts and
  observability.
- Added a single CDK foundation stack for private S3/CloudFront hosting and Node 22 API/MCP
  Lambdas, plus infrastructure assertions.
- Composed the verified immutable serving release with the bounded Bedrock named-tool agent through
  a versioned translation and public-evidence redaction adapter.
- Added terminal agent trace/citation states, a SQL-free DuckDB named-query console, and mandatory
  hosted API/MCP/artifact/release-continuity proof.
