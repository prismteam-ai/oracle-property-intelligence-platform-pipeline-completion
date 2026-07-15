#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/env.sh"

section() { echo; echo "== $1 =="; }

section "Tools"
"${SCRIPT_DIR}/check-tools.sh" || true

section "Shell PATH"
if grep -qF '.local/node/bin' "${HOME}/.bashrc" 2>/dev/null; then
  echo "  OK  ~/.bashrc PATH"
else
  echo "  MISSING run ./scripts/setup-bashrc-path.sh"
fi

section "GitHub"
if gh auth status >/dev/null 2>&1; then
  echo "  OK  gh authenticated"
else
  echo "  MISSING run ./scripts/run.sh gh"
fi

section "Cursor MCP"
"${SCRIPT_DIR}/setup-cursor-mcp.sh" || true

section "Secrets"
[[ -n "${S3_ACCESS_KEY_ID:-}" ]] && echo "  OK  Filebase keys" || echo "  MISSING run ./scripts/fill-filebase-env.sh"
[[ -n "${DATABASE_URL:-}" ]] && echo "  OK  DATABASE_URL" || echo "  SKIP  DATABASE_URL (optional)"
[[ -n "${AWS_PROFILE:-}" ]] && echo "  OK  AWS_PROFILE=${AWS_PROFILE}" || echo "  SKIP  AWS_PROFILE (optional)"

section "Data artifacts"
for f in "${PARQUET_PATH}" "${RUN_SUMMARY_PATH}" "${MANIFEST_PATH}"; do
  path="${PROJECT_ROOT}/${f#./}"
  [[ -f "${path}" ]] && echo "  OK  ${f}" || echo "  MISSING ${f}"
done

section "elephant-mcp repo"
mcp_dir="$(cd "${PROJECT_ROOT}/.." && pwd)/elephant-mcp"
[[ -d "${mcp_dir}/.git" ]] && echo "  OK  ${mcp_dir}" || echo "  MISSING run ./scripts/clone-elephant-mcp.sh"

section "Servers"
"${SCRIPT_DIR}/check-servers.sh" || true

section "Acceptance tests"
cd "${PROJECT_ROOT}"
python3 -m pytest tests/acceptance -q --tb=no 2>&1 | tail -1 || true

section "Summary"
echo "Fix all MISSING items: ./scripts/fix-missing.sh"
