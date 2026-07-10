"use client";

/**
 * Client-side DuckDB-WASM singleton.
 *
 * Loads DuckDB in the browser, registers the static properties.parquet, and
 * exposes a `properties` view for read-only SELECTs. This is the whole query
 * engine for the UI — no backend, no hosted database, matching the assignment's
 * "no ongoing Oracle infra cost" requirement. The same Parquet is published to
 * IPFS for the MCP path.
 */

import * as duckdb from "@duckdb/duckdb-wasm";

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;

async function initDb(): Promise<duckdb.AsyncDuckDB> {
  const bundles = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(bundles);
  // Cross-origin worker must be wrapped in a same-origin blob.
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], {
      type: "text/javascript",
    }),
  );
  const worker = new Worker(workerUrl);
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);

  // Register the parquet from the app's static assets and expose it as `properties`.
  const res = await fetch("/data/properties.parquet");
  if (!res.ok) throw new Error(`failed to load properties.parquet (${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  await db.registerFileBuffer("properties.parquet", buf);
  const conn = await db.connect();
  await conn.query(
    `CREATE VIEW properties AS SELECT * FROM parquet_scan('properties.parquet')`,
  );
  await conn.close();
  return db;
}

export function getDb(): Promise<duckdb.AsyncDuckDB> {
  if (!dbPromise) dbPromise = initDb();
  return dbPromise;
}

/** Run a read-only SELECT and return plain JS row objects. */
export async function query(sql: string): Promise<Record<string, unknown>[]> {
  const db = await getDb();
  const conn = await db.connect();
  try {
    const result = await conn.query(sql);
    return result.toArray().map((r) => {
      const o = r.toJSON() as Record<string, unknown>;
      // Arrow returns BigInt for integers; coerce for React/JSON.
      for (const k of Object.keys(o)) {
        if (typeof o[k] === "bigint") o[k] = Number(o[k]);
      }
      return o;
    });
  } finally {
    await conn.close();
  }
}

/** Count helper. */
export async function count(sql: string): Promise<number> {
  const rows = await query(`SELECT count(*) AS n FROM (${sql}) AS _q`);
  return Number(rows[0]?.n ?? 0);
}
