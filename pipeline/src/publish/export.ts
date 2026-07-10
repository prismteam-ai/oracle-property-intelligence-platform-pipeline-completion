/**
 * Export the query tables to Parquet.
 *
 * Produces one flat, scalar Parquet per table under data/export/. These are the
 * artifacts that (a) get published to IPFS (see publish.ts), (b) feed the MCP
 * server via DuckDB httpfs, and (c) ship as a static asset the browser UI reads
 * with DuckDB-WASM. `properties.parquet` is the primary query table (one row per
 * property); permits/pois are supporting detail.
 *
 * Run: npm run export   (after `npm run build:db`)
 */

import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb } from "../db/load.js";

export const EXPORT_DIR = fileURLToPath(
  new URL("../../data/export/", import.meta.url),
);

/** Tables to export; `sources` JSON is dropped from the flat parquet for portability. */
const EXPORTS: Array<{ table: string; file: string; select: string }> = [
  {
    table: "properties",
    file: "properties.parquet",
    // Cast dates to ISO strings and drop the JSON column so the parquet is
    // flat/scalar (DuckDB-WASM + range reads stay simple).
    select: `
      SELECT * EXCLUDE (sources, last_roof_permit_date, last_permit_date),
             CAST(last_roof_permit_date AS VARCHAR) AS last_roof_permit_date,
             CAST(last_permit_date AS VARCHAR)      AS last_permit_date
      FROM properties`,
  },
  {
    table: "permits_typed",
    file: "permits.parquet",
    select: `SELECT permit_id, apn_norm, CAST(permit_date AS VARCHAR) permit_date,
                    module, status, description, job_value, business_name,
                    license_nbr, is_roofing, source, source_url
             FROM permits_typed`,
  },
  {
    table: "pois_typed",
    file: "pois.parquet",
    select: `SELECT kind, name, latitude, longitude, source, source_url FROM pois_typed`,
  },
];

export async function exportParquet(): Promise<
  Array<{ file: string; path: string; rows: number }>
> {
  const conn = await openDb();
  await mkdir(EXPORT_DIR, { recursive: true });
  const out: Array<{ file: string; path: string; rows: number }> = [];

  for (const e of EXPORTS) {
    const path = `${EXPORT_DIR}${e.file}`;
    const escaped = path.replace(/'/g, "''");
    await conn.run(
      `COPY (${e.select}) TO '${escaped}' (FORMAT PARQUET, COMPRESSION ZSTD);`,
    );
    const r = await conn.runAndReadAll(`SELECT count(*) n FROM (${e.select})`);
    const rows = Number(r.getRowObjects()[0]!.n);
    // Sanity: a Parquet file starts with the magic bytes "PAR1".
    const head = await readFile(path);
    const magic = head.subarray(0, 4).toString("ascii");
    if (magic !== "PAR1") throw new Error(`${e.file} is not valid Parquet (magic=${magic})`);
    out.push({ file: e.file, path, rows });
    console.log(`  ${e.file}: ${rows} rows, ${(head.length / 1024).toFixed(0)} KB, magic OK`);
  }
  await conn.disconnectSync?.();
  return out;
}

// Run directly.
if (existsSync(fileURLToPath(import.meta.url))) {
  const isMain = process.argv[1] === fileURLToPath(import.meta.url);
  if (isMain) {
    exportParquet()
      .then((r) => console.log(`Exported ${r.length} parquet files to ${EXPORT_DIR}`))
      .catch((e) => {
        console.error(e);
        process.exit(1);
      });
  }
}
