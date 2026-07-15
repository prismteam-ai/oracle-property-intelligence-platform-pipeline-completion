"""Publish parquet artifacts to Filebase IPFS when credentials are configured."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path


def _local_cid(path: Path) -> str:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return f"local-sha256-{digest[:16]}"


def publish_parquet(path: Path, *, key: str = "properties.parquet") -> dict:
    bucket = os.environ.get("S3_BUCKET", "").strip()
    access_key = os.environ.get("S3_ACCESS_KEY_ID", "").strip()
    secret_key = os.environ.get("S3_SECRET_ACCESS_KEY", "").strip()
    endpoint = os.environ.get("S3_ENDPOINT", "https://s3.filebase.io").strip()
    gateway = os.environ.get("IPFS_GATEWAY", "https://ipfs.filebase.io/ipfs").rstrip("/")

    if not (bucket and access_key and secret_key):
        cid = _local_cid(path)
        return {
            "name": path.name,
            "cid": cid,
            "ipfs": f"local://{cid}",
            "gateway": None,
            "provider": "local-hash (Filebase keys not configured)",
            "local_path": str(path),
        }

    try:
        import boto3  # type: ignore
    except ImportError:
        cid = _local_cid(path)
        return {
            "name": path.name,
            "cid": cid,
            "ipfs": f"local://{cid}",
            "gateway": None,
            "provider": "local-hash (boto3 not installed)",
            "local_path": str(path),
        }

    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name=os.environ.get("AWS_REGION", "us-east-1"),
    )
    with path.open("rb") as handle:
        client.put_object(Bucket=bucket, Key=key, Body=handle, ContentType="application/octet-stream")
    head = client.head_object(Bucket=bucket, Key=key)
    cid = head.get("Metadata", {}).get("cid") or head.get("ETag", "").strip('"')
    if not cid:
        cid = _local_cid(path)
    return {
        "name": path.name,
        "cid": cid,
        "ipfs": f"ipfs://{cid}",
        "gateway": f"{gateway}/{cid}",
        "provider": "Filebase (IPFS)",
        "local_path": str(path),
        "bucket": bucket,
        "key": key,
    }
