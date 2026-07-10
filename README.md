# Oracle Property Intelligence — Palo Alto

Property-intelligence over **real** Santa Clara County / Palo Alto public data,
with **no ongoing hosted-database cost**: the dataset is published to public
**IPFS** and queried on demand by a **DuckDB** engine — in the browser (UI), in
an agent, and over **MCP**.

> The original assignment brief is preserved in [`ASSIGNMENT.md`](./ASSIGNMENT.md).

```
Sources ──▶ Ingest (DuckDB) ──▶ Transform ──▶ IPFS (Filebase) ──▶ Query
 SCC parcels    raw_records         one row/         Parquet,         UI · Agent · MCP
 PA permits     + provenance        property         no hosted DB     (DuckDB-WASM / httpfs)
 OSM POIs
```

## What's inside

| Piece | Where | What it does |
|---|---|---|
| Ingestion pipeline | `pipeline/` | Connectors → DuckDB `raw_records` with provenance |
| Transform | `pipeline/src/transforms` | Reconcile on APN, compute the 6-question signals, one row per property |
| Publish | `pipeline/src/publish` | Export Parquet, pin to IPFS (Filebase), write `manifest.json` |
| MCP server | `pipeline/src/mcp` | `queryProperties` over the IPFS Parquet — see [`MCP.md`](./MCP.md) |
| Web app | `web/` | Next.js UI: run summary, the 6 questions on a map, agent, IPFS artifacts |

Live dataset (public IPFS, verified):
`properties.parquet` → `https://ipfs.filebase.io/ipfs/QmYa6qQA4VNY2HZzt25ABHMziaZeTz128Y476cF3iAUtF6`
(20,912 properties · 52,157 permits · 870 POIs — see [`manifest.json`](./manifest.json)).

## The six questions & data honesty

Free open data answers four questions directly. Two are constrained by California
law (owner/sale data is not free open data — R&T Code §408), so rather than fake
them, the app is explicit:

| Question | Approach | Data |
|---|---|---|
| Roofs > 15 years | No roofing permit in the last 15 yr (permit history from 2013) | **real** |
| View of water | Parcel centroid within 150 m of an OSM water body (heuristic) | **real** |
| No sale in 10+ years | **Proxy**: no permit activity in 10 yr — *not* a recorded sale | proxy (labeled) |
| Regional (out-of-area) owner | Requires owner mailing address — **not in free open data** | gap (documented) |
| Near public transit | Parcel centroid within ~800 m of an OSM transit stop | **real** |
| Near a Starbucks | Parcel centroid within ~800 m of an OSM Starbucks | **real** |

Every property row carries a `sources` provenance array. If an owner/sale CSV is
later supplied, the file connector ingests it and Q3/Q4 light up with real data —
no code change.

## Data sources (all free)

| Source | Used for | Endpoint |
|---|---|---|
| Santa Clara County Parcels (Socrata) | parcel geometry + APN + situs address | `data.sccgov.org/resource/ubcd-cewv` |
| City of Palo Alto Development Center Permits (Junar) | permit dates, roofing, contractor, APN | `data.paloalto.gov/rest/datastreams/<id>/data.csv` |
| OpenStreetMap (Overpass API) | transit stops, Starbucks, water bodies | `overpass-api.de` (+ mirrors) |

The permit source's advertised host (`api.data.paloalto.gov`) is dead in DNS; the
pipeline uses the live portal export path discovered from the dataview. Owner /
sale / year-built data is paid only (SCC Assessor bulk or a commercial aggregator).

## Run it

### Docker (recommended)

```bash
cp web/.env.example web/.env.local      # fill in ANTHROPIC_API_KEY + AUTH_JWT_SECRET
docker compose up --build
# open http://localhost:3100  ·  login: owner / owner1234
```

The `properties.parquet` is baked into the image, so the app is self-contained —
no pipeline run or external DB needed to demo. The agent ("Ask the data") needs
`ANTHROPIC_API_KEY`; the six preset questions work without it.

### Local dev

```bash
cd web && npm install
cp .env.example .env.local              # fill in keys
npm run fetch-data                      # download the parquet from the cloud bucket
npm run dev                             # http://localhost:3100
```

> The query Parquet is **not committed** — it lives in cloud object storage and
> is pulled by `npm run fetch-data` (the Docker build runs this automatically).
> Primary source is a public **Google Cloud Storage** bucket
> (`gs://dmitriy-konyrev-oracle-property`), with the Filebase/IPFS gateway as an
> automatic fallback. Override with `DATA_URL=…`.

### Re-run the pipeline (optional)

```bash
cd pipeline && npm install
npm run run          # ingest real data -> DuckDB raw_records
npm run build:db     # transforms -> properties table
npm run export       # -> data/export/*.parquet
npm run publish      # pin to IPFS (needs Filebase keys in pipeline/.env)
```

## Query it over MCP

Any MCP-capable agent (Cursor, Claude Desktop, Claude Code, Codex) can query the
dataset — it reads the Parquet straight from IPFS. Copy-paste configs are in
[`MCP.md`](./MCP.md) and in the app's **IPFS artifacts → Connect via MCP** panel.

```bash
cd pipeline && npm install
PROPERTY_QUERY_TABLE_MAP='{"santa-clara":"https://ipfs.filebase.io/ipfs/QmYa6qQA4VNY2HZzt25ABHMziaZeTz128Y476cF3iAUtF6"}' \
  npx tsx ./pipeline/src/mcp/server.ts
```

Tools: `getPropertyQuerySchema`, `queryProperties` (read-only SELECT, row-capped),
`getOracleDatasetInfo`.

## Evaluation

Search relevance is benchmarked in the **Relevance evals** tab: a labeled question
set scores the intent agent (precision/recall/F1 + exact-match) and an
**LLM-as-judge** rates result relevance (0–5). The harness caught and fixed real
bugs — see [`FINDINGS.md`](./FINDINGS.md). Current: 100% intent exact-match, 100%
pass rate, 4.0/5 avg judge relevance.

## Demo credentials

| User | Password | Role |
|---|---|---|
| `owner` | `owner1234` | owner |
| `demo` | `demo1234` | viewer |

No OAuth — env-based demo login (`web/lib/auth.ts`), overridable via `DEMO_*` env vars.

## Repo structure

```
pipeline/   ingestion + transform + publish + MCP server (TypeScript, DuckDB)
web/        Next.js 15 UI (DuckDB-WASM, MapLibre, Anthropic agent)
manifest.json   IPFS CIDs + gateway URLs + PROPERTY_QUERY_TABLE_MAP
mcp.json        MCP server config (points at the IPFS Parquet)
MCP.md          how to connect via MCP
ASSIGNMENT.md   original brief
```

## Design decisions

- **No hosted database.** The query table is a single flat Parquet on IPFS;
  DuckDB range-reads it (server-side via `httpfs`, client-side via DuckDB-WASM).
- **APN reconciliation.** Parcels (`13213051`) and permits (`124-37-065`) are
  joined on a normalized 8-digit APN.
- **Transparent agent.** A dedicated intent agent parses questions into
  structured criteria (shown in the UI) that deterministically build the SQL;
  a second agent explains the results and flags proxies/gaps.
- **Provenance everywhere** — run report, per-property `sources`, documented
  source constraints.
