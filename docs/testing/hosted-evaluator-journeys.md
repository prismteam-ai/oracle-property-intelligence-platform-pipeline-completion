# Hosted evaluator Playwright journeys

Status: Wave 3B evaluator contract. These tests are read-only and release-bound.

## Purpose

`apps/e2e` exercises the evaluator as a grader sees it: direct HTTPS navigation,
immutable release labels, evidence semantics, deep-link refresh, keyboard use,
responsive layouts, and explicit degraded states. Assertions prefer roles,
accessible names, release identifiers, capability labels, evidence identifiers,
and route state. Screenshots are optional evidence; they are never the primary
pass condition.

The suite covers:

- cheap API health without a release query;
- overview, pipeline, coverage, property explorer, property detail, and evidence;
- all six named inquiry routes and their truth labels;
- deterministic combined ranking components;
- named-tool agent trace or an honest no-fallback degraded state;
- artifacts, data dictionary, capability/limitation, MCP, release-evidence, and
  architecture routes;
- direct navigation and refresh for every public deep link;
- invalid inquiry input without a positive result claim;
- skip-link, visible focus, active-navigation, and keyboard-only property flow;
- 375 px mobile, 768 px tablet, 1440 px desktop, and 812 x 375 landscape;
- 44 px form/control touch targets, no horizontal overflow, and reduced motion;
- optional full-page evidence screenshots and optional axe serious/critical checks.

## Toolchain

Use the repository-pinned Node `22.18.0` and pnpm `10.33.0`. In PowerShell,
prepend the installed Node directory for every command:

```powershell
$env:Path = 'E:\nvm\v22.18.0;' + $env:Path
node --version
pnpm --version
```

The expected Node output is exactly `v22.18.0`.

## Deterministic local lane

The local lane starts the built Vite preview at `http://127.0.0.1:4173` and a
cheap health fixture at `http://127.0.0.1:4174`. Browser POSTs to the frozen
application operations are intercepted with a deterministic test adapter.
Fixture responses carry the HTTP header
`x-oracle-fixture: TEST_ONLY_DETERMINISTIC_FIXTURE`, use test-prefixed release
identifiers, and never become a production fallback.

```powershell
$env:Path = 'E:\nvm\v22.18.0;' + $env:Path
$env:ORACLE_E2E_TARGET = 'local'
Remove-Item Env:ORACLE_E2E_BASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:ORACLE_E2E_API_BASE_URL -ErrorAction SilentlyContinue
pnpm --filter @oracle/e2e test
```

To use already-running loopback services, set both loopback URLs and disable
the managed servers explicitly:

```powershell
$env:ORACLE_E2E_TARGET = 'local'
$env:ORACLE_E2E_BASE_URL = 'http://127.0.0.1:4173'
$env:ORACLE_E2E_API_BASE_URL = 'http://127.0.0.1:4174'
$env:ORACLE_E2E_SKIP_WEB_SERVER = '1'
pnpm --filter @oracle/e2e test
```

The local target rejects non-loopback URLs.

## Hosted lane

Hosted runs have no default URL. Both the web and API origins must be explicit
HTTPS URLs without credentials, query strings, fragments, or loopback hosts.
This prevents an accidental run against an inferred preview, provider console,
or unrelated environment.

```powershell
$env:Path = 'E:\nvm\v22.18.0;' + $env:Path
$env:ORACLE_E2E_TARGET = 'hosted'
$env:ORACLE_E2E_BASE_URL = 'https://<explicit-cloudfront-host>'
$env:ORACLE_E2E_API_BASE_URL = 'https://<explicit-api-host>'
pnpm --filter @oracle/e2e test
```

The hosted health test requires `readiness: ready`, `fixture: null`, and
`dataQueryPerformed: false`. Browser pages must not display
`TEST_ONLY_DETERMINISTIC_FIXTURE`. A hosted agent journey may perform one
read-only named-evidence prompt; it never dispatches provider effects, publishes
artifacts, mutates IPNS/public data, changes cloud configuration, or writes a
dataset. If the exact promoted model is unavailable, the test accepts only an
explicit degraded/no-fallback presentation.

## Targeted commands

Use the smallest relevant command during iteration:

```powershell
$env:Path = 'E:\nvm\v22.18.0;' + $env:Path
pnpm --filter @oracle/e2e exec playwright test tests/health.spec.ts --project evaluator-desktop
pnpm --filter @oracle/e2e exec playwright test tests/evaluator-flow.spec.ts --project evaluator-desktop
pnpm --filter @oracle/e2e exec playwright test tests/keyboard.spec.ts --project evaluator-desktop
pnpm --filter @oracle/e2e exec playwright test tests/responsive.spec.ts
```

Static package verification is:

```powershell
$env:Path = 'E:\nvm\v22.18.0;' + $env:Path
pnpm exec prettier --check apps/e2e docs/testing/hosted-evaluator-journeys.md
pnpm --filter @oracle/e2e lint
pnpm --filter @oracle/e2e typecheck
pnpm --filter @oracle/e2e build
```

## Optional evidence

Generated Playwright reports, traces, screenshots, videos, and test results are
ignored by the repository and must not be committed.

Set `ORACLE_E2E_SCREENSHOTS=1` to capture an overview screenshot in the current
test output directory. To run axe without adding a dependency or changing a
manifest, point `ORACLE_E2E_AXE_SCRIPT_PATH` at an existing absolute local
`axe.min.js` file. The suite injects that local file and rejects serious or
critical violations:

```powershell
$env:ORACLE_E2E_SCREENSHOTS = '1'
$env:ORACLE_E2E_AXE_SCRIPT_PATH = 'C:\absolute\path\to\axe.min.js'
pnpm --filter @oracle/e2e exec playwright test tests/routes.spec.ts --project evaluator-desktop
```

No script is downloaded at test time and no external analytics runtime is used.

## Stable route and selector contract

The route matrix is frozen in `apps/e2e/support/routes.ts`. Tests select by
landmarks, heading/name roles, labels, `aria-current`, and route hrefs. The only
test-specific hooks are `data-release-id` or `data-testid="release-id"` for the
immutable release identifier. Every public route provides:

- one visible `main` landmark and one level-one heading;
- a skip link and keyboard-reachable primary navigation;
- a visible immutable release identifier;
- exact textual truth labels rather than color-only status;
- visible loading, error, empty, or degraded feedback where applicable.

The route contract is `/`, `/pipeline`, `/coverage`, `/properties`, the six
`/inquiries/*` routes, `/rankings`, `/agent`, `/artifacts`, `/dictionary`,
`/capabilities`, `/mcp`, `/evidence`, and `/about/architecture`. Property results
link to `/properties/:propertyId` and expose evidence on the detail route.

## Production-composition gap

Committed Wave 3A API `b92e2a0`, MCP `2c872c1`, and agent `5399fc2` deliberately
fail closed because their default production composition does not yet inject an
executable, verified immutable-release six-inquiry query service. The separately
authorized inquiry-adapter recovery owns that missing query-core implementation.

Therefore:

- local fixture success proves browser behavior and the committed injected API
  contract only;
- it does not prove DuckDB parity, a live county release, MCP tool execution, or
  Bedrock qualification;
- hosted tests must receive the explicit production web/API URLs and must see a
  ready, non-fixture release before they can close runtime verification;
- the suite never substitutes deterministic fixture rows for a hosted response
  and never upgrades a blocked/partial/proxy capability label.
