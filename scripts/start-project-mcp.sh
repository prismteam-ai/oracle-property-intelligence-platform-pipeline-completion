#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/env.sh"

export PATH="${HOME}/.local/node/bin:${HOME}/.local/bin:${PATH}"

MCP_DIR="${PROJECT_ROOT}/mcp"
cd "${MCP_DIR}"

if [[ ! -d node_modules/@elephant-xyz/mcp ]]; then
  echo "Installing @elephant-xyz/mcp..."
  npm install
fi

export PARQUET_PATH="${PARQUET_PATH:-${PROJECT_ROOT}/data/properties.parquet}"
export MCP_PORT="${MCP_PORT}"
export COUNTY="${COUNTY:-santa-clara}"

exec npm run start
