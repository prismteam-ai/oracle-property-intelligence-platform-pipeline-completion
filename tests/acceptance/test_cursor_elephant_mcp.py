"""Tests for Cursor ↔ Elephant MCP connectivity."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from tests.support.mcp_stdio_client import McpStdioClient, elephant_mcp_command

REQUIRED_ELEPHANT_TOOLS = {
    "getOracleDatasetInfo",
    "getPropertyQuerySchema",
    "queryProperties",
}


def find_cursor_elephant_mcp_dir() -> Path | None:
    override = os.environ.get("CURSOR_ELEPHANT_MCP_DIR")
    if override:
        path = Path(override)
        return path if path.is_dir() else None

    projects = Path.home() / ".cursor" / "projects"
    if not projects.is_dir():
        return None

    for meta in projects.glob("*/mcps/*/SERVER_METADATA.json"):
        try:
            data = json.loads(meta.read_text())
        except json.JSONDecodeError:
            continue
        if data.get("serverName") == "elephant":
            return meta.parent
    return None


def cursor_mcp_status(cursor_dir: Path) -> str:
    status_file = cursor_dir / "STATUS.md"
    if not status_file.exists():
        return "unknown"
    text = status_file.read_text().strip().lower()
    if "errored" in text or "error" in text:
        return "errored"
    if "connected" in text or "ready" in text:
        return "connected"
    return "unknown"


@pytest.fixture(scope="session")
def cursor_elephant_mcp_dir() -> Path | None:
    return find_cursor_elephant_mcp_dir()


@pytest.fixture(scope="session")
def elephant_mcp_env() -> dict[str, str]:
    env = os.environ.copy()
    config = Path(__file__).resolve().parents[2] / "config" / "elephant-mcp.env"
    if config.exists():
        for line in config.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            if value:
                env[key] = value
    # elephant-mcp zod rejects empty optional strings like AWS_PROFILE=
    env.pop("AWS_PROFILE", None)
    if not env.get("AWS_PROFILE"):
        env.pop("AWS_PROFILE", None)
    return {k: v for k, v in env.items() if v}


class TestCursorElephantMcpConnection:
    def test_local_npx_available(self):
        local_npx = Path.home() / ".local" / "node" / "bin" / "npx"
        assert local_npx.is_file(), (
            "Local npx missing. Run ./scripts/setup-environment.sh"
        )

    def test_project_mcp_launcher_configured(self):
        launcher = Path(__file__).resolve().parents[2] / "scripts" / "elephant-mcp-launch.sh"
        cursor_mcp = Path(__file__).resolve().parents[2] / ".mcp.json"
        assert launcher.is_file(), "Missing scripts/elephant-mcp-launch.sh"
        if not cursor_mcp.exists():
            pytest.fail(
                "Project .mcp.json missing. Run ./scripts/fix-cursor-elephant-mcp.sh"
            )
        data = json.loads(cursor_mcp.read_text())
        command = data["mcpServers"]["elephant"]["command"]
        assert "elephant-mcp-launch" in command or command.endswith("elephant-mcp-launch.sh")

    def test_cursor_elephant_mcp_dir_exists(self, cursor_elephant_mcp_dir):
        assert cursor_elephant_mcp_dir is not None, (
            "Cursor elephant MCP folder not found. "
            "Enable the Soofi plugin and reload Cursor."
        )

    def test_cursor_elephant_mcp_not_errored(self, cursor_elephant_mcp_dir):
        if cursor_elephant_mcp_dir is None:
            pytest.skip("Cursor elephant MCP folder not found")
        status = cursor_mcp_status(cursor_elephant_mcp_dir)
        assert status != "errored", (
            "Cursor reports elephant MCP errored. "
            "Run ./scripts/fix-cursor-elephant-mcp.sh then reload Cursor. "
            "Common cause: broken system npx (/usr/share/nodejs/npm) — launcher bypasses it."
        )

    def test_cursor_discovered_elephant_tools(self, cursor_elephant_mcp_dir):
        if cursor_elephant_mcp_dir is None:
            pytest.skip("Cursor elephant MCP folder not found")
        if cursor_mcp_status(cursor_elephant_mcp_dir) == "errored":
            pytest.fail("Cursor elephant MCP is errored — tools not available")

        tools_dir = cursor_elephant_mcp_dir / "tools"
        if not tools_dir.is_dir():
            pytest.fail(
                "Cursor has not discovered elephant MCP tools yet. "
                "Reload Cursor, enable elephant under Settings → MCP, wait 1-3 min."
            )

        discovered = {p.stem for p in tools_dir.glob("*.json")}
        missing = REQUIRED_ELEPHANT_TOOLS - discovered
        assert not missing, f"Cursor elephant MCP missing tools: {sorted(missing)}"


class TestElephantMcpFunctional:
    def test_elephant_mcp_stdio_tools_list(self, elephant_mcp_env):
        if shutil.which("node") is None:
            pytest.skip("node not on PATH")
        node_major = int(
            subprocess.check_output(["node", "-v"], text=True).strip().lstrip("v").split(".")[0]
        )
        if node_major < 22:
            pytest.skip("node 22+ required for elephant-mcp")

        package = os.environ.get("ELEPHANT_MCP_PACKAGE", "github:elephant-xyz/elephant-mcp#main")
        client = McpStdioClient(elephant_mcp_command(package), env=elephant_mcp_env)
        try:
            client.request(
                "initialize",
                {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "acceptance-test", "version": "1.0"},
                },
                req_id=1,
            )
            result = client.request("tools/list", {}, req_id=2)
            names = {tool["name"] for tool in result.get("tools", [])}
            missing = REQUIRED_ELEPHANT_TOOLS - names
            assert not missing, f"elephant-mcp missing tools: {sorted(missing)}"
        finally:
            client.close()

    def test_elephant_mcp_santa_clara_dataset_info(self, elephant_mcp_env):
        if shutil.which("node") is None:
            pytest.skip("node not on PATH")

        county = os.environ.get("ELEPHANT_MCP_COUNTY", "santa-clara")
        package = os.environ.get("ELEPHANT_MCP_PACKAGE", "github:elephant-xyz/elephant-mcp#main")
        client = McpStdioClient(elephant_mcp_command(package), env=elephant_mcp_env)
        try:
            client.request(
                "initialize",
                {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "acceptance-test", "version": "1.0"},
                },
                req_id=1,
            )
            client.request("tools/list", {}, req_id=2)
            result = client.request(
                "tools/call",
                {
                    "name": "getOracleDatasetInfo",
                    "arguments": {"county": county},
                },
                req_id=3,
            )
            body = json.dumps(result).lower()
            assert county.replace("-", "") in body.replace("-", "") or county in body
            assert "propertycount" in body or "property_count" in body or "count" in body
        finally:
            client.close()
