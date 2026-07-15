"""OpenStreetMap POI ingest (transit, Starbucks, water) with offline fallback."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import httpx

PALO_ALTO_BBOX = (37.35, -122.22, 37.48, -122.08)  # south, west, north, east

# Curated OSM snapshot used when Overpass is unavailable (real public coordinates).
FALLBACK_POIS: dict[str, list[dict[str, Any]]] = {
    "transit": [
        {"name": "Caltrain Palo Alto", "lat": 37.4431, "lon": -122.1651},
        {"name": "Caltrain California Ave", "lat": 37.4293, "lon": -122.1411},
        {"name": "Caltrain Mountain View", "lat": 37.3944, "lon": -122.0763},
        {"name": "VTA Mountain View", "lat": 37.3940, "lon": -122.0810},
        {"name": "VTA San Jose Diridon", "lat": 37.3297, "lon": -121.9020},
    ],
    "starbucks": [
        {"name": "Starbucks University Ave", "lat": 37.4452, "lon": -122.1630},
        {"name": "Starbucks California Ave", "lat": 37.4267, "lon": -122.1455},
        {"name": "Starbucks El Camino Palo Alto", "lat": 37.4251, "lon": -122.1468},
        {"name": "Starbucks Middlefield", "lat": 37.4489, "lon": -122.1289},
        {"name": "Starbucks San Antonio", "lat": 37.4089, "lon": -122.1167},
    ],
    "water": [
        {"name": "San Francisquito Creek", "lat": 37.4340, "lon": -122.1540},
        {"name": "Palo Alto Baylands", "lat": 37.4520, "lon": -122.1150},
        {"name": "Shoreline Lake", "lat": 37.4230, "lon": -122.0820},
        {"name": "Stevens Creek", "lat": 37.3960, "lon": -122.1060},
    ],
}


def _overpass_query(query: str) -> list[dict[str, Any]]:
    endpoints = (
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
    )
    for endpoint in endpoints:
        try:
            with httpx.Client(timeout=45.0) as client:
                response = client.post(endpoint, data={"data": query})
            if response.status_code != 200:
                continue
            payload = response.json()
            elements = []
            for element in payload.get("elements", []):
                if element.get("type") != "node":
                    continue
                elements.append(
                    {
                        "name": element.get("tags", {}).get("name", "poi"),
                        "lat": element.get("lat"),
                        "lon": element.get("lon"),
                    }
                )
            if elements:
                return elements
        except (httpx.HTTPError, json.JSONDecodeError):
            continue
    return []


def fetch_pois(data_dir: Path) -> Path:
    cache = data_dir / "osm_pois.json"
    if cache.exists() and cache.stat().st_size > 0:
        return cache

    south, west, north, east = PALO_ALTO_BBOX
    transit_q = (
        f"[out:json][timeout:25];(node[\"railway\"=\"station\"]({south},{west},{north},{east});"
        f"node[\"public_transport\"=\"station\"]({south},{west},{north},{east});"
        f"node[\"highway\"=\"bus_stop\"]({south},{west},{north},{east}););out body 80;"
    )
    starbucks_q = (
        f"[out:json][timeout:25];node[\"amenity\"=\"cafe\"][\"name\"~\"Starbucks\",i]"
        f"({south},{west},{north},{east});out body 80;"
    )
    water_q = (
        f"[out:json][timeout:25];(node[\"natural\"=\"water\"]({south},{west},{north},{east});"
        f"way[\"waterway\"]({south},{west},{north},{east}););out center 40;"
    )

    pois = {
        "transit": _overpass_query(transit_q),
        "starbucks": _overpass_query(starbucks_q),
        "water": _overpass_query(water_q),
        "source": "openstreetmap_overpass",
    }
    for kind, fallback in FALLBACK_POIS.items():
        if not pois[kind]:
            pois[kind] = fallback
            pois["source"] = "openstreetmap_snapshot_fallback"

    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(pois, indent=2) + "\n")
    return cache


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def min_distance_m(lat: float | None, lon: float | None, pois: list[dict[str, Any]]) -> float | None:
    if lat is None or lon is None:
        return None
    distances = [
        haversine_m(lat, lon, poi["lat"], poi["lon"])
        for poi in pois
        if poi.get("lat") is not None and poi.get("lon") is not None
    ]
    return min(distances) if distances else None
