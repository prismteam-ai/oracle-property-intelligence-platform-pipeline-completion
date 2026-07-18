# Oracle evaluator experience

Status: Wave 3B production UI contract.

## Runtime boundary

The evaluator is a static React application backed by the production
application API. It discovers an immutable release through
`POST /dataset.getInfo`, then binds every other operation to the returned
`releaseId`. The production client rejects any response containing the literal
`TEST_ONLY_DETERMINISTIC_FIXTURE` label.

Production composes the verified immutable-release query service and the
release-bound named-tool agent independently. Missing release configuration,
policy drift, or a failed model probe produces a conspicuous degraded/error
state; the UI never substitutes synthetic property rows, fabricated coverage
totals, or canned agent text. The static deployment must route the application
to that composed API origin.

Tests inject a deterministic `ApiClient` directly into `<App>`. Those records:

- carry the visible `TEST_ONLY_DETERMINISTIC_FIXTURE` banner;
- use `TEST-*` identifiers and test-only copy;
- are imported only by test modules;
- are rejected by the production HTTP client if they cross the transport
  boundary.

## Stable routes

| Route                              | Evaluator purpose                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `/`                                | County overview, immutable release, verified metrics, six inquiry launch points   |
| `/pipeline`                        | Release-bound pipeline runs, source counts, timestamps, and constraints           |
| `/coverage`                        | Expected/observed/linked denominators and source capability states                |
| `/properties`                      | URL-addressed property search with table and spatial/map-equivalent views         |
| `/properties/:propertyId`          | Canonical property facts and source/evidence timeline                             |
| `/inquiries/roof-age`              | Strict roof evidence with explicit proxy inclusion                                |
| `/inquiries/water-candidates`      | Potential water-view candidate semantics and terrain threshold                    |
| `/inquiries/ownership-age`         | Verified transfer-age semantics and completeness requirement                      |
| `/inquiries/regional-owner`        | Versioned Bay Area nine-county owner-region policy                                |
| `/inquiries/transit-walkability`   | Pedestrian-network transit distance with proxy distinction                        |
| `/inquiries/starbucks-walkability` | Qualified Overture place and pedestrian-route evidence                            |
| `/rankings`                        | Transparent deterministic multi-signal ranking                                    |
| `/agent`                           | No-fallback status, selected profile, terminal answer/error, citations, and trace |
| `/query-console`                   | SQL-free DuckDB console over fixed operations and bounded structured fields       |
| `/artifacts`                       | Public immutable CIDs, hashes, sizes, rows, and publication class                 |
| `/dictionary`                      | Release-bound public data dictionary                                              |
| `/mcp`                             | Streamable HTTP setup and exact sixteen-tool inventory                            |
| `/capabilities`                    | Direct/derived/proxy/partial/blocked/unsupported vocabulary                       |
| `/evidence`                        | Read-only immutable release receipt without self-scoring or held-out data         |
| `/about/architecture`              | DuckDB/IPFS portability and scale-to-zero cost posture                            |

CloudFront must apply SPA fallback for direct navigation and refresh of every
route. The API and `/mcp` paths must remain origin-routed and must not receive
the SPA document.

## URL query state

Property filters and inquiry thresholds use `URLSearchParams`; applying a form
updates the URL before the operation reruns. Agent submissions use `?q=`. This
makes demo steps shareable and replayable without browser storage. Returned
opaque cursors are not interpreted by the UI.

## Agent terminal states

`/agent` checks `agent.status` before enabling its question controls or sending
`agent.ask`. Loading is explicit. An unavailable, policy-drifted, or failed
profile produces a conspicuous terminal error and never displays a canned,
rules-based, fixture, or prior answer.

An available status names the actual selected model profile, policy hash,
immutable release, and public limitations returned by the composed production
service. A successful answer renders only the terminal synthesis, top-level
release receipt, sorted exact citations, and the redacted trace fields
`callIndex`, `toolName`, `releaseId`, and public `evidenceIds`. The UI never
renders model reasoning, chain-of-thought, prompts, named-tool arguments, raw
tool results, provider output, or private evidence.

## SQL-free DuckDB console

`/query-console` defaults to the fixed `get_dataset_info` operation and exposes
only an allowlisted operation selector. Release-bound inquiry choices reuse the
same fixed production operations and expose only their bounded structured
fields. The console has no query-text field and accepts no relation, column,
expression, path, URL, host, object key, extension, resource setting, or other
caller-controlled data authority. Unknown URL parameters fail closed before a
request is sent and are not echoed into the page.

Every successful terminal receipt shows the immutable release ID, exact named
operation, manifest-bound DuckDB version, elapsed milliseconds, bytes scanned,
row count, public evidence count (or an explicit metadata-operation absence),
returned capability, and public limitations. A response whose release ID does
not equal the evaluator's current immutable release is displayed as a terminal
release-mismatch error.

## Evidence language

Every rendered claim uses text and a Lucide icon in addition to semantic color:

- **Supported — direct evidence**: a source record establishes the claim.
- **Supported — derived evidence**: a deterministic versioned calculation over
  cited facts.
- **Proxy — review required**: a useful signal that does not establish the
  requested claim.
- **Partial coverage**: the evidence denominator or time interval is incomplete.
- **Blocked — source/access**: source, authorization, legal, or composition
  constraints prevent proof.
- **Unsupported**: the release does not implement or substantiate the
  capability.

`unknown` results are displayed as **Evidence unknown** and never promoted to a
positive match. Water results retain “potential candidate” wording, ownership
absence does not establish tenure, public owner identity stays redacted, and
straight-line walkability remains a proxy.

## Responsive and accessibility contract

- Semantic tokens drive both dark and light themes.
- The desktop layout uses a persistent sidebar at 1024px and above. Smaller
  viewports use a five-item bottom navigation plus an all-destinations menu.
- The layout is mobile-first and checked at 375, 768, 1024, and 1440 widths.
- Interactive controls have at least 44px targets and visible focus indicators.
- A skip link targets the main landmark; route changes focus the page heading.
- Result tables have captions, headers, and keyboard-scrollable regions. Every
  spatial result also has a non-map ordered-list view with coordinates and route
  basis.
- Loading, empty, invalid-input, API error, and agent-degraded states are
  announced semantically.
- Motion is restricted to short state transitions and is removed under
  `prefers-reduced-motion`.
- The app has no remote font or runtime design dependency.

## Verification

Use Node `22.18.0` explicitly:

```text
pnpm exec prettier --check apps/web docs/ui
pnpm --filter @oracle/web lint
pnpm --filter @oracle/web typecheck
pnpm --filter @oracle/web test
pnpm --filter @oracle/web build
```

Component tests cover production fixture rejection, stable API errors, route
and query behavior, accessible table/spatial views, agent loading/success/error
and no-fallback degradation, selected profile/release/limitations, exact
citations and redacted named-tool traces, the SQL-free console's terminal
metadata and strict authority rejection, explicit test-fixture labeling, direct
route entry, responsive semantic structure, and automated axe smoke checks.
