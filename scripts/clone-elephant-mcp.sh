#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/env.sh"

MCP_DIR="$(cd "${PROJECT_ROOT}/.." && pwd)/elephant-mcp"

if [[ -d "${MCP_DIR}/.git" ]]; then
  echo "OK  elephant-mcp already cloned at ${MCP_DIR}"
  exit 0
fi

echo "Cloning elephant-mcp to ${MCP_DIR}..."
git clone https://github.com/elephant-xyz/elephant-mcp.git "${MCP_DIR}"
cd "${MCP_DIR}"
npm install
echo "OK  elephant-mcp ready. Start with: ./scripts/run.sh mcp-start"
