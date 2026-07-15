"""Business records: OpenStreetMap (Overpass API) named businesses in Santa Clara County.

Neither the county nor San Jose publishes a bulk business-license dataset
(documented constraint), so OSM provides free, programmatic business points
with names, categories and coordinates.
"""
import pandas as pd
import requests

from .base import provenance, save_parquet
from ..config import MAX_RECORDS, USER_AGENT
from .. import state

SOURCE_NAME = "businesses"
OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

# 3600396501 = OSM area id for Santa Clara County (relation 396499)
QUERY = """
[out:json][timeout:240];
(
  node(area:3600396501)["name"]["shop"];
  node(area:3600396501)["name"]["office"];
  node(area:3600396501)["name"]["amenity"~"^(restaurant|cafe|bank|pharmacy|fast_food|bar|dentist|doctors|fuel)$"];
  node(area:3600396501)["highway"="bus_stop"];
  node(area:3600396501)["railway"~"^(station|halt|tram_stop)$"];
);
out;
"""


def _query_overpass():
    last_exc = None
    for url in OVERPASS_MIRRORS:
        try:
            state.update(SOURCE_NAME, url=url, message=f"querying {url}")
            r = requests.post(url, data={"data": QUERY},
                              headers={"User-Agent": USER_AGENT}, timeout=300)
            r.raise_for_status()
            return url, r.json().get("elements", [])
        except Exception as exc:
            last_exc = exc
    raise RuntimeError(f"all Overpass mirrors failed: {last_exc}")


def run():
    state.update(SOURCE_NAME, status="running", url=OVERPASS_MIRRORS[0],
                 message="querying Overpass for county businesses")
    used_url, elements = _query_overpass()
    rows = []
    for el in elements:
        tags = el.get("tags", {})
        if tags.get("highway") == "bus_stop" or tags.get("railway"):
            category = "transit"
        else:
            category = tags.get("shop") or tags.get("office") or tags.get("amenity")
        rows.append({
            "osm_id": el.get("id"),
            "name": tags.get("name"),
            "category": category,
            "brand": tags.get("brand"),
            "street": tags.get("addr:street"),
            "housenumber": tags.get("addr:housenumber"),
            "city": tags.get("addr:city"),
            "postcode": tags.get("addr:postcode"),
            "lat": el.get("lat"),
            "lon": el.get("lon"),
        })
        if MAX_RECORDS and len(rows) >= MAX_RECORDS:
            break
    df = provenance(pd.DataFrame(rows), SOURCE_NAME, used_url)
    path = save_parquet(df, SOURCE_NAME)
    state.update(SOURCE_NAME, status="done", records=len(df),
                 message=f"{len(df)} business records", file=path)
    return path
