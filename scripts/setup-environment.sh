#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/env.sh"

export PATH="${HOME}/.local/node/bin:${HOME}/.local/bin:${PATH}"

echo "== Setup: Python deps, data dirs, MCP npm =="
mkdir -p "${PROJECT_ROOT}/data" "${PROJECT_ROOT}/config"

python3 -m pip install --user -q -r "${PROJECT_ROOT}/requirements-dev.txt"

cd "${PROJECT_ROOT}/mcp"
if [[ ! -d node_modules/@elephant-xyz/mcp ]]; then
  npm install --no-fund --no-audit
fi

echo "OK  Setup complete."
echo "Next: ./scripts/run.sh pipeline && ./scripts/run.sh ui-start"
