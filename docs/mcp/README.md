# Oracle named-evidence MCP

## Production boundary

`@oracle/mcp` is the public, read-only, SQL-free Streamable HTTP surface for the
same 16 `NamedQueryName` operations used by the application API. The default
Lambda lazily composes `@oracle/query-core/serving/index`; it does not contain a
fixture, alternate query engine, network release discovery, or environment
switch that can select test data.

The shared serving factory verifies the portable manifest, manifest hash,
release/run/schema identity, every required public artifact hash, Parquet schema
and grain, and the configured capability policy before it becomes ready. It then
opens only packaged public relations with `DuckDBAnalyticalRuntime`. Fixed SQL,
public-visibility predicates, evidence/limitation propagation, HMAC cursors, and
scan/row/time/response budgets remain owned by that reusable boundary.

The MCP adds protocol schema validation, request/HTTP response caps, immutable
metadata parity checks, cursor validation, and redacted MCP errors. It accepts no
caller SQL, relation, expression, file/path, object key, URL, host, extension, or
network authority.

### Default-export behavior

| State | Health | Tool behavior |
|---|---|---|
| All three serving environment fields absent | `degraded` / `unconfigured` | initialize and tools/list remain available; every tool fails `SERVICE_UNAVAILABLE` |
| Partial, malformed, unreadable, hash-drifted, or schema-drifted configuration | `degraded` / `unconfigured` | fails closed; no fallback or fixture is selected |
| Complete configuration and verified packaged release | `ready` / `ready` | all 16 tools execute through the shared production service |
| Explicit test injection through `createLambdaMcpHandler` | `degraded` / `test_fixture` | test-only; the factory rejects such a service when `deployment: production` |

Health performs no named data query and reports `dataQueriesExecuted: 0`. On a
cold production process the lazy composer must first verify the packaged release
so `ready` is truthful; subsequent health calls reuse that verified composition.

## Production environment contract

API and MCP use the same three serving fields:

| Variable | Required configured value |
|---|---|
| `ORACLE_RELEASE_ROOT` | Explicit absolute path to a packaged, read-only release directory |
| `ORACLE_SERVING_CONFIG_RELATIVE_PATH` | Portable relative JSON path inside the release root; backslashes, absolute paths, and `..` segments are rejected |
| `ORACLE_CURSOR_HMAC_SECRET_BASE64` | Canonical base64 containing at least 32 random bytes; inject through the Lambda secret/configuration boundary, never package it with artifacts |

There is intentionally no production fixture variable. The MCP does not consume
gateway URLs, CIDs as fetch locations, buckets, arbitrary artifact paths, or an
IPNS/latest pointer. Release selection is entirely server-owned.

The packaged serving JSON has this strict top-level shape:

```json
{
  "manifestRelativePath": "release-manifest.json",
  "expected": {
    "releaseId": "release-santa-clara-2026-07-17",
    "runId": "run-santa-clara-2026-07-17",
    "manifestSha256": "<64 lowercase hex characters>",
    "manifestCid": "<immutable release manifest CID>",
    "asOf": "2026-07-17T00:00:00.000Z",
    "schemaVersion": "1.0.0",
    "policyVersion": "<frozen policy version>"
  },
  "rankingWeights": [
    { "criterion": "roof_age", "weight": 1, "proxyMultiplier": 0.5 },
    { "criterion": "water_view_candidate", "weight": 1, "proxyMultiplier": 0.5 },
    { "criterion": "ownership_age", "weight": 1, "proxyMultiplier": 0.5 },
    { "criterion": "regional_owner", "weight": 1, "proxyMultiplier": 0.5 },
    { "criterion": "transit_walkability", "weight": 1, "proxyMultiplier": 0.5 },
    { "criterion": "starbucks_walkability", "weight": 1, "proxyMultiplier": 0.5 }
  ],
  "capabilities": {
    "roof_age": { "state": "partial", "supportClasses": ["supported", "proxy", "unknown"], "numerator": 1, "denominator": 10, "limitations": ["Measured release limitation."] },
    "water_view_candidate": { "state": "partial", "supportClasses": ["supported", "proxy", "unknown"], "numerator": 1, "denominator": 10, "limitations": ["Measured release limitation."] },
    "ownership_age": { "state": "blocked", "supportClasses": ["unknown", "unsupported"], "numerator": 0, "denominator": 10, "limitations": ["Measured release limitation."] },
    "regional_owner": { "state": "blocked", "supportClasses": ["unknown", "unsupported"], "numerator": 0, "denominator": 10, "limitations": ["Measured release limitation."] },
    "transit_walkability": { "state": "partial", "supportClasses": ["supported", "proxy", "unknown"], "numerator": 1, "denominator": 10, "limitations": ["Measured release limitation."] },
    "starbucks_walkability": { "state": "partial", "supportClasses": ["supported", "proxy", "unknown"], "numerator": 1, "denominator": 10, "limitations": ["Measured release limitation."] }
  },
  "limitations": ["Release-wide public limitation."]
}
```

