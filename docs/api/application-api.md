# Oracle application API contract

Status: Production serving composition. Schema version: `1.0.0`.

## Transport

- `GET /health` never executes a named data query. On a cold Lambda it waits for the one-time packaged-release verification, then reports `ready`; an absent release reports `unconfigured`, while partial, invalid, or failed verification reports `configuration_error`; both are `degraded`. Injection tests report `test_fixture` and can never be selected from production environment variables.
- Every application operation uses `POST /<operation>` (or `POST /trpc/<operation>`) with `Content-Type: application/json`.
- `OPTIONS` implements allowlisted CORS preflight. There is no wildcard origin mode.
- Request bodies are at most 16 KiB. Responses are at most 1 MiB.
- All inputs are exact objects. Unknown keys are rejected; this includes caller-provided SQL, table/relation names, expressions, filesystem/object paths, URLs, hosts, or source locators.

Production composition calls `createProductionServingService` from `@oracle/query-core/serving/index`. The factory verifies the expected portable manifest, artifact bytes, hashes, schemas, grain, and public visibility before the API reports ready. Every result is checked against the verified release ID, run ID, manifest CID, as-of instant, and schema version. A test adapter must use deployment `test` and the literal label `TEST_ONLY_DETERMINISTIC_FIXTURE`; the handler refuses that label in production. No environment value selects a fixture.

## Common success envelope

```json
{
  "schemaVersion": "1.0.0",
  "releaseId": "immutable release identifier",
  "runId": "pipeline run identifier",
  "manifestCid": "immutable manifest CID",
  "asOf": "2026-07-17T00:00:00.000Z",
  "coverage": {},
  "limitations": [],
  "data": {},
  "nextCursor": null,
  "truncated": false,
  "timing": { "elapsedMs": 0, "bytesScanned": 0 }
}
```

Except for `dataset.getInfo`, every request requires `releaseId`. Page size defaults to 25 and is bounded to 1–100. Cursors are opaque, HMAC-protected, operation-bound, release-bound, and at most 512 bytes. Query execution is bounded to 5 seconds, 512 MiB scanned, and the requested page limit. Agent execution is bounded to 30 seconds, 3 model steps, and 6 named-tool calls.

The production cursor HMAC secret is injected by composition, must contain at least 32 random bytes, and must remain stable for the lifetime of the release. It is neither accepted from callers nor returned in responses. The API returns the shared serving cursor unchanged, so the same operation/input/release has cursor parity with MCP; there is no transport-specific second wrapper.

## Operations

All fields below are optional unless marked required. Common paged fields are `releaseId` (required), `limit`, and `cursor`. Common property filters are `city`, `postalCode`, and `propertyId`.

| Operation                      | Exact operation-specific fields                                                                                                     | Frozen query operation               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `dataset.getInfo`              | none                                                                                                                                | `get_dataset_info`                   |
| `dataset.getCoverage`          | `releaseId`                                                                                                                         | `get_dataset_coverage`               |
| `pipeline.listRuns`            | common page                                                                                                                         | `list_pipeline_runs`                 |
| `pipeline.getRun`              | `releaseId`, `runId` (required)                                                                                                     | `get_pipeline_run`                   |
| `property.search`              | common page/filters, `query`, `sort`                                                                                                | `search_properties`                  |
| `property.get`                 | `releaseId`, `propertyId` (required)                                                                                                | `get_property`                       |
| `property.getEvidence`         | common page, `propertyId` (required), `feature`                                                                                     | `get_property_evidence`              |
| `inquiry.roofAge`              | page/filters, `minimumAgeYears` (default 15), `includeProxy` (default false), `asOf`                                                | `find_roof_age_candidates`           |
| `inquiry.waterCandidates`      | page/filters, `maximumDistanceMeters` (default 5000), `minimumTerrainConfidence` (default 0.5), `waterFeatureTypes`, `includeProxy` | `find_water_view_candidates`         |
| `inquiry.ownershipAge`         | page/filters, `minimumTenureYears` (default 10), `requireCompleteCoverage` (default true)                                           | `find_ownership_age_candidates`      |
| `inquiry.regionalOwner`        | page/filters, `policyId` (`bay-area-nine-counties-v1`)                                                                              | `find_regional_owner_properties`     |
| `inquiry.transitWalkability`   | page/filters, network distance (default 800 m), snap distance (default 200 m), service date, agency, route, `includeProxy`          | `find_transit_walkable_properties`   |
| `inquiry.starbucksWalkability` | page/filters, network distance (default 800 m), snap distance (default 200 m), validation confidence (default 0.7), `includeProxy`  | `find_starbucks_walkable_properties` |
| `inquiry.rankCandidates`       | page/filters, selected `signals`, exact per-signal `weights`, `includeProxy`, `minimumEvidenceCoverage`                             | `rank_review_candidates`             |
| `artifacts.list`               | common page, `artifactType`                                                                                                         | `list_artifacts`                     |
| `artifacts.getDataDictionary`  | common page                                                                                                                         | `get_data_dictionary`                |
| `agent.ask`                    | `releaseId`, `prompt` (required, at most 2000 characters)                                                                           | no-fallback named-tool agent         |
| `agent.status`                 | `releaseId`                                                                                                                         | no-fallback agent status             |

The combined ranking service, not the model, owns component scores. Inputs select signals and explicit numeric weights; output data must retain component contribution, support/proxy/unknown state, evidence coverage, and stable tie-break information.

