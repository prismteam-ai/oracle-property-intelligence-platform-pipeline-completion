/**
 * Deployment configuration. County swaps (e.g. Santa Clara) are pure config:
 * set VITE_QUERY_TABLE_URL and VITE_COUNTY_LABEL in ui/.env.
 */
export const QUERY_TABLE_URL: string =
  import.meta.env.VITE_QUERY_TABLE_URL ||
  'https://ipfs.filebase.io/ipns/k51qzi5uqu5djd4ohcf3qm87dhlt0e270xw8ejhkyia62edr76uj0u05hrf7m5';

export const COUNTY_LABEL: string =
  import.meta.env.VITE_COUNTY_LABEL || 'Lee County, FL';

export const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

/** SQL fragment referencing the remote query table. */
export const TABLE = `read_parquet('${QUERY_TABLE_URL}')`;
