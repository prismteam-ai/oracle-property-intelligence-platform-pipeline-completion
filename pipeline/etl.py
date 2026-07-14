"""ETL layer: dedupe each dataset, normalize keys, and produce a duplication summary.

Runs after the loaders and before IPFS publish, so pinned artifacts are the
cleaned versions. Writes data/etl_summary.json with per-table dedupe stats and
cross-source APN overlap.
"""
import json
import re
from datetime import datetime, timezone

import pandas as pd

from .config import DATA_DIR, PARQUET_DIR
from . import state

ETL_SUMMARY_FILE = DATA_DIR / "etl_summary.json"

PROVENANCE_COLS = {"_source", "_source_url", "_collected_at"}

# Natural dedupe keys per table; None = all non-provenance columns
DEDUPE_KEYS = {
    "properties": ["apn"],
    "ownership": ["apn"],
    "businesses": ["osm_id"],
    "locations": ["apn", "full_address"],
    "permits": None,
    "contractors": None,  # license number column detected dynamically
}


def _norm_apn(series: pd.Series) -> pd.Series:
    return (series.astype(str)
            .str.upper()
            .str.replace(r"[^0-9A-Z]", "", regex=True)
            .replace({"NAN": None, "NONE": None, "": None}))


def _dedupe(df: pd.DataFrame, table: str):
    keys = DEDUPE_KEYS.get(table)
    if table == "contractors":
        lic = next((c for c in df.columns if "license" in str(c).lower()), None)
        keys = [lic] if lic else None
    if keys and all(k in df.columns for k in keys):
        mask = df.duplicated(subset=keys, keep="first") & df[keys].notna().all(axis=1)
        method = f"key ({', '.join(keys)})"
    else:
        cols = [c for c in df.columns if c not in PROVENANCE_COLS]
        mask = df.duplicated(subset=cols, keep="first")
        method = "full row"
    return df[~mask].reset_index(drop=True), int(mask.sum()), method


def run_etl() -> dict:
    summary = {
        "ran_at": datetime.now(timezone.utc).isoformat(),
        "tables": {},
        "cross_source": {},
    }
    apn_sets = {}
    for pq in sorted(PARQUET_DIR.glob("*.parquet")):
        table = pq.stem
        df = pd.read_parquet(pq)
        raw = len(df)
        if "apn" in df.columns:
            df["apn"] = _norm_apn(df["apn"])
            apns = set(df["apn"].dropna())
            if apns:
                apn_sets[table] = apns
        df, removed, method = _dedupe(df, table)
        df.to_parquet(pq, index=False)
        summary["tables"][table] = {
            "raw_records": raw,
            "clean_records": len(df),
            "duplicates_removed": removed,
            "dedupe_method": method,
        }
        state.update(table, records=len(df),
                     message=f"{len(df)} clean records ({removed} duplicates removed)")

    # cross-source APN overlap (same parcel appearing in multiple datasets)
    tables = sorted(apn_sets)
    for i, a in enumerate(tables):
        for b in tables[i + 1:]:
            n = len(apn_sets[a] & apn_sets[b])
            if n:
                summary["cross_source"][f"{a} ∩ {b}"] = n
    all_apns = set().union(*apn_sets.values()) if apn_sets else set()
    summary["cross_source"]["distinct_parcels_across_sources"] = len(all_apns)

    ETL_SUMMARY_FILE.write_text(json.dumps(summary, indent=2))
    return summary


def load_etl_summary() -> dict:
    if ETL_SUMMARY_FILE.exists():
        return json.loads(ETL_SUMMARY_FILE.read_text())
    return {}
