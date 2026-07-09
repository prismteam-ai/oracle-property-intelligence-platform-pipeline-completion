#!/usr/bin/env python3
"""Merge all Santa Clara sources into one enriched query-table parquet, by APN.

Inputs (all local, stable):
  - data/santa-clara/santa-clara-query-table.parquet   base: 495k parcels + coords
  - data/santa-clara/assessor_harvest.csv              transfer date, owner mailing, values
  - data/santa-clara/mtc_yearbuilt.json                year built + flood zone (Palo Alto)
  - data/santa-clara/osm/{starbucks,transit,water}.json  POIs for distance columns

Output:
  - data/santa-clara/santa-clara-enriched.parquet

Join key: APN normalized to digits-only (drop dashes/spaces). Every enriched
column is LEFT-joined so the full 495k base is preserved; parcels without
assessor/year data keep NULLs (honest gaps, never fabricated).

Derived columns that answer the demo questions:
  built_year            -> roofs >15yr
  last_sale_date        -> no ownership change >10yr   (parsed from transfer_date)
  owner_occupied        -> homeowner-exemption > 0
  owner_mailing_city/state, regional_owner  -> regional owners (mailing != situs)
  dist_transit_m / dist_starbucks_m / dist_water_m -> walking-distance + water view
  land_value / assessed_value / flood_zone
"""
import json
import re
import sys
from datetime import date, datetime
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from scipy.spatial import cKDTree

HERE = Path(__file__).resolve().parents[2] / "data" / "santa-clara"
BASE = HERE / "santa-clara-query-table.parquet"
HARVEST = HERE / "assessor_harvest.csv"
MTC = HERE / "mtc_yearbuilt.json"
OSM = HERE / "osm"
OUT = HERE / "santa-clara-enriched.parquet"

SC_CITIES = {  # cities inside Santa Clara County — mailing outside = out-of-county owner
    "SAN JOSE", "PALO ALTO", "SUNNYVALE", "SANTA CLARA", "MOUNTAIN VIEW",
    "CUPERTINO", "MILPITAS", "CAMPBELL", "LOS GATOS", "LOS ALTOS", "SARATOGA",
    "GILROY", "MORGAN HILL", "LOS ALTOS HILLS", "MONTE SERENO", "STANFORD",
}


def norm_apn(x) -> str | None:
    if x is None:
        return None
    d = re.sub(r"\D", "", str(x))
    return d.zfill(8) if d else None


def parse_transfer(s):
    if not s or not str(s).strip():
        return None
    for fmt in ("%m/%d/%Y",):
        try:
            return datetime.strptime(str(s).strip(), fmt).date()
        except ValueError:
            pass
    return None


_SUFFIX = {"AV", "AVE", "ST", "DR", "RD", "LN", "CT", "WAY", "BLVD", "PL", "CIR",
           "TER", "HWY", "LP", "BL", "PKWY", "PLZ", "TRL", "CTR", "EXPY", "DRIVE",
           "AVENUE", "STREET", "ROAD", "COURT", "PLACE", "LANE", "CIRCLE"}
_UNIT = {"UNIT", "STE", "APT", "NO", "SPC", "FL", "BLDG", "RM", "PMB", "BOX"}


def mailing_city_state(addr):
    """'1530 O'BRIEN DR STE C MENLO PARK CA 94025' -> ('MENLO PARK','CA').

    Walk backwards from the '<ST> <ZIP>' tail collecting up to 3 city words,
    stopping at a street suffix, unit keyword, single letter (unit), or number.
    """
    if not addr or not str(addr).strip():
        return None, None
    toks = str(addr).upper().replace(",", " ").split()
    for i in range(len(toks) - 1, 0, -1):
        if re.fullmatch(r"[A-Z]{2}", toks[i]) and i + 1 < len(toks) and re.match(r"\d{5}", toks[i + 1]):
            state = toks[i]
            city_toks, j = [], i - 1
            while j >= 0 and len(city_toks) < 3:
                t = toks[j]
                if (t in _SUFFIX or t in _UNIT or len(t) == 1
                        or re.search(r"\d", t) or t.startswith("#")):
                    break
                city_toks.insert(0, t)
                j -= 1
            return (" ".join(city_toks) if city_toks else None), state
    return None, None


