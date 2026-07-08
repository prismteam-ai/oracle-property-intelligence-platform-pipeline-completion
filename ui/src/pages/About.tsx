import { AGENT_A2A_URL, COUNTY_LABEL, IPFS_GATEWAY, MCP_URL, QUERY_TABLE_URL } from '../config';

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
 * Real, resolvable per-property CIDs pulled from the live query table
 * (SELECT property_cid … FROM the Lee query Parquet). Each resolves to the
 * consolidated source-document JSON for that parcel via any IPFS gateway.
 * Verified 200 OK via ipfs.io on 2026-07-08.
 */
const SAMPLE_CIDS: { cid: string; label: string }[] = [
  { cid: 'QmNLemwgTPCuGwDGkQD6Kzt63k1hwYNjaUgtX4QPdQbins', label: '10742 Cetrella Drive, Fort Myers (built 2014)' },
  { cid: 'QmNLeqszZogAGzhGtK9774RwXYzH66hyNSSNnXXjs54y1u', label: '9572 Dunkirk Drive, Fort Myers (built 2001)' },
  { cid: 'QmNLfC2agpNdCdb5szAM39CgbYDNU5dz3VJXk9oK9zbuAz', label: '2526 SE 16th Place #210, Cape Coral (built 1981)' },
  { cid: 'QmNLfFo5G7YuySVg12DGSh7PxLzus9c5KoiPrsavoE5edQ', label: '39 Broadway Circle, Fort Myers (built 1963)' },
  { cid: 'QmNLfPwxJVbHmniFAusEGDVHfhHMUou2Sv8HyCwj8aAowJ', label: '314 NW 9th Terrace, Cape Coral (built 2004)' },
];

const MCP_REQUEST = `POST ${MCP_URL}
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "queryProperties",
    "arguments": {
      "county": "lee",
      "sql": "SELECT parcel_identifier, address_city, built_year, property_cid FROM properties WHERE built_year > 0 AND built_year <= 2010 LIMIT 5"
    }
  }
}`;

const MCP_RESPONSE = `{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      { "type": "text", "text": "[{\\"parcel_identifier\\":\\"...\\",\\"address_city\\":\\"CAPE CORAL\\",\\"built_year\\":2004,\\"property_cid\\":\\"QmNLfPwxJ...\\"}, ...]" }
    ]
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

export default function About() {
  return (
    <div className="space-y-5 max-w-4xl">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">
          About the Oracle Property Intelligence platform
        </h1>
        <p className="text-sm text-slate-600 mt-1">
          A zero-standing-infrastructure property-intelligence Oracle. Currently
          serving {COUNTY_LABEL} open data while the Santa Clara County ingest
          completes.
        </p>
      </div>

      <Section
        title="IPFS artifacts & content-addressing"
        subtitle="Per-property source-document records are content-addressed on IPFS — addressed by their content hash (CID), not by a server location. Below are live, resolvable sample CIDs."
      >
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
            <span className="font-medium text-slate-700">Honest architecture note: </span>
            Each parcel's consolidated source-document set is pinned to IPFS and
            referenced by <code className="font-mono">property_cid</code> — those
            are the content-addressed artifacts (links above resolve through{' '}
            <span className="font-mono">{IPFS_GATEWAY}</span>).
          </p>
          <p>
            The columnar <span className="font-medium text-slate-700">query-table Parquet</span> itself
            is <span className="font-medium">CDN-hosted</span> (Netlify) for fast HTTP range-reads by
            DuckDB — it is <span className="font-medium">not</span> claimed to be on IPFS. The Parquet
            is the query index; the CIDs are the verifiable provenance layer.
          </p>
          <p className="break-all">
            Query table: <span className="font-mono">{QUERY_TABLE_URL}</span>
          </p>
        </div>
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
              (e.g. <span className="font-mono text-xs">lee</span>), mapped to the
              backing Parquet.
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
            <CodeBlock>{MCP_REQUEST}</CodeBlock>
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium text-slate-600">Example response shape</p>
            <CodeBlock>{MCP_RESPONSE}</CodeBlock>
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
                  Interim data is {COUNTY_LABEL} (Lee County, FL) — the Santa
                  Clara County ingest is still pending.
                </li>
                <li>
                  Roof-age and regional-owner answers are{' '}
                  <span className="font-medium">labeled proxies</span> (structure age /
                  portfolio size), not direct measurements.
                </li>
                <li>
                  Transit and Starbucks proximity use a small{' '}
                  <span className="font-medium">sample POI set</span>, not the full
                  place / GTFS network.
                </li>
                <li>
                  Water-view is <span className="font-medium">deferred</span> — it requires
                  geo enrichment not yet in the schema; no results are fabricated.
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
