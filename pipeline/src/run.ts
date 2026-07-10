/**
 * Pipeline entry point.
 *
 * Runs the active connectors into DuckDB's raw_records table and writes a run
 * report (source list, per-source counts, timestamps, provenance, documented
 * source constraints) to data/run-report.json — this is what the "pipeline run
 * summary" screen in the UI reads.
 *
 * Usage:
 *   tsx src/run.ts                       # full run, all active connectors
 *   tsx src/run.ts --limit 200           # bounded pilot (per connector)
 *   tsx src/run.ts --only scc-parcels    # one connector
 *   tsx src/run.ts --no-cache            # bypass raw cache, re-fetch
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { openDb, initRawSchema, loadConnector } from "./db/load.js";
import { ACTIVE_CONNECTORS, PALO_ALTO_BBOX } from "./sources.js";
import type { FetchOptions, FetchStats } from "./connectors/types.js";
import { nowIso } from "./lib/http.js";

const REPORT_PATH = fileURLToPath(
  new URL("../data/run-report.json", import.meta.url),
);

function parseArgs(argv: string[]): { opts: FetchOptions; only?: string[] } {
  const opts: FetchOptions = { bbox: PALO_ALTO_BBOX };
  let only: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") opts.limit = Number(argv[++i]);
    else if (a === "--no-cache") opts.noCache = true;
    else if (a === "--only") only = (argv[++i] ?? "").split(",").filter(Boolean);
  }
  return { opts, only };
}

async function main() {
  const { opts, only } = parseArgs(process.argv.slice(2));
  const connectors = only
    ? ACTIVE_CONNECTORS.filter((c) => only.includes(c.name))
    : ACTIVE_CONNECTORS;

  console.log(
    `Oracle pipeline — ${connectors.length} connector(s)` +
      (opts.limit ? `, limit ${opts.limit}/connector` : ", full") +
      (opts.noCache ? ", no-cache" : ""),
  );

  const conn = await openDb();
  await initRawSchema(conn);

  const startedAt = nowIso();
  const stats: FetchStats[] = [];
  for (const c of connectors) {
    process.stdout.write(`  → ${c.name} (${c.entity}) ... `);
    try {
      const s = await loadConnector(conn, c, opts);
      stats.push(s);
      console.log(`${s.count} records`);
    } catch (err) {
      console.log(`FAILED: ${String(err)}`);
      stats.push({
        connector: c.name,
        source: c.source,
        entity: c.entity,
        count: 0,
        sourceUrl: "",
        startedAt,
        finishedAt: nowIso(),
        notes: [`error: ${String(err)}`],
      });
    }
  }

  // Totals straight from the DB (BigInt -> Number for JSON).
  const totalsReader = await conn.runAndReadAll(
    `SELECT entity, source, count(*)::BIGINT n
     FROM raw_records GROUP BY entity, source ORDER BY entity, source`,
  );
  const byEntity = totalsReader.getRows().map((r) => ({
    entity: String(r[0]),
    source: String(r[1]),
    records: Number(r[2]),
  }));
  const grandTotal = byEntity.reduce((a, b) => a + b.records, 0);

  const report = {
    generatedAt: nowIso(),
    county: "Santa Clara County, CA",
    focus: "Palo Alto",
    bbox: PALO_ALTO_BBOX,
    grandTotalRecords: grandTotal,
    runs: stats,
    dbTotals: byEntity,
    constraints: [
      {
        source: "City of Palo Alto Development Center Permits (Junar)",
        status: "resolved-workaround",
        detail:
          "catalog advertises host api.data.paloalto.gov which is dead (NXDOMAIN); worked around by using the live portal export at data.paloalto.gov/rest/datastreams/<id>/data.csv/ (numeric ids browser-discovered). Permit history 2013-2026 ingested.",
        affects: ["roof age (Q1)"],
        catalog: "https://data.paloalto.gov/data.json",
      },
      {
        source: "SCC Assessor bulk / commercial parcel data",
        status: "not-open-data",
        detail:
          "owner name, owner mailing address, last sale date, and year built are not available as free open data for Santa Clara County; requires paid SCC Assessor bulk order or a commercial aggregator (Regrid/ATTOM). Owner names are additionally restricted by CA law.",
        affects: [
          "regional owner (Q3)",
          "no sale in 10yr (Q4)",
          "roof age fallback via year_built (Q1)",
        ],
      },
    ],
  };

  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
  console.log(
    `\nLoaded ${grandTotal} records across ${byEntity.length} source/entity groups.`,
  );
  console.table(byEntity);
  console.log(`Run report: ${REPORT_PATH}`);
  await conn.disconnectSync?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
