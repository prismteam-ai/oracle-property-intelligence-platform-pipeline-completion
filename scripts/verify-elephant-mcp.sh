#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/env.sh"

echo "== Elephant MCP smoke test =="
echo "Package: ${ELEPHANT_MCP_PACKAGE}"
echo "County:  ${ELEPHANT_MCP_COUNTY}"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "Node missing. Run ./scripts/setup-environment.sh"
  exit 1
fi

echo "Starting stdio server for 15s (Ctrl+C stops earlier)..."
timeout 15 bash -c "exec npx -y --package=${ELEPHANT_MCP_PACKAGE} mcp" &
pid=$!
sleep 5
if kill -0 "${pid}" 2>/dev/null; then
  echo "OK  elephant-mcp stdio server started"
  wait "${pid}" || true
else
  echo "FAIL elephant-mcp did not stay up"
  exit 1
fi

echo
echo "In Cursor: call getOracleDatasetInfo with county=${ELEPHANT_MCP_COUNTY}"
echo "Reference property IPNS: ${SANTA_CLARA_PROPERTY_IPNS}"
echo "Reference permit IPNS:   ${SANTA_CLARA_PERMIT_IPNS}"
