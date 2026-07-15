"""Minimal MCP stdio client for integration tests."""

from __future__ import annotations

import json
import queue
import subprocess
import threading
import time
from pathlib import Path
from typing import Any


class McpStdioClient:
    def __init__(self, command: list[str], env: dict[str, str] | None = None):
        self._proc = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=env,
        )
        self._responses: queue.Queue[dict[str, Any]] = queue.Queue()
        self._reader = threading.Thread(target=self._read_stdout, daemon=True)
        self._reader.start()

    def _read_stdout(self) -> None:
        assert self._proc.stdout is not None
        for line in self._proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                self._responses.put(json.loads(line))
            except json.JSONDecodeError:
                continue

    def request(self, method: str, params: dict[str, Any] | None = None, req_id: int = 1) -> dict[str, Any]:
        assert self._proc.stdin is not None
        payload = {"jsonrpc": "2.0", "id": req_id, "method": method}
        if params is not None:
            payload["params"] = params
        self._proc.stdin.write(json.dumps(payload) + "\n")
        self._proc.stdin.flush()
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                msg = self._responses.get(timeout=1)
            except queue.Empty:
                if self._proc.poll() is not None:
                    stderr = self._proc.stderr.read() if self._proc.stderr else ""
                    raise RuntimeError(f"MCP process exited: {stderr}")
                continue
            if msg.get("id") == req_id:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg.get("result", {})
        raise TimeoutError(f"MCP request timed out: {method}")

    def close(self) -> None:
        if self._proc.stdin:
            self._proc.stdin.close()
        self._proc.terminate()
        try:
            self._proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._proc.kill()


def elephant_mcp_command(package: str) -> list[str]:
    launcher = Path(__file__).resolve().parents[2] / "scripts" / "elephant-mcp-launch.sh"
    if launcher.is_file():
        return [str(launcher)]
    return ["bash", "-c", f"exec npx -y --package={package} mcp"]
