# Production serving composition

The production query boundary serves one explicit, immutable Santa Clara portable release. It
does not discover a release over the network, resolve IPNS, accept a caller path or URL, or expose
caller-authored SQL. API and MCP adapters call the same `ProductionServingService`, so a named
operation has one implementation and one result envelope.

## Public entry point

Import the boundary from `@oracle/query-core/serving/index`:

```ts
import {
  createProductionServingService,
  type ProductionServingConfig,
} from '@oracle/query-core/serving/index';

const service = await createProductionServingService(config);
const result = await service.execute({
  operation: 'search_properties',
  input: { releaseId: service.release.releaseId, city: 'Palo Alto', limit: 25 },
});
```

`PRODUCTION_SERVING_INPUT_FIELDS` exposes the exact field allowlist for all 16 frozen
`NamedQueryName` operations. Pagination at this shared boundary is always `limit` plus `cursor`.
The MCP transport maps its public `pageSize` field to `limit`; it does not pass both or introduce an
alias into query core.

The factory accepts only server-owned configuration:

```ts
type ProductionServingConfig = {
  releaseRoot: string; // explicit absolute packaged or read-only mounted directory
  manifestRelativePath: string; // portable path inside releaseRoot
  expected: {
    releaseId: string;
    runId: string;
    manifestSha256: string;
    manifestCid: string;
    asOf: string;
    schemaVersion: string;
    policyVersion: string;
  };
  cursorSecret: Uint8Array; // at least 32 bytes
  rankingWeights: readonly RankingWeight[];
  capabilities: InquiryReleaseContext['capabilities'];
  limitations?: readonly string[];
};
```

The caller of a named operation supplies only structured filters. It cannot replace any factory
field, relation, SQL statement, file path, object key, host, or URL.

## Verification and loading

Factory creation and every subsequent operation verify the committed portable release:

1. Parse the canonical portable manifest and validate its embedded SHA-256.
2. Match release ID, run ID, manifest hash, generated/as-of time, and schema version to explicit
   server configuration.
3. Hash every declared **public** release artifact and compare byte size and SHA-256. Restricted
   manifest entries do not require their bytes to exist in the public serving package.
4. Require the public `property_query`, `property_evidence`, `source_coverage`, `field_coverage`,
   `relation_coverage`, `pipeline_runs`, and `data_dictionary` relations.
5. Verify Parquet boundaries, exact ordered columns and DuckDB types, schema hash, row/non-null
   counts, grain keys, public visibility, and restricted-field policy.
6. Require the packaged DuckDB version to equal the manifest version.
7. Create views only for the verified public artifacts using server-owned paths under
   `releaseRoot`.

Any manifest, public artifact, schema, row-grain, count, visibility, release, or DuckDB-version
drift fails closed. Restricted artifacts can exist in the immutable manifest, but their bytes must
not be included in the public serving package; the public serving session neither reads them,
creates views for them, nor returns them from `list_artifacts`.

The runtime uses `DuckDBAnalyticalRuntime`. The six evidence inquiries and transparent combined
ranking use the existing `NamedInquiryExecutor`; dataset, pipeline, property, evidence, artifact,
and dictionary operations use fixed statements over the same verified session. Dataset/property/
artifact answers therefore come from release relations or verified manifest rows, never a fixture
service.

## Frozen operations

The service implements all 16 contract operations:

- `get_dataset_info`
- `get_dataset_coverage`
- `list_pipeline_runs`
- `get_pipeline_run`
- `search_properties`
- `get_property`
- `get_property_evidence`
- `find_roof_age_candidates`
- `find_water_view_candidates`
- `find_ownership_age_candidates`
- `find_regional_owner_properties`
- `find_transit_walkable_properties`
- `find_starbucks_walkable_properties`
- `rank_review_candidates`
- `list_artifacts`
- `get_data_dictionary`

Every operation has an exact field allowlist. Unknown fields are rejected. Page size is `1..100`,
cursors are at most 512 UTF-8 bytes, query timeout is 5 seconds, the immutable scan ceiling is 512
MiB, and a serialized response is at most 1 MiB. Queries request at most one look-ahead row beyond
the public page size.

