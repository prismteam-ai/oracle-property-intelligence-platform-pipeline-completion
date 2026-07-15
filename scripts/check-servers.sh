#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/env.sh"

port_open() {
  local port="$1"
  timeout 1 bash -c "echo >/dev/tcp/127.0.0.1/${port}" 2>/dev/null
}

echo "== UI / MCP server check =="
echo

if port_open "${WEB_PORT}"; then
  echo "OK  UI listening on port ${WEB_PORT} (${UI_BASE_URL})"
else
  echo "MISSING UI on port ${WEB_PORT}"
  echo "  Start your UI app, then set UI_BASE_URL in .env"
fi

if port_open "${MCP_PORT}"; then
  echo "OK  MCP listening on port ${MCP_PORT} (${MCP_BASE_URL})"
else
  echo "MISSING MCP on port ${MCP_PORT}"
  echo "  Start with: ./scripts/run.sh mcp-start"
fi

echo
echo "After both are up, run: ./scripts/run.sh test"
