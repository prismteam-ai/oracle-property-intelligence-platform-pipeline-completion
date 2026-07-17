# Portable DuckDB release and verification

This release lane materializes deterministic public and restricted Parquet profiles, verifies them with a clean DuckDB process, and binds the verified files into a canonical JSON manifest. It is the local, networkless foundation for ORA-070 through ORA-072. It does not publish bytes, update IPFS/IPNS, or claim a full-county run.

## Release boundary

The builder in `packages/data-runtime/src/serving` accepts typed rows for the frozen serving relations. It validates every value before DuckDB receives it, orders rows by the relation contract, rejects duplicate grain keys, and writes Zstandard-compressed Parquet with one DuckDB thread.

The two profiles are physically separate:

```text
<release-root>/
  public/
    property-query.parquet
    property-evidence.parquet
    data-dictionary.parquet
  restricted/
    elephant-properties.parquet
    data-dictionary.parquet
  artifact-manifest.json
```

The exact set varies with the relations supplied to a run. `data_dictionary` is generated for every profile and describes only relations in that profile. Restricted-only relations, including the 37-column Elephant compatibility projection, cannot be built into the public profile.

## Required row grains

Each relation declares its columns, DuckDB logical types, nullability, sort order, unique grain key, and allowed visibility in `schema.ts`. Important grains are:

| Relation              | Required grain                                            |
| --------------------- | --------------------------------------------------------- |
| `property_query`      | exactly one row per `property_id`                         |
| `elephant_properties` | exactly one row per Elephant `property_id`                |
| `property_evidence`   | one row per immutable `evidence_id`                       |
| `canonical_history`   | one row per canonical entity/version                      |
| coverage relations    | one row per declared source, field, or relationship scope |

Two addressable properties may share an APN. The builder therefore enforces `property_id`, not APN, as the one-row serving grain. A null or duplicate property ID is a hard failure.

## Determinism contract

Byte-identical rebuilds depend on all of the following:

- pinned Node, pnpm, and DuckDB versions;
- one DuckDB thread and preserved insertion order;
- exact schema column order;
- deterministic row sorting before `COPY`;
- fixed Parquet compression and row-group settings;
- canonical JSON strings with recursively sorted object keys;
- no build timestamp embedded in Parquet rows unless it is part of the declared source data.

Build the same input into a new empty directory. Existing artifact targets are never overwritten. The clean-room test builds into two unrelated directories and compares every Parquet byte, byte count, schema hash, and SHA-256.

## Public/restricted safety

Public output is fail-closed at build and verification time:

- prohibited owner, mailing, grantor/grantee, email, phone, and contact columns are rejected;
- nested JSON keys such as `owner_name`, `ownerName`, `mailing_address`, and contact fields are rejected;
- the artifact path must match its declared visibility directory and frozen filename;
- a relation must permit its declared visibility;
- the actual Parquet schema must match both the manifest metadata and the frozen relation contract;
- public and restricted DuckDB profiles register only artifacts of the selected class.

This structural check is one release-safety layer. The later ORA-073 whole-byte privacy/license scanner remains mandatory for the immutable full release; these checks do not replace that gate.

## Artifact verification

`verifyServingArtifacts` independently reopens each Parquet file and checks:

1. SHA-256 and byte size;
2. leading and trailing `PAR1` range reads;
3. exact column names, order, and DuckDB logical types;
4. frozen schema hash;
5. row count and per-column non-null counts;
6. null and duplicate grain keys;
7. visibility path/relation policy;
8. restricted JSON-key leakage in public artifacts.

`openServingProfile` creates a fresh in-memory DuckDB catalog of views over one visibility class. Callers do not supply table names or paths. The clean-room test compares its result with a separate direct `read_parquet` query and also copies the tiny fixture into a persistent DuckDB database, closes it, reopens it, and repeats the query.

`readArtifactRange(path, start, endInclusive)` uses strict inclusive safe-integer bounds and rejects short reads. This is the local equivalent of the later hosted `Range: bytes=0-3`/`PAR1` proof.

## Canonical release manifest

`packages/artifacts/src/release/manifest.ts` writes canonical UTF-8 JSON with a trailing LF and an immutable self-hash. Every artifact entry binds:

- portable relative path and media type;
- exact byte size and SHA-256;
- row count and declared row grain;
- ordered schema, schema SHA-256, and non-null counts;
- public or restricted visibility;
- source/snapshot IDs, source-byte and source-schema hashes, as-of time, and direct/derived role;
- an explicit limitations array.

The manifest-level `sourceIds` must exactly equal the union of artifact lineage sources. Manifest creation sorts set-like inputs, so caller ordering cannot change the output hash. `writePortableReleaseManifest` uses create-only semantics. `verifyPortableReleaseFiles` reopens the JSON, validates its self-hash, resolves every portable path inside the release root, and recomputes every artifact byte count and SHA-256.

The Elephant compatibility report separately binds the exact audited 37-column order/types and emits one baseline-versus-release record per field. It preserves the audited row/distinct-property denominator and labels coverage as `unchanged`, `filled`, `improved`, or `regressed`; it cannot collapse normalized history into the flat compatibility projection.

## Clean-room verification

Use the pinned toolchain for every command:

```powershell
$env:PATH='E:\nvm\v22.18.0;' + $env:PATH
node --version
pnpm --version
pnpm --filter @oracle/data-runtime test
pnpm --filter @oracle/artifacts test
pnpm --filter @oracle/testkit test
pnpm --filter @oracle/data-runtime typecheck
pnpm --filter @oracle/artifacts typecheck
```

The serving suites use tiny, legally safe fixtures and no network. They cover shared-APN row grain, null/duplicate IDs, scalar type and schema drift, column order/count/non-null drift, byte-identical reruns, bounded range reads, file and manifest corruption, nested restricted-field leakage, physical profile separation, direct DuckDB parity, persistent DuckDB reopen, and all 37 Elephant baseline fields.

## Recovery and release promotion

An interrupted build is restarted into a new empty output directory. Completed immutable artifacts may be reused only after all hashes and DuckDB checks pass. A changed source snapshot, schema, row count, lineage record, limitation, or artifact byte produces a different artifact or manifest hash and requires a new release ID.

Promotion still requires the pipeline terminal-state reconciliation, full uncapped county run, ORA-073 privacy/license scan, local CAR/range verification, and the explicit publication gates. No function in this lane uploads data or mutates a public pointer.

## Tradeoffs

- Parquet remains the portable source of truth; a DuckDB database is a reproducible cache/catalog, avoiding an always-on database and vendor lock-in.
- Physical public/restricted separation duplicates small dictionary metadata but makes accidental cross-profile registration auditable and fail-closed.
- Deterministic single-threaded fixture builds prioritize reproducibility. Full-county performance can use measured partitioning while retaining deterministic per-partition order and manifest binding.
- Per-artifact lineage is verbose, but it makes a release independently auditable and prevents a global source list from implying provenance that a specific artifact does not have.