The transport adapter performs a finite, tested alias mapping into the shared serving contract: `limit` stays `limit`; property `query` becomes the exact `parcelIdentifier`; water distance/confidence, ownership completeness, regional policy, agency/route, Starbucks confidence, and ranking field names are translated without changing their values. Ranking weight objects become the shared ordered weight array using the release-configured proxy multipliers. Unsupported API-only authority is rejected rather than dropped: non-`property_id` search sorts, transit-mode selection, and artifact-type filtering return `INVALID_REQUEST` for this immutable release. Explicit agency/route, snap-distance, place-confidence, water-feature, and terrain-confidence values also fail closed when the release does not materialize that selectable dimension.

## Stable error contract

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "The request does not match the operation contract.",
    "operation": "property.search",
    "requestId": "API Gateway request identifier",
    "retryable": false
  }
}
```

Codes are `INVALID_REQUEST`, `REQUEST_TOO_LARGE`, `RESPONSE_TOO_LARGE`, `UNKNOWN_OPERATION`, `METHOD_NOT_ALLOWED`, `ORIGIN_NOT_ALLOWED`, `RELEASE_MISMATCH`, `STALE_CURSOR`, `QUERY_BUDGET_EXCEEDED`, `DATA_CORRUPTION`, `AGENT_UNAVAILABLE`, `SERVICE_UNAVAILABLE`, and `INTERNAL_ERROR`. Public messages are fixed. Errors never include request fields, SQL, source content, provider output, physical paths, URLs, secrets, stacks, or exception text.

## Capability truthfulness

- Supported/proxy/unknown/unsupported state, evidence identifiers, coverage, and limitations come from the immutable query result; the API does not upgrade them.
- Potential water view remains a candidate and cannot assert an observed view.
- Missing ownership history remains unknown unless the query service establishes complete coverage.
- Public regional-owner results cannot expose raw owner identity.
- Straight-line walkability remains a proxy; supported results require network evidence.
- If the Bedrock agent or its promoted policy is unavailable, `agent.ask` fails with `AGENT_UNAVAILABLE`. Deterministic query routes remain independently usable; no rules-based or canned agent response is returned.

Evidence is not duplicated into a second transport-only field. Inquiry results preserve `data.results[*].evidence`; property-evidence results preserve `data.evidence`; dataset, property, artifact, coverage, and dictionary data preserve the shared serving rows verbatim. Top-level coverage, limitations, truncation, cursor, and timing are also copied from the same shared result used by MCP.

## Production environment contract

The default Lambda accepts only these server-owned configuration inputs:

- `ORACLE_ALLOWED_ORIGINS`: comma-separated, unique, exact HTTPS origins; wildcard, paths, query strings, and fragments are rejected.
- `ORACLE_RELEASE_ROOT`: absolute path to the packaged, read-only release directory.
- `ORACLE_SERVING_CONFIG_RELATIVE_PATH`: portable relative JSON path inside `ORACLE_RELEASE_ROOT`.
- `ORACLE_CURSOR_HMAC_SECRET_BASE64`: canonical base64 for at least 32 random bytes, stable for the release lifetime.

The serving JSON is strict and contains only:

```json
{
  "manifestRelativePath": "portable-release.json",
  "expected": {
    "releaseId": "release identifier",
    "runId": "run identifier",
    "manifestSha256": "64 lowercase hex characters",
    "manifestCid": "immutable CID",
    "asOf": "offset-qualified ISO-8601 instant",
    "schemaVersion": "1.0.0",
    "policyVersion": "release policy identifier"
  },
  "rankingWeights": [],
  "capabilities": {},
  "limitations": []
}
```

Paths, URLs, buckets, prefixes, SQL, tables, or object keys are never accepted from a request. An absent release configuration is cached as `unconfigured`; partial, malformed, out-of-root, stale, hash-drifted, schema-drifted, or non-public configuration is cached as `configuration_error`. In both cases `/health` is degraded and every operation returns redacted `SERVICE_UNAVAILABLE`/release-integrity errors. A failed cold-start composition is not retried within the same warm process.

`ORACLE_MODEL_PROVIDER`, `ORACLE_BEDROCK_MODEL_ID`, `ORACLE_BEDROCK_REGION`, and `ORACLE_AGENT_POLICY_HASH` do not by themselves enable `/agent.ask`. This wave keeps the agent unavailable until a promoted semantic-policy hash, release capability/data-dictionary policy, named-evidence adapter, and no-fallback Bedrock profile can be composed and qualified together. Deterministic production queries remain available independently.

## Lambda/CDK asset requirements

The Lambda asset must contain the serving JSON, portable manifest, and every manifest-bound public Parquet artifact under one read-only directory, and must set the four environment values above. The runtime bundle must also contain the `@duckdb/node-api` native binary for the Lambda architecture and Node `22.18.0`; an esbuild-only JavaScript bundle is insufficient unless the matching native module is copied into the asset. The current CDK bucket/prefix discovery variables and Secrets Manager ARN do not satisfy this local packaged-path contract, and the current ARM64 `NodejsFunction` requires explicit proof that the matching DuckDB native binary is present. Until CDK supplies that asset and injects the cursor secret value (or adds a bounded Secrets Manager loader), the deployed default correctly remains `configuration_error` rather than discovering a release over the network.
