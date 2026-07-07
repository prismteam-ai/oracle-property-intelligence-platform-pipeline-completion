/**
 * The six assignment questions as saved queries.
 *
 * Honesty rule: every question is graded against the columns that actually
 * exist in the query table (verified via DESCRIBE against the live parquet).
 * - 'supported'  -- answerable directly from real columns
 * - 'partial'    -- answerable via a clearly-labeled proxy or sample POI set
 * - 'deferred'   -- the schema genuinely cannot answer it yet; no fake results
 */
import { TABLE } from './config';

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
 * Haversine distance in meters, with a cheap bounding-box prefilter
 * (0.008 deg lat / 0.009 deg lon ~ 890 m at 26.5 N) so we do not compute
 * trigonometry for all 511k rows x every POI.
 */
function poiProximitySql(
  poisValues: string,
  radiusMeters: number,
): { summary: string; rows: string } {
  const near = `
WITH pois(poi_name, plat, plon) AS (VALUES
${poisValues}
),
near AS (
  SELECT t.property_id, t.parcel_identifier, t.address_street, t.address_city,
         t.address_zip, t.property_type, t.source_system, p.poi_name,
         round(2 * 6371000 * asin(sqrt(
           pow(sin(radians(t.latitude - p.plat) / 2), 2) +
           cos(radians(p.plat)) * cos(radians(t.latitude)) *
           pow(sin(radians(t.longitude - p.plon) / 2), 2)
         ))) AS distance_m
  FROM ${TABLE} t, pois p
  WHERE t.latitude  BETWEEN p.plat - 0.0080 AND p.plat + 0.0080
    AND t.longitude BETWEEN p.plon - 0.0090 AND p.plon + 0.0090
)`;
  return {
    summary: `${near}
SELECT COUNT(DISTINCT property_id) FROM near WHERE distance_m <= ${radiusMeters}`,
    rows: `${near}
SELECT parcel_identifier, address_street, address_city, property_type,
       poi_name AS nearest_sample_poi, distance_m, source_system
FROM near
WHERE distance_m <= ${radiusMeters}
ORDER BY distance_m
LIMIT 25`,
  };
}

// Sample POI sets -- approximate coordinates, v1 placeholder.
// Full POI data (GTFS transit stops, places API) lands with the Santa Clara ingest.
const TRANSIT_POIS = `  ('Rosa Parks Transportation Center, Fort Myers', 26.6444, -81.8710),
  ('Edison Mall transfer point, Fort Myers',      26.5983, -81.8709),
  ('Cape Coral Transfer Center (SE 47th Terr)',   26.5624, -81.9497),
  ('Beach Park & Ride, Summerlin Square',         26.4547, -81.9494),
  ('Lehigh Acres transfer point (Homestead Rd)',  26.6079, -81.6448)`;

const STARBUCKS_POIS = `  ('Starbucks - First St, Downtown Fort Myers',   26.6414, -81.8687),
  ('Starbucks - Cleveland Ave (US-41), Fort Myers', 26.5987, -81.8720),
  ('Starbucks - Santa Barbara Blvd, Cape Coral',  26.6249, -81.9740),
  ('Starbucks - Coconut Point, Estero',           26.4022, -81.8065),
  ('Starbucks - Gulf Coast Town Center',          26.4859, -81.7859),
  ('Starbucks - Bonita Beach Rd, Bonita Springs', 26.3312, -81.8069)`;

const transit = poiProximitySql(TRANSIT_POIS, 800);
const starbucks = poiProximitySql(STARBUCKS_POIS, 800);

