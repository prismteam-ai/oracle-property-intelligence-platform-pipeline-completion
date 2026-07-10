/**
 * Generic ArcGIS REST FeatureServer/MapServer connector.
 *
 * Powers county GIS/assessor layers (Santa Clara County parcels, ownership,
 * addresses) exposed as Esri REST services. Concrete layers are config: the
 * layer query URL + which attribute is the natural key. Geometry is requested
 * as GeoJSON so lat/lon is preserved for the coordinate-based questions
 * (near transit, near Starbucks, water view).
 *
 * Paging uses resultOffset/resultRecordCount. Some old servers cap page size
 * (maxRecordCount); we honor `pageSize` and stop when a short page returns.
 * Docs: https://developers.arcgis.com/rest/services-reference/enterprise/query-feature-service-layer/
 */

import type {
  Connector,
  EntityType,
  FetchOptions,
  RawRecord,
} from "./types.js";
import { getJson, nowIso } from "../lib/http.js";

export interface ArcGisConfig {
  name: string;
  entity: EntityType;
  source: string;
  /** Layer base URL, e.g. ".../FeatureServer/0" (no trailing /query). */
  layerUrl: string;
  /** Attribute holding the natural key (APN/PARCELID/OBJECTID). */
  idField: string;
  /** SQL where clause; default "1=1" (all). */
  where?: string;
  /** Comma list of out fields or "*". */
  outFields?: string;
  /** Request geometry (adds `geometry` GeoJSON to each record). */
  returnGeometry?: boolean;
  license?: string;
  /** Page size; many servers cap at 1000-2000. */
  pageSize?: number;
}

interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: Record<string, unknown> | null;
    geometry: { type: string; coordinates: unknown } | null;
  }>;
}

export function arcgisConnector(cfg: ArcGisConfig): Connector {
  const pageSize = cfg.pageSize ?? 1000;

  async function* fetchAll(
    opts: FetchOptions = {},
  ): AsyncGenerator<RawRecord, void, unknown> {
    let offset = 0;
    let yielded = 0;
    const fetchedAt = nowIso();

    for (;;) {
      const remaining =
        opts.limit === undefined ? pageSize : Math.min(pageSize, opts.limit - yielded);
      if (remaining <= 0) return;

      const params = new URLSearchParams({
        where: cfg.where ?? "1=1",
        outFields: cfg.outFields ?? "*",
        f: "geojson",
        returnGeometry: String(cfg.returnGeometry ?? true),
        resultOffset: String(offset),
        resultRecordCount: String(remaining),
        outSR: "4326", // WGS84 lat/lon
      });
      if (opts.bbox) {
        const [s, w, n, e] = opts.bbox;
        params.set("geometry", `${w},${s},${e},${n}`);
        params.set("geometryType", "esriGeometryEnvelope");
        params.set("inSR", "4326");
        params.set("spatialRel", "esriSpatialRelIntersects");
      }

      const url = `${cfg.layerUrl}/query?${params}`;
      const fc = await getJson<GeoJsonFeatureCollection>(url, {
        // Include exact query params so a page fetched under a smaller
        // resultRecordCount is never reused for a larger request.
        cacheKey: `${cfg.name}/${params.toString()}`,
        noCache: opts.noCache,
      });

      const features = fc?.features ?? [];
      if (features.length === 0) return;

      for (const f of features) {
        const props = f.properties ?? {};
        const sourceId =
          (props[cfg.idField] as string | undefined) ??
          `${cfg.name}:${offset}:${yielded}`;
        yield {
          entity: cfg.entity,
          sourceId: String(sourceId),
          // keep geometry alongside attributes so lat/lon survives to load time
          data: { ...props, __geometry: f.geometry },
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

      offset += features.length;
      if (features.length < remaining) return; // last page
    }
  }

  return {
    name: cfg.name,
    entity: cfg.entity,
    source: cfg.source,
    fetch: fetchAll,
  };
}
