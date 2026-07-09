import { AGENT_A2A_URL, IPFS_GATEWAY, MCP_URL } from '../config';
import type { CountyConfig } from '../counties';
import runSummary from '../data/santa-clara-run-summary.json';

const CONSTRAINTS: string[] = (runSummary as { constraints?: string[] }).constraints ?? [];

/**
 * Static reference page. No DuckDB engine required — App renders /about
 * without waiting on the SQL engine (same as /ask).
 *
 * This page is the home for two demo beats:
 *  - "show the IPFS artifacts" (content-addressing, resolvable sample CIDs)
 *  - "documented MCP-compatible query structure" (the MCP endpoint + tool)
 * It also carries the full architecture / zero-infra / model-card copy that
 * used to live inline on the header and footer of the main pages.
 */

/**
 * The Santa Clara dataset artifact (the query-table Parquet) pinned to IPFS,
 * plus real per-property CIDs. Every one resolves to its consolidated
 * source-document JSON. Pinned on our own kubo node (Azure Container Apps),
 * which serves all ~20.9k property CIDs + the dataset parquet; verified 200 OK
 * on 2026-07-09.
 */
const DATASET_CID = 'QmfMHvisxa2xgpW88WeahvZnmpbUhqMh8B2FqzaRZCrGqT';
const SAMPLE_CIDS: { cid: string; label: string }[] = [
  { cid: 'QmQRrv9jv47QqREM3SmnoK6HQ692n1eox5cdLtXZiajv3j', label: '780 Palo Alto Ave, Palo Alto (built 1921)' },
  { cid: 'QmW3HHxtbbVA4YbPt4cCAYZoffAJV6FicXEh9eyh2nq1Xh', label: '786 Palo Alto Ave, Palo Alto (built 1923)' },
  { cid: 'QmWd6hNTWTRfbWRRxaBxe6PuQBc4hVAF2Gi7nYm5AAmuhb', label: '788 Palo Alto Ave, Palo Alto (built 1922)' },
  { cid: 'Qmex1mTxDBAg277AL12ti4b39ryYW51eztW3SbC9JNxuhi', label: '253 Fulton St, Palo Alto (built 1906)' },
];

function mcpRequest(agentCounty: string): string {
  return `POST ${MCP_URL}
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "queryProperties",
    "arguments": {
      "county": "${agentCounty}",
      "sql": "SELECT parcel_identifier, address_city, latitude, longitude, property_cid FROM properties LIMIT 5"
    }
  }
}`;
}

const MCP_RESPONSE = `{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      { "type": "text", "text": "[{\\"parcel_identifier\\":\\"...\\",\\"address_city\\":\\"PALO ALTO\\",\\"latitude\\":37.44,\\"longitude\\":-122.16,\\"property_cid\\":\\"Qm...\\"}, ...]" }
    ]
  }
}`;

// Drop-in configs so any MCP client can query the public Oracle endpoint.
// Claude Desktop speaks stdio → bridge via the `mcp-remote` npx proxy (verified
// 2026-07-08: "Proxy established … StreamableHTTPClientTransport"). Cursor
// connects to the HTTP endpoint natively via `url`.
const CLAUDE_DESKTOP_CONFIG = `{
  "mcpServers": {
    "oracle-property-intelligence": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${MCP_URL}"]
    }
  }
}`;

const CURSOR_CONFIG = `{
  "mcpServers": {
    "oracle-property-intelligence": {
      "url": "${MCP_URL}"
    }
  }
}`;

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border border-slate-200 rounded bg-white p-5 space-y-3">
      <div>
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {subtitle && <p className="text-sm text-slate-600 mt-1">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto bg-slate-900 text-slate-100 rounded p-3 text-xs leading-relaxed">
      {children}
    </pre>
  );
}

