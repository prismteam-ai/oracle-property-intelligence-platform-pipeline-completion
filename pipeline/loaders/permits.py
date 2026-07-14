"""Permit records: City of San Jose open data (CKAN) building permit CSVs.

Covers active, expired and under-inspection building permits. Other Santa Clara
County cities do not publish bulk permit data (documented source constraint).
"""
import pandas as pd

from .base import download_csv, provenance, save_parquet, session
from ..config import RAW_DIR
from .. import state

SOURCE_NAME = "permits"
CKAN = "https://data.sanjoseca.gov/api/3/action/package_show?id={pkg}"
PACKAGES = [
    "active-building-permits",
    "expired-building-permits",
    "building-permits-under-inspection",
]


def _csv_resource(pkg: str):
    r = session.get(CKAN.format(pkg=pkg), timeout=60)
    r.raise_for_status()
    for res in r.json()["result"]["resources"]:
        if (res.get("format") or "").upper() == "CSV":
            return res["url"]
    raise RuntimeError(f"no CSV resource in package {pkg}")


def run():
    state.update(SOURCE_NAME, status="running", url="https://data.sanjoseca.gov",
                 message="downloading San Jose building permit CSVs")
    frames = []
    total = 0
    for pkg in PACKAGES:
        url = _csv_resource(pkg)
        df = download_csv(url, RAW_DIR / f"{pkg}.csv")
        df["permit_dataset"] = pkg
        df = provenance(df, SOURCE_NAME, url)
        frames.append(df)
        total += len(df)
        state.update(SOURCE_NAME, records=total, message=f"{pkg}: {len(df)} rows")
    merged = pd.concat(frames, ignore_index=True)
    path = save_parquet(merged, SOURCE_NAME)
    state.update(SOURCE_NAME, status="done", records=len(merged),
                 message=f"{len(merged)} permit records", file=path)
    return path
