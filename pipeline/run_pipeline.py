"""Orchestrator: run all loaders -> pin artifacts to IPFS -> build DuckDB views."""
import traceback

from .config import PARQUET_DIR
from .loaders import properties, permits, ownership, contractors, businesses, locations
from . import state
from .etl import run_etl
from .ipfs_publish import publish_all
from .build_db import build

LOADERS = [
    ("properties", properties.run),
    ("permits", permits.run),
    ("ownership", ownership.run),
    ("contractors", contractors.run),
    ("businesses", businesses.run),
    ("locations", locations.run),
]


def run_all():
    state.reset([name for name, _ in LOADERS])
    for name, fn in LOADERS:
        try:
            fn()
        except Exception as exc:
            traceback.print_exc()
            # If a previous snapshot exists, the pipeline continues with it:
            # report "cached" (stale-but-usable) rather than a hard error.
            if (PARQUET_DIR / f"{name}.parquet").exists():
                state.update(name, status="cached",
                             message=f"fetch failed, using previous snapshot: {str(exc)[:200]}")
            else:
                state.update(name, status="error", message=str(exc)[:300])
    try:
        run_etl()
    except Exception:
        traceback.print_exc()
    publish_all()
    try:
        build()
    except Exception:
        traceback.print_exc()
    state.finish()


if __name__ == "__main__":
    run_all()
