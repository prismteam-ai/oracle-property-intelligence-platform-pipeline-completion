# Oracle Property Intelligence Platform — Submission

Completes the Oracle pipeline for **Santa Clara County, CA** (the county containing
Palo Alto): county public-record ingest → entity reconciliation with preserved
provenance → publish to IPFS → query via DuckDB → explore through a UI and an
agent. **Zero standing infrastructure cost** — static hosting + scale-to-zero
compute + free IPFS pinning.

## Live runtime (public, no login)

| Surface | URL |
|---|---|
| Exploration UI | https://oracle-property-ui.netlify.app |
| MCP endpoint | https://oracle-mcp.whitewave-2a3d27b9.eastus2.azurecontainerapps.io/mcp |
| Agent (A2A) | https://oracle-agent.whitewave-2a3d27b9.eastus2.azurecontainerapps.io |
| Agent card | https://oracle-agent.whitewave-2a3d27b9.eastus2.azurecontainerapps.io/.well-known/agent-card.json |

## Demo walkthrough (mirrors the README demo transcript)

1. **Pipeline run summary** → **`/run`** — sources, live record counts, entity
   reconciliation (portfolio owners), IPFS artifact CIDs, and the documented
   source constraints. Every number is generated from a live query, not authored.
2. **DuckDB query layer** → **`/search`** — every filter composes into one
   client-side DuckDB-WASM query over the content-addressed Parquet (no backend DB).
3. **IPFS artifacts** → **`/about`** — the dataset Parquet CID plus per-property
   CIDs; all resolve on any public gateway (e.g. `https://ipfs.io/ipfs/<cid>`).
4.–9. **The six questions** → `/search` presets: roofs > 15 yr, view of water,
   no ownership change > 10 yr, regional owners, within walking distance of
   transit, within walking distance of Starbucks.
10. **Agent** → **`/ask`** — three compound prompts (roof + tenure; transit +
    regional owner; ranked review candidates). The agent writes and runs SQL,
    returns source-backed matches, and states its assumptions and coverage limits.
11. **MCP-ready** → **`/about`** — drop-in config to point Claude Desktop / Cursor
    at the public MCP and query the Oracle as a peer.

## Architecture — zero standing infrastructure cost

- **UI + query Parquet**: static on Netlify (CDN, HTTP range reads).
- **IPFS**: the dataset Parquet + a per-property sample are pinned (Pinata) and
  addressed by content hash (`property_cid`), resolvable on any gateway.
- **Query**: DuckDB-WASM in the browser and DuckDB embedded in the MCP server
  (Azure Container Apps, scale-to-zero capable) — no always-on database.
- **Agent**: A2A endpoint (Google ADK), answering over the MCP query layer.

## Data sources (Santa Clara County)

| Dataset | Source |
|---|---|
| Parcels + coordinates (≈495k) | Santa Clara County open data (Socrata) |
| Assessor per-parcel: transfer date, owner mailing address, assessed values | County Assessor public property lookup |
| Year built + flood zone | MTC / ABAG regional parcel dataset |
| Building permits | City of San Jose open data |
| Businesses + contractors + transit / Starbucks / water POIs | OpenStreetMap |

Reconciliation joins all sources on a normalized APN, and reconciles **owner
entities** across parcels (owners deduped by mailing address → portfolio owners).
Every served row carries `source_system` and `property_cid` provenance.

## Documented constraints (honest gaps)

- Assessor per-parcel records are behind a reCAPTCHA-gated public lookup — the
  **Palo Alto core** is fully enriched; full-county coverage is the identical
  operation at scale.
- **Owner names** are withheld by California privacy law on the public lookup, so
  ownership questions use owner **location** (mailing city/state), never a name.
- **Business / contractor** records come from OpenStreetMap (authoritative CA SOS
  and CSLB bulk data are paid).
- **"View of water"** is a labeled **proximity proxy** (distance to the nearest
  named water body), not a verified line-of-sight view.
- **Permits** cover the City of San Jose; other city portals have no bulk export.

## Connect your own agent (MCP-ready)

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "oracle-property-intelligence": {
      "command": "npx",
      "args": ["-y", "mcp-remote",
        "https://oracle-mcp.whitewave-2a3d27b9.eastus2.azurecontainerapps.io/mcp"]
    }
  }
}
```

**Cursor** — `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "oracle-property-intelligence": {
      "url": "https://oracle-mcp.whitewave-2a3d27b9.eastus2.azurecontainerapps.io/mcp"
    }
  }
}
```

Then ask, e.g., *"Using the oracle tools, how many parcels are in Palo Alto?"* —
the agent calls `queryProperties(county, sql)` against the live data.

## Repository layout

| Path | What |
|---|---|
| `ingest/santa-clara/` | ingest pipeline — harvest, merge/enrich, owner reconciliation, IPFS publish, run-summary generation |
| `agent/` | the A2A agent (+ `test_agent.py`, an end-to-end smoke test) |
| `ui/` | the exploration UI (React + DuckDB-WASM) |
| `deploy/mcp/` | the MCP server container |
| `.mcp.json` | MCP server configuration (environment-variable references only) |
