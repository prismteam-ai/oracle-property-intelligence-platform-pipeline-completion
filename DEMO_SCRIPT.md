# Demo script (≈2–3 min)

Live URL: **http://89.167.5.247:8091** · login **owner / owner1234**

Each step below = one line from the assignment's Demo Transcript → what to do in the app.

## 0. Intro (Run summary page, `/`)
> "I'll show that the Oracle pipeline loaded the full available dataset for the
> county that includes Palo Alto, that it's queryable through DuckDB, that
> artifacts are on IPFS, and that both the UI and an agent answer property
> questions."

## 1. Pipeline run summary → the `/` page
- Point at the **pipeline flow** (Sources → Ingest → Transform → IPFS → Query) and
  the totals: **73,939 records**.
> "This is the completed run: sources, record counts, timestamps, and the
> documented source constraints."

## 2. Total uploaded records by source → scroll to **Sources loaded**
- Show the table: SCC parcels (20,933), Palo Alto permits 2013–2026 (~52k), OSM POIs.
> "Uploaded property, permit, and coordinate records with collection timestamps
> and provenance." (Also point at **Documented source constraints**.)

## 3. DuckDB query layer → **Explore & Ask** tab
> "The data is queryable through DuckDB — this runs DuckDB-WASM in the browser
> over the Parquet, no hosted database." (Note the At-a-glance counts load live.)

## 4. IPFS artifacts → **IPFS artifacts** tab
- Show the three CIDs + gateway links, and the **Connect via MCP** panel.
> "Eligible datasets are pinned to public IPFS via Filebase — here are the CIDs."

## 5–10. The six questions → back on **Explore & Ask**, click each preset chip
1. **Roofs older than 15 years** — 14,859 results on the map. "From permit history: no roofing permit in 15 years."
2. **View of water** — 242 results. "Parcels within 150 m of water (heuristic)."
3. **No sale in 10+ years** — say the honest line: *"Sale dates aren't free open data in California, so this is a permit-dormancy proxy, clearly labeled."*
4. **Regional (out-of-area) owners** — 0 results. *"Owner mailing address isn't free open data (CA law), so we flag this rather than fake it."*
5. **Near public transit** — 20,683 results.
6. **Near a Starbucks** — 12,346 results.

## 11. Agent queries → type in the Ask box
- **"Which properties have roofs older than 15 years and have not exchanged ownership in more than 10 years?"**
  → parsed intent shows roof + dormancy (proxy); answer flags the ownership caveat.
- **"Which properties are near public transportation and also have regional owners?"**
  → near-transit results; agent flags that regional owner can't be determined.
- **"Which properties are strong candidates for review based on ownership age, roof age, and location signals?"**
  → ranked/filtered list; agent states assumptions and gaps.

## 12. MCP-ready → **IPFS artifacts → Connect via MCP**
- Show the tabs (Cursor / Claude Desktop / Claude Code / Codex) + the 3 tools.
> "It's MCP-ready — any agent queries the same dataset over MCP, reading the
> Parquet straight from IPFS." (Optionally show the **Relevance evals** tab: 100%
> intent exact-match, 4.0/5 judge relevance.)

## Close
> "Real Palo Alto data, DuckDB + IPFS, no hosted database, answered through both a
> UI and an agent — with honest handling of the two questions CA law restricts."

---

### Recording tips
- QuickTime (⌘⇧5) or Loom, full-window, ~2–3 min, narrate the lines above.
- Do one dry run so the DuckDB-WASM + map load once (cached) before recording.
- The agent calls take a few seconds each — pause for them.
