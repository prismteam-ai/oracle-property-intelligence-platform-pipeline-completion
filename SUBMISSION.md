# Oracle Property Intelligence Platform — Submission

Completes the Oracle pipeline for **Santa Clara County, CA** (the county containing
Palo Alto): county public-record ingest → entity reconciliation with preserved
provenance → publish to IPFS → query via DuckDB → explore through a UI and an
agent. **Publicly reachable at a URL; no standing database, near-zero
infrastructure cost.**

**Anchored to `README.md`.** README.md is the acceptance contract — its
acceptance-criteria list and its demo transcript. Everything below traces back to
it, not to a derived plan: the demo video follows the transcript in order, and the
six questions are the transcript's six questions, each shown with the exact
"basis" / "Expected Result" the README asks for.

## Demo video (two parts)

- **Part 1 — UI + agent walkthrough** (run summary → DuckDB query layer → IPFS
  artifacts → the six questions → the `/ask` agent):
  https://www.loom.com/share/9c1d9201d089459089d29513cb1cf5f9
- **Part 2 — MCP-ready, live** (an external agent — Claude Desktop — calls the
  Oracle's MCP tools and queries the data):
  https://www.loom.com/share/abaa2512057e41c0b72ba12fed4596af

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
3. **IPFS artifacts** → **`/about`** and **`/search`** — the dataset Parquet CID
   plus all ~20,912 per-property CIDs. Open a record → **View source documents on
   IPFS ↗** resolves that property's JSON by CID.
4.–9. **The six questions** → `/search` presets: roofs > 15 yr, view of water,
   no ownership change > 10 yr, regional owners, within walking distance of
   transit, within walking distance of Starbucks. Each shows a count, a labeled
   basis note, and a concrete matching row.
10. **Agent** → **`/ask`** — three compound prompts (roof + tenure; transit +
    regional owner; ranked review candidates). The agent writes and runs SQL,
    returns source-backed matches, and states its assumptions and coverage limits.
11. **MCP-ready** → **`/about`** + **Part 2 video** — drop-in config to point
    Claude Desktop / Cursor at the public MCP and query the Oracle as a peer.

## Architecture — near-zero infrastructure cost

- **UI + query Parquet**: static on Netlify (CDN, HTTP range reads).
- **IPFS**: the dataset Parquet + **all ~20,912 per-property JSONs** are pinned on
  our **own kubo IPFS node** (Azure) and addressed by content hash (`property_cid`).
  The app links to our own gateway for reliable direct serving; the CIDs are
  standard and resolvable by any IPFS client. Free pinning services (Pinata /
  Filebase) cap at ~500–1,000 objects, which is why we self-host the node.
- **Query**: DuckDB-WASM in the browser and DuckDB embedded in the MCP server —
  **no database at all**.
- **Agent**: A2A endpoint (Google ADK + Azure GPT-5.4), answering over the MCP layer.
- **The one bounded cost (disclosed)**: three small containers — MCP, agent, and
  the kubo IPFS node — run on **free Azure credits**. The MCP + agent are
  scale-to-zero capable (kept at one warm replica during the trial for demo
  reliability); the IPFS node stays up because a gateway must serve. Nothing is
  vendor-locked — the stack re-attaches to AWS / Cloud Run / any host by config.

## Data sources (Santa Clara County)

| Dataset | Source |
|---|---|
| Parcels + coordinates (≈495k) | Santa Clara County open data (Socrata) |
| Assessor per-parcel: transfer date, owner mailing address, assessed values | County Assessor public property lookup |
| Year built + flood zone | MTC / ABAG regional parcel dataset |
| Building permits | City of San Jose open data |
| Businesses + contractors + transit / Starbucks / water POIs | OpenStreetMap |

Reconciliation joins all sources on a normalized APN (in Python/DuckDB over local
files — no reconciliation database), and reconciles **owner entities** across
parcels (owners deduped by mailing address → portfolio owners). Every served row
carries `source_system` and `property_cid` provenance.

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
the agent calls `queryProperties(county, sql)` against the live data. The public
MCP serves **Santa Clara County only** (the deliverable county); Lee, FL was the
build-time reference implementation and is not exposed.

## Repository layout

| Path | What |
|---|---|
| `ingest/santa-clara/` | ingest pipeline — fetch, harvest, merge/enrich, owner reconciliation, IPFS publish, run-summary generation |
| `agent/` | the A2A agent (+ `test_agent.py`, an end-to-end smoke test) |
| `ui/` | the exploration UI (React + DuckDB-WASM) |
| `deploy/mcp/`, `deploy/ipfs/` | the MCP server + kubo IPFS node containers |
| `.mcp.json` | MCP server configuration (environment-variable references only) |
