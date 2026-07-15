// Launch @elephant-xyz/mcp against the local Santa Clara query-table parquet.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const parquetPath =
  process.env.PARQUET_PATH ?? join(projectRoot, "data", "properties.parquet");
const county = process.env.COUNTY ?? "santa-clara";

if (existsSync(parquetPath)) {
  process.env.PROPERTY_QUERY_TABLE_MAP = JSON.stringify({ [county]: parquetPath });
  console.log(`[oracle-mcp] serving ${county} from ${parquetPath}`);
} else {
  console.warn(
    `[oracle-mcp] parquet not found at ${parquetPath}; run ./scripts/run.sh pipeline`,
  );
}

process.env.PORT = process.env.MCP_PORT ?? process.env.PORT ?? "8000";
await import("@elephant-xyz/mcp/dist/server-http.js");
