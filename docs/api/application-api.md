# Oracle application API contract

Status: Wave 3A bounded serving contract. Schema version: `1.0.0`.

## Transport

- `GET /health` is a cheap process check. It never opens a release or executes a data query. It reports `ready`, `unconfigured`, or `test_fixture` readiness without pretending an uncomposed production release is healthy.
- Every application operation uses `POST /<operation>` (or `POST /trpc/<operation>`) with `Content-Type: application/json`.
- `OPTIONS` implements allowlisted CORS preflight. There is no wildcard origin mode.
- Request bodies are at most 16 KiB. Responses are at most 1 MiB.
- All inputs are exact objects. Unknown keys are rejected; this includes caller-provided SQL, table/relation names, expressions, filesystem/object paths, URLs, hosts, or source locators.

Production composition accepts only an injected `verified-immutable-release` query service. Every result is checked for `immutable: true`, `verified: true`, and the requested release ID. A test adapter must use deployment `test` and the literal label `TEST_ONLY_DETERMINISTIC_FIXTURE`; the handler refuses that label in production. The default Lambda export deliberately returns `SERVICE_UNAVAILABLE` until the recovered executable query service is composed. It never substitutes fixture data.

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

The production cursor HMAC secret is injected by composition, must contain at least 32 random bytes, and must remain stable for the lifetime of the release. It is neither accepted from callers nor returned in responses.

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
| `property.getEvidence`         | `releaseId`, `propertyId` (required), `feature`                                                                                     | `get_property_evidence`              |
| `inquiry.roofAge`              | page/filters, `minimumAgeYears` (default 15), `includeProxy` (default false), `asOf`                                                | `find_roof_age_candidates`           |
| `inquiry.waterCandidates`      | page/filters, `maximumDistanceMeters` (default 5000), `minimumTerrainConfidence` (default 0.5), `waterFeatureTypes`, `includeProxy` | `find_water_view_candidates`         |
| `inquiry.ownershipAge`         | page/filters, `minimumTenureYears` (default 10), `requireCompleteCoverage` (default true)                                           | `find_ownership_age_candidates`      |
| `inquiry.regionalOwner`        | page/filters, `policyId` (`bay-area-nine-counties-v1`)                                                                              | `find_regional_owner_properties`     |
| `inquiry.transitWalkability`   | page/filters, network/snap distances, service date, transit mode, agency, route, `includeProxy`                                     | `find_transit_walkable_properties`   |
| `inquiry.starbucksWalkability` | page/filters, network/snap distances, validation confidence, `includeProxy`                                                         | `find_starbucks_walkable_properties` |
| `inquiry.rankCandidates`       | page/filters, selected `signals`, exact per-signal `weights`, `includeProxy`, `minimumEvidenceCoverage`                             | `rank_review_candidates`             |
| `artifacts.list`               | common page, `artifactType`                                                                                                         | `list_artifacts`                     |
| `artifacts.getDataDictionary`  | `releaseId`                                                                                                                         | `get_data_dictionary`                |
| `agent.ask`                    | `releaseId`, `prompt` (required, at most 2000 characters)                                                                           | no-fallback named-tool agent         |
| `agent.status`                 | `releaseId`                                                                                                                         | no-fallback agent status             |

The combined ranking service, not the model, owns component scores. Inputs select signals and explicit numeric weights; output data must retain component contribution, support/proxy/unknown state, evidence coverage, and stable tie-break information.

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

## Composition gap at Wave 3A baseline

At baseline `b992780`, `packages/query-core/src/inquiries/` contains contracts and a cursor codec but no executable six-inquiry service. Consequently, this lane provides and verifies the full transport/composition contract but cannot honestly certify direct DuckDB parity or a production data response. Infrastructure must inject the recovered release/query service into `createApiHandler`; until then the default handler fails closed. This is an inherited integration gap, not a production fixture fallback.
