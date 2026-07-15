#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/env.sh"

ENV_FILE="${PROJECT_ROOT}/.env"

set_env_var() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "${ENV_FILE}"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "${ENV_FILE}"
  else
    echo "${key}=${value}" >> "${ENV_FILE}"
  fi
}

echo "== Fill Filebase credentials in .env =="
echo "Get keys from: https://console.filebase.com"
echo

read -r -p "S3_BUCKET: " bucket
read -r -p "S3_ACCESS_KEY_ID: " access_key
read -r -s -p "S3_SECRET_ACCESS_KEY: " secret_key
echo

if [[ -z "${bucket}" || -z "${access_key}" || -z "${secret_key}" ]]; then
  echo "Aborted — all three values are required."
  exit 1
fi

set_env_var "S3_BUCKET" "${bucket}"
set_env_var "S3_ACCESS_KEY_ID" "${access_key}"
set_env_var "S3_SECRET_ACCESS_KEY" "${secret_key}"

echo "OK  Filebase values saved to .env"
echo "Run: ./scripts/run.sh filebase"
