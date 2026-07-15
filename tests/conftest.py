"""Shared pytest fixtures for acceptance tests."""

from __future__ import annotations

import json
import os
from pathlib import Path

import httpx
import pytest
from dotenv import load_dotenv

load_dotenv()

MCP_ACCEPT = "application/json, text/event-stream"


def mcp_post_json(mcp_base: str, payload: dict, *, timeout: float = 30.0) -> httpx.Response:
    return httpx.post(
        mcp_base,
        json=payload,
        headers={"Accept": MCP_ACCEPT},
        timeout=timeout,
    )


def mcp_tools_from_response(response: httpx.Response) -> list[dict]:
    content_type = response.headers.get("content-type", "")
    if "text/event-stream" in content_type:
        for line in response.text.splitlines():
            if line.startswith("data: "):
                payload = json.loads(line[6:])
                return payload.get("result", {}).get("tools", [])
        return []
    try:
        return response.json().get("result", {}).get("tools", [])
    except json.JSONDecodeError:
        return []


@pytest.fixture(scope="session")
def ui_base() -> str:
    return os.environ.get("UI_BASE_URL", "http://localhost:3000").rstrip("/")


@pytest.fixture(scope="session")
def mcp_base() -> str:
    return os.environ.get("MCP_BASE_URL", "http://localhost:8000/mcp").rstrip("/")


@pytest.fixture(scope="session")
def parquet_path() -> str:
    return os.environ.get("PARQUET_PATH", "data/properties.parquet")


@pytest.fixture(scope="session")
def manifest_path() -> str:
    return os.environ.get("MANIFEST_PATH", "manifest.json")


@pytest.fixture(scope="session")
def run_summary_path() -> str:
    return os.environ.get("RUN_SUMMARY_PATH", "data/run_summary.json")


def load_json(path: str | Path) -> dict:
    p = Path(path)
    assert p.exists(), f"Missing required artifact: {p}"
    return __import__("json").loads(p.read_text())