export default function About({ county }: { county: CountyConfig }) {
  return (
    <div className="space-y-5 max-w-4xl">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">
          About the Oracle Property Intelligence platform
        </h1>
        <p className="text-sm text-slate-600 mt-1">
          A zero-standing-infrastructure property-intelligence Oracle. The
          deliverable county is <span className="font-medium">Santa Clara
          County, CA</span> (which contains Palo Alto); its open parcel + geo
          data makes the distance questions real. <span className="font-medium">
          Lee County, FL</span> is kept selectable as the reference
          implementation — its full assessor field set (owner, value, year
          built, sales) demonstrates the underwriting questions while the paid
          Santa Clara Assessor bulk order is outstanding. Both counties are
          served by the same MCP query layer via its{' '}
          <code className="font-mono text-xs bg-slate-100 px-1 py-0.5 rounded">
            PROPERTY_QUERY_TABLE_MAP
          </code>
          . Currently viewing: <span className="font-medium">{county.label}</span>.
        </p>
      </div>

      <Section
        title="IPFS artifacts & content-addressing"
        subtitle="Eligible dataset artifacts are content-addressed on IPFS — addressed by their content hash (CID), not a server location — and pinned by our own kubo IPFS node. Every CID below is a standard IPFS CIDv0 that resolves on any public gateway (e.g. ipfs.io)."
      >
        <div className="text-sm bg-slate-50 border border-slate-200 rounded px-3 py-2 mb-2">
          <span className="font-medium text-slate-700">Dataset artifact — the full Santa Clara query-table Parquet on IPFS:</span>
          <br />
          <a
            href={`${IPFS_GATEWAY}${DATASET_CID}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-xs text-slate-700 underline decoration-slate-300 hover:decoration-slate-600 break-all"
          >
            {DATASET_CID}
          </a>
        </div>
        <p className="text-xs font-medium text-slate-600">Per-property source-document records (all ~20,912 pinned — examples):</p>
        <ul className="space-y-1.5">
          {SAMPLE_CIDS.map((s) => (
            <li key={s.cid} className="text-sm">
              <a
                href={`${IPFS_GATEWAY}${s.cid}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-xs text-slate-700 underline decoration-slate-300 hover:decoration-slate-600 break-all"
              >
                {s.cid}
              </a>
              <span className="text-slate-500"> — {s.label}</span>
            </li>
          ))}
        </ul>
        <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded px-3 py-2 space-y-1">
          <p>
            <span className="font-medium text-slate-700">Architecture note: </span>
            All ~20,912 parcels' consolidated source-document sets are pinned to
            IPFS and referenced by <code className="font-mono">property_cid</code>.
            They are pinned by our own <span className="font-medium">kubo IPFS node</span>{' '}
            (Azure Container Apps), which replaces a paid pinning service — free
            tiers (Pinata, Filebase) cap at ~500–1,000 objects. Because that node
            provides to the IPFS DHT, these standard CIDs resolve on{' '}
            <span className="font-medium">any public gateway</span>; the links above
            use <span className="font-mono">{IPFS_GATEWAY}</span>.
          </p>
          <p>
            The columnar <span className="font-medium text-slate-700">query-table Parquet</span> is
            both <span className="font-medium">pinned to IPFS</span> (the dataset CID above, resolvable
            on any gateway) <span className="font-medium">and</span> CDN-mirrored (Netlify) so DuckDB
            gets fast HTTP range-reads at query time. IPFS is the durable, content-addressed source of
            truth; the CDN is a performance mirror of the same bytes.
          </p>
          <p className="break-all">
            Active query table: <span className="font-mono">{county.parquetUrl}</span>
          </p>
        </div>
      </Section>

      <Section
        title="Documented source constraints & honest gaps"
        subtitle="The real limitations of the Santa Clara ingest — what is paid, reCAPTCHA-gated, single-city, or a labeled proxy. Nothing here is fabricated; gaps are named, not hidden."
      >
        <ul className="space-y-2">
          {CONSTRAINTS.map((c, i) => (
            <li
              key={i}
              className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded px-3 py-2"
            >
              {c}
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="MCP-ready query structure"
        subtitle="The Oracle exposes a public MCP endpoint speaking JSON-RPC MCP. Agents and tools call one read-only query tool over the property data."
      >
        <p className="text-sm text-slate-700 break-all">
          Endpoint: <span className="font-mono text-xs">{MCP_URL}</span>
        </p>
        <div className="text-sm text-slate-700 space-y-1">
          <p>
            Key tool:{' '}
            <code className="font-mono text-xs bg-slate-100 border border-slate-200 rounded px-1 py-0.5">
              queryProperties(county, sql)
            </code>
          </p>
          <ul className="list-disc pl-5 text-sm text-slate-600 space-y-0.5">
            <li>
              <span className="font-mono text-xs">county</span> — the county key
              (<span className="font-mono text-xs">santa-clara</span> or{' '}
              <span className="font-mono text-xs">lee</span>), mapped to the
              backing Parquet via PROPERTY_QUERY_TABLE_MAP.
            </li>
            <li>
              <span className="font-mono text-xs">sql</span> — a read-only
              SELECT / CTE query over a <span className="font-mono text-xs">properties</span>{' '}
              view of ~37 columns (parcel_identifier, address_*, built_year,
              owner_name, last_sale_date, latitude/longitude, property_cid,
              source_system, …). Writes are rejected.
            </li>
          </ul>
        </div>
        <div className="grid md:grid-cols-2 gap-3">
          <div className="space-y-1">
            <p className="text-xs font-medium text-slate-600">Example request</p>
            <CodeBlock>{mcpRequest(county.agentCounty)}</CodeBlock>
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium text-slate-600">Example response shape</p>
            <CodeBlock>{MCP_RESPONSE}</CodeBlock>
          </div>
        </div>

        <div className="pt-2 border-t border-slate-100 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-800">
              Connect your own agent
            </h3>
            <p className="text-sm text-slate-600 mt-1">
              The endpoint is a standard streamable-HTTP MCP server, so any MCP
              client can query the Oracle as a peer — no key, no account. Add it
              to Claude Desktop or Cursor, then ask property questions in your own
              agent and it will call{' '}
              <span className="font-mono text-xs">queryProperties</span> against
              this data.
            </p>
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <p className="text-xs font-medium text-slate-600">
                Claude Desktop —{' '}
                <span className="font-mono">claude_desktop_config.json</span>
              </p>
              <CodeBlock>{CLAUDE_DESKTOP_CONFIG}</CodeBlock>
              <p className="text-xs text-slate-500">
                Uses the <span className="font-mono">mcp-remote</span> bridge
                (Claude Desktop speaks stdio; the bridge proxies to our HTTP
                endpoint). Restart Claude Desktop, then ask e.g.{' '}
                <span className="italic">
                  "Using the oracle tools, how many parcels are in Palo Alto?"
                </span>
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium text-slate-600">
                Cursor — <span className="font-mono">.cursor/mcp.json</span>
              </p>
              <CodeBlock>{CURSOR_CONFIG}</CodeBlock>
              <p className="text-xs text-slate-500">
                Cursor connects to the HTTP endpoint natively via{' '}
                <span className="font-mono">url</span>. Enable the server in
                Settings → MCP, then ask the same questions in Composer.
              </p>
            </div>
          </div>
        </div>
      </Section>

      <Section
        title="Architecture — zero standing infrastructure"
        subtitle="No always-on database, and no ongoing hosted-DB cost."
      >
        <p className="text-sm text-slate-700">
          The exploration UI runs <span className="font-medium">100% client-side SQL</span> over the
          content-addressed Parquet table via <span className="font-medium">DuckDB-WASM</span> —
          data is queried live in your browser, with no backend. The MCP layer
          embeds <span className="font-medium">DuckDB-in-process</span> and range-reads the same
          Parquet. Every property row carries a{' '}
          <code className="font-mono text-xs bg-slate-100 px-1 py-0.5 rounded">property_cid</code>{' '}
          pinning its full source-document set to IPFS for verifiable
          provenance. DuckDB-WASM in the browser + DuckDB-in-MCP over the Parquet
          + IPFS content-addressing together mean the Oracle carries{' '}
          <span className="font-medium">no ongoing hosted-database cost</span>.
        </p>
      </Section>

      <Section
        title="Deployment — re-attachable to any infrastructure"
        subtitle="Nothing here is proprietary or vendor-locked."
      >
        <ul className="list-disc pl-5 text-sm text-slate-600 space-y-1">
          <li>
            Static UI + the query-table Parquet host on any static / CDN target
            (Netlify today; equally S3+CloudFront, Cloudflare, GitHub Pages).
          </li>
          <li>
            The MCP server and the agent are plain containers — deployable to any
            container host, and scale-to-zero capable (Azure Container Apps
            today; equally AWS Fargate / Lambda, Cloud Run, Fly).
          </li>
          <li>
            The IPFS pinning node is a third container (kubo) — the one{' '}
            <span className="font-medium">always-on</span> piece, since a gateway
            must stay up to serve. It replaces a paid pinning service (free tiers
            cap at ~500–1,000 objects); on Azure Container Apps today, equally any
            container host.
          </li>
          <li>
            DuckDB reads the Parquet directly; IPFS artifacts resolve through any
            gateway. Swapping counties is pure config (Parquet URL + county
            label).
          </li>
        </ul>
      </Section>

      <Section
        title="Agent model card"
        subtitle="The natural-language answering agent behind Ask the Oracle."
      >
        <dl className="text-sm text-slate-700 space-y-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Model</dt>
            <dd>Azure GPT-5.4, orchestrated with Google ADK 2.3 via LiteLLM.</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Interface</dt>
            <dd>
              Exposed over the A2A (Agent2Agent) protocol — external agents query
              it as a peer (agent card:{' '}
              <a
                href={`${AGENT_A2A_URL}/.well-known/agent-card.json`}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-slate-300 hover:decoration-slate-600 break-all"
              >
                /.well-known/agent-card.json
              </a>
              ).
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Tools</dt>
            <dd>
              The elephant MCP server (<span className="font-mono text-xs">queryProperties</span> and
              related read-only tools over the property data).
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Capabilities</dt>
            <dd>
              Answers natural-language property questions by writing and running
              read-only SQL, returning source-backed answers with the SQL shown
              and CID-level provenance.
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">
              Honest limitations
            </dt>
            <dd>
              <ul className="list-disc pl-5 space-y-0.5">
                <li>
                  <span className="font-medium">Santa Clara (default):</span>{' '}
                  parcels + geo are real (495,231 parcels, 100% lat/lon), so
                  transit / Starbucks distance answers are real. Owner, value,
                  year-built and sale date are a{' '}
                  <span className="font-medium">paid offline Assessor bulk order</span>{' '}
                  — 100% NULL in v1 — so roof-age, ownership-tenure and
                  regional-owner questions are honestly deferred.
                </li>
                <li>
                  <span className="font-medium">Lee (reference):</span> full
                  assessor field set present. Roof-age and regional-owner answers
                  are <span className="font-medium">labeled proxies</span>{' '}
                  (structure age / portfolio size), not direct measurements.
                </li>
                <li>
                  Transit and Starbucks proximity use a small{' '}
                  <span className="font-medium">sample POI set</span> (real
                  Caltrain/VTA stations for Santa Clara), not the full place /
                  GTFS network.
                </li>
                <li>
                  Water-view is <span className="font-medium">deferred</span> for
                  both counties — it requires geo/shoreline enrichment not yet in
                  the schema; no results are fabricated.
                </li>
                <li>
                  Permits, business, and contractor signals are currently{' '}
                  <span className="font-medium">flags</span>, not full linked records.
                </li>
              </ul>
            </dd>
          </div>
        </dl>
      </Section>
    </div>
  );
}
