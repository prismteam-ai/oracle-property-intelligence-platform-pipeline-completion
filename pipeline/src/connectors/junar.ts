/**
 * Junar CSV connector for City of Palo Alto open data.
 *
 * The catalog (data.paloalto.gov/data.json) advertises permit downloads on the
 * host `api.data.paloalto.gov`, which is dead in DNS. But the live portal serves
 * each datastream's full export via `/rest/datastreams/{numericId}/data.csv/`,
 * which 302-redirects to a signed S3 URL with the complete file. That's the
 * path we use — one request, whole dataset, no fragile pagination.
 *
 * The numeric datastream id (not the catalog slug) is discovered from the
 * dataview's own network calls; ids for each date-range chunk live in sources.ts.
 */

import type {
  Connector,
  EntityType,
  FetchOptions,
  RawRecord,
} from "./types.js";
import { getText, nowIso } from "../lib/http.js";
import { parseCsv } from "../lib/csv.js";

export interface JunarConfig {
  name: string;
  entity: EntityType;
  source: string;
  /** Junar portal host, e.g. "data.paloalto.gov". */
  domain: string;
  /** Numeric datastream id (from the dataview's /rest/datastreams/<id>/ calls). */
  datastreamId: string | number;
  /** Column holding the natural key (e.g. "RECORD ID"). */
  idField: string;
  license?: string;
}

export function junarCsvConnector(cfg: JunarConfig): Connector {
  async function* fetchAll(
    opts: FetchOptions = {},
  ): AsyncGenerator<RawRecord, void, unknown> {
    const url = `https://${cfg.domain}/rest/datastreams/${cfg.datastreamId}/data.csv/`;
    const fetchedAt = nowIso();
    const text = await getText(url, {
      cacheKey: `${cfg.name}/full`,
      noCache: opts.noCache,
    });
    const rows = parseCsv(text);

    let yielded = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const key = row[cfg.idField]?.trim();
      yield {
        entity: cfg.entity,
        sourceId: key && key.length > 0 ? key : `${cfg.name}:${i}`,
        data: row,
        provenance: {
          source: cfg.source,
          sourceUrl: url,
          fetchedAt,
          license: cfg.license,
        },
      };
      yielded++;
      if (opts.limit !== undefined && yielded >= opts.limit) return;
    }
  }

  return { name: cfg.name, entity: cfg.entity, source: cfg.source, fetch: fetchAll };
}
