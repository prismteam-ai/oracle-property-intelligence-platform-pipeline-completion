/**
 * Deployment configuration. County swaps (e.g. Santa Clara) are pure config:
 * set VITE_QUERY_TABLE_URL and VITE_COUNTY_LABEL in ui/.env.
 */
export const QUERY_TABLE_URL: string =
  import.meta.env.VITE_QUERY_TABLE_URL ||
  'https://oracle-parquet-host.netlify.app/lee-query-table.parquet';

export const COUNTY_LABEL: string =
  import.meta.env.VITE_COUNTY_LABEL || 'Lee County, FL';

export const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

/** Base URL of the Oracle agent's A2A endpoint (JSON-RPC + agent card). */
export const AGENT_A2A_URL: string =
  import.meta.env.VITE_AGENT_A2A_URL || 'http://localhost:8788';

/** SQL fragment referencing the remote query table. */
export const TABLE = `read_parquet('${QUERY_TABLE_URL}')`;
