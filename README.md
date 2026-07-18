# Oracle Property Intelligence Platform Pipeline Completion

## Context

The Oracle ingestion pipeline has been started, but the full dataset has not been completely uploaded, reconciled, or demonstrated. The infrastructure must be designed so Oracle does not carry ongoing infrastructure cost by default. For this candidate, they are acting as both the Oracle and the builder, so they are responsible for completing the pipeline and proving the infrastructure approach.

## Description

Complete the Oracle pipeline by loading all available county property, permit, ownership, business, contractor, location, and public-source data into an MCP-ready database, using IPFS and DuckDB to minimize Oracle-hosted infrastructure costs while enabling UI and agent access to answer property intelligence questions.

## Acceptance Criteria
- Run the Oracle pipeline until all available county data is uploaded.
- Confirm the pipeline covers the county that includes Palo Alto, CA.
- Load available property records into the database.
- Load available permit records into the database.
- Load available ownership records into the database.
- Load available contractor records into the database.
- Load available business records into the database.
- Load available location and coordinate data into the database.
- Reconcile duplicate entities across all uploaded datasets.
- Preserve source provenance for uploaded records.
- Optimize pipeline performance where feasible.
- Identify slow source sites or constrained contractor data sources.
- Document pipeline speed limitations and source constraints.
- Design the infrastructure so Oracle does not carry ongoing infrastructure cost by default.
- Use IPFS for decentralized storage of eligible dataset artifacts.
- Use DuckDB for local or portable analytical querying.
- Structure the database to support MCP access.
- Enable agent access to query the database.
- Provide a UI for exploring the uploaded data.
- Support questions about properties with roofs older than 15 years.
- Support questions about properties with a view of water.
- Support questions about properties that have not exchanged ownership in more than 10 years.
- Support questions about properties with regional owners.
- Support questions about properties within walking distance of public transportation using property coordinates.
- Support questions about properties within walking distance of Starbucks using property coordinates.
- Return source-backed answers where source data is available.
- Demonstrate the uploaded dataset through the UI.
- Demonstrate the uploaded dataset through an agent query.
- Demonstrate that Oracle can operate without carrying the infrastructure cost.
- Confirm the candidate fulfilled both Oracle and builder responsibilities for this milestone.
- Pass the demo using real uploaded county records.

## Demo Transcript
- Presenter: “I will demonstrate that the Oracle pipeline has loaded the full available dataset for the county that includes Palo Alto, that the data is queryable through DuckDB, that eligible artifacts are stored through IPFS, and that both the UI and agent can answer property intelligence questions.”
- Presenter: “First, I am opening the pipeline run summary.”
  - Expected Result: The system displays the completed pipeline run, source list, record counts, timestamps, and any documented source limitations.
- Presenter: “Show the total uploaded records by source.”
  - Expected Result: The system shows uploaded property, permit, ownership, contractor, business, and coordinate records with collection timestamps and provenance.
- Presenter: “Now I am opening the DuckDB-backed query layer.”
  - Expected Result: The system confirms that the loaded data is available for structured querying without requiring Oracle-hosted database infrastructure.
- Presenter: “Show the IPFS artifacts created for the uploaded datasets.”
  - Expected Result: The system displays IPFS references or content identifiers for eligible dataset artifacts.
- Presenter: “Now I am using the UI to search for properties with roofs older than 15 years.”
  - Expected Result: The UI returns matching properties, supporting permit or property evidence, and source provenance where available.
- Presenter: “Show properties with a view of water.”
  - Expected Result: The UI returns properties identified using available location, parcel, or geographic indicators and explains the source basis.
- Presenter: “Show properties that have not exchanged ownership in more than 10 years.”
  - Expected Result: The system returns properties with ownership history showing no recorded exchange within the last 10 years.
- Presenter: “Show properties with regional owners.”
  - Expected Result: The system returns properties where owner location or ownership metadata indicates a regional owner.
- Presenter: “Show properties within walking distance of public transportation.”
  - Expected Result: The system uses property coordinates to return properties near public transportation and shows the distance calculation basis.
- Presenter: “Show properties within walking distance of Starbucks.”
  - Expected Result: The system uses property coordinates and nearby place data to return properties near Starbucks locations and shows the distance calculation basis.
