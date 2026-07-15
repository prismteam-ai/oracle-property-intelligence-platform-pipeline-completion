"""Shared helpers for all loaders: ArcGIS pagination, CKAN downloads, provenance."""
import time
from datetime import datetime, timezone

import pandas as pd
import requests

from ..config import MAX_RECORDS, PARQUET_DIR, USER_AGENT
from .. import state

session = requests.Session()
session.headers["User-Agent"] = USER_AGENT


def provenance(df: pd.DataFrame, source_name: str, source_url: str) -> pd.DataFrame:
    df = df.copy()
    df["_source"] = source_name
    df["_source_url"] = source_url
    df["_collected_at"] = datetime.now(timezone.utc).isoformat()
    return df


def save_parquet(df: pd.DataFrame, name: str) -> str:
    path = PARQUET_DIR / f"{name}.parquet"
    df.columns = [str(c) for c in df.columns]
    df.to_parquet(path, index=False)
    return str(path)


def arcgis_paginate(layer_url: str, where: str = "1=1", out_fields: str = "*",
                    return_geometry: bool = False, page_size: int = 2000,
                    source_key: str = "", geometry_centroid: bool = False,
                    max_retries: int = 4):
    """Yield attribute dicts from an ArcGIS FeatureServer/MapServer layer with paging."""
    offset = 0
    total = 0
    while True:
        params = {
            "where": where,
            "outFields": out_fields,
            "returnGeometry": "true" if return_geometry else "false",
            "resultOffset": offset,
            "resultRecordCount": page_size,
            "f": "json",
            "outSR": 4326,
        }
        data = None
        for attempt in range(max_retries):
            try:
                r = session.get(f"{layer_url}/query", params=params, timeout=120)
                r.raise_for_status()
                data = r.json()
                if "error" in data:
                    raise RuntimeError(data["error"])
                break
            except Exception:
                if attempt == max_retries - 1:
                    raise
                time.sleep(2 ** attempt)

        features = data.get("features", [])
        if not features:
            break
        for f in features:
            row = dict(f.get("attributes", {}))
            if return_geometry and geometry_centroid:
                geom = f.get("geometry") or {}
                rings = geom.get("rings")
                if rings and rings[0]:
                    xs = [p[0] for p in rings[0]]
                    ys = [p[1] for p in rings[0]]
                    row["centroid_lon"] = sum(xs) / len(xs)
                    row["centroid_lat"] = sum(ys) / len(ys)
                elif "x" in geom:
                    row["centroid_lon"], row["centroid_lat"] = geom["x"], geom["y"]
            yield row
            total += 1
            if MAX_RECORDS and total >= MAX_RECORDS:
                return
        if source_key:
            state.update(source_key, records=total, message=f"fetched {total} records...")
        if not data.get("exceededTransferLimit") and len(features) < page_size:
            break
        offset += len(features)


def download_csv(url: str, dest_path) -> pd.DataFrame:
    with session.get(url, stream=True, timeout=300) as r:
        r.raise_for_status()
        with open(dest_path, "wb") as fh:
            for chunk in r.iter_content(1 << 20):
                fh.write(chunk)
    df = pd.read_csv(dest_path, low_memory=False, on_bad_lines="skip")
    if MAX_RECORDS:
        df = df.head(MAX_RECORDS)
    return df
