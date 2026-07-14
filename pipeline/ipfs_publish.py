"""Add + pin dataset parquet files to IPFS (Kubo HTTP API), record CIDs in manifest.

Works against a local Kubo daemon (localhost:5001). If no daemon is reachable,
files are marked pending and DuckDB falls back to reading local parquet.
"""
import json
from datetime import datetime, timezone

import requests

from .config import IPFS_API, IPFS_GATEWAY, MANIFEST_FILE, PARQUET_DIR
from . import state


def ipfs_available() -> bool:
    try:
        r = requests.post(f"{IPFS_API}/api/v0/version", timeout=5)
        return r.ok
    except requests.RequestException:
        return False


def add_and_pin(path) -> str:
    with open(path, "rb") as fh:
        r = requests.post(
            f"{IPFS_API}/api/v0/add", params={"pin": "true", "cid-version": 1},
            files={"file": (path.name, fh)}, timeout=600,
        )
    r.raise_for_status()
    return r.json()["Hash"]


def publish_all() -> dict:
    manifest = {
        "published_at": datetime.now(timezone.utc).isoformat(),
        "gateway": IPFS_GATEWAY,
        "ipfs_available": ipfs_available(),
        "artifacts": {},
    }
    for pq in sorted(PARQUET_DIR.glob("*.parquet")):
        name = pq.stem
        entry = {"local_path": str(pq), "size_bytes": pq.stat().st_size, "cid": None,
                 "gateway_url": None}
        if manifest["ipfs_available"]:
            try:
                cid = add_and_pin(pq)
                entry["cid"] = cid
                entry["gateway_url"] = f"{IPFS_GATEWAY}/ipfs/{cid}"
                state.update(name, cid=cid)
            except Exception as exc:
                entry["error"] = str(exc)
        manifest["artifacts"][name] = entry
    MANIFEST_FILE.write_text(json.dumps(manifest, indent=2))
    return manifest


def load_manifest() -> dict:
    if MANIFEST_FILE.exists():
        return json.loads(MANIFEST_FILE.read_text())
    return {"artifacts": {}}


def pinned_cids() -> set:
    """CIDs currently pinned on the local Kubo node (empty set if unreachable)."""
    try:
        r = requests.post(f"{IPFS_API}/api/v0/pin/ls",
                          params={"type": "recursive"}, timeout=5)
        r.raise_for_status()
        return set(r.json().get("Keys", {}).keys())
    except (requests.RequestException, ValueError):
        return set()
