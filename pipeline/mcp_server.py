"""MCP server exposing the Oracle Property Intelligence platform as tools.

Run locally (stdio, for Claude Desktop etc.):
    python3 -m pipeline.mcp_server
Run hosted (streamable HTTP, e.g. Azure Container Apps):
    MCP_TRANSPORT=http PORT=8090 python3 -m pipeline.mcp_server
"""
import json
import os

from mcp.server.fastmcp import FastMCP

from . import state
from .agent import FILTER_DEFS, answer, filter_options, filtered
from .build_db import query
from .etl import load_etl_summary
from .ipfs_publish import load_manifest

mcp = FastMCP(
    "oracle-property-intel",
    instructions=(
        "Property intelligence for Santa Clara County built from free public "
        "data (parcels, San Jose permits & addresses, assessor ownership, CSLB "
        "contractors, OSM businesses/transit), deduplicated, pinned to IPFS "
        "and queried through DuckDB. Cross-source joins use normalized street "
        "addresses because the open address layer has no usable APN."),
    host=os.environ.get("HOST", "0.0.0.0"),
    port=int(os.environ.get("PORT", "8090")),
)


@mcp.tool()
def ask(question: str) -> dict:
    """Ask a natural-language property question (roof age, ownership tenure,
    water views, regional owners, walk-to-transit/Starbucks, candidate
    ranking). Returns rows plus the methodology basis and SQL used."""
    return answer(question)


@mcp.tool()
def find_properties(filters: list[str], thresholds: dict | None = None,
                    city: str | None = None, address_contains: str | None = None,
                    limit: int = 50, offset: int = 0) -> dict:
    """Find properties matching one or more criteria, intersected by
    normalized address. Valid filters: roof, stable_owner, regional, water,
    transit, starbucks. thresholds maps filter name -> value (e.g.
    {"roof": 20, "transit": 400}); defaults: roof>=15y, stable_owner>=10y,
    water<=1200m, transit/starbucks<=800m."""
    return filtered(filters, limit=min(limit, 500), offset=max(offset, 0),
                    params=thresholds or {}, city=city, q=address_contains)


@mcp.tool()
def query_sql(sql: str, max_rows: int = 200) -> dict:
    """Run a read-only DuckDB SELECT against the tables: properties, permits,
    ownership, contractors, businesses, locations, and precomputed marts
    feat_roof, feat_stable_owner, feat_regional, feat_water, feat_transit,
    feat_starbucks."""
    if not sql.strip().lower().startswith(("select", "with")):
        return {"error": "only SELECT/WITH statements are allowed"}
    return query(sql, max_rows=min(max_rows, 2000))


@mcp.tool()
def list_filters() -> dict:
    """List the available property filters, their parameters, allowed
    threshold choices and methodology notes, plus known cities."""
    return filter_options()


@mcp.tool()
def pipeline_status() -> dict:
    """Current pipeline run state: per-source status, record counts,
    timestamps, and the ETL deduplication summary."""
    s = state.get_state()
    s["etl"] = load_etl_summary()
    return s


@mcp.tool()
def list_ipfs_artifacts() -> dict:
    """IPFS content identifiers (CIDs), sizes and gateway URLs for the pinned
    dataset artifacts, so the data can be retrieved and verified
    independently."""
    return load_manifest()


@mcp.resource("opi://manifest")
def manifest_resource() -> str:
    """The dataset manifest with IPFS CIDs."""
    return json.dumps(load_manifest(), indent=2)


if __name__ == "__main__":
    transport = os.environ.get("MCP_TRANSPORT", "stdio")
    mcp.run(transport="streamable-http" if transport == "http" else "stdio")
