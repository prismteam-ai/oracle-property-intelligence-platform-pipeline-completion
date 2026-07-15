#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/env.sh"

mkdir -p "${PROJECT_ROOT}/data" "${PROJECT_ROOT}/config"

echo "OK  ${PROJECT_ROOT}/data"
echo "OK  ${PROJECT_ROOT}/config"
echo
echo "Expected artifacts (created by pipeline, not yet present):"
for f in "${PARQUET_PATH}" "${RUN_SUMMARY_PATH}" "${MANIFEST_PATH}"; do
  path="${PROJECT_ROOT}/${f#./}"
  if [[ -f "${path}" ]]; then
    echo "  EXISTS ${f}"
  else
    echo "  MISSING ${f}"
  fi
done
