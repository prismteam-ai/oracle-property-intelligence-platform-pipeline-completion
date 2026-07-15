"""Build a DuckDB database from the IPFS-pinned parquet artifacts.

Provenance layer: `<table>_ipfs` views read straight from the IPFS gateway
(local parquet fallback), so anyone with the manifest CIDs can rebuild.
Query layer: base tables are materialized as native DuckDB tables (columnar,
zone-mapped, no network I/O), enriched with parsed dates and normalized
address match keys, plus precomputed `feat_*` marts (see features.py) so
agent questions are simple lookups instead of repeated parse/join work.
"""
import duckdb
import requests

from .config import DUCKDB_FILE
from .features import build_features
from .ipfs_publish import load_manifest


def _reachable(url: str) -> bool:
    try:
        return requests.head(url, timeout=10, allow_redirects=True).ok
    except requests.RequestException:
        return False


def build():
    manifest = load_manifest()
    con = duckdb.connect(str(DUCKDB_FILE))
    con.execute("INSTALL httpfs; LOAD httpfs;")
    built = {}
    for name, art in manifest.get("artifacts", {}).items():
        url = art.get("gateway_url")
        if url and _reachable(url):
            src, origin = url, "ipfs"
        else:
            src, origin = art["local_path"], "local"
        # provenance view over IPFS + materialized native table for querying
        con.execute(f"CREATE OR REPLACE VIEW {name}_ipfs AS "
                    f"SELECT * FROM read_parquet('{src}')")
        try:
            con.execute(f"DROP VIEW IF EXISTS {name}")  # legacy view from older builds
        except duckdb.CatalogException:
            pass
        con.execute(f"CREATE OR REPLACE TABLE {name} AS "
                    f"SELECT * FROM read_parquet('{src}')")
        count = con.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0]
        built[name] = {"rows": count, "reads_from": origin, "src": src,
                       "cid": art.get("cid")}
    features = build_features(con)
    con.execute("ANALYZE")
    con.close()
    return {"tables": built, "features": features}


def query(sql: str, max_rows: int = 500):
    con = duckdb.connect(str(DUCKDB_FILE), read_only=True)
    try:
        res = con.execute(sql)
        cols = [d[0] for d in res.description]
        rows = res.fetchmany(max_rows)
        return {"columns": cols, "rows": [list(r) for r in rows]}
    finally:
        con.close()


if __name__ == "__main__":
    import json
    print(json.dumps(build(), indent=2))
