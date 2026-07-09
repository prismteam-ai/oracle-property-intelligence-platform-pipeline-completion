#!/usr/bin/env bash
# Local dev/demo: run elephant-mcp against the CACHED parquet, never the public
# IPFS gateway. Gateway reads are 10-60s + 429-throttled (0.44s local vs failed
# gateway, measured 2026-07-08); the deployed path must likewise not depend on
# the public gateway (ship the parquet with the MCP or use dedicated pins).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PARQUET="$ROOT/data/raw/lee-query-table.parquet"
[ -f "$PARQUET" ] || { echo "missing $PARQUET — run the cache download first"; exit 1; }
cd "$ROOT/../refs/elephant-mcp"
PROPERTY_QUERY_TABLE_MAP="{\"lee\":\"$PARQUET\"}" \
ORACLE_OPEN_DATA_IPNS_MAP='{"lee":"k51qzi5uqu5dlzgslzedrnk4whtd7ip69l0pmd3zxelz8hwjorbeyy0pyyeu4m"}' \
ORACLE_OPEN_DATA_DEFAULT_COUNTY=lee PORT=8787 exec node dist/server-http.js
