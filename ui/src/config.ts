/**
 * Deployment configuration.
 *
 * The app is MULTI-COUNTY: the per-county specifics (Parquet URL, label, agent
 * key, POI sets, dimension availability, demo-question honesty text) live in
 * `counties.ts`. This module holds only the county-agnostic endpoints and the
 * raw Parquet URLs the county configs are built from.
 *
 * A county swap is pure config: change the URLs below (or the VITE_* overrides)
 * and the active-county selector wires everything else.
 */

/**
 * Santa Clara County, CA — the deliverable county (contains Palo Alto). Default.
 * NOTE: the Parquet is served `cache-control: immutable`, so the content changes
 * across deploys must ride a NEW cache key — bump `?v=` on every parquet redeploy
 * or returning browsers serve stale data (0-result answers). Match this token to
 * the current parquet content.
 */
export const SANTA_CLARA_PARQUET_URL: string =
  import.meta.env.VITE_SC_QUERY_TABLE_URL ||
  'https://oracle-parquet-host.netlify.app/santa-clara-query-table.parquet?v=20260709-recon';

/** Lee County, FL — the reference implementation (full assessor field set). */
export const LEE_PARQUET_URL: string =
  import.meta.env.VITE_LEE_QUERY_TABLE_URL ||
  'https://oracle-parquet-host.netlify.app/lee-query-table.parquet';

// The app links to OUR OWN kubo IPFS gateway on Azure Container Apps (deploy/ipfs),
// which pins + serves all ~20.9k per-property CIDs + the dataset parquet and returns
// each `/ipfs/<cid>` directly (application/json, ~0.85s). These are standard IPFS
// CIDs — they also resolve on public gateways like ipfs.io — but the app uses our
// own gateway for reliability: public gateways (ipfs.io) get client-side-redirected
// to Fleek's inbrowser.link service-worker gateway, which loops/refreshes on our
// content. Our gateway isn't a "known public gateway", so IPFS-Companion-style
// browser extensions leave it alone and it serves directly every time.
export const IPFS_GATEWAY =
  'https://oracle-ipfs.whitewave-2a3d27b9.eastus2.azurecontainerapps.io/ipfs/';

/** Base URL of the Oracle agent's A2A endpoint (JSON-RPC + agent card). */
export const AGENT_A2A_URL: string =
  import.meta.env.VITE_AGENT_A2A_URL ||
  'https://oracle-agent.whitewave-2a3d27b9.eastus2.azurecontainerapps.io';

/** Public MCP endpoint (JSON-RPC MCP) exposing the queryProperties tool. */
export const MCP_URL: string =
  import.meta.env.VITE_MCP_URL ||
  'https://oracle-mcp.whitewave-2a3d27b9.eastus2.azurecontainerapps.io/mcp';
