/**
 * Demo-question building blocks (county-agnostic).
 *
 * The concrete per-county question sets are assembled in `counties.ts`, which
 * supplies the backing table fragment and POI sets. This module only defines
 * the shared types and the SQL helpers so the two surfaces that consume a
 * question (the Search honesty labels and the standalone question cards) can
 * never drift from the underlying math.
 *
 * Honesty rule: every question is graded against the columns that actually
 * exist in the active county's query table.
 * - 'supported'  -- answerable directly from real columns
 * - 'partial'    -- answerable via a clearly-labeled proxy or sample POI set
 * - 'deferred'   -- the schema genuinely cannot answer it yet; no fake results
 */
import { sqlString } from './lib/duckdb';

export type QuestionStatus = 'supported' | 'partial' | 'deferred';

export interface DemoQuestion {
  id: string;
  title: string;
  question: string;
  status: QuestionStatus;
  /** Honest description of what the data can and cannot say. */
  dataBasis: string;
  /** Scalar count query (single row, single column). Absent when deferred. */
  summarySql?: string;
  summaryLabel?: string;
  /** Sample-rows query. Absent when deferred. */
  rowsSql?: string;
}

/**
 * A point of interest with approximate coordinates. Shared as the single
 * source of truth for the POI sets used by BOTH the demo-question SQL AND the
 * composable Search filters (ui/src/searchQuery.ts), so the two surfaces can
 * never drift apart.
 */
export interface Poi {
  name: string;
  lat: number;
  lon: number;
}

/** Render a POI array as SQL `VALUES` rows: `  ('name', lat, lon)`. */
export function poisToValues(pois: Poi[]): string {
  return pois
    .map((p) => `  (${sqlString(p.name)}, ${p.lat}, ${p.lon})`)
    .join(',\n');
}

/**
 * Haversine distance in meters, with a cheap bounding-box prefilter
 * (~0.008 deg lat / 0.009 deg lon) so we do not compute trigonometry for every
 * row x every POI. `table` is the caller's read_parquet(...) fragment.
 */
export function poiProximitySql(
  table: string,
  pois: Poi[],
  radiusMeters: number,
): { summary: string; rows: string } {
  const near = `
WITH pois(poi_name, plat, plon) AS (VALUES
${poisToValues(pois)}
),
near AS (
  SELECT t.property_id, t.parcel_identifier, t.address_street, t.address_city,
         t.address_zip, t.property_type, t.source_system, p.poi_name,
         round(2 * 6371000 * asin(sqrt(
           pow(sin(radians(t.latitude - p.plat) / 2), 2) +
           cos(radians(p.plat)) * cos(radians(t.latitude)) *
           pow(sin(radians(t.longitude - p.plon) / 2), 2)
         ))) AS distance_m
  FROM ${table} t, pois p
  WHERE t.latitude  BETWEEN p.plat - 0.0080 AND p.plat + 0.0080
    AND t.longitude BETWEEN p.plon - 0.0090 AND p.plon + 0.0090
)`;
  return {
    summary: `${near}
SELECT COUNT(DISTINCT parcel_identifier) FROM near WHERE distance_m <= ${radiusMeters}`,
    rows: `${near}
SELECT parcel_identifier, address_street, address_city, property_type,
       poi_name AS nearest_sample_poi, distance_m, source_system
FROM near
WHERE distance_m <= ${radiusMeters}
QUALIFY row_number() OVER (PARTITION BY parcel_identifier ORDER BY distance_m) = 1
ORDER BY distance_m
LIMIT 25`,
  };
}
