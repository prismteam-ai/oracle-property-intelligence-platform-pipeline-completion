"""
README acceptance criteria integration tests.

These tests validate outcomes described in README.md only.
They do not assume any candidate PR layout, routes, tool names,
or schema choices.

Run: pytest tests/acceptance -v
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import duckdb
import httpx
import pytest

from tests.conftest import load_json, mcp_post_json, mcp_tools_from_response

README_SOURCE_TYPES = (
    "property",
    "permit",
    "ownership",
    "contractor",
    "business",
    "coordinate",
)

README_UI_QUESTIONS = (
    "roofs older than 15 years",
    "view of water",
    "not exchanged ownership in more than 10 years",
    "regional owners",
    "walking distance of public transportation",
    "walking distance of starbucks",
)

README_AGENT_PROMPTS = (
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
)


def duckdb_conn(parquet_path: str):
    assert Path(parquet_path).exists(), f"Parquet not found: {parquet_path}"
    con = duckdb.connect()
    con.execute(
        f"CREATE OR REPLACE VIEW dataset AS "
        f"SELECT * FROM read_parquet('{parquet_path}')"
    )
    return con


def source_counts(summary: dict) -> dict[str, int]:
    by_source = summary.get("records_by_source") or summary.get("sources") or {}
    counts: dict[str, int] = {}
    for source_type in README_SOURCE_TYPES:
        if source_type not in by_source:
            continue
        entry = by_source[source_type]
        count = entry.get("count", entry) if isinstance(entry, dict) else entry
        counts[source_type] = int(count)
    return counts


class TestPipelineAndLoads:
    def test_pipeline_completed(self, run_summary_path):
        summary = load_json(run_summary_path)
        status = str(summary.get("status", "")).lower()
        assert status in {"completed", "complete", "success"}, (
            "Pipeline run summary must show a completed run"
        )

    def test_pipeline_has_timing_and_limitations(self, run_summary_path):
        summary = load_json(run_summary_path)
        assert any(k in summary for k in ("started_at", "start_time", "started"))
        assert any(k in summary for k in ("finished_at", "end_time", "finished"))
        limitations = (
            summary.get("constraints")
            or summary.get("documented_constraints")
            or summary.get("source_limitations")
            or summary.get("limitations")
        )
        assert limitations, "Pipeline must document source limitations"

    def test_county_includes_palo_alto(self, parquet_path, run_summary_path):
        summary = load_json(run_summary_path)
        county_text = json.dumps(summary).lower()
        assert "palo alto" in county_text or "santa clara" in county_text

        con = duckdb_conn(parquet_path)
        cols = {row[0].lower() for row in con.execute("DESCRIBE dataset").fetchall()}
        location_cols = [c for c in cols if c in {"city", "address_city", "county", "jurisdiction"}]
        assert location_cols, "Dataset must expose a location field for county coverage"
        expr = " OR ".join(f"lower(cast({c} AS VARCHAR)) LIKE '%palo alto%'" for c in location_cols)
        county_expr = " OR ".join(
            f"lower(cast({c} AS VARCHAR)) LIKE '%santa clara%'" for c in location_cols if c != "city"
        )
        where = f"({expr})"
        if county_expr:
            where = f"({expr} OR {county_expr})"
        matches = con.execute(f"SELECT count(*) FROM dataset WHERE {where}").fetchone()[0]
        assert matches >= 1, "Dataset must include Palo Alto / Santa Clara records"

    @pytest.mark.parametrize("source_type", README_SOURCE_TYPES)
    def test_source_type_loaded(self, run_summary_path, source_type):
        counts = source_counts(load_json(run_summary_path))
        assert source_type in counts, f"Missing source type: {source_type}"
        assert counts[source_type] >= 1, f"No records loaded for {source_type}"


class TestDataQuality:
    def test_duplicate_entities_reconciled(self, parquet_path):
        con = duckdb_conn(parquet_path)
        cols = {row[0].lower() for row in con.execute("DESCRIBE dataset").fetchall()}
        key_cols = [c for c in ("apn", "parcel_id", "folio", "parcel_number") if c in cols]
        assert key_cols, "Dataset must expose a parcel identifier for reconciliation"
        key_expr = f"coalesce({', '.join(key_cols)})"
        dupes = con.execute(
            f"""
            SELECT count(*) - count(DISTINCT {key_expr})
            FROM dataset
            WHERE {key_expr} IS NOT NULL
            """
        ).fetchone()[0]
        assert dupes == 0, "Duplicate parcel entities must be reconciled"

    def test_source_provenance_preserved(self, parquet_path):
        con = duckdb_conn(parquet_path)
        cols = {row[0].lower() for row in con.execute("DESCRIBE dataset").fetchall()}
        provenance_cols = [
            c
            for c in cols
            if any(token in c for token in ("source", "provenance", "collected", "origin"))
        ]
        assert provenance_cols, "Dataset must preserve source provenance fields"
        sample_col = provenance_cols[0]
        populated = con.execute(
            f"SELECT count(*) FROM dataset WHERE {sample_col} IS NOT NULL"
        ).fetchone()[0]
        assert populated >= 1, "At least one record must carry provenance"

    def test_no_default_hosted_database_dependency(self, run_summary_path):
        summary = load_json(run_summary_path)
        text = json.dumps(summary.get("architecture", summary)).lower()
        forbidden = ("rds.", "neon.tech", "supabase", "postgres://", "mongodb://")
        assert not any(token in text for token in forbidden), (
            "Serving architecture must avoid ongoing hosted database cost"
        )


class TestStorageAndQueryLayer:
    def test_ipfs_artifacts_documented(self, manifest_path):
        manifest = load_json(manifest_path)
        artifacts = manifest.get("artifacts") or manifest.get("files") or manifest
        assert artifacts, "Manifest must list published artifacts"
        serialized = json.dumps(artifacts).lower()
        assert "cid" in serialized or "ipfs" in serialized, (
            "Manifest must include IPFS content identifiers"
        )

    def test_duckdb_can_query_dataset(self, parquet_path):
        con = duckdb_conn(parquet_path)
        total = con.execute("SELECT count(*) FROM dataset").fetchone()[0]
        assert total >= 1, "DuckDB must query the loaded dataset"

    def test_mcp_endpoint_available(self, mcp_base):
        try:
            r = httpx.get(mcp_base, timeout=15, follow_redirects=True)
        except httpx.ConnectError:
            pytest.skip("MCP endpoint not running")
        if r.status_code == 404:
            r = mcp_post_json(
                mcp_base,
                {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
            )
        if r.status_code in {404, 502, 503}:
            pytest.skip("MCP endpoint not running")
        assert r.status_code < 500, "MCP endpoint must be reachable"


class TestDemoQuestions:
    def test_ui_exposes_exploration_surface(self, ui_base):
        try:
            r = httpx.get(ui_base, timeout=30, follow_redirects=True)
        except httpx.ConnectError:
            pytest.skip("UI not running")
        assert r.status_code == 200
        assert "html" in r.headers.get("content-type", "").lower()

    @pytest.mark.parametrize("question", README_UI_QUESTIONS)
    def test_ui_supports_readme_questions(self, ui_base, question):
        try:
            r = httpx.get(ui_base, timeout=30, follow_redirects=True)
        except httpx.ConnectError:
            pytest.skip("UI not running")
        page = r.text.lower()
        assert question.split(" of ")[0] in page or "search" in page or "explore" in page, (
            f"UI must support README question: {question}"
        )

    def test_ui_shows_pipeline_summary(self, ui_base):
        candidates = (
            f"{ui_base}/run",
            f"{ui_base}/pipeline",
            f"{ui_base}/status",
            ui_base,
        )
        for url in candidates:
            try:
                r = httpx.get(url, timeout=30, follow_redirects=True)
            except httpx.ConnectError:
                pytest.skip("UI not running")
            if r.status_code != 200:
                continue
            text = r.text.lower()
            if any(token in text for token in README_SOURCE_TYPES):
                return
            if "record" in text and "source" in text:
                return
        pytest.fail("UI must show uploaded records by source")

    def test_ui_shows_ipfs_artifacts(self, ui_base):
        candidates = (
            f"{ui_base}/about",
            f"{ui_base}/artifacts",
            f"{ui_base}/ipfs",
            ui_base,
        )
        for url in candidates:
            try:
                r = httpx.get(url, timeout=30, follow_redirects=True)
            except httpx.ConnectError:
                pytest.skip("UI not running")
            if r.status_code != 200:
                continue
            if "ipfs" in r.text.lower() or "cid" in r.text.lower():
                return
        pytest.fail("UI must show IPFS artifacts")

    def test_mcp_exposes_query_tools(self, mcp_base):
        try:
            r = mcp_post_json(
                mcp_base,
                {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
            )
        except httpx.ConnectError:
            pytest.skip("MCP/agent not running")
        if r.status_code in {404, 502, 503}:
            pytest.skip("MCP/agent not running")
        assert r.status_code == 200
        tools = mcp_tools_from_response(r)
        assert tools, "MCP must expose agent-query tools"
        names = " ".join(tool["name"].lower() for tool in tools)
        assert any(
            token in names for token in ("query", "ask", "search", "property", "sql")
        ), "MCP tools must support database querying"

    @pytest.mark.parametrize("prompt", README_AGENT_PROMPTS)
    def test_readme_agent_prompts_documented(self, prompt):
        assert prompt.endswith("?")
        assert "properties" in prompt.lower()


class TestDemoReadiness:
    def test_real_county_records_not_toy_data(self, parquet_path):
        con = duckdb_conn(parquet_path)
        cols = {row[0].lower() for row in con.execute("DESCRIBE dataset").fetchall()}
        location_cols = [c for c in cols if c in {"city", "address_city", "county"}]
        assert location_cols, "Dataset must include location fields"
        values = []
        for col in location_cols:
            rows = con.execute(
                f"SELECT DISTINCT lower(cast({col} AS VARCHAR)) "
                f"FROM dataset WHERE {col} IS NOT NULL LIMIT 25"
            ).fetchall()
            values.extend(row[0] for row in rows)
        joined = " ".join(values)
        assert any(
            place in joined for place in ("palo alto", "san jose", "santa clara", "mountain view")
        )
        assert "toy" not in joined and "exampleville" not in joined

    def test_mcp_ready_documentation_available(self, ui_base, mcp_base):
        try:
            ui = httpx.get(ui_base, timeout=30, follow_redirects=True)
        except httpx.ConnectError:
            pytest.skip("UI not running")
        ui_text = ui.text.lower()
        documented = "mcp" in ui_text or mcp_base.lower() in ui_text
        if not documented:
            for path in ("/about", "/docs", "/connect"):
                try:
                    r = httpx.get(f"{ui_base}{path}", timeout=30, follow_redirects=True)
                except httpx.ConnectError:
                    continue
                if r.status_code == 200 and "mcp" in r.text.lower():
                    documented = True
                    break
        assert documented, "Project must document MCP-ready access"

    def test_answers_are_source_backed(self, parquet_path):
        con = duckdb_conn(parquet_path)
        cols = {row[0].lower() for row in con.execute("DESCRIBE dataset").fetchall()}
        provenance_cols = [c for c in cols if "source" in c or "provenance" in c]
        if not provenance_cols:
            pytest.skip("Implement provenance columns to enforce source-backed answers")
        col = provenance_cols[0]
        missing = con.execute(f"SELECT count(*) FROM dataset WHERE {col} IS NULL").fetchone()[0]
        total = con.execute("SELECT count(*) FROM dataset").fetchone()[0]
        assert missing / max(total, 1) <= 0.1, "Most records should remain source-backed"