def load_pois(path):
    """Return (lat, lon) arrays from an Overpass json (node lat/lon or way center)."""
    els = json.load(open(path)).get("elements", [])
    lat, lon = [], []
    for e in els:
        if "lat" in e and "lon" in e:
            lat.append(e["lat"]); lon.append(e["lon"])
        elif "center" in e:
            lat.append(e["center"]["lat"]); lon.append(e["center"]["lon"])
    return np.array(lat), np.array(lon)


def nearest_m(plat, plon, poi_lat, poi_lon):
    """Nearest-POI distance in metres for each parcel, via an equirectangular
    KD-tree (fine at county scale for walking-distance thresholds)."""
    if len(poi_lat) == 0:
        return np.full(len(plat), np.nan)
    lat0 = np.nanmean(plat)
    mlat, mlon = 111_320.0, 111_320.0 * np.cos(np.radians(lat0))
    tree = cKDTree(np.column_stack([poi_lat * mlat, poi_lon * mlon]))
    d, _ = tree.query(np.column_stack([plat * mlat, plon * mlon]), k=1)
    return d


def main():
    con = duckdb.connect()
    base = con.execute(f"SELECT * FROM read_parquet('{BASE}')").df()
    print(f"base parcels: {len(base)}", flush=True)
    base["_apn"] = base["parcel_identifier"].map(norm_apn)

    # --- assessor harvest ---
    if HARVEST.exists():
        h = pd.read_csv(HARVEST, dtype=str).drop_duplicates("apn", keep="last")
        h = h[h["error"].isna() | (h["error"] == "")]
        h["_apn"] = h["apn"].map(norm_apn)
        h["last_sale_date"] = h["transfer_date"].map(parse_transfer)
        h[["mail_city", "mail_state"]] = h["mailing_address"].apply(
            lambda a: pd.Series(mailing_city_state(a)))
        for c in ("land_value", "total_value", "homeowner_exemption"):
            h[c] = pd.to_numeric(h[c], errors="coerce")
        hh = h.set_index("_apn")
        print(f"assessor rows joined: {hh.index.notna().sum()}", flush=True)
    else:
        hh = pd.DataFrame().set_index(pd.Index([], name="_apn"))

    def hlook(apn, col):
        try:
            return hh.at[apn, col] if apn in hh.index else None
        except Exception:
            return None

    # --- MTC year built ---
    mtc = {norm_apn(x["apn"]): x for x in json.load(open(MTC))} if MTC.exists() else {}

    # --- assemble enriched columns (left-join, preserve all base rows) ---
    n = len(base)
    out = base.copy()
    def col(name, fn, dtype=object):
        out[name] = pd.Series([fn(a) for a in base["_apn"]], dtype=dtype)

    out["last_sale_date"] = [hlook(a, "last_sale_date") for a in base["_apn"]]
    out["land_value"] = [hlook(a, "land_value") for a in base["_apn"]]
    out["assessed_value"] = [hlook(a, "total_value") for a in base["_apn"]]
    hoe = [hlook(a, "homeowner_exemption") for a in base["_apn"]]
    out["owner_occupied"] = [None if v is None or (isinstance(v, float) and np.isnan(v))
                             else bool(v and v > 0) for v in hoe]
    mc = [hlook(a, "mail_city") for a in base["_apn"]]
    ms = [hlook(a, "mail_state") for a in base["_apn"]]
    out["owner_mailing_city"] = mc
    out["owner_mailing_state"] = ms
    # regional owner: mailing address outside Santa Clara County (or out of state)
    def regional(city, st):
        if not city or not isinstance(city, str):
            return None
        if st and isinstance(st, str) and st != "CA":
            return True
        return city.upper().strip() not in SC_CITIES
    out["regional_owner"] = [regional(c, s) for c, s in zip(mc, ms)]
    out["built_year"] = [int(mtc[a]["yearbuilt"]) if a in mtc and mtc[a].get("yearbuilt")
                         and str(mtc[a]["yearbuilt"]).isdigit() and mtc[a]["yearbuilt"] != "0"
                         else None for a in base["_apn"]]
    out["flood_zone"] = [mtc[a].get("floodzone") if a in mtc else None for a in base["_apn"]]

    # --- OSM distance columns ---
    plat = pd.to_numeric(base["latitude"], errors="coerce").to_numpy(dtype=float)
    plon = pd.to_numeric(base["longitude"], errors="coerce").to_numpy(dtype=float)
    for name, fn in (("dist_transit_m", "transit.json"),
                     ("dist_starbucks_m", "starbucks.json"),
                     ("dist_water_m", "water.json")):
        pth = OSM / fn
        if pth.exists():
            la, lo = load_pois(pth)
            out[name] = np.round(nearest_m(plat, plon, la, lo), 1)
            print(f"{name}: {len(la)} POIs", flush=True)
        else:
            out[name] = np.nan

    # --- OSM business records (nearest business + local density) ---
    bpath = OSM / "businesses.json"
    if bpath.exists():
        bels = [x for x in json.load(open(bpath)).get("elements", [])
                if x.get("tags", {}).get("name") and "lat" in x and "lon" in x]
        blat = np.array([x["lat"] for x in bels])
        blon = np.array([x["lon"] for x in bels])
        bname = [x["tags"]["name"] for x in bels]
        btype = [x["tags"].get("shop") or x["tags"].get("office") for x in bels]
        lat0 = np.nanmean(plat)
        mlat, mlon = 111_320.0, 111_320.0 * np.cos(np.radians(lat0))
        btree = cKDTree(np.column_stack([blat * mlat, blon * mlon]))
        pxy = np.column_stack([plat * mlat, plon * mlon])
        dist, idx = btree.query(pxy, k=1)
        # count of businesses within 200 m of each parcel centroid (local density)
        counts = btree.query_ball_point(pxy, r=200.0, return_length=True)
        out["business_count_200m"] = counts.astype("float")
        out["has_business_tenant"] = dist < 60.0  # a business at/on the parcel
        out["nearest_business_name"] = [bname[i] if d < 300 else None for d, i in zip(dist, idx)]
        out["nearest_business_type"] = [btype[i] if d < 300 else None for d, i in zip(dist, idx)]
        print(f"businesses: {len(bels)} loaded; "
              f"{int((dist < 60).sum())} parcels with an on-site business", flush=True)

    # --- OSM contractor records (building trades: hvac, construction, etc.) ---
    cpath = OSM / "contractors.json"
    if cpath.exists():
        cels = json.load(open(cpath)).get("elements", [])
        cll = [(e.get("lat") or e.get("center", {}).get("lat"),
                e.get("lon") or e.get("center", {}).get("lon")) for e in cels]
        cll = [(la, lo) for la, lo in cll if la is not None and lo is not None]
        if cll:
            clat = np.array([x[0] for x in cll]); clon = np.array([x[1] for x in cll])
            lat0 = np.nanmean(plat)
            mlat, mlon = 111_320.0, 111_320.0 * np.cos(np.radians(lat0))
            ctree = cKDTree(np.column_stack([clat * mlat, clon * mlon]))
            pxy = np.column_stack([plat * mlat, plon * mlon])
            # has_bbb_contractor (schema field): a licensed-trade contractor within 500 m
            cdist, _ = ctree.query(pxy, k=1)
            out["has_bbb_contractor"] = cdist < 500.0
            print(f"contractors: {len(cll)} loaded; "
                  f"{int((cdist < 500).sum())} parcels within 500m of a trade contractor",
                  flush=True)

    out = out.drop(columns=["_apn"])
    enriched = out["built_year"].notna().sum()
    sales = out["last_sale_date"].notna().sum()
    reg = (out["regional_owner"] == True).sum()  # noqa: E712
    print(f"\nENRICHED: built_year={enriched}, sale_date={sales}, regional_owner={reg}",
          flush=True)
    # cast dates to string for parquet portability (matches Lee's date-string convention)
    out["last_sale_date"] = out["last_sale_date"].map(lambda d: d.isoformat() if isinstance(d, date) else None)
    pq.write_table(pa.Table.from_pandas(out, preserve_index=False), OUT)
    print(f"wrote {OUT} ({len(out)} rows, {len(out.columns)} cols)", flush=True)


if __name__ == "__main__":
    main()
