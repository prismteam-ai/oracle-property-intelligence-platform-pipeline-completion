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

---

## Implementation (this PR)

Santa Clara County pipeline completion with hybrid ingest (Elephant IPFS seeds + SCC Socrata parcels + OpenStreetMap POIs), DuckDB parquet query table, Flask demo UI, `@elephant-xyz/mcp` HTTP serve, and optional AWS CloudFormation deploy.

**Branch:** `eran/property_pipeline`

### Quick start (local demo)

```bash
cp .env.example .env
./scripts/run.sh pipeline          # build data/properties.parquet
./scripts/run.sh ui-start          # http://localhost:3000
./scripts/run.sh ui-mcp-start      # http://localhost:8000/mcp (optional)
./scripts/run.sh test              # 38 acceptance tests
```

If the dataset is missing, open the UI and click **Load dataset** (runs the pipeline in the background).

### Demo video

Short local walkthrough (~35s) following the README demo transcript:

- **File:** [`demo/oracle-property-intelligence-demo.webm`](demo/oracle-property-intelligence-demo.webm)
- **Re-record:** `./scripts/run.sh record-demo` (with UI running)

Scenes: dashboard stats → run summary → IPFS/about → interactive sandbox (roof + transit filters) → explore → agent prompts.

### Assumptions and limitations

| Topic | Assumption / limitation |
|-------|-------------------------|
| **County scope** | Santa Clara County (includes Palo Alto). Five cities enriched via Socrata open data (`ubcd-cewv`). |
| **Property & permit backbone** | Elephant-published IPFS seeds (`QmRTMf9cw2wKmYZVXE3yJTNNY7GU9uvoiRaVRrWxcMmssA` properties, permit IPNS). |
| **Coordinates** | ~100k parcels matched to Socrata geometry by APN; remaining parcels lack real lat/lon. |
| **Ownership / sale dates** | California assessor bulk data withholds owner names and last-sale dates. Ownership tenure uses permit dormancy and owner-text signals — not recorded deed transfers. |
| **Contractor data** | Sparse (14 signals from permit text); county portal coverage is uneven. |
| **Water view** | OSM water-feature proximity ≤500m — labeled proxy, not line-of-sight. |
| **Transit / Starbucks distance** | Haversine meters from parcel coordinates to nearest OSM node. |
| **Roof age** | Years since last roof permit issue date — not assessor roof material. |
| **IPFS publish** | Without Filebase `S3_*` keys, manifest uses local SHA-256 CIDs. Real IPFS CIDs require Filebase credentials in `.env`. |
| **Hosted database** | None by default — DuckDB over local/S3 parquet. No RDS or Neon required for demo. |
| **Elephant skills `onboard-county`** | Not run end-to-end; pipeline uses direct HTTP/IPFS/Socrata/OSM connectors. Full skill path needs company Neon + Filebase + AWS. |
| **Cursor Elephant MCP** | Requires `./scripts/fix-cursor-elephant-mcp.sh` and Soofi plugin enabled in Cursor. |

Documented in UI basis notes on `/explore` and `/sandbox`, and in `data/run_summary.json` constraints.

### AWS deployment — what is ready vs what you need

Deploy templates and scripts are included (`deploy/aws/`, `./scripts/run.sh deploy-aws`) but **this submission was built and demoed locally** without a company AWS account.

**Already in the repo**

- CloudFormation stack: S3 artifact bucket + ECS Fargate (UI + MCP) + ALB (`/` → UI, `/mcp` → MCP)
- Docker images: `deploy/ui/Dockerfile`, `deploy/mcp/Dockerfile`
- `docker-compose.yml` for local prod smoke test
- `scripts/deploy-aws.sh` — build, push ECR, deploy stack, upload parquet/manifest

**What a reviewer must add to deploy**

| Requirement | Action |
|-------------|--------|
| **AWS account** | `aws configure` or env credentials; `aws sts get-caller-identity` must succeed |
| **Docker** | Running locally for image build/push |
| **Pipeline artifacts** | Run `./scripts/run.sh pipeline` first (creates `data/properties.parquet`, `manifest.json`) |
| **Deploy** | `./scripts/run.sh deploy-aws` |
| **Post-deploy URL** | Note ALB DNS from stack outputs; open `http://<alb>/` for demo |

**Optional — real IPFS CIDs (not required for AWS UI)**

Fill in `.env` (from `.env.example`):

```bash
S3_ENDPOINT=https://s3.filebase.io
S3_BUCKET=<your-bucket>
S3_ACCESS_KEY_ID=<key>
S3_SECRET_ACCESS_KEY=<secret>
FILEBASE_IPNS_LABEL=oracle-query-table-santa-clara
```

Then re-run pipeline publish so `manifest.json` has Filebase/IPFS gateway URLs instead of `local-sha256-*` placeholders.

**Optional — HTTPS**

Add ACM certificate + ALB listener on 443 (template currently serves HTTP on 80).

**Cost if left running**

~$15–25/mo Fargate (2 small tasks) + ~$16/mo ALB + S3 storage. Scale ECS `DesiredCount` to 0 or delete the stack after review.

See [`deploy/aws/README.md`](deploy/aws/README.md) for full deploy steps.

### Acceptance tests

```bash
./scripts/run.sh servers   # check UI :3000 and MCP :8000
./scripts/run.sh test      # 38 tests (31 README + 7 Cursor Elephant MCP)
```

