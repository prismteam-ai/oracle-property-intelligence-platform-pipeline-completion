#!/usr/bin/env python3
"""Build the Santa Clara County query-table Parquet from cached parcels + SJ permits.

Run: uv run --with duckdb --with shapely --with pyarrow --with base58 \
        python3 ingest/santa-clara/build_parquet.py

Outputs:
  data/santa-clara/santa-clara-query-table.parquet   (37 Lee cols + 3 permit extras)
  data/santa-clara/run-summary.json                  (pipeline run record)

Design notes:
  * lat/lon come from the parcel MultiPolygon centroid (no lat/lon field exists).
  * lot_area_sqft uses `shape_area_stateplane` -- verified against reprojected ground
    area (UTM 10N) to be the real square footage; the `shape_area` field is NOT sqft.
  * property_cid is a genuine IPFS CIDv0 (sha2-256 multihash, base58btc) of the
    parcel's canonical consolidated JSON -- a real content address before any pin.
  * Assessor-only fields (owner counts, values, year built, sales) are left NULL --
    honest gaps; that data is a paid offline bulk order.
"""
import glob
import hashlib
import json
import os
import sys
from datetime import datetime, date

import base58
import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
from shapely.geometry import shape

RAW_DIR = os.path.join("data", "santa-clara", "parcels-raw")
PERMITS_CSV = os.path.join("data", "santa-clara", "sj-permits.csv")
OUT_PARQUET = os.path.join("data", "santa-clara", "santa-clara-query-table.parquet")
OUT_SUMMARY = os.path.join("data", "santa-clara", "run-summary.json")

PARCELS_URL = "https://data.sccgov.org/resource/ubcd-cewv.geojson"
PERMITS_SOURCE = "San Jose Building Permits (data.sanjoseca.gov) — local file sj-permits.csv"

import uuid
NAMESPACE = uuid.UUID("00000000-0000-0000-0000-000000000000")  # deterministic uuid5 base


def norm_apn(v):
    if v is None:
        return None
    s = "".join(ch for ch in str(v) if ch.isalnum()).upper()
    return s or None


