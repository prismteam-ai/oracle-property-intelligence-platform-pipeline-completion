#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/env.sh"

export PATH="${HOME}/.local/node/bin:${HOME}/.local/bin:${PATH}"

MCP_DIR="$(cd "${PROJECT_ROOT}/.." && pwd)/elephant-mcp"

if [[ ! -d "${MCP_DIR}/.git" ]]; then
  echo "Cloning elephant-mcp..."
  git clone https://github.com/elephant-xyz/elephant-mcp.git "${MCP_DIR}"
fi

cd "${MCP_DIR}"
echo "Installing elephant-mcp dependencies..."
npm install

echo "Building elephant-mcp..."
npm run build

if [[ -f "${MCP_DIR}/dist/index.js" ]]; then
  echo "OK  Built ${MCP_DIR}/dist/index.js"
else
  echo "FAIL build did not produce dist/index.js"
  exit 1
fi

echo "Launcher will now use local build (faster, no npx fetch)."
