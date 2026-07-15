#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/env.sh"

ok=true

check() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf '  OK  %s\n' "${label}"
  else
    printf '  FAIL %s\n' "${label}"
    ok=false
  fi
}

echo "== Tool check =="
check "node >= 22" bash -c '[[ "$(node -v | sed "s/v//" | cut -d. -f1)" -ge 22 ]]'
check "npm" command -v npm
check "python3" command -v python3
check "pytest" python3 -m pytest --version
check "git" command -v git
check "curl" command -v curl
check "aws cli" command -v aws
check "gh cli" command -v gh

echo
echo "Versions:"
echo "  node:    $(node -v 2>/dev/null || echo missing)"
echo "  npm:     $(npm -v 2>/dev/null || echo missing)"
echo "  python:  $(python3 --version 2>/dev/null || echo missing)"
echo "  pytest:  $(python3 -m pytest --version 2>/dev/null | head -1 || echo missing)"

echo
echo "Paths:"
echo "  PROJECT_ROOT=${PROJECT_ROOT}"
echo "  ORACLE_NODE_DIR=${PROJECT_ROOT}/${ORACLE_NODE_DIR}"
echo "  SOOFI_PLUGIN_DIR=${SOOFI_PLUGIN_DIR}"

echo
echo "Repos:"
for dir in "${ORACLE_NODE_DIR}" "${ELEPHANT_QUERY_DB_DIR}" "${COUNTIES_TRANSFORM_SCRIPTS_DIR}"; do
  if [[ -d "${PROJECT_ROOT}/${dir}/.git" ]]; then
    echo "  OK  ${dir}"
  else
    echo "  MISSING ${dir}"
    ok=false
  fi
done

echo
echo "Skills:"
if [[ -d "${PROJECT_ROOT}/${ORACLE_NODE_DIR}/.agents/skills/onboard-county" ]]; then
  count="$(find "${PROJECT_ROOT}/${ORACLE_NODE_DIR}/.agents/skills" -mindepth 1 -maxdepth 1 -type d | wc -l)"
  echo "  OK  ${count} elephant-xyz skills installed"
else
  echo "  MISSING run ./scripts/setup-environment.sh"
  ok=false
fi

echo
echo "Secrets (.env):"
[[ -n "${COUNTY}" ]] && echo "  OK  COUNTY=${COUNTY}" || { echo "  FAIL COUNTY empty"; ok=false; }
[[ -n "${S3_ACCESS_KEY_ID}" ]] && echo "  OK  S3_ACCESS_KEY_ID set" || echo "  TODO S3_ACCESS_KEY_ID (Filebase)"
[[ -n "${DATABASE_URL}" ]] && echo "  OK  DATABASE_URL set" || echo "  TODO DATABASE_URL (optional Neon)"
[[ -n "${AWS_PROFILE:-}" ]] && echo "  OK  AWS_PROFILE=${AWS_PROFILE}" || echo "  SKIP AWS_PROFILE (optional — do not set empty)"

echo
if [[ "${ok}" == true ]]; then
  echo "All required checks passed."
else
  echo "Some checks failed. Run ./scripts/manual-steps.sh"
  exit 1
fi
