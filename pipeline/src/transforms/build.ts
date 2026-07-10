/**
 * Transform layer: build typed tables + the consolidated `properties` table from
 * raw_records.
 *
 * Reconciles the three sources on a normalized 8-digit APN (parcels `13213051`
 * vs permits `124-37-065`), computes parcel centroids and POI distances with the
 * DuckDB spatial extension, and rolls per-property signals for the six
 * questions. Every property carries a `sources` provenance array.
 *
 * Signal semantics (kept honest — see the data strategy):
 *  - roof_over_15: TRUE when there is NO roofing permit in the last 15 years
 *    (a recent re-roof permit => newer roof => FALSE). Permit history starts in
 *    2013, so "last roofing permit >15yr old" is impossible; absence of a recent
 *    roofing permit is the available signal. `roof_basis` records which case.
 *  - permit_dormant_10yr (Q4 PROXY, not sale data): TRUE when there is no permit
 *    activity in the last 10 years (incl. parcels with no permits 2013–2026).
 *  - owners_text / owner_data_available: Q3 gap — owner mailing address is not
 *    free open data in CA, so this is NULL/false and documented.
 *  - near_transit / near_starbucks: within 800 m (~10-min walk) of an OSM POI.
 *  - water_view: heuristic — within 150 m of an OSM water body (labeled).
 *
 * Run: npm run build:db   (after `npm run run` has populated raw_records)
 */

import { openDb } from "../db/load.js";
import type { DuckDBConnection } from "@duckdb/node-api";

const WALK_M = 800; // ~10-minute walk
const WATER_VIEW_M = 150; // adjacency heuristic for "view of water"
const ROOF_MAX_AGE = 15; // years
const DORMANT_YEARS = 10; // Q4 proxy window

async function run(conn: DuckDBConnection, sql: string): Promise<void> {
  await conn.run(sql);
}

