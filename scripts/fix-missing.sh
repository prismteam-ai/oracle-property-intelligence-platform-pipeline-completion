#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== Fix missing setup (automated steps) =="
echo

run_if_missing() {
  local label="$1"
  local check_cmd="$2"
  local fix_script="$3"
  if eval "${check_cmd}" >/dev/null 2>&1; then
    echo "SKIP ${label}"
  else
    echo "RUN  ${label}"
    "${fix_script}"
  fi
}

run_if_missing "bashrc PATH" "grep -qF '.local/node/bin' \"${HOME}/.bashrc\"" \
  "${SCRIPT_DIR}/setup-bashrc-path.sh"

run_if_missing "data directories" "test -d \"${SCRIPT_DIR}/../data\"" \
  "${SCRIPT_DIR}/init-data-dirs.sh"

mcp_dir="$(cd "${SCRIPT_DIR}/.." && pwd)/../elephant-mcp"
run_if_missing "elephant-mcp clone" "test -d \"${mcp_dir}/.git\"" \
  "${SCRIPT_DIR}/clone-elephant-mcp.sh"

run_if_missing "cursor elephant mcp config" "test -f \"${SCRIPT_DIR}/../.mcp.json\"" \
  "${SCRIPT_DIR}/fix-cursor-elephant-mcp.sh"

# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/env.sh"
if [[ -z "${S3_ACCESS_KEY_ID:-}" ]]; then
  echo
  echo "TODO Filebase keys — run interactively:"
  echo "  ./scripts/fill-filebase-env.sh"
fi

if ! gh auth status >/dev/null 2>&1; then
  echo
  echo "TODO GitHub auth — run:"
  echo "  ./scripts/run.sh gh"
fi

echo
"${SCRIPT_DIR}/setup-cursor-mcp.sh" || true

echo
echo "Done. Full status: ./scripts/status.sh"
