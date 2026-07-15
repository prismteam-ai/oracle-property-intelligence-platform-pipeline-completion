#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/env.sh"

MCP_DIR="$(cd "${PROJECT_ROOT}/.." && pwd)/elephant-mcp"

if [[ ! -d "${MCP_DIR}/.git" ]]; then
  echo "Cloning elephant-mcp..."
  git clone https://github.com/elephant-xyz/elephant-mcp.git "${MCP_DIR}"
fi

cd "${MCP_DIR}"
if [[ ! -d node_modules ]]; then
  npm install
fi

echo "Starting HTTP MCP on port ${MCP_PORT}..."
export PORT="${MCP_PORT}"
npm run dev:http
