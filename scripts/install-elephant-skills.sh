#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/env.sh"

echo "== Reinstall elephant-xyz skills =="
cd "${PROJECT_ROOT}/${ORACLE_NODE_DIR}"
npx skills add elephant-xyz/skills --all -y
echo "Done. Skills in .agents/skills/"
