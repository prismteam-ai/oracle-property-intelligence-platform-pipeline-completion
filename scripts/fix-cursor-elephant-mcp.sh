#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/env.sh"

LAUNCHER="${SCRIPT_DIR}/elephant-mcp-launch.sh"
CURSOR_MCP="${PROJECT_ROOT}/.mcp.json"
SOOFI_MCP="${SOOFI_PLUGIN_DIR}/mcp.json"

chmod +x "${LAUNCHER}"
mkdir -p "${PROJECT_ROOT}/.cursor" 2>/dev/null || true

write_mcp_config() {
  local target="$1"
  python3 - "${LAUNCHER}" "${target}" "${PROJECT_ROOT}/config/elephant-mcp.env" <<'PY'
import json
import sys
from pathlib import Path

launcher, cursor_mcp, env_file = sys.argv[1:4]
env = {}
path = Path(env_file)
if path.exists():
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key] = value

config = {
    "$schema": "https://cursor.com/schemas/mcp.json",
    "mcpServers": {
        "elephant": {
            "command": launcher,
            "args": [],
            "env": env,
        }
    },
}

out = Path(cursor_mcp)
out.write_text(json.dumps(config, indent=2) + "\n")
print(f"Wrote {out}")
PY
}

write_mcp_config "${CURSOR_MCP}"

if [[ -d "${SOOFI_PLUGIN_DIR}" ]]; then
  write_mcp_config "${SOOFI_MCP}"
  echo "Patched Soofi plugin MCP config (Option A)"
else
  echo "WARN Soofi plugin not found at ${SOOFI_PLUGIN_DIR}"
fi

echo
echo "== Diagnose broken system npx =="
if command -v npx >/dev/null 2>&1; then
  npx_path="$(command -v npx)"
  echo "  which npx: ${npx_path}"
fi
if [[ -x "${HOME}/.local/node/bin/npx" ]]; then
  echo "  OK  launcher uses ${HOME}/.local/node/bin/npx"
else
  echo "  FAIL local npx missing — run ./scripts/setup-environment.sh"
fi

echo
echo "Next:"
echo "  1. Reload Cursor window"
echo "  2. Settings → MCP → restart elephant (plugin-soofi-xyz-elephant)"
echo "  3. ./scripts/run.sh test"
