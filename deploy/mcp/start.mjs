// Launch elephant-mcp pointed at a LOCAL parquet file when one is present.
//
// Reading the 218MB query-table parquet over the network (from Netlify) on
// Render free-tier egress is slow AND unreliable — DuckDB httpfs range/HEAD
// reads intermittently SSL-fail or time out (self-review round 3, 2026-07-08).
// The build step downloads the parquet next to this file; here we point the
// county map at that local path so queries never touch the network.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const localParquet = join(here, "data.parquet");

if (existsSync(localParquet)) {
  process.env.PROPERTY_QUERY_TABLE_MAP = JSON.stringify({ lee: localParquet });
  console.log(`[oracle-mcp] serving local parquet: ${localParquet}`);
} else {
  console.log(
    "[oracle-mcp] local parquet not found; falling back to " +
      "PROPERTY_QUERY_TABLE_MAP from env (remote reads — may be slow/flaky)",
  );
}

await import("./node_modules/@elephant-xyz/mcp/dist/server-http.js");