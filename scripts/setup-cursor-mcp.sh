#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/env.sh"

echo "== Cursor Elephant MCP setup =="
echo

if [[ ! -d "${SOOFI_PLUGIN_DIR}" ]]; then
  echo "FAIL Soofi plugin missing at ${SOOFI_PLUGIN_DIR}"
  echo "Run:"
  echo "  mkdir -p ~/.cursor/plugins/local"
  echo "  git clone https://github.com/soofi-xyz/cursor-plugin.git ~/.cursor/plugins/local/soofi-xyz"
  exit 1
fi
echo "OK  Soofi plugin: ${SOOFI_PLUGIN_DIR}"

if [[ -f "${SOOFI_PLUGIN_DIR}/mcp.json" ]]; then
  echo "OK  mcp.json present"
else
  echo "FAIL mcp.json missing in Soofi plugin"
  exit 1
fi

node_path="$(command -v node || true)"
if [[ -z "${node_path}" ]]; then
  echo "FAIL node not on PATH"
  echo "Run: ./scripts/setup-bashrc-path.sh && source ~/.bashrc"
  exit 1
fi

node_major="$(node -v | sed 's/v//' | cut -d. -f1)"
if [[ "${node_major}" -lt 22 ]]; then
  echo "FAIL node $(node -v) — need >= 22.18"
  echo "Run: ./scripts/setup-environment.sh"
  exit 1
fi
echo "OK  node $(node -v) at ${node_path}"

if grep -qF '.local/node/bin' "${HOME}/.bashrc" 2>/dev/null; then
  echo "OK  ~/.bashrc PATH configured"
else
  echo "TODO ~/.bashrc PATH not set — Cursor may still see old node"
  echo "Run: ./scripts/setup-bashrc-path.sh"
fi

echo
echo "Manual steps in Cursor:"
echo "  1. source ~/.bashrc  (or open a new terminal)"
echo "  2. Reload Cursor window"
echo "  3. Settings → MCP → enable server: ${ELEPHANT_MCP_SERVER}"
echo "  4. Wait 1-3 min on first connect (npx builds elephant-mcp)"
echo "  5. Test: getOracleDatasetInfo with county=${ELEPHANT_MCP_COUNTY}"
echo
echo "Do NOT set empty OPENAI_API_KEY on the elephant MCP server."