async function main() {
  const conn = await openDb();
  await run(conn, "INSTALL spatial;");
  await run(conn, "LOAD spatial;");

  // ---- 1. Parcels -> one row per normalized APN, with centroid ----------
  // Dedup multi-situs rows: pick the lowest objectid deterministically.
  await run(conn, `
    CREATE OR REPLACE TABLE properties_base AS
    WITH ranked AS (
      SELECT
        regexp_replace(source_id, '[^0-9]', '', 'g')       AS apn_norm,
        source_id                                            AS parcel_apn,
        json_extract_string(data, '$.situs_house_number')   AS house_number,
        trim(concat_ws(' ',
          json_extract_string(data, '$.situs_street_name'),
          json_extract_string(data, '$.situs_street_type'))) AS street,
        json_extract_string(data, '$.situs_city_name')      AS city,
        json_extract_string(data, '$.situs_zip_code')       AS zip,
        json_extract_string(data, '$.jurisdiction')         AS jurisdiction,
        source                                               AS parcel_source,
        source_url                                           AS parcel_source_url,
        ST_Centroid(ST_GeomFromGeoJSON(json_extract(data, '$.the_geom'))) AS geom,
        row_number() OVER (
          PARTITION BY regexp_replace(source_id, '[^0-9]', '', 'g')
          ORDER BY CAST(json_extract_string(data, '$.objectid') AS BIGINT)
        ) AS rn
      FROM raw_records
      WHERE entity = 'property'
    )
    SELECT
      apn_norm, parcel_apn, house_number, street, city, zip, jurisdiction,
      parcel_source, parcel_source_url,
      ST_Y(geom) AS latitude,
      ST_X(geom) AS longitude,
      geom
    FROM ranked
    WHERE rn = 1 AND apn_norm <> '';
  `);

  // ---- 2. Permits -> typed --------------------------------------------
  await run(conn, `
    CREATE OR REPLACE TABLE permits_typed AS
    SELECT
      json_extract_string(data, '$.RECORD ID')                       AS permit_id,
      regexp_replace(json_extract_string(data, '$.APN'), '[^0-9]', '', 'g') AS apn_norm,
      try_strptime(json_extract_string(data, '$.DATE OPENED'), '%m/%d/%Y')::DATE AS permit_date,
      json_extract_string(data, '$.RECORD MODULE')                   AS module,
      json_extract_string(data, '$.RECORD STATUS')                   AS status,
      json_extract_string(data, '$.DESCRIPTION')                     AS description,
      TRY_CAST(regexp_replace(json_extract_string(data, '$.JOB VALUE'), '[^0-9.]', '', 'g') AS DOUBLE) AS job_value,
      json_extract_string(data, '$.BUSINESS NAME')                   AS business_name,
      json_extract_string(data, '$.LICENSE NBR')                     AS license_nbr,
      (lower(json_extract_string(data, '$.DESCRIPTION')) LIKE '%roof%') AS is_roofing,
      source, source_url
    FROM raw_records
    WHERE entity = 'permit';
  `);

  // ---- 3. POIs -> typed -----------------------------------------------
  await run(conn, `
    CREATE OR REPLACE TABLE pois_typed AS
    SELECT
      json_extract_string(data, '$.__poi_kind')     AS kind,
      json_extract_string(data, '$.name')           AS name,
      TRY_CAST(json_extract_string(data, '$.lat') AS DOUBLE) AS latitude,
      TRY_CAST(json_extract_string(data, '$.lon') AS DOUBLE) AS longitude,
      source, source_url,
      ST_Point(TRY_CAST(json_extract_string(data, '$.lon') AS DOUBLE),
               TRY_CAST(json_extract_string(data, '$.lat') AS DOUBLE)) AS geom
    FROM raw_records
    WHERE entity = 'poi';
  `);

  // ---- 4. Nearest POI distance per property per kind ------------------
  // Cross join (~21k parcels x ~870 POIs) + min per kind, pivoted to columns.
  await run(conn, `
    CREATE OR REPLACE TABLE prop_nearest AS
    WITH d AS (
      SELECT p.apn_norm,
             poi.kind,
             min(ST_Distance_Sphere(p.geom, poi.geom)) AS dist_m
      FROM properties_base p
      CROSS JOIN pois_typed poi
      GROUP BY 1, 2
    )
    SELECT
      apn_norm,
      max(CASE WHEN kind = 'transit'   THEN dist_m END) AS nearest_transit_m,
      max(CASE WHEN kind = 'starbucks' THEN dist_m END) AS nearest_starbucks_m,
      max(CASE WHEN kind = 'water'     THEN dist_m END) AS nearest_water_m
    FROM d GROUP BY apn_norm;
  `);

  // ---- 5. Permit rollup per property ----------------------------------
  await run(conn, `
    CREATE OR REPLACE TABLE prop_permits AS
    SELECT
      apn_norm,
      count(*)                                          AS permit_count,
      max(permit_date)                                  AS last_permit_date,
      max(CASE WHEN is_roofing THEN permit_date END)    AS last_roof_permit_date,
      count(*) FILTER (WHERE is_roofing)                AS roof_permit_count
    FROM permits_typed
    WHERE apn_norm <> ''
    GROUP BY apn_norm;
  `);

  // ---- 6. Consolidated properties table -------------------------------
  await run(conn, `
    CREATE OR REPLACE TABLE properties AS
    SELECT
      b.apn_norm                                        AS request_identifier,
      b.parcel_apn                                      AS parcel_identifier,
      'santa-clara'                                     AS county,
      b.house_number                                    AS address_house_number,
      b.street                                          AS address_street,
      b.city                                            AS address_city,
      b.zip                                             AS address_zip,
      b.latitude,
      b.longitude,

      -- Q1: roof age. A roofing permit in the last 15yr => newer roof (FALSE);
      -- no roofing permit in that window => roof likely >15yr (TRUE).
      pp.last_roof_permit_date,
      COALESCE(pp.roof_permit_count, 0)                 AS roof_permit_count,
      CASE WHEN pp.last_roof_permit_date IS NOT NULL
           THEN date_diff('year', pp.last_roof_permit_date, CURRENT_DATE) END AS years_since_roof_permit,
      (pp.last_roof_permit_date IS NULL
        OR pp.last_roof_permit_date < (CURRENT_DATE - INTERVAL ${ROOF_MAX_AGE} YEAR)) AS roof_over_15,
      CASE
        WHEN pp.last_roof_permit_date IS NULL THEN 'no_roofing_permit_on_record'
        WHEN pp.last_roof_permit_date >= (CURRENT_DATE - INTERVAL ${ROOF_MAX_AGE} YEAR)
          THEN 'reroofed_within_15yr'
        ELSE 'reroofed_over_15yr_ago'
      END                                               AS roof_basis,

      -- Q4 proxy: permit dormancy (NOT sale data)
      COALESCE(pp.permit_count, 0)                      AS permit_count,
      pp.last_permit_date,
      (pp.last_permit_date IS NULL
        OR pp.last_permit_date < (CURRENT_DATE - INTERVAL ${DORMANT_YEARS} YEAR)) AS permit_dormant_10yr,

      -- Q3 gap: owner data not in free open data (CA)
      CAST(NULL AS VARCHAR)                             AS owners_text,
      FALSE                                             AS owner_data_available,

      -- Q5 + water view: POI proximity
      n.nearest_transit_m,
      (n.nearest_transit_m <= ${WALK_M})                AS near_transit,
      n.nearest_starbucks_m,
      (n.nearest_starbucks_m <= ${WALK_M})              AS near_starbucks,
      n.nearest_water_m,
      (n.nearest_water_m <= ${WATER_VIEW_M})            AS water_view,

      -- provenance
      to_json([
        struct_pack(source := b.parcel_source, source_url := b.parcel_source_url,
                    contributes := 'parcel geometry, address, APN'),
        struct_pack(source := 'City of Palo Alto Development Center Permits',
                    source_url := 'https://data.paloalto.gov/',
                    contributes := 'roof age, permit dormancy, contractor'),
        struct_pack(source := 'OpenStreetMap (Overpass API)',
                    source_url := 'https://overpass-api.de/',
                    contributes := 'transit / Starbucks / water proximity')
      ])                                                AS sources
    FROM properties_base b
    LEFT JOIN prop_permits pp ON pp.apn_norm = b.apn_norm
    LEFT JOIN prop_nearest n  ON n.apn_norm  = b.apn_norm;
  `);

  // ---- Report --------------------------------------------------------
  const reader = await conn.runAndReadAll(`
    SELECT
      (SELECT count(*) FROM properties)                                   AS properties,
      (SELECT count(*) FROM properties WHERE roof_over_15)                AS roof_over_15,
      (SELECT count(*) FROM properties WHERE permit_dormant_10yr)         AS dormant_10yr,
      (SELECT count(*) FROM properties WHERE near_transit)                AS near_transit,
      (SELECT count(*) FROM properties WHERE near_starbucks)              AS near_starbucks,
      (SELECT count(*) FROM properties WHERE water_view)                  AS water_view,
      (SELECT count(*) FROM permits_typed)                               AS permits,
      (SELECT count(*) FROM pois_typed)                                  AS pois
  `);
  const row = reader.getRowObjects()[0]!;
  const num = (o: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v)]));
  console.log("Transform complete:");
  console.table(num(row));
  await conn.disconnectSync?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
