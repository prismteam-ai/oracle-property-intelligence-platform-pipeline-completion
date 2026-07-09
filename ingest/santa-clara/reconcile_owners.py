#!/usr/bin/env python3
"""Owner-entity reconciliation across the parcel set.

Beyond the APN key-join, this reconciles the OWNER entity: parcels whose owner
mailing address normalizes to the same string are the same owner, so we compute
each owner's portfolio size (owner_property_count) and flag multi-parcel owners.
This is real cross-record entity reconciliation (dedupe an owner appearing on N
parcels into one owner entity) and directly strengthens the "regional owner"
signal (an out-of-area owner holding several properties).

In-place post-process on the served query-table Parquet (no CID regen needed —
adds a column, keeps every property_cid unchanged).
"""
import re
from pathlib import Path

import duckdb
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

HERE = Path(__file__).resolve().parents[2] / "data" / "santa-clara"
PARQUET = HERE / "santa-clara-query-table.parquet"
HARVEST = HERE / "assessor_harvest.csv"


def norm_owner(addr) -> str | None:
    if not addr or not isinstance(addr, str) or not addr.strip():
        return None
    return re.sub(r"\s+", " ", addr.upper().replace(",", " ")).strip()


def norm_apn(x):
    d = re.sub(r"\D", "", str(x or ""))
    return d.zfill(8) if d else None


def main():
    con = duckdb.connect()
    df = con.execute(f"SELECT * FROM read_parquet('{PARQUET}')").df()

    # owner identity = normalized mailing address (from the harvest)
    h = pd.read_csv(HARVEST, dtype=str)
    h = h[h["error"].isna() | (h["error"] == "")]
    apn2owner = {norm_apn(a): norm_owner(m)
                 for a, m in zip(h["apn"], h["mailing_address"])}

    df["_apn"] = df["parcel_identifier"].map(norm_apn)
    df["_owner"] = df["_apn"].map(apn2owner)

    # reconcile: count parcels per owner entity (distinct parcels)
    owner_counts = (df[df["_owner"].notna()]
                    .drop_duplicates(["parcel_identifier"])
                    .groupby("_owner")["parcel_identifier"].nunique())
    df["owner_property_count"] = df["_owner"].map(owner_counts).astype("Int64")

    distinct_owners = int(owner_counts.shape[0])
    portfolio_owners = int((owner_counts > 1).sum())
    max_portfolio = int(owner_counts.max()) if len(owner_counts) else 0
    parcels_owned_by_multi = int(owner_counts[owner_counts > 1].sum())

    df = df.drop(columns=["_apn", "_owner"])
    pq.write_table(pa.Table.from_pandas(df, preserve_index=False), PARQUET)

    import json
    (HERE / "reconciliation-stats.json").write_text(json.dumps({
        "distinct_owner_entities": distinct_owners,
        "owned_parcels": int(owner_counts.sum()),
        "portfolio_owners_multi_parcel": portfolio_owners,
        "largest_portfolio_parcels": max_portfolio,
        "parcels_held_by_multi_parcel_owners": parcels_owned_by_multi,
    }, indent=2))
    print(f"reconciled owners: {distinct_owners} distinct owner entities across "
          f"{int(owner_counts.sum())} owned parcels")
    print(f"portfolio owners (>1 parcel): {portfolio_owners}; "
          f"largest portfolio: {max_portfolio} parcels; "
          f"parcels held by multi-parcel owners: {parcels_owned_by_multi}")
    print(f"wrote {PARQUET} (+ owner_property_count column)")


if __name__ == "__main__":
    main()
