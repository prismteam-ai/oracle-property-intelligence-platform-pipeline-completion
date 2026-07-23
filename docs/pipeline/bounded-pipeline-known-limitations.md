# Bounded pipeline known limitations

This document records engineering limitations of the current bounded pipeline
that are known, understood, and deliberately documented rather than hidden.
Each entry states the limitation, how the system behaves when it is hit, and
why that behavior is intentional.

## Resume does not cross process boundaries for DuckDB table state

**Limitation.** Completed stages transfer between runs as verified file
artifacts, and those artifacts are sufficient to resume most of the pipeline.
However, `derive_features` consumes DuckDB table state — specifically the
`canonical_entity` and `geospatial_candidate` tables — that is built only by
in-process execution of the preceding bounded stages. That table state is not
itself a transferable artifact.

**Consequence.** If the process crashes mid-`derive_features`, the run cannot
resume feature derivation from the crash point in a new process. The bounded
chain must be re-run in one process to rebuild the DuckDB tables.

**Rationale.** The verified-artifact contract covers files whose integrity can
be checked on read. DuckDB table state does not currently carry an equivalent
verification story, so the pipeline refuses to pretend it does. A future
improvement is table rehydration from the verified artifacts, which would
extend resume across the process boundary without weakening the integrity
contract.

## Empty-input feature partitions cannot persist unit-ledger checkpoints

**Limitation.** The bounded feature stage
(`packages/features/src/bounded-stage.ts`) persists unit-ledger checkpoints
only on chunk flush. A partition that receives no input rows never flushes a
chunk, and therefore never persists a checkpoint. An all-empty stage
consequently has no mechanism to commit.

**Consequence.** A stage whose every partition is empty cannot produce a
committed (empty) unit ledger. Today this is guarded by the stage-level
integrity error: rather than silently committing nothing, the stage fails
loudly. This is the correct failure mode for the current pipeline, where an
all-empty feature stage indicates upstream starvation (as observed in the
2026-07-19 acquisition-checkpoint reconciliation incident), not a legitimate
empty result.

**Rationale.** Persisting checkpoints outside the chunk-flush path would add a
second commit mechanism solely to bless empty output. Until there is a real
use case for legitimately empty feature stages, failing with an integrity
error is more honest than a special-cased empty commit.

## Default execution ceilings do not cover county scale

**Limitation.** The default execution policy — 128MiB DuckDB memory, 512MiB
process RSS — is sufficient for reduced scales, but county-scale
`derive_features` and `build_marts` exceed it. Running at county scale
requires the operator environment overrides:

- `ORACLE_PIPELINE_DUCKDB_MEMORY_BYTES`
- `ORACLE_PIPELINE_MAX_RSS_BYTES`

**Consequence.** County-scale runs are an operator decision, not an automatic
escalation. Without the overrides, a county-scale run hits the enforcement
ceilings and fails.

**Rationale.** The overrides raise only the enforcement ceilings at the
enforcement sites. Policy objects and policy hashes are intentionally
unchanged: generation identity does not depend on how much headroom an
operator granted, and a run cannot silently reclassify itself by consuming
more memory. Evidence records report the true observed peaks, so every run's
actual resource usage remains auditable whether or not the ceilings were
raised. Baking larger defaults into the policy would change policy hashes for
all runs and hide the fact that resource requirements are scale-dependent;
the explicit override keeps that decision visible.
