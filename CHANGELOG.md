# Changelog

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
  "successful" result. Resolution: a fresh run identity (requested-at `2026-07-19T19:00:00.000Z`)
  with clean re-acquisition of all sources; no checkpoint state was reinterpreted or
  force-accepted. Full re-acquisition is in progress. Run ID, generation ID, and release counts:
  (final identifiers recorded on release finalization).

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
