"use client";

import { useState } from "react";

/**
 * "Connect via MCP" panel — tabbed, copy-paste client configs for the Oracle
 * Property MCP server, wired to the live IPFS Parquet URL from the manifest.
 */

const TOOLS = [
  { name: "getPropertyQuerySchema", desc: "Columns + types of the `properties` view. Call first." },
  { name: "queryProperties", desc: "One read-only SELECT over `properties` (row-capped)." },
  { name: "getOracleDatasetInfo", desc: "County, property count, source URL." },
];

type Client = "Cursor" | "Claude Desktop" | "Claude Code" | "Codex" | "CLI";
const CLIENTS: Client[] = ["Cursor", "Claude Desktop", "Claude Code", "Codex", "CLI"];

const REPO = "/ABSOLUTE/PATH/TO/oracle-property-intelligence-platform-pipeline-completion";

function snippet(client: Client, url: string): string {
  const map = `{"santa-clara":"${url}"}`;
  switch (client) {
    case "Cursor":
      return `// The repo ships mcp.json at its root — enable "oracle" in
// Cursor → Settings → MCP. It points at the IPFS Parquet:
{
  "mcpServers": {
    "oracle": {
      "command": "npx",
      "args": ["tsx", "./pipeline/src/mcp/server.ts"],
      "env": { "PROPERTY_QUERY_TABLE_MAP": ${JSON.stringify(map)} }
    }
  }
}`;
    case "Claude Desktop":
      return `// claude_desktop_config.json (use the absolute repo path)
{
  "mcpServers": {
    "oracle": {
      "command": "npx",
      "args": ["tsx", "${REPO}/pipeline/src/mcp/server.ts"],
      "env": { "PROPERTY_QUERY_TABLE_MAP": ${JSON.stringify(map)} }
    }
  }
}`;
    case "Claude Code":
      return `# from the repo root
claude mcp add oracle \\
  --env PROPERTY_QUERY_TABLE_MAP='${map}' \\
  -- npx tsx ./pipeline/src/mcp/server.ts`;
    case "Codex":
      return `# ~/.codex/config.toml  (use the absolute repo path)
[mcp_servers.oracle]
command = "npx"
args = ["tsx", "${REPO}/pipeline/src/mcp/server.ts"]

[mcp_servers.oracle.env]
PROPERTY_QUERY_TABLE_MAP = '${map}'`;
    case "CLI":
      return `# one-time
cd pipeline && npm install

# run the server (stdio)
PROPERTY_QUERY_TABLE_MAP='${map}' \\
  npx tsx ./pipeline/src/mcp/server.ts`;
  }
}

export default function McpConnect({ queryUrl }: { queryUrl?: string }) {
  const [client, setClient] = useState<Client>("Cursor");
  const [copied, setCopied] = useState(false);
  const url = queryUrl ?? "https://ipfs.filebase.io/ipns/<key>";
  const code = snippet(client, url);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be blocked; ignore */
    }
  }

  return (
    <section className="card p-5 space-y-4">
      <div>
        <h2 className="font-semibold">Connect via MCP</h2>
        <p className="text-xs text-[var(--color-muted)] mt-1">
          Any MCP-capable agent can query this dataset — it reads the Parquet
          straight from IPFS, no hosted database. Prereq: <code>cd pipeline &amp;&amp; npm install</code>.
        </p>
      </div>

      {/* Tools */}
      <div className="grid sm:grid-cols-3 gap-2">
        {TOOLS.map((t) => (
          <div key={t.name} className="rounded-lg bg-[var(--color-panel-2)] border border-[var(--color-border)] p-3">
            <div className="font-mono text-xs text-[var(--color-accent-2)]">{t.name}</div>
            <div className="text-xs text-[var(--color-muted)] mt-1">{t.desc}</div>
          </div>
        ))}
      </div>

      {/* Client tabs */}
      <div className="flex flex-wrap gap-1.5">
        {CLIENTS.map((c) => (
          <button
            key={c}
            onClick={() => setClient(c)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${
              client === c
                ? "border-[var(--color-accent)] bg-[var(--color-panel)] text-[var(--color-text)]"
                : "border-[var(--color-border)] bg-[var(--color-panel-2)] text-[var(--color-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      {/* Snippet */}
      <div className="relative">
        <button
          onClick={copy}
          className="absolute top-2 right-2 chip hover:text-[var(--color-text)]"
        >
          {copied ? "copied ✓" : "copy"}
        </button>
        <pre className="bg-[var(--color-panel-2)] border border-[var(--color-border)] rounded-lg p-3 pr-16 text-xs overflow-x-auto whitespace-pre">
{code}
        </pre>
      </div>
    </section>
  );
}