`expected` must contain exactly the seven shown fields. `rankingWeights` and
`capabilities` must cover the full frozen release policy; query-core performs the
authoritative semantic validation. The JSON and manifest paths must resolve
inside `ORACLE_RELEASE_ROOT`.

`ORACLE_ALLOWED_ORIGINS` is an application API CORS setting, not an MCP serving
input. The MCP transport accepts no browser-origin authority and no query string.

## Transport

- MCP endpoint: `POST /mcp`
- Health: `GET /mcp/health` or `GET /health`
- SDK: `@modelcontextprotocol/sdk` `1.29.0`
- Mode: stateless Streamable HTTP with JSON responses
- Required `Accept`: `application/json, text/event-stream`
- Required `Content-Type`: `application/json`
- Required after initialization: a supported `MCP-Protocol-Version`
- Query strings: rejected
- Other methods on `/mcp`: `405`

The Lambda adapter creates a fresh SDK server/transport for each protocol
request. API Gateway v2 base64 bodies are decoded first. Server sessions,
server-initiated SSE, resumability, and token-bearing query strings are not
advertised.

## Frozen tools

1. `get_dataset_info`
2. `get_dataset_coverage`
3. `list_pipeline_runs`
4. `get_pipeline_run`
5. `search_properties`
6. `get_property`
7. `get_property_evidence`
8. `find_roof_age_candidates`
9. `find_water_view_candidates`
10. `find_ownership_age_candidates`
11. `find_regional_owner_properties`
12. `find_transit_walkable_properties`
13. `find_starbucks_walkable_properties`
14. `rank_review_candidates`
15. `list_artifacts`
16. `get_data_dictionary`

Every Inspector-visible input is a strict Zod object and generates
`additionalProperties: false`. Except for `get_dataset_info`, every operation
requires the exact immutable `releaseId`. The MCP field `pageSize` is validated
as `1..100` (default `25`) and translated once to query-core's canonical `limit`;
`pageSize` is removed before execution. A drift test compares every transformed
Inspector field set to query-core's exported
`PRODUCTION_SERVING_INPUT_FIELDS` allowlist.

`list_artifacts` is fixed to `publicationClass: public`. Authenticated/restricted
evidence is not available on this public surface.

## Result and parity contract

The MCP returns the shared application-compatible envelope without rewriting
evidence or support states:

```json
{
  "schemaVersion": "1.0.0",
  "releaseId": "immutable-release-id",
  "runId": "pipeline-run-id",
  "manifestCid": "immutable-manifest-cid",
  "asOf": "2026-07-17T00:00:00.000Z",
  "coverage": {},
  "limitations": [],
  "data": {},
  "nextCursor": null,
  "truncated": false,
  "timing": { "elapsedMs": 0, "bytesScanned": 0 }
}
```

