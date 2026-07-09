#!/usr/bin/env python3
"""Pin the per-property JSON directory to Pinata as ONE folder pin.

A recursive folder pin covers every file's CID in the DAG, so all ~20.9k Palo
Alto property_cids become resolvable while counting as a single pin. Verifies
Pinata's root CID matches the local kubo root (they must, content-addressed).
"""
import json
import sys
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parents[2] / "data" / "santa-clara"
PROPDIR = HERE / "ipfs-properties"
JWT = next((l.split("=", 1)[1].strip()
            for l in (HERE.parents[1] / ".env").read_text().splitlines()
            if l.startswith("PINATA_JWT=")), None)
EXPECTED = sys.argv[1] if len(sys.argv) > 1 else None

# Pinata free tier is storage-based (1 GB), NOT a 500-file cap (verified 2026-07-09:
# pin_count exceeded 500 without error). The full ~20.9k property set is ~82 MB, so
# every property_cid is pinned and resolvable as one recursive folder pin.
LIMIT = int(sys.argv[2]) if len(sys.argv) > 2 else None  # optional cap for testing
paths = sorted(PROPDIR.rglob("*.json"))
if LIMIT:
    paths = paths[:LIMIT]
files = []
for p in paths:
    rel = p.relative_to(PROPDIR.parent)  # ipfs-properties/<shard>/<apn>.json
    files.append(("file", (str(rel), p.read_bytes(), "application/json")))
print(f"uploading {len(files)} property files as one folder pin...", flush=True)

r = requests.post(
    "https://api.pinata.cloud/pinning/pinFileToIPFS",
    headers={"Authorization": f"Bearer {JWT}"},
    files=files,
    data={"pinataMetadata": json.dumps({"name": "santa-clara-properties"}),
          "pinataOptions": json.dumps({"cidVersion": 0})},
    timeout=1800,
)
print("HTTP", r.status_code, flush=True)
try:
    j = r.json()
    root = j.get("IpfsHash")
    print("Pinata folder root CID:", root, "| files:", j.get("NumberOfFiles"))
    if EXPECTED:
        print("matches kubo root?", root == EXPECTED, f"(kubo={EXPECTED})")
except Exception:
    print(r.text[:400])
