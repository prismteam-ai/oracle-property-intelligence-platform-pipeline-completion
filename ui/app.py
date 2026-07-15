"""Flask demo UI for Santa Clara property intelligence."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
from pathlib import Path

import duckdb
from dotenv import load_dotenv
from flask import Flask, abort, jsonify, render_template, request, send_from_directory

try:
    from ui.sandbox_queries import CITIES, PRESETS, SandboxParams, run_preset, run_sql
except ImportError:
    from sandbox_queries import CITIES, PRESETS, SandboxParams, run_preset, run_sql

load_dotenv()

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("DATA_DIR", PROJECT_ROOT / "data"))
PARQUET_PATH = Path(os.environ.get("PARQUET_PATH", DATA_DIR / "properties.parquet"))
RUN_SUMMARY_PATH = Path(os.environ.get("RUN_SUMMARY_PATH", DATA_DIR / "run_summary.json"))
MANIFEST_PATH = Path(os.environ.get("MANIFEST_PATH", PROJECT_ROOT / "manifest.json"))
MCP_BASE_URL = os.environ.get("MCP_BASE_URL", "http://localhost:8000/mcp")

README_QUESTIONS = [
    "roofs older than 15 years",
    "view of water",
    "not exchanged ownership in more than 10 years",
    "regional owners",
    "walking distance of public transportation",
    "walking distance of starbucks",
]

BASIS_NOTES = {
    "roofs older than 15 years": (
        "Basis: years since last roof permit (permit issue date), not assessor roof material."
    ),
    "view of water": (
        "Basis: OpenStreetMap water-feature proximity (<=500m) — labeled proxy, not line-of-sight."
    ),
    "not exchanged ownership in more than 10 years": (
        "Basis: assessor last_sale_date when present; otherwise permit dormancy proxy."
    ),
    "regional owners": (
        "Basis: owner-location / permit owner-text signals (CA privacy withholds owner names)."
    ),
    "walking distance of public transportation": (
        "Basis: parcel coordinates to nearest OSM transit node (haversine meters)."
    ),
    "walking distance of starbucks": (
        "Basis: parcel coordinates to nearest OSM Starbucks node (haversine meters)."
    ),
}

QUESTION_HINTS = {
    "roofs older than 15 years": "Permit history shows roof work older than 15 years.",
    "view of water": "Proximity to named water features from OSM.",
    "not exchanged ownership in more than 10 years": "Ownership tenure from sale date or dormancy.",
    "regional owners": "Owner mailing / portfolio signals from permits.",
    "walking distance of public transportation": "Within ~800m of transit stops using coordinates.",
    "walking distance of starbucks": "Within ~800m of Starbucks locations using coordinates.",
}

AGENT_PROMPTS = [
    (
        "Which properties have roofs older than 15 years and have not "
        "exchanged ownership in more than 10 years?"
    ),
    (
        "Which properties are near public transportation and also have "
        "regional owners?"
    ),
    (
        "Which properties appear to be strong candidates for further review "
        "based on ownership age, roof age, and location signals?"
    ),
]

QUERY_SPECS = [
    (
        "roofs older than 15 years",
        """
        SELECT count(*) FROM dataset WHERE roof_age_years >= 15
        """,
        """
        SELECT parcel_id, address_street, address_city, roof_age_years, source_system
        FROM dataset WHERE roof_age_years >= 15
        ORDER BY roof_age_years DESC NULLS LAST LIMIT 10
        """,
    ),
    (
        "view of water",
        "SELECT count(*) FROM dataset WHERE has_water_view = true",
        """
        SELECT parcel_id, address_street, address_city, has_water_view, distance_to_water_m
        FROM dataset WHERE has_water_view = true LIMIT 10
        """,
    ),
    (
        "not exchanged ownership in more than 10 years",
        """
        SELECT count(*) FROM dataset
        WHERE years_since_ownership_change >= 10 OR last_sale_date IS NULL
        """,
        """
        SELECT parcel_id, address_street, address_city, years_since_ownership_change, last_sale_date
        FROM dataset
        WHERE years_since_ownership_change >= 10 OR last_sale_date IS NULL
        LIMIT 10
        """,
    ),
    (
        "regional owners",
        "SELECT count(*) FROM dataset WHERE is_regional_owner = true",
        """
        SELECT parcel_id, address_street, address_city, is_regional_owner, source_system
        FROM dataset WHERE is_regional_owner = true LIMIT 10
        """,
    ),
    (
        "walking distance of public transportation",
        "SELECT count(*) FROM dataset WHERE distance_to_public_transit_m <= 800",
        """
        SELECT parcel_id, address_street, address_city, distance_to_public_transit_m, source_system
        FROM dataset WHERE distance_to_public_transit_m <= 800
        ORDER BY distance_to_public_transit_m LIMIT 10
        """,
    ),
    (
        "walking distance of starbucks",
        "SELECT count(*) FROM dataset WHERE distance_to_starbucks_m <= 800",
        """
        SELECT parcel_id, address_street, address_city, distance_to_starbucks_m, source_system
        FROM dataset WHERE distance_to_starbucks_m <= 800
        ORDER BY distance_to_starbucks_m LIMIT 10
        """,
    ),
]

app = Flask(__name__, template_folder="templates", static_folder="static")

_pipeline_lock = threading.Lock()
_pipeline_state: dict[str, str | None] = {
    "status": "idle",
    "error": None,
}


def _dataset_ready() -> bool:
    if not PARQUET_PATH.exists() or PARQUET_PATH.stat().st_size == 0:
        return False
    try:
        con = duckdb.connect()
        total = con.execute(
            f"SELECT count(*) FROM read_parquet('{PARQUET_PATH.as_posix()}')"
        ).fetchone()[0]
        return int(total) > 0
    except (duckdb.Error, OSError):
        return False


def _run_pipeline_job() -> None:
    with _pipeline_lock:
        if _pipeline_state["status"] == "running":
            return
        _pipeline_state["status"] = "running"
        _pipeline_state["error"] = None

    try:
        result = subprocess.run(
            [sys.executable, "-m", "pipeline.run"],
            cwd=PROJECT_ROOT,
            check=True,
            capture_output=True,
            text=True,
            timeout=3600,
        )
        if result.stderr.strip():
            print(result.stderr, file=sys.stderr)
    except subprocess.CalledProcessError as exc:
        with _pipeline_lock:
            detail = (exc.stderr or exc.stdout or str(exc)).strip()
            _pipeline_state["status"] = "failed"
            _pipeline_state["error"] = detail or "Pipeline exited with an error"
        return
    except Exception as exc:
        with _pipeline_lock:
            _pipeline_state["status"] = "failed"
            _pipeline_state["error"] = str(exc)
        return

    with _pipeline_lock:
        if _dataset_ready():
            _pipeline_state["status"] = "completed"
            _pipeline_state["error"] = None
        else:
            _pipeline_state["status"] = "failed"
            _pipeline_state["error"] = (
                "Pipeline finished but dataset file is missing or empty"
            )


@app.context_processor
def inject_dataset_context() -> dict:
    return {"dataset_ready": _dataset_ready()}


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def _load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def _source_stats(summary: dict) -> dict[str, int]:
    stats: dict[str, int] = {}
    for name, entry in (summary.get("records_by_source") or {}).items():
        stats[name] = entry.get("count", entry) if isinstance(entry, dict) else int(entry)
    return stats


def _query_examples() -> list[dict]:
    if not PARQUET_PATH.exists():
        return []
    con = duckdb.connect()
    con.execute(
        f"CREATE OR REPLACE VIEW dataset AS SELECT * FROM read_parquet('{PARQUET_PATH}')"
    )
    results = []
    for label, count_sql, rows_sql in QUERY_SPECS:
        try:
            count = con.execute(count_sql).fetchone()[0]
            rows = con.execute(rows_sql).fetchall()
            cols = [d[0] for d in con.description]
        except duckdb.Error:
            count, rows, cols = None, [], []
        results.append(
            {
                "question": label,
                "slug": _slug(label),
                "basis": BASIS_NOTES.get(label, ""),
                "count": count,
                "columns": cols,
                "rows": rows,
            }
        )
    return results


@app.get("/")
def home():
    summary = _load_json(RUN_SUMMARY_PATH)
    stats = _source_stats(summary)
    preset_by_label = {meta["label"]: key for key, meta in PRESETS.items()}
    questions = [
        {
            "label": q,
            "slug": _slug(q),
            "preset": preset_by_label.get(q, "roofs"),
            "hint": QUESTION_HINTS.get(q, ""),
        }
        for q in README_QUESTIONS
    ]
    return render_template(
        "home.html",
        title="Dashboard",
        active="home",
        summary=summary,
        stats=stats,
        questions=questions,
    )


@app.get("/search")
@app.get("/explore")
def search():
    return render_template(
        "explore.html",
        title="Explore",
        active="search",
        examples=_query_examples(),
    )


@app.get("/run")
@app.get("/pipeline")
@app.get("/status")
def run_summary():
    summary = _load_json(RUN_SUMMARY_PATH)
    sources = []
    by_source = summary.get("records_by_source") or {}
    max_count = max(
        (e.get("count", e) if isinstance(e, dict) else e for e in by_source.values()),
        default=1,
    )
    for name, entry in by_source.items():
        count = entry.get("count", entry) if isinstance(entry, dict) else entry
        provenance = entry.get("provenance", "") if isinstance(entry, dict) else ""
        pct = min(100, int(100 * int(count) / max(int(max_count), 1)))
        sources.append({"name": name, "count": int(count), "provenance": provenance, "pct": pct})
    return render_template(
        "run.html",
        title="Run summary",
        active="run",
        summary=summary,
        sources=sources,
    )


@app.get("/about")
@app.get("/artifacts")
@app.get("/ipfs")
def about():
    manifest = _load_json(MANIFEST_PATH)
    return render_template(
        "about.html",
        title="About",
        active="about",
        mcp_url=MCP_BASE_URL,
        artifacts=manifest.get("artifacts", []),
    )


@app.get("/ask")
def ask():
    return render_template(
        "ask.html",
        title="Agent",
        active="ask",
        mcp_url=MCP_BASE_URL,
        prompts=AGENT_PROMPTS,
    )


@app.get("/sandbox")
def sandbox():
    return render_template(
        "sandbox.html",
        title="Sandbox",
        active="sandbox",
        presets=PRESETS,
        cities=CITIES,
    )


@app.get("/api/dataset/status")
def api_dataset_status():
    summary = _load_json(RUN_SUMMARY_PATH) if _dataset_ready() else {}
    with _pipeline_lock:
        pipeline = dict(_pipeline_state)
    return jsonify(
        {
            "ready": _dataset_ready(),
            "pipeline": pipeline,
            "stats": _source_stats(summary),
        }
    )


@app.post("/api/pipeline/load")
def api_pipeline_load():
    if _dataset_ready():
        return jsonify({"error": "Dataset already loaded"}), 409
    with _pipeline_lock:
        if _pipeline_state["status"] == "running":
            return jsonify({"status": "running"}), 202
    threading.Thread(target=_run_pipeline_job, daemon=True).start()
    return jsonify({"status": "running"}), 202


@app.post("/api/sandbox/query")
def api_sandbox_query():
    if not PARQUET_PATH.exists():
        return jsonify({"error": "Dataset not found"}), 404
    body = request.get_json(silent=True) or {}
    try:
        params = SandboxParams(
            preset=str(body.get("preset", "roofs")),
            city=str(body.get("city", "")),
            min_roof_age=int(body.get("min_roof_age", 15)),
            min_ownership_years=int(body.get("min_ownership_years", 10)),
            max_transit_m=int(body.get("max_transit_m", 800)),
            max_starbucks_m=int(body.get("max_starbucks_m", 800)),
            max_water_m=int(body.get("max_water_m", 500)),
            limit=int(body.get("limit", 25)),
        )
        return jsonify(run_preset(PARQUET_PATH, params))
    except (ValueError, TypeError) as exc:
        return jsonify({"error": str(exc)}), 400
    except duckdb.Error as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/sandbox/sql")
def api_sandbox_sql():
    if not PARQUET_PATH.exists():
        return jsonify({"error": "Dataset not found"}), 404
    body = request.get_json(silent=True) or {}
    sql = str(body.get("sql", "")).strip()
    if not sql:
        return jsonify({"error": "SQL is required"}), 400
    try:
        return jsonify(run_sql(PARQUET_PATH, sql))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except duckdb.Error as exc:
        return jsonify({"error": str(exc)}), 400


@app.get("/data/<path:filename>")
def data_file(filename: str):
    if filename != "properties.parquet":
        abort(404)
    if not PARQUET_PATH.exists():
        abort(404)
    return send_from_directory(PARQUET_PATH.parent, filename)


def main() -> None:
    port = int(os.environ.get("WEB_PORT", "3000"))
    app.run(host="0.0.0.0", port=port, debug=False)


if __name__ == "__main__":
    main()