Some inspector-visible filters describe dimensions not present in the current compact mart. The
service accepts only the release-policy default for those dimensions and rejects a different
selection instead of silently ignoring it. Examples are routing snap distance, place confidence,
water-feature subsets, agency/route selection, and individual roof-proxy classes. A future release
can add fixed columns and a new policy/schema version to make those dimensions selectable.

## Cursors, visibility, evidence, and limitations

General-operation cursors are HMAC-SHA-256 signed and bind the release, named operation,
normalized input fingerprint, and keyset continuation. Inquiry cursors retain the existing
`NamedInquiryExecutor` binding to release, inquiry, normalized query, and sort keys. The shared
`validateCursor` method verifies either form for API/MCP transport preflight. A changed release,
operation, filter, threshold, weight, or limit invalidates the cursor.

Every SQL statement contains an explicit public-visibility predicate where row visibility exists.
Evidence queries require `property_evidence.visibility = 'public'`. Positive inquiry rows retain
their matching evidence summaries, source IDs, algorithm/version, confidence, support class,
as-of, and limitations. General relation JSON fields are parsed from the verified bytes and remain
part of the returned data.

The common API/MCP envelope intentionally has no separate top-level `evidence` property. Inquiry
evidence is in `data.results[*].evidence`; direct evidence lookup is in `data.evidence`. This matches
the committed success envelope while preserving evidence verbatim. Coverage and limitations remain
top-level and are also present at the applicable result/capability level.

## Production environment contract

Query core does not read environment variables. The API and MCP composition roots must parse and
validate their environment once, decode the cursor secret, create this config, and fail closed if
anything is missing. Use one identical release/configuration for both transports. The production
adapters use this exact environment contract:

| Variable                              | Meaning                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| `ORACLE_RELEASE_ROOT`                 | Absolute read-only release directory in the Lambda image or mounted asset       |
| `ORACLE_SERVING_CONFIG_RELATIVE_PATH` | Relative path under the release root to the packaged serving configuration      |
| `ORACLE_CURSOR_HMAC_SECRET_BASE64`    | Base64 secret decoding to at least 32 bytes; use the same value for API and MCP |
| `ORACLE_ALLOWED_ORIGINS`              | API only: comma-separated exact HTTPS origins; wildcard/non-HTTPS fails closed  |

The packaged serving configuration is strict JSON with only `manifestRelativePath`, `expected`,
`rankingWeights`, `capabilities`, and optional `limitations`. `expected` contains `releaseId`,
`runId`, `manifestSha256`, `manifestCid`, `asOf`, `schemaVersion`, and `policyVersion`. The config
file is inside `ORACLE_RELEASE_ROOT`; its manifest path is also relative to that root. This keeps
non-secret release metadata versioned with the read-only asset while the cursor HMAC secret remains
external.

Do not accept these values in an HTTP/MCP request. Do not put artifact URLs, gateway URLs, SQL, or
relation names in environment-driven operation input. Rotation of the HMAC secret invalidates
outstanding cursors by design.

## Error contract

`ProductionServingError` exposes a stable internal code for adapter mapping:

- `INVALID_REQUEST`
- `RELEASE_MISMATCH`
- `STALE_OR_TAMPERED_CURSOR`
- `RESULT_TOO_LARGE`
- `QUERY_BUDGET_EXCEEDED`
- `RELEASE_INVALID`
- `INTERNAL_QUERY_ERROR`

Adapters must map these to their public redacted error envelopes. They must not return the error
cause, SQL, stack, manifest path, or artifact path.

## Lambda packaging requirements

`@duckdb/node-api` is a native dependency. Build the Lambda container on Linux for the exact target
architecture and include its native binding and transitive shared libraries; a bundle produced on
Windows is not deployable. Keep Node at `22.18.0` and pnpm at `10.33.0` in build and runtime.

The release root must be immutable and readable by the Lambda role. A container-image layer is the
simplest option only while the complete release fits Lambda image limits. Otherwise CDK must package
an explicitly versioned read-only filesystem asset (for example an EFS access point mounted at a
fixed path) and pass that exact path; query core still performs no discovery and verifies all bytes
of every packaged public artifact before opening them. The current CDK lane must decide and test the
asset strategy, Linux native module inclusion, image architecture, file permissions, cold-start
time, and public-package size.