- Presenter: “Now I am asking the same type of questions through the agent.”
  - Agent Prompt: “Which properties have roofs older than 15 years and have not exchanged ownership in more than 10 years?”
    - Expected Result: The agent returns matching properties, explains the reasoning, and includes source-backed evidence.
  - Agent Prompt: “Which properties are near public transportation and also have regional owners?”
    - Expected Result: The agent returns matching properties with coordinate-based distance logic and ownership evidence.
  - Agent Prompt: “Which properties appear to be strong candidates for further review based on ownership age, roof age, and location signals?”
    - Expected Result: The agent returns a ranked or filtered list using available data and clearly identifies any assumptions or missing data.
- Presenter: “Finally, I will show that the system is MCP-ready.”
  - Expected Result: The system demonstrates an MCP-ready interface or documented MCP-compatible query structure that agents can use without changing the data model.

## Reference
- [Soofi XYZ Team Kit](https://github.com/soofi-xyz/soofi-xyz-team-kit)
- [Elephant Oracle Skills](https://github.com/elephant-xyz/skills)

## Implemented evaluator architecture

The evaluator serves one verified immutable Santa Clara County release through
four coordinated, scale-to-zero surfaces:

- a static CloudFront React evaluator;
- a Node 22 Lambda application API over fixed DuckDB operations;
- a stateless Streamable HTTP MCP exposing the same 16 SQL-free operations; and
- a bounded Amazon Bedrock ToolLoopAgent whose versioned adapter injects the
  immutable release, translates only frozen operation fields, redacts to public
  evidence, and returns exact citations plus a named-tool trace.

The UI includes the six assignment inquiries, transparent deterministic
ranking, `/agent`, and `/query-console`. The console accepts fixed named
operations and structured filters only; it has no arbitrary SQL, relation,
path, URL, host, or object-locator input. Restricted artifacts remain isolated
from API, MCP, CloudFront, and the model.

Production has no model fallback. Incomplete Bedrock configuration, semantic
policy drift, adapter/release mismatch, provider failure, or budget exhaustion
must report unavailable/failure and cannot produce a canned answer. The
deterministic fallback used by local tests is explicit test injection and
cannot be selected from production environment variables.

## Deployment outputs and hosted proof

Current endpoints are parent-supplied CDK outputs, not values committed to this
repository: `WebUrl`, `ApiUrl`, `McpUrl`, and `PublicArtifactUrl`. Use all four
from the same deployment; never infer an endpoint from an older stack or doc.

With Node `v22.18.0` and pnpm `10.33.0`:

```powershell
$env:PATH = 'E:\nvm\v22.18.0;' + $env:PATH
$env:ORACLE_E2E_TARGET = 'hosted'
$env:ORACLE_E2E_BASE_URL = 'https://<WebUrl-host>'
$env:ORACLE_E2E_API_BASE_URL = 'https://<ApiUrl-host>'
$env:ORACLE_E2E_MCP_URL = 'https://<exact-McpUrl-output-ending-in-mcp>'
$env:ORACLE_E2E_PUBLIC_ARTIFACT_BASE_URL = 'https://<PublicArtifactUrl-host>'
pnpm --filter @oracle/e2e test
```

The hosted gate requires ready query-free API/MCP health, API/MCP/manifest
release parity, `initialize -> tools/list -> tools/call`, strict schema
rejection, public artifact `HEAD`/range/SHA-256, SPA deep links, and one
successful bounded agent answer with the actual model/profile, named-tool trace,
citations, and release continuity. Degraded agent status fails this gate.

See [hosted evaluator checks](docs/testing/hosted-evaluator-journeys.md),
[agent contract](docs/agent/README.md), [API contract](docs/api/application-api.md),
[MCP contract](docs/mcp/README.md), and the
[recording walkthrough](docs/demo/oracle-evaluator-walkthrough.md).

## Current limitations

- Capability states depend on the immutable release. Missing redistributable
  ownership evidence remains blocked/unknown; absence never proves long tenure.
- Water proximity is a review candidate and does not prove a view. Straight-line
  walkability is a proxy unless network-route evidence is present.
- Public regional-owner evidence is coarse and never exposes raw owner identity.
- Bedrock availability and model access require a separately promoted exact
  inference profile, least-privilege IAM, and the matching semantic-policy hash.
- The repository does not claim a demo video exists. Record one only after the
  parent deploys and the mandatory hosted suite passes.
