/**
 * DuckDB load layer.
 *
 * Connectors stream `RawRecord`s; this module lands them into a single
 * `raw_records` table that preserves every source field as JSON plus full
 * provenance (source, url, fetch time, license). Typed/normalized tables and
 * the consolidated `properties` view are built from `raw_records` by the SQL
 * transforms in transforms/ once concrete source field names are known.
 *
 * Loading strategy: stream each connector to a newline-delimited JSON file
 * under data/staging/ (also a reproducibility artifact), then bulk-insert with
 * DuckDB's read_json + ON CONFLICT dedup. This is fast and keeps the hot path
 * off per-row prepared statements.
 */

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import type { Connector, FetchOptions, FetchStats } from "../connectors/types.js";
import { nowIso } from "../lib/http.js";

const DB_PATH = fileURLToPath(new URL("../../data/oracle.duckdb", import.meta.url));
const STAGING_DIR = fileURLToPath(new URL("../../data/staging/", import.meta.url));

export async function openDb(path: string = DB_PATH): Promise<DuckDBConnection> {
  await mkdir(dirname(path), { recursive: true });
  const instance = await DuckDBInstance.create(path);
  return instance.connect();
}

/** Create the raw capture table. Idempotent. */
export async function initRawSchema(conn: DuckDBConnection): Promise<void> {
  await conn.run(`
    CREATE TABLE IF NOT EXISTS raw_records (
      entity     VARCHAR   NOT NULL,
      source     VARCHAR   NOT NULL,
      source_id  VARCHAR   NOT NULL,
      source_url VARCHAR,
      fetched_at TIMESTAMP,
      license    VARCHAR,
      data       JSON,
      PRIMARY KEY (source, entity, source_id)
    );
  `);
}

function stagePath(connectorName: string): string {
  return `${STAGING_DIR}${connectorName.replace(/[^a-zA-Z0-9._-]/g, "_")}.jsonl`;
}

/**
 * Run one connector to completion, staging to JSONL then bulk-loading into
 * raw_records. Returns run stats for the pipeline report.
 */
export async function loadConnector(
  conn: DuckDBConnection,
  connector: Connector,
  opts: FetchOptions = {},
): Promise<FetchStats> {
  await mkdir(STAGING_DIR, { recursive: true });
  const file = stagePath(connector.name);
  const startedAt = nowIso();
  const notes: string[] = [];
  let count = 0;
  let lastUrl = "";

  const out = createWriteStream(file, { encoding: "utf8" });
  for await (const rec of connector.fetch(opts)) {
    lastUrl = rec.provenance.sourceUrl;
    const row = {
      entity: rec.entity,
      source: rec.provenance.source,
      source_id: rec.sourceId,
      source_url: rec.provenance.sourceUrl,
      fetched_at: rec.provenance.fetchedAt,
      license: rec.provenance.license ?? null,
      data: rec.data,
    };
    if (!out.write(JSON.stringify(row) + "\n")) {
      await once(out, "drain");
    }
    count++;
  }
  out.end();
  await once(out, "finish");

  if (count === 0) {
    notes.push("connector returned 0 records");
    return {
      connector: connector.name,
      source: connector.source,
      entity: connector.entity,
      count,
      sourceUrl: lastUrl,
      startedAt,
      finishedAt: nowIso(),
      notes,
    };
  }

  // Bulk load: read staged JSONL into a temp view, insert-or-ignore into raw.
  const escaped = file.replace(/'/g, "''");
  await conn.run(`
    INSERT INTO raw_records
    SELECT entity, source, source_id, source_url,
           CAST(fetched_at AS TIMESTAMP), license, data
    FROM read_json('${escaped}',
                   format = 'newline_delimited',
                   columns = {
                     entity: 'VARCHAR', source: 'VARCHAR', source_id: 'VARCHAR',
                     source_url: 'VARCHAR', fetched_at: 'VARCHAR', license: 'VARCHAR',
                     data: 'JSON'
                   })
    ON CONFLICT DO NOTHING;
  `);

  return {
    connector: connector.name,
    source: connector.source,
    entity: connector.entity,
    count,
    sourceUrl: lastUrl,
    startedAt,
    finishedAt: nowIso(),
    notes,
  };
}
