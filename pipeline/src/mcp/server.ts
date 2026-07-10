/**
 * Oracle Property MCP server (stdio).
 *
 * Mirrors the elephant-mcp shape so any agent that speaks to elephant works here
 * with no changes: a `properties` view queried via two SQL tools, plus a dataset
 * info tool. Reads the published IPFS Parquet (PROPERTY_QUERY_TABLE_MAP) or the
 * local export. Everything is read-only.
 *
 * Run: npm run mcp   (or: npx tsx src/mcp/server.ts)
 * Wire into Cursor/Claude Desktop via the mcp.json snippet in the repo.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  openPropertiesDb,
  COUNTY,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  type PropertiesDb,
} from "./query.js";

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
  };
}

async function main() {
  const db: PropertiesDb = await openPropertiesDb();

  const server = new McpServer({
    name: "oracle-property-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "getPropertyQuerySchema",
    {
      title: "Get property query schema",
      description:
        "Returns the columns, DuckDB types, and one-line descriptions of the `properties` view. Call this first to learn what you can query.",
      inputSchema: { county: z.string().optional().describe("County slug; default santa-clara.") },
    },
    async () => {
      const columns = await db.getSchema();
      return textResult({ county: COUNTY, view: "properties", columns });
    },
  );

  server.registerTool(
    "queryProperties",
    {
      title: "Query properties",
      description:
        `Run ONE read-only SELECT / WITH…SELECT over the \`properties\` view and return rows. ` +
        `Single statement only; mutations are rejected. A row cap applies (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). ` +
        `Use ILIKE for text matching (e.g. address_city ILIKE '%palo alto%').`,
      inputSchema: {
        sql: z.string().describe("A single SELECT/CTE over the `properties` view."),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_LIMIT)
          .optional()
          .describe(`Row cap (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
        county: z.string().optional(),
      },
    },
    async ({ sql, limit }) => {
      try {
        const rows = await db.query(sql, limit);
        return textResult({ rowCount: rows.length, rows });
      } catch (e) {
        return errorResult(String(e instanceof Error ? e.message : e));
      }
    },
  );

  server.registerTool(
    "getOracleDatasetInfo",
    {
      title: "Get dataset info",
      description:
        "Returns dataset provenance: county, property count, and the Parquet source (IPFS URL or local).",
      inputSchema: {},
    },
    async () => textResult(await db.info()),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr so we don't corrupt the stdio JSON-RPC stream
  console.error(`oracle-property-mcp ready (county=${COUNTY}, source=${db.source})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
