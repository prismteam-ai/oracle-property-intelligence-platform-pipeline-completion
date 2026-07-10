/**
 * Local CSV file connector.
 *
 * Ingests an operator-supplied CSV (e.g. the Palo Alto permit export downloaded
 * from the browsable dataview, or any assessor/ownership extract) through the
 * same Connector -> raw_records path as the API sources, so file-sourced data
 * gets identical provenance and dedup. Every column is preserved verbatim in
 * `data`; provenance.sourceUrl is a file:// URL plus the human source name.
 *
 * Adding a file source = one `csvFileConnector({...})` entry pointing at a path
 * under data/input/.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type {
  Connector,
  EntityType,
  FetchOptions,
  RawRecord,
} from "./types.js";
import { parseCsv } from "../lib/csv.js";
import { nowIso } from "../lib/http.js";

export interface CsvFileConfig {
  name: string;
  entity: EntityType;
  source: string;
  /** Absolute path to the CSV file. */
  filePath: string;
  /**
   * Column holding the natural key. If missing/blank in a row, a synthetic
   * `<name>:<rowIndex>` id is used so no record is silently dropped.
   */
  idField: string;
  license?: string;
}

export function csvFileConnector(cfg: CsvFileConfig): Connector {
  async function* fetchAll(
    opts: FetchOptions = {},
  ): AsyncGenerator<RawRecord, void, unknown> {
    if (!existsSync(cfg.filePath)) {
      throw new Error(
        `CSV file not found for connector '${cfg.name}': ${cfg.filePath}`,
      );
    }
    const text = await readFile(cfg.filePath, "utf8");
    const rows = parseCsv(text);
    const fetchedAt = nowIso();
    const sourceUrl = pathToFileURL(cfg.filePath).href;

    let yielded = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const key = row[cfg.idField]?.trim();
      yield {
        entity: cfg.entity,
        sourceId: key && key.length > 0 ? key : `${cfg.name}:${i}`,
        data: row,
        provenance: { source: cfg.source, sourceUrl, fetchedAt, license: cfg.license },
      };
      yielded++;
      if (opts.limit !== undefined && yielded >= opts.limit) return;
    }
  }

  return { name: cfg.name, entity: cfg.entity, source: cfg.source, fetch: fetchAll };
}

/** True when a file connector's source file is present on disk. */
export function csvFileAvailable(cfg: Pick<CsvFileConfig, "filePath">): boolean {
  return existsSync(cfg.filePath);
}
