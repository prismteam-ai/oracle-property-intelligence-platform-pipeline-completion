# Oracle named-evidence MCP

## Status

This application is a public, read-only, SQL-free Streamable HTTP MCP surface.
It exposes the 16 frozen named-evidence operations and no caller-controlled SQL,
relation, expression, path, object key, URL, or host authority.

The current repository does not contain an executable six-inquiry query service.
Production therefore advertises the protocol and tool schemas but fails tool
execution closed with `SERVICE_UNAVAILABLE` until composition injects a verified
immutable-release `NamedEvidenceService`. Tests use an explicit deterministic
adapter; test data is not a production fallback.

Elephant compatibility is separate and currently labeled:

| Capability | State |
|---|---|
| Official pinned metadata/schema smoke | Not implemented by this MCP |
| Caller `queryProperties` compatibility | Blocked, uncertified |
| Caller SQL exposed by this MCP | No |
| ORA-069 certification | Not present |

Do not describe this MCP as Elephant caller-query compatible unless the complete
replacement certification has passed. It never forwards caller SQL to the pinned
Elephant executor.

## Transport

- Endpoint: `POST /mcp`
- Health: `GET /mcp/health` or `GET /health`
- SDK: frozen `@modelcontextprotocol/sdk` `1.29.0`
- Mode: stateless Streamable HTTP with JSON responses
- Required `Accept`: both `application/json` and `text/event-stream`
- Required `Content-Type`: `application/json`
- Required after initialization: `MCP-Protocol-Version` using a version supported
  by the SDK
- Query strings: rejected
- `GET`, `DELETE`, and other methods on `/mcp`: `405`; server-initiated SSE and
  resumability are intentionally not advertised by this stateless Lambda surface

The Lambda adapter creates a fresh official SDK server and transport for every
request. API Gateway v2 base64 bodies are decoded before the SDK sees the request.

Health is deliberately cheap: it does not resolve a release, open an artifact,
invoke DuckDB, or call the named-evidence service. Its Elephant compatibility
object is a status label, not a live compatibility claim.

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

Every Inspector-visible input is a strict Zod object whose generated JSON Schema
has `additionalProperties: false`. Except for `get_dataset_info`, every input
requires an opaque `releaseId`. The public artifact tool accepts only the `public`
publication class; authenticated or restricted expansion needs a separately
authorized surface and is unavailable here.

The common successful result is the API-compatible envelope:

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

The MCP layer parses this envelope, preserves its evidence/support/unknown/
limitation data, verifies that its release matches the request, and applies
response bounds. It does not reinterpret evidence or convert unknown states into
positive claims.

## Limits and failure behavior

| Limit | Value |
|---|---:|
| Request body | 16 KiB |
| Page size | 1–100, default 50 |
| Cursor | 512 UTF-8 bytes |
| Tool payload safety budget | 900 KiB |
| Complete HTTP response | 1 MiB |

Cursors are opaque. A request cursor and every returned continuation cursor must
pass the injected service's integrity check for the exact operation and release.
If validation is missing, stale, or fails, the MCP rejects the call fail closed.

Tool errors use a bounded redacted object inside an MCP error result. Stable codes
are `INVALID_REQUEST`, `RELEASE_MISMATCH`, `STALE_OR_TAMPERED_CURSOR`,
`RESULT_TOO_LARGE`, `QUERY_BUDGET_EXCEEDED`, `RESTRICTED_EVIDENCE`,
`SERVICE_UNAVAILABLE`, and `INTERNAL_ERROR`. Unexpected exceptions never expose
SQL, stack traces, provider responses, secrets, or physical paths.

## Composition contract

`createLambdaMcpHandler(service)` accepts a `NamedEvidenceService` with:

- `execute({ tool, input, signal })` returning the common evidence envelope; and
- `validateCursor({ tool, releaseId, cursor })` whenever pagination is used.

The production composer must bind this adapter to one verified immutable release
and to the same deterministic named-query functions used by the direct query/API
surface. It must enforce scan, timeout, row, visibility, and authorization limits.
The MCP wrapper independently checks schema, release identity, cursor availability,
and serialized size.

Direct DuckDB parity remains blocked in this commit because the inherited
`packages/query-core/src/inquiries` tree contains contracts and a cursor codec but
no executable six-inquiry adapter. Closing parity requires injecting that recovered
adapter and running identical named requests against both paths; do not replace
that proof with fixtures.

## Verification

Run with Node `22.18.0`:

```text
pnpm exec prettier --check apps/mcp/src docs/mcp
pnpm --filter @oracle/mcp lint
pnpm --filter @oracle/mcp typecheck
pnpm --filter @oracle/mcp test
pnpm --filter @oracle/mcp build
```

The package currently has no package-local `format:check` script, so use the root
formatter check scoped by the repository workflow. Tests cover initialize and
protocol negotiation, media errors, the exact tool inventory, Inspector schema
hash, strict additional-property rejection for all tools, authority abuse,
release drift, page and cursor bounds, tampered cursors, oversized requests and
results, redaction, production fail-closed behavior, and API Gateway v2/base64
integration.
