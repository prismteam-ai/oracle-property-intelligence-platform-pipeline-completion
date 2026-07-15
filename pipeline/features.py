"""Feature mart definitions — precomputed at build time so agent queries are
simple indexed lookups instead of repeated parsing/joins at question time.

Shared constants (walk distance, haversine, water bodies, address key) live
here so both build_db (materialization) and agent (presentation) use one
definition.
"""

WALK_M = 800  # default walking distance in meters
POI_MAX_M = 1600  # marts precompute POI distances up to this radius
WATER_M = 1200  # default "view of water" proximity threshold
WATER_MAX_M = 3000  # marts precompute water distances up to this radius

HAVERSINE = ("2*6371000*asin(sqrt(pow(sin(radians({blat}-{alat})/2),2)"
             "+cos(radians({alat}))*cos(radians({blat}))"
             "*pow(sin(radians({blon}-{alon})/2),2)))")

# permits ISSUEDATE arrives as e.g. '4/10/2018 12:00:00 AM'
DATE = "try_strptime(ISSUEDATE, '%-m/%-d/%Y %-I:%M:%S %p')"


def addr_key(col):
    """Normalized street-address key used to match records across sources."""
    return f"trim(upper(regexp_replace(split_part({col}, ',', 1), ' +', ' ', 'g')))"


# Approximate centers of named water bodies in/adjacent to Santa Clara County
WATER_BODIES = [
    ("San Francisco Bay (Alviso)", 37.443, -121.998),
    ("San Francisco Bay (Palo Alto Baylands)", 37.459, -122.105),
    ("Shoreline Lake", 37.431, -122.086),
    ("Vasona Lake", 37.243, -121.965),
    ("Lexington Reservoir", 37.201, -121.986),
    ("Calero Reservoir", 37.178, -121.774),
    ("Anderson Lake", 37.166, -121.631),
    ("Almaden Reservoir", 37.163, -121.822),
    ("Stevens Creek Reservoir", 37.297, -122.077),
    ("Guadalupe Reservoir", 37.199, -121.875),
    ("Coyote Lake", 37.121, -121.550),
    ("Campbell Percolation Ponds", 37.279, -121.966),
]


def _water_parts():
    selects = " , ".join(
        f"{HAVERSINE.format(alat='centroid_lat', alon='centroid_lon', blat=lat, blon=lon)} AS d{i}"
        for i, (name, lat, lon) in enumerate(WATER_BODIES))
    least = "least(" + ",".join(f"d{i}" for i in range(len(WATER_BODIES))) + ")"
    name_case = "CASE " + " ".join(
        f"WHEN {least} = d{i} THEN '{name}'"
        for i, (name, _, _) in enumerate(WATER_BODIES)) + " END"
    return selects, least, name_case


def _near_poi_table(poi_filter, poi_label):
    dist = HAVERSINE.format(alat="l.lat", alon="l.lon", blat="b.lat", blon="b.lon")
    # bounding box sized for POI_MAX_M at ~37°N
    return f"""
    SELECT l.apn, l.full_address AS address, l.match_key, l.city,
           round(min({dist})) AS distance_m,
           any_value(b.name) AS nearest_{poi_label},
           any_value(l._source_url) AS property_source,
           any_value(b._source_url) AS poi_source
    FROM locations l
    JOIN businesses b
      ON abs(l.lat - b.lat) < 0.0146 AND abs(l.lon - b.lon) < 0.0183
    WHERE {poi_filter} AND l.lat IS NOT NULL AND b.lat IS NOT NULL
    GROUP BY l.apn, l.full_address, l.match_key, l.city
    HAVING min({dist}) <= {POI_MAX_M}"""