For a corresponding API and MCP operation, route-specific API names are adapted
to the exact same `NamedQueryName` input and both call the same
`ProductionServingService.execute`. The service result must match its verified
`schemaVersion`, `releaseId`, `runId`, `manifestCid`, and `asOf`; any difference
fails closed. Unknown, unsupported, proxy, evidence, coverage, limitation, sort,
and truncation semantics are therefore identical rather than reimplemented by
the transports.

## Bounds and failures

| Limit | Value |
|---|---:|
| Request body | 16 KiB |
| Page size | 1–100, default 25 |
| Cursor | 512 UTF-8 bytes |
| Tool payload safety budget | 900 KiB |
| Complete HTTP response | 1 MiB |
| Shared DuckDB timeout | 5 seconds |
| Shared maximum scan | 512 MiB |

Cursors are opaque HMAC values bound to the operation, normalized query, and
release. Both incoming and returned cursors are validated. Missing validation,
stale/tampered values, operation reuse, release reuse, or overlong cursors fail
closed.

Stable redacted tool codes are `INVALID_REQUEST`, `RELEASE_MISMATCH`,
`STALE_OR_TAMPERED_CURSOR`, `RESULT_TOO_LARGE`, `QUERY_BUDGET_EXCEEDED`,
`RESTRICTED_EVIDENCE`, `SERVICE_UNAVAILABLE`, and `INTERNAL_ERROR`. Query-core
`RELEASE_INVALID` maps to `SERVICE_UNAVAILABLE`; `INTERNAL_QUERY_ERROR` maps to
`INTERNAL_ERROR`. Neither response includes SQL, stack traces, native/provider
messages, secrets, or physical paths.

## Elephant compatibility

This is the assessment named-evidence MCP, not the separate Elephant caller-SQL
compatibility surface. Its metadata truthfully remains:

| Capability | State |
|---|---|
| Caller `queryProperties` exposed here | No |
| Caller SQL forwarded to Elephant | No |
| Compatibility surface | Separate and uncertified |
| ORA-069 certification | Not claimed by this MCP |

## Lambda/CDK packaging requirements

The infrastructure lane must still provide these deployment assets; this MCP
lane does not edit CDK:

- package `ORACLE_RELEASE_ROOT` with `ORACLE_SERVING_CONFIG_RELATIVE_PATH`, the
  verified manifest, and every required public Parquet relation at its manifest
  path, mounted/readable but not writable by the function;
- build for the Lambda Linux architecture and include the native
  `@duckdb/node-api`/`@duckdb/node-bindings` binary matching that architecture;
- include the externalized `@oracle/query-core` serving package and its
  `@oracle/artifacts`, `@oracle/data-runtime`, and DuckDB production dependency
  closure alongside the MCP bundle, or use a tested container image; the
  package build deliberately externalizes `@oracle/query-core/*` because a
  JavaScript bundle cannot safely inline the platform-selected `.node` binding;
- inject the cursor secret without placing it in the release directory, serving
  JSON, source map, logs, or CloudFormation output;
- give the function enough ephemeral memory/disk for the verified packaged
  release and native DuckDB while retaining the shared scan/timeout bounds.

Until CDK copies the release assets and Linux native binding into the Lambda
artifact/container, local package tests prove composition but not deployability.

## Verification

Use exactly Node `22.18.0` and pnpm `10.33.0`:

```text
pnpm exec prettier --check apps/mcp/src docs/mcp
pnpm --filter @oracle/mcp lint
pnpm --filter @oracle/mcp typecheck
pnpm --filter @oracle/mcp test
pnpm --filter @oracle/mcp build
```

Tests cover initialize/list/call protocol behavior, exact tool inventory and
schema hash, strict additional-property rejection for all 16 operations,
query/path/URL authority abuse, request/result/page/cursor limits, release and
result metadata drift, redaction, base64 bodies, configured/unconfigured health,
production fixture rejection, packaged-config parsing, shared allowlist drift,
`pageSize` translation, all-operation delegation, and cursor validation parity.