export const DEMO_QUESTIONS: DemoQuestion[] = [
  {
    id: 'roof-age',
    title: 'A. Roofs older than 15 years',
    question: 'Which properties have roofs older than 15 years?',
    status: 'partial',
    dataBasis:
      'The schema has a roof_covering_material column but it is 100% NULL in ' +
      'this extract, and there is no roof-install date. Proxy used: structure ' +
      'built 15+ years ago with no permit on record (has_permits = FALSE), so ' +
      'the roof is presumed original. Direct roof-age answers land with the ' +
      'permit/enrichment phase.',
    summaryLabel: 'properties with a presumed-original roof aged 15+ years',
    summarySql: `SELECT COUNT(*)
FROM ${TABLE}
WHERE built_year IS NOT NULL AND built_year > 0
  AND built_year <= year(current_date) - 15
  AND has_permits = FALSE
  AND property_type IN ('Building', 'ManufacturedHome')`,
    rowsSql: `SELECT parcel_identifier, address_street, address_city, built_year,
       year(current_date) - built_year AS structure_age_years,
       property_type, has_permits, source_system
FROM ${TABLE}
WHERE built_year IS NOT NULL AND built_year > 0
  AND built_year <= year(current_date) - 15
  AND has_permits = FALSE
  AND property_type IN ('Building', 'ManufacturedHome')
ORDER BY built_year
LIMIT 25`,
  },
  {
    id: 'water-view',
    title: 'B. View of water',
    question: 'Which properties have a view of water?',
    status: 'deferred',
    dataBasis:
      'Requires geo enrichment - lands with the county data phase. None of the ' +
      '37 columns encode view, waterfront, or water frontage. Latitude/longitude ' +
      'are fully populated (511,695 rows), so once water-body geometry (NHD / ' +
      'county GIS shoreline) is ingested this becomes a straightforward spatial ' +
      'join. No results are shown because none can honestly be computed yet.',
  },
  {
    id: 'ownership-tenure',
    title: 'C. No ownership change in 10+ years',
    question: 'Which properties have not changed ownership in more than 10 years?',
    status: 'supported',
    dataBasis:
      'Computed directly from last_sale_date (recorded for 510,934 of 511,695 ' +
      'rows). Rows with no recorded sale are excluded rather than assumed - ' +
      'tenure cannot be verified for them. Dates are stored as JS-style strings ' +
      'and parsed in SQL.',
    summaryLabel: 'properties with no ownership change in over 10 years',
    summarySql: `SELECT COUNT(*)
FROM ${TABLE}
WHERE try_strptime(substr(last_sale_date, 1, 15), '%a %b %d %Y')
      < current_date - INTERVAL 10 YEAR`,
    rowsSql: `SELECT parcel_identifier, address_street, address_city,
       strftime(try_strptime(substr(last_sale_date, 1, 15), '%a %b %d %Y'),
                '%Y-%m-%d') AS last_sale,
       owner_name, source_system
FROM ${TABLE}
WHERE try_strptime(substr(last_sale_date, 1, 15), '%a %b %d %Y')
      < current_date - INTERVAL 10 YEAR
ORDER BY last_sale
LIMIT 25`,
  },
  {
    id: 'regional-owners',
    title: 'D. Regional owners',
    question: 'Which properties are held by regional owners?',
    status: 'partial',
    dataBasis:
      'This extract has owner_name / owners_text / owner_occupied but no owner ' +
      'mailing address, so in-region vs out-of-region cannot be determined ' +
      'directly. Proxy used: portfolio owners holding 5+ parcels in the county ' +
      '(3,820 such owners exist). True regional classification lands with ' +
      'owner-address enrichment.',
    summaryLabel: 'owners holding 5+ parcels in the county',
    summarySql: `SELECT COUNT(*) FROM (
  SELECT owner_name
  FROM ${TABLE}
  WHERE owner_name IS NOT NULL AND owner_name <> ''
  GROUP BY owner_name
  HAVING COUNT(*) >= 5
)`,
    rowsSql: `SELECT owner_name,
       COUNT(*) AS parcels_held,
       COUNT(DISTINCT address_city) AS cities,
       COUNT(*) FILTER (owner_occupied) AS owner_occupied_parcels,
       any_value(source_system) AS source_system
FROM ${TABLE}
WHERE owner_name IS NOT NULL AND owner_name <> ''
GROUP BY owner_name
HAVING COUNT(*) >= 5
ORDER BY parcels_held DESC
LIMIT 25`,
  },
  {
    id: 'transit',
    title: 'E. Walking distance to public transportation',
    question:
      'Which properties are within walking distance (~800 m) of public transportation?',
    status: 'partial',
    dataBasis:
      'Latitude/longitude are populated for all 511,695 rows, so the distance ' +
      'math (haversine) is real. The transit locations are a SAMPLE POI SET: 5 ' +
      'approximate LeeTran hub/transfer coordinates hardcoded for v1. The full ' +
      'GTFS stop network lands with the Santa Clara ingest, at which point this ' +
      'query only swaps its POI table.',
    summaryLabel: 'properties within 800 m of a sample transit hub',
    summarySql: transit.summary,
    rowsSql: transit.rows,
  },
  {
    id: 'starbucks',
    title: 'F. Walking distance to Starbucks',
    question: 'Which properties are within walking distance (~800 m) of a Starbucks?',
    status: 'partial',
    dataBasis:
      'Same basis as the transit question: real per-property coordinates, ' +
      'haversine distance, but against a SAMPLE POI SET of 6 approximate ' +
      'Starbucks locations in the county. Full place data lands with the Santa ' +
      'Clara ingest.',
    summaryLabel: 'properties within 800 m of a sample Starbucks location',
    summarySql: starbucks.summary,
    rowsSql: starbucks.rows,
  },
];
