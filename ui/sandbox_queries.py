"""Safe, parameterized DuckDB queries for the interactive sandbox."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import duckdb

PRESETS = {
    "roofs": {
        "label": "roofs older than 15 years",
        "basis": "Years since last roof permit (permit issue date).",
    },
    "water": {
        "label": "view of water",
        "basis": "OpenStreetMap water proximity (<=500m) — labeled proxy.",
    },
    "ownership": {
        "label": "not exchanged ownership in more than 10 years",
        "basis": "Assessor last_sale_date or permit dormancy proxy.",
    },
    "regional": {
        "label": "regional owners",
        "basis": "Owner-location / permit owner-text signals.",
    },
    "transit": {
        "label": "walking distance of public transportation",
        "basis": "Parcel coordinates to nearest OSM transit (haversine m).",
    },
    "starbucks": {
        "label": "walking distance of starbucks",
        "basis": "Parcel coordinates to nearest OSM Starbucks (haversine m).",
    },
}

CITIES = (
    "PALO ALTO",
    "SAN JOSE",
    "SANTA CLARA",
    "MOUNTAIN VIEW",
    "SUNNYVALE",
    "CUPERTINO",
)


@dataclass
class SandboxParams:
    preset: str
    city: str = ""
    min_roof_age: int = 15
    min_ownership_years: int = 10
    max_transit_m: int = 800
    max_starbucks_m: int = 800
    max_water_m: int = 500
    limit: int = 25


def _connect(parquet_path: Path) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute(
        f"CREATE OR REPLACE VIEW properties AS "
        f"SELECT * FROM read_parquet('{parquet_path.as_posix()}')"
    )
    return con


def _city_clause(city: str) -> tuple[str, list[str]]:
    if not city.strip():
        return "", []
    return " AND lower(address_city) LIKE ?", [f"%{city.strip().lower()}%"]


def run_preset(parquet_path: Path, params: SandboxParams) -> dict[str, Any]:
    if params.preset not in PRESETS:
        raise ValueError(f"Unknown preset: {params.preset}")

    meta = PRESETS[params.preset]
    city_sql, city_args = _city_clause(params.city)
    limit = max(1, min(int(params.limit), 100))

    if params.preset == "roofs":
        where = f"roof_age_years >= ?{city_sql}"
        args: list[Any] = [params.min_roof_age, *city_args]
        sql = f"""
            SELECT parcel_id, address_street, address_city, roof_age_years, source_system
            FROM properties WHERE {where}
            ORDER BY roof_age_years DESC NULLS LAST LIMIT {limit}
        """
        count_sql = f"SELECT count(*) FROM properties WHERE {where}"

    elif params.preset == "water":
        where = f"(has_water_view = true OR distance_to_water_m <= ?){city_sql}"
        args = [params.max_water_m, *city_args]
        sql = f"""
            SELECT parcel_id, address_street, address_city, has_water_view,
                   distance_to_water_m, source_system
            FROM properties WHERE {where}
            ORDER BY distance_to_water_m NULLS LAST LIMIT {limit}
        """
        count_sql = f"SELECT count(*) FROM properties WHERE {where}"

    elif params.preset == "ownership":
        where = f"(years_since_ownership_change >= ? OR last_sale_date IS NULL){city_sql}"
        args = [params.min_ownership_years, *city_args]
        sql = f"""
            SELECT parcel_id, address_street, address_city,
                   years_since_ownership_change, last_sale_date, source_system
            FROM properties WHERE {where}
            ORDER BY years_since_ownership_change DESC NULLS LAST LIMIT {limit}
        """
        count_sql = f"SELECT count(*) FROM properties WHERE {where}"

    elif params.preset == "regional":
        where = f"is_regional_owner = true{city_sql}"
        args = list(city_args)
        sql = f"""
            SELECT parcel_id, address_street, address_city, is_regional_owner, source_system
            FROM properties WHERE {where} LIMIT {limit}
        """
        count_sql = f"SELECT count(*) FROM properties WHERE {where}"

    elif params.preset == "transit":
        where = f"distance_to_public_transit_m <= ?{city_sql}"
        args = [params.max_transit_m, *city_args]
        sql = f"""
            SELECT parcel_id, address_street, address_city,
                   distance_to_public_transit_m, source_system
            FROM properties WHERE {where}
            ORDER BY distance_to_public_transit_m LIMIT {limit}
        """
        count_sql = f"SELECT count(*) FROM properties WHERE {where}"

    else:  # starbucks
        where = f"distance_to_starbucks_m <= ?{city_sql}"
        args = [params.max_starbucks_m, *city_args]
        sql = f"""
            SELECT parcel_id, address_street, address_city,
                   distance_to_starbucks_m, source_system
            FROM properties WHERE {where}
            ORDER BY distance_to_starbucks_m LIMIT {limit}
        """
        count_sql = f"SELECT count(*) FROM properties WHERE {where}"

    con = _connect(parquet_path)
    total = con.execute(count_sql, args).fetchone()[0]
    rows = con.execute(sql, args).fetchall()
    columns = [d[0] for d in con.description]

    return {
        "preset": params.preset,
        "question": meta["label"],
        "basis": meta["basis"],
        "count": int(total),
        "columns": columns,
        "rows": [list(r) for r in rows],
        "params": {
            "city": params.city,
            "min_roof_age": params.min_roof_age,
            "min_ownership_years": params.min_ownership_years,
            "max_transit_m": params.max_transit_m,
            "max_starbucks_m": params.max_starbucks_m,
            "max_water_m": params.max_water_m,
            "limit": limit,
        },
    }


def run_sql(parquet_path: Path, sql: str, *, limit: int = 25) -> dict[str, Any]:
    cleaned = sql.strip().rstrip(";")
    if not cleaned.lower().startswith("select"):
        raise ValueError("Only SELECT queries are allowed")
    forbidden = ("insert", "update", "delete", "drop", "create", "attach", "copy", "pragma")
    lowered = cleaned.lower()
    if any(word in lowered for word in forbidden):
        raise ValueError("Only read-only SELECT queries are allowed")

    capped = max(1, min(limit, 100))
    if "limit" not in lowered:
        cleaned = f"{cleaned} LIMIT {capped}"

    con = _connect(parquet_path)
    rows = con.execute(cleaned).fetchall()
    columns = [d[0] for d in con.description]
    return {
        "columns": columns,
        "rows": [list(r) for r in rows],
        "sql": cleaned,
    }