def build_features(con):
    """Materialize derived columns + feature marts as native DuckDB tables.

    Assumes base tables (properties, permits, ownership, locations,
    businesses, contractors) are already materialized as native tables.
    Returns {feature_table: row_count}.
    """
    # -- derived columns on base tables (parse once, store forever) ----------
    con.execute(f"""
        CREATE OR REPLACE TABLE permits AS
        SELECT *, {DATE} AS issue_ts, {addr_key('gx_location')} AS match_key
        FROM permits ORDER BY match_key""")
    con.execute(f"""
        CREATE OR REPLACE TABLE locations AS
        SELECT *, {addr_key('full_address')} AS match_key
        FROM locations ORDER BY match_key""")
    con.execute(f"""
        CREATE OR REPLACE TABLE properties AS
        SELECT *, {addr_key('situs_address')} AS match_key
        FROM properties ORDER BY match_key""")
    con.execute(f"""
        CREATE OR REPLACE TABLE ownership AS
        SELECT *, {addr_key('situs_address')} AS match_key
        FROM ownership ORDER BY match_key""")

    selects, least, name_case = _water_parts()
    # Marts store raw values (age, tenure, distance) with generous ceilings so
    # thresholds can be applied dynamically at query time by the Data
    # Exploration filters; the chat intents apply the default thresholds.
    marts = {
        "feat_roof": """
            WITH roof AS (
              SELECT ASSESSORS_PARCEL_NUMBER AS apn,
                     max(issue_ts) AS last_roof_ts,
                     any_value(gx_location) AS address,
                     any_value(match_key) AS match_key,
                     any_value(OWNERNAME) AS owner,
                     any_value(WORKDESCRIPTION) AS evidence,
                     any_value(_source_url) AS source
              FROM permits
              WHERE WORKDESCRIPTION ILIKE '%roof%' AND issue_ts IS NOT NULL
              GROUP BY 1)
            SELECT apn, address, match_key, owner,
                   strftime(last_roof_ts, '%Y-%m-%d') AS last_roof_permit,
                   date_diff('year', last_roof_ts, current_date) AS roof_age_years,
                   evidence, source
            FROM roof""",
        "feat_stable_owner": """
            SELECT ASSESSORS_PARCEL_NUMBER AS apn,
                   any_value(gx_location) AS address,
                   any_value(match_key) AS match_key,
                   any_value(OWNERNAME) AS owner,
                   strftime(min(issue_ts), '%Y-%m-%d') AS first_permit,
                   strftime(max(issue_ts), '%Y-%m-%d') AS last_permit,
                   date_diff('year', min(issue_ts), current_date) AS years_of_history,
                   any_value(_source_url) AS source
            FROM permits
            WHERE OWNERNAME IS NOT NULL AND issue_ts IS NOT NULL
            GROUP BY 1
            HAVING count(DISTINCT OWNERNAME) = 1
               AND count(*) > 1""",
        "feat_regional": f"""
            WITH own AS (
              SELECT o.apn, o.owner_name, o.owner_city, o.owner_state, o.owner_zip,
                     o.land_value, o.centroid_lat, o.centroid_lon,
                     o.situs_address, o.match_key AS own_key,
                     o._source_url AS source
              FROM ownership o WHERE o.owner_name IS NOT NULL),
            near_addr AS (
              -- ownership situs fields are blank server-side, so borrow the
              -- nearest address point (<=250 m) for a cross-source match key
              SELECT own.apn,
                     arg_min(l.full_address,
                             {HAVERSINE.format(alat='own.centroid_lat', alon='own.centroid_lon',
                                               blat='l.lat', blon='l.lon')}) AS near_address,
                     arg_min(l.match_key,
                             {HAVERSINE.format(alat='own.centroid_lat', alon='own.centroid_lon',
                                               blat='l.lat', blon='l.lon')}) AS near_key,
                     min({HAVERSINE.format(alat='own.centroid_lat', alon='own.centroid_lon',
                                           blat='l.lat', blon='l.lon')}) AS addr_dist_m
              FROM own
              JOIN locations l
                ON abs(own.centroid_lat - l.lat) < 0.0023
               AND abs(own.centroid_lon - l.lon) < 0.0029
              WHERE own.centroid_lat IS NOT NULL AND l.lat IS NOT NULL
              GROUP BY own.apn
              HAVING min({HAVERSINE.format(alat='own.centroid_lat', alon='own.centroid_lon',
                                           blat='l.lat', blon='l.lon')}) <= 250)
            SELECT own.apn,
                   coalesce(na.near_address,
                            nullif(nullif(trim(own.situs_address), ''), '(LAND ONLY)')) AS address,
                   coalesce(na.near_key,
                            CASE WHEN own.own_key ~ '^[0-9]+ ' THEN own.own_key END) AS match_key,
                   own.owner_name, own.owner_city, own.owner_state, own.owner_zip,
                   own.land_value, own.centroid_lat, own.centroid_lon,
                   round(na.addr_dist_m) AS matched_address_m, own.source
            FROM own LEFT JOIN near_addr na USING (apn)""",
        "feat_water": f"""
            WITH p AS (
              SELECT apn, situs_address, match_key, situs_city,
                     centroid_lat, centroid_lon, {selects},
                     _source_url AS source
              FROM properties WHERE centroid_lat IS NOT NULL)
            SELECT apn, situs_address AS address, match_key, situs_city AS city,
                   round({least}) AS meters_to_water,
                   {name_case} AS nearest_water_body, source
            FROM p WHERE {least} <= {WATER_MAX_M}""",
        "feat_transit": _near_poi_table("b.category = 'transit'", "stop"),
        "feat_starbucks": _near_poi_table(
            "(b.name ILIKE '%starbucks%' OR b.brand ILIKE '%starbucks%')",
            "starbucks"),
    }
    counts = {}
    for name, sql in marts.items():
        con.execute(f"CREATE OR REPLACE TABLE {name} AS {sql} ORDER BY match_key")
        counts[name] = con.execute(f"SELECT count(*) FROM {name}").fetchone()[0]
    return counts
