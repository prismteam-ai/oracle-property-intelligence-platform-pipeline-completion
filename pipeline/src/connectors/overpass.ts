/**
 * OpenStreetMap Overpass API connector for points of interest.
 *
 * Supplies the "near X" reference geometry the assignment needs: public transit
 * stops, Starbucks locations, and water bodies (for the water-view heuristic).
 * These are POIs the property coordinates get measured against; they are not
 * property records themselves.
 *
 * Overpass returns elements with lat/lon (nodes) or a center (ways/relations).
 * Docs: https://wiki.openstreetmap.org/wiki/Overpass_API
 */

import type {
  Connector,
  EntityType,
  FetchOptions,
  RawRecord,
} from "./types.js";
import { getJson, nowIso } from "../lib/http.js";

/**
 * Overpass endpoints tried in order. The primary throttles heavy IPs (returning
 * 406, not 429); mirrors give resilience. A mirror that returns HTTP 200 but an
 * empty element set for a query we expect to be non-empty is treated as a miss
 * and we fall through to the next.
 */
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
];

export interface OverpassConfig {
  name: string;
  source: string;
  /**
   * Overpass QL body WITHOUT the settings/out lines. Use `{{bbox}}` where a
   * bounding box should be injected. Example:
   *   'node["highway"="bus_stop"]({{bbox}}); node["railway"="station"]({{bbox}});'
   */
  query: string;
  /** Default bbox [south, west, north, east] if the run doesn't pass one. */
  defaultBbox: [number, number, number, number];
  /** Sub-kind tag written into data.__poi_kind (e.g. "transit", "starbucks"). */
  poiKind: string;
  license?: string;
}

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements: OverpassElement[];
}

export function overpassConnector(cfg: OverpassConfig): Connector {
  const entity: EntityType = "poi";

  async function* fetchAll(
    opts: FetchOptions = {},
  ): AsyncGenerator<RawRecord, void, unknown> {
    const [s, w, n, e] = opts.bbox ?? cfg.defaultBbox;
    const bboxStr = `${s},${w},${n},${e}`;
    const body = `[out:json][timeout:120];(${cfg.query.replaceAll(
      "{{bbox}}",
      bboxStr,
    )});out center;`;

    // Overpass 406s on GET with an application/json Accept header; POST the
    // query as a form body instead (matches the API's expected content type).
    const fetchedAt = nowIso();
    let res: OverpassResponse | undefined;
    let usedEndpoint = OVERPASS_ENDPOINTS[0]!;
    let lastErr: unknown;
    for (let i = 0; i < OVERPASS_ENDPOINTS.length; i++) {
      const endpoint = OVERPASS_ENDPOINTS[i]!;
      const isLast = i === OVERPASS_ENDPOINTS.length - 1;
      try {
        const r = await getJson<OverpassResponse>(endpoint, {
          method: "POST",
          body: `data=${encodeURIComponent(body)}`,
          // Overpass/Apache does content-negotiation and 406s on a strict
          // application/json Accept; ask for anything.
          headers: { accept: "*/*" },
          cacheKey: `${cfg.name}/${bboxStr}`,
          noCache: opts.noCache,
        });
        // Skip mirrors that answer 200 but empty (unless it's the last try).
        if (!isLast && (r.elements?.length ?? 0) === 0) continue;
        res = r;
        usedEndpoint = endpoint;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!res) {
      throw new Error(
        `all Overpass endpoints failed for ${cfg.name}: ${String(lastErr)}`,
      );
    }

    let yielded = 0;
    for (const el of res.elements ?? []) {
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (lat === undefined || lon === undefined) continue;
      yield {
        entity,
        sourceId: `${el.type}/${el.id}`,
        data: {
          osm_type: el.type,
          osm_id: el.id,
          lat,
          lon,
          name: el.tags?.name ?? null,
          __poi_kind: cfg.poiKind,
          tags: el.tags ?? {},
        },
        provenance: {
          source: cfg.source,
          sourceUrl: usedEndpoint,
          fetchedAt,
          license: cfg.license ?? "OpenStreetMap ODbL",
        },
      };
      yielded++;
      if (opts.limit !== undefined && yielded >= opts.limit) return;
    }
  }

  return { name: cfg.name, entity, source: cfg.source, fetch: fetchAll };
}
