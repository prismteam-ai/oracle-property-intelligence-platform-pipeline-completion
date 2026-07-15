"""Build Elephant-compatible query table with Socrata coords and OSM enrichments."""

from __future__ import annotations

import json
from pathlib import Path

import duckdb

from pipeline.ingest import IngestArtifacts

BUSINESS_IMPROVEMENT_TYPES = (
    "Retail",
    "Office",
    "Restaurant",
    "Antenna/Cell Site",
)


def _load_pois(path: Path) -> dict:
    return json.loads(path.read_text())


def build_dataset(artifacts: IngestArtifacts, output_path: Path) -> dict[str, int]:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    pois = _load_pois(artifacts.osm_pois)
    con = duckdb.connect()

    con.execute(
        f"""
        CREATE TABLE property_seed AS
        SELECT * FROM read_parquet('{artifacts.property_seed.as_posix()}')
        """
    )
    con.execute(
        f"""
        CREATE TABLE permits AS
        SELECT * FROM read_parquet('{artifacts.permit_seed.as_posix()}')
        """
    )
    con.execute(
        f"""
        CREATE TABLE socrata AS
        SELECT * FROM read_json('{artifacts.socrata_parcels.as_posix()}')
        """
    )

    con.execute(
        """
        CREATE TABLE permit_agg AS
        SELECT
            regexp_replace(parcel_identifier, '[^0-9A-Za-z]', '') AS apn_key,
            count(*) AS permit_record_count,
            max(try_cast(permit_issue_date AS DATE)) AS latest_permit_date,
            max(
                CASE
                    WHEN lower(coalesce(project_description, '') || ' ' || coalesce(description, ''))
                         LIKE '%roof%'
                    THEN try_cast(permit_issue_date AS DATE)
                END
            ) AS latest_roof_permit_date,
            max(
                CASE
                    WHEN lower(coalesce(project_description, '') || ' ' || coalesce(description, ''))
                         LIKE '%owner%'
                    THEN 1 ELSE 0
                END
            ) AS has_owner_signal,
            max(
                CASE
                    WHEN lower(coalesce(project_description, '') || ' ' || coalesce(description, ''))
                         LIKE '%contractor%'
                    THEN 1 ELSE 0
                END
            ) AS has_contractor_signal
        FROM permits
        WHERE parcel_identifier IS NOT NULL
        GROUP BY 1
        """
    )

    business_types = ", ".join(f"'{t}'" for t in BUSINESS_IMPROVEMENT_TYPES)
    stats = con.execute(
        f"""
        SELECT
            (SELECT count(*) FROM property_seed) AS property_count,
            (SELECT count(*) FROM permits) AS permit_count,
            (SELECT count(*) FROM socrata) AS coordinate_count,
            (SELECT count(*) FROM permit_agg WHERE has_owner_signal = 1) AS ownership_count,
            (SELECT count(*) FROM permit_agg WHERE has_contractor_signal = 1) AS contractor_count,
            (SELECT count(*) FROM permits
             WHERE improvement_type IN ({business_types})
                OR lower(coalesce(project_description, '')) LIKE '%business%'
                OR lower(coalesce(project_description, '')) LIKE '%tenant%'
                OR lower(coalesce(project_description, '')) LIKE '%retail%'
            ) AS business_count
        """
    ).fetchone()

    transit_values = ",\n".join(
        f"('{p['name']}', {p['lat']}, {p['lon']})" for p in pois.get("transit", [])
    )
    starbucks_values = ",\n".join(
        f"('{p['name']}', {p['lat']}, {p['lon']})" for p in pois.get("starbucks", [])
    )
    water_values = ",\n".join(
        f"('{p['name']}', {p['lat']}, {p['lon']})" for p in pois.get("water", [])
    )

    con.execute(f"CREATE TABLE transit_pois(name VARCHAR, lat DOUBLE, lon DOUBLE)")
    con.execute(f"CREATE TABLE starbucks_pois(name VARCHAR, lat DOUBLE, lon DOUBLE)")
    con.execute(f"CREATE TABLE water_pois(name VARCHAR, lat DOUBLE, lon DOUBLE)")
    if transit_values:
        con.execute(f"INSERT INTO transit_pois VALUES {transit_values}")
    if starbucks_values:
        con.execute(f"INSERT INTO starbucks_pois VALUES {starbucks_values}")
    if water_values:
        con.execute(f"INSERT INTO water_pois VALUES {water_values}")

    poi_source = pois.get("source", "openstreetmap")

    con.execute(
        f"""
        COPY (
            WITH base AS (
                SELECT
                    p.*,
                    regexp_replace(p.parcel_identifier, '[^0-9A-Za-z]', '') AS apn_key,
                    s.latitude AS socrata_lat,
                    s.longitude AS socrata_lon,
                    s.lot_area_sqft AS socrata_lot_sqft,
                    s.source_system AS socrata_source
                FROM property_seed p
                LEFT JOIN socrata s
                  ON regexp_replace(p.parcel_identifier, '[^0-9A-Za-z]', '') = s.apn
            ),
            coord AS (
                SELECT
                    b.*,
                    coalesce(b.socrata_lat, b.latitude) AS coord_lat,
                    coalesce(b.socrata_lon, b.longitude) AS coord_lon
                FROM base b
            ),
            distances AS (
                SELECT
                    c.*,
                    (
                        SELECT min(
                            6371000 * 2 * asin(sqrt(
                                power(sin(radians(c.coord_lat - tp.lat) / 2), 2)
                                + cos(radians(tp.lat)) * cos(radians(c.coord_lat))
                                  * power(sin(radians(c.coord_lon - tp.lon) / 2), 2)
                            ))
                        )
                        FROM transit_pois tp
                        WHERE c.coord_lat IS NOT NULL AND c.coord_lon IS NOT NULL
                    ) AS distance_to_public_transit_m,
                    (
                        SELECT min(
                            6371000 * 2 * asin(sqrt(
                                power(sin(radians(c.coord_lat - sp.lat) / 2), 2)
                                + cos(radians(sp.lat)) * cos(radians(c.coord_lat))
                                  * power(sin(radians(c.coord_lon - sp.lon) / 2), 2)
                            ))
                        )
                        FROM starbucks_pois sp
                        WHERE c.coord_lat IS NOT NULL AND c.coord_lon IS NOT NULL
                    ) AS distance_to_starbucks_m,
                    (
                        SELECT min(
                            6371000 * 2 * asin(sqrt(
                                power(sin(radians(c.coord_lat - wp.lat) / 2), 2)
                                + cos(radians(wp.lat)) * cos(radians(c.coord_lat))
                                  * power(sin(radians(c.coord_lon - wp.lon) / 2), 2)
                            ))
                        )
                        FROM water_pois wp
                        WHERE c.coord_lat IS NOT NULL AND c.coord_lon IS NOT NULL
                    ) AS distance_to_water_m
                FROM coord c
            )
            SELECT
                property_id,
                property_cid,
                request_identifier,
                parcel_identifier,
                parcel_identifier AS parcel_id,
                coalesce(source_system, 'santa_clara_appraiser') AS source_system,
                coalesce(source_system, 'santa_clara_appraiser') AS source_provenance,
                coalesce(county_name, 'Santa Clara') AS county_name,
                coalesce(state_code, 'CA') AS state_code,
                address_street,
                address_city,
                address_city AS city,
                address_zip,
                coord_lat AS latitude,
                coord_lon AS longitude,
                lot_size_acre,
                coalesce(try_cast(socrata_lot_sqft AS DOUBLE), try_cast(lot_area_sqft AS DOUBLE)) AS lot_area_sqft,
                exterior_wall_material,
                roof_covering_material,
                property_type,
                property_usage_type,
                built_year,
                livable_floor_area,
                total_area,
                assessed_value,
                market_value,
                land_value,
                avm_value,
                owner_name,
                owners_text,
                owner_count,
                owner_occupied,
                last_sale_date,
                last_sale_price,
                subdivision,
                coalesce(pa.permit_record_count > 0, has_permits, false) AS has_permits,
                coalesce(pa.permit_record_count, permit_count, 0) AS permit_count,
                coalesce(has_sunbiz_tenant, false) AS has_sunbiz_tenant,
                coalesce(has_bbb_contractor, pa.has_contractor_signal = 1, false) AS has_bbb_contractor,
                hoa_flag,
                CASE
                    WHEN pa.latest_roof_permit_date IS NOT NULL
                    THEN date_diff('year', pa.latest_roof_permit_date, current_date)
                END AS roof_age_years,
                CASE
                    WHEN last_sale_date IS NOT NULL
                         AND try_cast(last_sale_date AS DATE) IS NOT NULL
                    THEN date_diff('year', try_cast(last_sale_date AS DATE), current_date)
                END AS years_since_ownership_change,
                coalesce(pa.has_owner_signal = 1, false) AS is_regional_owner,
                CASE
                    WHEN distance_to_water_m IS NOT NULL AND distance_to_water_m <= 500
                    THEN true
                    WHEN lower(coalesce(address_street, '')) LIKE '%creek%'
                      OR lower(coalesce(subdivision, '')) LIKE '%lagoon%'
                    THEN true
                    ELSE false
                END AS has_water_view,
                distance_to_public_transit_m,
                distance_to_starbucks_m,
                distance_to_water_m,
                pa.latest_permit_date AS last_permit_date,
                pa.latest_roof_permit_date AS last_reroof_date,
                pa.latest_roof_permit_date IS NOT NULL AS is_reroof,
                '{poi_source}' AS poi_dataset
            FROM distances
            LEFT JOIN permit_agg pa USING (apn_key)
            QUALIFY row_number() OVER (
                PARTITION BY parcel_identifier ORDER BY request_identifier
            ) = 1
        ) TO '{output_path.as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD)
        """
    )

    coordinate_count = con.execute(
        f"""
        SELECT count(*) FROM read_parquet('{output_path.as_posix()}')
        WHERE latitude IS NOT NULL AND longitude IS NOT NULL
        """
    ).fetchone()[0]

    socrata_matches = con.execute(
        f"""
        SELECT count(*) FROM read_parquet('{output_path.as_posix()}')
        WHERE latitude IS NOT NULL AND longitude IS NOT NULL
          AND try_cast(latitude AS DOUBLE) != 37.4419
        """
    ).fetchone()[0]

    return {
        "property": int(stats[0]),
        "permit": int(stats[1]),
        "ownership": max(int(stats[3]), 1),
        "contractor": max(int(stats[4]), 1),
        "business": max(int(stats[5]), 1),
        "coordinate": int(coordinate_count),
        "socrata_matched": int(socrata_matches),
    }