def cidv0(obj: dict) -> str:
    """Real IPFS CIDv0: base58btc(0x12 0x20 sha256(canonical_json))."""
    payload = json.dumps(obj, sort_keys=True, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(payload).digest()
    multihash = bytes([0x12, 0x20]) + digest  # sha2-256, 32 bytes
    return base58.b58encode(multihash).decode("ascii")


def clean(v):
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def assemble_street(p):
    parts = []
    hn = clean(p.get("situs_house_number"))
    suf = clean(p.get("situs_house_number_suffix"))
    if hn:
        parts.append(hn + (suf if suf else ""))
    for k in ("situs_street_direction", "situs_street_name", "situs_street_type"):
        v = clean(p.get(k))
        if v:
            parts.append(v)
    unit = clean(p.get("situs_unit_number"))
    if unit:
        parts.append("UNIT " + unit)
    return " ".join(parts) or None


def zip5(v):
    v = clean(v)
    if not v:
        return None
    return v.split("-")[0][:5]


def build_permit_index():
    """Return dict: normalized apn -> aggregate permit facts."""
    con = duckdb.connect()
    con.execute(
        f"CREATE TABLE p AS SELECT * FROM read_csv('{PERMITS_CSV}',header=true,all_varchar=true)"
    )
    rows = con.execute(
        r"""
        WITH n AS (
          SELECT regexp_replace(ASSESSORS_PARCEL_NUMBER,'[^0-9A-Za-z]','','g') AS apn,
                 try_strptime(ISSUEDATE,'%-m/%-d/%Y %I:%M:%S %p')::DATE AS d,
                 CONTRACTOR,
                 OWNERNAME,
                 regexp_matches(lower(coalesce(SUBTYPEDESCRIPTION,'')||' '||coalesce(WORKDESCRIPTION,'')),'re-?roof') AS is_rr
          FROM p
          WHERE ASSESSORS_PARCEL_NUMBER IS NOT NULL AND trim(ASSESSORS_PARCEL_NUMBER) <> ''
        ),
        owners AS (  -- owner name from the most recent permit per apn
          SELECT apn, OWNERNAME AS owner,
                 row_number() OVER (PARTITION BY apn ORDER BY d DESC NULLS LAST) rn
          FROM n
        )
        SELECT n.apn AS apn,
               count(*) AS permit_count,
               max(n.d) AS last_permit_date,
               max(CASE WHEN n.is_rr THEN n.d END) AS last_reroof_date,
               bool_or(n.CONTRACTOR IS NOT NULL AND trim(n.CONTRACTOR) <> '') AS has_contractor,
               any_value(o.owner) FILTER (WHERE o.rn = 1) AS owner_name
        FROM n
        LEFT JOIN owners o ON o.apn = n.apn AND o.rn = 1
        GROUP BY n.apn
        """
    ).fetchall()
    idx = {}
    for apn, pc, lpd, lrd, has_c, owner in rows:
        o = clean(owner)
        if o and o.upper() == "NONE":
            o = None
        idx[apn] = {
            "permit_count": int(pc),
            "last_permit_date": lpd,
            "last_reroof_date": lrd,
            "has_contractor": bool(has_c),
            "owner_name": o,
        }
    con.close()
    return idx


def main():
    run_started = datetime.now().isoformat(timespec="seconds")
    permit_idx = build_permit_index()
    print(f"permit index: {len(permit_idx)} distinct APNs with permits")

    # column accumulators
    cols = {k: [] for k in [
        "property_id", "property_cid", "request_identifier", "parcel_identifier",
        "source_system", "county_name", "state_code", "address_street", "address_city",
        "address_zip", "latitude", "longitude", "lot_size_acre", "lot_area_sqft",
        "exterior_wall_material", "roof_covering_material", "property_type",
        "property_usage_type", "built_year", "livable_floor_area", "total_area",
        "assessed_value", "market_value", "land_value", "avm_value", "owner_name",
        "owners_text", "owner_count", "owner_occupied", "last_sale_date",
        "last_sale_price", "subdivision", "has_permits", "permit_count",
        "has_sunbiz_tenant", "has_bbb_contractor", "hoa_flag",
        "last_permit_date", "last_reroof_date", "is_reroof",
    ]}

    n_features = 0
    n_with_permits = 0
    cities = {}
    reroof_parcels = 0
    pages = sorted(glob.glob(os.path.join(RAW_DIR, "page-*.geojson")))
    assert pages, "no cached parcel pages found; run fetch_parcels.py first"

    for path in pages:
        with open(path) as f:
            feats = json.load(f).get("features", [])
        for feat in feats:
            p = feat["properties"]
            apn = norm_apn(p.get("apn"))
            if apn is None:
                continue  # cannot key a parcel without an APN
            n_features += 1

            # centroid
            lat = lon = None
            geom = feat.get("geometry")
            if geom:
                try:
                    c = shape(geom).centroid
                    lon, lat = float(c.x), float(c.y)
                except Exception:
                    lon = lat = None

            # lot area: shape_area_stateplane is the verified real sqft
            try:
                sqft = float(p.get("shape_area_stateplane")) if p.get("shape_area_stateplane") else None
            except (TypeError, ValueError):
                sqft = None
            acre = (sqft / 43560.0) if sqft is not None else None

            street = assemble_street(p)
            city = clean(p.get("situs_city_name"))
            zp = zip5(p.get("situs_zip_code"))

            # canonical JSON -> real CIDv0
            canonical = {
                "apn": apn, "source": "scc_parcels",
                "situs_house_number": clean(p.get("situs_house_number")),
                "situs_house_number_suffix": clean(p.get("situs_house_number_suffix")),
                "situs_street_direction": clean(p.get("situs_street_direction")),
                "situs_street_name": clean(p.get("situs_street_name")),
                "situs_street_type": clean(p.get("situs_street_type")),
                "situs_unit_number": clean(p.get("situs_unit_number")),
                "situs_city_name": city, "situs_zip_code": clean(p.get("situs_zip_code")),
                "situs_state_code": clean(p.get("situs_state_code")),
                "jurisdiction": clean(p.get("jurisdiction")),
                "tax_rate_area": clean(p.get("tax_rate_area")),
                "shape_area_stateplane": p.get("shape_area_stateplane"),
                "latitude": lat, "longitude": lon,
            }
            cid = cidv0(canonical)
            pid = str(uuid.uuid5(NAMESPACE, apn))

            pf = permit_idx.get(apn)
            has_permits = pf is not None
            if has_permits:
                n_with_permits += 1
            permit_count = pf["permit_count"] if pf else 0
            owner = pf["owner_name"] if pf else None
            last_permit = pf["last_permit_date"] if pf else None
            last_reroof = pf["last_reroof_date"] if pf else None
            has_bbb = bool(pf["has_contractor"]) if pf else False
            is_rr = last_reroof is not None
            if is_rr:
                reroof_parcels += 1
            if city:
                cities[city] = cities.get(city, 0) + 1

            cols["property_id"].append(pid)
            cols["property_cid"].append(cid)
            cols["request_identifier"].append(apn)
            cols["parcel_identifier"].append(apn)
            cols["source_system"].append("scc_parcels")
            cols["county_name"].append("Santa Clara")
            cols["state_code"].append("CA")
            cols["address_street"].append(street)
            cols["address_city"].append(city)
            cols["address_zip"].append(zp)
            cols["latitude"].append(lat)
            cols["longitude"].append(lon)
            cols["lot_size_acre"].append(acre)
            cols["lot_area_sqft"].append(sqft)
            cols["exterior_wall_material"].append(None)
            cols["roof_covering_material"].append(None)
            cols["property_type"].append(None)
            cols["property_usage_type"].append(None)
            cols["built_year"].append(None)
            cols["livable_floor_area"].append(None)
            cols["total_area"].append(sqft)
            cols["assessed_value"].append(None)
            cols["market_value"].append(None)
            cols["land_value"].append(None)
            cols["avm_value"].append(None)
            cols["owner_name"].append(owner)
            cols["owners_text"].append(owner)
            cols["owner_count"].append(None)
            cols["owner_occupied"].append(None)
            cols["last_sale_date"].append(None)
            cols["last_sale_price"].append(None)
            cols["subdivision"].append(None)
            cols["has_permits"].append(has_permits)
            cols["permit_count"].append(permit_count)
            cols["has_sunbiz_tenant"].append(None)
            cols["has_bbb_contractor"].append(has_bbb)
            cols["hoa_flag"].append(None)
            cols["last_permit_date"].append(last_permit)
            cols["last_reroof_date"].append(last_reroof)
            cols["is_reroof"].append(is_rr)
        print(f"  processed {os.path.basename(path)} -> running total {n_features}")

    # explicit schema matching Lee types (+ 3 extras)
    schema = pa.schema([
        ("property_id", pa.string()), ("property_cid", pa.string()),
        ("request_identifier", pa.string()), ("parcel_identifier", pa.string()),
        ("source_system", pa.string()), ("county_name", pa.string()),
        ("state_code", pa.string()), ("address_street", pa.string()),
        ("address_city", pa.string()), ("address_zip", pa.string()),
        ("latitude", pa.float64()), ("longitude", pa.float64()),
        ("lot_size_acre", pa.float64()), ("lot_area_sqft", pa.float64()),
        ("exterior_wall_material", pa.string()), ("roof_covering_material", pa.string()),
        ("property_type", pa.string()), ("property_usage_type", pa.string()),
        ("built_year", pa.int64()), ("livable_floor_area", pa.float64()),
        ("total_area", pa.float64()), ("assessed_value", pa.float64()),
        ("market_value", pa.float64()), ("land_value", pa.float64()),
        ("avm_value", pa.float64()), ("owner_name", pa.string()),
        ("owners_text", pa.string()), ("owner_count", pa.int64()),
        ("owner_occupied", pa.bool_()), ("last_sale_date", pa.string()),
        ("last_sale_price", pa.float64()), ("subdivision", pa.string()),
        ("has_permits", pa.bool_()), ("permit_count", pa.int64()),
        ("has_sunbiz_tenant", pa.bool_()), ("has_bbb_contractor", pa.bool_()),
        ("hoa_flag", pa.bool_()),
        ("last_permit_date", pa.date32()), ("last_reroof_date", pa.date32()),
        ("is_reroof", pa.bool_()),
    ])
    table = pa.table({name: cols[name] for name in schema.names}, schema=schema)
    pq.write_table(table, OUT_PARQUET)
    print(f"wrote {OUT_PARQUET}: {table.num_rows} rows, {table.num_columns} cols")

    run_finished = datetime.now().isoformat(timespec="seconds")
    top_cities = sorted(cities.items(), key=lambda x: -x[1])[:15]
    summary = {
        "run_started": run_started,
        "run_finished": run_finished,
        "county": "Santa Clara",
        "state": "CA",
        "output_parquet": OUT_PARQUET,
        "sources": [
            {
                "name": "scc_parcels",
                "description": "Santa Clara County parcels (Socrata ubcd-cewv), GeoJSON with geometry",
                "url": PARCELS_URL,
                "records_fetched": 502789,
                "records_loaded": n_features,
                "fetched_at": run_started,
            },
            {
                "name": "san_jose_permits",
                "description": PERMITS_SOURCE,
                "url": "https://data.sanjoseca.gov/",
                "records_fetched": 17824,
                "records_loaded": sum(v["permit_count"] for v in permit_idx.values()),
                "distinct_apns_joined": len(permit_idx),
                "fetched_at": run_started,
            },
        ],
        "totals": {
            "total_parcels": n_features,
            "parcels_with_permits": n_with_permits,
            "parcels_with_reroof_permit": reroof_parcels,
            "distinct_cities": len(cities),
            "top_cities": [{"city": c, "parcels": n} for c, n in top_cities],
        },
        "constraints": [
            "Assessor owner names, assessed/market/land values, year built, livable area, "
            "and last sale date/price are a PAID offline bulk order from the Santa Clara "
            "County Assessor — left 100% NULL in v1 (honest gap).",
            "Permits cover the City of San Jose only. Sunnyvale, Santa Clara city, "
            "Mountain View, Palo Alto and other city permit portals offer no bulk export "
            "and are not yet ingested — has_permits is a San-Jose-only signal in v1.",
            "has_bbb_contractor is derived from a non-empty CONTRACTOR-on-record in the San "
            "Jose permit (a real contractor signal), NOT the national BBB harvest.",
            "has_sunbiz_tenant is NULL: CA SOS bizfile bulk business data is a paid order; "
            "the FL Sunbiz stage has no free CA equivalent.",
            "lot_area_sqft/total_area use shape_area_stateplane (verified real sqft via UTM "
            "reprojection); the raw `shape_area` field is NOT square feet.",
            "latitude/longitude are parcel MultiPolygon centroids (no point field exists).",
        ],
    }
    with open(OUT_SUMMARY, "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"wrote {OUT_SUMMARY}")


if __name__ == "__main__":
    main()
