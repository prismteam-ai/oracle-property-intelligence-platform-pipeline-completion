#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/env.sh"

echo "== Pull DATABASE_URL from Vercel (elephant-query-db) =="
echo "Requires: vercel CLI + access to elephant-xyz team"
echo

if ! command -v vercel >/dev/null 2>&1; then
  echo "Install Vercel CLI:"
  echo "  npm install -g vercel"
  exit 1
fi

target="${PROJECT_ROOT}/${ELEPHANT_QUERY_DB_DIR}"
if [[ ! -d "${target}" ]]; then
  echo "Missing ${target}. Run ./scripts/setup-environment.sh first."
  exit 1
fi

cd "${target}"
vercel link --yes --team elephant-xyz --project website
vercel env pull .env.local --scope elephant-xyz --environment development --yes

if [[ -f .env.local ]]; then
  url="$(grep -E '^DATABASE_URL=' .env.local | cut -d= -f2- | tr -d '"'"'"' || true)"
  if [[ -n "${url}" ]]; then
    if grep -q '^DATABASE_URL=' "${PROJECT_ROOT}/.env"; then
      sed -i "s|^DATABASE_URL=.*|DATABASE_URL=${url}|" "${PROJECT_ROOT}/.env"
    else
      echo "DATABASE_URL=${url}" >> "${PROJECT_ROOT}/.env"
    fi
    echo "DATABASE_URL copied to project .env"
  else
    echo "DATABASE_URL not found in .env.local"
    exit 1
  fi
fi
