# Oracle Property MCP server

An [MCP](https://modelcontextprotocol.io) server that lets any MCP-capable agent
(Cursor, Claude Desktop, Claude Code, …) query the Palo Alto property dataset.
It mirrors the `@elephant-xyz/mcp` contract, so an agent written for elephant
works here unchanged.

It reads the `properties` Parquet **directly from public IPFS** (Filebase
gateway) via DuckDB `httpfs` range reads — there is no hosted database.

## Tools

| Tool | Purpose |
|---|---|
| `getPropertyQuerySchema` | Column names + DuckDB types + one-line descriptions of the `properties` view. Call this first. |
| `queryProperties` | Run ONE read-only `SELECT` / `WITH…SELECT` over `properties`. Single statement, SELECT/CTE only, row cap (default 100, max 1000). |
| `getOracleDatasetInfo` | County, property count, and the Parquet source URL. |

## Prerequisites

- Node.js 22+
- Install the server's dependencies once:
  ```bash
  cd pipeline && npm install
  ```

## Run it standalone (stdio)

From the repository root:

```bash
PROPERTY_QUERY_TABLE_MAP='{"santa-clara":"https://ipfs.filebase.io/ipfs/QmYa6qQA4VNY2HZzt25ABHMziaZeTz128Y476cF3iAUtF6"}' \
  npx tsx ./pipeline/src/mcp/server.ts
```

With no `PROPERTY_QUERY_TABLE_MAP` set it serves the local
`pipeline/data/export/properties.parquet` instead of IPFS.

It speaks JSON-RPC over stdio; you normally don't run it by hand — an MCP client
launches it (below).

## Wire it into Cursor

The repo ships a ready [`mcp.json`](./mcp.json) at the root. Open the project in
Cursor and enable the **`oracle`** server under Settings → MCP. (Cursor launches
it with the project root as the working directory, so the relative path resolves.)

## Wire it into Claude Desktop

Add this to `claude_desktop_config.json` (use the **absolute** path to this repo):

```json
{
  "mcpServers": {
    "oracle": {
      "command": "npx",
      "args": ["tsx", "/ABSOLUTE/PATH/TO/oracle-property-intelligence-platform-pipeline-completion/pipeline/src/mcp/server.ts"],
      "env": {
        "PROPERTY_QUERY_TABLE_MAP": "{\"santa-clara\":\"https://ipfs.filebase.io/ipfs/QmYa6qQA4VNY2HZzt25ABHMziaZeTz128Y476cF3iAUtF6\"}"
      }
    }
  }
}
```

Restart Claude Desktop; the `oracle` tools appear in the tool picker.

## Wire it into Claude Code

```bash
# from the repo root
claude mcp add oracle \
  --env PROPERTY_QUERY_TABLE_MAP='{"santa-clara":"https://ipfs.filebase.io/ipfs/QmYa6qQA4VNY2HZzt25ABHMziaZeTz128Y476cF3iAUtF6"}' \
  -- npx tsx ./pipeline/src/mcp/server.ts
```
Omit `--env …` to serve the local Parquet instead of IPFS.

## Wire it into Codex

Add to `~/.codex/config.toml` (use the **absolute** path to this repo):

```toml
[mcp_servers.oracle]
command = "npx"
args = ["tsx", "/ABSOLUTE/PATH/TO/oracle-property-intelligence-platform-pipeline-completion/pipeline/src/mcp/server.ts"]

[mcp_servers.oracle.env]
PROPERTY_QUERY_TABLE_MAP = "{\"santa-clara\":\"https://ipfs.filebase.io/ipfs/QmYa6qQA4VNY2HZzt25ABHMziaZeTz128Y476cF3iAUtF6\"}"
```

Then the `oracle` tools are available to Codex agents.

## Example agent queries

Once connected, ask the agent things like:

- "Call getPropertyQuerySchema, then find properties with roof_over_15 and near_starbucks."
- "How many Palo Alto properties are permit-dormant for 10+ years?"
- "Which properties are near transit AND likely have roofs over 15 years? Return address + APN."

Under the hood the agent calls:

```sql
SELECT request_identifier, address_house_number, address_street, roof_basis, nearest_starbucks_m
FROM properties
WHERE roof_over_15 AND near_starbucks
ORDER BY nearest_starbucks_m
```

## Honesty notes the agent should respect

- `permit_dormant_10yr` is a **proxy** for "no sale in 10 years" — last-sale dates
  are not free open data in California. It is not a recorded sale.
- `owners_text` is always NULL and `owner_data_available` is FALSE — owner mailing
  address is not free open data (CA R&T Code §408), so "regional owner" can't be answered.
- `water_view` is a 150 m proximity heuristic, not a verified sightline.
