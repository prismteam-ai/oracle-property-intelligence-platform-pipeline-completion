/**
 * Generic Socrata (SODA API) connector.
 *
 * Powers any city/county open-data portal that runs Socrata — e.g. the City of
 * Palo Alto and Santa Clara County portals. Concrete datasets are just config
 * (domain + dataset id + which entity + which field is the natural key), so a
 * new Socrata source is one `socrataConnector({...})` call, no new class.
 *
 * SODA paging: ?$limit=&$offset=&$order=:id keeps pages stable across requests.
 * Docs: https://dev.socrata.com/docs/paging.html
 */

import type {
  Connector,
  EntityType,
  FetchOptions,
  RawRecord,
} from "./types.js";
import { getJson, nowIso } from "../lib/http.js";

export interface SocrataConfig {
  name: string;
  entity: EntityType;
  source: string;
  /** Portal host, e.g. "data.cityofpaloalto.org". */
  domain: string;
  /** Socrata dataset (4x4) id, e.g. "abcd-1234". */
  datasetId: string;
  /** Field in each row that is the source natural key (APN, permit no, ...). */
  idField: string;
  /** Optional SoQL $where filter to scope the pull. */
  where?: string;
  /** Optional app token to lift throttling (read from env by the caller). */
  appToken?: string;
  license?: string;
  /** Page size; Socrata allows up to 50000 per request. */
  pageSize?: number;
}

export function socrataConnector(cfg: SocrataConfig): Connector {
  const pageSize = cfg.pageSize ?? 5000;

  async function* fetchAll(
    opts: FetchOptions = {},
  ): AsyncGenerator<RawRecord, void, unknown> {
    const headers = cfg.appToken ? { "X-App-Token": cfg.appToken } : undefined;
    let offset = 0;
    let yielded = 0;
    const fetchedAt = nowIso();

    for (;;) {
      const remaining =
        opts.limit === undefined ? pageSize : Math.min(pageSize, opts.limit - yielded);
      if (remaining <= 0) return;

      const params = new URLSearchParams({
        $limit: String(remaining),
        $offset: String(offset),
        $order: ":id",
      });
      if (cfg.where) params.set("$where", cfg.where);

      const url = `https://${cfg.domain}/resource/${cfg.datasetId}.json?${params}`;
      const page = await getJson<Record<string, unknown>[]>(url, {
        headers,
        // Cache key includes the exact query params so a page fetched under a
        // smaller $limit is never reused for a larger request.
        cacheKey: `${cfg.name}/${params.toString()}`,
        noCache: opts.noCache,
      });

      if (!Array.isArray(page) || page.length === 0) return;

      for (const row of page) {
        const sourceId =
          (row[cfg.idField] as string | undefined) ?? `${cfg.name}:${offset}:${yielded}`;
        yield {
          entity: cfg.entity,
          sourceId: String(sourceId),
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

      offset += page.length;
      if (page.length < remaining) return; // last page
    }
  }

  return {
    name: cfg.name,
    entity: cfg.entity,
    source: cfg.source,
    fetch: fetchAll,
  };
}
