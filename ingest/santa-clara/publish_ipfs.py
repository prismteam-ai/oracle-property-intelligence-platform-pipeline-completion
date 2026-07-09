#!/usr/bin/env python3
"""Publish the enriched Santa Clara data to IPFS with REAL, resolvable CIDs.

Fixes the core bug (our old property_cid was base58(sha256(json)) — NOT an IPFS
CID, so it never resolved). Here we:
  1. write one consolidated provenance JSON per property into sharded dirs,
  2. `ipfs add -r` them through the real kubo node -> the genuine CIDv0 for each
     file (the UnixFS/DAG-PB hash IPFS actually uses),
  3. rewrite property_cid in the parquet with those real CIDs,
  4. `ipfs add` the parquet itself -> the dataset artifact CID,
  5. emit a manifest (dataset CID + per-property root dir CID + counts).

Durable hosting (pinning service / Azure node) re-adds the SAME bytes and gets
the SAME CIDs — content addressing guarantees it — so this step is what makes the
advertised CIDs correct; pinning just keeps them online.

Env: IPFS_PATH + kubo on PATH.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import duckdb
import pyarrow.parquet as pq

HERE = Path(__file__).resolve().parents[2] / "data" / "santa-clara"
ENRICHED = HERE / "santa-clara-enriched.parquet"
PROPDIR = HERE / "ipfs-properties"
OUT_PARQUET = HERE / "santa-clara-query-table.parquet"  # rewritten in place for deploy
MANIFEST = HERE / "ipfs-manifest.json"

# Fields that make up a property's public provenance record on IPFS.
FIELDS = ["parcel_identifier", "address_street", "address_city", "address_zip",
          "latitude", "longitude", "built_year", "last_sale_date", "owner_name",
          "owner_mailing_city", "owner_mailing_state", "regional_owner",
          "land_value", "assessed_value", "flood_zone", "dist_transit_m",
          "dist_starbucks_m", "dist_water_m", "has_permits", "permit_count",
          "source_system", "county_name", "state_code"]


def ipfs(*args, capture=True):
    return subprocess.run(["ipfs", *args], capture_output=capture, text=True,
                          check=True, env=os.environ)


def main(limit=None):
    con = duckdb.connect()
    cols = ", ".join(FIELDS)
    # Per-property JSONs (each gets its own resolvable CID) are generated for the
    # Palo Alto showcase — the enriched core. The whole-county dataset is pinned
    # as the Parquet artifact regardless, so every parcel is on IPFS via that.
    where = "WHERE lower(address_city)='palo alto'" if not limit else ""
    df = con.execute(f"SELECT {cols} FROM read_parquet('{ENRICHED}') {where}"
                     + (f" LIMIT {limit}" if limit else "")).df()
    print(f"generating {len(df)} property JSONs (Palo Alto showcase)...", flush=True)

    # write sharded: ipfs-properties/<apn[:3]>/<apn>.json  (keeps dirs small)
    if PROPDIR.exists():
        subprocess.run(["rm", "-rf", str(PROPDIR)], check=True)
    PROPDIR.mkdir(parents=True)
    apns = []
    for rec in df.to_dict("records"):
        apn = str(rec["parcel_identifier"] or "").strip()
        if not apn:
            continue
        shard = PROPDIR / apn[:3]
        shard.mkdir(exist_ok=True)
        clean = {k: (None if (v is None or (isinstance(v, float) and v != v)) else v)
                 for k, v in rec.items()}
        (shard / f"{apn}.json").write_text(json.dumps(clean, default=str,
                                                       separators=(",", ":")))
        apns.append(apn)
    print(f"wrote {len(apns)} files; running ipfs add -r (real CIDs)...", flush=True)

    # single `ipfs add -r` (long form): one "added <cid> <path>" line per file,
    # plus the root directory as the final line.
    res = ipfs("add", "-r", "--cid-version=0", str(PROPDIR))
    path_cid = {}
    root_cid = None
    for ln in res.stdout.splitlines():
        parts = ln.split()
        if len(parts) >= 2 and parts[0] == "added":
            cid, rel = parts[1], (parts[2] if len(parts) >= 3 else "")
            if rel.endswith(".json"):
                path_cid[Path(rel).stem] = cid
            elif rel == PROPDIR.name:  # the root dir line
                root_cid = cid
    print(f"root dir CID: {root_cid} | per-property CIDs: {len(path_cid)}", flush=True)

    # rewrite property_cid in the full parquet with the real CIDs
    full = con.execute(f"SELECT * FROM read_parquet('{ENRICHED}')").df()
    full["property_cid"] = [path_cid.get(str(a).strip()) for a in full["parcel_identifier"]]
    pq.write_table(__import__("pyarrow").Table.from_pandas(full, preserve_index=False),
                   OUT_PARQUET)
    real = full["property_cid"].notna().sum()
    print(f"rewrote {OUT_PARQUET.name}: {real} rows now carry a REAL property_cid", flush=True)

    # pin the dataset parquet itself -> the dataset artifact CID
    dataset_cid = ipfs("add", "--cid-version=0", "-q", str(OUT_PARQUET)).stdout.strip()
    print(f"dataset parquet CID: {dataset_cid}", flush=True)

    manifest = {
        "county": "santa-clara",
        "dataset_parquet_cid": dataset_cid,
        "properties_root_cid": root_cid,
        "property_count": len(path_cid),
        "sample_property": {"apn": apns[0], "cid": path_cid.get(apns[0])} if apns else None,
        "note": "Real IPFS CIDv0 (UnixFS DAG-PB). Durable pin keeps them online; "
                "content-addressing guarantees the same CID on any node.",
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2))
    manifest_cid = ipfs("add", "--cid-version=0", "-q", str(MANIFEST)).stdout.strip()
    print(f"manifest CID: {manifest_cid}\nWROTE {MANIFEST}", flush=True)


if __name__ == "__main__":
    lim = int(sys.argv[1]) if len(sys.argv) > 1 else None
    main(lim)
