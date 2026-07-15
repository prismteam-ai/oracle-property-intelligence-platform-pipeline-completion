"""Santa Clara County parcel ingest via Socrata open data."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

import httpx

SOCRATA_DOMAIN = "data.sccgov.org"
DATASET_ID = "ubcd-cewv"
PAGE_SIZE = 5000
MAX_PAGES = int(os.environ.get("SOCRATA_MAX_PAGES", "4"))

SANTA_CLARA_CITIES = (
    "PALO ALTO",
    "SAN JOSE",
    "SANTA CLARA",
    "MOUNTAIN VIEW",
    "SUNNYVALE",
)


def normalize_apn(value: str | None) -> str:
    if not value:
        return ""
    return re.sub(r"[^0-9A-Za-z]", "", str(value))


def _centroid_from_geom(geom: dict[str, Any] | None) -> tuple[float | None, float | None]:
    if not geom or not geom.get("coordinates"):
        return None, None
    coords = geom["coordinates"]
    points: list[tuple[float, float]] = []

    def walk(node: Any) -> None:
        if isinstance(node, (list, tuple)):
            if len(node) >= 2 and isinstance(node[0], (int, float)) and isinstance(node[1], (int, float)):
                if -180 <= float(node[0]) <= 180 and -90 <= float(node[1]) <= 90:
                    points.append((float(node[0]), float(node[1])))
                    return
            for child in node:
                walk(child)

    walk(coords)
    if not points:
        return None, None
    lon = sum(p[0] for p in points) / len(points)
    lat = sum(p[1] for p in points) / len(points)
    return lat, lon


def _street(row: dict[str, Any]) -> str:
    parts = [
        str(row.get("situs_house_number") or "").strip(),
        str(row.get("situs_street_name") or "").strip(),
        str(row.get("situs_street_type") or "").strip(),
    ]
    return " ".join(p for p in parts if p)


def fetch_city_parcels(city: str, *, app_token: str | None = None) -> list[dict[str, Any]]:
    headers = {"Accept": "application/json"}
    if app_token:
        headers["X-App-Token"] = app_token
    rows: list[dict[str, Any]] = []
    offset = 0
    pages = 0
    base = f"https://{SOCRATA_DOMAIN}/resource/{DATASET_ID}.json"
    while pages < MAX_PAGES:
        params = {
            "$limit": PAGE_SIZE,
            "$offset": offset,
            "$where": f"situs_city_name='{city}'",
        }
        with httpx.Client(timeout=120.0, follow_redirects=True) as client:
            response = client.get(base, params=params, headers=headers)
            response.raise_for_status()
            batch = response.json()
        if not batch:
            break
        for row in batch:
            lat, lon = _centroid_from_geom(row.get("the_geom"))
            rows.append(
                {
                    "apn": normalize_apn(row.get("apn")),
                    "address_street": _street(row),
                    "address_city": str(row.get("situs_city_name") or city).upper(),
                    "address_zip": row.get("situs_zip_code"),
                    "latitude": lat,
                    "longitude": lon,
                    "lot_area_sqft": row.get("shape_area_stateplane"),
                    "source_system": "santa_clara_socrata_parcels",
                    "jurisdiction": row.get("jurisdiction"),
                }
            )
        if len(batch) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
        pages += 1
    return rows


def fetch_parcels(
    data_dir: Path,
    *,
    cities: tuple[str, ...] = SANTA_CLARA_CITIES,
    app_token: str | None = None,
) -> Path:
    cache = data_dir / "socrata_parcels.json"
    if cache.exists() and cache.stat().st_size > 0:
        return cache

    all_rows: list[dict[str, Any]] = []
    for city in cities:
        print(f"  Socrata parcels: {city}...")
        city_rows = fetch_city_parcels(city, app_token=app_token)
        print(f"    {len(city_rows)} rows")
        all_rows.extend(city_rows)

    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(all_rows, indent=2) + "\n")
    return cache
