#!/usr/bin/env python3
"""Fetch Santa Clara County parcels (Socrata ubcd-cewv) as GeoJSON, paginated + cached.

Run: uv run --with requests python3 ingest/santa-clara/fetch_parcels.py

Caches each page to data/santa-clara/parcels-raw/page-NNNNN.geojson. Idempotent:
an existing non-empty page file is never re-downloaded. County site is slow; be polite.
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error

BASE = "https://data.sccgov.org/resource/ubcd-cewv.geojson"
COUNT_URL = "https://data.sccgov.org/resource/ubcd-cewv.json?$select=count(*)"
PAGE = 50000
OUT_DIR = os.path.join("data", "santa-clara", "parcels-raw")


def http_get(url, retries=5):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "oracle-pipeline/1.0"})
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read()
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            last = e
            wait = 2 ** attempt
            print(f"  retry {attempt+1}/{retries} after {wait}s ({e})", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"GET failed after {retries}: {url} :: {last}")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    total = int(json.loads(http_get(COUNT_URL))[0]["count"])
    print(f"total parcels reported: {total}")
    offset = 0
    page_i = 0
    fetched_total = 0
    while offset < total:
        path = os.path.join(OUT_DIR, f"page-{page_i:05d}.geojson")
        if os.path.exists(path) and os.path.getsize(path) > 0:
            # count cached features so the running total stays accurate
            n = len(json.load(open(path)).get("features", []))
            print(f"page {page_i} cached ({n} features) -> skip")
            fetched_total += n
            offset += PAGE
            page_i += 1
            continue
        # $order=objectid gives a stable sort so pagination never skips/dupes
        url = f"{BASE}?$limit={PAGE}&$offset={offset}&$order=objectid"
        print(f"page {page_i} offset={offset} ...", flush=True)
        raw = http_get(url)
        feats = json.loads(raw).get("features", [])
        with open(path, "wb") as f:
            f.write(raw)
        print(f"  -> {len(feats)} features, {len(raw)} bytes")
        fetched_total += len(feats)
        if len(feats) == 0:
            print("  empty page; stopping")
            break
        offset += PAGE
        page_i += 1
        time.sleep(1)  # polite
    print(f"DONE: {fetched_total} features across {page_i} pages")


if __name__ == "__main__":
    main()
