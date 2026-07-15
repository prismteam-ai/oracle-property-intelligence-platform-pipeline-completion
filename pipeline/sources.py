"""Download Elephant-published Santa Clara artifacts from IPFS."""

from __future__ import annotations

import os
from pathlib import Path

import httpx

PROPERTY_CID = "QmRTMf9cw2wKmYZVXE3yJTNNY7GU9uvoiRaVRrWxcMmssA"
PERMIT_IPNS = (
    "https://ipfs.filebase.io/ipns/"
    "k51qzi5uqu5dm5dkii3wz7hj8vqurb1b773uy0qj9nlvsvgaqqyccuurz8kmic"
)


def _gateway() -> str:
    return os.environ.get("IPFS_GATEWAY", "https://ipfs.filebase.io/ipfs").rstrip("/")


def download(url: str, dest: Path, timeout: float = 600.0) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    with httpx.stream("GET", url, follow_redirects=True, timeout=timeout) as response:
        response.raise_for_status()
        with dest.open("wb") as handle:
            for chunk in response.iter_bytes():
                handle.write(chunk)
    return dest


def fetch_property_seed(data_dir: Path) -> Path:
    url = f"{_gateway()}/{PROPERTY_CID}"
    return download(url, data_dir / "source.parquet")


def fetch_permit_seed(data_dir: Path) -> Path:
    return download(PERMIT_IPNS, data_dir / "permits.parquet")
