#!/usr/bin/env python3
"""Run the Santa Clara Oracle pipeline and write acceptance-test artifacts."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

from pipeline.ingest import run_ingest
from pipeline.publish import publish_parquet
from pipeline.transform import build_dataset

load_dotenv()

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def write_run_summary(
    path: Path,
    *,
    started_at: str,
    finished_at: str,
    counts: dict[str, int],
) -> None:
    records_by_source = {
        "property": {
            "count": counts["property"],
            "collected_at": finished_at,
            "provenance": "Elephant Santa Clara property seed + SCC Socrata parcel join",
        },
        "permit": {
            "count": counts["permit"],
            "collected_at": finished_at,
            "provenance": "Elephant Santa Clara permit-table IPNS snapshot",
        },
        "ownership": {
            "count": counts["ownership"],
            "collected_at": finished_at,
            "provenance": "Permit description owner signals (assessor owner names withheld in CA)",
        },
        "contractor": {
            "count": counts["contractor"],
            "collected_at": finished_at,
            "provenance": "Permit contractor-on-record text signals",
        },
        "business": {
            "count": counts["business"],
            "collected_at": finished_at,
            "provenance": "Permit improvement types (Retail/Office/Restaurant)",
        },
        "coordinate": {
            "count": counts["coordinate"],
            "collected_at": finished_at,
            "provenance": (
                f"SCC Socrata parcel geometry ({counts.get('socrata_matched', 0)} APN matches)"
            ),
        },
    }
    summary = {
        "status": "completed",
        "county": "Santa Clara",
        "coverage": "Santa Clara County including Palo Alto, CA",
        "started_at": started_at,
        "finished_at": finished_at,
        "records_by_source": records_by_source,
        "constraints": [
            (
                "California assessor owner names and last-sale dates are not in free bulk "
                "open data; ownership tenure uses permit dormancy/owner-text signals."
            ),
            (
                "Santa Clara permit coverage is county-portal sourced; City of Palo Alto "
                "advertised API host has been unreliable (documented upstream outage)."
            ),
            (
                "View-of-water uses OpenStreetMap water-feature proximity (<=500m) with "
                "labeled basis in the UI — not verified line-of-sight."
            ),
            (
                "BBB/Sunbiz statewide enrichment tables are not in the free published seed; "
                "contractor/business counts use permit improvement metadata."
            ),
        ],
        "architecture": {
            "ingest": "elephant-xyz/skills published IPFS + SCC Socrata + OSM POIs",
            "storage": "IPFS (Filebase when configured) for parquet artifacts",
            "query_layer": "DuckDB over local parquet files",
            "agent_access": "@elephant-xyz/mcp HTTP (queryProperties)",
            "ui": "Local Flask UI on port 3000",
            "ongoing_cost": "No Oracle-hosted database; portable files only",
        },
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(summary, indent=2) + "\n")


def write_manifest(path: Path, *, parquet_artifact: dict) -> None:
    manifest = {
        "county": os.environ.get("COUNTY", "santa-clara"),
        "published_at": _iso_now(),
        "artifacts": [
            parquet_artifact,
            {
                "name": "run_summary.json",
                "description": "Pipeline run metadata and per-source record counts",
            },
        ],
    }
    path.write_text(json.dumps(manifest, indent=2) + "\n")


def main() -> int:
    data_dir = Path(os.environ.get("DATA_DIR", PROJECT_ROOT / "data"))
    parquet_path = Path(os.environ.get("PARQUET_PATH", data_dir / "properties.parquet"))
    run_summary_path = Path(
        os.environ.get("RUN_SUMMARY_PATH", data_dir / "run_summary.json")
    )
    manifest_path = Path(os.environ.get("MANIFEST_PATH", PROJECT_ROOT / "manifest.json"))

    started_at = _iso_now()
    artifacts = run_ingest(data_dir)
    print("Transform: Elephant 37-col query table + enrichments...")
    counts = build_dataset(artifacts, parquet_path)
    print("Publish: Filebase IPFS (when configured)...")
    published = publish_parquet(parquet_path)
    finished_at = _iso_now()

    write_run_summary(
        run_summary_path,
        started_at=started_at,
        finished_at=finished_at,
        counts=counts,
    )
    write_manifest(manifest_path, parquet_artifact=published)

    print(f"Wrote {parquet_path} ({counts['property']} properties)")
    print(f"Wrote {run_summary_path}")
    print(f"Wrote {manifest_path}")
    print("Source counts:", json.dumps(counts, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
