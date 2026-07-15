#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/env.sh"

echo "== Cursor ↔ Elephant MCP tests =="
cd "${PROJECT_ROOT}"
python3 -m pytest tests/acceptance/test_cursor_elephant_mcp.py -v "$@"
