// Launch elephant-mcp pointed at LOCAL parquet files, one per county.
//
// Reading the query-table parquet over the network on free-tier egress is slow
// AND unreliable — DuckDB httpfs range/HEAD reads intermittently SSL-fail or
// time out (self-review round 3, 2026-07-08). The build step downloads each
// county's parquet next to this file; here we point the county map at those
// local paths so queries never touch the network.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// county key -> local parquet filename (downloaded at build time)
const COUNTIES = {
  "santa-clara": "santa-clara.parquet", // the deliverable county (contains Palo Alto) — the ONLY county the public MCP serves
};

const map = {};
for (const [county, file] of Object.entries(COUNTIES)) {
  const path = join(here, file);
  if (existsSync(path)) map[county] = path;
}

if (Object.keys(map).length > 0) {
  process.env.PROPERTY_QUERY_TABLE_MAP = JSON.stringify(map);
  process.env.ORACLE_OPEN_DATA_DEFAULT_COUNTY = "santa-clara";
  console.log(`[oracle-mcp] serving local parquets: ${JSON.stringify(map)}`);
} else {
  console.log(
    "[oracle-mcp] no local parquets found; falling back to " +
      "PROPERTY_QUERY_TABLE_MAP from env (remote reads — may be slow/flaky)",
  );
}

await import("./node_modules/@elephant-xyz/mcp/dist/server-http.js");
