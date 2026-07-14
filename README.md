# Oracle Property Intel — Santa Clara County

Pulls free public county data → dedupes (ETL) → **pins Parquet artifacts to IPFS** →
**DuckDB** materializes tables + precomputed feature marts → web UI (pipeline / chat / data
exploration) + **MCP server** so any agent can query the data as tools.
A rule-based agent answers property-intelligence questions, with Claude (key in Azure Key
Vault) adding narratives and SQL generation for off-bank questions.

## Live URLs (Azure)

| What | URL |
|---|---|
| Web app (Pipeline · Chat · Data Exploration) | https://opi-web.livelyisland-4b7ca71a.westus2.azurecontainerapps.io |
| MCP endpoint (streamable HTTP) | `https://opi-mcp.livelyisland-4b7ca71a.westus2.azurecontainerapps.io/mcp` |

⚠️ The MCP endpoint is currently unauthenticated.

## What was built

```
sources (6 free APIs)
   └─► pipeline/loaders/*        pull + provenance columns (_source, _source_url, _collected_at)
        └─► pipeline/etl.py      dedupe per table + cross-source overlap summary
             └─► pipeline/ipfs_publish.py   add+pin parquet to Kubo → data/manifest.json (CIDs)
                  └─► pipeline/build_db.py  DuckDB: *_ipfs provenance views + materialized tables
                       └─► pipeline/features.py  precomputed marts: feat_roof, feat_stable_owner,
                           feat_regional, feat_water, feat_transit, feat_starbucks
                            ├─► pipeline/server.py  Flask UI + APIs (port 5050)
                            ├─► pipeline/agent.py   NL question → SQL (+ Claude via pipeline/llm.py)
                            └─► pipeline/mcp_server.py  MCP tools (stdio or HTTP)
```

- **Pipeline page** — Pull Data button, per-source progress/limitations, run timestamps,
  ETL dedup summary, IPFS artifact table (CIDs, sizes, pin status, gateway links).
- **Chat page** — question bank (roof >15y, water view, stable ownership, regional owners,
  walk-to-transit/Starbucks, candidate ranking) + raw SQL passthrough; Claude narrates and
  writes DuckDB SQL for anything outside the bank.
- **Data Exploration page** — same question bank as dynamic filters with threshold
  dropdowns, city dropdown, address search, column sorting; filters intersect by
  normalized street address (the open address layer's APN field is null). Raw table
  browsing when no filters are active.
- **MCP tools** — `ask`, `find_properties`, `query_sql`, `list_filters`,
  `pipeline_status`, `list_ipfs_artifacts`.

## Run locally

```bash
pip3 install -r requirements.txt
ipfs daemon &                      # Kubo on localhost:5001/8080 (optional — falls back to local parquet)
python3 -m pipeline.server         # UI at http://127.0.0.1:5050 → click "Pull Data"
python3 -m pipeline.mcp_server     # MCP over stdio (MCP_TRANSPORT=http PORT=8090 for HTTP)
```

Headless: `python3 -m pipeline.run_pipeline` (env `MAX_RECORDS` caps each source; default 25000).

Query: `python3 -c "from pipeline.build_db import query; print(query('SELECT COUNT(*) FROM properties'))"`

## MCP config (Claude Code)

```bash
claude mcp add --transport http oracle-property-intel \
  https://opi-mcp.livelyisland-4b7ca71a.westus2.azurecontainerapps.io/mcp
```

or in `.mcp.json`:

```json
{
  "mcpServers": {
    "oracle-property-intel": {
      "type": "http",
      "url": "https://opi-mcp.livelyisland-4b7ca71a.westus2.azurecontainerapps.io/mcp"
    }
  }
}
```

## Azure resources (subscription "Azure subscription 1", RG `oracle-property-intel-rg`, westus2)

| Resource | Name | Purpose |
|---|---|---|
| Key Vault | `opi-kv-14929` | secret `anthropic-api-key`; apps read it via managed identity (never in code/config) |
| Container Registry | `opiacr14929` | image `opi:v1` (built with `az acr build`) |
| Storage account | `opistore14929` | Azure Files share `opidata` mounted at `/data` (parquet, DuckDB, manifest persist) |
| Container Apps env | `opi-env` | hosts both apps |
| Container App | `opi-web` | gunicorn Flask + **Kubo IPFS sidecar** (`ipfs/kubo:v0.32.1`, ephemeral repo — Azure Files SMB breaks Kubo's chmod; pins re-publish on each pull) |
| Container App | `opi-mcp` | same image, `python -m pipeline.mcp_server`, port 8090 |

Redeploy after code changes:

```bash
az acr build -r opiacr14929 -t opi:v1 .
az containerapp update -g oracle-property-intel-rg -n opi-web --image opiacr14929.azurecr.io/opi:v1
az containerapp update -g oracle-property-intel-rg -n opi-mcp --image opiacr14929.azurecr.io/opi:v1
```

## Sources (all free, programmatic)

| Table | Source | Notes |
|---|---|---|
| properties | CA statewide parcels (ArcGIS FeatureServer), filtered to Santa Clara County cities | APN, situs address, centroid coords |
| permits | San Jose Open Data (CKAN): active / expired / under-inspection building permits | CSV resources |
| ownership | SCC county GIS parcel layer with owner fields | see constraints |
| contractors | CSLB "List by Classification & County" portal | ASP.NET VIEWSTATE postback → XLSX |
| businesses | OpenStreetMap Overpass API (county relation 396501), incl. transit stops | 3 mirror fallback |
| locations | San Jose master address points (395K, lat/long) | APN field is null server-side → address-key matching |

CIDs for pinned artifacts are recorded in `data/manifest.json`.

## Documented source constraints
- `mapservices.sccgov.org` (county's 502K-parcel service) is offline; `gis.sccgov.org` is
  Cloudflare-protected — a statewide parcel mirror is used instead.
- Bulk assessor ownership roll and recorded deeds are not open data; ownership is limited
  to ~231 parcels with public owner fields, and ownership tenure is *inferred from permit
  history* (single owner across 10+ years of permits).
- Permits and address points cover San José only — other SCC cities publish no feeds.
- CSLB has no bulk API: legacy postback, ≤10 classifications/request.
- No bulk business-license dataset exists; OSM community data is used for businesses.
- Default cap: 25,000 records per source (`MAX_RECORDS`).

## Infrastructure cost model
Artifacts are content-addressed on IPFS and re-hostable by anyone from the manifest CIDs.
DuckDB is embedded — no hosted database. Both container apps are right-sized
(web+IPFS sidecar 0.75 vCPU/1.5Gi, MCP 0.25 vCPU/0.5Gi) and **scale to zero when idle**
— you pay only per-second while a request is being served (first request after idle has a
~10–20s cold start). Fixed costs are just ACR Basic (~$5/mo), a few GB of Azure Files, and
Log Analytics (30-day retention). Idle total ≈ **$5–8/mo**; active use adds pennies/hour.
Note: keep the Pipeline page open during a "Pull Data" run — its status polling keeps the
replica alive until the run finishes.
